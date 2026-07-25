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
});