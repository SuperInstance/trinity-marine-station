# Operations & Run Modes

This document is the runbook for the **trinity-marine-station** daemon — every
way to start it, every environment variable it understands, and what to do
when it misbehaves. Pair this with [`ARCHITECTURE.md`](./ARCHITECTURE.md)
(which describes *why* each piece exists) and [`TESTING.md`](./TESTING.md)
(which describes how each piece is verified).

---

## 1. Quick-start (the 90-second tour)

```bash
# 1. Make sure dependencies are installed (only ws is required).
npm install

# 2. Run the whole Trinity in one process. The daemon:
#    - starts an embedded mock Signal K streamer on port 3000,
#    - connects the telemetry ingest,
#    - feeds the JEPA world model + LLM narrator + vector retriever,
#    - exposes /health and /status on http://127.0.0.1:3001,
#    - and serves the A2A WebSocket bridge on ws://127.0.0.1:3002 for
#      Phase 5 frontend consumers (Theia extension, dashboards).
npm start

# 3. In a second terminal, watch what is happening:
curl http://127.0.0.1:3001/status | jq

# 4. In a third terminal, run the test suite (uses Ollama if available;
#    otherwise everything falls back to the deterministic MockLlmBackend).
npm test
```

You should see on the daemon side:

```
[LIFE] trinity daemon starting source="local ollama model=qwen3:4b" ...
[LIFE] ingest open url="ws://127.0.0.1:3000"
[LIFE] streamer hello server="mockSignalK" v="0.1.0-phase1"
[TICK] frame lat=37.8196 lon=-122.5187 sog=5.34kt ... energy=0.0000
...
```

---

## 2. The four entry points

| Script                     | What it does                                                                   |
|----------------------------|--------------------------------------------------------------------------------|
| `npm start` / `npm run dev` | Runs `backend/trinityDaemon.js` — full stack, one process.                     |
| `npm run streamer`          | Runs only `backend/mockSignalK.js` on port 3000.                                |
| `npm run ingest`            | Runs only `backend/telemetryIngest.js` against the local streamer.              |
| `npm run narrator`          | Runs only `backend/llmNarrator.js` against the local streamer.                  |
| `npm run daemon`            | Same as `npm start` (explicit alias for `trinityDaemon.js`).                    |

The four entry points are independently useful for debugging — start only the
streamer when you want to point a third-party Signal K client at it, or only
the ingest when you want to test the JEPA layer against a synthetic trace.

---

## 3. Run modes (LLM backend selection)

The narrator chooses its backend at boot via `createBackend()` in
`backend/llmNarrator.js`. The decision is purely env-var driven so you can
swap backends with no code changes:

| Env var(s) set                                              | Backend chosen                  |
|-------------------------------------------------------------|----------------------------------|
| _none of the below_                                         | **HttpLlmBackend** → local Ollama |
| `MOCK_LLM=1`                                                | **MockLlmBackend** → deterministic, offline |
| `CLOUD_LLM_BASE_URL=...` `CLOUD_LLM_MODEL=...`               | **OpenAiCompatibleBackend** → any OpenAI-shape endpoint |

### 3a. Local Ollama (default)

```
LOCAL_LLM_MODEL     qwen3:4b              # generation model
LOCAL_LLM_EMBED     nomic-embed-text:latest # embedding model
OLLAMA_HOST         127.0.0.1             # default
OLLAMA_PORT         11434                 # default
```

If you have a beefier GPU and want better prose, bump the model:

```bash
LOCAL_LLM_MODEL=gemma4:12b npm start
```

### 3b. Cloud (OpenAI-compatible)

```
CLOUD_LLM_BASE_URL  https://api.openai.com
CLOUD_LLM_API_KEY   sk-...
CLOUD_LLM_MODEL     gpt-4o-mini
```

Works with any service that speaks the `/v1/chat/completions` protocol:
OpenAI, Together, Groq, Anyscale, OpenRouter, vLLM, LM Studio (OpenAI mode),
and llama.cpp's HTTP server. The backend streams SSE chunks through the same
`StreamSplitter` and `parseAndValidateA2A` pipeline used locally.

### 3c. Mock backend (tests + offline demo)

```
MOCK_LLM=1
```

The MockLlmBackend emits a deterministic short prose paragraph + one
well-formed `<a2a>...</a2a>` JSON block per generation. Used by all unit tests
and by `npm run test:daemon` so the test suite works in CI without a GPU.

---

## 4. Other environment variables

| Var                       | Default                | Meaning                                                  |
|---------------------------|------------------------|----------------------------------------------------------|
| `STREAMER_EMBED`          | `true`                 | Embed the mock Signal K streamer inside the daemon.      |
| `SIGNAL_K_URL`            | `ws://127.0.0.1:3000`  | Streamer URL when `STREAMER_EMBED=false`.                |
| `ANOMALY_THRESHOLD`       | `0.50`                 | Energy score above this triggers emergency narration.    |
| `NARRATOR_INTERVAL_MS`    | `4000`                 | Throttle between peaceful prose generations.             |
| `RING_CAPACITY`           | `256`                  | Frames retained in the sensory ring buffer (~128 s).     |
| `OPS_HOST`                | `127.0.0.1`            | Bind address for the ops HTTP server.                    |
| `OPS_PORT`                | `3001`                 | Port for `/health` and `/status`.                        |
| `A2A_LOG_DIR`             | `./logs/a2a`           | Directory for the A2A audit log (JSONL). Auto-created.   |
| `A2A_LOG_MAX_BYTES`       | `10485760` (10 MB)     | Rotate the active log file when it exceeds this size.    |
| `A2A_LOG_DISABLED`        | `false`                | Set `1` to disable the audit log (ephemeral tests).      |
| `BRIDGE_HOST`             | `127.0.0.1`            | Bind address for the A2A WebSocket bridge (Phase 5).     |
| `BRIDGE_PORT`             | `3002`                 | Port for the A2A WebSocket bridge.                       |
| `BRIDGE_DISABLED`         | `false`                | Set `1` to disable the bridge (e.g. when running only the audit log). |

---

## 5. The ops HTTP server

`GET /health` → `200 {"ok":true,"ts":<ms>}` — liveness probe.
`GET /status` → `200 <full snapshot JSON>` — everything you need to debug.

Sample `/status` shape (real fields may grow):

```json
{
  "ts": 1753406400000,
  "ingest": { "connected": true, "stats": { "framesReceived": 256, "reconnectCount": 0 } },
  "jepa":   { "tickCount": 256, "anomalyCount": 1, "recentEnergies": [...] },
  "narrator": { "totalGenerations": 64, "a2aActionsEmitted": 1, ... },
  "core":   { "running": true, "peacefulCount": 63, "emergencyCount": 1, ... },
  "retriever": { "size": 2 },
  "lastFrame": { "frame": [37.81, -122.50, 5.0, 90, 1.2, 0.5], "energy": { ... } }
}
```

The `lastFrame` is the most recent 6-D feature vector with its JEPA energy
attached — useful for "what just happened" triage.

### 5b. The A2A WebSocket bridge

In addition to the HTTP `ops` server, the daemon also serves a WebSocket
endpoint on `ws://${BRIDGE_HOST}:${BRIDGE_PORT}` (default
`ws://127.0.0.1:3002`). This is **Phase 5** — the transport that lets an
external consumer (the Eclipse Theia extension, a dashboard, or a headless
test harness) receive the same `A2AAction` stream that the cognitive engine
emits, durably, and replay-safe.

The protocol is documented in detail in [`docs/PHASE5.md`](./PHASE5.md) and
implemented in `backend/a2aBridge.js` (server) and `backend/a2aClient.js`
(client). At a glance:

| Frame type    | Direction       | Purpose                                                 |
|---------------|-----------------|---------------------------------------------------------|
| `hello`       | bridge → client | Handshake on connect. Carries `last_action_id`.         |
| `action`      | bridge → client | A validated workspace mutation with a monotonic `id`.   |
| `replay_end`  | bridge → client | Marks the end of a gap-fill replay.                     |
| `ack_ok`      | bridge → client | Ack was persisted.                                      |
| `pong`        | bridge → client | Heartbeat response.                                     |
| `error`       | bridge → client | Protocol / schema violation (with `code` + `errors[]`).  |
| `ack`         | client → bridge | "I've durably applied action id N."                      |
| `replay`      | client → bridge | "Replay every action with id > N."                       |
| `ping`        | client → bridge | Liveness probe.                                         |

**Quick smoke test** — once the daemon is running:

```bash
# In Node:
node -e "
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:3002');
  ws.on('message', (b) => console.log(b.toString()));
"
```

You should see a `hello` envelope within a few hundred milliseconds. Any
`A2AAction` the cognitive engine emits will arrive as `action` envelopes.
The bridge also appears in `/status` under `a2aBridge`:

```json
{
  "a2aBridge": {
    "running": true,
    "clientCount": 1,
    "stats": { "actionsBroadcast": 42, "acksReceived": 41, "replaysDrained": 0, ... }
  }
}
```

The bridge is bound to `127.0.0.1` by default for safety. To expose it on
your LAN, set `BRIDGE_HOST=0.0.0.0` — but only do that if you understand
that any client with TCP reach can subscribe to every emitted mutation.

### 5c. Retrospective queries (a2aQuery)

For post-voyage analysis ("how often did we hit hazard mode last week?",
"top reasons for raising alerts"), use the `A2aQuery` read-side layer.
It streams the JSONL files in `./logs/a2a/` (same files the bridge
writes to) and answers questions without needing the daemon to be
running.

```bash
node -e "
  const { A2aQuery } = require('./backend/a2aQuery');
  const q = new A2aQuery({ dir: './logs/a2a' });
  (async () => {
    const top = await q.topBy({ field: 'action', limit: 5 });
    console.log(JSON.stringify(top, null, 2));
    const buckets = await q.bucketBy({ intervalMs: 3_600_000 });
    console.log('per-hour:', JSON.stringify(buckets));
  })();
"
```

`A2aQuery` is pure JS — no DuckDB, no native deps. It does an mtime-ordered
stream of the directory, parses each JSONL line, and applies filters in JS.
Suitable for voyage-week logs (KB to low MB). For multi-year archives,
consider exporting to DuckDB separately.

Available methods: `query(filters)`, `countBy({field, filters})`,
`topBy({field, limit, filters})`, `bucketBy({intervalMs, filters})`,
`summary(filters)`. Filters: `kind`, `action`, `since`, `until`,
`minPriority`, `maxPriority`, `reasonContains`.

See `tests/a2aQuery.test.js` for usage examples and `AGENTS.md` §5.3 for
a longer write-up.

---

## 6. Graceful shutdown

The daemon traps `SIGINT` and `SIGTERM` and runs the following teardown in
order:

1. `core.stop()` — halts the 500 ms loop and aborts any in-flight LLM gen.
2. `narrator.destroy()` — marks the narrator as destroyed.
3. `ingest.disconnect()` — sets the user-closed flag and clears reconnect timers.
4. `a2aBridge.stop()` — closes all subscribed clients and unbinds port 3002.
5. `a2aLog.destroy()` — flushes any pending A2A audit writes to disk before exit.
6. `stopOpsServer(opsServer)` — closes the HTTP listener.
7. `stopStreamer()` (only if embedded) — SIGTERM with a 2 s SIGKILL escalation.

If anything in that chain throws, the daemon exits with code 1 and the error
is logged at `[ERR]`. Otherwise it logs `[LIFE] shutdown complete` and exits 0.

---

## 7. Troubleshooting

### "EADDRINUSE 127.0.0.1:3000"

Another streamer is already bound. On Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

On macOS / Linux:

```bash
lsof -ti:3000 | xargs -r kill -9
```

### "EADDRINUSE 127.0.0.1:3002" (Phase 5 bridge)

Two daemons can't share the A2A bridge port. Either:

- Pick a different port on the second one: `BRIDGE_PORT=3003 npm start`.
- Or disable the bridge on the second one: `BRIDGE_DISABLED=1 npm start`.

The same `Get-NetTCPConnection` / `lsof` recipes above work for port 3002.

### "Ollama ECONNREFUSED 127.0.0.1:11434"

The Ollama daemon isn't running. Start it (`ollama serve` on Linux/macOS, the
system tray app on Windows), then either pull the models:

```bash
ollama pull qwen3:4b
ollama pull nomic-embed-text:latest
```

…or just set `MOCK_LLM=1` to run the rest of the stack without an LLM.

### "qwen3:4b produces prose but no `<a2a>` block"

Small reasoning models sometimes prefer to "think aloud" rather than emit the
JSON we want. Three mitigations:

1. **Run a bigger model**: `LOCAL_LLM_MODEL=gemma4:12b npm start` — they emit
   `<a2a>` blocks more reliably.
2. **Increase the token budget**: pass `maxTokens` to `LlmNarrator`.
3. **Run in mock mode** for demos / CI: `MOCK_LLM=1 npm start`.

The smoke test treats prose-only as a soft pass because the splitter,
parser, and pipeline all still run correctly. Only a hard A2A parse failure
fails the test.

### "Anomalies fire too often / never"

`ANOMALY_THRESHOLD` defaults to `0.50`. Raise it (`0.75`) if natural
telemetry noise keeps tripping emergencies; lower it (`0.25`) if genuine
hazards aren't getting flagged.

### "Memory keeps growing"

The ring buffer is fixed (`RING_CAPACITY * 6 * 8 bytes` = 12 KB at default).
If RSS climbs, the culprit is almost always the LLM backend's SSE parser or
the embedder — both are HTTP clients and bounded by request count, not
uptime.

---

## 8. CI / unattended runs

For continuous-integration or container deploys:

```bash
MOCK_LLM=1 STREAMER_EMBED=true OPS_PORT=3001 npm start
```

This brings up the whole stack with deterministic LLM output. Tests pass
without any external services. The daemon will exit cleanly on `SIGTERM`,
which is what most container runtimes send on `docker stop`.

For a production-ish run that still exercises the real LLM:

```bash
NODE_ENV=production npm start
```

(There's no `NODE_ENV` branch in the code yet, but the door is open — the
hooks to add request logging, metrics, etc. are all already in
`trinityDaemon.js`.)

---

## 9. File layout (where to look when something breaks)

| Symptom                                  | First place to look            |
|------------------------------------------|---------------------------------|
| Wrong / no telemetry frames              | `backend/telemetryIngest.js`    |
| Boats moving on the wrong route          | `backend/navigationSimulator.js`|
| JEPA never flags anomalies               | `backend/jepaWorldModel.js`     |
| Narrator text is empty / malformed       | `backend/llmNarrator.js`        |
| Cloud LLM isn't being used               | `backend/llmBackends.js`        |
| `<a2a>` blocks aren't reaching the UI    | `backend/trinityDaemon.js` event log |
| A2A audit log missing or wrong shape     | `backend/a2aLog.js`             |
| Vector store returns wrong chunks        | `backend/vectorStore.js`        |
| Tests fail / flake                       | `docs/TESTING.md`               |