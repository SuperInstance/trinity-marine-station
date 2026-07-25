// backend/vesselAgentAdapter.js
// =============================================================================
// Trinity delta normalizer.
//
// Single source of truth for translating whatever wire format the upstream
// producer speaks (Signal K delta, vessel-agent core_anchor JSON, or any
// superset thereof) into the canonical TrinityFrame shape that every
// downstream module (ring buffer, JEPA, narrator, vector store) consumes.
//
// Why a single adapter?
//   - Adding new fields means one edit here, not N edits across the codebase
//   - The downstream contract is stable even if upstream formats diverge
//   - Pure functions = trivially testable
//
// Inputs accepted:
//   1. Signal K delta:
//        { context, updates: [ { timestamp, values: { ...paths } } ] }
//   2. Trinity delta (vessel-agent vocabulary):
//        { context, updates: [ { timestamp, timestamp_ns,
//                                source: { vessel_uuid, ... },
//                                values: { navigation.*, spatial.*, crew_report.* } } ] }
//
// Output:
//   TrinityFrame (see JSDoc below)
//
// Backward-compat: this module is additive — pure Signal K frames produce
// valid TrinityFrames with vessel_uuid = "anonymous", h3Index computed on
// the fly, and crew_report / fleet_report fields absent.
// =============================================================================

"use strict";

const h3 = require("./h3");
const { validateTrinityFrame, isPlainObject } = require("./schemas");

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Normalize any incoming message into a TrinityFrame.
 *
 * Returns `{ ok: true, frame }` on success or `{ ok: false, error }` on
 * failure. Errors are intentionally non-throwing so the WebSocket consumer
 * can log + continue without crashing on a single bad frame.
 *
 * @param {object} msg  Raw parsed JSON from the WebSocket
 * @returns {{ ok: true, frame: TrinityFrame } | { ok: false, error: string }}
 */
function normalize(msg) {
  if (!isPlainObject(msg)) {
    return { ok: false, error: "message is not an object" };
  }

  // Hello handshake is *not* a delta — caller handles separately.
  if (msg.type === "hello") {
    return { ok: false, error: "hello frame; skip normalization" };
  }

  // ─── Signal K + Trinity delta both use the { context, updates } envelope ──
  if (!Array.isArray(msg.updates) || msg.updates.length === 0) {
    return { ok: false, error: "no updates array" };
  }

  // We only normalize the first update per message; multi-update deltas
  // arrive as separate messages in practice (Signal K best practice).
  // Caller can call normalize() per message and skip nulls.
  const u = msg.updates[0];
  if (!isPlainObject(u)) {
    return { ok: false, error: "update[0] is not an object" };
  }

  const values = isPlainObject(u.values) ? u.values : {};

  const tsIso = pickTimestamp(u, values);
  if (!tsIso) {
    return { ok: false, error: "no timestamp in update" };
  }
  const tsNs = pickTimestampNs(u, tsIso);

  const source = extractSource(msg, u);
  const nav    = extractNavigation(values);
  const env    = extractEnvironment(values);
  const spatial = extractSpatial(values, nav.latitude, nav.longitude);
  const crew   = extractCrewReport(values);
  const fleet  = extractFleetReport(values);
  const meta   = extractMeta(values);

  const frame = {
    timestampNs: tsNs,
    timestamp:   tsIso,
    source,
    navigation:  nav,
    environment: env,
    spatial,
    trajectoryProgress: meta.trajectoryProgress,
    currentWaypoint:    meta.currentWaypoint,
  };
  if (crew)  frame.crewReport  = crew;
  if (fleet) frame.fleetReport = fleet;

  const valid = validateTrinityFrame(frame);
  if (!valid.ok) return { ok: false, error: valid.error };

  return { ok: true, frame };
}

/**
 * Convenience: throw on failure (for tests / known-good producers).
 *
 * @param {object} msg
 * @returns {TrinityFrame}
 * @throws {Error}
 */
function normalizeOrThrow(msg) {
  const r = normalize(msg);
  if (!r.ok) throw new Error(`vesselAgentAdapter.normalize failed: ${r.error}`);
  return r.frame;
}

// ---------------------------------------------------------------------------
// Field extractors — each returns its slice of the canonical frame, applying
// vessel-agent vocabulary where present and falling back to Signal K paths.
// ---------------------------------------------------------------------------

function extractSource(msg, u) {
  // vessel-agent explicit source block on the update
  const ua = isPlainObject(u.source) ? u.source : {};
  // Signal K "context" carries vessel URN (e.g. "vessels.urn:uuid:...")
  const ctxVessel = extractVesselFromContext(msg.context);
  return {
    vesselUuid:      ua.vessel_uuid      || ctxVessel || "anonymous",
    hardwareSource:  ua.hardware_source  || "unknown",
    pipelineVersion: ua.pipeline_version || "unknown",
  };
}

function extractNavigation(values) {
  const pos = isPlainObject(values["navigation.position"])
    ? values["navigation.position"]
    : null;
  const lat = pos ? Number(pos.latitude) : null;
  const lon = pos ? Number(pos.longitude) : null;
  return {
    latitude:        Number.isFinite(lat) ? lat : 0,
    longitude:       Number.isFinite(lon) ? lon : 0,
    speedOverGround: toFiniteNumber(values["navigation.speedOverGround"]) || 0,
    headingTrue:     toFiniteNumber(values["navigation.headingTrue"])     || 0,
  };
}

function extractEnvironment(values) {
  return {
    depthBelowTransducer:
      toFiniteNumber(values["environment.depth.belowTransducer"]) || 0,
  };
}

function extractSpatial(values, lat, lon) {
  // vessel-agent precomputed hex string wins. Accept 8–16-char hex (canonical
  // H3 indexes are 15 chars; our 16-char layout zero-pads to a uint64 width).
  const explicit = pickString(values["spatial.h3Index"])
                || pickString(values["spatial.h3_index"]);
  if (explicit) {
    // Strip 0x prefix (vessel-agent uses "0x8a21104523fffff"); lowercase;
    // zero-pad to 16 chars (uint64 width).
    const stripped = explicit.toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,16}$/.test(stripped)) return { h3Index: "0000000000000000" };
    return { h3Index: stripped.padStart(16, "0") };
  }
  // Fall back to computing on the fly from lat/lon
  if (lat !== 0 || lon !== 0) {
    try { return { h3Index: h3.latLngToCell(lat, lon) }; }
    catch { return { h3Index: "0000000000000000" }; }
  }
  return { h3Index: "0000000000000000" };
}

function extractCrewReport(values) {
  const tx = pickString(values["crew_report.transcript"]);
  if (!tx) return null;
  return {
    transcript: tx,
    confidence: toFiniteNumber(values["crew_report.confidence"]) ?? 0,
  };
}

function extractFleetReport(values) {
  const src = pickString(values["fleet_report.source_vessel"])
           || pickString(values["fleet_report.sourceVessel"]);
  if (!src) return null;
  return { sourceVessel: src };
}

function extractMeta(values) {
  return {
    trajectoryProgress:
      toFiniteNumber(values["meta.trajectoryProgress"]) ?? 0,
    currentWaypoint:
      pickString(values["meta.currentWaypoint"]) || "",
  };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function pickTimestamp(u, values) {
  // vessel-agent prefers timestamp_ns; fall back to ISO; fall back to now.
  if (typeof u.timestamp === "string") return u.timestamp;
  if (typeof values.timestamp === "string") return values.timestamp;
  return null;
}

function pickTimestampNs(u, tsIso) {
  if (Number.isFinite(u.timestamp_ns)) {
    return BigInt(Math.trunc(u.timestamp_ns));
  }
  if (Number.isFinite(values_timestamp_ns(u))) {
    return BigInt(Math.trunc(values_timestamp_ns(u)));
  }
  // Derive from ISO (millisecond precision)
  return BigInt(Math.trunc(new Date(tsIso).getTime() * 1_000_000));
}

function values_timestamp_ns(u) {
  // helper that looks at values.timestamp_ns if present
  return isPlainObject(u.values) && Number.isFinite(u.values.timestamp_ns)
    ? u.values.timestamp_ns
    : NaN;
}

function extractVesselFromContext(ctx) {
  // Signal K contexts look like "vessels.urn:uuid:US-AK-FVCATCHER-01"
  // vessel-agent contexts look like "urn:uuid:US-AK-FVCATCHER-01"
  // or "vessels.<vessel-uuid>"
  //
  // We deliberately do NOT match the literal "self" — that's Signal K's
  // way of saying "the local vessel" and the adapter's default "anonymous"
  // is the right outcome for that case.
  if (typeof ctx !== "string") return null;
  // Prefer the urn:uuid: form when present.
  const urn = ctx.match(/(urn:uuid:[A-Za-z0-9_-]+)/);
  if (urn) return urn[1];
  // Otherwise accept a non-"self" vessel identifier.
  const id = ctx.match(/(?:vessels?\.)?([A-Za-z0-9_-]+)/);
  if (id && id[1] !== "self") return id[1];
  return null;
}

function pickString(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalize,
  normalizeOrThrow,
};