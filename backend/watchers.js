/**
 * backend/watchers.js
 * ----------------------------------------------------------------------------
 * Watcher pattern — deterministic threshold rules that emit A2A actions
 * directly from incoming FeatureVector frames, WITHOUT involving the LLM.
 *
 * Origin and motivation
 * ---------------------
 * This pattern is borrowed from the AELMA (Agent-Engine Linked Marine
 * Architecture) reference document studied in
 * `docs/AELMA_SYNTHESIS.md`. AELMA calls them "Watchers": small deterministic
 * NPCs that patrol a region and fire a fixed alert when their threshold is
 * crossed, before any "smart" reasoning is consulted. In Trinity's pipeline
 * they fill the gap between (a) raw JEPA anomalies (which are statistical,
 * not semantic) and (b) full LLM narration (which is slow, expensive, and
 * sometimes hallucinates a wrong action under load).
 *
 * What a watcher does
 * -------------------
 * A watcher is a pure function over the latest FeatureVector: when
 * `when(frame) === true`, it produces a validated A2AAction which is then
 * routed through `trinityCore` via the existing `'a2a'` event so it lands in
 * the same fanout / log / replay path as narrator-issued actions.
 *
 * Why route through the core
 * --------------------------
 * Bypassing the core would split the action stream: some actions would be
 * persisted and broadcast, others wouldn't. The watcher MUST emit through
 * the same `core.emit('a2a', action)` channel so:
 *   1. The a2aLog records the action for replay.
 *   2. The a2aBridge broadcasts it to all live clients.
 *   3. The LLM is informed (it can choose to elaborate on it in prose),
 *      rather than being completely bypassed.
 * Routing through the core is what makes a watcher a *complement* to the
 * LLM, not a replacement.
 *
 * Pure-evaluation contract
 * ------------------------
 * `when(frame)` and any payload functions must be PURE. They may not:
 *   - Read from disk, network, environment, or globals.
 *   - Mutate the frame.
 *   - Make non-deterministic choices (Math.random(), Date.now()).
 * This makes watchers deterministic and replayable: the same frame always
 * produces the same set of actions, which is essential for tests and for
 * AELMA's "divination sandbox" pattern (predict, then act).
 *
 * Priority and override semantics
 * -------------------------------
 * A watcher may emit any of the 8 actions in `A2A_ALLOWED_ACTIONS`
 * (authoritative allow-list, see `backend/schemas.js`). Priority defaults
 * to 0.5 if unspecified; a watcher that wants to dominate the LLM can
 * emit priority 1.0. Multiple watchers firing on the same frame are
 * emitted in the order they were registered (deterministic).
 *
 * Validation
 * ----------
 * Every produced action is run through `validateA2AAction` before being
 * returned. Invalid actions are dropped with an error event but do NOT
 * abort the rest of the evaluation — one bad rule cannot silence the
 * others.
 *
 * Events emitted
 * --------------
 *   - 'error' (err, { ruleId, ruleName })   A rule threw or produced an
 *                                            invalid action. The error is
 *                                            attached to the offending rule
 *                                            so consumers can disable it.
 *   - 'fired' (action, { ruleId, ruleName }) Emitted for each successful
 *                                            action (in addition to the
 *                                            returned array).
 *
 * Usage:
 *   const reg = new WatcherRegistry();
 *   reg.add({
 *     id: "shallow-water",
 *     name: "Shallow water warning",
 *     when: (f) => f.depth > 0 && f.depth < 2.0,
 *     action: {
 *       name: "raise_alert",
 *       payload: (f) => ({ kind: "shallow_water", depth: f.depth }),
 *       reason: (f) => `depth=${f.depth.toFixed(2)}m`,
 *       priority: () => 0.85,
 *     },
 *   });
 *
 *   const actions = reg.evaluate(frame);
 *   for (const a of actions) core.emit("a2a", a);
 *
 *   // ---- With suppression history ----
 *   const hist = new WatcherHistory();
 *   const reg2 = new WatcherRegistry({ history: hist });
 *   reg2.add({
 *     id: "shallow-water",
 *     name: "Shallow water warning",
 *     cooldownMs: 30000,           // suppress duplicates for 30s
 *     when: (f) => f.depth > 0 && f.depth < 2.0,
 *     action: { name: "raise_alert", priority: () => 0.85 },
 *   });
 *   reg2.evaluate(frame);          // fires
 *   reg2.evaluate(frame);          // suppressed (cooldown-active)
 * --------------------------------------------------------------------------- */

"use strict";

const EventEmitter = require("events");
const { validateA2AAction } = require("./schemas");

/**
 * Default priority assigned when an action rule omits a priority function.
 * 0.5 is "middle of the road": higher than passive prose, lower than a
 * full-blown emergency. Watchers that want to dominate should override.
 */
const DEFAULT_PRIORITY = 0.5;

/**
 * Default cooldown (ms) when a rule omits one. Zero means "fire every time
 * the predicate matches" — i.e. no suppression. The daemon's default rules
 * override this (30s for shallow-water, 60s for heading-off-course, etc.).
 */
const DEFAULT_COOLDOWN_MS = 0;

/**
 * WatcherRegistry
 * ---------------
 * Holds an ordered list of watcher rules and evaluates them on demand.
 *
 * Construction:
 *   const reg = new WatcherRegistry({ verbose: false });
 *
 * API:
 *   reg.add(rule)                Register a rule. Returns the assigned id.
 *   reg.remove(id)               Remove a rule by id. Returns true if removed.
 *   reg.evaluate(frame)          Run all rules against frame. Returns
 *                                an array of validated A2AAction objects
 *                                in registration order.
 *   reg.get(id)                  Look up a rule by id.
 *   reg.list()                   List rules (id + name) for diagnostics.
 *   reg.size                     Number of registered rules.
 *   reg.clear()                  Remove all rules.
 *
 * The registry is itself an EventEmitter. See the file header for events.
 */
class WatcherRegistry extends EventEmitter {
  /**
   * @param {object}  [opts]
   * @param {boolean} [opts.verbose=false]   Log rule firings to stderr when true.
   * @param {object}  [opts.history]         Optional WatcherHistory instance.
   *   When supplied, every rule's `cooldownMs` is consulted before the
   *   action is emitted, suppressing duplicates within the cooldown window
   *   and identical payloads (when the history has dedupPayloads enabled).
   *   Rules with no cooldownMs or with cooldownMs=0 are unaffected.
   *   See `backend/watcherHistory.js` for the suppression contract.
   * @param {() => number} [opts.now]        Optional clock function (returns
   *   epoch ms). Defaults to `Date.now`. Tests inject a fixed clock so the
   *   cooldown behaviour is deterministic.
   */
  constructor(opts = {}) {
    super();
    this.verbose = Boolean(opts.verbose);
    /** @type {Map<string, NormalisedWatcherRule>} */
    this._rules = new Map();
    /** Optional history (per-rule suppression state). May be null. */
    this._history = opts.history ?? null;
    /** Optional clock function. Defaults to Date.now. */
    this._now = typeof opts.now === "function" ? opts.now : null;
  }

  /**
   * Per-rule + aggregate stats, suitable for /status snapshots.
   * When no history is attached, historyStats is null.
   * @returns {{ ruleCount: number, rules: object[], historyStats: object | null }}
   */
  get stats() {
    return {
      ruleCount: this._rules.size,
      rules: this.list(),
      historyStats: this._history ? this._history.getStats() : null,
    };
  }

  /**
   * Add a rule. Throws on validation failure (caught early so a malformed
   * rule cannot lurk and silently break evaluation).
   *
   * @param {WatcherRule} rule
   * @returns {string} the rule's id (echoed for convenience)
   */
  add(rule) {
    const normalised = _normaliseRule(rule);
    this._rules.set(normalised.id, normalised);
    return normalised.id;
  }

  /**
   * Remove a rule by id.
   * @param {string} id
   * @returns {boolean} true if a rule was removed
   */
  remove(id) {
    return this._rules.delete(id);
  }

  /**
   * Look up a rule.
   * @param {string} id
   * @returns {WatcherRule | undefined}
   */
  get(id) {
    const r = this._rules.get(id);
    if (!r) return undefined;
    return _denormaliseRule(r);
  }

  /**
   * List rules for diagnostics. Does not include functions.
   * @returns {Array<{ id: string, name: string }>}
   */
  list() {
    const out = [];
    for (const r of this._rules.values()) {
      out.push({ id: r.id, name: r.name });
    }
    return out;
  }

  /** Number of registered rules. */
  get size() { return this._rules.size; }

  /** Remove all rules. */
  clear() { this._rules.clear(); }

  /**
   * Evaluate all rules against a frame.
   *
   * Suppression: if the registry was constructed with a `history` instance
   * and the matched rule has `cooldownMs > 0` (or the history's
   * `dedupPayloads` is on), the rule's `shouldFire()` is consulted first.
   * Suppressed rules are dropped (counted in history stats) but do not
   * abort evaluation of other rules.
   *
   * @param {FeatureVector} frame
   * @returns {Array<A2AAction>}  validated actions, in registration order
   */
  evaluate(frame) {
    if (frame == null || typeof frame !== "object") {
      throw new TypeError("WatcherRegistry.evaluate: frame must be an object");
    }
    const now = this._now ? this._now() : Date.now();
    const fired = [];
    for (const rule of this._rules.values()) {
      let matched = false;
      try {
        matched = Boolean(rule.when(frame));
      } catch (err) {
        this.emit("error", err, { ruleId: rule.id, ruleName: rule.name, stage: "when" });
        continue;
      }
      if (!matched) continue;

      // History check: ask the registered history whether this rule should
      // be allowed to fire *right now*. A return of {ok: false, reason} means
      // the rule is suppressed and we should NOT call record() (no state
      // change). When no history is attached, the check is skipped and the
      // rule fires unconditionally.
      if (this._history) {
        let decision;
        try {
          decision = this._history.shouldFire(rule.id, now, rule.cooldownMs, undefined);
        } catch (err) {
          this.emit("error", err, { ruleId: rule.id, ruleName: rule.name, stage: "history-decide" });
          continue;
        }
        if (!decision.ok) {
          try {
            this._history.markSuppressed(rule.id, decision.reason);
          } catch (err) {
            this.emit("error", err, { ruleId: rule.id, ruleName: rule.name, stage: "history-mark" });
          }
          if (this.verbose) {
            console.error(`[watcher] ${rule.id} (${rule.name}) SUPPRESSED (${decision.reason})`);
          }
          continue;
        }
      }

      let payload = {};
      let reason = "";
      let priority = DEFAULT_PRIORITY;
      try {
        if (rule.action.payloadFn)  payload  = rule.action.payloadFn(frame) ?? {};
        if (rule.action.reasonFn)   reason   = rule.action.reasonFn(frame)  ?? "";
        if (rule.action.priorityFn) priority = rule.action.priorityFn(frame);
      } catch (err) {
        this.emit("error", err, { ruleId: rule.id, ruleName: rule.name, stage: "extract" });
        continue;
      }

      if (typeof priority !== "number" || !Number.isFinite(priority)) {
        this.emit("error", new Error(`priority must be a finite number, got ${priority}`),
          { ruleId: rule.id, ruleName: rule.name, stage: "validate-priority" });
        continue;
      }

      const candidate = {
        action: rule.action.name,
        payload,
        reason,
        priority,
      };
      const v = validateA2AAction(candidate);
      if (!v.ok) {
        this.emit("error", new Error(`rule produced invalid action: ${v.errors.join("; ")}`),
          { ruleId: rule.id, ruleName: rule.name, stage: "validate-action" });
        continue;
      }
      fired.push(v.value);
      this.emit("fired", v.value, { ruleId: rule.id, ruleName: rule.name });
      if (this.verbose) {
        // Use console.error (not console.log) so the lint allow-list is
        // respected and operators still see the line in their terminal.
        console.error(`[watcher] ${rule.id} (${rule.name}) -> ${v.value.action} p=${v.value.priority}`);
      }
      // Record the successful fire so the next call within cooldownMs is
      // suppressed. Failures here must not crash evaluation.
      if (this._history) {
        try {
          this._history.record(rule.id, now, v.value.payload, v.value.priority);
        } catch (err) {
          this.emit("error", err, { ruleId: rule.id, ruleName: rule.name, stage: "history-record" });
        }
      }
    }
    return fired;
  }
}

// ---------------------------------------------------------------------------
// Internal: rule normalisation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WatcherRule
 * @property {string}   id         Unique id. Must be non-empty, <= 64 chars.
 * @property {string}   name       Human-readable label.
 * @property {(frame: FeatureVector) => boolean} when
 *           Pure predicate. Returns true if this rule should fire.
 * @property {string}   action.name   Action name from A2A_ALLOWED_ACTIONS.
 * @property {(frame: FeatureVector) => Object}  [action.payload]
 *           Pure function returning the action payload. Defaults to {}.
 * @property {(frame: FeatureVector) => string}  [action.reason]
 *           Pure function returning the action reason. Defaults to "".
 * @property {(frame: FeatureVector) => number}  [action.priority]
 *           Pure function returning the action priority. Defaults to 0.5.
 */

/**
 * Internal stored shape. Same as WatcherRule but with the action callbacks
 * renamed to *Fn so we can name `payload` (the user-facing field) separately
 * from the validated payload (the runtime field).
 *
 * @typedef {Object} NormalisedWatcherRule
 * @property {string} id
 * @property {string} name
 * @property {(frame: FeatureVector) => boolean} when
 * @property {string} action.name
 * @property {null | ((frame: FeatureVector) => Object)} action.payloadFn
 * @property {null | ((frame: FeatureVector) => string)} action.reasonFn
 * @property {null | ((frame: FeatureVector) => number)} action.priorityFn
 * @property {number} cooldownMs
 *   0 = no suppression. If a `history` is attached to the registry, the
 *   rule will be skipped for this many ms after a successful fire.
 */

function _normaliseRule(rule) {
  if (rule == null || typeof rule !== "object") {
    throw new TypeError("watcher rule must be an object");
  }
  if (typeof rule.id !== "string" || rule.id.length === 0) {
    throw new TypeError("watcher rule.id must be a non-empty string");
  }
  if (rule.id.length > 64) {
    throw new RangeError("watcher rule.id must be <= 64 chars");
  }
  if (typeof rule.name !== "string" || rule.name.length === 0) {
    throw new TypeError("watcher rule.name must be a non-empty string");
  }
  if (typeof rule.when !== "function") {
    throw new TypeError("watcher rule.when must be a function");
  }
  if (rule.action == null || typeof rule.action !== "object") {
    throw new TypeError("watcher rule.action must be an object");
  }
  if (typeof rule.action.name !== "string" || rule.action.name.length === 0) {
    throw new TypeError("watcher rule.action.name must be a non-empty string");
  }
  // Reject obviously-invalid action names early; validateA2AAction will
  // also catch this on every fire, but failing fast gives clearer errors.
  const a = rule.action;
  let cooldownMs = DEFAULT_COOLDOWN_MS;
  if (rule.cooldownMs !== undefined) {
    if (typeof rule.cooldownMs !== "number" || !Number.isFinite(rule.cooldownMs) || rule.cooldownMs < 0) {
      throw new TypeError("watcher rule.cooldownMs must be a finite, non-negative number");
    }
    cooldownMs = rule.cooldownMs;
  }
  return {
    id: rule.id,
    name: rule.name,
    when: rule.when,
    cooldownMs,
    action: {
      name: a.name,
      payloadFn:  typeof a.payload  === "function" ? a.payload  : null,
      reasonFn:   typeof a.reason   === "function" ? a.reason   : null,
      priorityFn: typeof a.priority === "function" ? a.priority : null,
    },
  };
}

function _denormaliseRule(n) {
  return {
    id: n.id,
    name: n.name,
    when: n.when,
    cooldownMs: n.cooldownMs,
    action: {
      name: n.action.name,
      payload:  n.action.payloadFn  || ((_f) => ({})),
      reason:   n.action.reasonFn   || ((_f) => ""),
      priority: n.action.priorityFn || ((_f) => DEFAULT_PRIORITY),
    },
  };
}

module.exports = {
  WatcherRegistry,
  DEFAULT_PRIORITY,
  DEFAULT_COOLDOWN_MS,
};
