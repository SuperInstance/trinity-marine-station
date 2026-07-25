/**
 * backend/mockSignalK.js
 * ----------------------------------------------------------------------------
 * Mock Signal K Telemetry Streamer
 * ----------------------------------------------------------------------------
 * Phase 1 deliverable: a Node.js background utility that simulates a real-time
 * boat telemetry stream over a local WebSocket server on port 3000.
 *
 * It mirrors what an actual Signal K server would output to a connected
 * client — same JSON shape, same heartbeat cadence, same delta updates —
 * but the data is synthesized by a NavigationSimulator instead of arriving
 * from real NMEA 2000 hardware on a CAN bus.
 *
 * Run with:   npm run streamer
 * Stop with:  Ctrl+C
 *
 * Architecture:
 *   ┌─────────────────────┐   every 500ms   ┌─────────────────────┐
 *   │ NavigationSimulator │ ───────────────▶│  WebSocket clients  │
 *   │  (pure simulation)  │                 │  (Theia, ingest, …) │
 *   └─────────────────────┘                 └─────────────────────┘
 *
 * Key properties:
 *   - Stateless from the broadcaster's POV — we don't remember clients.
 *   - Backpressure-safe — we drop slow clients instead of queueing.
 *   - Self-contained — no external services required.
 * ----------------------------------------------------------------------------
 */

const WebSocket = require("ws");
const NavigationSimulator = require("./navigationSimulator");
const {
  STREAMER_PORT,
  STREAMER_HOST,
  HEARTBEAT_INTERVAL_MS,
  MAX_CLIENT_BACKLOG,
  TRAJECTORY_WAYPOINTS,
} = require("./marineConstants");

// ---------------------------------------------------------------------------
// 1. Boot the navigation simulator
// ---------------------------------------------------------------------------
// The simulator owns all "world state". It is intentionally independent of
// the WebSocket transport so we can reuse it in tests and (later) inside the
// JEPA world-model for counterfactual prediction.
const sim = new NavigationSimulator();

// Track the timestamp of the previous tick so we can advance physics by
// the real elapsed delta (instead of assuming a perfect 500 ms cadence).
let lastTickMs = Date.now();

// ---------------------------------------------------------------------------
// 2. WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({
  host: STREAMER_HOST,
  port: STREAMER_PORT,
  // The default per-message-deflate compression is OFF — marine telemetry is
  // tiny JSON and compression adds CPU cost we don't need for Phase 1.
});

// Heartbeat timer — broadcast 2 Hz, regardless of client count.
// We keep a handle so we can cancel it on graceful shutdown.
const heartbeat = setInterval(() => {
  const nowMs = Date.now();
  const dtMs  = nowMs - lastTickMs;
  lastTickMs  = nowMs;

  // Advance the world and get a fresh snapshot.
  const snapshot = sim.tick(dtMs);

  // Attach a stream identity so downstream consumers can detect reconnects.
  // Signal K also wraps its updates this way.
  const delta = {
    context: `vessels.self`,
    updates: [
      {
        timestamp: snapshot.timestamp,
        values: [
          { path: "navigation.position",                  value: snapshot.navigation.position },
          { path: "navigation.speedOverGround",           value: snapshot.navigation.speedOverGround },
          { path: "navigation.headingTrue",               value: snapshot.navigation.headingTrue },
          { path: "environment.depth.belowTransducer",    value: snapshot.environment.depth.belowTransducer },
          { path: "meta.trajectoryProgress",              value: snapshot.meta.trajectoryProgress },
          { path: "meta.currentWaypoint",                 value: snapshot.meta.currentWaypoint },
        ],
      },
    ],
  };

  // Serialize once, fan-out to all clients.
  const payload = JSON.stringify(delta);

  // Iterate over clients with a snapshot of the Set. We don't await — if a
  // client can't keep up, we drop its frames and let it resync via the next
  // full-state heartbeat.
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    // Backpressure check: if the OS send buffer for this socket has more than
    // MAX_CLIENT_BACKLOG queued messages, the client is too slow. Close the
    // socket so it can reconnect with a clean slate.
    if (client.bufferedAmount > MAX_CLIENT_BACKLOG * payload.length) {
      console.warn(
        `[mockSignalK] Dropping slow client ${shortId(client)} ` +
        `(bufferedAmount=${client.bufferedAmount} bytes)`
      );
      client.terminate();
      continue;
    }

    client.send(payload);
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 3. Connection lifecycle
// ---------------------------------------------------------------------------
wss.on("connection", (socket, req) => {
  const clientId = shortId(socket);

  console.log(
    `[mockSignalK] Client connected  ${clientId}  ` +
    `(${wss.clients.size} total) from ${req.socket.remoteAddress}`
  );

  // Immediately send a hello with the server identity. Real Signal K does
  // something similar on handshake (HTTP returns a self-description doc,
  // then WS upgrades).
  socket.send(JSON.stringify({
    type: "hello",
    server: "mockSignalK",
    version: "0.1.0-phase1",
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
  }));

  socket.on("close", () => {
    console.log(
      `[mockSignalK] Client disconnected ${clientId}  ` +
      `(${wss.clients.size} remaining)`
    );
  });

  socket.on("error", (err) => {
    console.warn(`[mockSignalK] Client error ${clientId}: ${err.message}`);
  });
});

// ---------------------------------------------------------------------------
// 4. Graceful shutdown
// ---------------------------------------------------------------------------
// Ensures the port is released cleanly during development restarts.
function shutdown(signal) {
  console.log(`\n[mockSignalK] Received ${signal}, shutting down...`);
  clearInterval(heartbeat);
  wss.close(() => {
    console.log("[mockSignalK] WebSocket server closed. Bye.");
    process.exit(0);
  });
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// 5. Startup banner
// ---------------------------------------------------------------------------
wss.on("listening", () => {
  console.log("--------------------------------------------------------------");
  console.log(` mockSignalK streamer listening on ws://${STREAMER_HOST}:${STREAMER_PORT}`);
  console.log(` Heartbeat cadence: ${HEARTBEAT_INTERVAL_MS} ms`);
  console.log(` Trajectory waypoints: ${TRAJECTORY_WAYPOINTS.length}`);
  console.log("--------------------------------------------------------------");
});

// ---------------------------------------------------------------------------
// 6. Helpers
// ---------------------------------------------------------------------------
// Generate a short opaque identifier so log lines don't leak full socket IDs.
function shortId(socket) {
  // ws doesn't expose a stable id; use the remote port as a quick handle.
  const port = socket._socket?.remotePort ?? "?";
  return `#${port}`;
}