/**
 * backend/jepaWorldModel.js
 * ----------------------------------------------------------------------------
 * JEPA — Joint Embedding Predictive Architecture (world-model layer).
 *
 * Per Yann LeCun's JEPA framing, the world model does NOT predict raw pixels
 * or raw telemetry — it predicts embeddings, and the prediction error
 * ("energy") is the primary signal the rest of the system reacts to.
 *
 * For Phase 3 we keep this deliberately lightweight: a tiny linear predictor
 * over the 6-dim feature vector plus a deterministic depth-aware anomaly
 * detector. The shape of the API is what matters; the predictor can later
 * be swapped for a real torch/onnx model without touching TrinityCore.
 *
 * Public surface:
 *   - new JepaWorldModel({ predictor, anomalyThreshold })
 *   - .observe(featureVector) → JepaEnergyReading
 *   - .tick(featureVector)    → calls observe() and emits 'energy' event
 *   - extends EventEmitter
 *
 * Design note:
 *   We use EventEmitter rather than a callback so a single JEPA instance
 *   can fan out to multiple subscribers (the LlmNarrator AND any future
 *   alerting pipeline).
 * ----------------------------------------------------------------------------
 */

const EventEmitter = require("events");

const DEFAULT_ANOMALY_THRESHOLD = 0.50;

/**
 * Tiny linear predictor. Predicts next-state embedding as
 *   predicted[t+1] = W * state[t] + b
 * where W is the identity matrix (the simplest possible baseline) and b
 * drifts toward zero. This is intentionally trivial — it gives us a stable
 * "no surprise" baseline. Real JEPA would replace this with a learned
 * non-linear predictor in Phase 4+.
 */
class LinearPredictor {
  constructor(dim) {
    this.dim = dim;
    // Identity matrix baked into the predictor so each output dimension
    // is just the same input dimension from the previous tick.
    this.W = identity(dim);
    this.b = zeros(dim);
  }

  /**
   * Predict next-state vector given the current one.
   * @param  {Float64Array|number[]} x
   * @returns {Float64Array}
   */
  predict(x) {
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      let s = this.b[i];
      for (let j = 0; j < this.dim; j++) s += this.W[i * this.dim + j] * x[j];
      out[i] = s;
    }
    return out;
  }

  /**
   * One-step online update. For Phase 3 we don't actually learn anything
   * (the predictor is the identity). The seam is here for Phase 4.
   */
  update(/* x, predicted, observed, error */) {
    /* no-op — placeholder for future online learning */
  }
}

function identity(n) {
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) out[i * n + i] = 1;
  return out;
}
function zeros(n) {
  return new Float64Array(n);
}

/**
 * The "energy" of a JEPA prediction. We use normalised L2 distance:
 *   energy = ||predicted - observed|| / scale
 * where `scale` is tuned so that a normal, well-behaved trajectory tick
 * produces an energy near 0 and a dramatic event (e.g. depth dropping
 * from 25 m to 1.2 m) pushes it past 1.0.
 *
 * The scale is computed dynamically from the running mean absolute
 * feature magnitudes so it adapts to whatever units the predictor uses.
 */
class JepaWorldModel extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.predictor]   Inject a custom predictor; default LinearPredictor(dim=6).
   * @param {number} [opts.dim=6]       Feature vector dimensionality.
   * @param {number} [opts.anomalyThreshold=0.50]
   */
  constructor(opts = {}) {
    super();
    this._dim = opts.dim ?? 6;
    this._predictor = opts.predictor ?? new LinearPredictor(this._dim);
    this._threshold = opts.anomalyThreshold ?? DEFAULT_ANOMALY_THRESHOLD;

    // Running statistics for adaptive scaling.
    this._magnitudeEMA = 0;
    this._alpha        = 0.10; // EMA smoothing factor
    this._prevVec      = null;
    this._tickCount    = 0;

    // Recent energy history (bounded — the narrator may want a rolling avg).
    this._energyWindow = [];
    this._windowMax    = 32;
  }

  /**
   * Observe a new feature vector. Returns the energy reading and emits
   * an 'energy' event with the same payload.
   * @param {Float64Array|number[]} vec
   * @returns {JepaEnergyReading}
   */
  observe(vec) {
    if (vec.length !== this._dim) {
      throw new RangeError(`feature vector length ${vec.length} !== dim ${this._dim}`);
    }

    this._tickCount += 1;

    // First observation — nothing to compare to. Energy = 0.
    if (!this._prevVec) {
      this._prevVec = new Float64Array(vec);
      const reading = this._makeReading(0, "first observation", false);
      this.emit("energy", reading);
      return reading;
    }

    // Predict the next state from the previous one.
    const predicted = this._predictor.predict(this._prevVec);

    // Compute raw L2 error.
    let sq = 0;
    for (let i = 0; i < this._dim; i++) {
      const d = predicted[i] - vec[i];
      sq += d * d;
    }
    const l2 = Math.sqrt(sq);

    // Update the magnitude EMA so the energy normaliser adapts.
    let mag = 0;
    for (let i = 0; i < this._dim; i++) mag += Math.abs(vec[i]);
    mag /= this._dim;
    this._magnitudeEMA = this._magnitudeEMA * (1 - this._alpha) + mag * this._alpha;

    // Floor the scale so we never divide by near-zero (when the boat is
    // stationary in calm waters, magnitude can be tiny).
    const scale = Math.max(this._magnitudeEMA, 1.0);
    const energy = clamp01(l2 / scale);

    // Append to history and trim.
    this._energyWindow.push(energy);
    if (this._energyWindow.length > this._windowMax) this._energyWindow.shift();

    // Update the predictor online (placeholder for future learning).
    this._predictor.update(this._prevVec, predicted, vec, energy);

    // Cache for next tick.
    const prevForReason = this._prevVec; // snapshot before we overwrite
    this._prevVec = new Float64Array(vec);

    // Heuristic label so the narrator can quote a reason.
    const reason = this._diagnoseReason(prevForReason, vec, energy);
    const anomaly = energy > this._threshold;
    const reading = this._makeReading(energy, reason, anomaly);

    this.emit("energy", reading);
    return reading;
  }

  /**
   * Alias kept for callers that prefer tick() terminology.
   */
  tick(vec) { return this.observe(vec); }

  /**
   * Mean energy over the recent window. Used by the narrator to write
   * "things have been calm for the last minute" prose.
   */
  recentMeanEnergy() {
    if (this._energyWindow.length === 0) return 0;
    let sum = 0;
    for (const e of this._energyWindow) sum += e;
    return sum / this._energyWindow.length;
  }

  get anomalyThreshold() { return this._threshold; }
  get tickCount()       { return this._tickCount; }

  _makeReading(score, reason, anomaly) {
    return {
      score,
      anomaly,
      reason,
      timestamp: Date.now(),
    };
  }

  _diagnoseReason(prev, cur, energy) {
    if (!prev) return "first observation";
    if (energy < 0.05) return "steady";
    // Look for the dominant signal change. Feature-vector layout:
    //   0=latitude, 1=longitude, 2=SOG(kt), 3=heading(deg), 4=depth(m), 5=trajectoryProgress
    const depthDelta   = Math.abs(cur[4] - prev[4]);
    const headingDelta = Math.abs(cur[3] - prev[3]);
    const sogDelta     = Math.abs(cur[2] - prev[2]);
    const max = Math.max(depthDelta, headingDelta, sogDelta);
    if (max === depthDelta   && depthDelta   > 1.0) return "depth plunge";
    if (max === headingDelta && headingDelta > 10)  return "heading jolt";
    if (max === sogDelta     && sogDelta     > 1.5) return "speed surge";
    return "minor deviation";
  }
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

module.exports = {
  JepaWorldModel,
  LinearPredictor,
};