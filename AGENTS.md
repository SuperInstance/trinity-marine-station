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
| `backend/a2aBridge.js`     | 446 | WebSocket server (port 3002). Hello, replay, ack, ping/pong, graceful shutdown. |
| `backend/a2aClient.js`     | 457 | Typed WS client. Auto-reconnect, manual replay, destroy. |
| `backend/schemas.js`       | 429 | Validators for every wire shape. Add new shapes here. |
| `backend/telemetryIngest.js` | 323 | WebSocket consumer. Hello handshake, exponential backoff, frame parsing. |
| `backend/a2aLog.js`        | 307 | Append-only JSONL audit log. Batched writes, rotation, replay. |
| `backend/vectorStore.js`   | 295 | Float32Array cosine/dot/L2 store + `EmbeddingRetriever`. |
| `backend/circuitBreaker.js` | 277 | 3-state breaker. `exec()` for sync, `execStream()` for async iterables. |
| `backend/ollama.smoke.test.js` | 263 | Live Ollama integration (skips if not running). |
| `backend/vesselAgentAdapter.js` | 240 | Normalizes Signal K + vessel-agent deltas into one `TrinityFrame`. |
| `backend/jepaWorldModel.js` | 203 | Linear predictor. Energy ∈ [0,1]. >0.5 = anomaly. |
| `backend/a2aBridge.test.js` | 429 | 15 cases. |
| `backend/a2aClient.test.js` | 465 | 16 cases. |
| `backend/a2aLog.test.js`    | 361 | 18 cases. |
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

## 8. The future plan (Phase 6 candidates)

**Phase 6 progress so far:**

- [x] **Sync-then-broadcast bridge fix** (shipped 2026-07-26, commit forthcoming). `_broadcastAction` awaits `log.append()` before sending to clients; `actionsDropped` counter added; 3 new tests pin the invariant. See `docs/PHASE5.md §5.1` for the durability analysis and gotcha #1 above for the implementation summary.

**Remaining candidates, ranked by value-per-line:**

1. **Theia extension** (TypeScript, lives in `frontend/`). The `A2aClient` is ready to drop in. Need: a panel that reads `morph_to_hazard_mode` and visually switches the workspace; basic JSON-RPC plumbing. ~200 LOC.
2. **Real vessel-agent → WS bridge** (Python, ships in `vessel-agent`). ~80 LOC. Just publishes the trinity delta format at `ws://localhost:3000`.
3. **DuckDB read-side adapter.** For retrospective queries against archived features. ~150 LOC.
4. **`h3-js` integration** for production-grade H3 (current is a quantized-grid approximation). Drop-in replacement of `backend/h3.js`.

If you are a future agent and need to pick one: **#1 (Theia extension)** closes the cognitive loop the most of these. The repo is currently "talks to itself" — the bridge fans out, but no UI listens. Theia is where the operator (captain) finally sees the system.

---

## 9. Cross-references

- `docs/PHASE5.md` — bridge protocol reference + Phase 5 status
- `docs/SYNERGY.md` — vessel-agent integration boundary (L0–L4 cognitive levels)
- `docs/OPERATIONS.md` — env vars, run-time ops, shutdown order, troubleshooting
- `docs/ARCHITECTURE.md` — design rationale (the *why*)
- `docs/TESTING.md` — how the test suite is structured
- `docs/a2a/` (this round) — formal JSON Schema, examples, quickref for the A2A bridge
- `docs/AGENTS.md` (this round) — longer-form agent-oriented onboarding
- `docs/STATUS.json` (this round) — machine-readable project state
- `docs/MESH_TEST_REPORT.md` — last round's mesh-test findings (audits, what was verified)

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

The repo ships five auditors that catch the most common drift bugs:

| Tool | Catches | When to run |
|---|---|---|
| `tools/auditLinks.js` | Broken cross-doc links | Before any doc PR |
| `tools/auditStatus.js` | Stale STATUS.json (commit, line counts) | Before pushing code changes |
| `tools/auditRequires.js` | Missing/typo'd `require()` paths | Before any commit that touches backend/ or tests/ |
| `tools/smokeDaemon.js` | Daemon won't boot, /status missing a2aBridge | After daemon changes |
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
