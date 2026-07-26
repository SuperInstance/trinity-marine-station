#!/usr/bin/env node
// Daemon smoke test.
// Starts the daemon briefly, hits /health and /status, validates that the
// a2aBridge section is present, then shuts it down cleanly.
//
// Usage: node tools/smokeDaemon.js

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.DAEMON_PORT || 8787;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
  });
}

async function waitFor(label, fn, timeoutMs = 8000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

(async () => {
  console.log("[smoke] starting daemon on port", PORT);
  // Use unique ports so we don't collide with a real daemon.
  const env = {
    ...process.env,
    OPS_PORT: String(PORT),
    OPS_HOST: "127.0.0.1",
    BRIDGE_PORT: String(31000 + Math.floor(Math.random() * 1000)),
    BRIDGE_HOST: "127.0.0.1",
    SIGNAL_K_URL: "ws://127.0.0.1:31010", // intentionally unreachable - we only test bridge, not full pipeline
    A2A_LOG_DIR: "./.smoke-a2a-logs",
  };
  // port 0 lets the OS pick; we'll read the real port from /status
  const proc = spawn(process.execPath, [path.join(ROOT, "backend/trinityDaemon.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log("[smoke] daemon exited code=" + code);
  });

  try {
    await waitFor("/health", async () => {
      const r = await get(`http://127.0.0.1:${PORT}/health`);
      return r.status === 200 ? r : null;
    });
    console.log("[smoke] /health returned 200");

    const statusResp = await waitFor("/status", async () => {
      const r = await get(`http://127.0.0.1:${PORT}/status`);
      return r.status === 200 ? r : null;
    });
    const status = JSON.parse(statusResp.body);
    console.log("[smoke] /status keys:", Object.keys(status).join(", "));

    if (!status.a2aBridge) {
      throw new Error("/status did not include a2aBridge section");
    }
    if (!status.a2aBridge.running) {
      throw new Error("a2aBridge.running is false: " + JSON.stringify(status.a2aBridge));
    }
    if (!status.a2aBridge.stats) throw new Error("a2aBridge.stats missing");
    console.log("[smoke] a2aBridge.stats:", JSON.stringify(status.a2aBridge.stats));

    console.log("[smoke] a2aBridge section valid: running=true, stats present");
    console.log("[smoke] ALL CHECKS PASSED");
  } catch (e) {
    console.error("[smoke] FAILED:", e.message);
    console.error("[smoke] daemon stderr:\n" + stderr);
    proc.kill("SIGKILL");
    process.exit(1);
  }

  // Graceful shutdown
  proc.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 3000);
    proc.on("exit", () => { clearTimeout(t); r(); });
  });
  process.exit(0);
})();