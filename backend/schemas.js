/**
 * backend/schemas.js
 * ----------------------------------------------------------------------------
 * Runtime schemas for the Trinity Marine Station.
 *
 * Every payload that crosses a module boundary in this system has a shape
 * defined here. Each schema is a small validator with a stable error format
 * so we can:
 *
 *   1. Validate once at module boundaries (no silent drift).
 *   2. Get a precise error message for the malformed-frame path.
 *   3. Document the wire formats in code, not just in Markdown.
 *
 * Why not JSON Schema / Ajv?
 *   - Zero new dependencies in a project that prides itself on being small.
 *   - These schemas are *narrow* — each validates one shape. The cost of
 *     a hand-written validator is ~10 lines per shape and readability is
 *     much higher than a generic JSON Schema declaration.
 *   - The validators are designed to return normalized objects, not just
 *     `true`/`false`, so callers can rely on field defaults without re-running
 *     construction everywhere.
 *
 * Anti-corrupt layer pattern:
 *   All payloads arriving from outside (Signal K delta, LLM output, cloud
 *   API response) are validated via these schemas before any downstream
 *   consumer sees them. This is the seam at which the system rejects bad
 *   data instead of letting it spread into the JEPA / narrator / frontend.
 * ----------------------------------------------------------------------------
 */

// ===========================================================================
// Low-level helpers
// ===========================================================================

/**
 * A schema validator: takes unknown input, returns { ok, value, errors }.
 * If ok is true, value is the normalized payload. If ok is false, errors is
 * a list of strings describing the first problem.
 *
 * @typedef {(input: any) => { ok: boolean, value?: any, errors?: string[] }} Validator
 */

/**
 * Run a list of predicate checks against a value. Returns the first failure
 * message or null. Keeps per-schema code short and readable.
 *
 * @param {any} value
 * @param {Array<[string, (v: any) => boolean]>} checks
 * @returns {string|null}
 */
function checkAll(value, checks) {
  for (const [name, fn] of checks) {
    if (!fn(value)) return `field '${name}' failed validation`;
  }
  return null;
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function isString(x) {
  return typeof x === "string";
}

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// ===========================================================================
// 1. FeatureVector — the 6-dim Float64Array packed by the ingest pipeline.
// ----------------------------------------------------------------------------
// One important contract: we pass Float64Array through unchanged, but we
// also accept plain arrays (for callers that don't ship typed arrays).
// ===========================================================================

const FEATURE_VECTOR_INDEX = Object.freeze({
  LATITUDE:            0,
  LONGITUDE:           1,
  SPEED_OVER_GROUND:   2,
  HEADING_TRUE:        3,
  DEPTH:               4,
  TRAJECTORY_PROGRESS: 5,
  VECTOR_DIM:          6,
});

/**
 * Validate and normalize a feature vector. Returns a Float64Array of length
 * VECTOR_DIM. On failure, returns { ok: false, errors }.
 *
 * @param {any} input
 * @returns {{ ok: true, value: Float64Array } | { ok: false, errors: string[] }}
 */
function validateFeatureVector(input) {
  if (input == null) {
    return { ok: false, errors: ["feature vector is null/undefined"] };
  }
  const len = (input.length !== undefined) ? input.length : -1;
  if (len !== FEATURE_VECTOR_INDEX.VECTOR_DIM) {
    return { ok: false, errors: [`feature vector length ${len} != ${FEATURE_VECTOR_INDEX.VECTOR_DIM}`] };
  }
  // Validate every element is a finite number.
  for (let i = 0; i < FEATURE_VECTOR_INDEX.VECTOR_DIM; i++) {
    if (!isFiniteNumber(input[i])) {
      return { ok: false, errors: [`feature vector[${i}] is not a finite number (got ${input[i]})`] };
    }
  }
  // Domain sanity: lat ∈ [-90, 90], lon ∈ [-180, 180], depth should be ≥ 0,
  // trajectory progress ∈ [0, 1]. We don't *fail* on out-of-range (the
  // simulator may push past shoreline on purpose) but we *report* it.
  const warnings = [];
  if (input[0] < -90 || input[0] > 90)   warnings.push(`latitude ${input[0]} outside [-90, 90]`);
  if (input[1] < -180 || input[1] > 180) warnings.push(`longitude ${input[1]} outside [-180, 180]`);
  if (input[4] < 0)                      warnings.push(`depth ${input[4]} is negative`);
  if (input[5] < 0 || input[5] > 1)      warnings.push(`trajectory progress ${input[5]} outside [0, 1]`);

  // Copy through a fresh Float64Array so the caller can mutate without
  // touching the source typed array.
  const out = new Float64Array(FEATURE_VECTOR_INDEX.VECTOR_DIM);
  for (let i = 0; i < FEATURE_VECTOR_INDEX.VECTOR_DIM; i++) out[i] = input[i];
  return { ok: true, value: out, warnings: warnings.length ? warnings : undefined };
}

// ===========================================================================
// 2. SignalKDelta — the message type arriving over the WebSocket stream.
// ----------------------------------------------------------------------------
// Loose schema: we accept any message that has at least one update with
// the fields we care about. Update values is the unpackDeltaInto() concern.
// ===========================================================================

/**
 * Lightly validate a Signal K delta message. Returns true if it has the
 * shape we can extract feature vectors from. Defensive only — the unpacker
 * does the deep work.
 *
 * @param {any} msg
 * @returns {boolean}
 */
function isPlausibleSignalKDelta(msg) {
  return isPlainObject(msg) && Array.isArray(msg.updates) && msg.updates.length > 0;
}

// ===========================================================================
// 3. JepaEnergyReading — the JEPA's output. Internal type but exposed via
// events; pinning the shape lets the frontend render it without guessing.
// ===========================================================================

/**
 * @typedef {object} JepaEnergyReading
 * @property {number}  score      0..1, higher = more anomalous
 * @property {boolean} anomaly    score > threshold
 * @property {string}  reason     human-readable label ("depth plunge", "steady", ...)
 * @property {number}  timestamp  epoch ms
 */

/**
 * Normalize a JEPA reading, filling any missing fields with safe defaults.
 * @param {any} r
 * @returns {JepaEnergyReading | null} null if input is unrecognizable
 */
function normalizeEnergyReading(r) {
  if (!isPlainObject(r)) return null;
  return {
    score:     isFiniteNumber(r.score) ? r.score : 0,
    anomaly:   r.anomaly === true,
    reason:    isString(r.reason) ? r.reason : "unknown",
    timestamp: isFiniteNumber(r.timestamp) ? r.timestamp : Date.now(),
  };
}

// ===========================================================================
// 4. A2AAction — the schema for `<a2a>{...}</a2a>` JSON.
// ----------------------------------------------------------------------------
// This is the contract with the Theia frontend. Every action emission must
// pass through here so the format cannot drift silently between the narrator
// and the frontend.
// ===========================================================================

/** The allow-list of action names. Mirrors llmNarrator.ALLOWED_ACTIONS. */
const A2A_ALLOWED_ACTIONS = Object.freeze(new Set([
  "morph_to_hazard_mode",
  "morph_to_navigation_mode",
  "morph_to_engineering_mode",
  "highlight_waypoint",
  "raise_alert",
  "clear_alerts",
  "set_panel_focus",
  "announce",
]));

/**
 * Validate and normalize an A2A action.
 * @param {any} input
 * @returns {{ ok: true, value: NormalisedA2AAction } | { ok: false, errors: string[] }}
 */
function validateA2AAction(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["a2a payload is not an object"] };
  }
  if (!isString(input.action) || input.action.length === 0) {
    return { ok: false, errors: ["a2a.action must be a non-empty string"] };
  }
  if (!A2A_ALLOWED_ACTIONS.has(input.action)) {
    return { ok: false, errors: [`a2a.action '${input.action}' is not in the allow-list`] };
  }
  // payload is optional; default to empty object
  const payload = isPlainObject(input.payload) ? input.payload : {};
  // reason is optional; default to empty string
  const reason  = isString(input.reason) ? input.reason : "";
  // priority is optional; default to 0.5, clamped to [0, 1]
  let priority = 0.5;
  if (isFiniteNumber(input.priority)) {
    priority = Math.max(0, Math.min(1, input.priority));
  }
  return {
    ok: true,
    value: Object.freeze({
      action: input.action,
      payload: Object.freeze({ ...payload }),
      reason,
      priority,
    }),
  };
}

/**
 * Convenience: parse a JSON string and validate the result.
 * @param {string} raw
 * @returns {{ ok: true, value: NormalisedA2AAction } | { ok: false, errors: string[] }}
 */
function parseAndValidateA2A(raw) {
  if (!isString(raw)) {
    return { ok: false, errors: ["a2a raw is not a string"] };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, errors: ["a2a raw is empty"] };
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (e) {
    return { ok: false, errors: [`a2a JSON parse failed: ${e.message}`] };
  }
  return validateA2AAction(parsed);
}

/**
 * Client-to-bridge message validator.
 *
 * The bridge accepts a small, strict set of request types from subscribed
 * frontend clients (Eclipse Theia panels, web dashboards, etc.). Anything
 * else is rejected with `{ ok: false, errors: [...] }` so the client knows
 * to retry / fix its code instead of silently dropping.
 *
 * Supported message types:
 *   - { type: "ping" }              health check
 *   - { type: "ack", action_id: N } mark action N as received
 *   - { type: "replay", since_id: N } re-send all actions with id > N
 *
 * Returns the normalised { type, ... } payload on success. Each message
 * type is validated independently so the caller can dispatch safely.
 */
function parseA2AClientMessage(raw) {
  if (typeof raw !== "string" && !(raw instanceof Buffer)) {
    return { ok: false, errors: ["client message is not a string or Buffer"] };
  }
  const text = String(raw).trim();
  if (text.length === 0) {
    return { ok: false, errors: ["client message is empty"] };
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    return { ok: false, errors: [`client message JSON parse failed: ${e.message}`] };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["client message is not an object"] };
  }
  if (!isString(parsed.type) || parsed.type.length === 0) {
    return { ok: false, errors: ["client message missing 'type' field"] };
  }

  switch (parsed.type) {
    case "ping":
      return { ok: true, value: { type: "ping" } };

    case "ack": {
      // action_id is required and must be a non-negative integer
      if (!Number.isInteger(parsed.action_id) || parsed.action_id < 0) {
        return { ok: false, errors: ["ack.action_id must be a non-negative integer"] };
      }
      return { ok: true, value: { type: "ack", action_id: parsed.action_id } };
    }

    case "replay": {
      // since_id is optional; if present, must be a non-negative integer
      const sinceId = parsed.since_id === undefined ? 0 : parsed.since_id;
      if (!Number.isInteger(sinceId) || sinceId < 0) {
        return { ok: false, errors: ["replay.since_id must be a non-negative integer"] };
      }
      return { ok: true, value: { type: "replay", since_id: sinceId } };
    }

    default:
      return { ok: false, errors: [`unknown client message type '${parsed.type}'`] };
  }
}

// ===========================================================================
// 5. LlmChunk — output of every LlmBackend.generate() iteration.
// ----------------------------------------------------------------------------
// Pinning this shape lets the narrator code assume the kind field exists.
// ===========================================================================

/**
 * @typedef {object} LlmChunk
 * @property {string}  text          The token text (may be empty for done-only chunks)
 * @property {boolean} [done]        True on the final chunk
 * @property {string}  [kind]        "response" | "thinking" — reasoning models use this
 * @property {string}  [finishReason]
 */

/**
 * Construct a normalized LlmChunk. Useful for backends and tests.
 * @param {string} text
 * @param {object} [extra]
 * @returns {LlmChunk}
 */
function makeLlmChunk(text, extra = {}) {
  return {
    text: isString(text) ? text : "",
    done: extra.done === true,
    kind: isString(extra.kind) ? extra.kind : "response",
    ...(extra.finishReason ? { finishReason: extra.finishReason } : {}),
  };
}

// ===========================================================================
// 6. TrinityFrame — canonical internal shape produced by vesselAgentAdapter.
// ----------------------------------------------------------------------------
// Every module downstream of the WebSocket consumes this shape. Adding a
// new field here is a one-line edit; everything else stays untouched.
// ===========================================================================

/**
 * @typedef {object} TrinityFrame
 * @property {bigint} timestampNs                  Nanosecond-anchored timestamp
 * @property {string} timestamp                    ISO-8601 mirror (human-readable)
 * @property {object} source                       Provenance triple
 * @property {string} source.vesselUuid
 * @property {string} source.hardwareSource
 * @property {string} source.pipelineVersion
 * @property {object} navigation                   Position + motion
 * @property {number} navigation.latitude           degrees, [-90, 90]
 * @property {number} navigation.longitude          degrees, [-180, 180]
 * @property {number} navigation.speedOverGround    knots
 * @property {number} navigation.headingTrue        degrees, [0, 360)
 * @property {object} environment
 * @property {number} environment.depthBelowTransducer  meters
 * @property {object} spatial
 * @property {string} spatial.h3Index               16-char hex
 * @property {number} [trajectoryProgress]          0..1 (optional ground-truth label)
 * @property {string} [currentWaypoint]             optional waypoint name
 * @property {object} [crewReport]
 * @property {string} crewReport.transcript
 * @property {number} crewReport.confidence         0..1
 * @property {object} [fleetReport]
 * @property {string} fleetReport.sourceVessel
 */

/**
 * Validate a TrinityFrame. Returns { ok: true, value } on success.
 * The validator is defensive: it does NOT mutate the input.
 *
 * @param {any} f
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
function validateTrinityFrame(f) {
  const errors = [];
  if (!isPlainObject(f))                  errors.push("frame is not an object");
  if (typeof f?.timestampNs !== "bigint") errors.push("timestampNs must be BigInt");
  if (!isString(f?.timestamp))            errors.push("timestamp must be ISO string");
  if (!isPlainObject(f?.source))          errors.push("source must be an object");
  else {
    if (!isString(f.source.vesselUuid))      errors.push("source.vesselUuid must be string");
    if (!isString(f.source.hardwareSource))  errors.push("source.hardwareSource must be string");
    if (!isString(f.source.pipelineVersion)) errors.push("source.pipelineVersion must be string");
  }
  if (!isPlainObject(f?.navigation))      errors.push("navigation must be an object");
  else {
    if (!isFiniteNumber(f.navigation.latitude))         errors.push("navigation.latitude not finite");
    if (!isFiniteNumber(f.navigation.longitude))        errors.push("navigation.longitude not finite");
    if (!isFiniteNumber(f.navigation.speedOverGround))  errors.push("navigation.speedOverGround not finite");
    if (!isFiniteNumber(f.navigation.headingTrue))      errors.push("navigation.headingTrue not finite");
  }
  if (!isPlainObject(f?.environment))     errors.push("environment must be an object");
  else if (!isFiniteNumber(f.environment.depthBelowTransducer))
    errors.push("environment.depthBelowTransducer not finite");
  if (!isPlainObject(f?.spatial))         errors.push("spatial must be an object");
  else if (!isString(f.spatial.h3Index))  errors.push("spatial.h3Index must be hex string");
  // crewReport / fleetReport are optional
  if (f?.crewReport !== undefined) {
    if (!isPlainObject(f.crewReport))               errors.push("crewReport must be object");
    else if (!isString(f.crewReport.transcript))     errors.push("crewReport.transcript must be string");
  }
  if (f?.fleetReport !== undefined) {
    if (!isPlainObject(f.fleetReport))              errors.push("fleetReport must be object");
    else if (!isString(f.fleetReport.sourceVessel)) errors.push("fleetReport.sourceVessel must be string");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: f };
}

// ===========================================================================
// 7. VesselAnchor — the upstream vessel-agent "core_anchor" schema.
// ----------------------------------------------------------------------------
// We don't generate this shape ourselves; we *accept* it on the WebSocket
// and immediately normalize to TrinityFrame via vesselAgentAdapter. This
// validator exists so we can reject malformed upstream messages early.
// ===========================================================================

/**
 * Lightly validate that an incoming message looks like a vessel-agent
 * core_anchor update envelope. NOT exhaustive — deep field checks happen
 * inside the adapter.
 *
 * @param {any} msg
 * @returns {boolean}
 */
function isPlausibleVesselAnchor(msg) {
  if (!isPlainObject(msg)) return false;
  if (!Array.isArray(msg.updates) || msg.updates.length === 0) return false;
  const u = msg.updates[0];
  if (!isPlainObject(u)) return false;
  // Must carry either a timestamp (ISO) or a timestamp_ns (nanoseconds).
  const hasTs    = isString(u.timestamp);
  const hasTsNs  = isFiniteNumber(u.timestamp_ns);
  const hasValues = isPlainObject(u.values);
  return (hasTs || hasTsNs) && hasValues;
}

// ===========================================================================
// Module exports
// ===========================================================================

module.exports = {
  // Helpers
  isFiniteNumber,
  isString,
  isPlainObject,
  // Schemas
  FEATURE_VECTOR_INDEX,
  validateFeatureVector,
  isPlausibleSignalKDelta,
  normalizeEnergyReading,
  A2A_ALLOWED_ACTIONS,
  validateA2AAction,
  parseAndValidateA2A,
  parseA2AClientMessage,
  makeLlmChunk,
  validateTrinityFrame,
  isPlausibleVesselAnchor,
};
