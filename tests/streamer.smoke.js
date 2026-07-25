/**
 * tests/streamer.smoke.js
 * ----------------------------------------------------------------------------
 * Phase 1 smoke test for the mockSignalK streamer.
 *
 * Spins up backend/mockSignalK.js as a child process, opens a WebSocket
 * client to it, validates the hello frame and a small batch of heartbeats,
 * then cleanly terminates the server.
 *
 * Run with:   node tests/streamer.smoke.js
 * ----------------------------------------------------------------------------
 */

const { spawn } = require("child_process");
const path      = require("path");
const WebSocket = require("ws");

const HOST = "127.0.0.1";
const PORT = 3000;
const URL  = `ws://${HOST}:${PORT}`;

// How many heartbeats we want to receive before declaring success.
const REQUIRED_FRAMES = 6;

function log(...args) { console.log("[streamer.smoke]", ...args); }

function spawnStreamer() {
  const entry = path.resolve(__dirname, "..", "backend", "mockSignalK.js");
  log(`Spawning ${entry}`);
  const proc = spawn(process.execPath, [entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.stdout.on("data", (b) => process.stdout.write(`[streamer] ${b}`));
  proc.stderr.on("data", (b) => process.stderr.write(`[streamer!] ${b}`));
  return proc;
}

function waitForListening(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for streamer to start listening")), timeoutMs);
    const onChunk = (b) => {
      const s = b.toString();
      if (s.includes("listening on")) {
        clearTimeout(timer);
        proc.stdout.off("data", onChunk);
        resolve();
      }
    };
    proc.stdout.on("data", onChunk);
  });
}

function run() {
  return new Promise((resolve, reject) => {
    const proc = spawnStreamer();
    let cleaned = false;

    const cleanup = (code = 0, err) => {
      if (cleaned) return;
      cleaned = true;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 1500);
      if (err) reject(err); else resolve(code);
    };

    waitForListening(proc).then(() => {
      log("Streamer reports listening — opening client...");
      const ws = new WebSocket(URL);

      let hello = null;
      const heartbeats = [];

      ws.on("open", () => log("Client connected"));
      ws.on("error", (e) => cleanup(1, new Error(`Client error: ${e.message}`)));

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "hello") {
          hello = msg;
          log("Got hello:", JSON.stringify(hello));
          return;
        }

        if (msg.updates && Array.isArray(msg.updates)) {
          heartbeats.push(msg);
          log(`Heartbeat ${heartbeats.length}/${REQUIRED_FRAMES}`);

          if (heartbeats.length >= REQUIRED_FRAMES) {
            ws.close();
          }
        }
      });

      ws.on("close", () => {
        const ok = !!hello && heartbeats.length >= REQUIRED_FRAMES;
        log(`Closed. hello=${!!hello}, heartbeats=${heartbeats.length}, ok=${ok}`);
        cleanup(ok ? 0 : 1, ok ? null : new Error("Did not receive expected frames"));
      });
    }).catch(cleanup);
  });
}

run()
  .then((code) => {
    log(`PASS (exit ${code})`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[streamer.smoke] FAIL:", err.message);
    process.exit(1);
  });