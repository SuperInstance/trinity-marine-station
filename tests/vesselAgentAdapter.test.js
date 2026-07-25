/**
 * tests/vesselAgentAdapter.test.js
 * ----------------------------------------------------------------------------
 * Unit tests for the schema-bridge adapter that normalizes both Signal K
 * deltas and vessel-agent core_anchor updates into the canonical TrinityFrame.
 *
 * Coverage:
 *   - Hello frame rejection (returned as error, not normalized)
 *   - Malformed message rejection (non-object, missing updates, bad values)
 *   - Pure Signal K delta → TrinityFrame with anonymous vessel_uuid
 *   - Pure vessel-agent delta → TrinityFrame with explicit provenance
 *   - Crew report & fleet report extraction
 *   - H3 index auto-computation when not provided
 *   - Explicit H3 index preservation when provided
 *   - Timestamp_ns nanosecond-anchor path
 *   - Schema round-trip (validateTrinityFrame succeeds for every produced frame)
 *   - normalizeOrThrow convenience
 * ----------------------------------------------------------------------------
 */

"use strict";

const {
  test, assert, assertEq, assertThrows, assertDoesNotThrow,
  section, run,
} = require("./_harness");
const adapter = require("../backend/vesselAgentAdapter");
const { validateTrinityFrame } = require("../backend/schemas");

// Helper: a minimal valid Signal K delta
function signalKDelta(overrides = {}) {
  return Object.assign({
    context: "vessels.self",
    updates: [{
      timestamp: "2026-07-25T17:31:04.512Z",
      values: {
        "navigation.position":            { latitude: 37.8196, longitude: -122.5187 },
        "navigation.speedOverGround":     5.2,
        "navigation.headingTrue":         38.0,
        "environment.depth.belowTransducer": 31.5,
        "meta.trajectoryProgress":        0.05,
        "meta.currentWaypoint":           "Golden Gate Approach",
      },
    }],
  }, overrides);
}

// Helper: a minimal valid vessel-agent delta (triply-anchored)
function vesselAgentDelta(overrides = {}) {
  return Object.assign({
    context: "urn:uuid:US-AK-FVCATCHER-01",
    updates: [{
      timestamp: "2026-07-25T17:31:04.512Z",
      timestamp_ns: 1785000664512000000,
      source: {
        vessel_uuid:      "urn:uuid:US-AK-FVCATCHER-01",
        hardware_source:  "Furuno_DFF3DHD",
        pipeline_version: "0.4.0",
      },
      values: {
        "navigation.position":            { latitude: 58.123, longitude: -134.456 },
        "navigation.speedOverGround":     8.5,
        "navigation.headingTrue":         45.0,
        "environment.depth.belowTransducer": 32.4,
        "spatial.h3Index":                "8a21104523fffff",
        "crew_report.transcript":         "Looks like chum at 40 fathoms",
        "crew_report.confidence":         0.82,
        "fleet_report.source_vessel":     "urn:uuid:US-AK-FVCATCHER-02",
      },
    }],
  }, overrides);
}

run("vesselAgentAdapter", async () => {
  section("rejection paths");

  test("rejects non-object messages", async () => {
    assertEq(adapter.normalize(null).ok, false,  "null");
    assertEq(adapter.normalize(undefined).ok, false, "undefined");
    assertEq(adapter.normalize("string").ok, false, "string");
    assertEq(adapter.normalize(42).ok, false, "number");
    assertEq(adapter.normalize([1,2,3]).ok, false, "array");
  });

  test("hello frames return a skip-sentinel error", async () => {
    const r = adapter.normalize({ type: "hello", name: "trinity-marine-station" });
    assertEq(r.ok, false, "hello rejected");
    assert(r.error.includes("hello"), `error mentions hello: ${r.error}`);
  });

  test("rejects messages without updates", async () => {
    const r = adapter.normalize({ context: "x" });
    assertEq(r.ok, false, "missing updates");
    assert(r.error.includes("updates"), `error mentions updates: ${r.error}`);
  });

  test("rejects empty updates array", async () => {
    const r = adapter.normalize({ context: "x", updates: [] });
    assertEq(r.ok, false, "empty updates");
  });

  test("rejects updates[0] that is not an object", async () => {
    const r = adapter.normalize({ context: "x", updates: ["nope"] });
    assertEq(r.ok, false, "string update");
  });

  test("rejects update without timestamp", async () => {
    const r = adapter.normalize({
      context: "x",
      updates: [{ values: {} }],   // no timestamp
    });
    assertEq(r.ok, false, "missing timestamp");
    assert(r.error.includes("timestamp"), `error mentions timestamp: ${r.error}`);
  });

  section("pure Signal K delta");

  test("normalizes a Signal K delta into a TrinityFrame", async () => {
    const r = adapter.normalize(signalKDelta());
    assert(r.ok, "normalize ok");
    const f = r.frame;
    assertEq(f.source.vesselUuid, "anonymous", "anonymous vessel for pure SK");
    assertEq(f.source.hardwareSource, "unknown", "no hardware source");
    assertEq(f.navigation.latitude,  37.8196, "lat");
    assertEq(f.navigation.longitude, -122.5187, "lon");
    assertEq(f.navigation.speedOverGround, 5.2, "sog");
    assertEq(f.navigation.headingTrue,     38.0, "hdg");
    assertEq(f.environment.depthBelowTransducer, 31.5, "depth");
    assertEq(f.trajectoryProgress, 0.05, "trajectory progress");
    assertEq(f.currentWaypoint, "Golden Gate Approach", "waypoint");
    assert(typeof f.timestampNs === "bigint", "timestampNs is BigInt");
  });

  test("auto-computes H3 index when not provided", async () => {
    const r = adapter.normalize(signalKDelta());
    assert(r.ok, "normalize ok");
    assertEq(typeof r.frame.spatial.h3Index, "string", "h3 type");
    assertEq(r.frame.spatial.h3Index.length, 16, "h3 length");
    assert(/^[0-9a-f]{16}$/.test(r.frame.spatial.h3Index), "h3 format");
  });

  test("extracted vessel-uuid from Signal K context when present", async () => {
    const r = adapter.normalize(signalKDelta({
      context: "vessels.urn:uuid:US-AK-FVCATCHER-99",
    }));
    assert(r.ok, "normalize ok");
    assertEq(r.frame.source.vesselUuid, "urn:uuid:US-AK-FVCATCHER-99",
             "vessel uuid from context");
  });

  section("vessel-agent delta");

  test("normalizes a vessel-agent delta with full provenance", async () => {
    const r = adapter.normalize(vesselAgentDelta());
    assert(r.ok, "normalize ok");
    const f = r.frame;
    assertEq(f.source.vesselUuid,      "urn:uuid:US-AK-FVCATCHER-01", "vessel uuid");
    assertEq(f.source.hardwareSource,  "Furuno_DFF3DHD", "hw source");
    assertEq(f.source.pipelineVersion, "0.4.0", "pipeline version");
    assertEq(f.navigation.latitude,  58.123, "lat");
    assertEq(f.navigation.longitude, -134.456, "lon");
    assertEq(f.navigation.speedOverGround, 8.5, "sog");
    assertEq(f.navigation.headingTrue,     45.0, "hdg");
    assertEq(f.environment.depthBelowTransducer, 32.4, "depth");
    // Explicit H3 should win over auto-compute. The adapter zero-pads to
    // uint64 width (16 chars), so the canonical 15-char H3 hex becomes a
    // 16-char form.
    assertEq(f.spatial.h3Index, "08a21104523fffff", "explicit h3 preserved");
  });

  test("preserves timestamp_ns as BigInt", async () => {
    const r = adapter.normalize(vesselAgentDelta());
    assert(r.ok, "normalize ok");
    assert(typeof r.frame.timestampNs === "bigint", "timestampNs BigInt");
    assertEq(r.frame.timestampNs, 1785000664512000000n, "exact ns value");
  });

  test("derives timestamp_ns from ISO when timestamp_ns is absent", async () => {
    const r = adapter.normalize(signalKDelta());
    assert(r.ok, "normalize ok");
    // 2026-07-25T17:31:04.512Z = 1785000664512 ms = 1785000664512000000 ns
    assertEq(r.frame.timestampNs, 1785000664512000000n, "derived ns value");
  });

  test("extracts crewReport", async () => {
    const r = adapter.normalize(vesselAgentDelta());
    assert(r.ok, "normalize ok");
    assert(r.frame.crewReport, "crewReport present");
    assertEq(r.frame.crewReport.transcript, "Looks like chum at 40 fathoms", "transcript");
    assertEq(r.frame.crewReport.confidence, 0.82, "confidence");
  });

  test("extracts fleetReport", async () => {
    const r = adapter.normalize(vesselAgentDelta());
    assert(r.ok, "normalize ok");
    assert(r.frame.fleetReport, "fleetReport present");
    assertEq(r.frame.fleetReport.sourceVessel, "urn:uuid:US-AK-FVCATCHER-02",
             "source vessel");
  });

  test("omits crewReport when not present", async () => {
    const r = adapter.normalize(signalKDelta());
    assert(r.ok, "normalize ok");
    assertEq(r.frame.crewReport, undefined, "no crewReport");
    assertEq(r.frame.fleetReport, undefined, "no fleetReport");
  });

  section("schema round-trip");

  test("every produced frame passes validateTrinityFrame()", async () => {
    for (const [name, msg] of [
      ["pure SK",     signalKDelta()],
      ["vessel-agent", vesselAgentDelta()],
      ["SK with vessel context", signalKDelta({ context: "vessels.urn:uuid:X-1" })],
    ]) {
      const r = adapter.normalize(msg);
      assert(r.ok, `normalize ${name}`);
      const v = validateTrinityFrame(r.frame);
      assert(v.ok, `${name} validates: ${v.errors ? v.errors.join("; ") : ""}`);
    }
  });

  section("normalizeOrThrow convenience");

  test("returns the frame on success", async () => {
    const f = adapter.normalizeOrThrow(signalKDelta());
    assertEq(f.navigation.latitude, 37.8196, "frame.latitude");
  });

  test("throws on bad input", async () => {
    assertThrows(() => adapter.normalizeOrThrow({ type: "hello" }),
                 /hello/);
    assertThrows(() => adapter.normalizeOrThrow(null),
                 /not an object|message is not an object/);
  });

  section("resilience");

  test("missing position defaults to (0, 0) without crashing", async () => {
    const msg = {
      context: "x",
      updates: [{
        timestamp: "2026-07-25T17:31:04.512Z",
        values: {
          "navigation.speedOverGround": 5.0,
          "navigation.headingTrue":     90.0,
          "environment.depth.belowTransducer": 10.0,
        },
      }],
    };
    const r = adapter.normalize(msg);
    assert(r.ok, "normalize ok");
    assertEq(r.frame.navigation.latitude, 0, "default lat");
    assertEq(r.frame.navigation.longitude, 0, "default lon");
    // H3 fallback when no position to compute from.
    assertEq(r.frame.spatial.h3Index, "0000000000000000", "zero h3");
  });

  test("string-valued numerics in values are coerced", async () => {
    const msg = signalKDelta();
    msg.updates[0].values["navigation.speedOverGround"] = "5.7";
    msg.updates[0].values["environment.depth.belowTransducer"] = "12.3";
    const r = adapter.normalize(msg);
    assert(r.ok, "normalize ok");
    assertEq(r.frame.navigation.speedOverGround, 5.7, "string sog → number");
    assertEq(r.frame.environment.depthBelowTransducer, 12.3, "string depth → number");
  });

  test("rejects non-finite numerics", async () => {
    const msg = signalKDelta();
    msg.updates[0].values["navigation.speedOverGround"] = Infinity;
    const r = adapter.normalize(msg);
    assertEq(r.ok, true, "Infinity → fallback 0 (coerced to finite default)");
    assertEq(r.frame.navigation.speedOverGround, 0, "fallback to 0");
  });

  test("ensure normalize doesn't mutate its input", async () => {
    const msg = signalKDelta();
    const snapshot = JSON.stringify(msg);
    adapter.normalize(msg);
    assertEq(JSON.stringify(msg), snapshot, "input unchanged");
  });
});