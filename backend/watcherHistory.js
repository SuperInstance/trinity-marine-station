/**
 * backend/watcherHistory.js
 * ----------------------------------------------------------------------------
 * WatcherHistory — per-rule suppression state for the WatcherRegistry.
 *
 * Why this exists
 * ---------------
 * Watchers fire on every frame that matches their `when()` predicate. In a
 * steady-state alert condition (e.g. depth staying under 1.5 m for an hour)
 * the same rule would re-fire every 500 ms tick — generating 7,200 identical
 * A2A actions and flooding the bridge, log, and frontend. The crew only needs
 * ONE alert, not one per tick.
 *
 * WatcherHistory is the layer that decides "should this rule fire *now*, or
 * did it fire recently enough that we'd be repeating ourselves?". It is
 * deliberately decoupled from the WatcherRegistry: the registry is a pure
 * function over the latest frame, while history is a stateful accumulator.
 * Splitting them keeps the registry easy to test (no time mocking) and lets
 * us swap history strategies later (token bucket, sliding window, LLM-driven
 * debounce) without touching the registry.
 *
 * Design: per-rule cooldown window
 * --------------------------------
 * For each ruleId we track:
 *   - lastFiredAt:    epoch ms of the most recent recorded fire
 *   - lastPayloadKey: a short string hash of the most recent action payload
 *                     (used for payload-deduplication; see below)
 *   - lastPriority:   the priority of the most recent fire (informational;
 *                     useful for "raise a higher-priority alert even during
 *                     cooldown" — future work)
 *   - fireCount:      how many times this rule has fired
 *   - suppressCount:  how many times this rule was suppressed
 *
 * Three suppression modes (per call):
 *   1. TIME:    if (now - lastFiredAt) < cooldownMs, suppress.
 *   2. PAYLOAD: if payloadKey === lastPayloadKey, suppress even past cooldown
 *               (so a stuck sensor that re-emits the exact same value every
 *                tick doesn't keep alerting). Default: ON, key = JSON.stringify.
 *   3. PRIORITY: caller can supply a `forcePriority` threshold; if the new
 *                action's priority exceeds it, bypass cooldown. (Default:
 *                no bypass — the operator chooses whether to add an explicit
 *                "panic" rule for that.)
 *
 * Pure where possible
 * -------------------
 * `shouldFire()` is a pure function of (now, cooldownMs, payloadKey) plus
 * the rule's stored state. `record()` is the only state mutator. `now` is
 * supplied by the caller (the registry's evaluate loop) so the module stays
 * deterministic and testable.
 *
 * Events
 * ------
 * The history is itself an EventEmitter. It emits:
 *   - 'suppressed' (ruleId, reason)   — emitted when shouldFire() returns false
 *                                       and a record() was NOT called.
 *   - 'recorded'   (ruleId, at)       — emitted when record() updates state.
 *   - 'reset'      (ruleId)           — emitted when reset() or clear() mutates.
 * These are not consumed by the registry today (the registry reads the
 * shouldFire() return value directly) but they make the history observable
 * for /status snapshots and operator dashboards.
 *
 * Audience: future agent builders tuning watcher behaviour.
 * - One WatcherHistory instance per WatcherRegistry.
 * - Pass into the registry at construction: `new WatcherRegistry({ history })`.
 * - Rules declare their own `cooldownMs` (default 0 = no suppression).
 * - The registry's `evaluate()` consults history BEFORE the action emits.
 * - Use `getStats()` to surface suppression rates in /status.
 *
 * Usage:
 *   const hist = new WatcherHistory();
 *   const reg  = new WatcherRegistry({ history: hist });
 *   reg.add({
 *     id: "shallow-water",
 *     name: "Shallow water",
 *     cooldownMs: 30000,             // suppress duplicates for 30s
 *     when: (f) => f.depth > 0 && f.depth < 2.0,
 *     action: { name: "raise_alert" },
 *   });
 * ---------------------------------------------------------------------------
 */

"use strict";

const EventEmitter = require("events");

/**
 * Default suppression window. Zero means "no cooldown" — the rule fires
 * every time it matches. The Trinity daemon's default watcher rules
 * override this to 30 s (shallow-water) and 60 s (heading-off-course).
 */
const DEFAULT_COOLDOWN_MS = 0;

/**
 * Produce a short string key for a payload object. Used to dedup identical
 * payloads across consecutive frames (a stuck sensor re-emitting the same
 * value should not produce a new alert every tick). We don't use a real
 * hash because payloads are small and we want the key to be human-readable
 * in logs.
 */
function payloadKey(payload) {
  if (payload == null) return "";
  // Sort keys so {a:1, b:2} and {b:2, a:1} hash the same. JSON.stringify
  // with a replacer would be cleaner but slower; Object.keys + sort + join
  // is plenty for our small payloads.
  if (typeof payload !== "object") return String(payload);
  const keys = Object.keys(payload).sort();
  const parts = keys.map((k) => `${k}=${JSON.stringify(payload[k])}`);
  return parts.join("&");
}

class WatcherHistory extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.verbose=false]
   *   Log every suppression and record to stderr when true. Use console.error
   *   to stay on the lint allow-list (the lint forbids console.log in
   *   non-CLI modules; console.error is permitted everywhere).
   * @param {boolean} [opts.dedupPayloads=true]
   *   When true, identical payloads within the same rule are suppressed
   *   even past the cooldown window. Disable for rules whose payload
   *   legitimately changes every frame.
   */
  constructor(opts = {}) {
    super();
    this.verbose = Boolean(opts.verbose);
    this.dedupPayloads = opts.dedupPayloads !== false;  // default ON
    /** @type {Map<string, { lastFiredAt: number, lastPayloadKey: string, lastPriority: number, fireCount: number, suppressCount: number }>} */
    this._state = new Map();
    /** Total suppressions across all rules — diagnostic aggregate. */
    this._totalSuppressed = 0;
    /** Total records across all rules — diagnostic aggregate. */
    this._totalRecorded = 0;
  }

  /**
   * Decide whether a rule should fire RIGHT NOW.
   *
   * Returns { ok, reason } where:
   *   ok = true   means "fire, then call record() to update state"
   *   ok = false  means "suppress; do not call record()"
   *
   * reason is one of: "no-prior-fire" | "cooldown-elapsed" | "cooldown-active"
   *                  | "payload-dedup". For tests and operator logs.
   *
   * @param {string}  ruleId
   * @param {number}  now              epoch ms (supplied by caller for testability)
   * @param {number}  cooldownMs       0 = no cooldown
   * @param {Object}  [payload]        the action payload that *would* fire
   * @returns {{ ok: boolean, reason: string }}
   */
  shouldFire(ruleId, now, cooldownMs, payload) {
    if (typeof ruleId !== "string" || ruleId.length === 0) {
      throw new TypeError("WatcherHistory.shouldFire: ruleId must be a non-empty string");
    }
    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw new TypeError("WatcherHistory.shouldFire: now must be a finite number");
    }
    if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new TypeError("WatcherHistory.shouldFire: cooldownMs must be a finite, non-negative number");
    }
    const st = this._state.get(ruleId);
    if (!st) {
      // First time we've seen this rule — let it through.
      return { ok: true, reason: "no-prior-fire" };
    }
    // Time-based suppression.
    if (cooldownMs > 0 && (now - st.lastFiredAt) < cooldownMs) {
      return { ok: false, reason: "cooldown-active" };
    }
    // Payload-based dedup (optional).
    if (this.dedupPayloads) {
      const k = payloadKey(payload);
      if (k !== "" && k === st.lastPayloadKey) {
        return { ok: false, reason: "payload-dedup" };
      }
    }
    return { ok: true, reason: cooldownMs > 0 ? "cooldown-elapsed" : "no-prior-fire" };
  }

  /**
   * Record a successful fire. Updates lastFiredAt, lastPayloadKey, lastPriority,
   * and increments fireCount + totalRecorded. Call this ONLY after the
   * registry has decided to actually emit the action.
   *
   * @param {string} ruleId
   * @param {number} now
   * @param {Object} [payload]
   * @param {number} [priority]
   */
  record(ruleId, now, payload, priority) {
    if (typeof ruleId !== "string" || ruleId.length === 0) {
      throw new TypeError("WatcherHistory.record: ruleId must be a non-empty string");
    }
    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw new TypeError("WatcherHistory.record: now must be a finite number");
    }
    const st = this._state.get(ruleId) ?? {
      lastFiredAt: 0, lastPayloadKey: "", lastPriority: 0,
      fireCount: 0, suppressCount: 0,
    };
    st.lastFiredAt = now;
    st.lastPayloadKey = this.dedupPayloads ? payloadKey(payload) : "";
    st.lastPriority = typeof priority === "number" && Number.isFinite(priority)
      ? priority : 0;
    st.fireCount += 1;
    this._state.set(ruleId, st);
    this._totalRecorded += 1;
    this.emit("recorded", ruleId, now);
    if (this.verbose) {
      console.error(`[history] ${ruleId} recorded at ${now} (fires=${st.fireCount})`);
    }
  }

  /**
   * Mark a suppression. Called by the registry when shouldFire returned false.
   * Increments per-rule suppressCount and the global total.
   *
   * @param {string} ruleId
   * @param {string} reason
   */
  markSuppressed(ruleId, reason) {
    const st = this._state.get(ruleId) ?? {
      lastFiredAt: 0, lastPayloadKey: "", lastPriority: 0,
      fireCount: 0, suppressCount: 0,
    };
    st.suppressCount += 1;
    this._state.set(ruleId, st);
    this._totalSuppressed += 1;
    this.emit("suppressed", ruleId, reason);
    if (this.verbose) {
      console.error(`[history] ${ruleId} suppressed (${reason}) — total ${st.suppressCount}`);
    }
  }

  /**
   * Look up state for one rule. Returns undefined if no state yet.
   * @param {string} ruleId
   */
  get(ruleId) {
    const st = this._state.get(ruleId);
    if (!st) return undefined;
    return { ...st };
  }

  /**
   * Per-rule + aggregate stats, suitable for /status snapshots.
   * @returns {{ tracksActive: number, totalFires: number, totalSuppressed: number, rules: object[] }}
   */
  getStats() {
    const rules = [];
    for (const [id, st] of this._state.entries()) {
      rules.push({
        ruleId: id,
        lastFiredAt: st.lastFiredAt,
        lastPriority: st.lastPriority,
        fireCount: st.fireCount,
        suppressCount: st.suppressCount,
      });
    }
    return {
      tracksActive: this._state.size,
      totalFires: this._totalRecorded,
      totalSuppressed: this._totalSuppressed,
      rules,
    };
  }

  /**
   * Reset one rule. Clears its state.
   * @param {string} ruleId
   */
  reset(ruleId) {
    this._state.delete(ruleId);
    this.emit("reset", ruleId);
  }

  /**
   * Clear all state.
   */
  clear() {
    this._state.clear();
    this._totalSuppressed = 0;
    this._totalRecorded = 0;
    this.emit("reset", null);
  }
}

module.exports = {
  WatcherHistory,
  DEFAULT_COOLDOWN_MS,
  payloadKey,  // exported for tests
};
