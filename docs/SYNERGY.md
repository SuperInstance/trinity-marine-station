# Trinity ↔ Vessel-Agent Synergy

**Status:** Living design document — updated as integration surfaces ship.
**Audience:** Anyone wiring `vessel-agent` (Python data capture, F/V EILEEN)
together with `trinity-marine-station` (Node cognitive engine + Theia frontend).

---

## TL;DR

Two repositories, one mission. They live at different layers of the same stack
and were designed independently — but their seams align so cleanly that a
single integration boundary unifies them into a complete agentic marine
station:

| Layer | Repo | Language | Responsibility |
|------:|:-----|:--------:|:---------------|
| **L0 Raw capture** | vessel-agent | Python | UDP/NMEA byte capture, ring buffer, Parquet writer, H3 indexing |
| **L0/L1 Normalization** | vessel-agent | Python | Sub-second GPS interpolation, Sv dB, hardware calibration |
| **L2 Cognitive** | **trinity-marine-station** | Node | JEPA world model, anomaly energy, A2A workspace mutations |
| **L3 Narrative** | **trinity-marine-station** | Node | LLM narrator, stream-of-consciousness markdown, prose + A2A split |
| **L3 Memory** | **trinity-marine-station** | Node | Vector store, retrievers, JEPA associations |
| **L3.5 Delivery** | **trinity-marine-station** | Node | A2A bridge: WebSocket fanout + JSONL audit log + replay-on-reconnect |
| **L4 Workspace** | Theia (both) | TS | Multi-panel UI, agent-chat panel, mutation surface |

**The integration boundary is a WebSocket that carries triply-anchored JSON.**
vessel-agent already publishes this shape (see `vessel_agent_memory_schema.json`,
`core_anchor`); Trinity already consumes an analogous shape (Signal K deltas).
A small schema-bridge module makes them speak the same wire format.

---

## 1. Why these two belong together

### vessel-agent's strengths (what we *don't* rebuild)

Reading `vessel_agent_knowledge_base.md` and the 5-year vision, vessel-agent has
solved — in production-quality spec form — problems we deliberately deferred:

- **Lossless UDP/NMEA capture** with BPF filters and zero-copy ring buffers
- **Triply-anchored data**: every point carries temporal (`timestamp_ns`),
  spatial (`latitude`, `longitude`, `h3_index_uint64`, `heading_true`,
  `transducer_depth_m`), and provenance (`vessel_uuid`, `hardware_source`,
  `pipeline_version`) metadata
- **Hive-partitioned Parquet** archive with ICES SONAR-netCDF4 alignment
- **DuckDB query layer** for retrospective analysis
- **Sub-second GPS interpolation** for fusing sounder pings with position
- **Multi-modal ingestion** (voice transcripts, photos, fleet reports)
- **ZeroMQ agent bus** for pub/sub between ingestion / analysis / supervisor /
  communication agents
- **BMAD methodology** with 5 abstraction levels (Raw Bits → Strategy)

That's years of careful design we shouldn't duplicate.

### trinity-marine-station's strengths (what vessel-agent hasn't built)

What vessel-agent's docs explicitly defer to "Phase 3+" or describe only as a
vague `IngestionAgent.classify()`:

- **JEPA-style world model** that learns to predict the next state and emits
  an **energy score** when reality diverges from prediction (anomaly)
- **LLM narrator** that converts numeric state + retrieved memories into
  prose ("you're heading toward a known rocky shelf, captain")
- **A2A `<a2a>...</a2a>` blocks** in the LLM stream that mutate the workspace
  (`morph_to_hazard_mode`, `raise_alert`, `dim_panel`, etc.)
- **Pre-allocated typed-array ring buffer** for ML-ready feature vectors
  (zero per-frame GC pressure, fixed memory footprint)
- **Circuit-breaker + health probes** for resilient LLM calls
- **Cloud-swappable LLM backend** (Ollama today, OpenAI-compatible tomorrow,
  one env var)

These are the **conscious narrator** + **subconscious world model** halves of
the architecture vessel-agent's BMAD framework gestures at but doesn't
implement.

### The union

```
                        vessel-agent (Python)                   trinity-marine-station (Node)
                        ─────────────────────                   ──────────────────────────────
   Furuno sounder ─►  ┌──────────────────────┐
   GPS / NMEA    ─►   │  BPF + ring buffer   │
                      │  NMEA interpolation  │
   Phone voice   ─►   │  Parquet writer      │
   Phone camera  ─►   │  Hive partitioning   │
                      │  H3 spatial index    │
                      │  DuckDB query        │
                      └──────────┬───────────┘
                                 │  Triply-anchored JSON
                                 │  over WebSocket (NEW bridge)
                                 ▼
                      ┌──────────────────────────────────────────────────────┐
                      │  telemetryIngest.js  (Signal K + vessel-agent aware)  │
                      │  ringBuffer.js       (Float64Array feature vectors)   │
                      └──────────┬───────────────────────────────────────────┘
                                 │  latest frame + history
                                 ▼
                      ┌──────────────────────────────────────────────────────┐
                      │  jepaWorldModel.js   (predict next, score mismatch)   │
                      │  vectorStore.js      (associative memory + retriever) │
                      └──────────┬───────────────────────────────────────────┘
                                 │  energy score + retrieved context
                                 ▼
                      ┌──────────────────────────────────────────────────────┐
                      │  llmNarrator.js      (StreamSplitter → prose + A2A)  │
                      │  circuitBreaker.js   (LLM failure protection)         │
                      └──────────┬───────────────────────────────────────────┘
                                 │  prose track (markdown) + <a2a> actions
                                 ▼
                      ┌──────────────────────────────────────────────────────┐
                      │  a2aLog.js          (durable JSONL audit log)         │
                      │  a2aBridge.js       (WebSocket fanout :3002)          │
                      │  a2aClient.js       (typed subscriber, used by Theia) │
                      └──────────┬───────────────────────────────────────────┘
                                 │  text JSON over WebSocket
                                 ▼
                      ┌──────────────────────────────────────────────────────┐
                      │  Theia IDE  (panels, layout, mutation sink)           │
                      │  – morph_to_hazard_mode, raise_alert, …              │
                      └──────────────────────────────────────────────────────┘
```

---

## 2. The integration boundary

### Wire protocol: a triply-anchored delta frame

vessel-agent's `core_anchor` already encodes the right metadata. We lift it
into the Trinity wire format as a **trinity delta**:

```jsonc
{
  "context": "vessels.urn:uuid:US-AK-FVCATCHER-01",
  "updates": [
    {
      "timestamp":   "2026-07-25T17:31:04.512Z",
      "timestamp_ns": 1721935264512000000,        // ← nanosecond anchor
      "source": {
        "vessel_uuid":      "urn:uuid:US-AK-FVCATCHER-01",
        "hardware_source":  "Furuno_DFF3DHD",
        "pipeline_version": "0.4.0"
      },
      "values": {
        // ─── vessel-agent core_anchor subset ──────────────────────
        "navigation.position":           { "latitude": 58.123, "longitude": -134.456 },
        "navigation.speedOverGround":    8.5,                      // knots
        "navigation.headingTrue":        45.0,                     // degrees
        "environment.depth.belowTransducer": 32.4,                 // meters

        // ─── vessel-agent spatial augmentation ────────────────────
        "spatial.h3Index":              "8a21104523fffff",        // hex string

        // ─── vessel-agent multi-modal ingestion ───────────────────
        "crew_report.transcript":        "Looks like chum at 40 fathoms",
        "crew_report.confidence":        0.82,
        "fleet_report.source_vessel":    "urn:uuid:US-AK-FVCATCHER-02"
      }
    }
  ]
}
```

This is **strictly a superset** of Signal K delta updates. The existing
Signal K fields (`navigation.*`, `environment.*`) are preserved verbatim so
the existing `mockSignalK.js` and any third-party Signal K producer keep
working without modification. The new keys (`spatial.*`, `crew_report.*`,
`fleet_report.*`, `source.*`) are vessel-agent vocabulary and are no-ops
for purely-Signal-K consumers.

### Three integration patterns

| Pattern | Use case | Implementation |
|--------:|----------|----------------|
| **A. Direct WS bridge** | vessel-agent Python process publishes to `ws://localhost:3000` via `websockets` lib; Trinity ingests | Trivial — both ends already speak WS |
| **B. File-bridge** | vessel-agent writes NDJSON to a watched dir; Trinity tails it | Useful when WS isn't viable (e.g. cloud-edge split) |
| **C. Shared SQLite/Parquet** | vessel-agent writes Parquet; Trinity reads via DuckDB | Best for retrospective analysis; the in-memory ring buffer is for *live* cognitive work |

This repo implements **A** today (it ships a mock; swapping for real
vessel-agent is a configuration change). **B** and **C** are designed for
but not implemented — they're future work.

---

## 3. The BMAD level mapping

vessel-agent's 5-level BMAD framework maps cleanly onto Trinity's
components:

| BMAD Level | vessel-agent component | Trinity component | Hand-off |
|-----------:|------------------------|-------------------|----------|
| **L0 Raw Bits** | `capture/network_capture.py`, BPF filters, ring buffer | `mockSignalK.js`, `ringBuffer.js` | packet → typed-array |
| **L1 Physical Tensors** | `NMEAInterpolator`, Sv dB normalization, H3 indexing | `telemetryIngest.js`, H3 helper | scalars → feature vector |
| **L2 Analytical Features** | `AnalysisAgent`, biomass density, species classifier | `jepaWorldModel.js` | feature vector → embedding + energy |
| **L3 Operational Intelligence** | `SupervisorAgent`, catch predictions | `llmNarrator.js` + A2A actions | embedding + prose → decisions |
| **L4 Strategic Knowledge** | `Stock Assessment`, ecosystem analysis | `vectorStore.js` + crew reports | fleet patterns → strategic context |

**Key insight from LeCun's JEPA framing**: vessel-agent's L2 models are
*discriminative* (classify this ping as chum vs sockeye). Trinity's JEPA
world model is *generative* (predict what the next frame should look like
and flag mismatches). The two complement each other: vessel-agent says
*"this looks like chum"*; Trinity says *"the predicted trajectory says
chum here, but reality says sockeye — energy=0.7, flag anomaly"*.

---

## 4. Concrete synergy deliverables in this repo

This section tracks what's been built (✅), what's in progress (🔄), and what
remains (⏳) on the integration path.

### ✅ Already shipped

- **`mockSignalK.js`** — synthetic vessel trajectory broadcasting Signal K
  deltas at 2 Hz. Drop-in replacement for a real Signal K server.
- **`telemetryIngest.js`** — WebSocket consumer with hello-handshake,
  exponential-backoff reconnect, and structured frame parsing.
- **`ringBuffer.js`** — pre-allocated `Float64Array` ring buffer
  (256 × 6 = 12 KB) ready for ML ingestion, zero per-frame allocation.
- **`jepaWorldModel.js`** — predictive world model emitting
  `energy ∈ [0, 1]`. Energy > 0.5 = anomaly.
- **`llmNarrator.js`** — split-track LLM output (prose + `<a2a>...</a2a>`)
  with emergency-header override on anomaly.
- **`trinityCore.js`** — orchestrator that pulls from the ring buffer every
  500 ms, feeds JEPA, and routes peaceful prose vs emergency A2A actions.
- **`vectorStore.js`** — in-memory cosine/dot/L2 store with text + vector
  ingest and `EmbeddingRetriever` ready to drop in for the LLM context.
- **`schemas.js`** — validators for A2A actions, JEPA energy, feature
  vectors, and the new vessel-agent core anchor.
- **`backend/a2aLog.js`** — append-only JSONL audit log with replay,
  rotation, and corruption tolerance. The durability layer for the
  bridge's idempotency and replay-on-reconnect.
- **`backend/a2aBridge.js`** — WebSocket fanout on `ws://127.0.0.1:3002`.
  Monotonic action IDs, replay-on-connect via `lastAckId`, persisted
  `ack` checkpoints, ping/pong liveness. The L3 → L4 delivery seam.
- **`backend/a2aClient.js`** — typed-style WS client. Hello handshake,
  monotonic action IDs, auto-reconnect with exponential backoff, manual
  `requestReplay`. The consumer side, ready to drop into Theia.
- **`docs/PHASE5.md`** — canonical phase-5 reference: protocol, env
  vars, run-time knobs, and forward work.
- **`backend/h3.js`** — pure-JS H3-like indexer for lat/lon → uint64 hex
  (lightweight; full H3 compat can swap in via `h3-js` later).
- **`backend/vesselAgentAdapter.js`** — schema-bridge that normalizes both
  Signal K deltas *and* vessel-agent triply-anchored updates into a single
  internal frame shape.
- **`schemas.js`** — adds `validateVesselAnchor()` and `validateTrinityDelta()`.
- **`shared/events.js`** — adds `crew_report`, `fleet_report`, `anomaly`,
  `workspace_morph` events.
- **`docs/SYNERGY.md`** — this document.
- **README.md** — cross-link to vessel-agent.

### ⏳ Future work (clearly scoped seams)

- **Real vessel-agent → WS bridge** (Python `websockets` server publishing
  the trinity delta format). One file, ~80 lines.
- **`h3-js` integration** for production-grade H3 resolution (current
  helper is a quantized-grid approximation good enough for marine scale).
- **Parquet log writer** for A2A actions (`workspace_morph` history becomes
  audit log)
- **DuckDB read-side adapter** for retrospective A2A replay from archived
  features
- **Theia extension** that actually consumes A2A `<a2a>` blocks and mutates
  the workspace. The server-side `a2aBridge.js` and the typed client
  `a2aClient.js` are both shipped; what's missing is the Theia-side
  consumer that calls `panel.mutate(action)` on every received action
  (see `docs/PHASE5.md` for the exact API surface).

---

## 5. Schema bridge reference

`backend/vesselAgentAdapter.js` is the canonical normalizer. Both Signal K
deltas and vessel-agent core_anchor updates flow through it and produce
the same internal `TrinityFrame`:

```
TrinityFrame {
  timestampNs:    BigInt        // nanosecond anchor (preferred)
  timestamp:      string        // ISO-8601 (human-readable mirror)
  source: {
    vesselUuid:     string
    hardwareSource: string
    pipelineVersion: string
  },
  navigation: {
    latitude:       number      // degrees
    longitude:      number      // degrees
    speedOverGround: number     // knots
    headingTrue:    number      // degrees
  },
  environment: {
    depthBelowTransducer: number // meters
  },
  spatial: {
    h3Index:        string      // hex string (uint64)
  },
  crewReport?: {
    transcript:     string
    confidence:     number
  },
  fleetReport?: {
    sourceVessel:   string
  },
  trajectoryProgress: number   // 0..1, optional ground-truth label
  currentWaypoint:   string    // optional
}
```

This is the one shape every downstream module (ring buffer, JEPA, narrator,
vector store) speaks. Adding a new vessel-agent field means adding one line
to the adapter; everything downstream stays untouched.

---

## 6. Operating both systems together

### Development (this repo, mock data)

```bash
npm start              # brings up the full daemon with mock Signal K + Ollama
npm test               # runs all 6 test suites
```

### Production (vessel-agent upstream)

```bash
# On the boat workstation (Linux, 8 GB RAM, no internet)
python capture_daemon.py run &           # captures & writes to Parquet

# Same host (or cloud bridge):
python vessel_agent_ws_bridge.py \      # tiny ~80-line script, ships with vessel-agent
  --upstream tcp://localhost:5555 \
  --downstream ws://localhost:3000

# Trinity daemon subscribes & narrates:
CLOUD_LLM_BASE_URL= npm start
```

### Cloud-split deployment

For slow-link boats, vessel-agent runs the WS bridge with a queue:

```bash
python vessel_agent_ws_bridge.py \
  --queue sqlite:///var/lib/vessel-agent/outbox.db \
  --downstream wss://trinity.example.com/ingest
```

The `telemetryIngest.js` already supports `wss://` URLs out of the box (the
`ws` library handles TLS).

---

## 7. Migration path from Signal K → full vessel-agent

| Phase | Signal K fields | vessel-agent fields | Status |
|-------|-----------------|---------------------|--------|
| **Phase 1** (today) | `navigation.*`, `environment.*` | — | ✅ |
| **Phase 2** | + `meta.*` (trajectoryProgress, waypoint) | — | ✅ |
| **Phase 3** | as above | + `spatial.h3Index`, `source.vessel_uuid` | 🔄 this update |
| **Phase 4** | as above | + `crew_report.*`, `fleet_report.*` | 🔄 this update |
| **Phase 5** | — | full `core_anchor` + acoustic tensor | ⏳ |
| **Phase 5.5** | — | A2A bridge (WebSocket fanout + replay + ack) | ✅ shipped |
| **Phase 5.6** | — | A2A client (typed, reconnect, manual replay) | ✅ shipped |

Each phase is backward-compatible: the Signal K consumer keeps working; new
fields simply unlock new cognitive features (H3-based spatial clustering,
crew-report correlation, fleet intelligence).

---

## 7.5 The L3 → L4 seam: the A2A bridge

The cognitive engine's job is to decide what should happen next. The
workspace's job is to make it visible. The bridge between them is the
**A2A WebSocket protocol** — the smallest possible contract that lets
the LLM's `<a2a>...</a2a>` blocks (emitted at L3) mutate the workspace
(at L4) without either side knowing the other's internals.

### Why a bridge, not a direct coupling

The cognitive engine and the workspace evolve at different cadences:

- The cognitive engine may swap LLM backends (Ollama today, cloud tomorrow),
  change prompt strategy, or add new action types.
- The workspace may swap UI frameworks (Theia today, something else tomorrow).

A direct call (`trinity_narrator.morphToHazardMode(panel)`) would couple
both ends to each other's lifetime. A WebSocket bridge lets each side
restart, crash, or be replaced independently. The protocol is the API.

### The protocol in one paragraph

A single WebSocket endpoint on `ws://127.0.0.1:3002` carries **text JSON
frames only**. The server is authoritative for action IDs (monotonic,
strictly increasing). Clients send a `hello` on connect with their
`lastAckId`; the server replays any gap from the JSONL audit log, then
transitions to live broadcast. Clients send `ack` messages to checkpoint
idempotency. Periodic `ping`/`pong` frames keep the connection warm;
silent clients are dropped after 3 missed pongs.

### vessel-agent ↔ Trinity flow across the bridge

```
vessel-agent (Python)            trinity-marine-station (Node)
─────────────────────            ─────────────────────────────
BPF + ring buffer
  └─ Parquet
       └─ ZeroMQ agent bus
            └─ core_anchor JSON
                 │
                 │  (NEW: WS bridge)
                 ▼
                                  telemetryIngest on :3000
                                    └─ TrinityFrame
                                         └─ JepaWorldModel
                                              └─ LlmNarrator
                                                   └─ <a2a>...</a2a>
                                                        │
                                                        ▼
                                                   a2aLog (JSONL)        ← durability
                                                        │
                                                        ▼
                                                   a2aBridge on :3002    ← delivery
                                                        │
                                                        │  text JSON over WS
                                                        ▼
                                                   a2aClient in Theia    ← mutation sink
                                                        │
                                                        ▼
                                                   Theia panels mutate
                                                   (morph_to_hazard_mode,
                                                    raise_alert, etc.)
```

The bridge is the **only** seam that crosses the L3/L4 boundary. Every
component above L3 stays in Node; every component below L4 stays in
Eclipse Theia. The audit log on disk is the **durable handoff** —
recovering from a missed message is just `client.requestReplay()`.

### Three guarantees that come for free

| Guarantee | Mechanism |
|-----------|-----------|
| **No duplicate application** | Server stamps every action with a monotonic `id`; client tracks `lastAckId`; replay only sends `id > lastAckId`. |
| **No lost actions on reconnect** | Client sends `lastAckId` in the `hello` handshake on (re)connect; bridge replays the gap from the persisted log, then resumes live. |
| **Liveness under load** | Server sends pings every 15s; client must respond with pongs within 45s or be terminated (backpressure). |

### What this means for the vessel-agent integration

The vessel-agent side doesn't need to talk to Theia directly. It only
needs to ensure the **right side of the curtain** is healthy:

1. `trinity_agent_daemon` is running with `BRIDGE_PORT=3002` (default).
2. The Theia workspace has an `A2aClient` connected to `ws://localhost:3002`.
3. vessel-agent's data is flowing into Trinity's `telemetryIngest` (the
   L0/L1 boundary we've already shipped).

That's the entire integration contract. Everything else — JEPA scoring,
LLM narration, action validation, panel mutation — is internal to one
side or the other.

### Sources of truth

- **Wire protocol details** (handshake, error envelopes, replay semantics):
  [`docs/PHASE5.md`](PHASE5.md).
- **Run-time knobs** (env vars, port collision, shutdown order):
  [`docs/OPERATIONS.md`](OPERATIONS.md).
- **Implementation**: `backend/a2aBridge.js` (server), `backend/a2aClient.js`
  (client), `backend/a2aLog.js` (durable log).

---

## 8. Why this design is durable

1. **The wire format is a strict superset** of Signal K. Existing producers
   (and existing tests) keep working unchanged.
2. **The internal frame shape is the single contract** between adapter,
   ring buffer, JEPA, narrator, and vector store. Adding fields doesn't
   ripple.
3. **The cognitive engine is transport-agnostic.** Swap Signal K for
   Parquet-tail, for HTTP polling, for ZeroMQ — only the adapter changes.
4. **BMAD levels compose.** L0 vessel-agent raw → L1 vessel-agent
   normalized → L1.5 Trinity ingest → L2 Trinity JEPA → L3 Trinity
   narrator → L4 Trinity strategy. No level is skipped.
5. **LeCun's JEPA principle is honored**: the world model is generative
   and predictive; the LLM is a *narrator on top*, not the primary
   reasoner.

---

*This document is the canonical integration reference. Update it whenever
the integration boundary moves.*