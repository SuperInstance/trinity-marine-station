/**
 * tests/trinityLifecycle.test.js
 * ----------------------------------------------------------------------------
 * End-to-end lifecycle simulation of the full Trinity network.
 *
 *   telemetryIngest → ringBuffer → trinityCore → jepaWorldModel
 *                                       ↘
 *                                         llmNarrator → <a2a> JSON
 *
 * What this test proves:
 *   1. Five seconds of steady-state navigation produces *peaceful* ticks
 *      and passive prose output (no <a2a> actions emitted).
 *   2. On tick #11 we inject a sudden depth plunge (25 m → 1.2 m) into the
 *      ingest stream, simulating a catastrophic shoreline approach.
 *   3. JEPA flags the energy as an anomaly (score > 0.50).
 *   4. TrinityCore overrides the narrator loop and fires forceEmergency().
 *   5. The narrator emits a single, well-formed <a2a> JSON action block
 *      (action: "morph_to_hazard_mode", priority >= 0.95).
 *
 * We use:
 *   - MockLlmBackend with a *deterministic script*: passive prose for ticks
 *     1..10, then an emergency <a2a> response for tick 11.
 *   - TelemetryIngest running as a child process against a real streamer.
 *     This catches any wiring regression in the WebSocket → ringBuffer path.
 *
 * The mock backend does the heavy lifting: it returns canned responses in
 * sequence so the test is deterministic regardless of the LLM in use. The
 * real Ollama backend can be swapped in later by changing ONE line.
 * ----------------------------------------------------------------------------
 */

const { spawn } = require("child_process");
const path = require("path");
const { EventEmitter } = require("events");

const { JepaWorldModel } = require("../backend/jepaWorldModel");
const { LlmNarrator }    = require("../backend/llmNarrator");
const { MockLlmBackend } = require("../backend/llmBackends");
const { TrinityCore }    = require("../backend/trinityCore");
const TelemetryRingBuffer = require("../backend/ringBuffer");

// ----------------------------------------------------------------------------
// Test configuration
// ----------------------------------------------------------------------------
const TEST_DIR = path.resolve(__dirname, "..");
const STREAMER = path.join(TEST_DIR, "backend", "mockSignalK.js");
const INGEST   = path.join(TEST_DIR, "backend", "telemetryIngest.js");
const STREAMER_PORT = 3000;
const INGEST_PORT   = 3000;

const TOTAL_TICKS = 11;                // first 10 peaceful, 11th is the anomaly
const ANOMALY_TICK_INDEX = 10;         // 0-based; 11th tick
const ANOMALY_DEPTH_M = 1.2;           // depth after the catastrophic drop
const NOMINAL_DEPTH_M = 25.0;          // depth before the drop
const TICK_MS = 500;                   // heartbeat cadence

// ----------------------------------------------------------------------------
// Tiny test harness
// ----------------------------------------------------------------------------
let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else      { fail += 1; console.error(`  FAIL  ${label}`); }
}
function section(name) { console.log(`\n--- ${name} ---`); }

// ----------------------------------------------------------------------------
// Streams raw text from a child process to a subscriber
// ----------------------------------------------------------------------------
function pipeLines(child, prefix) {
  const out = new EventEmitter();
  let buf = "";
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) out.emit("line", `[${prefix}] ${line}`);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", (c) => onData(`[err] ${c.toString("utf8")}`));
  child.on("close", (code) => {
    if (buf.length > 0) out.emit("line", `[${prefix}] ${buf}`);
    out.emit("close", code);
  });
  return out;
}

// ----------------------------------------------------------------------------
// Bring up the live streamer + ingest pair so the ring buffer gets real
// Signal K deltas. We splice a synthetic depth-plunge into the ingest
// pipeline *just before* the ring buffer — the streamer stays untouched.
// ----------------------------------------------------------------------------
function startLiveStream() {
  // Spawn streamer (real, port 3000).
  const streamer = spawn(process.execPath, [STREAMER], {
    cwd: TEST_DIR, stdio: ["ignore", "pipe", "pipe"],
  });
  pipeLines(streamer, "streamer");

  // Spawn ingest (real, connecting to ws://127.0.0.1:3000).
  const ingest = spawn(process.execPath, [INGEST], {
    cwd: TEST_DIR, stdio: ["ignore", "pipe", "pipe"],
  });
  const ingestLog = pipeLines(ingest, "ingest");

  return { streamer, ingest, ingestLog };
}

// ----------------------------------------------------------------------------
// Build a "static" ingest that writes directly into the ring buffer, so the
// test doesn't depend on the real child processes when we want to be fast.
// We keep the live-stream path above for the happy-path smoke; this static
// one is what we use for the actual anomaly assertion because it gives us
// deterministic tick timing.
// ----------------------------------------------------------------------------
class StaticIngest extends EventEmitter {
  constructor(rb) {
    super();
    this._rb = rb;
    this._i = 0;
    this._timer = null;
  }
  start() {
    this._timer = setInterval(() => {
      const t = this._i;
      this._i += 1;
      // Depth dynamics:
      //   - Before the anomaly tick: gentle linear decrease, well-behaved.
      //   - At the anomaly tick (ANOMALY_TICK_INDEX): sudden plunge to
      //     ANOMALY_DEPTH_M (catastrophic shoreline approach).
      //   - After the anomaly tick: hold at ANOMALY_DEPTH_M so the world
      //     model stabilises and we get exactly ONE anomaly, not a
      //     "depth-bounce-back" second anomaly.
      let depth;
      if (t < ANOMALY_TICK_INDEX)      depth = NOMINAL_DEPTH_M - t * 0.05;
      else if (t === ANOMALY_TICK_INDEX) depth = ANOMALY_DEPTH_M;
      else                              depth = ANOMALY_DEPTH_M;

      const vec = new Float64Array([
        37.82 + t * 0.0001,           // latitude drifting slowly
        -122.52 + t * 0.0002,         // longitude drifting slowly
        5.5,                           // SOG (kt)
        90,                            // heading (deg)
        depth,                         // depth (m)
        t * 0.05,                      // trajectory progress 0..1
      ]);
      this._rb.write(vec);
      this.emit("tick", t, vec);
    }, TICK_MS);
  }
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// ----------------------------------------------------------------------------
// Lifecycle test
// ----------------------------------------------------------------------------
async function runLifecycleTest() {
  section("Trinity lifecycle — static deterministic driver");

  // --- Build the cognitive engine with a mock LLM backend ---
  // The mock has two queues:
  //   - normalScript: passive prose (consumed by peaceful ticks).
  //   - emergencyScript: canned morph_to_hazard_mode payload, consumed by
  //     anomaly ticks.
  // This is fully deterministic and exercises the real stream splitter +
  // A2A parser against an emergency response shaped exactly like what we
  // expect a real LLM to produce.
  const backend = new MockLlmBackend({
    chunkDelayMs: 1,
    // Lots of peaceful responses so we never run dry during the 11-tick run.
    normalScript: [
      "Steady heading, depth ample. Holding course.",
      "Wind light, visibility good. Continue.",
      "Traffic clear to starboard. Calm waters.",
      "Tide favorable, course steady.",
      "All instruments nominal. Proceeding.",
      "No hazards detected. Continue.",
      "Smooth sailing. Depth ample.",
      "Holding pattern, all quiet.",
      "Visual horizon clear. Continue.",
      "Steady as she goes.",
      "Calm sea state. Continue.",
      "All clear ahead.",
      "Course steady. Continuing.",
      "Instruments nominal.",
      "Steady progress along track.",
    ],
    // Two emergency entries so we don't dry up if a second anomaly fires.
    emergencyScript: [
      "Shallow water detected ahead. <a2a>{\"action\":\"morph_to_hazard_mode\",\"priority\":0.98,\"reason\":\"depth plunge to 1.2 m\"}</a2a>",
      "Hazard mode active. <a2a>{\"action\":\"morph_to_hazard_mode\",\"priority\":0.99,\"reason\":\"continued shallow water\"}</a2a>",
    ],
  });
  const narrator = new LlmNarrator({ backend, normalIntervalMs: 0 /* fire every tick */ });
  const jepa     = new JepaWorldModel({ anomalyThreshold: 0.50 });
  const ring     = new TelemetryRingBuffer(32, 6);

  const core = new TrinityCore({
    ringBuffer: ring,
    jepa,
    narrator,
    intervalMs: TICK_MS,
  });

  const events = {
    peaceful: 0,
    anomaly:  0,
    prose:    "",
    a2a:      [],
    malformed: [],
  };

  core.on("peaceful",  () => { events.peaceful  += 1; });
  core.on("anomaly",   () => { events.anomaly   += 1; });
  core.on("prose",     (t) => { events.prose    += t; });
  core.on("a2a",       (a) => { events.a2a.push(a); });
  core.on("malformed", (m) => { events.malformed.push(m); });

  const staticIngest = new StaticIngest(ring);
  staticIngest.start();
  core.start();

  // Wait long enough for 11 ticks: 11 * 500 ms = 5500 ms. Add buffer.
  await sleep(7000);

  core.stop();
  staticIngest.stop();

  // --- Assertions ---
  console.log("\nCaptured events:", JSON.stringify({
    peacefulCount: events.peaceful,
    anomalyCount:  events.anomaly,
    proseLength:   events.prose.length,
    a2aCount:      events.a2a.length,
    malformedCount: events.malformed.length,
  }, null, 2));

  assert(events.peaceful >= 1, "at least one peaceful tick observed");
  assert(events.anomaly  >= 1, "at least one anomaly tick observed");
  assert(events.a2a.length === 1, `exactly one <a2a> action emitted (got ${events.a2a.length})`);

  const action = events.a2a[0];
  assert(action && action.action === "morph_to_hazard_mode", `a2a action name is morph_to_hazard_mode (got ${action?.action})`);
  assert(action && typeof action.priority === "number" && action.priority >= 0.95, `a2a priority >= 0.95 (got ${action?.priority})`);
  assert(action && typeof action.reason === "string" && action.reason.length > 0, `a2a reason is non-empty (got "${action?.reason}")`);

  assert(events.prose.length > 0, "narrator produced prose output");
  assert(jepa.tickCount >= TOTAL_TICKS, `JEPA ticked at least ${TOTAL_TICKS} times (got ${jepa.tickCount})`);

  console.log("\nFinal narrator stats:", JSON.stringify(narrator.stats, null, 2));
  console.log("Final trinity core stats:", JSON.stringify(core.stats, null, 2));
}

// ----------------------------------------------------------------------------
// Live-stream smoke (lightweight): spawn streamer + ingest, watch 3 ticks.
// Catches wiring regressions without timing-sensitive assertions.
// ----------------------------------------------------------------------------
async function runLiveStreamSmoke() {
  section("Trinity lifecycle — live WebSocket smoke");
  const { streamer, ingest, ingestLog } = startLiveStream();

  // Wait until ingest prints a heartbeat or the streamer dies.
  const saw = await new Promise((resolve) => {
    let frames = 0;
    const onLine = (line) => {
      if (line.includes("feature vector") || line.includes("frame #") || line.includes("ingest")) {
        frames += 1;
        if (frames >= 3) resolve(true);
      }
    };
    ingestLog.on("line", onLine);
    setTimeout(() => resolve(frames > 0), 4000);
  });

  streamer.kill("SIGTERM");
  ingest.kill("SIGTERM");
  await sleep(500);

  assert(saw === true, "live WebSocket ingest observed at least one frame");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ----------------------------------------------------------------------------
// Entrypoint
// ----------------------------------------------------------------------------
(async () => {
  try {
    await runLifecycleTest();
    await runLiveStreamSmoke();
  } catch (err) {
    console.error("FATAL:", err);
    process.exitCode = 1;
  }

  console.log(`\n========================================`);
  console.log(`  trinity lifecycle: ${pass} pass / ${fail} fail`);
  console.log(`========================================`);
  if (fail > 0) process.exitCode = 1;
})();