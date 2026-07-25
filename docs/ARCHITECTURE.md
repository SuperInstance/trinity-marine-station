# Phase 1 Architecture — Design Deep-Dive

> Companion to `README.md`. This document explains **why** each module exists, the trade-offs considered, and the seams left open for Phase 2 (the JEPA cognitive engine).

---

## The big picture

Phase 1 delivers a **single, stable data path**:

```
real (or simulated) boat ──► Signal K delta JSON ──► typed-array feature vectors
```

Two hard constraints shaped the design:

1. **Zero per-frame allocation on the hot path.** GC pauses on a boat at 0300 are unacceptable.
2. **A typed-array interface ready for WebGPU/WASM upload.** Phase 2's JEPA encoder should be able to grab a `Float64Array` and feed it straight into a tensor pipeline.

Everything else is plumbing.

---

## Module-by-module

### `backend/marineConstants.js`

The single source of truth for everything domain-specific. Any other module that needs a port number, a trajectory waypoint, a depth envelope, or the canonical feature-vector layout reads it from here.

Key exports:

| Constant | Purpose |
|---|---|
| `TRAJECTORY_WAYPOINTS` | Six lat/lon points along the SF Bay shoreline. The vessel interpolates between them in a closed loop. |
| `INITIAL_DEPTH_METERS`, `FINAL_DEPTH_METERS` | Defines the bathymetry story: vessel runs from 32 m deep water into 1.8 m flats. |
| `STREAMER_HOST`, `STREAMER_PORT`, `HEARTBEAT_INTERVAL_MS` | Network/timing defaults — change here, change everywhere. |
| `FEATURE_VECTOR_LAYOUT` | The contract. `{ LATITUDE: 0, LONGITUDE: 1, …, VECTOR_DIM: 6 }`. Anyone producing or consuming a feature vector must respect these indices. |

**Design note:** `FEATURE_VECTOR_LAYOUT.VECTOR_DIM` is the dimension every buffer is sized against. Adding a new feature means bumping `VECTOR_DIM` *and* updating `FEATURE_VECTOR_NAMES` *and* both producer and consumer paths — a manual but deliberate friction so we never silently mismatch schemas.

---

### `backend/navigationSimulator.js`

A pure stateful class. `tick(dtMs) → snapshot`. Nothing else.

Why this exists as a separate module:

- The JEPA world-model (Phase 2) needs to **roll out** hypothetical futures. Having the simulator as a standalone class means the JEPA module can instantiate one, call `tick()` N times, and compare the predicted snapshot against the actually-observed snapshot from `telemetryIngest`.
- The simulator is **transport-agnostic**. The streamer (`mockSignalK.js`) doesn't know anything about how the simulator decides positions; it just calls `sim.tick()` and serializes the result. This makes swapping the simulator (e.g., for a recorded real-world trace) trivial.

State machine summary:

```
state: { lat, lon, speedKnots, headingDeg, depthMeters, segmentIdx, segProgress }

tick(dtMs):
  speed += randomWalk(speed)                       // 4.0..8.5 kt
  heading += randomWalk(heading)                   // wrap 0..360
  advance trajectory by dtMs/SECOND_PER_SEGMENT    // linear interp on waypoints
  depth = lowpass(depth, targetDepth(routeProgress) + jitter)  // 32..1.8 m
  return snapshot()
```

The depth is **low-pass filtered** toward the target depth to avoid sudden jumps when segment boundaries cross — this matters for the visual feel of any future bridge display.

---

### `backend/mockSignalK.js`

A `ws` WebSocket server on `127.0.0.1:3000`. Every 500 ms:

1. Advances the simulator by the real elapsed ms (not assuming a perfect cadence).
2. Serializes one Signal K **delta update** envelope.
3. Fans out to all clients with a backpressure guard.

The Signal K delta format we emit:

```json
{
  "context": "vessels.self",
  "updates": [{
    "timestamp": "ISO-8601",
    "values": [
      { "path": "navigation.position",                "value": { "latitude": 37.82, "longitude": -122.52 } },
      { "path": "navigation.speedOverGround",         "value": 5.72 },
      { "path": "navigation.headingTrue",             "value": 39.07 },
      { "path": "environment.depth.belowTransducer",  "value": 31.93 },
      { "path": "meta.trajectoryProgress",            "value": 0.01 },
      { "path": "meta.currentWaypoint",               "value": "Golden Gate Approach" }
    ]
  }]
}
```

This is a strict subset of the real Signal K delta schema. Phase 2/3 will likely add `notifications`, `meta.context`, etc. — the schema was chosen so we don't have to change producers when consumers grow.

**Hello handshake:** on every new connection, the server immediately sends:

```json
{ "type": "hello", "server": "mockSignalK", "version": "0.1.0-phase1", "heartbeatMs": 500 }
```

This is a tiny, deliberate departure from real Signal K (which serves an HTTP self-description doc on the upgrade), but it lets clients confirm protocol version without parsing a separate doc.

**Backpressure guard:**

```js
if (client.bufferedAmount > MAX_CLIENT_BACKLOG * payload.length) {
  client.terminate();
}
```

If a client's TCP send buffer grows beyond `MAX_CLIENT_BACKLOG * payloadSize` bytes, we assume it can't keep up and forcibly close the connection. Better to drop it than to let the broadcast fall behind real time.

---

### `backend/ringBuffer.js`

A pre-allocated, fixed-capacity ring buffer of `Float64` feature vectors.

Construction:

```js
const buf = new TelemetryRingBuffer({ capacity: 256 });
// Allocates one Float64Array of length 256 * 6 = 1536 doubles (~12 KB).
// This allocation happens ONCE per process lifetime.
```

Hot-path operations:

```js
buf.write(vec);    // ring slot index 0..255; overwrites oldest when full
buf.read(slot, out);   // copies frame into caller-supplied Float64Array (no alloc)
buf.latest();          // returns the most recent frame as a Float64Array (allocates 1×)
buf.snapshot(n);       // returns a contiguous chronological window (allocates 1×)
```

The **ring slot** index never decreases — it monotonically wraps at `capacity`. The `totalWrites` counter tracks lifetime writes. `snapshot()` knows how to splice around the wrap point so callers always get oldest-first ordering.

**Why a Float64Array and not a plain Array?**

- Single contiguous block of memory — friendly to WebGPU/WASM upload.
- No boxing of numbers — true IEEE-754 doubles.
- Fixed memory footprint, regardless of uptime. A 24-hour soak test allocates the same 12 KB as a 5-minute smoke test.

---

### `backend/telemetryIngest.js`

The consumer. Lifecycle:

```
connect()
   │
   ├── ws.on('open')    → _onOpen()      (resets reconnect counter)
   │
   ├── ws.on('message') → _onMessage()   (JSON.parse → unpackDeltaInto → ringBuffer.write)
   │
   ├── ws.on('close')   → _onClose()     (schedule reconnect OR exit if disconnect())
   │
   └── ws.on('error')   → _onError()     (suppressed ECONNREFUSED during reconnect storm)
```

`unpackDeltaInto(update, outVec)` is the schema-mapping hot path. It iterates the Signal K `values` array once and writes the five scalars into the fixed-layout `outVec`:

| `outVec` index | Signal K path                              |
|---:|--------------------------------------------|
| 0 | `navigation.position.latitude`             |
| 1 | `navigation.position.longitude`            |
| 2 | `navigation.speedOverGround`               |
| 3 | `navigation.headingTrue`                   |
| 4 | `environment.depth.belowTransducer`        |
| 5 | `meta.trajectoryProgress`                  |

Returns `false` if any required field is missing — `telemetryIngest` increments `stats.droppedFrames` and continues.

**Standalone vs embedded:**

- `node backend/telemetryIngest.js` runs with `{standalone: true}` and prints one human-readable line per frame.
- Importing `TelemetryIngest` elsewhere and constructing it lets the cognitive engine subscribe to `'frame'` events without any logging interference.

**Reconnect policy:**

```
delay_ms = RECONNECT_DELAYS_MS[min(attempt, 4)]
        = 500, 1000, 2000, 4000, 8000, 8000, …
```

Bounded so a hung CI doesn't retry forever. The ingest emits a `'reconnecting'` event every attempt for ops dashboards; the standalone mode logs only the first attempt to avoid log spam.

---

## What's NOT in Phase 1 (deliberate omissions)

These are intentionally absent because they belong to later phases:

- ❌ Authentication / TLS. The streamer binds `127.0.0.1` only — adequate for a single-vessel loopback bridge. Production deployment will need TLS + Signal K access control.
- ❌ Schema versioning. Right now we hardcode path strings. Phase 3 will introduce a versioned protocol.
- ❌ Persistence. Nothing is written to disk. Phase 2 may add a rotating log of feature vectors for offline JEPA training.
- ❌ Any actual AI. The whole point of Phase 1 is to be the bedrock *under* the AI.

---

## What Phase 2 will plug into

| Phase 1 seam | How Phase 2 uses it |
|---|---|
| `TelemetryRingBuffer.snapshot(n)` | The JEPA encoder samples windows of historical frames for supervised prediction loss. |
| `TelemetryIngest.on('frame', vec)` | The embedding memory module subscribes here to maintain a vector-index of "scenes". |
| `NavigationSimulator.tick()` | The JEPA world-model rolls out hypothetical trajectories to compare against actual observed frames. |
| `TelemetryIngest.stats` | The LLM narrator consults these to write "stream-of-consciousness" markdown updates for the bridge display. |---

# Phase 3 Architecture — The Conscious Narrator + JEPA

> **Added in v0.2.0.** Phase 1 (sensory ingestion) is unchanged. This section documents the cognitive engine that reads from Phase 1's ring buffer and emits A2A mutations for the future Theia frontend.

## Why a JEPA + LLM pair?

Yann LeCun's JEPA architecture argues for a *world model* that operates in embedding space, predicting future latent states from past ones, with a small LLM only synthesizing the result as natural language. We follow that recipe:

- **JepaWorldModel** — a linear predictor over 6-D feature vectors. Cheap (one matrix multiply per tick). Emits an *energy score* (prediction error normalized to [0,1]). Energy > 0.5 = anomaly.
- **LlmNarrator** — only asks the LLM when there's something to say. Normal-mode is throttled to 4 s; anomaly-mode fires immediately and aborts any in-flight generation.
- **LlmBackend** interface — today backed by `HttpLlmBackend` (Ollama at 127.0.0.1:11434). Tomorrow, swap in any OpenAI-compatible service with zero changes to the narrator.

## The conscious narrator (`backend/llmNarrator.js`)

### Stream splitter

The narrator doesn't try to constrain the LLM via grammar or function-calling. Instead it streams freely and *peels* the output as it arrives:

- Anything outside `<a2a>...</a2a>` is **prose** (markdown for the bridge display).
- Anything inside is held until the closing tag, then JSON.parse'd and validated against an allow-list of action names.
- The splitter is allocation-light: a small `tail` buffer prevents tags from being split across chunks.

### Emergency mode

When `TrinityCore` sees an anomaly it calls `narrator.forceEmergency(ctx)` which:

1. Aborts any in-flight normal generation (5 ms grace).
2. Issues a new request with `EMERGENCY_SYSTEM_PROMPT` (different from the default).
3. Forces a 200-token budget and `think: false` so reasoning models (qwen3, deepseek-r1) return the answer directly instead of spending the budget on internal monologue.

### The `<a2a>` schema

```json
{
  "action":  "morph_to_hazard_mode",
  "payload": { "id": "hazard-console" },
  "reason":  "depth plunge to 1.2 m",
  "priority": 0.98
}
```

Allowed actions (allow-list in `ALLOWED_ACTIONS`):

- `morph_to_hazard_mode` / `morph_to_navigation_mode` / `morph_to_engineering_mode` — switch the Theia workspace layout.
- `highlight_waypoint` — focus a chart marker.
- `raise_alert` / `clear_alerts` — manage notification stack.
- `set_panel_focus` — open a specific panel by id.
- `announce` — voice/TTS output.

## The JEPA world model (`backend/jepaWorldModel.js`)

A deliberately tiny model: a 6×6 linear transform + EMA-updated identity. Each tick it predicts the next feature vector from the previous one and computes the L2 distance to the observed vector, normalized into [0,1] by a running max-distance estimate.

This is enough to flag "something changed faster than expected" without any training. Future phases will swap the linear predictor for a proper JEPA encoder (probably a small transformer trained on recorded telemetry) and replace the energy score with the encoder's prediction error in embedding space.

## The orchestrator (`backend/trinityCore.js`)

```js
setInterval(() => {
  const vec = ringBuffer.latest();
  const energy = jepa.observe(vec);
  if (energy.anomaly) narrator.forceEmergency({ featureVector: vec, energy, retrieved: [] });
  else                narrator.maybeGenerate({ featureVector: vec, energy, retrieved: [] });
}, 500);
```

Pulls the latest frame from the ring buffer every 500 ms, runs it through JEPA, and branches. `peacefulCount` and `emergencyCount` stats are exposed on the instance for the test harness.

## LLM backend swapping

The narrator depends only on the `LlmBackend` interface. To move from local Ollama to a cloud provider, write a `class OpenAiCompatibleBackend` that implements `generate/embed/listModels/dispose` and pass it to `new LlmNarrator({ backend })`. The narrator, splitter, parser, and orchestrator are unchanged.

## Verified end-to-end

```
[run.js] running 3 test file(s):
[run.js]   • ollama.smoke.test.js
[run.js]   • pipeline.test.js
[run.js]   • trinityLifecycle.test.js

[ollama.smoke]      ✅ OLLAMA SMOKE TEST PASSED   (real qwen3:4b + nomic-embed-text)
[pipeline]          ✅ PHASE 1 PIPELINE VERIFIED  (11 checks)
[trinityLifecycle]  9 pass / 0 fail               (static driver + live WS)
[run.js]            ✅ ALL TESTS PASSED
```
