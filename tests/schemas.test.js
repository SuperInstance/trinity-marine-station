/**
 * tests/schemas.test.js
 * ----------------------------------------------------------------------------
 * Unit tests for backend/schemas.js — the runtime validation contract.
 * ----------------------------------------------------------------------------
 */

const {
  FEATURE_VECTOR_INDEX,
  validateFeatureVector,
  isPlausibleSignalKDelta,
  normalizeEnergyReading,
  A2A_ALLOWED_ACTIONS,
  validateA2AAction,
  parseAndValidateA2A,
  makeLlmChunk,
  getActionPayloadSchema,
  validateActionPayload,
  isFiniteNumber,
  isString,
  isPlainObject,
} = require("../backend/schemas");

const { test, assert, run } = require("./_harness");

run("schemas", async () => {

  // -------------------------------------------------------------------------
  // validateFeatureVector
  // -------------------------------------------------------------------------
  test("validateFeatureVector: accepts a Float64Array of length 6", () => {
    const v = new Float64Array([37.81, -122.51, 5.4, 45, 30, 0.1]);
    const r = validateFeatureVector(v);
    assert(r.ok === true, "should be ok");
    assert(r.value instanceof Float64Array, "should return Float64Array");
    assert(r.value.length === 6, "should preserve length");
    assert(r.value[0] === 37.81, "should preserve content");
  });

  test("validateFeatureVector: accepts a plain array", () => {
    const r = validateFeatureVector([0, 0, 0, 0, 0, 0]);
    assert(r.ok, "ok");
    assert(r.value instanceof Float64Array, "should normalize to Float64Array");
  });

  test("validateFeatureVector: rejects wrong length", () => {
    const r = validateFeatureVector([1, 2, 3]);
    assert(!r.ok, "should fail");
    assert(r.errors[0].includes("length 3"), "should mention length");
  });

  test("validateFeatureVector: rejects NaN elements", () => {
    const r = validateFeatureVector([1, 2, NaN, 4, 5, 6]);
    assert(!r.ok, "should fail");
    assert(r.errors[0].includes("not a finite number"), "should identify the bad element");
  });

  test("validateFeatureVector: rejects non-array input", () => {
    assert(!validateFeatureVector(null).ok,  "null should fail");
    assert(!validateFeatureVector(undefined).ok, "undefined should fail");
    assert(!validateFeatureVector({}).ok, "object should fail");
    assert(!validateFeatureVector(42).ok, "number should fail");
  });

  test("validateFeatureVector: reports domain warnings but still ok", () => {
    const r = validateFeatureVector([91, -200, 5, 180, -1, 1.5]);
    assert(r.ok, "should still be ok");
    assert(r.warnings, "should have warnings");
    assert(r.warnings.length >= 4, "should report all out-of-range fields");
  });

  test("validateFeatureVector: returns a copy so caller can't mutate original", () => {
    const src = new Float64Array([1, 2, 3, 4, 5, 6]);
    const r = validateFeatureVector(src);
    r.value[0] = 99;
    assert(src[0] === 1, "original should not be mutated");
  });

  // -------------------------------------------------------------------------
  // isPlausibleSignalKDelta
  // -------------------------------------------------------------------------
  test("isPlausibleSignalKDelta: accepts a real delta", () => {
    assert(isPlausibleSignalKDelta({ updates: [{ values: [] }] }));
  });
  test("isPlausibleSignalKDelta: rejects null", () => {
    assert(!isPlausibleSignalKDelta(null));
  });
  test("isPlausibleSignalKDelta: rejects missing updates", () => {
    assert(!isPlausibleSignalKDelta({}));
  });
  test("isPlausibleSignalKDelta: rejects empty updates", () => {
    assert(!isPlausibleSignalKDelta({ updates: [] }));
  });
  test("isPlausibleSignalKDelta: rejects non-object", () => {
    assert(!isPlausibleSignalKDelta("string"));
    assert(!isPlausibleSignalKDelta(42));
  });

  // -------------------------------------------------------------------------
  // normalizeEnergyReading
  // -------------------------------------------------------------------------
  test("normalizeEnergyReading: passes through a clean reading", () => {
    const r = normalizeEnergyReading({ score: 0.4, anomaly: false, reason: "steady", timestamp: 1000 });
    assert(r.score === 0.4, "score");
    assert(r.anomaly === false, "anomaly");
    assert(r.reason === "steady", "reason");
    assert(r.timestamp === 1000, "timestamp");
  });
  test("normalizeEnergyReading: fills defaults", () => {
    const r = normalizeEnergyReading({});
    assert(r.score === 0, "score default");
    assert(r.anomaly === false, "anomaly default");
    assert(r.reason === "unknown", "reason default");
    assert(Number.isFinite(r.timestamp), "timestamp default");
  });
  test("normalizeEnergyReading: returns null on non-object", () => {
    assert(normalizeEnergyReading(null) === null);
    assert(normalizeEnergyReading("string") === null);
  });

  // -------------------------------------------------------------------------
  // validateA2AAction
  // -------------------------------------------------------------------------
  test("validateA2AAction: accepts a known action", () => {
    const r = validateA2AAction({ action: "morph_to_hazard_mode", priority: 0.9, reason: "shallow" });
    assert(r.ok, "ok");
    assert(r.value.action === "morph_to_hazard_mode", "action");
    assert(r.value.priority === 0.9, "priority");
    assert(r.value.reason === "shallow", "reason");
  });
  test("validateA2AAction: clamps priority to [0,1]", () => {
    assert(validateA2AAction({ action: "raise_alert", priority: 1.5 }).value.priority === 1);
    assert(validateA2AAction({ action: "raise_alert", priority: -0.5 }).value.priority === 0);
  });
  test("validateA2AAction: defaults priority to 0.5", () => {
    assert(validateA2AAction({ action: "raise_alert" }).value.priority === 0.5);
  });
  test("validateA2AAction: defaults payload to {} when missing", () => {
    assert(validateA2AAction({ action: "raise_alert" }).value.payload !== undefined);
  });
  test("validateA2AAction: rejects unknown action", () => {
    const r = validateA2AAction({ action: "do_nothing" });
    assert(!r.ok, "should fail");
    assert(r.errors[0].includes("allow-list"), "should mention allow-list");
  });
  test("validateA2AAction: rejects non-string action", () => {
    assert(!validateA2AAction({ action: 42 }).ok);
    assert(!validateA2AAction({ action: null }).ok);
  });
  test("validateA2AAction: rejects non-object", () => {
    assert(!validateA2AAction(null).ok);
    assert(!validateA2AAction("a2a").ok);
    assert(!validateA2AAction([]).ok);
  });

  // -------------------------------------------------------------------------
  // parseAndValidateA2A
  // -------------------------------------------------------------------------
  test("parseAndValidateA2A: round-trips a valid JSON", () => {
    const r = parseAndValidateA2A('{"action":"morph_to_hazard_mode","priority":0.97}');
    assert(r.ok, "ok");
    assert(r.value.action === "morph_to_hazard_mode");
    assert(r.value.priority === 0.97);
  });
  test("parseAndValidateA2A: rejects invalid JSON", () => {
    const r = parseAndValidateA2A('not json');
    assert(!r.ok, "should fail");
    assert(r.errors[0].includes("parse"), "should mention parse failure");
  });
  test("parseAndValidateA2A: rejects empty string", () => {
    assert(!parseAndValidateA2A("").ok);
    assert(!parseAndValidateA2A("   ").ok);
  });
  test("parseAndValidateA2A: rejects non-string input", () => {
    assert(!parseAndValidateA2A(null).ok);
    assert(!parseAndValidateA2A(42).ok);
  });
  test("parseAndValidateA2A: valid JSON but invalid action", () => {
    const r = parseAndValidateA2A('{"action":"hack_the_bridge"}');
    assert(!r.ok, "should fail");
  });
  test("parseAndValidateA2A: trims whitespace", () => {
    const r = parseAndValidateA2A('  {"action":"announce"}  ');
    assert(r.ok, "ok");
    assert(r.value.action === "announce");
  });

  // -------------------------------------------------------------------------
  // makeLlmChunk
  // -------------------------------------------------------------------------
  test("makeLlmChunk: defaults to kind=response and done=false", () => {
    const c = makeLlmChunk("hi");
    assert(c.text === "hi");
    assert(c.done === false);
    assert(c.kind === "response");
  });
  test("makeLlmChunk: preserves done and finishReason", () => {
    const c = makeLlmChunk("", { done: true, finishReason: "stop" });
    assert(c.done === true);
    assert(c.finishReason === "stop");
  });
  test("makeLlmChunk: coerces non-string text to empty", () => {
    assert(makeLlmChunk(null).text === "");
    assert(makeLlmChunk(42).text === "");
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------
  test("FEATURE_VECTOR_INDEX.VECTOR_DIM === 6", () => {
    assert(FEATURE_VECTOR_INDEX.VECTOR_DIM === 6);
  });

  test("A2A_ALLOWED_ACTIONS is a Set with expected entries", () => {
    assert(A2A_ALLOWED_ACTIONS instanceof Set);
    assert(A2A_ALLOWED_ACTIONS.has("morph_to_hazard_mode"));
    assert(A2A_ALLOWED_ACTIONS.has("announce"));
    assert(A2A_ALLOWED_ACTIONS.size >= 5);
  });

  // -------------------------------------------------------------------------
  // Predicates
  // -------------------------------------------------------------------------
  test("isFiniteNumber: only finite numbers", () => {
    assert(isFiniteNumber(0));
    assert(isFiniteNumber(-1.5));
    assert(isFiniteNumber(1e10));
    assert(!isFiniteNumber(NaN));
    assert(!isFiniteNumber(Infinity));
    assert(!isFiniteNumber("1"));
    assert(!isFiniteNumber(null));
  });
  test("isString: only strings", () => {
    assert(isString(""));
    assert(isString("hello"));
    assert(!isString(42));
    assert(!isString(null));
  });
  test("isPlainObject: arrays and null are not plain objects", () => {
    assert(isPlainObject({}));
    assert(isPlainObject({ a: 1 }));
    assert(!isPlainObject([]));
    assert(!isPlainObject(null));
    assert(!isPlainObject("string"));
  });

  // -------------------------------------------------------------------------
  // Per-action payload schemas (Phase 8 groundwork)
  // -------------------------------------------------------------------------
  test("ACTION_PAYLOAD_SCHEMAS: covers every allowed action", () => {
    // Every name in A2A_ALLOWED_ACTIONS must have a payload schema.
    for (const name of A2A_ALLOWED_ACTIONS) {
      const schema = getActionPayloadSchema(name);
      assert(schema !== null, `schema missing for action '${name}'`);
      assert(schema.name === name, "schema.name must match");
      assert(typeof schema.fields === "object", "fields must be object");
    }
  });

  test("getActionPayloadSchema: returns null for unknown action", () => {
    assert(getActionPayloadSchema("not_an_action") === null);
  });

  test("validateActionPayload: passes through unknown-action payloads", () => {
    // Backward compatibility: actions without a schema accept any plain object.
    const r = validateActionPayload("custom_action_xyz", { foo: "bar" });
    assert(r.ok, "ok");
    assert(r.value.foo === "bar", "preserves unknown fields");
  });

  test("validateActionPayload: rejects non-object payload for unknown action", () => {
    const r = validateActionPayload("custom_action_xyz", "string");
    assert(!r.ok, "should fail");
    assert(r.errors[0].includes("must be an object"), "explains why");
  });

  test("validateActionPayload: applies defaults when fields are absent", () => {
    // raise_alert: severity defaults to "warning", source to "system", etc.
    const r = validateActionPayload("raise_alert", {});
    assert(r.ok, "ok");
    assert(r.value.severity === "warning", "default severity");
    assert(r.value.source === "system", "default source");
    assert(r.value.message === "", "default message");
    assert(r.value.ttlMs === 0, "default ttlMs");
  });

  test("validateActionPayload: rejects unknown fields when allowExtras=false", () => {
    const r = validateActionPayload("raise_alert", { severity: "critical", bogus: 42 });
    assert(!r.ok, "should fail");
    assert(r.errors.some(e => e.includes("bogus")), "names the unknown field");
    assert(r.errors.some(e => e.includes("unknown field")), "explains why");
  });

  test("validateActionPayload: rejects wrong-type field values", () => {
    // severity must be a string
    const r1 = validateActionPayload("raise_alert", { severity: 42 });
    assert(!r1.ok, "should fail");
    assert(r1.errors[0].includes("expected string"), "explains the type error");

    // ttlMs must be an integer
    const r2 = validateActionPayload("raise_alert", { severity: "warning", ttlMs: 1.5 });
    assert(!r2.ok, "should fail");
    assert(r2.errors[0].includes("expected integer"), "explains the type error");

    // durationMs (highlight_waypoint) must be a non-negative integer
    const r3 = validateActionPayload("highlight_waypoint", { durationMs: "soon" });
    assert(!r3.ok, "should fail");
    assert(r3.errors[0].includes("expected integer"), "explains the type error");
  });

  test("validateActionPayload: rejects empty strings for string fields", () => {
    // We require non-empty strings for declared string fields when supplied.
    const r = validateActionPayload("raise_alert", { severity: "" });
    assert(!r.ok, "should fail");
    assert(r.errors[0].includes("non-empty"), "explains why");
  });

  test("validateActionPayload: accepts string[] fields (clear_alerts)", () => {
    const r1 = validateActionPayload("clear_alerts", { severities: ["warning", "critical"] });
    assert(r1.ok, "ok");
    assert(r1.value.severities.length === 2, "preserves array");
    const r2 = validateActionPayload("clear_alerts", { severities: [] });
    assert(r2.ok, "ok");
    assert(r2.value.severities.length === 0, "empty array ok");
    const r3 = validateActionPayload("clear_alerts", { severities: "not-an-array" });
    assert(!r3.ok, "should fail");
    assert(r3.errors[0].includes("expected array of strings"), "explains why");
    const r4 = validateActionPayload("clear_alerts", { severities: ["ok", 42] });
    assert(!r4.ok, "should fail");
    assert(r4.errors[0].includes("array[1]"), "names the bad index");
  });

  test("validateActionPayload: freezes the normalized payload", () => {
    const r = validateActionPayload("announce", { message: "hi" });
    assert(r.ok, "ok");
    assert(Object.isFrozen(r.value), "payload is frozen");
  });

  test("validateA2AAction: integrates payload validation into the main path", () => {
    // Previously, any plain object payload was accepted. Now the per-action
    // schema enforces the shape. This test pins that integration.
    const r1 = validateA2AAction({ action: "raise_alert", payload: { severity: "critical", message: "boom" } });
    assert(r1.ok, "valid payload should pass");
    assert(r1.value.payload.severity === "critical", "severity preserved");
    assert(r1.value.payload.message === "boom", "message preserved");

    const r2 = validateA2AAction({ action: "raise_alert", payload: { severity: 99 } });
    assert(!r2.ok, "wrong-type payload should fail");
    assert(r2.errors[0].includes("expected string"), "explains the failure");
  });

  test("validateA2AAction: legacy callers without payload still work (backward compat)", () => {
    // The schemas default every field, so callers that omit payload
    // entirely still get a successful validation.
    for (const action of [
      "morph_to_hazard_mode",
      "morph_to_navigation_mode",
      "morph_to_engineering_mode",
      "raise_alert",
      "clear_alerts",
      "announce",
      "highlight_waypoint",
      "set_panel_focus",
    ]) {
      const r = validateA2AAction({ action });
      assert(r.ok, `action '${action}' with no payload should still validate`);
    }
  });
});