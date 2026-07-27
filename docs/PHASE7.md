# PHASE7.md — Deterministic Watcher Rules (AELMA-inspired)

> Audience: future agent sessions, maintainers, post-incident reviewers.
> Status: **shipped** at HEAD `c1e10a4` on `main` (2026-07-26).

## 1. Why this exists

Trinity's hot path was 100% LLM-bound. Even a trivial "depth < 2 m -> raise alert" had to wait for a 2-5 s Ollama round-trip before the captain saw anything on the bridge. The AELMA/VRDTA vision document (`docs/AELMA_SYNTHESIS.md`) called these deterministic rules **"Watcher NPCs"** — small, audible patterns that fire instantly on threshold conditions and *inform* the narrator rather than replace it.

Phase 7 implements that pattern in pure JS, **without bypassing the LLM**.

## 2. What shipped

| File | Purpose |
|------|---------|
| `backend/watchers.js`              | `WatcherRegistry` class. Rule engine: pure predicates over `FeatureVector` -> A2A actions. |
| `tests/watchers.test.js`          | 47 unit tests for the registry. |
| `tests/trinityCoreWatchers.test.js` | 11 integration tests for `trinityCore` -> watcher -> `'a2a'` event chain. |
| `tools/smokeBridgeClient.js`      | End-to-end smoke test that exercises the full WS round-trip (connect, broadcast, ack, reconnect+replay). |
| `docs/AELMA_SYNTHESIS.md`         | Upstream design source (gap analysis referencing the Roblox/AELMA doc). |

Wiring:
- `backend/trinityCore.js` — accepts optional `watchers` param, runs `watchers.evaluate(frame)` on every tick after JEPA observe but before the LLM branch.
- `backend/trinityDaemon.js` — installs 3 default rules (`shallow-water`, `heading-off-course`, `speed-anomaly`) inside `buildDefaultWatchers()`. Toggle with `WATCHERS_DISABLED=1`.

## 3. The contract

A watcher rule has this shape:

```js
reg.add({
  id:   "shallow-water",
  name: "Shallow water warning",
  when: (frame) => frame.depth != null && frame.depth < 2.0,
  action: {
    name:     "raise_alert",                       // must be in A2A_ALLOWED_ACTIONS
    payload:  (frame) => ({ kind: "shallow_water", depth: frame.depth }),
    reason:   (frame) => `depth=${frame.depth.toFixed(2)}m < 2.0m threshold`,
    priority: () => 0.85,                          // clamped to [0,1] by validateA2AAction
  },
});
```

Validation rules (`add()`):
- `id` required, non-empty, ≤ 64 chars.
- `name` required, non-empty.
- `when` must be a function.
- `action.name` required and must be in `A2A_ALLOWED_ACTIONS` (see `backend/schemas.js`).
- If `action.payload` / `reason` / `priority` are functions, they are called with the frame. If omitted, defaults are `{}`, `""`, and `0.5`.

Per-rule error isolation:
- A throwing `when` / `payload` / `reason` / `priority` fires `'error'` and **drops the rule** from the registry. Other rules continue firing.
- A non-finite priority or invalid action name also drops the rule.

Method API:
- `add(rule) -> string` (returns the id)
- `remove(id) -> boolean`
- `get(id) -> object | undefined` (denormalised view: `{ id, name, actionName, actionHasPayload, actionHasReason, actionHasPriority }`)
- `list() -> Array<{ id, name }>` (registration order)
- `size`, `clear()`
- `evaluate(frame) -> A2AAction[]` (the fired actions; also emits `'fired'` event with `(action, { ruleId, ruleName })`)

## 4. The runtime seam

`trinityCore` wires the registry like this (simplified from `backend/trinityCore.js`):

```js
this._watchers = opts.watchers ?? null;
if (this._watchers) {
  this._watchers.on("fired", (action, info) => {
    this._watcherFiredCount += 1;
    const stamped = Object.freeze({
      ...action,
      source: "watcher",
      ruleId:   info.ruleId,
      ruleName: info.ruleName,
    });
    this.emit("a2a", stamped);                 // SAME path as narrator A2A
    this.emit("watcher-fired", stamped, info);
  });
  this._watchers.on("error", (err, info) => {
    this._watcherErrorCount += 1;
    this.emit("watcher-error", err, info);
  });
}

// On every tick, after JEPA emits energy, BEFORE the LLM branch:
if (this._watchers) this._watchers.evaluate(frame);
```

This means:
- Watcher-fired actions get **persisted** (a2aLog).
- Watcher-fired actions get **broadcast** (a2aBridge, including to reconnecting clients).
- Watcher-fired actions get **observed by the narrator** because the narrator subscribes to `core.on('a2a', ...)` (with the `source` field distinguishing watcher from LLM).

The whole point of sharing the `'a2a'` event is that the audit log and frontend see *one* consistent stream regardless of whether the action came from the LLM or from a deterministic rule. If you want to add a new path that bypasses this, please read `docs/AELMA_SYNTHESIS.md` first.

## 5. Operational notes

- **Env var:** `WATCHERS_DISABLED=1` (or `=true`) turns off the default rule set in the daemon. Use this when:
  - You want a clean LLM-only baseline for an experiment.
  - A rule is misfiring and you need to disable without restarting the watcher registry.
- **`/status` snapshot:**
  ```json
  "watchers": { "ruleCount": 3, "rules": [ { "id": "shallow-water", "name": "..." }, ... ] }
  ```
  The default rules are listed by id + name (not full action shape) to keep the snapshot light.
- **Stats:** `core.stats` gains `watcherFiredCount` and `watcherErrorCount` fields. These are also visible via the `/status` snapshot.

## 6. Adding a new watcher rule

Three-step recipe:

1. Edit `backend/trinityDaemon.js` inside `buildDefaultWatchers()`. Pick a unique `id` (≤ 64 chars).
2. If the action name is **new**, edit `backend/schemas.js` to add it to `A2A_ALLOWED_ACTIONS` and to `docs/a2a/SCHEMA.json` (run `npm run regen:schema` — the schema is regenerated from `schemas.js`).
3. Add a test in `tests/watchers.test.js` exercising your rule's predicate + shape. The `default priority is 0.5 when priority fn omitted` test pattern is a good template.

Then run before pushing:

```bash
node tests/run.js          # full suite green
node tools/lint.js         # 44 files clean
node tools/regenStatus.js  # refresh line counts in STATUS.json
git diff docs/STATUS.json  # should show your new line counts only
```

## 7. What watchers are NOT for

- **Anything with non-trivial logic.** Watchers are pure functions over a single frame. If your rule needs history, sensor fusion, or cross-frame correlation, that's a JEPA-style model, not a watcher.
- **Anything that should be overridable by crew.** A rule that fires `raise_alert` every tick in a storm is noise. Add a debounce/cooldown higher up (in the rule itself), or move to a learning system.
- **Anything the LLM should *decide*, not be told about.** The watcher fires; the LLM is informed. If you find yourself wanting the LLM to *approve* a watcher-fired action, you probably want to remove the watcher entirely and let the narrator handle it — at the cost of latency.

## 8. Phase 8+ candidates that build on this

Ranked by value-per-line:

0. ✅ **A2A action parameter schemas** — SHIPPED in commit `390fb2c`.
   `ACTION_PAYLOAD_SCHEMAS` in `backend/schemas.js` is the single source of
   truth; `docs/a2a/SCHEMA.json` is regenerated from it by
   `tools/regenSchema.js`. Each of the 8 allowed actions now has a declared
   payload shape (fields, types, defaults). `validateA2AAction` enforces it
   at every boundary. 12 new tests in `tests/schemas.test.js`.
1. ✅ **Watcher history** — SHIPPED in commit `5d4f590`. `backend/watcherHistory.js`
   provides per-rule cooldown (ms-based) and payload-key dedup. The
   `WatcherRegistry` now consults history inside `evaluate()`; suppressed
   fires emit no `'fired'` event but DO increment the suppress counter
   (visible in `/status`). Default daemon rules ship with sensible cooldowns:
   shallow-water=30s, heading-off-course=60s, speed-anomaly=0s. 33 unit tests
   in `tests/watcherHistory.test.js` + 16 integration tests in
   `tests/watchersWithHistory.test.js`. The history is a pure in-memory
   object — no IO, no persistence, safe for the 500ms tick loop.
2. ✅ **`a2aQuery.timeRange(filters)`** — SHIPPED in commit `a2aQuery` module update. Returns `{ earliest, latest, spanMs, matched }` for any filter set. Designed for dashboards: "when did the last incident start?", "how long has the vessel been in anomaly mode?", "has there been a raise_alert in the last 10 minutes?". Streams the log once via the existing `_iterate` filter — memory stays bounded regardless of corpus size. 6 new tests in `tests/a2aQuery.test.js` cover empty log, single & multi-record spans, filter composition, and `spanMs=0` semantics when all records share one timestamp.
3. ✅ **Source provenance filter on a2aQuery** — SHIPPED in commit `e8fe38d`. `source` filter (exact match) plus convenience methods `bySource(source, opts)` and `sourceBreakdown(filters)`. Surfaces "what fraction of morning alerts came from watchers vs the LLM?" directly. 9 new tests.
4. **`predict(counterfactual)` on JEPA world model** ("Divination" from AELMA). ~200 LOC. Research-flavored — see `docs/AELMA_SYNTHESIS.md` for the prior discussion.

## 9. Cross-references

- `backend/watchers.js` — implementation
- `backend/trinityCore.js` — integration
- `backend/trinityDaemon.js` — default rules
- `tests/watchers.test.js`, `tests/trinityCoreWatchers.test.js` — coverage
- `tools/smokeBridgeClient.js` — end-to-end verification
- `docs/AELMA_SYNTHESIS.md` — upstream design rationale
- `docs/STATUS.json` — module manifest (phase 7 block, watcher row, `phase_7_candidates[0].status = "shipped"`)
- `AGENTS.md` §6, §8, §11 — seam entry, plan entry, audit table
- `docs/PHASE5.md` §5.1 — sync-then-broadcast (the persistence invariant that protects watcher-fired actions the same way it protects narrator-fired ones)
