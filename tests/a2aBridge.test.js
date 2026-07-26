/**
 * tests/a2aBridge.test.js
 * ----------------------------------------------------------------------------
 * End-to-end tests for the A2aBridge WebSocket server.
 *
 * Coverage:
 *   1. Construction validation (requires core)
 *   2. Hello handshake on connect
 *   3. Live action broadcast (subscribe → core emits → client receives)
 *   4. Replay-on-connect (client says "since_id=N", bridge replays gap)
 *   5. Ack handling (persisted +56 lastAckedId tracked)
 *   6. Malformed client messages rejected with error envelope
 *   7. Unknown message types rejected
 *   8. Ping/pong round-trip
 *   9. Backpressure closes slow clients
 *  10. Restart resumes monotonic IDs from log
 *  11. Graceful shutdown closes clients
 *  12. Stats endpoint
 *
 * Every test uses port 0 (OS picks a free port) to avoid conflicts with
 * the real daemon. Each test allocates its own A2aLog in a temp dir so
 * state never leaks between tests.
 * ----------------------------------------------------------------------------
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const WebSocket = require("ws");

const { run, test, assert, assertEq, assertThrows } = require("./_harness");
const { A2aBridge } = require("../backend/a2aBridge");
const { A2aLog } = require("../backend/a2aLog");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Fake core: an EventEmitter that exposes `emit('a2a', action)`.
 * Lets us inject A2AActions synchronously without running the full
 * trinityCore pipeline.
 */
function fakeCore() {
  const e = new EventEmitter();
  e.tickCount = 0;
  e.a2aCount = 0;
  return e;
}

/**
 * Allocate a fresh temp dir for log files. Cleans up on test teardown.
 */
function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trinity-a2a-bridge-test-"));
}

/**
 * Wait for a specific message type on a WebSocket. Resolves with the
 * parsed JSON payload, or rejects on timeout.
 */
function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    }
    ws.on("message", handler);
  });
}

/**
 * Collect all messages of a given type until `count` arrives (or timeout).
 */
function collectMessages(ws, type, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      ws.off("message", handler);
      if (collected.length < count) {
        reject(new Error(`only got ${collected.length}/${count} ${type} messages`));
      } else {
        resolve(collected);
      }
    }, timeoutMs);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) { return; }
      if (msg.type === type) {
        collected.push(msg);
        if (collected.length >= count) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(collected);
        }
      }
    }
    ws.on("message", handler);
  });
}

/**
 * Build a fresh bridge + log pair bound to a free port. Returns both
 * along with the fake core and a `cleanup` function.
 */
async function makeBridge(opts = {}) {
  const core = fakeCore();
  const dir = tmpLogDir();
  const log = new A2aLog({ dir });
  const bridge = new A2aBridge({
    core,
    a2aLog: log,
    port: 0,
    verbose: false,
    ...opts,
  });
  await bridge.start();
  // After start, port is bound but we need to look up the actual bound port.
  // ws@8 exposes it via _wss.options.server.address().
  const addr = bridge._wss._server?.address();
  const port = addr ? addr.port : bridge.port;
  return {
    core,
    log,
    bridge,
    port,
    cleanup: async () => {
      await bridge.stop().catch(() => {});
      await log.destroy().catch(() => {});
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

run("a2aBridge", async () => {

  await test("construction requires core", async () => {
    assertThrows(() => new A2aBridge({}), /opts\.core is required/);
  });

  await test("hello handshake sent on connect", async () => {
    const { bridge, port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const hello = await waitForMessage(ws, (m) => m.type === "hello");
      assertEq(hello.server, "trinity-a2a-bridge");
      assertEq(hello.version, 1);
      assertEq(hello.last_action_id, 0);
      assertEq(typeof hello.ts, "string");
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("live action broadcast on core.a2a", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const action = {
        action: "morph_to_hazard_mode",
        payload: { hint: "shallow water" },
        reason: "depth plunge",
        priority: 0.95,
      };

      // Trigger after handshake so we don't miss it.
      const promise = waitForMessage(ws, (m) => m.type === "action");
      core.emit("a2a", action);

      const env = await promise;
      assertEq(env.id, 1);
      assertEq(env.action.action, "morph_to_hazard_mode");
      assertEq(env.action.priority, 0.95);
      assertEq(typeof env.ts, "string");
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("IDs are monotonic across multiple actions", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const promises = [
        waitForMessage(ws, (m) => m.type === "action" && m.id === 1),
        waitForMessage(ws, (m) => m.type === "action" && m.id === 2),
        waitForMessage(ws, (m) => m.type === "action" && m.id === 3),
      ];
      core.emit("a2a", { action: "raise_alert", reason: "x", priority: 0.5 });
      core.emit("a2a", { action: "clear_alerts", reason: "y", priority: 0.5 });
      core.emit("a2a", { action: "announce", reason: "z", priority: 0.5 });
      const envs = await Promise.all(promises);
      assertEq(envs.length, 3);
      assertEq(envs[0].id, 1);
      assertEq(envs[1].id, 2);
      assertEq(envs[2].id, 3);
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("malformed core payload is silently dropped (not broadcast)", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      // Emit a malformed action (not in allow-list). Bridge should reject
      // it without bumping nextId.
      core.emit("a2a", { action: "DROP_TABLES", reason: "naughty" });

      // Give the bridge a moment to (not) send.
      await new Promise((r) => setTimeout(r, 100));

      // Now emit a valid action — it should get id=1, not id=2.
      const promise = waitForMessage(ws, (m) => m.type === "action");
      core.emit("a2a", { action: "raise_alert", reason: "real", priority: 0.5 });
      const env = await promise;
      assertEq(env.id, 1);
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("replay fills the gap", async () => {
    // First session: emit 3 actions
    const core1 = fakeCore();
    const dir = tmpLogDir();
    const log1 = new A2aLog({ dir });
    const bridge1 = new A2aBridge({ core: core1, a2aLog: log1, port: 0 });
    await bridge1.start();
    const port1 = bridge1._wss._server.address().port;
    {
      const ws = new WebSocket(`ws://127.0.0.1:${port1}`);
      await waitForMessage(ws, (m) => m.type === "hello");
      core1.emit("a2a", { action: "raise_alert", reason: "a", priority: 0.5 });
      core1.emit("a2a", { action: "raise_alert", reason: "b", priority: 0.5 });
      core1.emit("a2a", { action: "raise_alert", reason: "c", priority: 0.5 });
      await waitForMessage(ws, (m) => m.type === "action" && m.id === 3);
      ws.close();
    }
    // Flush log so the records are persisted before we restart.
    await log1.flush();
    await bridge1.stop();
    await log1.destroy();

    // Second session: same dir, same log file, fresh bridge.
    const core2 = fakeCore();
    const log2 = new A2aLog({ dir });
    const bridge2 = new A2aBridge({ core: core2, a2aLog: log2, port: 0 });
    await bridge2.start();
    const port2 = bridge2._wss._server.address().port;

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}`);
      const hello = await waitForMessage(ws, (m) => m.type === "hello");
      assertEq(hello.last_action_id, 3, "hello should report last issued id");

      // Request replay of all 3 actions
      const replayed = collectMessages(ws, "action", 3);
      ws.send(JSON.stringify({ type: "replay", since_id: 0 }));

      const envs = await replayed;
      assertEq(envs.length, 3);
      assertEq(envs[0].id, 1);
      assertEq(envs[1].id, 2);
      assertEq(envs[2].id, 3);

      // After replay, next id should be 4 (resumed from maxId)
      assertEq(bridge2._nextId, 4);

      ws.close();
    } finally {
      await bridge2.stop();
      await log2.destroy();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("ack updates lastAckedId and persists to log", async () => {
    const { core, log, port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      core.emit("a2a", { action: "raise_alert", reason: "x", priority: 0.5 });
      const env = await waitForMessage(ws, (m) => m.type === "action");
      assertEq(env.id, 1);

      const ackOk = waitForMessage(ws, (m) => m.type === "ack_ok");
      ws.send(JSON.stringify({ type: "ack", action_id: 1 }));
      const ack = await ackOk;
      assertEq(ack.action_id, 1);

      // Wait for the ack to hit the log.
      await log.flush();
      const replayed = await log.replay({ limit: 10 });
      const ackRec = replayed.find((r) => r.kind === "ack");
      assert(ackRec, "ack record should be persisted to log");
      assertEq(ackRec.action_id, 1);

      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("ping returns pong", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      ws.send(JSON.stringify({ type: "ping" }));
      const pong = await pongPromise;
      assertEq(typeof pong.ts, "string");
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("malformed JSON from client returns error envelope", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const errPromise = waitForMessage(ws, (m) => m.type === "error");
      ws.send("not json at all {");
      const err = await errPromise;
      assertEq(err.code, "malformed_message");
      assert(err.errors && err.errors.length > 0, "errors should be non-empty");
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("unknown type returns error envelope", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const errPromise = waitForMessage(ws, (m) => m.type === "error");
      ws.send(JSON.stringify({ type: "purge_database" }));
      const err = await errPromise;
      assertEq(err.code, "unknown_type");
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("ack with non-integer action_id returns error", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const errPromise = waitForMessage(ws, (m) => m.type === "error");
      ws.send(JSON.stringify({ type: "ack", action_id: "soon" }));
      const err = await errPromise;
      assert(err.errors.some((e) => e.includes("non-negative integer")));
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("replay without a2aLog returns replay_end with reason", async () => {
    // Build a bridge without a log
    const core = fakeCore();
    const bridge = new A2aBridge({ core, port: 0 });
    await bridge.start();
    const port = bridge._wss._server.address().port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const endPromise = waitForMessage(ws, (m) => m.type === "replay_end");
      ws.send(JSON.stringify({ type: "replay", since_id: 0 }));
      const end = await endPromise;
      assertEq(end.replayed, 0);
      assertEq(end.reason, "no_log");
      ws.close();
    } finally {
      await bridge.stop();
    }
  });

  await test("multiple clients receive broadcasts", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws1, (m) => m.type === "hello");
      await waitForMessage(ws2, (m) => m.type === "hello");

      const p1 = waitForMessage(ws1, (m) => m.type === "action");
      const p2 = waitForMessage(ws2, (m) => m.type === "action");
      core.emit("a2a", { action: "raise_alert", reason: "all", priority: 0.5 });

      const [e1, e2] = await Promise.all([p1, p2]);
      assertEq(e1.id, 1);
      assertEq(e2.id, 1);
      ws1.close();
      ws2.close();
    } finally {
      await cleanup();
    }
  });

  await test("clientCount and stats reflect state", async () => {
    const { bridge, port, cleanup } = await makeBridge();
    try {
      assertEq(bridge.clientCount(), 0);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");
      // Give the server a moment to add the client to its set.
      await new Promise((r) => setImmediate(r));
      assertEq(bridge.clientCount(), 1);
      const stats = bridge.stats();
      assertEq(stats.connectedClients, 1);
      assertEq(stats.clientsConnected, 1);
      assert(stats.actionsBroadcast === 0);
      ws.close();
    } finally {
      await cleanup();
    }
  });

  await test("graceful stop closes all clients", async () => {
    const { bridge, port, cleanup } = await makeBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForMessage(ws, (m) => m.type === "hello");
    await new Promise((r) => setImmediate(r));
    assertEq(bridge.clientCount(), 1);

    const closed = new Promise((resolve) => ws.on("close", () => resolve(true)));
    await bridge.stop();
    // Wait for the bridge to actually close the socket.
    const didClose = await Promise.race([
      closed,
      new Promise((r) => setTimeout(() => r(false), 1000)),
    ]);
    assert(didClose, "client socket should have been closed by bridge.stop()");
    assertEq(bridge.clientCount(), 0);
    // No cleanup needed because we already stopped.
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Phase 6: sync-then-broadcast durability tests
  //
  // These tests pin down the contract that a2aLog.append() MUST resolve
  // before the action envelope is sent to clients. If we ever regress to
  // fire-and-forget, these tests will fail.
  // -------------------------------------------------------------------------

  await test("P6: action is persisted to log BEFORE broadcast (ordering invariant)", async () => {
    // We wrap the log to observe when append() resolves vs when the client
    // receives the envelope. The invariant: every action id that the client
    // sees MUST have been flushed to disk first.
    const dir = tmpLogDir();
    const log = new A2aLog({ dir });

    const events = []; // chronological log of internal events
    const origAppend = log.append.bind(log);
    log.append = async (rec) => {
      events.push({ kind: "append:start", id: rec.id });
      const result = await origAppend(rec);
      events.push({ kind: "append:done", id: rec.id });
      return result;
    };

    const core = fakeCore();
    const bridge = new A2aBridge({ core, a2aLog: log, port: 0 });
    await bridge.start();
    const port = bridge._wss._server.address().port;

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      // The client side: every received action id is recorded.
      const clientReceived = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "action") {
          events.push({ kind: "client:received", id: m.id });
          clientReceived.push(m.id);
        }
      });

      // Emit three actions in rapid succession.
      core.emit("a2a", { action: "raise_alert", reason: "a", priority: 0.5 });
      core.emit("a2a", { action: "raise_alert", reason: "b", priority: 0.5 });
      core.emit("a2a", { action: "raise_alert", reason: "c", priority: 0.5 });

      // Wait until all three arrived at the client.
      while (clientReceived.length < 3) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // Invariant: for every id X, "append:done X" must appear before
      // "client:received X" in the events log. Anything else means we
      // broadcast before persisting — the durability gap.
      for (const id of clientReceived) {
        const appendDone = events.findIndex((e) => e.kind === "append:done" && e.id === id);
        const clientRx    = events.findIndex((e) => e.kind === "client:received" && e.id === id);
        assert(appendDone >= 0, `append:done for id=${id} missing from event log`);
        assert(clientRx    >= 0, `client:received for id=${id} missing from event log`);
        assert(
          appendDone < clientRx,
          `action id=${id} was broadcast BEFORE its log write resolved (appendDone=${appendDone}, clientRx=${clientRx})`
        );
      }

      // And: every id the client saw is actually on disk.
      await log.flush();
      const persisted = await log.replay({ limit: 100 });
      const persistedIds = new Set(
        persisted.filter((r) => r.kind === "action").map((r) => r.id)
      );
      for (const id of clientReceived) {
        assert(persistedIds.has(id), `action id=${id} was broadcast but NOT persisted`);
      }

      ws.close();
    } finally {
      await bridge.stop();
      await log.destroy();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("P6: dropped action (append failure) is NOT broadcast", async () => {
    const dir = tmpLogDir();
    const log = new A2aLog({ dir });

    // Sabotage append() so it always rejects.
    const origAppend = log.append.bind(log);
    log.append = async () => { throw new Error("disk full (test)"); };

    const core = fakeCore();
    const bridge = new A2aBridge({ core, a2aLog: log, port: 0, verbose: false });
    await bridge.start();
    const port = bridge._wss._server.address().port;

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForMessage(ws, (m) => m.type === "hello");

      const clientReceived = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "action") clientReceived.push(m.id);
      });

      // Emit an action — persistence will fail, broadcast must NOT happen.
      core.emit("a2a", { action: "raise_alert", reason: "x", priority: 0.5 });

      // Wait long enough for the bridge to have processed it (or not).
      await new Promise((r) => setTimeout(r, 200));

      assertEq(clientReceived.length, 0, "client should not receive an action that failed to persist");
      assertEq(bridge._stats.actionsDropped, 1, "actionsDropped should increment on append failure");
      assertEq(bridge._stats.actionsBroadcast, 0, "actionsBroadcast must not increment when persistence failed");

      // The id that was burnt by the failed append should be reclaimed so
      // the next successful action gets the same number (id=1, not id=2).
      // Sanity-check by emitting a successful action next.
      log.append = origAppend; // restore
      core.emit("a2a", { action: "raise_alert", reason: "y", priority: 0.5 });
      const env = await waitForMessage(ws, (m) => m.type === "action");
      assertEq(env.id, 1, "next successful action should reuse the reclaimed id=1");

      ws.close();
    } finally {
      await bridge.stop();
      await log.destroy();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("P6: stats.actionsDropped is exposed and starts at 0", async () => {
    const { bridge, cleanup } = await makeBridge();
    try {
      const s = bridge.stats();
      assertEq(s.actionsDropped, 0);
      assert("actionsDropped" in s, "stats() must include actionsDropped");
    } finally {
      await cleanup();
    }
  });

});
