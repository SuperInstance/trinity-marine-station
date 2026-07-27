# AGENTS.md — Read this first

> **Audience:** any LLM agent or autonomous builder that needs to extend or
> maintain the Trinity Marine Station. This file is deliberately dense; it
> prioritises *what you need to know to start working* over *what a human
> needs to know to understand the project*. If something is missing here,
> please add it.

---

## 1. What this repo is

A real-time marine navigation platform. It ingests telemetry from a vessel,
runs a JEPA-style anomaly detector over a 6-D feature vector, streams
prose narration from a local LLM, and emits validated `<a2a>...</a2a>`
mutations that flow through a WebSocket bridge to any subscribed frontend
(future: Eclipse Theia).

Two design hinges:

- **The wire is text JSON**, never binary. Every module speaks JSON.
- **The audit log is the source of truth.** The bridge is a fanout that
  *also* writes to a JSONL log; replay-on-reconnect is the log + the
  client's `lastAckId`.

---

## 2. The golden path (run/test/repeat)

```bash
npm install                # one-time
npm test                   # runs all 14 test suites; expect "[run.js] ✅ ALL TESTS PASSED"
node tools/lint.js         # 39 files must be clean
npm run streamer           # terminal A: mock Signal K on :3000
npm run ingest             # terminal B: consume, log feature vectors
npm run narrator           # terminal C: AI narration every 4s
node backend/trinityDaemon.js  # production-mode: all of the above + ops HTTP on :8787
```

**Test suite map** (all in `tests/`):

| Suite | Files | Notes |
|------|------:|-------|
| `pipeline.test.js`     |  1 | Phase 1 end-to-end (streamer + ingest) |
| `trinityLifecycle.test.js` | 1 | Phase 3 full lifecycle + live smoke |
| `daemon.test.js`       |  1 | Spawns daemon, hits `/health` + `/status` |
| `a2aBridge.test.js`    |  1 | Bridge: hello, replay, ack, ping/pong, multi-client |
| `a2aClient.test.js`    |  1 | Client: reconnect, give-up, replay, destroy |
| `a2aLog.test.js`       |  1 | Audit log: append, rotation, replay, corruption |
| `circuitBreaker.test.js` | 1 | Breaker state machine |
| `healthCheck.test.js`  |  1 | Probe runner + status aggregator |
| `h3.test.js`           |  1 | H3 indexer accuracy |
| `vesselAgentAdapter.test.js` | 1 | Cross-system normalization |
| `vectorStore.test.js`  |  1 | Cosine/dot/L2, growth, retriever |
| `schemas.test.js`      |  1 | Every validator: success + rejection |
| `openai.smoke.test.js` |  1 | OpenAI-compatible backend |
| `ollama.smoke.test.js` |  1 | Live Ollama (skips if not running) |

`tests/run.js` discovers every `*.test.js` automatically. **Add a test file
there and it's picked up — no runner config to update.**

---

## 3. File map (with line counts as a smell check)

Approximate total backend: ~5,800 lines across 19 modules.
Approximate total tests: ~3,950 lines across 18 files.

| File | Lines | Purpose |
|------|------:|---------|
| `backend/trinityDaemon.js` | 488 | Production daemon: ingest → JEPA → narrator → a2aLog → a2aBridge. Binds env vars. |
| `backend/llmBackends.js`   | 558 | `HttpLlmBackend` (Ollama) + `OpenAiCompatibleBackend` + `MockLlmBackend` + SSE parser. |
| `backend/llmNarrator.js`   | 523 | Conscious narrator: stream splitter, prose vs `<a2a>` blocks, throttled/emergency modes. |
| `backend/a2aBridge.js`     | 446 | WebSocket server (port 3002). Hello, replay, ack, ping/pong, graceful shutdown. Sync-then-broadcast durability (Phase 6). |
| `backend/a2aClient.js`     | 457 | Typed WS client. Auto-reconnect, manual replay, destroy. |
| `backend/a2aQuery.js`      | 450 | Read-side query layer over the JSONL action log. Pure JS, no native deps. Filters, countBy/topBy, time-bucket, summary, source provenance (`bySource`, `sourceBreakdown`), `timeRange`. |

| `backend/watchers.js`      | 440 | Deterministic A2A rule engine (Phase 7). Pure-function predicates over `FeatureVector`; fires A2A actions through trinityCore's `a2a` event so the LLM is informed rather than bypassed. Optional `WatcherHistory` integration for cooldown + payload dedup. Inspired by AELMA 'Watcher NPCs' pattern (docs/AELMA_SYNTHESIS.md). |
| `backend/watcherHistory.js` | 293 | Per-rule suppression layer. shouldFire(rid, now) checks both cooldown (ms) and canonical payload-key dedup; record() / markSuppressed() update per-rule stats. Pure in-memory state, no IO, safe for the 500ms tick loop. Stats exposed via getStats(). |
| `backend/schemas.js`       | 429 | Validators for every wire shape. Add new shapes here. |
| `backend/telemetryIngest.js` | 323 | WebSocket consumer. Hello handshake, exponential backoff, frame parsing. |
| `backend/a2aLog.js`        | 307 | Append-only JSONL audit log. Batched writes, rotation, replay. |
| `backend/vectorStore.js`   | 295 | Float32Array cosine/dot/L2 store + `EmbeddingRetriever`. |
| `backend/circuitBreaker.js` | 277 | 3-state breaker. `exec()` for sync, `execStream()` for async iterables. |
| `backend/ollama.smoke.test.js` | 263 | Live Ollama integration (skips if not running). |
| `backend/vesselAgentAdapter.js` | 240 | Normalizes Signal K + vessel-agent deltas into one `TrinityFrame`. |
| `backend/jepaWorldModel.js` | 203 | Linear predictor. Energy ∈ [0,1]. >0.5 = anomaly. |
| `backend/a2aBridge.test.js` | 429 | 18 cases. |
| `backend/a2aClient.test.js` | 465 | 16 cases. |
| `backend/a2aLog.test.js`    | 361 | 18 cases. |
| `tests/a2aQuery.test.js`    | 948 | 53 cases (helpers + integration + source-filter + timeRange). |

| `tests/watchers.test.js`    | 470 | 47 cases. Pure-registry behavior: registration, evaluation, error isolation, validation. |

| `tests/watcherHistory.test.js` | 410 | 33 cases. WatcherHistory state machine: cooldown, payload dedup, record/markSuppressed, stats, arg validation. |
| `tests/watchersWithHistory.test.js` | 380 | 16 cases. WatcherRegistry + WatcherHistory integration: backward compat, cooldown behavior, reg.stats, error isolation. |
| `tests/trinityCoreWatchers.test.js` | 290 | 11 cases. Integration: registry -> core -> a2a event. Verifies source='watcher' stamp + LLM-notification design. |
| `backend/trinityLifecycle.test.js` | 274 | 9 cases + live WS smoke. |
| `backend/pipeline.test.js`  | 264 | 11 cases (streamer + ingest + ring buffer). |
| `backend/daemon.test.js`    | 228 | 6 cases. |
| `backend/vesselAgentAdapter.test.js` | 251 | 22 cases. |

(Line counts from `wc -l` on the current commit; treat as a smell check, not
ground truth — they shift with every commit.)

---

## 4. The contracts (what shape is what)

### 4.1 On-wire frames (WebSocket)

The bridge carries **text JSON** only. One JSON envelope per `ws.send()`.
See `docs/a2a/SCHEMA.json` for the formal JSON Schema.

**Bridge → Client** (`backend/a2aBridge.js`):

```jsonc
{ "type": "hello",      "last_action_id": 42,   "ts": "2026-07-26T..." }
{ "type": "action",     "id": 43, "action": { "action": "morph_to_hazard_mode", "priority": 0.98, "payload": {}, "reason": "..." } }
{ "type": "replay_end", "replayed": 5 }
{ "type": "ack_ok",     "action_id": 43 }
{ "type": "pong",       "ts": "2026-07-26T..." }
{ "type": "error",      "code": "BAD_JSON", "errors": ["..."] }
```

**Client → Bridge** (`backend/a2aClient.js`):

```jsonc
{ "type": "ping" }
{ "type": "ack",   "action_id": 43 }
{ "type": "replay", "since_id": 42 }
```

### 4.2 In-process events

Every event name is a constant in `shared/events.js`. **Never** emit a string
literal — always import `EVENTS` and use the constant. This is the single
biggest source of bugs in the codebase when refactored.

```js
const { EVENTS } = require("../shared/events");
core.emit(EVENTS.CORE_ANOMALY, { energy });
```

Full catalogue in `backend/schemas.js` (JSDoc) and `shared/events.js` (table).

### 4.3 File shapes

- **`FeatureVector`** — `Float64Array` of length 6: `[lat, lon, sog, hdg, depth, progress]`
- **`JepaEnergyReading`** — `{ score, anomaly, reason, timestamp }`
- **`A2AAction`** — `{ action, payload?, priority?, reason? }` where `action` is one of `A2A_ALLOWED_ACTIONS` (a `Set` in `schemas.js`)
- **`TrinityFrame`** — the canonical internal frame after adapter normalization. Includes `timestampNs` (BigInt), `source.vesselUuid`, `navigation`, `environment`, `spatial.h3Index`, optional `crewReport`, `fleetReport`. Defined in `docs/SYNERGY.md §5`.
- **`LlmChunk`** — `{ text, done, finishReason? }`

---

## 5. The protocol (state machines)

### 5.1 A2A bridge protocol

```
Client                                Bridge
  |  --connect (TCP + WS upgrade)-->   |
  | <--{type:"hello", last_action_id}-|
  |  --{type:"hello", last_action_id}-|  (same content; client confirms)
  | <--{type:"action", id:N}----------|  (gap-fill if id > last_action_id)
  | <--{type:"action", id:N+1}-------|
  | <--{type:"replay_end"}-----------|
  |  --{type:"ack", action_id:M}----->|  (client persists M as its checkpoint)
  | <--{type:"ack_ok", action_id:M}--|
  | <--{type:"action", id:N+2}-------|
  |  --{type:"ping"}---------------->|
  | <--{type:"pong", ts}-------------|
  ...                                 |
  |  --close------------------------->|
```

**Idempotency:** the bridge assigns `id = max(seen) + 1` at action mint
time and persists to `A2aLog` *before* broadcasting. On restart, the
bridge reads `maxId()` from the log and resumes. Clients track
`lastAckId`; replay only sends `id > lastAckId`.

**Liveness:** server pings every 15s; client must respond with pongs
within 45s or be terminated (backpressure).

**Reconnect:** `A2aClient` re-emits `hello` with `lastAckId` automatically.

### 5.2 The cognitive pipeline (5 Hz)

```
trinityDaemon.js (per-tick)
  ↓
TelemetryIngest → ringBuffer → emit('frame')
  ↓
JepaWorldModel.observe(vec) → emit('energy', {score, anomaly})
  ↓
TrinityCore on('energy')
  ├── if anomaly:  LlmNarrator.forceEmergency() → emit('a2a') → a2aLog.append → a2aBridge.broadcast
  └── if peaceful: LlmNarrator.maybeGenerate() (throttled 4s)  → emit('prose' | 'a2a')
  ↓
A2aBridge on('a2a') → A2aLog append → broadcast to all clients
```

### 5.3 Read-side queries (a2aQuery)

For retrospective analysis ("what happened yesterday?", "top alert reasons",
"actions-per-hour"), use `backend/a2aQuery.js`. It streams the JSONL files
in `./logs/a2a/` (oldest-first by mtime) and applies filters / aggregations
in JS. No SQL, no native deps, no full-file load.

```
const { A2aQuery } = require("./backend/a2aQuery");
const q = new A2aQuery({ dir: "./logs/a2a" });

// Filter: every hazard-mode morph in the last hour
const hazards = await q.query({
  action: "morph_to_hazard_mode",
  since: new Date(Date.now() - 3_600_000).toISOString(),
});

// Top-N reasons for raise_alert
const topReasons = await q.topBy({
  field: "reason", limit: 5,
  filters: { action: "raise_alert" },
});

// Per-minute bucket for the last day
const buckets = await q.bucketBy({
  intervalMs: 60_000,
  filters: { since: "2026-07-25T00:00:00Z" },
});
// => [ { ts: "2026-07-25T12:00:00Z", count: 3 }, ... ]

// Roll-up
const s = await q.summary();
// => { totalRecords, byKind, byAction, timeRange: { earliest, latest, spanMs } }

// Time span of a filtered set (dashboards, alerts)
const span = await q.timeRange({ action: "raise_alert" });
// => { earliest: "2026-07-25T12:00:00Z", latest: "2026-07-25T18:42:00Z", spanMs: 23920000, matched: 7 }
```

Filters: `kind`, `action`, `since`, `until`, `minPriority`, `maxPriority`,
`reasonContains`, and `source` (exact match — `"watcher"` / `"narrator"` /
`"system"`). Combinations are AND-ed. Missing fields on a record cause
that record to fail the corresponding filter.

**Source provenance** (added Phase 7+): every record carries a `source`
field stamped at emission, so queries can separate watcher-fired actions
from narrator-issued ones. Convenience methods:

```
// All watcher-fired raise_alerts today
const watcherAlerts = await q.bySource("watcher", {
  filters: { action: "raise_alert" },
});

// What's the watcher-vs-narrator split over the last hour?
const breakdown = await q.sourceBreakdown({
  since: new Date(Date.now() - 3_600_000).toISOString(),
});
// => Map { watcher => 42, narrator => 7, system => 1 }
```

Why streaming and not in-memory? Voyage-day logs are small (KB to low MB),
but multi-week retrospectives can grow. The iterator yields records one at a
time, so memory stays bounded by line length, not file size.

---

## 6. The seams (where to add things)

| Want to add... | Touch these files |
|---|---|
| A new A2A action type | `backend/schemas.js` (`A2A_ALLOWED_ACTIONS` + `validateA2AAction`) |
| A new event name | `shared/events.js` (constant) + emitter + listener |
| A new LLM backend | `backend/llmBackends.js` (implement `LlmBackend` interface) |
| A new feature vector field | `backend/marineConstants.js` (FEATURE_VECTOR_INDEX) + `unpackDeltaInto` |
| A new vessel-agent vocabulary field | `backend/vesselAgentAdapter.js` (extract) + `backend/schemas.js` (validate) |
| A new Theia-side consumer | `backend/a2aClient.js` (already shipped) + new TypeScript file in `frontend/` |
| A new health probe | `backend/healthCheck.js` (implement `probe()`) |
| A new env var | `backend/trinityDaemon.js` (read), `docs/OPERATIONS.md` (document) |
| A new test suite | Drop `*.test.js` in `tests/` — auto-discovered |
| A new query filter / aggregation | `backend/a2aQuery.js` (`recordMatches`, `query`, `countBy`, `topBy`, `bucketBy`, `summary`, `bySource`, `sourceBreakdown`, `timeRange`) |
| A new deterministic A2A rule | `backend/watchers.js` (add to a `WatcherRegistry`); the daemon installs `buildDefaultWatchers()` so rules fire before the LLM. Watcher-fired actions are stamped with `source: "watcher"`. |
| A new suppression policy for watchers | `backend/watcherHistory.js` (cooldown + payload dedup). Pass `{ history }` to the registry constructor to enable. Defaults: cooldownMs=0 (off), dedupPayloads=true. |

---

## 7. The gotchas

1. **The bridge persists to the log BEFORE broadcasting (sync-then-broadcast, Phase 6).** `_broadcastAction` is async; it `await`s `a2aLog.append()` then iterates live clients. If the bridge crashes mid-handler, clients either (a) received the action AND it's on disk for replay, or (b) received nothing. The old fire-and-forget order is gone — three new tests in `tests/a2aBridge.test.js` (prefixed `P6:`) pin this invariant down. If `append()` rejects, the action is dropped (no broadcast) and `actionsDropped` increments; the burnt id is reclaimed so the next action reuses it.

2. **`opts.port ?? DEFAULT_PORT` not `||`.** A bug we hit: `port: 0` (let OS pick) was being silently rewritten to `3002`. Use nullish coalescing everywhere.

3. **PowerShell doesn't support `&&`.** Use `;` to chain commands, or run them in separate `bash` calls. Multi-line bash with `|` in Markdown tables breaks the parser; write a Node helper script in those cases.

4. **The daemon test teardown requires `bridge.stop()`**. Otherwise the WebSocket server holds the event loop open and the test process hangs at exit.

5. **Unicode in `record_note` payloads breaks on Windows** (charmap encoding). Avoid `→`, `≤`, `✓` in notes — use ASCII `->`, `<=`, `OK`.

6. **`A2aLog` is durable across instances.** `_listLogFiles()` reads the entire `logs/a2a/` directory on every instance, so a fresh `A2aLog` opens against the same persisted state. Don't instantiate a second `A2aLog` on the same dir in production (wastes file descriptors). For tests, use a tmp dir per test.

7. **Sub-second GPS interpolation belongs to vessel-agent (Python), not us.** Trinity is downstream of the normalized frame. Don't add interpolation here.

8. **Lint forbids `console.log` in non-CLI backend modules.** Allow-list: `mockSignalK.js`, `telemetryIngest.js`, `llmNarrator.js`, `trinityDaemon.js`. Use `console.warn` or `console.error` if you need to log. See `tools/lint.js`.

9. **The Theia consumer is the only Phase 5 work remaining.** The bridge is shipped (server + client + audit log + wire protocol). What's missing is the TypeScript `ITheiaClient.on('a2a', action => panel.mutate(action))` glue. See `docs/PHASE5.md §6` for Phase 6 candidates.

10. **Don't add a TypeScript build step.** The codebase is intentionally plain JS with JSDoc. Adding `tsc` would force a rebuild on every saved edit and break the "node-only, no build" promise. Theia is the only place TS is allowed.

---

## 8. The future plan (Phase 7+ candidates)

**Phase 6 progress (all shipped):**

- [x] **Sync-then-broadcast bridge fix** (shipped 2026-07-26, commit `486c1e9`). `_broadcastAction` awaits `log.append()` before sending to clients; `actionsDropped` counter added; 3 new tests pin the invariant. See `docs/PHASE5.md §5.1` for the durability analysis and gotcha #1 above for the implementation summary.
- [x] **Read-side query layer** (shipped 2026-07-26, commits `db6285d` + `22e72de`). `backend/a2aQuery.js` provides a DuckDB-substitute in pure JS — streaming filter, countBy/topBy, time-bucketing, summary. No native deps. 38 tests cover it.
- [x] **A2A allow-list single-source-of-truth** (shipped 2026-07-26, commit `7e8ddf2`). `schemas.js` is authoritative; `tools/regenSchema.js` regenerates `docs/a2a/SCHEMA.json`; `tools/auditSchema.js` catches drift. Future agents adding an action: edit `schemas.js` -> run `npm run regen:schema` -> commit code + docs together.
- [x] **Bounded-replay overflow protection** (shipped 2026-07-26, commit `db076f3`). `A2aClient` caps replay at `maxReplayBytes` (default 8 MiB) and fires a one-shot `onReplayOverflow` callback + `replay_truncated` event so reconnecting clients don't drown in a multi-day backlog. 7 new tests cover happy-path, limit, infinity, reset, resume-live.

**Phase 7 progress:**

- [x] **Deterministic Watcher Rules** (AELMA-inspired, shipped 2026-07-26, commit `c1e10a4`). `backend/watchers.js` provides a `WatcherRegistry` where each rule has a `when(frame)` predicate + an `action` template. The daemon installs 3 defaults (`shallow-water`, `heading-off-course`, `speed-anomaly`) in `buildDefaultWatchers()`. Watchers fire BEFORE the LLM is consulted, but the resulting A2A actions are routed through `trinityCore`'s existing `'a2a'` event so they share persistence + broadcast + LLM-notification. The LLM is informed, not bypassed. 47 pure-registry tests + 11 integration tests pin the design. Toggle with `WATCHERS_DISABLED=1`.
- [x] **A2A action parameter schemas** (shipped 2026-07-26, commit `390fb2c`). `ACTION_PAYLOAD_SCHEMAS` in `backend/schemas.js` is the single source of truth for per-action payload shape. `tools/regenSchema.js` regenerates `docs/a2a/SCHEMA.json` from it. 12 new schema tests + ollama smoke fix.
- [x] **Watcher history (cooldown + payload dedup)** (shipped 2026-07-27, commit `5d4f590`). `backend/watcherHistory.js` is a per-rule suppression layer that prevents alert flooding when a steady-state condition keeps a watcher predicate true on every tick. The `WatcherRegistry` now consults history inside `evaluate()`; suppressed fires emit no `'fired'` event but DO increment suppress counters (visible in `/status`). 33 unit + 16 integration tests cover cooldown math, payload-key dedup, per-rule isolation, error isolation, and `reg.stats` exposure.
- [x] **Time-range query on a2aQuery** (shipped 2026-07-27, commit `fc6244a`). `timeRange(filters)` returns `{ earliest, latest, spanMs, matched }` for any filter set — designed for dashboards that need to know "when did the last incident start?" or "how long has the vessel been in anomaly mode?" without scanning the log yourself. Streams the log once via the existing `_iterate` filter; memory stays bounded regardless of corpus size. 6 new tests cover empty log, single & multi-record spans, filter composition, and `spanMs=0` semantics.
- [x] **Source provenance filter on a2aQuery** (shipped 2026-07-27, commit `e8fe38d`). Every A2A record carries a `source` field (`"watcher"` / `"narrator"` / `"system"`) stamped at emission; `A2aQuery` now exposes `source` as a filter plus two convenience methods: `bySource(source, opts)` and `sourceBreakdown(filters)`. Lets retrospective queries answer "what fraction of today's alerts came from watchers vs the LLM?" — directly. 9 new tests cover exact match, composition with other filters, limit cap, invalid arg rejection, and breakdown aggregation.

**Remaining Phase 7+ candidates, ranked by value-per-line:**

1. **Theia extension** (TypeScript, lives in `frontend/`). The `A2aClient` is ready to drop in. Need: a panel that reads `morph_to_hazard_mode` and visually switches the workspace; basic JSON-RPC plumbing. ~200 LOC. **Cross-repo.**
2. **Real vessel-agent -> WS bridge** (Python, ships in `vessel-agent`). ~80 LOC. Just publishes the trinity delta format at `ws://localhost:3000`. **Cross-repo.**
3. **`predict(counterfactual)` on JEPA world model** ("Divination" from AELMA). Returns the expected trajectory delta for a hypothetical action without committing. ~200 LOC. **In-repo but research-flavored** — a 200-LOC first cut would be either trivial or wrong; recommend planning round first.
4. **Spatial layer (scene graph of physical components)**. Zone-based query API for spatial relationships ("engine room + 1.2ft from hydraulic line"). ~300 LOC. No new deps; `h3` already shipped. **In-repo architectural commitment.**
5. **`h3-js` integration** for production-grade H3 (current is a quantized-grid approximation). Drop-in replacement of `backend/h3.js`. ~50 LOC. **In-repo.**

If you are a future agent and need to pick one: **#1 (Theia extension)** closes the cognitive loop most — the repo currently "talks to itself", the bridge fans out, but no UI listens. Theia is where the operator (captain) finally sees the system. **#5 (A2A parameter schemas)** is the highest-leverage purely-in-repo pick because it unlocks structured narrator -> watcher hand-off.

---

## 9. Cross-references

- `docs/PHASE5.md` — bridge protocol reference + Phase 5 status
- `docs/SYNERGY.md` — vessel-agent integration boundary (L0–L4 cognitive levels)
- `docs/OPERATIONS.md` — env vars, run-time ops, shutdown order, troubleshooting
- `docs/ARCHITECTURE.md` — design rationale (the *why*)
- `docs/LIVE_PATH.md` — runtime sequence: Signal K → ingest → JEPA → narrator → core → a2aLog → bridge → Theia (the *how*, end-to-end)
- `docs/TESTING.md` — how the test suite is structured
- `docs/a2a/` (this round) — formal JSON Schema, examples, quickref for the A2A bridge
- `docs/AGENTS.md` (this round) — longer-form agent-oriented onboarding
- `docs/STATUS.json` (this round) — machine-readable project state
- `docs/MESH_TEST_REPORT.md` — last round's mesh-test findings (audits, what was verified)
- `docs/PHASE6_HANDOFF.md` — cross-repo handoff for Phase 6 work (Theia, vessel-agent Python)
- `docs/AELMA_SYNTHESIS.md` — mapping of the AELMA/VRDTA vision (Roblox-based) onto Trinity; identifies Phase 7+ candidates inferred from the gap analysis

---

## 10. Your obligations when extending this repo

1. **Read** `docs/PHASE5.md` and `docs/SYNERGY.md` before touching anything in `backend/`.
2. **Add a test** in `tests/` for any new module. The runner auto-discovers.
3. **Run** `node tools/lint.js` and `node tests/run.js` before committing.
4. **Update** `docs/AGENTS.md` §3 (file map) and `docs/STATUS.json` if you add
   or remove a module.
5. **Update** `docs/PHASE5.md` if you change the wire protocol.
6. **Coordinate** any new event name through `shared/events.js`.
7. **Commit** with a clear message; **push** to `main` if you have access, else
   push to a feature branch and open a PR.
8. **Write a new memory entry** if you make a non-obvious decision.
9. **Before any commit that changes module line counts**, run `npm run regen:status`
   so `docs/STATUS.json` reflects reality.
10. **Run `npm run verify`** before pushing. If it fails, do not commit.

---

## 11. Mesh verification (the "can I trust this codebase?" checklist)

The repo ships six auditors that catch the most common drift bugs:

| Tool | Catches | When to run |
|---|---|---|
| `tools/auditLinks.js` | Broken cross-doc links | Before any doc PR |
| `tools/auditStatus.js` | Stale STATUS.json (commit, line counts) | Before pushing code changes |
| `tools/auditRequires.js` | Missing/typo'd `require()` paths | Before any commit that touches backend/ or tests/ |
| `tools/auditSchema.js` | SCHEMA.json / EXAMPLES.jsonl / *.md use action names not in `A2A_ALLOWED_ACTIONS` | Before any commit that touches `docs/a2a/` or `backend/schemas.js` |
| `tools/smokeDaemon.js` | Daemon won't boot, /status missing a2aBridge | After daemon changes |
| `tools/smokeBridgeClient.js` | End-to-end WS round-trip — connect, broadcast, ack, reconnect+replay | After bridge/client changes |
| `tools/lint.js` | Syntax errors, stray tabs, console.log in backend | Every commit |

**Fastest sanity check:**

```bash
npm run verify       # audits + lint + test (~45s)
```

This is the canonical "is this codebase trustworthy?" command. Every CI run,
every fresh agent session, every pre-push should run it. If it passes, the
docs match the code, the tests cover the contracts, and the daemon boots.

**Detailed report:** `docs/MESH_TEST_REPORT.md` (last round's findings).

---

*This document is consumed by successor agent sessions. If you found
something here that misled you, fix it. If you found something missing,
add it. The next agent is you, minus the memory.*
