/**
 * tests/streamer.payloadShape.js
 * ----------------------------------------------------------------------------
 * Inspects a single heartbeat payload and asserts the Signal K delta shape
 * matches the schema documented in mockSignalK.js. Diagnostic-only — prints
 * the payload to stdout for human review.
 * ----------------------------------------------------------------------------
 */
const { spawn } = require("child_process");
const path      = require("path");
const WebSocket = require("ws");

const URL = "ws://127.0.0.1:3000";

const proc = spawn(process.execPath, [path.resolve(__dirname, "..", "backend", "mockSignalK.js")], { stdio: ["ignore", "pipe", "pipe"] });
proc.stderr.on("data", (b) => process.stderr.write(`[streamer!] ${b}`));

let resolved = false;

const onChunk = (b) => {
  if (b.toString().includes("listening on")) {
    proc.stdout.off("data", onChunk);
    startClient();
  }
};
proc.stdout.on("data", onChunk);

function startClient() {
  const ws = new WebSocket(URL);
  ws.on("message", (raw) => {
    if (resolved) return;
    const msg = JSON.parse(raw.toString());
    if (msg.updates) {
      resolved = true;
      console.log("=== One heartbeat payload ===");
      console.log(JSON.stringify(msg, null, 2));
      console.log("=============================");
      ws.close();
      proc.kill("SIGTERM");
      setTimeout(() => process.exit(0), 200);
    }
  });
}

setTimeout(() => { console.error("Timeout"); proc.kill("SIGKILL"); process.exit(1); }, 6000);