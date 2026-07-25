/**
 * shared/events.js
 * ----------------------------------------------------------------------------
 * The single source of truth for every event name emitted in the Trinity
 * Marine Station.
 *
 * The frontend (Eclipse Theia extension, Svelte/React panel, anything) can
 * `require('shared/events')` and import the constants instead of guessing
 * the string `'a2a'` or `'anomaly'`. This prevents silent breakage when
 * an event name is renamed in one module but not the others.
 *
 * Each event is documented with:
 *   - name           the constant
 *   - description    what triggers it
 *   - payloadShape   the canonical argument list (best-effort)
 *
 * Convention:
 *   - Past-tense verbs for state notifications: "tick", "anomaly", "frame"
 *   - Imperative verbs for outputs: "prose", "a2a"
 *   - Every event has a `timestamp` field added by the bridge if it doesn't
 *     already carry one (consumer side can ignore this).
 * ----------------------------------------------------------------------------
 */

const EVENTS = Object.freeze({
  // ------------------------------------------------------------------
  // TelemetryIngest
  // ------------------------------------------------------------------
  INGEST_OPEN:           "ingest:open",          // ()           WebSocket opened
  INGEST_HELLO:          "ingest:hello",         // (helloPayload)   Signalk handshake
  INGEST_FRAME:          "ingest:frame",         // (vec: Float64Array, ts: string)
  INGEST_PARSE_ERROR:    "ingest:parse-error",   // (err: Error)
  INGEST_MALFORMED:      "ingest:malformed",     // (update)
  INGEST_RECONNECTING:   "ingest:reconnecting",  // ({attempt, delayMs})
  INGEST_CLOSE:          "ingest:close",         // ({code, reason})
  INGEST_ERROR:          "ingest:error",         // (err)

  // ------------------------------------------------------------------
  // JepaWorldModel
  // ------------------------------------------------------------------
  JEPA_ENERGY:           "jepa:energy",          // (JepaEnergyReading)
  JEPA_ANOMALY:          "jepa:anomaly",         // (JepaEnergyReading)

  // ------------------------------------------------------------------
  // LlmNarrator
  // ------------------------------------------------------------------
  NARRATOR_PROSE:        "narrator:prose",       // (text: string)
  NARRATOR_A2A:          "narrator:a2a",         // (A2AAction)
  NARRATOR_MALFORMED:    "narrator:malformed",   // ({raw, error})
  NARRATOR_GEN_START:    "narrator:generation-start",  // ({reason, prompt})
  NARRATOR_GEN_END:      "narrator:generation-end",    // ({reason, aborted})
  NARRATOR_ERROR:        "narrator:error",       // (err)
  NARRATOR_DEGRADED:     "narrator:degraded",    // ({reason, retryInMs})  circuit open

  // ------------------------------------------------------------------
  // TrinityCore
  // ------------------------------------------------------------------
  CORE_TICK:             "core:tick",            // ({frame, energy})
  CORE_PEACEFUL:         "core:peaceful",        // ({energy})
  CORE_ANOMALY:          "core:anomaly",         // ({energy})
  CORE_STOPPED:          "core:stopped",         // ()

  // ------------------------------------------------------------------
  // Daemon
  // ------------------------------------------------------------------
  DAEMON_LIFECYCLE:      "daemon:lifecycle",     // ({event, ...})  boot/ready/shutdown
  DAEMON_A2A:            "daemon:a2a",           // (A2AAction)   re-emitted post-validation
});

/**
 * Helper: a list of all event names. Useful for documentation generation
 * or for tests that want to verify no listener is dangling.
 */
const ALL_EVENTS = Object.freeze(Object.values(EVENTS));

module.exports = { EVENTS, ALL_EVENTS };
