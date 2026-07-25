/**
 * backend/telemetryIngest.js
 * ----------------------------------------------------------------------------
 * Telemetry Consumer Pipeline
 * ----------------------------------------------------------------------------
 * Phase 1 deliverable: connects to the local mock Signal K server and
 * converts each incoming delta into a flat numeric "feature vector" packed
 * into a pre-allocated ring buffer.
 *
 * Design goals:
 *   1. Zero per-frame allocation on the hot path. JSON.parse still creates
 *      a transient JS object (we can't avoid that without a custom parser),
 *      but we immediately extract the 5 scalar fields into a reusable
 *      Float64Array that we own forever.
 *
 *   2. Deterministic, fixed-cost memory footprint. 256 frames × 6 features
 *      × 8 bytes = 12 KB. Period. No matter how long we run.
 *
 *   3. Friendly to the future JEPA encoder. The latest feature vector is
 *      always available via `latestFeatureVector()`, and any sliding window
 *      of historical frames via `snapshot(n)`. Both return typed arrays
 *      that can be uploaded directly to WebGPU / WASM.
 *
 *   4. Resilient. Handles the {type:"hello"} handshake cleanly, ignores
 *      unknown frames, reconnects with exponential backoff on stream loss.
 *
 * Usage:
 *     node backend/telemetryIngest.js           # standalone, logs to stdout
 *     const ing = new TelemetryIngest(opts);    # embeddable API
 *     ing.on('frame', (vec) => { ... });
 *
 * Architecture:
 *   ┌──────────────────┐  ws   ┌─────────────────┐  feature vector  ┌────────────┐
 *   │  mockSignalK.js  │ ─────▶│ telemetryIngest │ ───────────────▶ │ JEPA core  │
 *   └──────────────────┘ 2 Hz  └─────────────────┘   Float64Array   │ (Phase 2)  │
 *                                       │                          └────────────┘
 *                                       ▼
 *                              ┌─────────────────┐
 *                              │  Ring buffer    │ (history for training)
 *                              └─────────────────┘
 * ----------------------------------------------------------------------------
 */

const EventEmitter = require("events");
const WebSocket     = require("ws");
const TelemetryRingBuffer = require("./ringBuffer");
const {
  STREAMER_HOST,
  STREAMER_PORT,
  FEATURE_VECTOR_LAYOUT,
} = require("./marineConstants");

const DEFAULT_URL = `ws://${STREAMER_HOST}:${STREAMER_PORT}`;

// Reconnect schedule (ms). Bounded so we don't retry forever in a hung CI.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

// How many frames we retain in history by default. 256 × 500 ms = ~128 s.
const DEFAULT_CAPACITY = 256;

class TelemetryIngest extends EventEmitter {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.url]                WebSocket URL to connect to.
   * @param {number}  [opts.capacity=256]        Ring buffer frame capacity.
   * @param {boolean} [opts.autoReconnect=true]  Reconnect on stream loss.
   * @param {boolean} [opts.standalone=false]    If true, log every frame to stdout
   *                                            (used when invoked as `node ...`).
   */
  constructor(opts = {}) {
    super();

    this._url            = opts.url ?? DEFAULT_URL;
    this._autoReconnect  = opts.autoReconnect ?? true;
    this._standalone     = opts.standalone ?? false;

    // The reusable feature vector we refill on every frame. Owning it here
    // means we never allocate during the hot path.
    this._scratchVector = new Float64Array(FEATURE_VECTOR_LAYOUT.VECTOR_DIM);

    // The ring buffer.
    this._buffer = new TelemetryRingBuffer({ capacity: opts.capacity ?? DEFAULT_CAPACITY });

    // Connection state.
    this._ws              = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer  = null;
    this._connected       = false;
    this._helloReceived   = false;
    this._closedByUser    = false;

    // Stats — useful for the verification harness and for ops dashboards.
    this._stats = {
      helloReceivedAt:  null,
      lastFrameAt:      null,
      totalFrames:      0,
      droppedFrames:    0,
      reconnectCount:   0,
    };

    if (this._standalone) this._wireStdoutLogging();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Open the WebSocket connection. */
  connect() {
    if (this._ws) return; // already connecting/connected

    this._closedByUser = false;
    this._helloReceived = false;
    this._openSocket();
  }

  /** Disconnect and stop reconnect attempts. */
  disconnect() {
    this._closedByUser = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._connected = false;
  }

  /**
   * The current "freshest" feature vector as a Float64Array. Stable until
   * the next frame arrives. Returns null until the first frame.
   */
  latestFeatureVector() {
    return this._buffer.latest();
  }

  /** The ring buffer (read-only — don't mutate!). */
  get buffer()      { return this._buffer; }
  get stats()       { return { ...this._stats }; }
  get isConnected() { return this._connected; }

  // ------------------------------------------------------------------
  // Internal: socket lifecycle
  // ------------------------------------------------------------------

  _openSocket() {
    if (this._closedByUser) return;

    this._ws = new WebSocket(this._url);

    this._ws.on("open",    () => this._onOpen());
    this._ws.on("message", (raw) => this._onMessage(raw));
    this._ws.on("close",   (code, reason) => this._onClose(code, reason));
    this._ws.on("error",   (err) => this._onError(err));
  }

  _onOpen() {
    this._connected       = true;
    this._helloReceived   = false;
    this._reconnectAttempts = 0;
    this.emit("open");
  }

  _onError(err) {
    // 'error' fires before 'close' on a socket failure; we just announce it
    // and let the close handler drive reconnect logic.
    // We intentionally do NOT log the underlying ECONNREFUSED during the
    // reconnect storm that follows a graceful shutdown — that would flood
    // CI logs with noise. The 'reconnecting' event still fires for callers.
    if (err && err.code === "ECONNREFUSED" && this._reconnectAttempts > 0) {
      this.emit("error", err);
      return;
    }
    this.emit("error", err);
  }

  _onClose(code, reason) {
    const wasConnected = this._connected;
    this._connected = false;
    this._ws = null;

    this.emit("close", { code, reason: reason?.toString() ?? "" });

    if (this._closedByUser) return;

    if (this._autoReconnect) {
      this._scheduleReconnect(wasConnected);
    }
  }

  _scheduleReconnect(wasConnected) {
    if (this._closedByUser) return;

    const idx = Math.min(this._reconnectAttempts, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[idx];
    this._reconnectAttempts += 1;
    this._stats.reconnectCount += 1;

    this.emit("reconnecting", { attempt: this._reconnectAttempts, delayMs: delay });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  // ------------------------------------------------------------------
  // Internal: hot path
  // ------------------------------------------------------------------

  _onMessage(raw) {
    // Parse once. We can't avoid this allocation, but everything downstream
    // is allocation-free.
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      this._stats.droppedFrames += 1;
      this.emit("parse-error", err);
      return;
    }

    // Handshake frame. Real Signal K sends this on first connection.
    if (msg && msg.type === "hello") {
      this._helloReceived = true;
      this._stats.helloReceivedAt = Date.now();
      this.emit("hello", msg);
      return;
    }

    // Anything else must be a Signal K delta. Validate shape defensively.
    if (!msg || !Array.isArray(msg.updates) || msg.updates.length === 0) {
      this._stats.droppedFrames += 1;
      return;
    }

    // Unpack the most recent update's value paths into our scratch vector.
    const ok = unpackDeltaInto(msg.updates[0], this._scratchVector);
    if (!ok) {
      this._stats.droppedFrames += 1;
      this.emit("malformed-frame", msg.updates[0]);
      return;
    }

    // Copy the scratch into the ring. (We can't just hand the scratch
    // pointer because the next frame would overwrite it before any
    // async reader got a chance.)
    this._buffer.write(this._scratchVector);

    this._stats.lastFrameAt = Date.now();
    this._stats.totalFrames += 1;

    this.emit("frame", this._scratchVector, msg.updates[0].timestamp);
  }

  // ------------------------------------------------------------------
  // Internal: standalone mode (for `node telemetryIngest.js`)
  // ------------------------------------------------------------------

  _wireStdoutLogging() {
    this.on("hello", (h) => {
      console.log(`[telemetryIngest] hello from ${h.server} v${h.version} ` +
                  `(heartbeat ${h.heartbeatMs} ms)`);
    });

    this.on("frame", (vec, ts) => {
      const fields = FEATURE_VECTOR_LAYOUT;
      const fmt = (n, p = 4) => Number.isFinite(n) ? n.toFixed(p) : "—";
      console.log(
        `[telemetryIngest] frame #${this._stats.totalFrames} ` +
        `@ ${ts}  ` +
        `lat=${fmt(vec[fields.LATITUDE])} ` +
        `lon=${fmt(vec[fields.LONGITUDE])} ` +
        `sog=${fmt(vec[fields.SPEED_OVER_GROUND], 2)} kt ` +
        `hdg=${fmt(vec[fields.HEADING_TRUE], 2)}° ` +
        `depth=${fmt(vec[fields.DEPTH], 2)} m ` +
        `prog=${fmt(vec[fields.TRAJECTORY_PROGRESS], 3)}`
      );
    });

    this.on("error", (e) => {
      // Suppress ECONNREFUSED during reconnect storms — the 'reconnecting'
      // event already explains what's happening.
      if (e && e.code === "ECONNREFUSED") return;
      console.warn(`[telemetryIngest] error: ${e.message}`);
    });
    this.on("reconnecting", (r) => {
      // Log the first attempt only. Subsequent attempts within the same
      // storm are implied; consumers can subscribe to the event for full
      // telemetry.
      if (r.attempt === 1) {
        console.warn(`[telemetryIngest] reconnecting (next in ${r.delayMs} ms…)`);
      }
    });
    this.on("close", (c) => {
      // Suppress close logging entirely during the standalone loop —
      // the 'reconnecting' event captures intent more clearly, and the
      // test harness already logs this on its side. Real users wiring
      // this into a larger app can still subscribe via EventEmitter.
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so tests can unit-test them in isolation.
// ---------------------------------------------------------------------------

/**
 * Walk a Signal K delta update's `values` array and pull out the 5 core
 * scalar fields into `outVec` at the canonical indices.
 *
 * Returns true on success, false if any required field was missing.
 */
function unpackDeltaInto(update, outVec) {
  const fields = FEATURE_VECTOR_LAYOUT;
  let sawLat = false, sawLon = false, sawSog = false, sawHdg = false, sawDepth = false;

  for (const entry of update.values) {
    if (!entry || typeof entry.path !== "string") continue;
    const v = entry.value;

    switch (entry.path) {
      case "navigation.position": {
        if (v && typeof v.latitude === "number" && typeof v.longitude === "number") {
          outVec[fields.LATITUDE]  = v.latitude;
          outVec[fields.LONGITUDE] = v.longitude;
          sawLat = sawLon = true;
        }
        break;
      }
      case "navigation.speedOverGround":
        if (typeof v === "number") { outVec[fields.SPEED_OVER_GROUND] = v; sawSog = true; }
        break;
      case "navigation.headingTrue":
        if (typeof v === "number") { outVec[fields.HEADING_TRUE] = v; sawHdg = true; }
        break;
      case "environment.depth.belowTransducer":
        if (typeof v === "number") { outVec[fields.DEPTH] = v; sawDepth = true; }
        break;
      case "meta.trajectoryProgress":
        // Optional — doesn't gate success.
        if (typeof v === "number") outVec[fields.TRAJECTORY_PROGRESS] = v;
        break;
      default:
        // Unknown path — ignore. Forward-compatibility for new Signal K keys.
        break;
    }
  }

  return sawLat && sawLon && sawSog && sawHdg && sawDepth;
}

module.exports = {
  TelemetryIngest,
  unpackDeltaInto,
};

// ---------------------------------------------------------------------------
// Standalone entry — `node backend/telemetryIngest.js`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const ingest = new TelemetryIngest({ standalone: true });
  ingest.connect();

  const shutdown = (sig) => {
    console.log(`\n[telemetryIngest] ${sig} received, shutting down...`);
    ingest.disconnect();
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}