/**
 * tests/trinityCoreWatchers.test.js
 * ----------------------------------------------------------------------------
 * Integration tests for the watcher -> trinityCore -> a2a path.
 *
 * What this proves:
 *   1. A WatcherRegistry attached to TrinityCore fires A2A actions through
 *      the same 'a2a' event the narrator uses.
 *   2. Watcher-fired actions carry source: "watcher" so downstream consumers
 *      can distinguish them from LLM-issued actions.
 *   3. Watcher-fired actions are exposed via core.stats.watcherFiredCount.
 *   4. Watcher errors do not crash the core; they bump watcherErrorCount.
 *   5. TrinityCore works fine WITHOUT a registry (backward compatible).
 *   6. The watcher 'fired' event carries a useful info object.
 *
 * This is the integration seam between backend/watchers.js and
 * backend/trinityCore.js. The pure-registry behavior is covered by
 * tests/watchers.test.js; this file is specifically about the wiring.
 * ----------------------------------------------------------------------------
 */

"use strict";

const { EventEmitter } = require("events");

const { run, test, assert, assertEq, assertThrows, section, sleep } = require("./_harness");
const { TrinityCore } = require("../backend/trinityCore");
const { WatcherRegistry } = require("../backend/watchers");

/**
 * Minimal ringBuffer stand-in: we don't need a real one for this test
 * because TrinityCore only calls .latest(). It just needs to return a frame.
 */
function ringBufferWith(frame) {
  return {
    _frame: frame,
    _listeners: [],
    get featureDim() { return 6; },
    latest() { return this._frame; },
    on(ev, fn) { this._listeners.push({ ev, fn }); return this; },
    write(f) {
      this._frame = f;
      for (const { ev, fn } of this._listeners) {
        if (ev === "frame") fn(f);
      }
    },
  };
}

/**
 * Minimal jepa stand-in: never flags anomalies.
 */
function quietJepa() {
  const e = new EventEmitter();
  let count = 0;
  e.observe = () => {
    count += 1;
    return { score: 0.1, anomaly: false, reason: "quiet" };
  };
  e.tickCount = () => count;
  e.anomalyThreshold = 0.5;
  return e;
}

/**
 * Minimal narrator stand-in: never generates, just forwards events.
 */
function quietNarrator() {
  const e = new EventEmitter();
  e.stats = { a2aActionsEmitted: 0, proseChunksEmitted: 0 };
  e.maybeGenerate = () => {};
  e.forceEmergency = () => {};
  e.abort = () => {};
  e.destroy = () => {};
  return e;
}

run("trinityCore watchers integration", async () => {

  // -----------------------------------------------------------------------
  section("watcher wiring basics");
  // -----------------------------------------------------------------------

  test("core fires A2A event when a watcher matches", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "shallow",
      name: "shallow water",
      when: (f) => f.depth < 2.0,
      action: { name: "raise_alert", priority: () => 0.9 },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const a2aEvents = [];
    core.on("a2a", (a) => a2aEvents.push(a));

    // Manually drive one tick by emitting on the ring buffer's frame event.
    // (The setInterval loop in core.start() is too slow for unit tests.)
    core._tick();

    assertEq(a2aEvents.length, 1, "one a2a event");
    assertEq(a2aEvents[0].action, "raise_alert", "action name");
    assertEq(a2aEvents[0].source, "watcher", "source stamped");
    assertEq(a2aEvents[0].ruleId, "shallow", "ruleId stamped");
    assertEq(a2aEvents[0].priority, 0.9, "priority preserved");
  });

  test("core does not fire A2A when no watcher matches", () => {
    const ring = ringBufferWith({ depth: 11.4 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "shallow",
      name: "shallow water",
      when: (f) => f.depth < 2.0,
      action: { name: "raise_alert" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const a2aEvents = [];
    core.on("a2a", (a) => a2aEvents.push(a));

    core._tick();
    assertEq(a2aEvents.length, 0, "no events");
  });

  test("multiple watcher matches fire in registration order", () => {
    const ring = ringBufferWith({ depth: 1.2, headingTrue: 5 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "shallow",
      name: "shallow water",
      when: (f) => f.depth < 2.0,
      action: { name: "raise_alert" },
    });
    reg.add({
      id: "heading",
      name: "heading off",
      when: (f) => f.headingTrue < 10,
      action: { name: "highlight_waypoint" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const a2aEvents = [];
    core.on("a2a", (a) => a2aEvents.push(a.action));

    core._tick();
    assertEq(a2aEvents.length, 2, "two events");
    assertEq(a2aEvents[0], "raise_alert", "first in order");
    assertEq(a2aEvents[1], "highlight_waypoint", "second in order");
  });

  // -----------------------------------------------------------------------
  section("stats");
  // -----------------------------------------------------------------------

  test("stats.watcherFiredCount increments", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "shallow",
      name: "shallow water",
      when: (f) => f.depth < 2.0,
      action: { name: "raise_alert" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    core._tick();
    core._tick();
    core._tick();
    assertEq(core.stats.watcherFiredCount, 3, "fired 3 times");
  });

  test("stats.watcherErrorCount increments on rule error", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "broken",
      name: "broken rule",
      when: () => { throw new Error("boom"); },
      action: { name: "raise_alert" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    core._tick();
    assertEq(core.stats.watcherErrorCount, 1, "one error counted");
    assertEq(core.stats.watcherFiredCount, 0, "no fires");
  });

  test("stats fields present even when no registry attached", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr });
    assertEq(core.stats.watcherFiredCount, 0, "0 fired");
    assertEq(core.stats.watcherErrorCount, 0, "0 errors");
  });

  // -----------------------------------------------------------------------
  section("error isolation");
  // -----------------------------------------------------------------------

  test("watcher errors are emitted as 'watcher-error' with rule context", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "broken",
      name: "broken rule",
      when: () => { throw new Error("kaboom"); },
      action: { name: "raise_alert" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const errs = [];
    core.on("watcher-error", (e, info) => errs.push({ msg: e.message, info }));
    core._tick();
    assertEq(errs.length, 1, "one error event");
    assertEq(errs[0].msg, "kaboom", "message");
    assertEq(errs[0].info.ruleId, "broken", "ruleId");
    assertEq(errs[0].info.stage, "when", "stage=when");
  });

  test("a bad rule does not stop a good rule from firing", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "bad",
      name: "bad rule",
      when: () => { throw new Error("nope"); },
      action: { name: "raise_alert" },
    });
    reg.add({
      id: "good",
      name: "good rule",
      when: (f) => f.depth < 2.0,
      action: { name: "announce" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const a2a = [];
    core.on("a2a", (a) => a2a.push(a));
    core._tick();
    assertEq(a2a.length, 1, "good rule still fired");
    assertEq(a2a[0].ruleId, "good", "from good rule");
  });

  // -----------------------------------------------------------------------
  section("event forwarding");
  // -----------------------------------------------------------------------

  test("'watcher-fired' event is emitted alongside 'a2a'", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "shallow",
      name: "shallow water",
      when: (f) => f.depth < 2.0,
      action: { name: "raise_alert" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const fired = [];
    core.on("watcher-fired", (a, info) => fired.push({ action: a.action, ruleId: info.ruleId }));

    core._tick();
    assertEq(fired.length, 1, "one watcher-fired event");
    assertEq(fired[0].action, "raise_alert", "action");
    assertEq(fired[0].ruleId, "shallow", "ruleId");
  });

  // -----------------------------------------------------------------------
  section("backward compatibility");
  // -----------------------------------------------------------------------

  test("TrinityCore works without watchers (existing tests stay green)", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr });
    assertEq(core.watchers, null, "no watchers attached");
    // Tick should not throw.
    core._tick();
    assertEq(core.stats.watcherFiredCount, 0, "still 0");
  });

  test("LLM-issued a2a and watcher-issued a2a are distinguishable by source", () => {
    const ring = ringBufferWith({ depth: 1.2 });
    const jepa = quietJepa();
    const narr = quietNarrator();
    const reg = new WatcherRegistry();
    reg.add({
      id: "shallow",
      name: "shallow water",
      when: (f) => f.depth < 2.0,
      action: { name: "raise_alert" },
    });
    const core = new TrinityCore({ ringBuffer: ring, jepa, narrator: narr, watchers: reg });

    const a2a = [];
    core.on("a2a", (a) => a2a.push(a));

    // 1. Watcher fires.
    core._tick();
    // 2. Narrator fires.
    core.emit("a2a", Object.freeze({ action: "morph_to_hazard_mode", priority: 0.99, source: "narrator" }));

    assertEq(a2a.length, 2, "two events");
    assertEq(a2a[0].source, "watcher", "first is watcher");
    assertEq(a2a[1].source, "narrator", "second is narrator");
  });
});
