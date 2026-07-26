# Trinity Live-Path Sequence

> **Audience:** future agent builders and successor sessions who need to
> reason about *what happens between a Signal K update arriving and a
> Theia UI pixel changing*. The repo has dozens of small modules; this
> document stitches them into the single linear chain they form when the
> daemon is running.

This is a complement to `ARCHITECTURE.md` (which describes each module
in isolation) and `SYNERGY.md` (which describes the philosophical
coupling). This document is for the *runtime* graph: who hands what to
whom, in what order, with what back-pressure and what failure modes.

## TL;DR

```
Signal K ─► TelemetryIngest ─► RingBuffer
                                    │
                                    ▼
                            JepaWorldModel (tick)
                                    │
                  energy (peaceful) │ energy (anomalous)
                                    ▼
                          EmbeddingRetriever ─┐
                                              │
                                            TrinityCore
                                              │
                                ┌─────────────┼─────────────┐
                                ▼             ▼             ▼
                            prose         a2a           anomaly
                            (stdout)      (event)       (event)
                                              │
                                  ┌───────────┴───────────┐
                                  ▼                       ▼
                              A2aLog                A2aBridge ─► A2aClient (Theia)
                          (logs/a2a/*.jsonl)
```

The four output branches (prose, a2a, anomaly, tick) all flow from the
single TrinityCore loop, which ticks every `intervalMs` (default 500 ms)
against the latest frame in the ring buffer.

---

## Step 1 — Source: `mockSignalK.js` or external Signal K

`backend/mockSignalK.js` runs an embedded WebSocket server on
`STREAMER_HOST:STREAMER_PORT` (default `127.0.0.1:10110`) when
`STREAMER_EMBED=true` is set (the daemon default). It synthesizes a
navigation stream: lat/lon drift, SOG/HDG wiggles, depth, and the
occasional "hazard" or "shallow" anomaly.

To attach to a real Signal K server instead, set
`STREAMER_EMBED=false SIGNAL_K_URL=ws://your-host/signalk/v1/stream`.

The streamer emits Signal K *deltas*: small JSON envelopes whose
`updates[]` array carries navigation context-value pairs. Format
reference: Signal K specification.

## Step 2 — Wire: `telemetryIngest.js`

`TelemetryIngest` connects to the WebSocket, performs the Signal K hello
handshake, parses each delta into a `TrinityFrame` (a fixed 6-float
vector plus optional `vessel-agent` provenance fields — see
`schemas.js` `validateTrinityFrame`), and:

1. pushes the frame into its internal `RingBuffer` (capacity
   `RING_CAPACITY`, default 256)
2. emits `EVENTS.INGEST_FRAME` for any side-channel listeners

It also handles reconnection with exponential back-off (the
`INGEST_RECONNECTING` event fires on each attempt). On malformed JSON
it emits `INGEST_MALFORMED` and continues; it does *not* crash on
single-message errors.

The ring buffer is the *only* state shared between ingest and the
cognitive layers. There is no message queue between them.

## Step 3 — Cognition: `jepaWorldModel.js`

On each tick (driven by `TrinityCore`, not by ingest), the JEPA world
model consumes the latest frame plus a small history window, computes
a predictive-energy score, and classifies the tick as
`peaceful` / `anomalous`.

Outputs:
- always: `JEPA_ENERGY` (`{score, anomaly: bool, reason}`) via core
- on anomaly: also `JEPA_ANOMALY` (with full `JepaEnergyReading`)

The threshold is `ANOMALY_THRESHOLD` env var (unset ⇒ use module
default). The model is intentionally lightweight — see
`docs/JEPA.md` for the energy formulation.

If you want to add a new anomaly reason, this is the only file to
touch: add a branch, emit `JEPA_ANOMALY` with a new `reason` string,
and any downstream listener (narrator, UI, alerts) will receive it.

## Step 4 — Memory: `vectorStore.js`

`InMemoryVectorStore` + `EmbeddingRetriever` give the narrator a tiny
RAG memory. The daemon seeds two synthetic entries at boot (only when
the embedder is real — see `buildTrinity()` lines ~272–279):

```
"vessel on coastal approach, depth steady ~30 m"
"approaching Golden Gate, light fog, traffic moderate"
```

The retriever embeds the JEPA-derived query string on each narrator
generation, pulls the top-K (default 3) similar entries, and injects
them into the LLM prompt as `RetrievedContextChunk` objects.

When `MOCK_LLM=1` the retriever is bypassed (no real embedder
available). When the embedder throws (network blip, model down), the
retriever emits `narrator:degraded` and proceeds with no retrieval
context — the loop is non-blocking.

## Step 5 — Narration: `llmNarrator.js`

`LlmNarrator` runs on its own `setInterval` (default 4000 ms,
`NARRATOR_INTERVAL_MS`). Every tick it inspects the latest energy
reading and either:

- **peaceful path**: ask the LLM for a short prose summary
  ("We're holding course 215°, 6.2 knots, depth 34 m. Visibility good.")
- **anomaly path**: skip the quiet call entirely and force an
  *emergency* prompt ("HAZARD detected: shallow water ahead at 0.3 nm,
  recommend hard-a-starboard and slow to 3 knots.")

The LLM backend is chosen at boot by `createBackend()`:

| Condition | Backend | Model |
|-----------|---------|-------|
| `MOCK_LLM=1` | `MockLlmBackend` | n/a (deterministic) |
| `CLOUD_LLM_BASE_URL` + `CLOUD_LLM_MODEL` | `OpenAiCompatibleBackend` | cloud model |
| otherwise | `OllamaBackend` | `LOCAL_LLM_MODEL` (default `qwen3:4b`) |

Three output channels from the narrator:

1. **`NARRATOR_PROSE`** → forwarded by core as `prose` → daemon logs it
2. **`NARRATOR_A2A`** → forwarded by core as `a2a` → daemon + bridge listen
3. **`NARRATOR_MALFORMED`** → forwarded by core as `malformed` → daemon
   logs at ERR level (the LLM tried to emit A2A but the JSON was bad)

A circuit breaker (`backend/circuitBreaker.js`, 20 tests) sits in front
of the LLM call: after N consecutive failures it opens and refuses
calls for a cool-down, emitting `NARRATOR_DEGRADED` so the UI can show
"AI assistant temporarily offline" instead of hanging.

## Step 6 — Decision: `trinityCore.js`

`TrinityCore` is the **single ticker**. It runs `setInterval` at
`intervalMs` (default 500 ms) and, on each tick:

```
1. latest = ringBuffer.latest()            // from ingest
2. energy = jepa.observe(latest)            // energy reading
3. if energy.anomaly: emit("anomaly", ...)
4. else:             emit("peaceful", ...)  // for hooks
5. emit("tick", { frame, energy })          // for /status snapshot
```

The narrator is *not* driven by the core's tick. It runs on its own
timer (slower) and only consults the most recent tick when it fires.
This decoupling is deliberate — see `docs/ARCHITECTURE.md` §4.

`core.start()` begins the loop; `core.stop()` clears the interval and
emits `core:stopped`. Order in shutdown matters: see §Shutdown below.

## Step 7 — Branch A: Prose to stdout

```
narrator → "prose" → daemon logs [PROSE] tag → process.stdout
```

Used by humans tailing the daemon log and by any future log shipper.
No structured downstream consumer reads this; if you need prose in a
machine feed, listen for `NARRATOR_PROSE` from your own consumer.

## Step 8 — Branch B: A2A actions (the persistent branch)

This is the durable branch — every validated mutation lands in the
JSONL log and is available for replay forever.

```
narrator → "a2a" → core "a2a" → daemon (1) logs [A2A]
                                  (2) calls a2aLog.append(action)
                                  → sync-then-broadcast ensures
                                    disk write completes before
                                    any client receives it
```

**Why sync-then-broadcast matters:** Before commit `486c1e9` (Phase 6),
the bridge broadcast to live WebSocket clients *first* and persisted
*after*. A crash between those two steps left clients holding an
action ID that wasn't on disk for replay — so on reconnect the client
would ask "give me everything since 4711" and the server would say
"there's nothing since 4711". Now the order is reversed: the append
returns before any `ws.send()` runs. If the append fails the action
is **not** broadcast (and `stats.actionsDropped` increments). See
`tests/a2aBridge.test.js` "P6: ordering invariant" for the contract.

`A2aLog` writes to `A2A_LOG_DIR` (default `./logs/a2a`) as
date-stamped JSONL files (`a2a-2026-07-26.jsonl`, etc.). Each line is
one `A2AAction` with two added fields:

```json
{ "action": "morph_to_hazard_mode", "priority": 0.98,
  "reason": "JEPA anomaly", "_loggedAt": 1753571234567, "_seq": 4711 }
```

`_seq` is the monotonic replay cursor. Clients send `{type:"replay",
sinceId: N}` to receive every action from `N+1` onward.

For *retrospective* queries (not live), use `backend/a2aQuery.js`
(added Phase 6) — stream-parses the JSONL, supports `kind`, `action`,
time range, priority range, ID range, with `countBy`, `bucketBy`,
`topActions`, `summary`. 38 tests, no native deps.

## Step 9 — Branch C: The Theia transport (live fan-out)

```
              ┌── a2aLog.append(action) → JSONL ──┐
narrator ─► core ─► "a2a"                          │
                                  ┌── daemon ────┘
                                  │     (logs + bridge subscribes to core)
                                  ▼
                              A2aBridge (ws://bridgeHost:bridgePort)
                                  │
                                  ├─► A2aClient #1 (Theia extension)
                                  ├─► A2aClient #2 (CLI dashboard)
                                  └─► A2aClient #N (any WS client)
```

`A2aBridge` opens a WebSocket server on `BRIDGE_HOST:BRIDGE_PORT`
(default `127.0.0.1:3002`). On client connect it:

1. **hello handshake**: sends `{type:"hello", server, version,
   capabilities}` so the client can confirm protocol compat.
2. **optional replay**: if the client immediately sends
   `{type:"replay", sinceId: N}`, the bridge diffs `a2aLog` for
   everything with `_seq > N` and sends it as a batch followed by a
   `{type:"replay_end"}` marker.
3. **live fan-out**: from now on, every persisted action is delivered
   to every connected client. Acks (`{type:"ack", id}`) are persisted
   back to the log so future replays skip already-acknowledged items.
4. **heartbeat**: every `heartbeatMs` (default 15s) the bridge pings;
   clients that don't pong within `heartbeatTimeoutMs` are
   disconnected.

`A2aClient` (in this repo, for testing + future Theia consumer) wraps
the same flow in an EventEmitter: `connect`, `destroy`,
`requestReplay()`, `ack(id)`. It auto-reconnects with exponential
back-off (capped) and surfaces reconnect attempts as `reconnecting`
events for the UI to render.

Wire format is fully specified in `docs/a2a/SCHEMA.json` (JSON Schema
draft 2020-12) and demonstrated by `docs/a2a/EXAMPLES.jsonl` (9
canonical sessions). Cheat sheet at `docs/a2a/QUICKREF.md`.

## Step 10 — Ops HTTP: the read-only dashboard

The daemon runs a tiny HTTP server on `OPS_HOST:OPS_PORT` (default
`127.0.0.1:3001`). Three endpoints:

| Path | Returns |
|------|---------|
| `GET /` or `/status` | Full snapshot: ingest stats, jepa tick/anomaly counts, narrator stats, core stats, retriever size, a2aLog stats, a2aBridge stats, last frame |
| `GET /health` | `{ok: true, ts: <epoch_ms>}` — 200 |
| any other | `not found` — 404 |

This server is **not** for controlling the daemon — it's purely for
observability. Tools like `tools/smokeDaemon.js` use it to verify
boot. Future dashboards (Grafana JSON datasource, Theia status panel)
should consume `/status` on a polling interval.

---

## Shutdown order

```
SIGINT/SIGTERM
   ↓
1. core.stop()                  ← stops emitting tick/anomaly/a2a
2. narrator.destroy()            ← stops the slow LLM timer
3. ingest.disconnect()          ← closes upstream WebSocket
4. await bridge.stop()          ← flushes pending client writes
5. await a2aLog.destroy()       ← flushes the JSONL write buffer
6. stopOpsServer()              ← closes /status
7. stopStreamer()               ← kills embedded mockSignalK
```

Why this order matters:
- **bridge before log**: if the log dies first, a client ack that
  arrives during shutdown would fail to persist. Stopping the bridge
  first ensures no new acks arrive while the log is still alive.
- **log before everything else**: a2aLog has an internal write buffer
  (~100 ms batch). Destroying it flushes anything pending. Doing it
  *after* the bridge has stopped means the buffer only contains
  acks that arrived before shutdown began.

If you add new components, place them in this chain based on what
they depend on, not in source-file order.

---

## What can go wrong (failure modes worth knowing)

| Failure | Symptom | Where to look |
|---------|---------|---------------|
| Streamer port collision | `EADDRINUSE` on 10110 at boot | `STREAMER_PORT` env, or `Stop-Process` a stale daemon |
| Ingest never connects | `[ERR] ingest error ECONNREFUSED` repeating every back-off | `SIGNAL_K_URL` correctness, or streamer boot race (the daemon waits 400 ms but slow disks can lose that) |
| JEPA always peaceful | `anomalyCount` stays at 0 | `ANOMALY_THRESHOLD` may be too high; check `JEPARecentEnergies` in `/status` |
| LLM offline | `narrator:degraded` events, circuit breaker open | `OllamaBackend` reachable? `curl localhost:11434`; or set `MOCK_LLM=1` to unblock demos |
| Bridge port collision | `EADDRINUSE` on 3002 at boot | `BRIDGE_PORT` env, `Stop-Process` any node holding 3002 |
| Bridge never broadcasts | Clients connect but receive only `hello` | Check `core.on("a2a")` listener is wired (search `daemon.js` for `t.a2aBridge`); check `a2aLog` is appending |
| JSONL grows unbounded | Disk fills up over weeks | Use `a2aQuery.summary()` to size it; rotate by date (already done) or add size-based retention in `a2aLog.js` |
| Slow client stalls bridge | One Theia panel freezes, other clients see latency | Per-client write queue not yet implemented — Phase 6 candidate |

For each, the first stop is `/status` — it tells you which subsystem
last had activity.

---

## Related docs

- `docs/ARCHITECTURE.md` — module-by-module reference (what each
  class does in isolation, no runtime graph)
- `docs/SYNERGY.md` — the *why*: which subsystems need each other and
  where the seams are
- `docs/OPERATIONS.md` — operator-facing runbook (how to start, env
  vars, troubleshooting)
- `docs/PHASE5.md` — A2A bridge and client deep-dive (the seam
  between this repo and the Theia frontend)
- `AGENTS.md` — quick onboarding for new agents
- `docs/STATUS.json` — machine-readable state manifest (commit hash,
  test counts, file map)