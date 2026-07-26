/**
 * tools/regenSchema.js
 * ----------------------------------------------------------------------------
 * Regenerates `docs/a2a/SCHEMA.json` from the authoritative source:
 * `backend/schemas.js` (specifically the A2A_ALLOWED_ACTIONS set).
 *
 * Why this exists
 * ---------------
 * The bridge enforces an allow-list of A2A action names. Documentation that
 * lists action names must mirror that list exactly, otherwise:
 *   - Example sessions in EXAMPLES.jsonl use actions that get silently
 *     dropped by the bridge (the validation fails, no log record, the
 *     example looks broken when reproduced verbatim).
 *   - New contributors copy invalid names from docs into their code.
 *
 * Single-source-of-truth rule
 * ---------------------------
 * Code is authoritative. Docs are generated. If you want to add an action,
 * edit `backend/schemas.js`. If you want to change the schema's *shape*
 * (e.g. add a new field to the `a2a_action` definition), edit this tool.
 *
 * Usage
 * -----
 *   node tools/regenSchema.js           # rewrites docs/a2a/SCHEMA.json in place
 *   node tools/regenSchema.js --check   # exit 1 if SCHEMA.json is out of date
 *
 * Side effects
 * ------------
 * Only writes `docs/a2a/SCHEMA.json`. Never mutates code.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEMAS_PATH = path.join(REPO_ROOT, "backend", "schemas.js");
const OUTPUT_PATH  = path.join(REPO_ROOT, "docs", "a2a", "SCHEMA.json");

function loadAllowedActions() {
  // We require schemas.js to read the authoritative allow-list. This module is
  // pure (no IO, no side effects on require), so importing it is safe.
  const schemas = require(SCHEMAS_PATH);
  const set = schemas.A2A_ALLOWED_ACTIONS;
  if (!(set instanceof Set)) {
    throw new Error("schemas.js did not export A2A_ALLOWED_ACTIONS as a Set");
  }
  // Sort for stable JSON output.
  return Array.from(set).sort();
}

function buildSchema(allowedActions) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/SuperInstance/trinity-marine-station/blob/main/docs/a2a/SCHEMA.json",
    title: "Trinity A2A Bridge Wire Protocol",
    description:
      "Formal JSON Schema for the text-JSON envelopes carried over the " +
      "WebSocket A2A bridge (default port 3002). All frames are flat JSON " +
      "objects with a required `type` discriminator. The `action.action` " +
      "enum is generated from `backend/schemas.js:A2A_ALLOWED_ACTIONS` — " +
      "do not edit it here. See `docs/a2a/QUICKREF.md` for prose and " +
      "`docs/a2a/EXAMPLES.jsonl` for canonical exchanges.",
    version: "1.0.0",
    type: "object",
    oneOf: [
      { $ref: "#/$defs/bridge_to_client" },
      { $ref: "#/$defs/client_to_bridge" },
    ],
    $defs: {
      iso8601: {
        type: "string",
        pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$",
      },
      non_negative_integer: { type: "integer", minimum: 0 },
      positive_integer:     { type: "integer", minimum: 1 },
      a2a_action: {
        type: "object",
        description:
          "A validated workspace mutation. The `action` field is restricted " +
          "to the allow-list in `backend/schemas.js:A2A_ALLOWED_ACTIONS`.",
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: allowedActions,
            description:
              "Allowed action name. Enforced by the server via " +
              "`validateA2AAction()` in `backend/schemas.js`.",
          },
          payload: {
            type: "object",
            additionalProperties: true,
            description:
              "Optional action-specific payload. JSON object with arbitrary keys.",
          },
          priority: {
            type: "number", minimum: 0, maximum: 1, default: 0.5,
            description:
              "Override strength. 1 = forced (override user); 0.5 = default.",
          },
          reason: {
            type: "string",
            description:
              "Short human-readable justification (e.g. 'depth plunge to 1.2 m').",
          },
        },
        additionalProperties: false,
      },
      bridge_to_client: {
        type: "object",
        title: "Bridge \u2192 Client envelopes",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["hello", "action", "replay_end", "ack_ok", "pong", "error"] },
        },
        oneOf: [
          {
            type: "object",
            required: ["type", "last_action_id"],
            properties: {
              type: { const: "hello" },
              last_action_id: { $ref: "#/$defs/non_negative_integer" },
              ts: { $ref: "#/$defs/iso8601" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "id", "action"],
            properties: {
              type: { const: "action" },
              id: { $ref: "#/$defs/positive_integer" },
              action: { $ref: "#/$defs/a2a_action" },
              ts: { $ref: "#/$defs/iso8601" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "replayed"],
            properties: {
              type: { const: "replay_end" },
              replayed: { $ref: "#/$defs/non_negative_integer" },
              reason: { type: "string" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "action_id"],
            properties: {
              type: { const: "ack_ok" },
              action_id: { $ref: "#/$defs/positive_integer" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "ts"],
            properties: {
              type: { const: "pong" },
              ts: { $ref: "#/$defs/iso8601" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "code", "errors"],
            properties: {
              type: { const: "error" },
              code: {
                type: "string",
                enum: ["BAD_JSON", "BAD_TYPE", "BAD_FIELD", "BAD_ACTION", "BAD_ID", "BRIDGE_STOPPED", "REPLAY_NO_LOG", "INTERNAL"],
              },
              errors: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
      },
      client_to_bridge: {
        type: "object",
        title: "Client \u2192 Bridge envelopes",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["ping", "ack", "replay"] },
        },
        oneOf: [
          {
            type: "object",
            required: ["type"],
            properties: { type: { const: "ping" } },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "action_id"],
            properties: {
              type: { const: "ack" },
              action_id: { $ref: "#/$defs/non_negative_integer" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["type", "since_id"],
            properties: {
              type: { const: "replay" },
              since_id: { $ref: "#/$defs/non_negative_integer" },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    examples: [
      {
        comment:
          "Bridge \u2192 Client: hello on first connect. Tells client the server's " +
          "last known action id so client can decide whether to replay.",
        valid: true,
        value: { type: "hello", last_action_id: 42, ts: "2026-07-26T16:30:00.000Z" },
      },
      {
        comment: "Bridge \u2192 Client: a validated workspace mutation.",
        valid: true,
        value: {
          type: "action",
          id: 43,
          action: {
            action: "morph_to_hazard_mode",
            priority: 0.98,
            payload: { reason: "depth plunge" },
            reason: "depth plunge to 1.2 m",
          },
          ts: "2026-07-26T16:30:01.000Z",
        },
      },
      {
        comment: "Bridge \u2192 Client: end of replay gap-fill.",
        valid: true,
        value: { type: "replay_end", replayed: 5 },
      },
      {
        comment: "Bridge \u2192 Client: ack was persisted.",
        valid: true,
        value: { type: "ack_ok", action_id: 43 },
      },
      {
        comment: "Bridge \u2192 Client: heartbeat response.",
        valid: true,
        value: { type: "pong", ts: "2026-07-26T16:30:15.000Z" },
      },
      {
        comment: "Bridge \u2192 Client: protocol violation by the client.",
        valid: true,
        value: { type: "error", code: "BAD_JSON", errors: ["SyntaxError: Unexpected token"] },
      },
      {
        comment: "Client \u2192 Bridge: heartbeat probe.",
        valid: true,
        value: { type: "ping" },
      },
      {
        comment: "Client \u2192 Bridge: idempotency checkpoint.",
        valid: true,
        value: { type: "ack", action_id: 43 },
      },
      {
        comment: "Client \u2192 Bridge: replay all actions with id > since_id.",
        valid: true,
        value: { type: "replay", since_id: 42 },
      },
    ],
  };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const allowed   = loadAllowedActions();
  const newSchema = buildSchema(allowed);
  const newJson   = JSON.stringify(newSchema, null, 2) + "\n";

  if (checkOnly) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`[regenSchema] FAIL: ${path.relative(REPO_ROOT, OUTPUT_PATH)} does not exist`);
      process.exit(1);
    }
    const current = fs.readFileSync(OUTPUT_PATH, "utf8");
    if (current !== newJson) {
      console.error(`[regenSchema] FAIL: ${path.relative(REPO_ROOT, OUTPUT_PATH)} is out of date`);
      console.error(`[regenSchema] Run: node tools/regenSchema.js`);
      process.exit(1);
    }
    console.log(`[regenSchema] OK: ${path.relative(REPO_ROOT, OUTPUT_PATH)} matches schemas.js`);
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, newJson, "utf8");
  console.log(`[regenSchema] wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} with ${allowed.length} allowed actions:`);
  for (const a of allowed) console.log(`  - ${a}`);
}

if (require.main === module) {
  try { main(); }
  catch (e) {
    console.error("[regenSchema] error:", e.message);
    process.exit(1);
  }
}

module.exports = { loadAllowedActions, buildSchema };