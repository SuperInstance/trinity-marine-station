/**
 * backend/trinityDaemon.js
 * ----------------------------------------------------------------------------
 * The Trinity Daemon — one process, one entry point.
 *
 * Boots and wires together:
 *
 *   mockSignalK   (only if STREAMER_EMBED=true)
 *       |
 *       v
 *   TelemetryIngest  --(frame)-->  RingBuffer
 *                                          |
 *                                          v
 *                                     JepaWorldModel
 *                                          |
 *                       +------- (energy) -+------- (anomaly)
 *                       v                            v
 *              EmbeddingRetriever          LlmNarrator.forceEmergency
 *                       |                            |
 *                       +----> TrinityCore <---------+
 *                                  |
 *                                  v
 *                       unified event log (stdout)
 *                       + ops HTTP on port 3001
 *
 * Why a daemon:
 *   - One process to start (`npm start`) instead of three terminal windows.
 *   - One process to log, monitor, and shut down.
 *   - The ops HTTP endpoint (default 127.0.0.1:3001) exposes live status,
 *     counters, and the latest frame for dashboards / triage.
 *
 * Pull-and-play:
 *   - Set CLOUD_LLM_BASE_URL / CLOUD_LLM_API_KEY / CLOUD_LLM_MODEL to swap
 *     the local Ollama backend for a cloud OpenAI-compatible endpoint.
 *     No code change required.
 *   - Set MOCK_LLM=1 to use MockLlmBackend for offline demos and tests.
 *   - Set STREAMER_EMBED=false to attach to an external Signal K server
 *     (set SIGNAL_K_URL instead).
 *   - Set OPS_PORT to override the ops HTTP port (default 3001).
 * ----------------------------------------------------------------------------
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const {
  TelemetryIngest,
} = require("./telemetryIngest");
const {
  JepaWorldModel,
} = require("./jepaWorldModel");
const {
  LlmNarrator,
  createBackend,
} = require("./llmNarrator");
const {
  TrinityCore,
} = require("./trinityCore");
const {
  InMemoryVectorStore,
  EmbeddingRetriever,
} = require("./vectorStore");
const {
  A2aLog,
} = require("./a2aLog");
const {
  A2aBridge,
} = require("./a2aBridge");
const {
  WatcherRegistry,
} = require("./watchers");
const {
  WatcherHistory,
} = require("./watcherHistory");
const {
  STREAMER_HOST,
  STREAMER_PORT,
} = require("./marineConstants");

const DEFAULT_OPS_PORT      = 3001;
const DEFAULT_OPS_HOST      = "127.0.0.1";
const DEFAULT_BRIDGE_PORT   = 3002;
const DEFAULT_BRIDGE_HOST   = "127.0.0.1";

// ===========================================================================
// Logger — a single tagged line format for everything the daemon emits.
// Keeps human and machine log parsers happy.
// ===========================================================================

const TAG_LIFECYCLE = "LIFE";
const TAG_TICK      = "TICK";
const TAG_ENERGY    = "ENERGY";
const TAG_ANOMALY   = "ANOMALY";
const TAG_PROSE     = "PROSE";
const TAG_A2A       = "A2A";
const TAG_ERR       = "ERR";
const TAG_OPS       = "OPS";

function log(tag, message, fields = {}) {
  const ts = new Date().toISOString();
  const meta = Object.keys(fields).length
    ? " " + Object.entries(fields).map(([k, v]) => `${k}=${fmtField(v)}`).join(" ")
    : "";
  const line = `[${ts}] [${tag}] ${message}${meta}`;
  if (tag === TAG_ERR) console.error(line);
  else                  console.log(line);
}

function fmtField(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(4) : String(v);
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ===========================================================================
// Env -> config helper. Reads process.env once and freezes the result.
// ===========================================================================

function loadConfig(env = process.env) {
  const cfg = {
    // Streaming source
    streamerEmbed:  env.STREAMER_EMBED !== "false",
    signalKUrl:     env.SIGNAL_K_URL ?? `ws://${STREAMER_HOST}:${STREAMER_PORT}`,

    // LLM backend
    mockLlm:        env.MOCK_LLM === "1" || env.MOCK_LLM === "true",
    cloudBaseUrl:   env.CLOUD_LLM_BASE_URL ?? null,
    cloudModel:     env.CLOUD_LLM_MODEL   ?? null,
    cloudApiKey:    env.CLOUD_LLM_API_KEY  ?? null,
    localModel:     env.LOCAL_LLM_MODEL    ?? "qwen3:4b",
    localEmbedModel: env.LOCAL_LLM_EMBED   ?? "nomic-embed-text:latest",

    // Behaviour
    anomalyThreshold:  env.ANOMALY_THRESHOLD ? Number(env.ANOMALY_THRESHOLD) : undefined,
    normalIntervalMs:  env.NARRATOR_INTERVAL_MS ? Number(env.NARRATOR_INTERVAL_MS) : 4000,
    ringCapacity:      env.RING_CAPACITY ? Number(env.RING_CAPACITY) : 256,

    // Ops HTTP
    opsHost: env.OPS_HOST ?? DEFAULT_OPS_HOST,
    opsPort: env.OPS_PORT ? Number(env.OPS_PORT) : DEFAULT_OPS_PORT,

    // A2A audit log
    a2aLogDir:       env.A2A_LOG_DIR ?? "./logs/a2a",
    a2aLogMaxBytes:  env.A2A_LOG_MAX_BYTES ? Number(env.A2A_LOG_MAX_BYTES) : undefined,
    a2aLogDisabled:  env.A2A_LOG_DISABLED === "1" || env.A2A_LOG_DISABLED === "true",

    // A2A WebSocket bridge (Phase 5 — Theia frontend transport)
    bridgeHost:      env.BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST,
    bridgePort:      env.BRIDGE_PORT ? Number(env.BRIDGE_PORT) : DEFAULT_BRIDGE_PORT,
    bridgeDisabled:  env.BRIDGE_DISABLED === "1" || env.BRIDGE_DISABLED === "true",

    // Watchers (Phase 7 — deterministic A2A rules, see backend/watchers.js
    // and docs/AELMA_SYNTHESIS.md). WATCHERS_DISABLED=1 turns them off; the
    // daemon defaults to on because the built-in rules are conservative
    // (raise_alert on shallow water, highlight_waypoint on heading drift)
    // and the LLM is informed rather than bypassed.
    watchersDisabled: env.WATCHERS_DISABLED === "1" || env.WATCHERS_DISABLED === "true",
  };

  // Source description (used in startup banner)
  if (cfg.cloudBaseUrl && cfg.cloudModel) {
    cfg.source = `cloud ${cfg.cloudBaseUrl} model=${cfg.cloudModel}`;
  } else if (cfg.mockLlm) {
    cfg.source = "mock backend";
  } else {
    cfg.source = `local ollama model=${cfg.localModel}`;
  }
  return Object.freeze(cfg);
}

// ===========================================================================
// Streamer lifecycle — only used when STREAMER_EMBED=true.
// ===========================================================================

let streamerProc = null;

function startStreamer() {
  const script = path.join(__dirname, "mockSignalK.js");
  const proc = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  // Tag and forward streamer logs so they're easy to distinguish from daemon.
  proc.stdout.on("data", (b) => process.stdout.write(prefixStreamer(b.toString())));
  proc.stderr.on("data", (b) => process.stderr.write(prefixStreamer(b.toString())));
  proc.on("exit", (code, sig) => {
    log(TAG_LIFECYCLE, "embedded streamer exited", { code, sig });
    streamerProc = null;
  });
  return proc;
}

function prefixStreamer(s) {
  return s
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[streamer] ${line}`)
    .join("\n") + "\n";
}

function stopStreamer() {
  if (!streamerProc) return Promise.resolve();
  return new Promise((resolve) => {
    const proc = streamerProc;
    streamerProc = null;
    const t = setTimeout(() => proc.kill("SIGKILL"), 2000);
    proc.on("exit", () => { clearTimeout(t); resolve(); });
    try { proc.kill("SIGTERM"); } catch {}
  });
}

// ===========================================================================
// Default watcher rule set
// ----------------------------------------------------------------------------
// A small, conservative set of deterministic rules that fire before the LLM
// is consulted. Each rule emits a single A2A action and tags it with
// source: "watcher" so downstream consumers can distinguish watcher-fired
// from narrator-issued actions. Rules here are deliberately simple — anything
// nuanced belongs in the LLM. See backend/watchers.js and
// docs/AELMA_SYNTHESIS.md for the design rationale.
// ===========================================================================
function buildDefaultWatchers() {
  // Shared suppression state. Per-rule cooldowns are declared on each rule
  // below; this history is the single accumulator that records when each
  // rule last fired and rejects duplicates within its window. See
  // backend/watcherHistory.js for the suppression contract.
  const history = new WatcherHistory();
  const reg = new WatcherRegistry({ history });
  reg.add({
    id: "shallow-water",
    name: "Shallow water warning",
    cooldownMs: 30_000,         // suppress repeats for 30s
    when: (f) => f && f.depth != null && f.depth < 2.0,
    action: {
      name: "raise_alert",
      payload: (f) => ({ kind: "shallow_water", depth: f.depth }),
      reason: (f) => `depth=${f.depth.toFixed(2)}m < 2.0m threshold`,
      priority: () => 0.85,
    },
  });
  reg.add({
    id: "heading-off-course",
    name: "Heading deviates from expected range",
    cooldownMs: 60_000,         // suppress repeats for 60s
    when: (f) => f && f.headingTrue != null && (f.headingTrue < 10 || f.headingTrue > 350),
    action: {
      name: "highlight_waypoint",
      payload: (f) => ({ heading: f.headingTrue }),
      reason: (f) => `heading=${f.headingTrue.toFixed(1)}° is outside [10, 350]°`,
      priority: () => 0.6,
    },
  });
  reg.add({
    id: "speed-anomaly",
    name: "Unusual speed (likely a stale or lost sensor)",
    cooldownMs: 45_000,         // suppress repeats for 45s
    when: (f) => f && f.speedOverGround != null && f.speedOverGround > 30,
    action: {
      name: "announce",
      payload: (f) => ({ kind: "speed_anomaly", sog: f.speedOverGround }),
      reason: (f) => `speed=${f.speedOverGround.toFixed(1)}kt > 30kt (likely sensor fault)`,
      priority: () => 0.7,
    },
  });
  // Expose the history on the registry so the /status snapshot can show
  // suppression rates without re-walking the rule list.
  reg._history = history;
  return reg;
}

// ===========================================================================
// Ops HTTP — tiny read-only dashboard for human + machine eyes.
// ===========================================================================

function startOpsServer({ host, port, getSnapshot }) {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/" || url === "/status")) {
      const body = JSON.stringify(getSnapshot(), null, 2);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log(TAG_OPS, "ops server listening", { host, port });
      resolve(server);
    });
  });
}

function stopOpsServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

// ===========================================================================
// Trinity wiring — given config, build every piece and return the live graph.
// ===========================================================================

async function buildTrinity(cfg) {
  // LLM backend choice.
  const backend = cfg.mockLlm
    ? new (require("./llmBackends").MockLlmBackend)()
    : createBackend({
        // Pass through explicit overrides; env-derived defaults are applied
        // inside createBackend() if no override is supplied.
        backend: cfg.cloudBaseUrl && cfg.cloudModel
          ? new (require("./llmBackends").OpenAiCompatibleBackend)({
              baseUrl: cfg.cloudBaseUrl,
              apiKey:  cfg.cloudApiKey,
              model:   cfg.cloudModel,
            })
          : undefined,
        httpOpts: { defaultModel: cfg.localModel, defaultEmbedModel: cfg.localEmbedModel },
      });

  // Associative memory.
  const store = new InMemoryVectorStore({ dim: cfg.localEmbedModel ? 768 : 8 });
  const retriever = new EmbeddingRetriever({
    store,
    embedFn: cfg.mockLlm ? null : (text) => backend.embed({ text }).then((r) => r.vector),
    topK: 3,
  });

  // Seed the memory with a few canonical "past log" entries so retrieval
  // is exercised on the first peaceful frame. Only meaningful when we have
  // a real embedder (otherwise text cannot be embedded).
  if (!cfg.mockLlm) {
    try {
      await store.addText("vessel on coastal approach, depth steady ~30 m", retriever._embedFn, { source: "log" });
      await store.addText("approaching Golden Gate, light fog, traffic moderate", retriever._embedFn, { source: "log" });
    } catch (err) {
      log(TAG_ERR, "failed to seed vector store", { error: err.message });
    }
  }

  // Telemetry -- ring buffer (created internally by the ingest).
  const ingest = new TelemetryIngest({
    url: cfg.signalKUrl,
    capacity: cfg.ringCapacity,
    autoReconnect: true,
  });

  // Cognitive layers.
  const jepa = new JepaWorldModel(
    cfg.anomalyThreshold !== undefined ? { anomalyThreshold: cfg.anomalyThreshold } : {}
  );
  const narrator = new LlmNarrator({
    backend,
    normalIntervalMs: cfg.normalIntervalMs,
  });

  // Watcher registry — deterministic threshold rules that emit A2A
  // actions before the LLM is consulted. Disabled with WATCHERS_DISABLED=1.
  // See backend/watchers.js and docs/AELMA_SYNTHESIS.md.
  const watchers = cfg.watchersDisabled ? null : buildDefaultWatchers();

  const core = new TrinityCore({
    ringBuffer: ingest.buffer,
    jepa,
    narrator,
    retriever,
    watchers,
    intervalMs: 500,
  });

  // A2A audit log — persists every emitted workspace mutation. Writes are
  // batched (~100ms) and rotated by size, so the cost is negligible even at
  // high anomaly rates. Disable with A2A_LOG_DISABLED=1 for ephemeral tests.
  const a2aLog = cfg.a2aLogDisabled ? null : new A2aLog({
    dir: cfg.a2aLogDir,
    ...(cfg.a2aLogMaxBytes ? { maxBytes: cfg.a2aLogMaxBytes } : {}),
  });

  // A2A WebSocket bridge — Phase 5 fan-out transport for the Theia
  // frontend (and any other listener). Reuses the same a2aLog so
  // acknowledgements and replays share one durable record. Disable with
  // BRIDGE_DISABLED=1 for tests that don't need it.
  let a2aBridge = null;
  if (!cfg.bridgeDisabled) {
    a2aBridge = new A2aBridge({
      core,
      a2aLog,
      host: cfg.bridgeHost,
      port: cfg.bridgePort,
      verbose: false,
    });
    a2aBridge.start().catch((err) => {
      log(TAG_ERR, "a2a bridge failed to start", { error: err.message });
    });
  }

  // ---------- event wiring ----------
  const frameBuffer = { last: null };
  ingest.on("open",      () => log(TAG_LIFECYCLE, "ingest open", { url: cfg.signalKUrl }));
  ingest.on("hello",     (h) => log(TAG_LIFECYCLE, "streamer hello", { server: h.server, v: h.version }));
  ingest.on("reconnecting", (r) => log(TAG_LIFECYCLE, "ingest reconnecting", { attempt: r.attempt, delayMs: r.delayMs }));
  ingest.on("error",     (e) => {
    // Suppress ECONNREFUSED during reconnect storms — the 'reconnecting'
    // event already explains what's happening. Real failures still surface.
    if (e?.code === "ECONNREFUSED") return;
    log(TAG_ERR, "ingest error", { error: e?.message ?? String(e), code: e?.code });
  });
  ingest.on("close",     (c) => log(TAG_LIFECYCLE, "ingest close", { code: c?.code }));

  core.on("tick",     ({ frame, energy }) => {
    // Convert to a plain array for the snapshot cache so JSON serialization
    // preserves the values. Keep the typed array reference for hot paths.
    frameBuffer.last = {
      frame:   Array.from(frame),
      energy:  { score: energy.score, anomaly: energy.anomaly, reason: energy.reason },
    };
    log(TAG_TICK, "frame", {
      lat: frame[0], lon: frame[1], sog: frame[2], hdg: frame[3],
      depth: frame[4], prog: frame[5],
      energy: energy.score,
    });
  });
  core.on("peaceful", () => {
    // Peaceful ticks are already covered by TAG_TICK above; we don't log
    // here to avoid spam. This is a hook for future UI updates.
  });
  core.on("anomaly",  ({ energy }) => {
    log(TAG_ANOMALY, "JEPA flagged anomaly", {
      score: energy.score, reason: energy.reason,
    });
  });
  core.on("prose",    (text) => {
    log(TAG_PROSE, text.trim().slice(0, 280));
  });
  core.on("a2a",      (action) => {
    log(TAG_A2A, "mutation", {
      action: action.action,
      priority: action.priority,
      reason: action.reason,
    });
    // Persist every validated mutation to the audit log. The log augments
    // the record with _loggedAt + _seq, so we don't lose the original priority.
    if (a2aLog) {
      a2aLog.append(action).catch((err) => {
        log(TAG_ERR, "a2a log append failed", { error: err?.message ?? String(err) });
      });
    }
  });
  core.on("malformed",({ raw, error }) => {
    log(TAG_ERR, "malformed A2A", { error, raw: raw.slice(0, 120) });
  });
  core.on("narrator-error", (err) => {
    log(TAG_ERR, "narrator error", { error: err?.message ?? String(err) });
  });
  core.on("error", (err) => {
    log(TAG_ERR, "core error", { error: err?.message ?? String(err) });
  });

  return {
    backend, ingest, jepa, narrator, core, retriever, store, a2aLog, a2aBridge, watchers,
    ringBuffer: ingest.buffer,
    frameBuffer,
    snapshot: () => ({
      ts: Date.now(),
      ingest: {
        connected:   ingest.isConnected,
        stats:       ingest.stats,
      },
      jepa: {
        tickCount:       jepa.tickCount,
        anomalyCount:    jepa.anomalyCount,
        recentEnergies:  jepa.recentEnergies ?? [],
      },
      narrator: narrator.stats,
      core:     core.stats,
      retriever: { size: retriever.size },
      watchers: watchers
        ? {
            ruleCount: watchers.size,
            rules: watchers.list(),
            history: watchers.stats.historyStats,
          }
        : { disabled: true },
      a2aLog:   a2aLog ? a2aLog.stats() : { disabled: true },
      a2aBridge: a2aBridge
        ? {
            running: a2aBridge.running,
            clientCount: a2aBridge.clientCount,
            stats: a2aBridge.stats(),
          }
        : { disabled: true },
      lastFrame: frameBuffer.last,
    }),
  };
}

// ===========================================================================
// Main: build, wire, run, shutdown.
// ===========================================================================

async function main() {
  const cfg = loadConfig();

  log(TAG_LIFECYCLE, "trinity daemon starting", {
    source: cfg.source,
    streamerEmbed: cfg.streamerEmbed,
    signalKUrl: cfg.signalKUrl,
    opsHost: cfg.opsHost,
    opsPort: cfg.opsPort,
    bridgeHost: cfg.bridgeHost,
    bridgePort: cfg.bridgePort,
    ringCapacity: cfg.ringCapacity,
    normalIntervalMs: cfg.normalIntervalMs,
  });

  // Optional embedded streamer.
  if (cfg.streamerEmbed) {
    streamerProc = startStreamer();
    // Give the streamer a moment to bind its port before ingest connects.
    await new Promise((r) => setTimeout(r, 400));
  }

  const t = await buildTrinity(cfg);

  // Ops HTTP.
  let opsServer = null;
  try {
    opsServer = await startOpsServer({
      host: cfg.opsHost,
      port: cfg.opsPort,
      getSnapshot: t.snapshot,
    });
  } catch (err) {
    log(TAG_ERR, "ops server failed to start", { error: err.message });
    // Continue without ops — it's not load-bearing.
  }

  // Start the loop.
  t.ingest.connect();
  t.core.start();

  log(TAG_LIFECYCLE, "trinity daemon running");

  // Graceful shutdown.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(TAG_LIFECYCLE, "shutdown initiated", { signal });
    try {
      t.core.stop();
      t.narrator.destroy();
      t.ingest.disconnect();
      // Stop the bridge BEFORE we tear the audit log down — otherwise the
      // bridge's "ack persisted" writes race with destroy() and we lose
      // the final acknowledgements.
      if (t.a2aBridge) await t.a2aBridge.stop();
      // Flush the A2A audit log BEFORE we tear anything else down so any
      // in-flight mutation that's still pending a write gets durably saved.
      if (t.a2aLog) await t.a2aLog.destroy();
      await stopOpsServer(opsServer);
      if (cfg.streamerEmbed) await stopStreamer();
      log(TAG_LIFECYCLE, "shutdown complete");
      process.exit(0);
    } catch (err) {
      log(TAG_ERR, "shutdown error", { error: err.message });
      process.exit(1);
    }
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log(TAG_ERR, "uncaughtException", { error: err?.message ?? String(err), stack: err?.stack });
  });
  process.on("unhandledRejection", (reason) => {
    log(TAG_ERR, "unhandledRejection", { reason: reason?.message ?? String(reason) });
  });

  return { shutdown };
}

module.exports = {
  main,
  loadConfig,
  buildTrinity,
  log,
  DEFAULT_OPS_PORT,
  DEFAULT_OPS_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_BRIDGE_HOST,
  TAG_LIFECYCLE,
  TAG_TICK,
  TAG_ENERGY,
  TAG_ANOMALY,
  TAG_PROSE,
  TAG_A2A,
  TAG_ERR,
  TAG_OPS,
};

// ===========================================================================
// Standalone entry — `node backend/trinityDaemon.js`
// ===========================================================================
if (require.main === module) {
  main().catch((err) => {
    log(TAG_ERR, "daemon failed to start", { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
