/**
 * tests/watchers.test.js
 * ----------------------------------------------------------------------------
 * End-to-end tests for the WatcherRegistry (backend/watchers.js).
 *
 * Coverage:
 *   1. Construction & defaults
 *   2. Rule registration (success, validation, dedupe)
 *   3. Rule removal & lookup
 *   4. evaluate() basic match / no-match
 *   5. evaluate() payload / reason / priority generation
 *   6. evaluate() default priority (0.5) when priority fn omitted
 *   7. evaluate() preserves registration order across multiple rules
 *   8. evaluate() invokes the LLM-notify path: 'fired' event + return value
 *   9. evaluate() when() throws -> 'error' event, evaluation continues
 *  10. evaluate() payload fn throws -> 'error' event, evaluation continues
 *  11. evaluate() produces invalid action -> 'error' event, evaluation continues
 *  12. evaluate() with bad frame throws TypeError
 *  13. evaluate() default payload {} when payloadFn omitted
 *  14. evaluate() default reason "" when reasonFn omitted
 *  15. list() diagnostics
 *  16. size / clear()
 *  17. Rule validation: bad id, bad name, bad when, bad action.name
 *  18. Verbose mode does not crash
 *  19. Priority out of range -> validateA2AAction clamps (existing behavior)
 *  20. End-to-end: registry output is consumable by validateA2AAction
 * ----------------------------------------------------------------------------
 */

"use strict";

const { run, test, assert, assertEq, assertThrows, section } = require("./_harness");
const { WatcherRegistry, DEFAULT_PRIORITY } = require("../backend/watchers");
const { validateA2AAction } = require("../backend/schemas");

/**
 * A canonical "shallow water" watcher used by many tests.
 */
function shallowWaterRule(overrides = {}) {
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
    ...overrides,
  };
}

/**
 * A second, independent watcher for ordering tests.
 */
function headingOffRule(overrides = {}) {
  return {
    id: "heading-off-course",
    name: "Heading deviates from route",
    when: (f) => f.headingTrue != null && (f.headingTrue < 10 || f.headingTrue > 350),
    action: {
      name: "highlight_waypoint",
      payload: (f) => ({ heading: f.headingTrue }),
      reason: (f) => `heading=${f.headingTrue.toFixed(1)}°`,
      priority: () => 0.6,
    },
    ...overrides,
  };
}

/**
 * Build a sample FeatureVector.
 */
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

run("watchers", async () => {

  // -----------------------------------------------------------------------
  section("construction & defaults");
  // -----------------------------------------------------------------------

  test("constructs with no options", () => {
    const reg = new WatcherRegistry();
    assertEq(reg.size, 0, "size=0");
    assertEq(reg.verbose, false, "verbose=false");
  });

  test("constructs with verbose: true", () => {
    const reg = new WatcherRegistry({ verbose: true });
    assertEq(reg.verbose, true, "verbose=true");
  });

  test("is an EventEmitter", () => {
    const reg = new WatcherRegistry();
    assertEq(typeof reg.on, "function", "has on()");
    assertEq(typeof reg.emit, "function", "has emit()");
  });

  test("DEFAULT_PRIORITY is 0.5", () => {
    assertEq(DEFAULT_PRIORITY, 0.5, "default priority");
  });

  // -----------------------------------------------------------------------
  section("rule registration");
  // -----------------------------------------------------------------------

  test("add() returns the id", () => {
    const reg = new WatcherRegistry();
    const id = reg.add(shallowWaterRule());
    assertEq(id, "shallow-water", "echoes id");
    assertEq(reg.size, 1, "size=1");
  });

  test("add() with duplicate id overwrites (last write wins)", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    reg.add(shallowWaterRule({ name: "v2" }));
    assertEq(reg.size, 1, "size=1 after overwrite");
    assertEq(reg.get("shallow-water").name, "v2", "name updated");
  });

  test("add() rejects non-object rule", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add(null), "object");
  });

  test("add() rejects missing id", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add({ name: "x", when: () => true, action: { name: "announce" } }), "id");
  });

  test("add() rejects empty id", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add({ id: "", name: "x", when: () => true, action: { name: "announce" } }), "id");
  });

  test("add() rejects id > 64 chars", () => {
    const reg = new WatcherRegistry();
    const longId = "a".repeat(65);
    assertThrows(() => reg.add({ id: longId, name: "x", when: () => true, action: { name: "announce" } }), "64");
  });

  test("add() rejects missing name", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add({ id: "x", when: () => true, action: { name: "announce" } }), "name");
  });

  test("add() rejects non-function when", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add({ id: "x", name: "y", when: "nope", action: { name: "announce" } }), "when");
  });

  test("add() rejects missing action", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add({ id: "x", name: "y", when: () => true }), "action");
  });

  test("add() rejects missing action.name", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.add({ id: "x", name: "y", when: () => true, action: {} }), "name");
  });

  // -----------------------------------------------------------------------
  section("rule lookup / removal");
  // -----------------------------------------------------------------------

  test("get() returns a denormalised rule", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const r = reg.get("shallow-water");
    assertEq(r.id, "shallow-water", "id");
    assertEq(r.name, "Shallow water warning", "name");
    assertEq(r.action.name, "raise_alert", "action.name");
    assertEq(typeof r.action.payload, "function", "action.payload is fn");
  });

  test("get() with unknown id returns undefined", () => {
    const reg = new WatcherRegistry();
    assertEq(reg.get("nope"), undefined, "undefined");
  });

  test("remove() returns true when present, false when absent", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    assertEq(reg.remove("shallow-water"), true, "removed");
    assertEq(reg.remove("shallow-water"), false, "absent");
    assertEq(reg.size, 0, "size=0");
  });

  test("list() returns id+name in registration order", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    reg.add(headingOffRule());
    const out = reg.list();
    assertEq(out.length, 2, "length=2");
    assertEq(out[0].id, "shallow-water", "first id");
    assertEq(out[1].id, "heading-off-course", "second id");
  });

  test("size reflects additions and removals", () => {
    const reg = new WatcherRegistry();
    assertEq(reg.size, 0, "empty");
    reg.add(shallowWaterRule());
    assertEq(reg.size, 1, "after add");
    reg.add(headingOffRule());
    assertEq(reg.size, 2, "after 2nd add");
    reg.remove("shallow-water");
    assertEq(reg.size, 1, "after remove");
  });

  test("clear() removes all rules", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    reg.add(headingOffRule());
    reg.clear();
    assertEq(reg.size, 0, "size=0 after clear");
  });

  // -----------------------------------------------------------------------
  section("evaluate() — basic match / no-match");
  // -----------------------------------------------------------------------

  test("returns empty array when no rules are registered", () => {
    const reg = new WatcherRegistry();
    const out = reg.evaluate(frame());
    assertEq(out.length, 0, "no actions");
  });

  test("returns empty array when no rule matches", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    // depth=11.4 is well above the 2.0 threshold
    const out = reg.evaluate(frame({ depth: 11.4 }));
    assertEq(out.length, 0, "no match");
  });

  test("returns one action when one rule matches", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out.length, 1, "one match");
    assertEq(out[0].action, "raise_alert", "action name");
  });

  // -----------------------------------------------------------------------
  section("evaluate() — payload / reason / priority");
  // -----------------------------------------------------------------------

  test("payload fn is called with the frame", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out[0].payload.kind, "shallow_water", "payload.kind");
    assertEq(out[0].payload.depth, 1.2, "payload.depth");
  });

  test("reason fn produces expected string", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const out = reg.evaluate(frame({ depth: 1.25 }));
    assertEq(out[0].reason, "depth=1.25m", "reason string");
  });

  test("priority fn controls priority", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out[0].priority, 0.85, "priority=0.85");
  });

  test("default priority is 0.5 when priority fn omitted", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "always",
      name: "always fires",
      when: () => true,
      action: { name: "announce" },
    });
    const out = reg.evaluate(frame());
    assertEq(out[0].priority, 0.5, "default priority");
  });

  test("default payload is {} when payload fn omitted", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "always",
      name: "always fires",
      when: () => true,
      action: { name: "announce" },
    });
    const out = reg.evaluate(frame());
    assertEq(typeof out[0].payload, "object", "payload is object");
    assertEq(Object.keys(out[0].payload).length, 0, "payload is empty");
  });

  test("default reason is '' when reason fn omitted", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "always",
      name: "always fires",
      when: () => true,
      action: { name: "announce" },
    });
    const out = reg.evaluate(frame());
    assertEq(out[0].reason, "", "empty reason");
  });

  test("priority is clamped to [0, 1] by validateA2AAction", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "too-loud",
      name: "priority too high",
      when: () => true,
      action: {
        name: "announce",
        priority: () => 5.0, // out of range
      },
    });
    const out = reg.evaluate(frame());
    assertEq(out[0].priority, 1.0, "clamped to 1.0");
  });

  test("priority is clamped to 0 from negative", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "silent",
      name: "priority too low",
      when: () => true,
      action: {
        name: "announce",
        priority: () => -3.0,
      },
    });
    const out = reg.evaluate(frame());
    assertEq(out[0].priority, 0, "clamped to 0");
  });

  // -----------------------------------------------------------------------
  section("evaluate() — ordering & multiple rules");
  // -----------------------------------------------------------------------

  test("preserves registration order across multiple firings", () => {
    const reg = new WatcherRegistry();
    // Both rules will match this frame.
    reg.add(shallowWaterRule());  // depth < 2
    reg.add(headingOffRule());    // heading < 10 OR > 350
    const out = reg.evaluate(frame({ depth: 1.2, headingTrue: 5 }));
    assertEq(out.length, 2, "two actions");
    assertEq(out[0].action, "raise_alert", "first: shallow");
    assertEq(out[1].action, "highlight_waypoint", "second: heading");
  });

  test("only firing rules contribute to output", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());   // matches
    reg.add(headingOffRule());     // does NOT match (heading=214.5)
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out.length, 1, "one match");
    assertEq(out[0].action, "raise_alert", "shallow");
  });

  // -----------------------------------------------------------------------
  section("evaluate() — events");
  // -----------------------------------------------------------------------

  test("emits 'fired' for each successful action", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    reg.add(headingOffRule());
    const fires = [];
    reg.on("fired", (a, info) => fires.push({ action: a.action, ruleId: info.ruleId }));
    reg.evaluate(frame({ depth: 1.2, headingTrue: 5 }));
    assertEq(fires.length, 2, "two fired events");
    assertEq(fires[0].ruleId, "shallow-water", "first ruleId");
    assertEq(fires[1].ruleId, "heading-off-course", "second ruleId");
  });

  test("does NOT emit 'fired' for non-matching rules", () => {
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const fires = [];
    reg.on("fired", () => fires.push(1));
    reg.evaluate(frame({ depth: 11.4 })); // does not match
    assertEq(fires.length, 0, "no fires");
  });

  // -----------------------------------------------------------------------
  section("evaluate() — error isolation");
  // -----------------------------------------------------------------------

  test("when() throwing rule does not stop other rules", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "broken-when",
      name: "broken when",
      when: () => { throw new Error("boom"); },
      action: { name: "announce" },
    });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (e, info) => errs.push({ msg: e.message, stage: info.stage, ruleId: info.ruleId }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(errs.length, 1, "one error event");
    assertEq(errs[0].stage, "when", "error in when stage");
    assertEq(errs[0].ruleId, "broken-when", "ruleId attached");
    assertEq(out.length, 1, "other rule still fires");
    assertEq(out[0].action, "raise_alert", "shallow still fires");
  });

  test("payload() throwing rule does not stop other rules", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "broken-payload",
      name: "broken payload",
      when: () => true,
      action: {
        name: "announce",
        payload: () => { throw new Error("payload boom"); },
      },
    });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (e, info) => errs.push({ msg: e.message, stage: info.stage }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(errs.length, 1, "one error");
    assertEq(errs[0].stage, "extract", "error in extract stage");
    assertEq(out.length, 1, "shallow still fires");
  });

  test("reason() throwing rule does not stop other rules", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "broken-reason",
      name: "broken reason",
      when: () => true,
      action: {
        name: "announce",
        reason: () => { throw new Error("reason boom"); },
      },
    });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (e, info) => errs.push({ msg: e.message, stage: info.stage }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(errs.length, 1, "one error");
    assertEq(errs[0].stage, "extract", "error in extract stage");
    assertEq(out.length, 1, "shallow still fires");
  });

  test("priority() throwing rule does not stop other rules", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "broken-priority",
      name: "broken priority",
      when: () => true,
      action: {
        name: "announce",
        priority: () => { throw new Error("priority boom"); },
      },
    });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (e, info) => errs.push({ msg: e.message, stage: info.stage }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(errs.length, 1, "one error");
    assertEq(errs[0].stage, "extract", "error in extract stage");
    assertEq(out.length, 1, "shallow still fires");
  });

  test("non-finite priority fires 'error' and the rule is dropped", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "bad-priority",
      name: "non-finite priority",
      when: () => true,
      action: { name: "announce", priority: () => NaN },
    });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (e, info) => errs.push({ msg: e.message, stage: info.stage }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(errs.length, 1, "one error");
    assertEq(errs[0].stage, "validate-priority", "stage=validate-priority");
    assertEq(out.length, 1, "shallow still fires");
  });

  test("invalid action name fires 'error' and the rule is dropped", () => {
    const reg = new WatcherRegistry();
    reg.add({
      id: "bad-action",
      name: "unknown action",
      when: () => true,
      action: { name: "not_a_real_action" },
    });
    reg.add(shallowWaterRule());
    const errs = [];
    reg.on("error", (e, info) => errs.push({ msg: e.message, stage: info.stage }));
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(errs.length, 1, "one error");
    assertEq(errs[0].stage, "validate-action", "stage=validate-action");
    assertEq(out.length, 1, "shallow still fires");
  });

  // -----------------------------------------------------------------------
  section("evaluate() — argument validation");
  // -----------------------------------------------------------------------

  test("rejects null frame with TypeError", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.evaluate(null), "frame");
  });

  test("rejects undefined frame with TypeError", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.evaluate(undefined), "frame");
  });

  test("rejects string frame with TypeError", () => {
    const reg = new WatcherRegistry();
    assertThrows(() => reg.evaluate("frame"), "frame");
  });

  test("accepts any plain object as a frame (no field validation)", () => {
    // Watchers own field validation via their `when` predicate. A frame
    // with no fields at all just means every depth-check returns false.
    const reg = new WatcherRegistry();
    reg.add(shallowWaterRule());
    const out = reg.evaluate({});
    assertEq(out.length, 0, "no match (depth undefined -> false)");
  });

  // -----------------------------------------------------------------------
  section("verbose mode");
  // -----------------------------------------------------------------------

  test("verbose mode does not throw", () => {
    const reg = new WatcherRegistry({ verbose: true });
    reg.add(shallowWaterRule());
    const out = reg.evaluate(frame({ depth: 1.2 }));
    assertEq(out.length, 1, "still fires");
  });

  // -----------------------------------------------------------------------
  section("end-to-end: every produced action passes validateA2AAction");
  // -----------------------------------------------------------------------

  test("all 8 allowed actions are accepted by the registry", () => {
    const reg = new WatcherRegistry();
    const names = [
      "morph_to_hazard_mode",
      "morph_to_navigation_mode",
      "morph_to_engineering_mode",
      "highlight_waypoint",
      "raise_alert",
      "clear_alerts",
      "set_panel_focus",
      "announce",
    ];
    for (const n of names) {
      reg.add({
        id: `r-${n}`,
        name: `rule for ${n}`,
        when: () => true,
        action: { name: n },
      });
    }
    const out = reg.evaluate(frame());
    assertEq(out.length, 8, "all 8 fired");
    for (let i = 0; i < 8; i++) {
      const v = validateA2AAction(out[i]);
      assertEq(v.ok, true, `validate: ${names[i]}`);
    }
  });
});
