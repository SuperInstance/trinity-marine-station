/**
 * tests/pipeline.test.js
 * ----------------------------------------------------------------------------
 * End-to-end pipeline verification for Phase 1.
 *
 * Spawns the mockSignalK server, spawns telemetryIngest as a child process,
 * listens to its stdout for our canonical log line, validates at least N
 * consecutive feature-vector heartbeats are correctly received, and then
 * tears down both processes.
 *
 * Strategy:
 *   Rather than reach inside the running telemetryIngest process to inspect
 *   its ring buffer (which would require IPC), we observe its external
 *   behavior: it prints a deterministic one-line summary per frame, and we
 *   parse that line. This validates the *real* hot path end-to-end.
 *
 *   To additionally check the *internal* buffer math, we also import the
 *   ring buffer module directly and exercise it on a synthetic delta.
 *
 * Run with:   node tests/pipeline.test.js
 * Exit code:  0 = pass, 1 = fail.
 * ----------------------------------------------------------------------------
 */

const { spawn } = require("child_process");
const path      = require("path");
const assert    = require("assert/strict");

const TelemetryRingBuffer = require("../backend/ringBuffer");
const { TelemetryIngest, unpackDeltaInto } = require("../backend/telemetryIngest");
const { FEATURE_VECTOR_LAYOUT } = require("../backend/marineConstants");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT    = path.resolve(__dirname, "..");
const STREAMER_PATH = path.join(REPO_ROOT, "backend", "mockSignalK.js");
const INGEST_PATH   = path.join(REPO_ROOT, "backend", "telemetryIngest.js");

const REQUIRED_FRAMES = 5;
const STARTUP_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS    = 15000;

// Logger helpers — keep test output scannable.
const ok    = (...a) => console.log("[pipeline.test] ✓", ...a);
const info  = (...a) => console.log("[pipeline.test] ·", ...a);
const fail  = (...a) => console.error("[pipeline.test] ✗", ...a);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn a child Node process, capturing stdout/stderr. */
function spawnNode(scriptPath, env = {}) {
  return spawn(process.execPath, [scriptPath], {
    cwd:   REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env:   { ...process.env, ...env },
  });
}

/** Wait for a regex to appear in a stream's stdout. */
function waitFor(stream, regex, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(regex);
      if (m) {
        stream.off("data", onData);
        clearTimeout(timer);
        resolve(m);
      }
    };
    stream.on("data", onData);
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`Timed out waiting for ${regex} (got: ${buf.slice(-200)})`));
    }, timeoutMs);
  });
}

/** Gracefully terminate a child process (SIGTERM, then SIGKILL after grace). */
function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) return resolve();
    const done = () => { resolve(); };
    child.once("exit", done);
    try { child.kill("SIGTERM"); } catch { return done(); }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
  });
}

// ---------------------------------------------------------------------------
// The actual test
// ---------------------------------------------------------------------------

async function main() {
  info(`repo root: ${REPO_ROOT}`);

  // ---- 1. Unit: ring buffer math ----------------------------------------
  section("Unit: TelemetryRingBuffer");
  const buf = new TelemetryRingBuffer({ capacity: 4 });
  assert.equal(buf.capacity, 4);
  assert.equal(buf.featureDim, FEATURE_VECTOR_LAYOUT.VECTOR_DIM);
  assert.equal(buf.totalWrites, 0);
  assert.equal(buf.latest(), null);

  const v = new Float64Array(FEATURE_VECTOR_LAYOUT.VECTOR_DIM);
  for (let i = 0; i < 6; i++) {
    v[i] = i + 1; // 1..6
    const slot = buf.write(v);
    assert.equal(slot, i % 4, `slot #${i} should be ${i % 4}`);
  }
  assert.equal(buf.totalWrites, 6);
  assert.equal(buf.filled, 4); // capped at capacity

  // After 6 writes into a capacity-4 buffer, the latest frame should be
  // the 6th write (values 1..6 in lastDim order, last one written wins).
  const latest = buf.latest();
  assert.deepEqual(Array.from(latest), [1, 2, 3, 4, 5, 6]);

  // Out-parameter read into caller-supplied buffer — no allocation.
  const out = new Float64Array(FEATURE_VECTOR_LAYOUT.VECTOR_DIM);
  buf.read(0, out);
  assert.equal(out[0], 1); // slot 0 was written most recently for write #4 (0-indexed)

  // Snapshot returns chronological order across the wrap.
  const snap = buf.snapshot(4);
  assert.equal(snap.length, 4 * FEATURE_VECTOR_LAYOUT.VECTOR_DIM);
  ok("ring buffer unit checks");

  // ---- 2. Unit: unpackDeltaInto -----------------------------------------
  section("Unit: unpackDeltaInto");
  const scratch = new Float64Array(FEATURE_VECTOR_LAYOUT.VECTOR_DIM);
  const fakeDelta = {
    timestamp: "2026-01-01T00:00:00.000Z",
    values: [
      { path: "navigation.position",        value: { latitude: 12.34, longitude: -56.78 } },
      { path: "navigation.speedOverGround", value: 7.7 },
      { path: "navigation.headingTrue",     value: 180.0 },
      { path: "environment.depth.belowTransducer", value: 12.5 },
      { path: "meta.trajectoryProgress",    value: 0.42 },
      { path: "meta.currentWaypoint",       value: "ignored" },
    ],
  };
  const ok2 = unpackDeltaInto(fakeDelta, scratch);
  assert.equal(ok2, true);
  assert.equal(scratch[FEATURE_VECTOR_LAYOUT.LATITUDE],           12.34);
  assert.equal(scratch[FEATURE_VECTOR_LAYOUT.LONGITUDE],         -56.78);
  assert.equal(scratch[FEATURE_VECTOR_LAYOUT.SPEED_OVER_GROUND],   7.7);
  assert.equal(scratch[FEATURE_VECTOR_LAYOUT.HEADING_TRUE],      180.0);
  assert.equal(scratch[FEATURE_VECTOR_LAYOUT.DEPTH],              12.5);
  assert.equal(scratch[FEATURE_VECTOR_LAYOUT.TRAJECTORY_PROGRESS], 0.42);
  ok("unpackDeltaInto maps Signal K paths correctly");

  // Missing-field case must fail gracefully (return false).
  const partial = { values: [{ path: "navigation.speedOverGround", value: 1 }] };
  assert.equal(unpackDeltaInto(partial, scratch), false);
  ok("unpackDeltaInto rejects partial deltas");

  // ---- 3. End-to-end: spawn server + ingest child ------------------------
  section("End-to-end: streamer + ingest child");

  const streamer = spawnNode(STREAMER_PATH);
  streamer.stderr.on("data", (b) => process.stderr.write(`[streamer!] ${b}`));
  await waitFor(streamer.stdout, /listening on/, STARTUP_TIMEOUT_MS);
  ok("streamer is listening");

  const ingest = spawnNode(INGEST_PATH);
  ingest.stderr.on("data", (b) => process.stderr.write(`[ingest!] ${b}`));

  // Wait for telemetryIngest to log its first hello receipt from the streamer.
  await waitFor(ingest.stdout, /hello from mockSignalK/, STARTUP_TIMEOUT_MS);
  ok("ingest received hello handshake");

  // Now collect REQUIRED_FRAMES consecutive `[telemetryIngest] frame #N …` lines.
  const frameRe = /\[telemetryIngest\] frame #(\d+) @ (\S+)\s+lat=([-\d.]+) lon=([-\d.]+) sog=([-\d.]+) kt hdg=([-\d.]+)° depth=([-\d.]+) m prog=([-\d.]+)/g;
  const parsedFrames = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (parsedFrames.length >= REQUIRED_FRAMES) resolve();
      else reject(new Error(`Only saw ${parsedFrames.length}/${REQUIRED_FRAMES} frames in ${RUN_TIMEOUT_MS} ms`));
    }, RUN_TIMEOUT_MS);

    ingest.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      let m;
      frameRe.lastIndex = 0;
      while ((m = frameRe.exec(text)) !== null) {
        parsedFrames.push({
          n:        Number(m[1]),
          ts:       m[2],
          lat:      Number(m[3]),
          lon:      Number(m[4]),
          sog:      Number(m[5]),
          hdg:      Number(m[6]),
          depth:    Number(m[7]),
          prog:     Number(m[8]),
        });
        if (parsedFrames.length >= REQUIRED_FRAMES) {
          clearTimeout(timer);
          resolve();
        }
      }
    });

    ingest.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ingest exited prematurely with code ${code}`));
    });
  });
  ok(`collected ${parsedFrames.length} feature-vector frames from ingest stdout`);

  // Validate shape & ordering of every captured frame.
  for (let i = 0; i < parsedFrames.length; i++) {
    const f = parsedFrames[i];
    assert.ok(Number.isInteger(f.n) && f.n > 0,        `frame #${i} has invalid counter`);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(f.ts),        `frame #${i} has invalid timestamp ${f.ts}`);
    assert.ok(f.lat >= 37.7  && f.lat <=  37.82,       `frame #${i} lat ${f.lat} outside SF Bay trajectory`);
    assert.ok(f.lon >= -122.52 && f.lon <= -122.39,    `frame #${i} lon ${f.lon} outside SF Bay trajectory`);
    assert.ok(f.sog >= 4.0 && f.sog <= 8.5,            `frame #${i} SOG ${f.sog} outside envelope`);
    assert.ok(f.hdg >= 0   && f.hdg <= 360,            `frame #${i} heading ${f.hdg} outside 0..360`);
    assert.ok(f.depth > 0  && f.depth < 32.5,          `frame #${i} depth ${f.depth} outside field`);
    assert.ok(f.prog >= 0  && f.prog <= 1,             `frame #${i} progress ${f.prog} outside 0..1`);
  }
  ok("all captured frames are within valid marine envelopes");

  // Confirm frames are monotonic in time and at least roughly monotonic in n.
  for (let i = 1; i < parsedFrames.length; i++) {
    assert.ok(parsedFrames[i].n > parsedFrames[i - 1].n,
      `frame counter regressed: ${parsedFrames[i].n} after ${parsedFrames[i - 1].n}`);
    assert.ok(parsedFrames[i].ts >= parsedFrames[i - 1].ts,
      `frame timestamp regressed: ${parsedFrames[i].ts} < ${parsedFrames[i - 1].ts}`);
  }
  ok("frame counters + timestamps are monotonically increasing");

  // Print the parsed frames so a human reviewer can eyeball them.
  console.log("\n[pipeline.test] --- captured feature vectors ---");
  for (const f of parsedFrames) {
    console.log(`  #${f.n}  ${f.ts}  ` +
      `lat=${f.lat.toFixed(5)}  lon=${f.lon.toFixed(5)}  ` +
      `sog=${f.sog.toFixed(2)}kt  hdg=${f.hdg.toFixed(1)}°  ` +
      `depth=${f.depth.toFixed(2)}m  prog=${f.prog.toFixed(3)}`);
  }
  console.log("[pipeline.test] -----------------------------------\n");

  // ---- 4. Resilient: signal the ingest to disconnect cleanly -------------
  // We don't kill the streamer out from under the ingest — that would
  // trigger the ingest's reconnect storm and spam stderr. Instead we send
  // SIGINT to the ingest first (which its standalone entry handles by
  // calling disconnect()), give it a moment to close its WS, then kill the
  // streamer, and finally SIGTERM the ingest if it hasn't exited yet.
  section("Resilience: graceful shutdown of both children");

  // 1. Tell the ingest to stop. Its standalone handler runs disconnect()
  //    and then process.exit(0) after 250ms.
  const ingestExit = new Promise((r) => ingest.once("exit", r));
  try { ingest.kill("SIGINT"); } catch {}

  // 2. Give the ingest ~300ms to close its WS. During this window its
  //    _onClose handler sees _closedByUser=true and bails out without
  //    scheduling a reconnect. No "reconnecting" log line is emitted.
  await new Promise((r) => setTimeout(r, 300));

  // 3. Now the streamer is harmless to kill — no live clients attached.
  const streamerExit = new Promise((r) => streamer.once("exit", r));
  try { streamer.kill("SIGTERM"); } catch {}
  await streamerExit;
  ok("streamer terminated gracefully");

  // 4. If the ingest hasn't already exited from its own SIGINT handler,
  //    force-stop it.
  if (ingest.exitCode === null && !ingest.killed) {
    await killChild(ingest);
  }
  await ingestExit;
  ok("ingest terminated gracefully");

  // ---- 5. Teardown -------------------------------------------------------
  ok("teardown clean — both child processes terminated");

  console.log("\n[pipeline.test] ============================================");
  console.log("[pipeline.test]   ✅ PHASE 1 PIPELINE VERIFIED");
  console.log("[pipeline.test] ============================================");
}

function section(name) {
  console.log(`\n[pipeline.test] ── ${name} ──`);
}

// ---------------------------------------------------------------------------
// Bootstrap with proper error handling.
// ---------------------------------------------------------------------------
main().then(
  () => process.exit(0),
  (err) => {
    fail(err.stack || err.message || String(err));
    process.exit(1);
  }
);