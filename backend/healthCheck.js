/**
 * backend/healthCheck.js
 * ----------------------------------------------------------------------------
 * A unified health check for the Trinity Daemon.
 *
 * The daemon has several moving pieces (streamer, ingest, JEPA, narrator,
 * vector store). The HTTP `/health` endpoint used to return a hardcoded
 * `{ok: true}` -- fine for happy path, useless for triage.
 *
 * This module probes each subsystem and aggregates the result into a single
 * structured payload so an operator can hit one URL and know what's wrong.
 *
 * Status levels:
 *   "ok"       everything is working
 *   "degraded" some non-critical subsystem is down (e.g. cloud LLM rate-limited)
 *              but core flow (stream → JEPA → ring buffer) is alive
 *   "down"     a critical subsystem is unreachable (e.g. no telemetry stream)
 *
 * Probes are async but designed to fail fast (we wrap each in a timeout).
 * The whole check is bounded by `overallTimeoutMs` so a single slow probe
 * never holds the HTTP response.
 * ----------------------------------------------------------------------------
 */

const DEFAULT_OVERALL_TIMEOUT_MS = 2000;
const DEFAULT_PROBE_TIMEOUT_MS   = 800;

const STATUS_OK       = "ok";
const STATUS_DEGRADED = "degraded";
const STATUS_DOWN     = "down";

/**
 * Wrap a probe with a timeout so it can never hang the health check.
 * Uses Promise.race so the probe promise is *resolved* (not just signalled)
 * at the timeout boundary.
 *
 * @param {(signal?: AbortSignal) => Promise<ProbeResult>} probe
 * @param {number} timeoutMs
 * @returns {Promise<ProbeResult>}
 */
async function runProbe(probe, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ ok: false, error: `probe timeout ${timeoutMs}ms` }), timeoutMs + 1);
  });
  try {
    const result = await Promise.race([
      probe(ac.signal),
      timeoutPromise,
    ]);
    return result;
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  } finally {
    clearTimeout(t);
    clearTimeout(timeoutHandle);
  }
}

/**
 * Build a health check that probes a fixed set of subsystems.
 *
 * @param {object}  opts
 * @param {Array<{ name: string, critical?: boolean, probe: (signal?: AbortSignal) => Promise<ProbeResult> }>} opts.probes
 * @param {number}  [opts.overallTimeoutMs=2000]
 * @param {number}  [opts.probeTimeoutMs=800]
 * @returns {{ check: () => Promise<HealthReport> }}
 */
function buildHealthCheck({ probes, overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  const list = probes ?? [];

  async function check() {
    const startedAt = Date.now();
    const overall = new AbortController();
    const t = setTimeout(() => overall.abort(), overallTimeoutMs);
    const results = await Promise.all(list.map(async (p) => {
      const r = await runProbe((sig) => {
        // If the overall budget is gone, abort the probe before it starts.
        if (overall.signal.aborted) return Promise.resolve({ ok: false, error: "overall timeout" });
        return p.probe(sig);
      }, probeTimeoutMs);
      return { name: p.name, critical: p.critical !== false, ...r };
    }));
    clearTimeout(t);

    // Aggregate: any critical probe failing → "down".
    // Any non-critical probe failing → "degraded" (but only if everything
    // critical is ok).
    const criticalFailures = results.filter((r) => r.critical && !r.ok);
    const softFailures     = results.filter((r) => !r.critical && !r.ok);

    let status = STATUS_OK;
    if (criticalFailures.length > 0) status = STATUS_DOWN;
    else if (softFailures.length > 0) status = STATUS_DEGRADED;

    return {
      status,
      durationMs: Date.now() - startedAt,
      probes: results,
      failingCritical: criticalFailures.map((r) => r.name),
      failingSoft:     softFailures.map((r) => r.name),
    };
  }

  return { check };
}

// ===========================================================================
// Common probe helpers used by the daemon's health check.
// ===========================================================================

/**
 * Probe the local MockSignalK TCP port. We just open a socket to the host
 * and short-circuit as soon as the connection establishes or rejects.
 *
 * @param {string} host
 * @param {number} port
 */
function tcpReachableProbe(host, port) {
  const net = require("net");
  return () => new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      ok ? resolve({ ok: true }) : reject(new Error(error));
    };
    sock.once("connect", () => done(true));
    sock.once("error",   (e) => done(false, e.message));
    setTimeout(() => done(false, "probe timeout"), 600).unref();
  });
}

/**
 * Probe an LLM backend by calling listModels() with a tight timeout.
 */
function backendReachableProbe(backend) {
  return async () => {
    const out = await backend.listModels();
    if (Array.isArray(out) && out.length > 0) return { ok: true, details: { modelCount: out.length } };
    return { ok: false, error: "listModels returned empty" };
  };
}

/**
 * Probe the ring buffer to make sure it can be read.
 */
function ringBufferProbe(buffer) {
  return () => {
    try {
      const latest = buffer.latest();
      const size = buffer.size?.() ?? 0;
      return { ok: true, details: { frames: size, hasLatest: latest != null } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

module.exports = {
  buildHealthCheck,
  tcpReachableProbe,
  backendReachableProbe,
  ringBufferProbe,
  STATUS_OK,
  STATUS_DEGRADED,
  STATUS_DOWN,
};
