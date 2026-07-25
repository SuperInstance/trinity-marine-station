# Trinity Marine Station — Phase 1

> Agentic-first marine navigation station. Phase 1 lays the **sensory ingestion foundation** before any AI is bolted on.

## Folder layout

```
trinity-agent/
├── backend/                  ← Signal K data layer (this phase)
│   ├── marineConstants.js    ← Shared schema, trajectory, depths, ports
│   ├── navigationSimulator.js← Pure stateful world simulator
│   ├── mockSignalK.js        ← WebSocket broadcaster (port 3000)
│   └── telemetryIngest.js    ← (Step 3 — coming next)
├── frontend/                 ← Theia extension boilerplate (Phase 3)
├── cognitive-engine/         ← JEPA + LLM (Phase 2)
├── tests/                    ← Sanity verification
│   ├── streamer.smoke.js
│   └── streamer.payloadShape.js
└── package.json
```

## What runs in Phase 1

| Script              | Purpose                                                       |
|---------------------|---------------------------------------------------------------|
| `npm run streamer`  | Spawns the mock Signal K WebSocket server on `ws://127.0.0.1:3000` |
| `node tests/streamer.smoke.js` | Boots the streamer, validates 6 heartbeats, tears down  |

## Wire protocol (Signal K delta)

Every 500 ms, the server broadcasts a JSON envelope:

```json
{
  "context": "vessels.self",
  "updates": [{
    "timestamp": "ISO-8601",
    "values": [
      { "path": "navigation.position",                  "value": { "latitude": 37.82, "longitude": -122.52 } },
      { "path": "navigation.speedOverGround",           "value": 5.72 },
      { "path": "navigation.headingTrue",               "value": 39.07 },
      { "path": "environment.depth.belowTransducer",    "value": 31.93 },
      { "path": "meta.trajectoryProgress",              "value": 0.01 },
      { "path": "meta.currentWaypoint",                 "value": "Golden Gate Approach" }
    ]
  }]
}
```

Immediately on connect, the server sends a `{ "type": "hello" }` frame so consumers can confirm protocol version.

## Architectural notes

- **`navigationSimulator.js` is transport-agnostic** — it has no WebSocket knowledge. This is deliberate so the JEPA world-model in Phase 2 can reuse it for counterfactual rollout.
- **Backpressure**: if any client's TCP send buffer exceeds `MAX_CLIENT_BACKLOG * payloadBytes`, the server terminates that socket instead of letting the broadcast fall behind real time.
- **Heartbeat is dt-aware**: we measure real elapsed ms between ticks and feed that to the simulator so the world model stays in sync even if Node's timer ever jitters.
- **Trajectory is a closed loop** of 6 waypoints along the SF Bay shoreline. After reaching "Marina Green Flats" the vessel teleports back to "Golden Gate Approach" and the depth field resets.

## Next steps (Phase 1 continuation)

- [ ] `backend/telemetryIngest.js` — pre-allocated ring buffer, fixed-layout `Float64Array` feature vector
- [ ] `tests/pipeline.test.js` — automated end-to-end verification of the ingestion pipeline