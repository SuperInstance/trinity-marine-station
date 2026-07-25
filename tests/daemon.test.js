/**
 * tests/daemon.test.js
 * ----------------------------------------------------------------------------
 * Lifecycle test for the TrinityDaemon entry point.
 *
 * Strategy:
 *   1. Spawn the mockSignalK server as a child process on port 3000.
 *   2. Boot the daemon in-process with the mock backend (MOCK_LLM=1).
 *   3. Wait for the first peaceful frame on the ops HTTP endpoint.
 *   4. Inject an anomaly tick by writing directly into the ring buffer.
 *   5. Confirm the daemon emits an anomaly + A2A in its snapshot.
 *   6. Shut down gracefully.
 *
 * Port 3000 assumption: the test runs in a clean local environment. If
 * something else is bound there, the test will fail loudly (good).
 *
 * Run with:  npm run test:daemon
 * ----------------------------------------------------------------------------
 */

const assert = require("node:assert/strict");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

// Set env BEFORE requires so createBackend() picks the mock path.
process.env.MOCK_LLM = "1";
process.env.STREAMER_EMBED = "false";
process.env.NARRATOR_INTERVAL_MS = "200";

const { loadConfig, buildTrinity } = require("../backend/trinityDaemon");

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { console.log(`  ok   ${name}`); pass++; },
                     (err) => { console.log(`  FAIL ${name}: ${err.message}`); fail++; failures.push({ name, err }); });
    }
    console.log(`  ok   ${name}`); pass++;
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`); fail++; failures.push({ name, err });
  }
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on("error", reject);
  });
}

(async () => {
  console.log("Daemon tests");

  // ---- 1. Spawn the Signal K streamer on the standard port 3000. ----
  const streamerScript = path.join(__dirname, "..", "backend", "mockSignalK.js");
  const streamer = spawn(process.execPath, [streamerScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Forward streamer logs so any binding error is visible.
  streamer.stdout.on("data", (b) => process.stdout.write(`[streamer] ${b}`));
  streamer.stderr.on("data", (b) => process.stderr.write(`[streamer] ${b}`));

  // Wait for the streamer to print "listening on".
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("streamer didn't print listening banner")), 5000);
    const onData = (b) => {
      if (b.toString().includes("listening on")) {
        streamer.stdout.removeListener("data", onData);
        clearTimeout(t);
        resolve();
      }
    };
    streamer.stdout.on("data", onData);
  });

  // ---- 2. Build the daemon in-process with the mock backend. ----
  const cfg = loadConfig({
    MOCK_LLM: "1",
    STREAMER_EMBED: "false",
    SIGNAL_K_URL: "ws://127.0.0.1:3000",
    NARRATOR_INTERVAL_MS: "200",
    ANOMALY_THRESHOLD: "0.5", // high enough to ignore natural drift
  });

  const t = await buildTrinity(cfg);

  // Start ops server on an ephemeral port.
  let opsSrv = null;
  const opsPort = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const body = JSON.stringify(t.snapshot(), null, 2);
      res.writeHead(200, {"content-type":"application/json","content-length":Buffer.byteLength(body)});
      res.end(body);
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      opsSrv = srv;
      resolve(srv.address().port);
    });
  });

  // Start the loop.
  t.ingest.connect();
  t.core.start();

  // ---- TEST 1: ops /health is reachable ----
  await test("ops /health returns ok", async () => {
    const r = await get(opsPort, "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  // ---- TEST 2: wait for at least one peaceful frame ----
  await test("daemon receives peaceful frames from streamer", async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snap = (await get(opsPort, "/status")).body;
      if (snap.lastFrame && snap.core.peacefulCount > 0) {
        assert.equal(snap.ingest.connected, true);
        assert.equal(snap.lastFrame.frame.length, 6);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no peaceful frame received within 5s");
  });

  // ---- TEST 3: anomaly path triggers an A2A mutation ----
  await test("anomaly triggers A2A mutation", async () => {
    // Disconnect the ingest FIRST so it doesn't try to reconnect when we
    // kill the streamer. This keeps stderr clean and deterministic.
    t.ingest.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    // Stop the streamer.
    streamer.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));

    // Inject a catastrophic frame directly into the ring buffer.
    const frame = new Float64Array(6);
    frame[0] = 37.81;  // lat
    frame[1] = -122.50; // lon
    frame[2] = 5.0;    // sog
    frame[3] = 90;     // hdg
    frame[4] = 1.2;    // depth — this is the anomaly signal
    frame[5] = 0.5;    // prog
    t.ringBuffer.write(frame);

    // Wait for the next anomaly to be picked up AND for the LLM to finish
    // streaming its emergency response (default mock ~140 chars / 12ms each).
    const deadline = Date.now() + 8000;
    let snap;
    while (Date.now() < deadline) {
      snap = (await get(opsPort, "/status")).body;
      if (snap.core.emergencyCount > 0 && snap.narrator.a2aActionsEmitted > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(snap.core.emergencyCount > 0, `expected emergencyCount > 0, got ${snap.core.emergencyCount}`);
    assert.ok(snap.narrator.a2aActionsEmitted > 0,
              `expected narrator a2aActionsEmitted > 0, got ${snap.narrator.a2aActionsEmitted}`);
  });

  // ---- TEST 4: snapshot exposes expected fields ----
  await test("ops /status includes all subsystems", async () => {
    const r = await get(opsPort, "/status");
    assert.equal(r.status, 200);
    assert.ok(r.body.ingest,    "missing ingest");
    assert.ok(r.body.jepa,      "missing jepa");
    assert.ok(r.body.narrator,  "missing narrator");
    assert.ok(r.body.core,      "missing core");
    assert.ok(r.body.retriever, "missing retriever");
    assert.ok(r.body.lastFrame, "missing lastFrame");
    assert.equal(typeof r.body.ts, "number");
  });

  // ---- TEST 5: shutdown chain is wired (manual teardown) ----
  await test("teardown: core.stop, narrator.destroy, ingest.disconnect", async () => {
    t.core.stop();
    t.narrator.destroy();
    t.ingest.disconnect();
    assert.equal(t.core.stats.running, false);
    assert.equal(t.ingest.isConnected, false);
  });

  // Cleanup.
  await new Promise((r) => opsSrv.close(r));
  streamer.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));

  // ---- summary ----
  console.log("---");
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
  console.log("daemon: ALL TESTS PASSED");
})();
