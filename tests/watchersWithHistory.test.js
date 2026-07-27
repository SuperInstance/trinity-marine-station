/**
 * tests/watchersWithHistory.test.js
 * ----------------------------------------------------------------------------
 * Tests for the integration between WatcherRegistry and WatcherHistory.
 *
 * The history is opt-in: a registry constructed without one behaves exactly
 * as before (no suppression). When a history IS attached, rules with
 * cooldownMs > 0 are suppressed within their window; rules with cooldownMs
 * = 0 are unaffected. Payload dedup (history default: ON) further
 * suppresses identical payloads past the cooldown window.
 *
 * Coverage:
 *   1. No-history behavior is unchanged (backward compat)
 *   2. History attached, cooldownMs=0: rule fires every time
 *   3. History attached, cooldownMs=30000: first call fires, second suppressed
 *   4. After cooldown elapses, rule fires again
 *   5. Stats: getStats reflects fires and suppressions
 *   6. record() called only after a successful fire
 *   7. Mark suppressed when shouldFire returns false
 *   8. Custom clock (now) drives the test
 *   9. Suppressed rules do NOT abort later rules
 *  10. get() round-trips cooldownMs through denormalisation
 *  11. reg.stats getter exposes history stats
 *  12. The 'fired' event fires only for non-suppressed matches
 * ----------------------------------------------------------------------------
 */

"use strict";

const { run, test, assert, assertEq, section } = require("./_harness");
const { WatcherRegistry } = require("../backend/watchers");
const { WatcherHistory } = require("../backend/watcherHistory");

function frame(over = {}) {
  return {
    latitude: 59.34521,
    longitude: 18.07341,
    speedOverGround: 5.4,
    headingTrue: 214.5,
    depth: 11.4,
    trajectoryProgress: 0.42,
    ...over,
  };
}

function shallowWaterRule(over = {}) {
  return {
    id: "shallow-water",
    name: "Shallow water warning",
    when: (f) => f.depth != null && f.depth < 2.0,
    action: {
      name: "raise_alert",
      payload: (f) => ({ kind: "shallow_water", depth: f.depth }),
      reason: (f) => `depth=${f.depth.toFixed(2)}m`,
      priority: () => 0.85,
    },
    ...over,
  };
}

function headingRule(over = {}) {
  return {
    id: "heading-off-course",
    name: "Heading deviates",
    when: (f) => f.headingTrue != null && (f.headingTrue < 10 || f.headingTrue > 350),
    action: {
      name: "highlight_waypoint",
      payload: (f) => ({ heading: f.headingTrue }),
      reason: (f) => `heading=${f.headingTrue.toFixed(1)}°`,
      priority: () => 0.6,
    },
    ...over,
  };
}

run("watchersWithHistory", async () => {

  // -----------------------------------------------------------------------
  section("no-history behavior (backward compat)");
  // -----------------------------------------------------------------------

  test("registry without history: rule fires every evaluate (no suppression)", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule({ cooldownMs: 30_000 })); // cooldown declared but ignored
    const out1 = reg.evaluate(frame({ depth: 1.2 }));
    const out2 = reg.evaluate(frame({ depth: 1.2 }));
    const out3 = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out1.length, 1, "fires 1");
    assertEq(out2.length, 1, "fires 2 (no history, no suppression)");
    assertEq(out3.length, 1, "fires 3");
  });

  test("registry without history: stats.historyStats is null", () => {
    const reg = new WatcherRegistry();
    assertEq(reg.stats.historyStats, null, "null when no history");
    assertEq(reg.stats.ruleCount, 0, "ruleCount=0");
  });

  // -----------------------------------------------------------------------
  section("history attached — cooldown behavior");
  // -----------------------------------------------------------------------

  test("with history, cooldownMs=0: rule fires every evaluate", () => {
    const hist = new WatcherHistory();
    const reg = new WatcherRegistry({ history: hist });
    reg.add(shallowWaterRule({ cooldownMs: 0 }));
    const out1 = reg.evaluate(frame({ depth: 1.2 }));
    const out2 = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out1.length, 1, "1");
    assertEq(out2.length, 1, "2");
    assertEq(hist.get("shallow-water").fireCount, 2, "two records");
  });

  test("with history, cooldownMs=30s: first fires, second suppressed", () => {
    const hist = new WatcherHistory();
    let now = 1000;
    const reg = new WatcherRegistry({ history: hist, now: () => now });
    reg.add(shallowWaterRule({ cooldownMs: 30_000 }));
    const out1 = reg.evaluate(frame({ depth: 1.2 }));
    now += 5_000;     // 5s later
    const out2 = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out1.length, 1, "first fires");
    assertEq(out2.length, 0, "second suppressed");
    assertEq(hist.get("shallow-water").fireCount, 1, "fireCount=1");
    const stats = hist.getStats();
    assertEq(stats.totalSuppressed, 1, "1 suppression");
  });

  test("after cooldown elapses, rule fires again", () => {
    const hist = new WatcherHistory();
    let now = 1000;
    const reg = new WatcherRegistry({ history: hist, now: () => now });
    reg.add(shallowWaterRule({ cooldownMs: 30_000 }));
    reg.evaluate(frame({ depth: 1.2 }));     // fires at t=1000
    now += 5_000;
    reg.evaluate(frame({ depth: 1.2 }));     // suppressed
    now += 26_000;                            // total 31s elapsed
    const out = reg.evaluate(frame({ depth: 1.2 }));  // fires again
    assertEq(out.length, 1, "fires after cooldown");
    assertEq(hist.get("shallow-water").fireCount, 2, "fireCount=2");
  });

  test("cooldown is per-rule: r1 cooldown does not affect r2", () => {
    const hist = new WatcherHistory();
    let now = 1000;
    const reg = new WatcherRegistry({ history: hist, now: () => now });
    reg.add(shallowWaterRule({ cooldownMs: 60_000 }));
    reg.add(headingRule({ cooldownMs: 0 }));
    reg.evaluate(frame({ depth: 1.2, headingTrue: 5 }));     // both fire
    now += 1_000;
    reg.evaluate(frame({ depth: 1.1, headingTrue: 6 }));     // r1 suppressed, r2 fires
    const r1 = hist.get("shallow-water");
    const r2 = hist.get("heading-off-course");
    assertEq(r1.fireCount, 1, "r1 fired once");
    assertEq(r1.suppressCount, 1, "r1 suppressed once");
    assertEq(r2.fireCount, 2, "r2 fired twice");
    assertEq(r2.suppressCount, 0, "r2 never suppressed");
  });

  // -----------------------------------------------------------------------
  section("reg.stats getter exposes history");
  // -----------------------------------------------------------------------

  test("reg.stats returns ruleCount, rules, and historyStats", () => {
    const hist = new WatcherHistory();
    const reg = new WatcherRegistry({ history: hist });
    reg.add(shallowWaterRule({ cooldownMs: 100 }));
    reg.add(headingRule({ cooldownMs: 0 }));
    const stats = reg.stats;
    assertEq(stats.ruleCount, 2, "2 rules");
    assertEq(stats.rules.length, 2, "rules listed");
    assert(stats.historyStats !== null, "historyStats present");
    assertEq(stats.historyStats.tracksActive, 0, "no fires yet");
  });

  test("reg.stats.historyStats updates after fires + suppressions", () => {
    const hist = new WatcherHistory();
    let now = 0;
    const reg = new WatcherRegistry({ history: hist, now: () => (now += 100) });
    reg.add(shallowWaterRule({ cooldownMs: 30_000 }));
    reg.evaluate(frame({ depth: 1.2 }));   // t=100
    reg.evaluate(frame({ depth: 1.2 }));   // t=200, suppressed
    reg.evaluate(frame({ depth: 1.2 }));   // t=300, suppressed
    const stats = reg.stats;
    assertEq(stats.historyStats.totalFires, 1, "1 fire");
    assertEq(stats.historyStats.totalSuppressed, 2, "2 suppressions");
  });

  // -----------------------------------------------------------------------
  section("event semantics with history");
  // -----------------------------------------------------------------------

  test("'fired' event fires only on non-suppressed matches", () => {
    const hist = new WatcherHistory();
    let now = 0;
    const reg = new WatcherRegistry({ history: hist, now: () => (now += 1000) });
    reg.add(shallowWaterRule({ cooldownMs: 30_000 }));
    const firedIds = [];
    reg.on("fired", (_action, info) => firedIds.push(info.ruleId));
    reg.evaluate(frame({ depth: 1.2 }));     // fires
    reg.evaluate(frame({ depth: 1.2 }));     // suppressed
    reg.evaluate(frame({ depth: 1.2 }));     // suppressed
    assertEq(firedIds.length, 1, "fired event fired once");
    assertEq(firedIds[0], "shallow-water", "right ruleId");
  });

  test("'error' event NOT emitted on normal suppression", () => {
    const hist = new WatcherHistory();
    let now = 0;
    const reg = new WatcherRegistry({ history: hist, now: () => (now += 100) });
    reg.add(shallowWaterRule({ cooldownMs: 30_000 }));
    const errs = [];
    reg.on("error", (err, info) => errs.push({ msg: err.message, stage: info.stage }));
    reg.evaluate(frame({ depth: 1.2 }));
    reg.evaluate(frame({ depth: 1.2 }));     // suppressed — should be silent
    assertEq(errs.length, 0, "no errors");
  });

  // -----------------------------------------------------------------------
  section("rule contract: cooldownMs round-trips through get()");
  // -----------------------------------------------------------------------

  test("get() returns the declared cooldownMs (denormalised)", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule({ cooldownMs: 30_000 }));
    const r = reg.get("shallow-water");
    assertEq(r.cooldownMs, 30_000, "cooldownMs preserved");
  });

  test("get() returns cooldownMs=0 by default", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const r = reg.get("shallow-water");
    assertEq(r.cooldownMs, 0, "default 0");
  });

  test("add() rejects negative cooldownMs", () => {
    const reg = new WatcherRegistry();
    let threw = false;
    try {
      reg.add(shallowWaterRule({ cooldownMs: -1 }));
    } catch (err) {
      threw = true;
      assert(err.message.includes("cooldownMs"), "mentions cooldownMs");
    }
    assert(threw, "should have thrown");
  });

  test("add() rejects non-numeric cooldownMs", () => {
    const reg = new WatcherRegistry();
    let threw = false;
    try {
      reg.add(shallowWaterRule({ cooldownMs: "30s" }));
    } catch (err) {
      threw = true;
    }
    assert(threw, "should have thrown");
  });

  // -----------------------------------------------------------------------
  section("history error isolation");
  // -----------------------------------------------------------------------

  test("shouldFire throwing -> 'error' emitted with stage=history-decide, evaluation continues", () => {
    const hist = new WatcherHistory();
    // Replace shouldFire with a broken impl to simulate a buggy history.
    hist.shouldFire = () => { throw new Error("boom"); };
    const reg = new WatcherRegistry({ history: hist });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (err, info) => errs.push({ msg: err.message, stage: info.stage }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    // When history.shouldFire throws, that rule is dropped (error emitted,
    // continue to next rule). The broken history affects every rule, so
    // the registry produces zero actions but emits one error per rule.
    assert(errs.length >= 1, "at least one error");
    assertEq(errs[0].stage, "history-decide", "stage=history-decide");
    assertEq(errs[0].msg, "boom", "original error message preserved");
    assertEq(out.length, 0, "no actions fired (history broken for every rule)");
  });

  test("a broken history for one rule does not stop a healthy rule on a different registry", () => {
    // Build a fresh registry whose history is healthy.
    const goodHist = new WatcherHistory();
    const reg = new WatcherRegistry({ history: goodHist });
    reg.add(shallowWaterRule({ cooldownMs: 0 }));
    reg.add(headingRule({ cooldownMs: 0 }));
    const out = reg.evaluate(frame({ depth: 1.2, headingTrue: 5 }));
    assertEq(out.length, 2, "both rules fire (healthy history)");
  });
});
