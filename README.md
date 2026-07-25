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
              │  Phase 5 — Theia workspace (PLANNED)     │
              │  Eclipse Theia IDE + JSON-RPC A2A bridge │
              │  AI morphs panels at runtime             │
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

**Expected test output:**
```
[run.js] ✅ ALL TESTS PASSED
   • ollama.smoke        PASS (skipped if Ollama down)
   • pipeline            PASS (Phase 1, 11 checks)
   • trinityLifecycle    PASS (9 checks + 1 live smoke)
```

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
├── backend/                        ← everything (data, pipe, AI)
│   ├── marineConstants.js          Shared schema
│   ├── navigationSimulator.js      Pure world model
│   ├── mockSignalK.js              WebSocket broadcaster (port 3000)
│   ├── ringBuffer.js               Pre-allocated Float64Array ring buffer
│   ├── telemetryIngest.js          Consumer pipeline
│   ├── jepaWorldModel.js           Energy-score predictor
│   ├── llmBackends.js              HttpLlmBackend + MockLlmBackend
│   ├── llmNarrator.js              Conscious narrator + stream splitter
│   └── trinityCore.js              Orchestrator (anomaly → emergency)
├── shared/                         Shared type/constant modules
├── frontend/                       Reserved for Phase 4 (Theia)
├── cognitive-engine/               Reserved for future Trinity expansions
├── docs/
│   ├── ARCHITECTURE.md             Design deep-dive
│   └── TESTING.md                  How the test suite is structured
├── tests/
│   ├── run.js                      Unified test runner
│   ├── pipeline.test.js            Phase 1 end-to-end
│   ├── trinityLifecycle.test.js    Phase 3 full lifecycle
│   ├── ollama.smoke.test.js        Live Ollama integration (opt-in)
│   ├── streamer.smoke.js           (legacy) streamer-only check
│   └── streamer.payloadShape.js    (legacy) dumps one heartbeat payload
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

## Phase status

| Phase | Title                          | Status |
|------:|--------------------------------|--------|
| **1** | Sensory Ingestion Foundation   | ✅ Complete |
| **2** | JEPA Cognitive Engine          | ✅ Complete (energy-score predictor) |
| **3** | Conscious Narrator + A2A       | ✅ Complete (Ollama + Mock, anomaly-driven emergency) |
| **3.5** | Daemon, Vector Store, Cloud Backend | ✅ Complete (unified daemon + OpenAI-compatible backend) |
| **4** | vessel-agent Integration       | ✅ Complete (anti-corruption adapter, H3 indexing, provenance) |
| **5** | Theia Modular Workspace        | ⏳ Next — JSON-RPC A2A bridge + Theia extension |

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
