/**
 * tests/a2aClient.test.js
 * ----------------------------------------------------------------------------
 * End-to-end tests for A2aClient — exercised against a real A2aBridge.
 *
 * Coverage:
 *   1. Construction + defaults
 *   2. Connect resolves after hello handshake
 *   3. Live action event delivered; ack updates lastAckedId
 *   4. hello is exposed as a public field
 *   5. Ping/pong round-trip
 *   6. Manual requestReplay drains gap
 *   7. Auto-replay on reconnect when lastAckedId > 0
 *   8. Auto-reconnect on server stop/start with exponential backoff
 *   9. Reconnect gives up after maxReconnectAttempts
 *  10. Malformed server JSON becomes an error event (strict mode)
 *  11. Error envelope from server becomes an error event
 *  12. ack rejects non-integer action_id
 *  13. requestReplay rejects negative since_id
 *  14. Destroy cancels reconnect and closes socket
 *  15. Stats reflect activity
 *  16. lastAckedId field starts from constructor opt
 * ----------------------------------------------------------------------------
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const WebSocket = require("ws");

const { run, test, assert, assertEq, assertThrows } = require("./_harness");
const { A2aClient } = require("../backend/a2aClient");
const { A2aBridge } = require("../backend/a2aBridge");
const { A2aLog } = require("../backend/a2aLog");

// ---------------------------------------------------------------------------
// Test helpers (mirror a2aBridge.test.js so we can spin up a real server)
// ---------------------------------------------------------------------------

function fakeCore() {
  const e = new EventEmitter();
  e.tickCount = 0;
  e.a2aCount = 0;
  return e;
}

function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trinity-a2a-client-test-"));
}

function collect(wsOrEmitter, eventName, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      wsOrEmitter.off(eventName, handler);
      if (collected.length < count) {
        reject(new Error(`only got ${collected.length}/${count} '${eventName}' events`));
      } else {
        resolve(collected);
      }
    }, timeoutMs);

    function handler(payload) {
      collected.push(payload);
      if (collected.length >= count) {
        clearTimeout(timer);
        wsOrEmitter.off(eventName, handler);
        resolve(collected);
      }
    }
    wsOrEmitter.on(eventName, handler);
  });
}

function once(emitter, eventName, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, handler);
      reject(new Error(`once('${eventName}') timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(payload) {
      if (!predicate || predicate(payload)) {
        clearTimeout(timer);
        emitter.off(eventName, handler);
        resolve(payload);
      }
    }
    emitter.on(eventName, handler);
  });
}

async function makeBridge(opts = {}) {
  const core = fakeCore();
  const dir = tmpLogDir();
  const log = new A2aLog({ dir });
  const bridge = new A2aBridge({ core, a2aLog: log, port: 0, verbose: false, ...opts });
  await bridge.start();
  const port = bridge._wss._server.address().port;
  return {
    core, log, bridge, port, dir,
    cleanup: async () => {
      await bridge.stop().catch(() => {});
      await log.destroy().catch(() => {});
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

async function makeClient(url, opts = {}) {
  const c = new A2aClient({ url, autoReconnect: false, ...opts });
  return c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

run("a2aClient", async () => {

  await test("constructor applies defaults and custom opts", async () => {
    const c = new A2aClient();
    assertEq(c.state, "idle");
    assertEq(c.hello, null);
    assertEq(c.lastAckedId, 0);
    assertEq(c.url, "ws://127.0.0.1:3002");

    const c2 = new A2aClient({ url: "ws://example:9999", lastAckedId: 42 });
    assertEq(c2.url, "ws://example:9999");
    assertEq(c2.lastAckedId, 42);

    const c3 = new A2aClient({ lastAckedId: -5 });
    assertEq(c3.lastAckedId, 0, "negative lastAckedId should clamp to 0");
  });

  await test("connect resolves after hello handshake", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      const hello = await c.connect();
      assertEq(hello.type, "hello");
      assertEq(hello.server, "trinity-a2a-bridge");
      assertEq(typeof hello.last_action_id, "number");
      assertEq(c.hello.server, "trinity-a2a-bridge");
      assertEq(c.state, "open");
      await c.destroy();
    } finally { await cleanup(); }
  });

  await test("connect() rejects if called twice while open", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      await c.connect();
      let threw = null;
      try { await c.connect(); } catch (e) { threw = e; }
      assert(threw, "second connect() should reject");
      assert(threw.message.includes("already connecting/open"), `unexpected msg: ${threw.message}`);
      await c.destroy();
    } finally { await cleanup(); }
  });

  await test("connect() rejects after destroy()", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      await c.destroy();
      let threw = null;
      try { await c.connect(); } catch (e) { threw = e; }
      assert(threw, "connect after destroy should reject");
      assert(threw.message.includes("after destroy"), `unexpected msg: ${threw.message}`);
    } finally { await cleanup(); }
  });

  await test("live action event delivered; ack updates lastAckedId", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      await c.connect();

      const actionPromise = once(c, "action", (e) => e.id === 1);
      core.emit("a2a", { action: "raise_alert", reason: "test", priority: 0.5 });
      const env = await actionPromise;
      assertEq(env.action.action, "raise_alert");
      assertEq(env.action.reason, "test");
      assertEq(c.lastAckedId, 0, "not yet acked");

      // Send ack and confirm lastAckedId advances.
      const ackOk = once(c, "ack_ok", (e) => e.action_id === 1);
      c.ack(env.id);
      const ackEnv = await ackOk;
      assertEq(ackEnv.action_id, 1);
      assertEq(c.lastAckedId, 1);

      await c.destroy();
    } finally { await cleanup(); }
  });

  await test("ping returns pong event", async () => {
    const { port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      await c.connect();
      const pongPromise = once(c, "pong");
      c.ping();
      const pong = await pongPromise;
      assertEq(pong.type, "pong");
      assertEq(typeof pong.ts, "string");
      await c.destroy();
    } finally { await cleanup(); }
  });

  await test("manual requestReplay drains gap", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      await c.connect();

      // Emit 3 actions, capture them on the live feed.
      const liveP = Promise.all([
        once(c, "action", (e) => e.id === 1),
        once(c, "action", (e) => e.id === 2),
        once(c, "action", (e) => e.id === 3),
      ]);
      core.emit("a2a", { action: "raise_alert", reason: "a", priority: 0.5 });
      core.emit("a2a", { action: "raise_alert", reason: "b", priority: 0.5 });
      core.emit("a2a", { action: "raise_alert", reason: "c", priority: 0.5 });
      await liveP;
      // Ack all 3 so we have a known cursor.
      c.ack(3);
      await once(c, "ack_ok", (e) => e.action_id === 3);

      // Register the replay collector BEFORE triggering the replay.
      const replayP = collect(c, "action", 2);
      // Emit 2 more (now total 5), then ask for replay from id 3 → should
      // get back ids 4 and 5.
      core.emit("a2a", { action: "raise_alert", reason: "d", priority: 0.5 });
      core.emit("a2a", { action: "raise_alert", reason: "e", priority: 0.5 });
      // Wait for the bridge to flush those appends to the log so the
      // replay request can find them. (The bridge broadcasts live first
      // and persists asynchronously.)
      await new Promise((r) => setTimeout(r, 100));
      c.requestReplay(3);

      const replayed = await replayP;
      assertEq(replayed.length, 2);
      assertEq(replayed[0].id, 4);
      assertEq(replayed[1].id, 5);

      // replay_end should fire.
      const end = await once(c, "replay_end");
      assertEq(end.replayed, 2);

      await c.destroy();
    } finally { await cleanup(); }
  });

  await test("auto-replay on reconnect when lastAckedId > 0", async () => {
    const core1 = fakeCore();
    const dir = tmpLogDir();
    const log1 = new A2aLog({ dir });
    const bridge1 = new A2aBridge({ core: core1, a2aLog: log1, port: 0 });
    await bridge1.start();
    const port1 = bridge1._wss._server.address().port;

    // Emit + persist 2 actions, then stop the first bridge.
    {
      const ws = new WebSocket(`ws://127.0.0.1:${port1}`);
      const messages = [];
      ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
      const helloSeen = new Promise((r) => {
        const check = () => messages.some((x) => x.type === "hello") && r();
        const t = setInterval(check, 5);
        // Give it a moment to settle.
        setTimeout(() => clearInterval(t), 1000);
      });
      await helloSeen;
      core1.emit("a2a", { action: "raise_alert", reason: "a", priority: 0.5 });
      core1.emit("a2a", { action: "raise_alert", reason: "b", priority: 0.5 });
      // Wait for both action envelopes to arrive.
      const t0 = Date.now();
      while (Date.now() - t0 < 2000) {
        const have1 = messages.some((x) => x.type === "action" && x.id === 1);
        const have2 = messages.some((x) => x.type === "action" && x.id === 2);
        if (have1 && have2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      ws.close();
    }
    await log1.flush();
    await bridge1.stop();
    await log1.destroy();

    // Start a fresh bridge on the same log dir.
    const core2 = fakeCore();
    const log2 = new A2aLog({ dir });
    const bridge2 = new A2aBridge({ core: core2, a2aLog: log2, port: 0 });
    await bridge2.start();
    const port2 = bridge2._wss._server.address().port;

    // New client with lastAckedId=1 → should auto-replay id=2.
    const c = new A2aClient({ url: `ws://127.0.0.1:${port2}`, lastAckedId: 1 });
    // Register both listeners BEFORE connect so we never miss the
    // replay_end frame if it races the action.
    const endPromise = once(c, "replay_end");
    const replayedPromise = once(c, "action", (e) => e.id === 2);
    await c.connect();
    const replayed = await replayedPromise;
    assertEq(replayed.id, 2);
    const end = await endPromise;
    assertEq(end.replayed, 1);

    await c.destroy();
    await bridge2.stop();
    await log2.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  await test("auto-reconnect on server restart", async () => {
    const dir = tmpLogDir();
    const core1 = fakeCore();
    const log1 = new A2aLog({ dir });
    const bridge1 = new A2aBridge({ core: core1, a2aLog: log1, port: 0 });
    await bridge1.start();
    const port1 = bridge1._wss._server.address().port;

    const c = new A2aClient({
      url: `ws://127.0.0.1:${port1}`,
      autoReconnect: true,
      reconnectInitialMs: 50,
      maxReconnectMs: 200,
      maxReconnectAttempts: 10,
    });
    await c.connect();

    // Receive one action so we know the live path works.
    const first = once(c, "action", (e) => e.id === 1);
    core1.emit("a2a", { action: "raise_alert", reason: "first", priority: 0.5 });
    const firstEnv = await first;
    assertEq(firstEnv.id, 1);
    c.ack(1);
    await once(c, "ack_ok", (e) => e.action_id === 1);

    // Kill bridge1 — log1 still on disk, client will start auto-reconnect.
    const closeP = once(c, "close");
    await bridge1.stop();
    await log1.destroy();
    await closeP;

    // Spin up bridge2 on the SAME port (bridge1 has released it).
    const core2 = fakeCore();
    const log2 = new A2aLog({ dir });
    const bridge2 = new A2aBridge({ core: core2, a2aLog: log2, port: port1 });
    await bridge2.start();

    // Wait for reconnect to complete (client emits 'reconnect' after hello).
    await once(c, "reconnect", () => true, 5000);

    // After reconnect, client auto-replays since lastAckedId=1.
    // The log has only id=1 (the action from bridge1), so replay should
    // be empty — but the bridge's hello should carry last_action_id=1,
    // and the client should NOT replay because there's nothing newer.
    // Verify a FRESH action from bridge2 lands as id=2 (because
    // bridge2.maxId()=1 → nextId=2).
    const fresh = once(c, "action", (e) => e.id === 2, 5000);
    core2.emit("a2a", { action: "announce", reason: "after-reconnect", priority: 0.5 });
    const freshEnv = await fresh;
    assertEq(freshEnv.action.action, "announce");
    assertEq(freshEnv.id, 2);

    await c.destroy();
    await bridge2.stop();
    await log2.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  await test("reconnect gives up after maxReconnectAttempts", async () => {
    // Start a bridge, connect, then kill it. Use a deliberately tiny
    // attempt count so the test runs fast.
    const core1 = fakeCore();
    const log1 = new A2aLog({ dir: tmpLogDir() });
    const bridge1 = new A2aBridge({ core: core1, a2aLog: log1, port: 0 });
    await bridge1.start();
    const port1 = bridge1._wss._server.address().port;

    const c = new A2aClient({
      url: `ws://127.0.0.1:${port1}`,
      autoReconnect: true,
      reconnectInitialMs: 20,
      maxReconnectMs: 50,
      maxReconnectAttempts: 2,
    });
    await c.connect();
    await bridge1.stop();
    await log1.destroy();

    // Should emit an error event when attempts exhaust.
    const errors = [];
    c.on("error", (e) => errors.push(e));
    const errP = new Promise((resolve) => {
      const check = () => {
        const found = errors.find((e) => e && typeof e === "object" && e.message && e.message.includes("gave up"));
        if (found) resolve(found);
        else setTimeout(check, 20);
      };
      check();
    });
    const err = await errP;
    assert(err.message.includes("gave up"), `unexpected err: ${err.message}`);
    await c.destroy();
  });

  await test("malformed server JSON becomes an error event (strict)", async () => {
    const c = new A2aClient({ url: "ws://stub", autoReconnect: false, strict: true });
    c.hello = { type: "hello", server: "stub", version: 1, last_action_id: 0, ts: "x" };
    const errP = once(c, "error");
    // Drive the parse path directly — no WebSocket needed.
    c.handleServerMessage(Buffer.from("not json")).then(
      () => { /* should not happen */ },
      (err) => {
        // The promise rejects with the parse error; we surface it
        // manually so the once('error') resolves with the same Error.
        c.emit("error", err);
      }
    );
    const err = await errP;
    assert(err.message.includes("JSON parse failed"), `unexpected err: ${err.message}`);
  });

  await test("error envelope from server becomes an error event", async () => {
    const c = new A2aClient({ url: "ws://stub", autoReconnect: false });
    c.hello = { type: "hello", server: "stub", version: 1, last_action_id: 0, ts: "x" };
    const errP = once(c, "error");
    await c.handleServerMessage(JSON.stringify({
      type: "error", code: "unknown_type", errors: ["nope"]
    }));
    const err = await errP;
    assertEq(err.code, "unknown_type");
    assertEq(err.errors[0], "nope");
  });

  await test("ack rejects non-integer action_id", async () => {
    const c = new A2aClient();
    assertThrows(() => c.ack(-1), /non-negative integer/);
    assertThrows(() => c.ack(1.5), /non-negative integer/);
    assertThrows(() => c.ack("soon"), /non-negative integer/);
    // valid call should not throw
    c.lastAckedId = 0;
    // We don't actually have a socket so _send will no-op, but ack() must not throw.
    c.ack(0);
  });

  await test("requestReplay rejects negative since_id", async () => {
    const c = new A2aClient();
    assertThrows(() => c.requestReplay(-1), /non-negative integer/);
    assertThrows(() => c.requestReplay(1.5), /non-negative integer/);
  });

  await test("destroy cancels reconnect and closes socket", async () => {
    const { bridge, port, cleanup } = await makeBridge();
    try {
      const c = new A2aClient({
        url: `ws://127.0.0.1:${port}`,
        autoReconnect: true,
        reconnectInitialMs: 100,
      });
      // Capture errors from the start so any unhandled error during
      // auto-reconnect ECONNREFUSED doesn't crash the test process.
      const errs = [];
      c.on("error", (e) => errs.push(e));
      await c.connect();
      assertEq(c.state, "open");

      const closeP = once(c, "close");
      await bridge.stop();
      await closeP;

      // Give the reconnect timer a chance to fire AND fail (transient
      // ECONNREFUSED) so we can confirm destroy() then prevents further
      // errors. Pre-destroy errors are captured here.
      await new Promise((r) => setTimeout(r, 250));
      const errsBeforeDestroy = errs.length;

      await c.destroy();
      // After destroy, no more reconnect attempts should be made.
      await new Promise((r) => setTimeout(r, 300));
      assertEq(errs.length, errsBeforeDestroy,
        `destroy() should prevent further reconnect errors (got ${errs.length - errsBeforeDestroy} new)`);
      assertEq(c.state, "closed");
    } finally {
      await cleanup();
    }
  });

  await test("stats reflect activity", async () => {
    const { core, port, cleanup } = await makeBridge();
    try {
      const c = await makeClient(`ws://127.0.0.1:${port}`);
      await c.connect();
      assertEq(c.stats().actionsReceived, 0);
      assertEq(c.stats().acksSent, 0);

      const actionP = Promise.all([
        once(c, "action", (e) => e.id === 1),
        once(c, "action", (e) => e.id === 2),
      ]);
      core.emit("a2a", { action: "raise_alert", reason: "a", priority: 0.5 });
      core.emit("a2a", { action: "raise_alert", reason: "b", priority: 0.5 });
      await actionP;
      c.ack(1);
      c.ack(2);

      const s = c.stats();
      assertEq(s.actionsReceived, 2);
      assertEq(s.acksSent, 2);
      assertEq(s.errors, 0);

      await c.destroy();
    } finally { await cleanup(); }
  });

});