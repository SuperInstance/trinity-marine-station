/**
 * tests/watcherHistory.test.js
 * ----------------------------------------------------------------------------
 * Unit tests for backend/watcherHistory.js — the per-rule suppression
 * accumulator that WatcherRegistry consults to decide whether a rule
 * should fire RIGHT NOW or be debounced.
 *
 * Coverage:
 *   1. Construction & defaults
 *   2. shouldFire — first time passes (no-prior-fire)
 *   3. shouldFire — within cooldown suppresses (cooldown-active)
 *   4. shouldFire — after cooldown passes (cooldown-elapsed)
 *   5. shouldFire — payload dedup (default on)
 *   6. shouldFire — payload dedup (off via opts)
 *   7. record — updates state, fires 'recorded' event
 *   8. record — lastPayloadKey tracks dedup payload
 *   9. markSuppressed — increments counter, fires 'suppressed' event
 *  10. getStats — aggregate + per-rule
 *  11. reset(rid) — clears one rule
 *  12. clear() — clears all + zeros aggregates
 *  13. shouldFire — argument validation
 *  14. payloadKey — sorted-key determinism
 * ----------------------------------------------------------------------------
 */

"use strict";

const { run, test, assert, assertEq, assertThrows, section } = require("./_harness");
const {
  WatcherHistory,
  DEFAULT_COOLDOWN_MS,
  payloadKey,
} = require("../backend/watcherHistory");

run("watcherHistory", async () => {

  // -----------------------------------------------------------------------
  section("construction & defaults");
  // -----------------------------------------------------------------------

  test("constructs with no options", () => {
    const h = new WatcherHistory();
    assertEq(h.verbose, false, "verbose=false");
    assertEq(h.dedupPayloads, true, "dedupPayloads=true (default)");
    const stats = h.getStats();
    assertEq(stats.tracksActive, 0, "no tracks");
    assertEq(stats.totalFires, 0, "no fires");
    assertEq(stats.totalSuppressed, 0, "no suppressions");
    assertEq(stats.rules.length, 0, "no rules");
  });

  test("default cooldown constant is 0", () => {
    assertEq(DEFAULT_COOLDOWN_MS, 0, "0 = no cooldown");
  });

  test("dedupPayloads can be disabled", () => {
    const h = new WatcherHistory({ dedupPayloads: false });
    assertEq(h.dedupPayloads, false, "off");
  });

  // -----------------------------------------------------------------------
  section("shouldFire — basic state machine");
  // -----------------------------------------------------------------------

  test("first time shouldFire for a rule returns ok=true (no-prior-fire)", () => {
    const h = new WatcherHistory();
    const d = h.shouldFire("r1", 1000, 0, undefined);
    assertEq(d.ok, true, "ok=true");
    assertEq(d.reason, "no-prior-fire", "reason=no-prior-fire");
  });

  test("within cooldown suppresses (cooldown-active)", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    const d = h.shouldFire("r1", 5000, 10_000, undefined);
    assertEq(d.ok, false, "suppressed");
    assertEq(d.reason, "cooldown-active", "reason=cooldown-active");
  });

  test("after cooldown allows firing again (cooldown-elapsed)", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    const d = h.shouldFire("r1", 12_000, 10_000, undefined);
    assertEq(d.ok, true, "fired");
    assertEq(d.reason, "cooldown-elapsed", "reason=cooldown-elapsed");
  });

  test("cooldown=0 allows immediate re-fire (no-prior-fire)", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    const d = h.shouldFire("r1", 1500, 0, undefined);
    assertEq(d.ok, true, "fired");
    assertEq(d.reason, "no-prior-fire", "no cooldown means no debounce");
  });

  test("per-rule independence: cooldown on r1 does not affect r2", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    const d1 = h.shouldFire("r1", 1500, 60_000, undefined);
    const d2 = h.shouldFire("r2", 1500, 60_000, undefined);
    assertEq(d1.ok, false, "r1 suppressed");
    assertEq(d2.ok, true, "r2 fresh");
  });

  // -----------------------------------------------------------------------
  section("shouldFire — payload dedup");
  // -----------------------------------------------------------------------

  test("identical payload within cooldown is suppressed (payload-dedup)", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, { kind: "shallow_water", depth: 1.2 }, 0.85);
    // 999 seconds later (way past 0-cooldown default), but payload is identical.
    const d = h.shouldFire("r1", 1_000_000, 0, { kind: "shallow_water", depth: 1.2 });
    assertEq(d.ok, false, "suppressed");
    assertEq(d.reason, "payload-dedup", "reason=payload-dedup");
  });

  test("different payload after cooldown allows firing", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, { kind: "shallow_water", depth: 1.2 }, 0.85);
    const d = h.shouldFire("r1", 12_000, 10_000, { kind: "shallow_water", depth: 1.1 });
    assertEq(d.ok, true, "different depth -> fires");
  });

  test("payload dedup can be disabled per-instance", () => {
    const h = new WatcherHistory({ dedupPayloads: false });
    h.record("r1", 1000, { depth: 1.2 }, 0.5);
    const d = h.shouldFire("r1", 1_000_000, 0, { depth: 1.2 });
    assertEq(d.ok, true, "dedup off -> fires");
  });

  // -----------------------------------------------------------------------
  section("record — state mutation");
  // -----------------------------------------------------------------------

  test("record updates lastFiredAt, lastPriority, fireCount", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.7);
    h.record("r1", 2000, undefined, 0.9);
    const st = h.get("r1");
    assertEq(st.lastFiredAt, 2000, "lastFiredAt updated");
    assertEq(st.lastPriority, 0.9, "lastPriority updated");
    assertEq(st.fireCount, 2, "fireCount incremented");
  });

  test("record emits 'recorded' event with ruleId and now", () => {
    const h = new WatcherHistory();
    const seen = [];
    h.on("recorded", (ruleId, at) => seen.push({ ruleId, at }));
    h.record("r1", 1234, undefined, 0.5);
    assertEq(seen.length, 1, "one event");
    assertEq(seen[0].ruleId, "r1", "ruleId matches");
    assertEq(seen[0].at, 1234, "now matches");
  });

  test("record with no payload keeps lastPayloadKey=''", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    assertEq(h.get("r1").lastPayloadKey, "", "no payload -> empty key");
  });

  test("record with payload stores canonical payloadKey", () => {
    const h = new WatcherHistory();
    // Key order shouldn't matter for canonical form.
    h.record("r1", 1000, { a: 1, b: 2 }, 0.5);
    const st = h.get("r1");
    assertEq(st.lastPayloadKey, payloadKey({ a: 1, b: 2 }), "stored key");
  });

  // -----------------------------------------------------------------------
  section("markSuppressed — counter updates");
  // -----------------------------------------------------------------------

  test("markSuppressed increments per-rule + total counters", () => {
    const h = new WatcherHistory();
    h.markSuppressed("r1", "cooldown-active");
    h.markSuppressed("r1", "cooldown-active");
    h.markSuppressed("r2", "payload-dedup");
    const stats = h.getStats();
    assertEq(stats.totalSuppressed, 3, "total=3");
    const r1 = stats.rules.find((r) => r.ruleId === "r1");
    const r2 = stats.rules.find((r) => r.ruleId === "r2");
    assertEq(r1.suppressCount, 2, "r1=2");
    assertEq(r2.suppressCount, 1, "r2=1");
  });

  test("markSuppressed emits 'suppressed' event", () => {
    const h = new WatcherHistory();
    const seen = [];
    h.on("suppressed", (ruleId, reason) => seen.push({ ruleId, reason }));
    h.markSuppressed("r1", "cooldown-active");
    assertEq(seen.length, 1, "one event");
    assertEq(seen[0].ruleId, "r1", "ruleId");
    assertEq(seen[0].reason, "cooldown-active", "reason");
  });

  // -----------------------------------------------------------------------
  section("getStats / get / reset / clear");
  // -----------------------------------------------------------------------

  test("getStats includes track counts and per-rule rows", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    h.record("r2", 1100, undefined, 0.6);
    h.markSuppressed("r1", "cooldown-active");
    const stats = h.getStats();
    assertEq(stats.tracksActive, 2, "2 active tracks");
    assertEq(stats.totalFires, 2, "2 fires");
    assertEq(stats.totalSuppressed, 1, "1 suppression");
    assertEq(stats.rules.length, 2, "2 rules in list");
  });

  test("get returns undefined for unknown rule", () => {
    const h = new WatcherHistory();
    assertEq(h.get("nope"), undefined, "undefined");
  });

  test("get returns a snapshot (not a live reference)", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    const snap = h.get("r1");
    snap.fireCount = 9999;        // mutate the snapshot
    const fresh = h.get("r1");     // internal state unaffected
    assertEq(fresh.fireCount, 1, "internal state not mutated by snapshot mutation");
  });

  test("reset(rid) clears one rule's state and emits 'reset' event", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    const seen = [];
    h.on("reset", (ruleId) => seen.push(ruleId));
    h.reset("r1");
    assertEq(h.get("r1"), undefined, "state cleared");
    assertEq(seen[0], "r1", "reset event for r1");
  });

  test("clear() wipes all state and zeros aggregates", () => {
    const h = new WatcherHistory();
    h.record("r1", 1000, undefined, 0.5);
    h.record("r2", 1100, undefined, 0.6);
    h.markSuppressed("r1", "cooldown-active");
    h.clear();
    const stats = h.getStats();
    assertEq(stats.tracksActive, 0, "no tracks");
    assertEq(stats.totalFires, 0, "no fires");
    assertEq(stats.totalSuppressed, 0, "no suppressions");
  });

  // -----------------------------------------------------------------------
  section("argument validation");
  // -----------------------------------------------------------------------

  test("shouldFire rejects empty ruleId", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.shouldFire("", 1000, 0, undefined), "ruleId");
  });

  test("shouldFire rejects non-string ruleId", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.shouldFire(42, 1000, 0, undefined), "ruleId");
  });

  test("shouldFire rejects non-finite now", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.shouldFire("r1", NaN, 0, undefined), "finite");
  });

  test("shouldFire rejects negative cooldown", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.shouldFire("r1", 1000, -1, undefined), "cooldown");
  });

  test("shouldFire rejects non-numeric cooldown", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.shouldFire("r1", 1000, "1000", undefined), "cooldown");
  });

  test("record rejects empty ruleId", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.record("", 1000), "ruleId");
  });

  test("record rejects non-finite now", () => {
    const h = new WatcherHistory();
    assertThrows(() => h.record("r1", Infinity), "finite");
  });

  // -----------------------------------------------------------------------
  section("payloadKey helper");
  // -----------------------------------------------------------------------

  test("payloadKey is order-independent", () => {
    const a = payloadKey({ x: 1, y: 2, z: 3 });
    const b = payloadKey({ z: 3, y: 2, x: 1 });
    assertEq(a, b, "same key for reordered keys");
  });

  test("payloadKey returns '' for null/undefined", () => {
    assertEq(payloadKey(null), "", "null");
    assertEq(payloadKey(undefined), "", "undefined");
  });

  test("payloadKey handles nested values via JSON.stringify round-trip", () => {
    const k1 = payloadKey({ a: [1, 2, 3], b: "hi" });
    const k2 = payloadKey({ b: "hi", a: [1, 2, 3] });
    assertEq(k1, k2, "arrays stringify deterministically");
  });

  test("payloadKey coerces non-object primitives to string", () => {
    assertEq(payloadKey(42), "42", "number");
    assertEq(payloadKey("hello"), "hello", "string");
  });
});
