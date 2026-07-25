/**
 * backend/trinityCore.js
 * ----------------------------------------------------------------------------
 * The Trinity Core — the active loop that wires the three layers together:
 *
 *   JEPA world model  (subconscious)     backend/jepaWorldModel.js
 *   Ring buffer       (sensory memory)  backend/ringBuffer.js
 *   LLM narrator      (conscious voice) backend/llmNarrator.js
 *
 * Every 500 ms the core:
 *   1. Pulls the latest feature vector from the ring buffer.
 *   2. Feeds it into the JEPA world model. The model emits an energy reading.
 *   3. If energy <= threshold (peaceful):
 *        -> ask the narrator for a *passive* prose update.
 *           The narrator is throttled (default 4 s) so we won't spam the LLM.
 *   4. If energy > threshold (anomaly):
 *        -> override everything. Abort any in-flight generation and force
 *           the narrator to produce an emergency <a2a> JSON mutation
 *           command (e.g. morph_to_hazard_mode).
 *
 * The core emits events that the Theia frontend (Phase 2) will subscribe to:
 *   'tick'        ({ frame, energy })       — every loop iteration
 *   'peaceful'    ({ frame, energy })       — energy below threshold
 *   'anomaly'     ({ frame, energy })       — energy above threshold
 *   'prose'       (text: string)            — narrator prose
 *   'a2a'         (action: A2AAction)       — narrator A2A command
 *   'stopped'     ()                        — loop torn down
 *
 * Usage:
 *   const core = new TrinityCore({ ringBuffer, jepa, narrator, intervalMs: 500 });
 *   core.start();
 *   ...
 *   core.stop();
 * ----------------------------------------------------------------------------
 */

const EventEmitter = require("events");

const DEFAULT_INTERVAL_MS = 500;
const EMERGENCY_PROMPT_HEADER = "EMERGENCY";

class TrinityCore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.ringBuffer   TelemetryRingBuffer instance.
   * @param {object} opts.jepa         JepaWorldModel instance.
   * @param {object} opts.narrator     LlmNarrator instance.
   * @param {object} [opts.retriever]  Optional Retriever-like object with .retrieve(vec) -> RetrievedContextChunk[].
   * @param {number} [opts.intervalMs=500]   Loop period in ms.
   * @param {number} [opts.anomalyThreshold] Override JEPA threshold.
   */
  constructor(opts) {
    super();
    if (!opts?.ringBuffer) throw new Error("TrinityCore: ringBuffer is required");
    if (!opts?.jepa)       throw new Error("TrinityCore: jepa is required");
    if (!opts?.narrator)   throw new Error("TrinityCore: narrator is required");

    this._ring   = opts.ringBuffer;
    this._jepa   = opts.jepa;
    this._narr   = opts.narrator;
    this._retr   = opts.retriever ?? { retrieve: async () => [] };
    this._period = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this._threshold = opts.anomalyThreshold ?? this._jepa.anomalyThreshold;

    this._timer        = null;
    this._running      = false;
    this._lastFrame    = null;
    this._lastEnergy   = null;
    this._emergencyCount = 0;
    this._peacefulCount = 0;

    // Forward narrator events so consumers only need one EventEmitter.
    this._narr.on("prose",     (t) => this.emit("prose", t));
    this._narr.on("a2a",       (a) => this.emit("a2a", a));
    this._narr.on("malformed", (m) => this.emit("malformed", m));
    this._narr.on("error",     (e) => this.emit("narrator-error", e));

    // JEPA anomalies: we re-route them too so a test/UI can subscribe.
    this._jepa.on("energy", (reading) => {
      if (reading.anomaly) this._onAnomaly(reading);
    });
  }

  /** Begin the loop. Idempotent. */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._tickSafe(), this._period);
    // Fire one immediately so tests don't have to wait.
    this._tickSafe();
  }

  /** Halt the loop. Safe to call multiple times. */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._narr.abort();
    this.emit("stopped");
  }

  /**
   * Read-only view of internal counters (for the test harness).
   */
  get stats() {
    return {
      running:        this._running,
      peacefulCount:  this._peacefulCount,
      emergencyCount: this._emergencyCount,
      threshold:      this._threshold,
      narratorStats:  this._narr.stats,
      jepaTicks:      this._jepa.tickCount,
    };
  }
  get ringBuffer() { return this._ring; }
  get jepa()       { return this._jepa; }
  get narrator()   { return this._narr; }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Catch any synchronous exception in the loop so a malformed tick can't
   * kill the daemon.
   */
  _tickSafe() {
    try { this._tick(); }
    catch (err) { this.emit("error", err); }
  }

  async _tick() {
    // 1. Pull the latest frame from the ring buffer.
    const frame = this._ring.latest ? this._ring.latest() : null;
    if (!frame) {
      // No data yet; nothing to do.
      return;
    }
    this._lastFrame = frame;

    // 2. Feed JEPA.
    const energy = this._jepa.observe(frame);
    this._lastEnergy = energy;
    this.emit("tick", { frame, energy });

    // 3. Branch.
    if (energy.anomaly) {
      // _onAnomaly() is called synchronously from the JEPA 'energy' listener
      // above; do nothing else here.
      return;
    }

    this._peacefulCount += 1;
    this.emit("peaceful", { frame, energy });

    // 4. Throttled passive narration.
    const retrieved = await this._retr.retrieve(frame);
    this._narr.maybeGenerate({
      featureVector: frame,
      energy,
      retrieved,
    });
  }

  /**
   * JEPA just flagged an anomaly. Override the narrator.
   */
  _onAnomaly(energy) {
    this._emergencyCount += 1;
    this.emit("anomaly", { frame: this._lastFrame, energy });

    // Fetch retrieved context in parallel with the abort. If the retriever
    // is sync, this still resolves immediately on the next microtask.
    const frameForPrompt = this._lastFrame ?? new Float64Array(this._ring.featureDim ?? 6);
    this._retr.retrieve(frameForPrompt)
      .catch(() => [])
      .then((retrieved) => {
        this._narr.forceEmergency({
          featureVector: frameForPrompt,
          energy,
          retrieved,
          emergencyHeader: EMERGENCY_PROMPT_HEADER,
        });
      });
  }
}

module.exports = {
  TrinityCore,
  EMERGENCY_PROMPT_HEADER,
  DEFAULT_INTERVAL_MS,
};