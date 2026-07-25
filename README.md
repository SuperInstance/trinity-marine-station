# Trinity Marine Station

> **Agentic-first marine navigation station.** A modular, real-time bridge platform that fuses native marine hardware telemetry with a headless cognitive engine (JEPA world-model + local LLM) and an Eclipse Theia-based modular workspace.

This repository holds **Phase 1** of the project: the **sensory ingestion foundation** — the "nervous system" wiring that everything else plugs into.

> 🔗 https://github.com/SuperInstance/trinity-marine-station

---

## What is "Phase 1"?

Phase 1 establishes a stable, allocation-free pipeline from a (mock) Signal K marine telemetry stream into a typed-array feature vector suitable for direct ingestion by a future machine-learning encoder. **No AI models are trained or invoked yet.** What we *do* ship:

| Layer | Module | Role |
|------:|--------|------|
| **Data**     | `backend/marineConstants.js`     | Single source of truth for trajectory, depth field, ports, feature-vector schema. |
| **Data**     | `backend/navigationSimulator.js` | Transport-agnostic world model: a stateless state-machine that produces snapshots. |
| **Data**     | `backend/mockSignalK.js`         | WebSocket broadcaster that mimics a real Signal K server on `ws://127.0.0.1:3000`. |
| **Pipeline** | `backend/ringBuffer.js`          | Pre-allocated `Float64Array` ring buffer (~12 KB fixed footprint). |
| **Pipeline** | `backend/telemetryIngest.js`     | WebSocket consumer that flattens each delta into a feature vector and packs it into the ring buffer. |
| **Tests**    | `tests/pipeline.test.js`         | End-to-end verification of the entire path. |
| **Tests**    | `tests/run.js`                   | Clean runner that guarantees `npm test` exits 0 on success. |

---

## Quick start

```bash
# 1. Install the one dependency (the ws WebSocket library).
npm install

# 2. Verify the system.
npm test            # runs tests/run.js → tests/pipeline.test.js

# 3. Run the pieces manually for development.
npm run streamer    # in terminal A: starts the mock Signal K server
npm run ingest      # in terminal B: connects and logs feature vectors
```

**Expected test output:**
```
✅ PHASE 1 PIPELINE VERIFIED   (exit 0)
```

---

## Architecture (Phase 1)

```
                     ┌────────────────────────┐
                     │  NavigationSimulator   │  (pure, transport-agnostic)
                     │  world model           │
                     └───────────┬────────────┘
                                 │  tick(dtMs) → snapshot
                                 ▼
   ┌──────────────────────────────────────────────────┐
   │              mockSignalK.js                       │
   │  WebSocket server @ ws://127.0.0.1:3000           │
   │  2 Hz heartbeat · Signal K delta JSON             │
   │  Backpressure-aware broadcast                     │
   └──────────────────────────┬───────────────────────┘
                              │  WebSocket frames
                              ▼
   ┌──────────────────────────────────────────────────┐
   │              telemetryIngest.js                   │
   │  Hello handshake · delta unpack                   │
   │  Exponential-backoff reconnect                    │
   │  EventEmitter API: open/hello/frame/close/error   │
   └────────────┬──────────────────────┬──────────────┘
                │ write(vec)           │ emit('frame', vec)
                ▼                      ▼
   ┌────────────────────┐    ┌────────────────────────┐
   │   TelemetryRingBuffer│    │   Cognitive engine     │
   │  Float64Array ring   │    │   (JEPA — Phase 2)     │
   │  256 × 6 features    │    │   reads latestFeatureVector() │
   │  ~12 KB, fixed       │    │   reads snapshot(n)    │
   └────────────────────┘    └────────────────────────┘
```

For deeper architectural rationale and design decisions, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
For details on how tests are structured and how to extend them, see [`docs/TESTING.md`](docs/TESTING.md).

---

## Project layout

```
trinity-agent/
├── backend/                        ← Signal K data layer + ingestion pipeline
│   ├── marineConstants.js          Shared schema (trajectory, depth, feature layout)
│   ├── navigationSimulator.js      Pure stateful world model
│   ├── mockSignalK.js              WebSocket broadcaster (port 3000)
│   ├── ringBuffer.js               Pre-allocated Float64Array ring buffer
│   └── telemetryIngest.js          Consumer pipeline (frame → feature vector)
├── frontend/                       Reserved for Theia IDE extension (Phase 3)
├── cognitive-engine/               Reserved for JEPA + LLM (Phase 2)
├── docs/
│   ├── ARCHITECTURE.md             Phase 1 design deep-dive
│   └── TESTING.md                  How the test suite is structured
├── tests/
│   ├── pipeline.test.js            The end-to-end test
│   ├── run.js                      Clean `npm test` wrapper
│   ├── streamer.smoke.js           (Legacy) streamer-only check
│   └── streamer.payloadShape.js    (Legacy) dumps one heartbeat payload
├── package.json
└── README.md
```

---

## Phase status

| Phase | Title                          | Status |
|------:|--------------------------------|--------|
| **1** | Sensory Ingestion Foundation   | ✅ Complete |
| 2     | JEPA Cognitive Engine          | ⏳ Next |
| 3     | Theia Modular Workspace        | ⏳ Planned |
| 4     | A2A JSON-RPC Layout Bridge     | ⏳ Planned |

---

## License

Private project, no license declared yet.