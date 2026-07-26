# Trinity Marine Station

> **Agentic-first marine navigation station.** A modular, real-time bridge platform that fuses native marine hardware telemetry with a headless cognitive engine (JEPA world-model + local LLM narrator) and a future Eclipse Theia-based modular workspace that the AI can morph at runtime.

🔗 https://github.com/SuperInstance/trinity-marine-station

---

## The Trinity

```
              ┌──────────────────────────────────────────┐
              │  Phase 1 — Nervous system (THIS PHASE)   │
              │  mockSignalK → telemetryIngest → ring buf │
              └────────────────────┬─────────────────────┘
                                   │ frame events
                                   ▼
              ┌──────────────────────────────────────────┐
              │  Phase 3 — Conscious narrator (DONE)     │
              │  JepaWorldModel ─┐                       │
              │  LlmNarrator  ←──┴── HttpLlmBackend      │
              │   (qwen3:4b on local Ollama)            │
              │   emits prose + <a2a> actions            │
              └────────────────────┬─────────────────────┘
                                   │ a2a actions
                                   ▼
              ┌──────────────────────────────────────────┐
              │  Phase 4 — vessel-agent integration      │
              │  (DONE — anti-corruption adapter)        │
              │   vesselAgentAdapter normalizes BOTH     │
              │   Signal K deltas AND vessel-agent       │
              │   core_anchor JSON into TrinityFrame     │
              │   + H3 spatial index per frame           │
              │   + vessel-uuid provenance               │
              └────────────────────┬─────────────────────┘
                                   │ canonical TrinityFrame
                                   ▼
              ┌──────────────────────────────────────────┐
              │  Phase 5 — Theia workspace (IN PROGRESS) │
              │  ✅ WebSocket A2A bridge shipped         │
              │     (a2aBridge.js + a2aClient.js)        │
              │  ⏳ Theia IDE + bridge consumer pending  │
              │  See docs/PHASE5.md for protocol.        │
              └──────────────────────────────────────────┘
```

---

## What's in this repo

| Layer | Module | Purpose |
|------:|--------|---------|
| **Data** | `backend/marineConstants.js` | Single source of truth: SF Bay trajectory, depth field, feature-vector layout. |
| **Data** | `backend/navigationSimulator.js` | Pure stateful world model (lat/lon, heading, depth). Transport-agnostic. |
| **Data** | `backend/mockSignalK.js` | WebSocket broadcaster on `ws://127.0.0.1:3000` at 2 Hz. |
| **Pipe** | `backend/ringBuffer.js` | Pre-allocated `Float64Array` ring buffer (~12 KB fixed). |
| **Pipe** | `backend/telemetryIngest.js` | WebSocket consumer. Flattens Signal K deltas into 6-D feature vectors. |
| **AI**   | `backend/jepaWorldModel.js` | Linear predictor over feature vectors. Emits an *energy score* per tick; above 0.5 = anomaly. |
| **AI**   | `backend/llmBackends.js` | Pluggable `LlmBackend` — `HttpLlmBackend` (Ollama) + `MockLlmBackend` for tests. |
| **AI**   | `backend/llmNarrator.js` | The Conscious Narrator. Streams LLM output, splits prose vs `<a2a>` blocks. Throttled normal mode, instant emergency mode. |
| **AI**   | `backend/trinityCore.js` | Wires the world model + narrator. Polls the ring buffer every 500 ms, branches on energy. |
| **AI**   | `backend/trinityDaemon.js` | Production daemon: wires ingest → JEPA → narrator → ops HTTP (`/health`, `/status`). |
| **AI**   | `backend/vectorStore.js` | Pre-allocated Float32Array matrix. Cosine / dot / L2 similarity, `EmbeddingRetriever` wrapper. |
| **AI**   | `backend/schemas.js` | Single source of truth: validates `TrinityFrame`, `A2AAction`, `JepaEnergyReading`, `FeatureVector`, `VesselAnchor`. |
| **AI**   | `backend/circuitBreaker.js` | Three-state (closed/open/half-open) breaker around the LLM backend, with `execStream` for async iterators. |
| **AI**   | `backend/healthCheck.js` | Probe runner + status aggregator for the daemon's `/health` endpoint. |
| **AI**   | `backend/a2aLog.js` | Append-only JSONL audit log for every emitted A2A mutation. Batched writes, size-based rotation, replay across files. |
| **AI**   | `backend/a2aBridge.js` | WebSocket server that fans out `A2AAction` events to subscribed frontends with replay-on-reconnect and ack-based idempotency. Port 3002. See [`docs/PHASE5.md`](./docs/PHASE5.md). |
| **AI**   | `backend/a2aClient.js` | Typed-style WebSocket client for the bridge — hello handshake, monotonic action IDs, auto-reconnect with exponential backoff, manual replay. Used by the future Theia frontend. |
| **AI**   | `backend/a2aQuery.js` | Read-side query layer over the A2A JSONL audit log. Pure-JS streaming filter, `countBy`/`topBy`, time-bucketing, `summary`. No native deps (DuckDB substitute). |
| **Data** | `backend/h3.js` | Lightweight H3-style spatial indexer (drop-in compatible with `h3-js`). |
| **Data** | `backend/vesselAgentAdapter.js` | Anti-corruption layer: normalizes Signal K + vessel-agent `core_anchor` JSON into a canonical `TrinityFrame`. |
| **Test** | `tests/pipeline.test.js` | End-to-end Phase 1 verification (streamer + ingest + ring buffer). |
| **Test** | `tests/trinityLifecycle.test.js` | Static-deterministic + live-WebSocket lifecycle of the full Trinity. |
| **Test** | `tests/daemon.test.js` | Spawns the daemon, exercises `/health` + `/status`, validates graceful shutdown. |
| **Test** | `tests/vectorStore.test.js` | Cosine / dot / L2, auto-grow, embedFn round-trip, retriever. |
| **Test** | `tests/ollama.smoke.test.js` | Live Ollama integration (skips gracefully if Ollama isn't running). |
| **Test** | `tests/openai.smoke.test.js` | OpenAI-compatible backend with a local mock SSE server. |
| **Test** | `tests/schemas.test.js` | Every validator: success path, rejection path, edge cases. |
| **Test** | `tests/circuitBreaker.test.js` | State machine, threshold, half-open probe, execStream coverage. |
| **Test** | `tests/healthCheck.test.js` | Probe runner, status aggregator, timeout bounds. |
| **Test** | `tests/h3.test.js` | H3 encoding determinism, locality, dateline wrap, haversine accuracy. |
| **Test** | `tests/vesselAgentAdapter.test.js` | Signal K + vessel-agent normalization, schema round-trip, rejection paths. |
| **Test** | `tests/a2aLog.test.js` | JSONL audit log: append, batching, rotation, replay, corruption tolerance, concurrency. |
| **Test** | `tests/a2aBridge.test.js` | Bridge: hello handshake, replay-on-connect, ack persistence, ping/pong, malformed-payload dropping, multi-client fanout, graceful stop. |
| **Test** | `tests/a2aClient.test.js` | Client: hello round-trip, monotonic action IDs, manual + auto replay, malformed JSON, error envelope, destroy cancels reconnect, reconnect give-up. |
| **Test** | `tests/a2aQuery.test.js` | a2aQuery: filter helpers, multi-file mtime order, countBy/topBy, bucketBy, summary, malformed-line tolerance. |
| **Test** | `tests/run.js` | Unified runner that discovers every `*.test.js`, aggregates exit codes, never lets a stray stderr line fail `npm test`. |

---

## Quick start

```bash
# 1. Install
npm install

# 2. (Optional) Make sure Ollama is running locally with qwen3:4b + nomic-embed-text.
#    If Ollama isn't up, the smoke test skips itself; everything else still works.

# 3. Run the entire test suite — Phase 1 + Phase 3 + Ollama smoke
npm test

# 4. Run the pieces manually
npm run streamer      # in terminal A: starts the mock Signal K server
npm run ingest        # in terminal B: connects and logs feature vectors
npm run narrator      # in terminal C: prints AI narration every 4s
```

**Expected test output:** the suite discovers 14 `*.test.js` files and
expects every one to print `X pass / 0 fail` (or `passed, 0 failed`)
followed by `[run.js] ✅ ALL TESTS PASSED`. Final tally is roughly
**225 assertions across 14 suites**; ollama.smoke skips cleanly when
Ollama isn't running.

---

## Architecture (Phases 1 + 3)

### The nervous system (Phase 1)
```
NavigationSimulator ─► mockSignalK (WS :3000, 2 Hz)
                                  │
                                  ▼
                       telemetryIngest (hello + delta unpack)
                                  │
                                  ▼
                       TelemetryRingBuffer (Float64Array, 256×6)
                                  │
                                  ▼
                       'frame' event ─────────────┐
                                                   │
The subconscious (Phase 3) ◄──────────────────────┘
                           │
                           ▼
            JepaWorldModel.observe(vec)
              → energy.score ∈ [0,1]
              → anomaly = (score > 0.5)

                           │ if peaceful (energy ≤ 0.5)
                           ▼
            narrator.maybeGenerate()  [throttled 4s]

                           │ if anomaly
                           ▼
            narrator.forceEmergency() [instant, aborts in-flight]
                  │
                  ▼
            LlmBackend.generate()  [Ollama /api/generate stream]
                  │
                  ▼
            StreamSplitter
              ├─ prose  → emit('prose') → bridge display
              └─ <a2a>  → parseAndValidateA2A() → emit('a2a')
                                                              │
                                                              ▼
                                              Theia JSON-RPC A2A bridge (Phase 4)
```

### The interfaces
- **`TelemetryIngest.on('frame', vec)`** — every 500ms, fresh 6-D Float64Array.
- **`LlmNarrator.on('prose' | 'a2a' | 'malformed')`** — bridge display + frontend mutation events.
- **`TrinityCore.on('energy' | 'anomaly')`** — JEPA ticks; the latter is the trigger.
- **`LlmBackend`** interface — swap `HttpLlmBackend` (Ollama) for `OpenAiCompatibleBackend` (cloud) with one constructor arg.

For the rationale behind each design decision, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
For how the tests are structured and how to extend them, see [`docs/TESTING.md`](docs/TESTING.md).

---

## Project layout

```
trinity-agent/
├── backend/                          ← data, pipe, AI, and the A2A bridge
│   ├── marineConstants.js            Shared schema
│   ├── navigationSimulator.js        Pure world model
│   ├── mockSignalK.js                WebSocket broadcaster (port 3000)
│   ├── ringBuffer.js                 Pre-allocated Float64Array ring buffer
│   ├── telemetryIngest.js            Consumer pipeline
│   ├── h3.js                         H3-style spatial indexer
│   ├── vesselAgentAdapter.js         Signal K + vessel-agent normalizer
│   ├── jepaWorldModel.js             Energy-score predictor
│   ├── llmBackends.js                HttpLlmBackend + MockLlmBackend
│   ├── llmNarrator.js                Conscious narrator + stream splitter
│   ├── trinityCore.js                Orchestrator (anomaly → emergency)
│   ├── trinityDaemon.js              Production daemon + ops HTTP
│   ├── vectorStore.js                In-memory float32 cosine store
│   ├── schemas.js                    Validators (TrinityFrame, A2A, …)
│   ├── circuitBreaker.js             3-state breaker around LLM backend
│   ├── healthCheck.js                Probe runner for /health
│   ├── a2aLog.js                     Durable JSONL audit log
│   ├── a2aBridge.js                  WebSocket fanout (port 3002)
│   └── a2aClient.js                  Typed subscriber for the bridge
├── shared/                           Shared type/constant modules
├── frontend/                         Reserved for Theia (Phase 5 IDE)
├── cognitive-engine/                 Reserved for future Trinity expansions
├── docs/
│   ├── ARCHITECTURE.md               Design deep-dive
│   ├── OPERATIONS.md                 Run-time ops (incl. bridge section 5b)
│   ├── PHASE5.md                     A2A bridge protocol reference
│   ├── SYNERGY.md                    Cross-system integration (vessel-agent)
│   └── TESTING.md                    How the test suite is structured
├── tests/
│   ├── run.js                        Unified test runner
│   ├── pipeline.test.js              Phase 1 end-to-end
│   ├── trinityLifecycle.test.js      Phase 3 full lifecycle
│   ├── daemon.test.js                Spawns daemon, exercises /health + /status
│   ├── a2aBridge.test.js             Bridge: handshake, replay, ack, ping/pong
│   ├── a2aClient.test.js             Client: connect, replay, reconnect, give-up
│   ├── a2aLog.test.js                Audit log: append, rotation, replay
│   ├── circuitBreaker.test.js        Breaker state machine
│   ├── healthCheck.test.js           Probe runner + aggregator
│   ├── h3.test.js                    H3 indexer accuracy
│   ├── vesselAgentAdapter.test.js    Adapter normalization
│   ├── vectorStore.test.js           Cosine / dot / L2, growth, retriever
│   ├── schemas.test.js               Every validator: success + rejection
│   ├── openai.smoke.test.js          OpenAI-compatible backend
│   ├── ollama.smoke.test.js          Live Ollama integration (skips if down)
│   ├── streamer.smoke.js             (legacy) streamer-only check
│   └── streamer.payloadShape.js      (legacy) dumps one heartbeat payload
├── logs/a2a/                         Append-only JSONL audit log directory
├── package.json
└── README.md
```

---

## LLM backend swapping

The narrator is intentionally backend-agnostic. The `LlmBackend` interface is:

```js
class LlmBackend {
  async *generate(req) { /* AsyncIterable<LlmChunk> */ }
  async embed(req)      { /* EmbeddingResult */ }            // optional
  async listModels()    { /* string[] */ }
  async dispose()       { /* void */ }                        // optional
}
```

Today:
```js
const { HttpLlmBackend } = require("./backend/llmBackends");
const backend = new HttpLlmBackend({
  host: "127.0.0.1", port: 11434,
  defaultModel: "qwen3:4b",            // or "granite4.1:8b", "gemma4:12b"
  defaultEmbedModel: "nomic-embed-text:latest",
});
```

Tomorrow (cloud, no code change in `LlmNarrator`):
```js
class OpenAiCompatibleBackend { /* implements LlmBackend */ }
const backend = new OpenAiCompatibleBackend({
  baseUrl: "https://api.openai.com/v1",
  apiKey:  process.env.OPENAI_API_KEY,
  model:   "gpt-4o-mini",
});
```

---

## A2A audit log

Every validated `<a2a>` mutation emitted by the narrator is persisted to a
JSONL audit log. This gives us:

- **Replay**: read the last N actions from `replay()` to put recent history into the narrator's prompt.
- **Audit**: a permanent record of every workspace mutation (the bridge can re-derive the timeline).
- **Crash safety**: append-only writes are O(1) and never rewrite in place.

The log is wired into the daemon automatically — no caller code required:

```js
// backend/trinityDaemon.js
core.on("a2a", (action) => {
  log(TAG_A2A, "mutation", { action: action.action, priority: action.priority });
  if (a2aLog) a2aLog.append(action);   // <-- persists with _loggedAt + _seq
});
```

**Configuration** (env vars):

| Var | Default | Purpose |
|---|---|---|
| `A2A_LOG_DIR` | `./logs/a2a` | Where the JSONL files live. Auto-created. |
| `A2A_LOG_MAX_BYTES` | `10 MB` | Rotate the active file when it exceeds this size. |
| `A2A_LOG_DISABLED` | `false` | Set to `1` to skip persistence (ephemeral tests). |

**Replay into the narrator context** (when you want it):

```js
const recent = await a2aLog.replay({ limit: 10 });
// → [{ action: "morph_to_hazard_mode", priority: 0.98, _loggedAt: "...", _seq: 1 }, ...]
```

**File naming convention** (kebab-case ISO timestamps, Windows-safe):

```
logs/a2a/a2a-2026-07-25T18-00-00-000Z.jsonl
logs/a2a/a2a-2026-07-25T18-15-22-123Z.jsonl    ← rotated when the active file exceeded maxBytes
```

The daemon flushes & destroys the log on `SIGINT`/`SIGTERM`, so no in-flight mutations are lost.

---

## A2A WebSocket bridge

The persisted log is the **durability** layer. The **delivery** layer is the
A2A bridge — a tiny WebSocket fanout on port `3002` that pushes validated
mutations to any subscribed frontend (today: none yet; tomorrow: Theia).

```
TrinityDaemon ──► A2aLog (durability) ─► A2aBridge (:3002) ─► A2aClient
                       │                       │                    │
                  JSONL files             live broadcast      Theia panels
                  (replay-able)           (replay-on-connect)  (mutation sink)
```

Three guarantees knock out the usual WebSocket pain:

| Guarantee | How |
|-----------|-----|
| **No duplicate application** | Server stamps every action with a monotonic `id`; client persists `lastAckId`; replay only sends `id > lastAckId`. |
| **No lost actions on reconnect** | Client sends `lastAckId` in the `hello` handshake; server replays the gap from the log, then resumes live. |
| **Liveness under load** | Server heartbeats every 15s; 3 missed pings in a row → connection terminated with backpressure metric. |

Minimal client (intended for Theia):

```js
const { A2aClient } = require("./backend/a2aClient");
const c = new A2aClient({ url: "ws://127.0.0.1:3002" });
c.on("action", (a) => panelMutate(a));
c.on("replay_end", () => c.ack(a.id));   // idempotency checkpoint
c.connect();
```

Full protocol (handshake, error envelopes, replay semantics, env vars) lives
in [`docs/PHASE5.md`](./docs/PHASE5.md). Run-time knobs are documented under
[`docs/OPERATIONS.md`](./docs/OPERATIONS.md#5b-the-a2a-websocket-bridge).

---

## Phase status

| Phase | Title                          | Status |
|------:|--------------------------------|--------|
| **1** | Sensory Ingestion Foundation   | ✅ Complete |
| **2** | JEPA Cognitive Engine          | ✅ Complete (energy-score predictor) |
| **3** | Conscious Narrator + A2A       | ✅ Complete (Ollama + Mock, anomaly-driven emergency) |
| **3.5** | Daemon, Vector Store, Cloud Backend | ✅ Complete (unified daemon + OpenAI-compatible backend) |
| **4** | vessel-agent Integration       | ✅ Complete (anti-corruption adapter, H3 indexing, provenance) |
| **5** | Theia Modular Workspace        | 🔄 In progress — WebSocket A2A bridge (server + client) shipped; Theia IDE consumer pending |

---

## Cross-system synthesis

This repo is the **cognitive layer** of a two-system stack. The data-layer sibling is
[`SuperInstance/vessel-agent`](https://github.com/SuperInstance/vessel-agent) — a Python
project that captures raw NMEA / acoustic / catch data on the boat workstation.

They meet at a clean integration boundary — see [`docs/SYNERGY.md`](docs/SYNERGY.md) for:
- L0–L4 cognitive-level mapping (BMAD methodology)
- Triply-anchored records (timestamp / lat-lon-H3 / vessel-uuid)
- The wire-format strict superset (Signal K + vessel-agent vocabulary)
- 7 concrete integration deliverables that are already landed in this repo

---

## License

Private project, no license declared yet.
