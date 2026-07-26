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
   * @param {object} [opts.watchers]   Optional WatcherRegistry (backend/watchers.js). If supplied,
   *                                    deterministic threshold rules can emit A2A actions before the
   *                                    LLM is consulted. Watcher-fired actions are routed through
   *                                    this core's 'a2a' event so they share the same persistence,
   *                                    broadcast, and LLM-notification path as narrator-issued
   *                                    actions. See docs/AELMA_SYNTHESIS.md for the design rationale.
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
    this._watchers = opts.watchers ?? null;  // optional; see JSDoc
    this._period = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this._threshold = opts.anomalyThreshold ?? this._jepa.anomalyThreshold;

    this._timer        = null;
    this._running      = false;
    this._lastFrame    = null;
    this._lastEnergy   = null;
    this._emergencyCount = 0;
    this._peacefulCount = 0;
    this._watcherFiredCount = 0;
    this._watcherErrorCount = 0;

    // Forward narrator events so consumers only need one EventEmitter.
    this._narr.on("prose",     (t) => this.emit("prose", t));
    this._narr.on("a2a",       (a) => this.emit("a2a", a));
    this._narr.on("malformed", (m) => this.emit("malformed", m));
    this._narr.on("error",     (e) => this.emit("narrator-error", e));

    // Wire watcher events so consumers see the same shape from one emitter.
    if (this._watchers) {
      this._watchers.on("fired", (action, info) => {
        this._watcherFiredCount += 1;
        // Stamp the source so downstream consumers can tell LLM vs watcher.
        const stamped = Object.freeze({
          ...action,
          source: "watcher",
          ruleId: info.ruleId,
          ruleName: info.ruleName,
        });
        this.emit("a2a", stamped);
        this.emit("watcher-fired", stamped, info);
      });
      this._watchers.on("error", (err, info) => {
        this._watcherErrorCount += 1;
        this.emit("watcher-error", err, info);
      });
    }

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
      running:            this._running,
      peacefulCount:      this._peacefulCount,
      emergencyCount:     this._emergencyCount,
      watcherFiredCount:  this._watcherFiredCount,
      watcherErrorCount:  this._watcherErrorCount,
      threshold:          this._threshold,
      narratorStats:      this._narr.stats,
      jepaTicks:          this._jepa.tickCount,
    };
  }
  get ringBuffer() { return this._ring; }
  get jepa()       { return this._jepa; }
  get narrator()   { return this._narr; }
  get watchers()   { return this._watchers; }

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

    // 2b. Deterministic watcher rules (if a WatcherRegistry was provided).
    // Watchers run *before* the LLM so time-critical alerts (shallow water,
    // heading off-course) are not delayed by an LLM round-trip. The
    // 'a2a' event handler above stamps source: "watcher" and forwards
    // them through the same persistence + broadcast path as LLM-issued
    // actions. Errors are caught by the registry itself; we do not need
    // a try/catch here unless we want to swallow the registry entirely.
    if (this._watchers) {
      this._watchers.evaluate(frame);
    }

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