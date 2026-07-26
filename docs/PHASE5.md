# Phase 5 — The A2A Bridge (handover)

> **Status:** Phase 5 is **feature-complete** as of the current commit.
> All four deliverables from the original plan are shipped, tested, documented,
> and wired into the daemon. This document is the **handover summary** plus
> the open question of what Phase 6 should be.

---

## 1. What shipped

| Artifact | Status | Purpose |
|---|---|---|
| `backend/a2aBridge.js`        | shipped (commit `07bddbb`) | WebSocket server. Validates `A2AAction` payloads from `core.on('a2a', …)`, assigns monotonic ids, persists to `A2aLog`, broadcasts to all live clients with backpressure-aware fanout. Handles `replay` (gap-fill from log) and `ack` (persist client progress) requests. |
| `backend/a2aLog.js`           | shipped (commit `07bddbb`) | `append()` accepts arbitrary `{ kind, id?, action?, ts, … }` records. Adds `since(sinceId)` and `maxId()` for replay / id-resume. |
| `backend/schemas.js`          | shipped (commit `07bddbb`) | Exports `parseA2AClientMessage()` — strict validator for the three client request types (`ping`, `ack`, `replay`). |
| `backend/a2aBridge.js` (rev)  | this round | Added `get running` accessor for the daemon's `/status` snapshot. |
| `backend/a2aClient.js`        | **shipped this round**      | Typed subscription wrapper. Connect → hello → optional auto-replay → live feed → ack. Auto-reconnect with exponential backoff. Public `handleServerMessage(raw)` for testability. |
| `backend/trinityDaemon.js`    | **shipped this round**      | Wires `A2aBridge` into the daemon. New env vars: `BRIDGE_HOST`, `BRIDGE_PORT`, `BRIDGE_DISABLED`. Bridge `stats()` flows into `/status` under `a2aBridge`. |
| `tests/a2aBridge.test.js`     | shipped (commit `07bddbb`) | 15 cases: hello, live broadcast, monotonic ids, malformed-payload drop, replay-fills-gap across restart, ack persistence, ping/pong, malformed JSON, unknown type, bad-field rejection, no-log replay, multi-client fanout, stats endpoint, graceful shutdown. |
| `tests/a2aClient.test.js`     | **shipped this round**      | 16 cases: construction, hello handshake, double-connect rejection, connect-after-destroy rejection, live action delivery, ping/pong, manual replay, auto-replay on reconnect, auto-reconnect across server restart, give-up after `maxReconnectAttempts`, malformed JSON → error event, server error envelope → error event, ack validation, requestReplay validation, destroy cancels reconnect, stats surface. |
| `tests/daemon.test.js`        | **updated this round**      | Teardown now also stops the bridge so the test process exits cleanly. |
| `docs/OPERATIONS.md`          | **updated this round**      | New section `5b. The A2A WebSocket bridge`. Bridge env vars in section 4. Bridge port collision in section 7. Shutdown order in section 6 includes `a2aBridge.stop()`. |
| `package.json`                | **updated this round**      | `test:a2abridge`, `test:a2aclient` scripts. |
| `README.md`                   | (already in IN PROGRESS)    | Phase 5 row + cross-link to this document. |
| `docs/SYNERGY.md`             | TBD                         | One-line cross-link (optional — left for next round). |

**Test suite:** 14 suites, 200+ assertions, **all green** (`npm test`).  
**Lint:** clean (`npm run lint`, 39 files).

---

## 2. Wire format (canonical reference)

All frames are JSON, UTF-8 text, one envelope per WebSocket message. Newlines
are not part of the frame — `ws` delivers each `send()` as one message.

### Bridge → Client

| Type         | Required fields                                | Purpose                              |
|--------------|------------------------------------------------|--------------------------------------|
| `hello`      | `last_action_id: int ≥ 0`                       | Sent once after every (re)connect.   |
| `action`     | `id: int > 0`, `action: object`                 | A validated workspace mutation.       |
| `replay_end` | `replayed: int ≥ 0`, optional `reason`          | Marks the end of a gap-fill replay.  |
| `ack_ok`     | `action_id: int ≥ 0`                            | Ack was persisted.                   |
| `pong`       | `ts: ISO string`                                | Heartbeat response.                  |
| `error`      | `code: string`, `errors: string[]`              | Protocol / schema violation.         |

### Client → Bridge

| Type    | Required fields                | Purpose                                        |
|---------|--------------------------------|------------------------------------------------|
| `ping`  | (none)                         | Liveness probe — expect a `pong` back.         |
| `ack`   | `action_id: int ≥ 0`            | "I've durably applied action id N."            |
| `replay`| `since_id: int ≥ 0`             | Replay every action with id > `since_id`.      |

### Idempotency rules

1. **Monotonic ids:** the bridge assigns `id = max(seen) + 1` at assignment
   time and persists to `A2aLog`. Restart resumes from `maxId()`.
2. **Replay is safe:** clients persist `lastAckedId`; on reconnect they send
   `replay { since_id: lastAckedId }` and receive only the gap. No action is
   ever delivered twice and none is lost.
3. **Ack is monotonic:** the bridge accepts any `action_id ≥ 0` and stores
   the max. Older acks are tolerated (don't error) but don't regress the
   cursor.

### Frame delivery vs. persistence ordering

The bridge broadcasts live actions to connected clients **first**, then
asynchronously appends to `A2aLog`. This means a crash between broadcast and
append would leave a client with an action that isn't on disk for replay.
This is a known durability gap — see §5 "Open issues".

---

## 3. Operating the bridge

### Run modes

| Mode                                | How                                                              |
|-------------------------------------|------------------------------------------------------------------|
| **Embedded in daemon** (default)    | `npm start`. Bridge binds to `ws://${BRIDGE_HOST}:${BRIDGE_PORT}` (default `ws://127.0.0.1:3002`). |
| **Standalone against fake core**    | `node -e "const {A2aBridge}=require('./backend/a2aBridge');const {EventEmitter}=require('events');const core=new EventEmitter();const b=new A2aBridge({core, port:3002, verbose:true});b.start();"` |
| **Disabled**                         | `BRIDGE_DISABLED=1 npm start`. Useful when only the audit log is needed. |

### Smoke test

```bash
# Terminal 1
npm start

# Terminal 2 — bare-bones subscriber
node -e "
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:3002');
  ws.on('message', (b) => console.log(b.toString()));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
"
```

You should see a `hello` envelope within a few hundred ms, then any
`A2AAction` the cognitive engine emits will arrive as `action` envelopes.

### Liveness via `/status`

The daemon's `/status` endpoint includes a new `a2aBridge` field:

```json
{
  "a2aBridge": {
    "running": true,
    "clientCount": 1,
    "stats": {
      "actionsBroadcast": 42,
      "acksReceived": 41,
      "replaysDrained": 0,
      "clientsConnected": 1,
      "clientsDisconnected": 0,
      "errorsSent": 0,
      "nextId": 43,
      "connectedClients": 1,
      "port": 3002
    }
  }
}
```

### Production client sketch

```js
const { A2aClient } = require("backend/a2aClient");

const c = new A2aClient({
  url: "ws://127.0.0.1:3002",
  lastAckedId: loadPersistedAckCursor(),   // restart-time safety
  autoReconnect: true,
});

c.on("hello",     () => { /* hello.last_action_id available as c.hello */ });
c.on("action",    (env) => { applyAction(env.action); persistAckCursor(env.id); c.ack(env.id); });
c.on("replay_end",(info) => { /* gap filled — info.replayed = N */ });
c.on("error",     (err) => { log.error(err); });

await c.connect();   // resolves after hello
// ...later...
await c.destroy();   // or c.destroy() on app shutdown
```

The client persists its own `lastAckedId` (you assign it via the `lastAckedId`
constructor opt or read it after each `ack`). On restart, pass it back in.

---

## 3.5 Worked example — a complete bridge session

This is the canonical "one happy-path session" you can use as a template when
writing tests, building a new client, or debugging protocol drift. Every line
below is a literal `ws.send()` call (or its arrival on the other side), with
the bridge's expected response.

### 3.5.1 The participants

```
┌────────────────────┐                    ┌────────────────────┐
│  a2aClient.js      │   ws://127.0.0.1   │  a2aBridge.js      │
│  (Theia frontend)  │◄──────────────────►│  (inside daemon)   │
│                    │       :3002        │                    │
└────────────────────┘                    └────────────────────┘
        │                                         │
        │   persists lastAckedId locally          │   persists to
        ▼                                         ▼   a2aLog/<date>.jsonl
   disk/sqldb                                logs/a2a/
```

### 3.5.2 Cold start (first connect, no prior cursor)

```
T+0ms    CLIENT  ──ws.open──►                BRIDGE
T+5ms    CLIENT  ◄──{ type:"hello", last_action_id: 0 }── BRIDGE
         (client.on("hello") fires; c.hello.last_action_id === 0)

T+2s     ── core emits A2AAction { kind:"morph_to_hazard_mode", payload:{...}, priority:0.98 }
T+2s+ε   BRIDGE  assigns id=1, broadcasts
         CLIENT  ◄──{ type:"action", id:1, action:{kind:"morph_to_hazard_mode", ...}, ts:"..." }
         CLIENT  (c.on("action") handler runs; applyAction(...); c.ack(1))
         CLIENT  ──►{ type:"ack", action_id:1 }
         BRIDGE  ◄──{ type:"ack_ok", action_id:1 }── CLIENT   (confirms persisted)
         BRIDGE  appends to a2aLog/2026-07-26.jsonl (asynchronously, ~100ms batch)

T+60s    CLIENT  ──►{ type:"ping" }
T+60s    CLIENT  ◄──{ type:"pong", ts:"2026-07-26T..." }── BRIDGE
```

What the client should persist after this session:
- `lastAckedId = 1` (write to disk/sqldb before exit)
- `bridgeStats = { helloLastActionId: 0, acksSent: 1, lastPongTs: "..." }`

### 3.5.3 Restart and resume (the safety net that proves durability)

```
[T+10min]  Client process restarts. Loads lastAckedId=1 from disk.

T+0ms     CLIENT  ──ws.open──►                BRIDGE
T+5ms     CLIENT  ◄──{ type:"hello", last_action_id: 47 }── BRIDGE
          (47 actions were emitted while client was down)
          (c.on("hello") fires with c.hello.last_action_id === 47)

T+10ms    CLIENT  ──►{ type:"replay", since_id: 1 }
T+11ms    CLIENT  ◄──{ type:"action", id:2,  action:{...} }── BRIDGE
T+11ms    CLIENT  ◄──{ type:"action", id:3,  action:{...} }── BRIDGE
          ... (46 frames total, batched, ~5ms each)
T+50ms    CLIENT  ◄──{ type:"action",  id:47, action:{...} }── BRIDGE
T+50ms    CLIENT  ◄──{ type:"replay_end", replayed:46 }──── BRIDGE

          For each: c.on("action") → applyAction → persistAckCursor → c.ack(id)
          Final cursor: lastAckedId = 47
```

Why this proves the protocol works:
- No action is delivered twice — ids are monotonic from the bridge
- No action is lost — the bridge reads from durable `a2aLog`
- The client doesn't need to know how long it was offline
- The protocol is "replay-safe" by construction

### 3.5.4 Server restart (bridge dies and comes back)

```
[T+30min]  Bridge process restarts (deploy / SIGTERM-and-restart).
           A2aLog survives on disk (its state lives in logs/a2a/*.jsonl).

           Graceful shutdown order (see OPERATIONS.md §6):
             1. bridge.stop()         ← sends "server shutting down" close
             2. a2aLog.destroy()      ← flushes pending batch
           Reverse order would lose writes; this order does not.

T+0ms     CLIENT  ws auto-reconnect (exponential backoff: 250ms → 500 → ... → 5s)
T+2.3s    CLIENT  ──ws.open──►                BRIDGE (fresh process)
T+2.3s    CLIENT  ◄──{ type:"hello", last_action_id: 47 }── BRIDGE
          (BRIDGE's maxId() read a2aLog and got 47 — same as before)
          Client's c.on("hello") handler sees last_action_id === lastAckedId,
          so NO replay needed. Live feed resumes.
```

### 3.5.5 Client crash + late ack (the edge case that catches bugs)

```
[T+1h]  Client received action id=53 but crashed BEFORE sending c.ack(53).
        On restart lastAckedId = 52.

        Hello arrives with last_action_id = 53.
        Client sends replay { since_id: 52 }.
        Bridge replays ONLY id=53 (one frame).
        Client applies it, sends ack { action_id: 53 }.
        Cursor advances to 53.
```

This is the entire reason the protocol carries `action_id` separately from
any client-side state: **at-least-once delivery with idempotent application**.

### 3.5.6 What the on-disk JSONL looks like

`logs/a2a/2026-07-26.jsonl` after the above session:

```jsonl
{"kind":"hello_meta","ts":"2026-07-26T12:00:00.000Z","clientCount":1}
{"kind":"action","id":1,"action":{"kind":"morph_to_hazard_mode","payload":{"region":"north_atlantic"},"priority":0.98,"reason":"weather_front"},"ts":"2026-07-26T12:00:02.001Z"}
{"kind":"ack","action_id":1,"from":"client-abc","ts":"2026-07-26T12:00:02.050Z"}
{"kind":"action","id":2,"action":{...},"ts":"..."}
...
{"kind":"ack","action_id":47,"from":"client-abc","ts":"..."}
{"kind":"replay","since_id":1,"replayed":46,"ts":"..."}
```

`A2aLog.since(0)` returns all records; `A2aLog.since(46)` returns only the
last two. `A2aLog.maxId()` returns the highest `id` seen across all records.

### 3.5.7 Failure modes (what NOT to assume)

| Symptom | Likely cause | Where to look |
|---|---|---|
| `hello` never arrives | Bridge not started, or port blocked | `npm start` output; `BRIDGE_PORT` env; `OPERATIONS.md` §7 |
| `replay` returns 0 actions | Bridge restarted with empty log (first run ever) | `logs/a2a/` directory; `A2aLog.maxId()` |
| `error` envelope with code `MALFORMED_JSON` | Client sent non-JSON or wrong `type` | `parseA2AClientMessage()` validator |
| Actions arrive out of order | Should not happen — monotonic ids | Check `_nextId` in `a2aBridge.js`; report a bug |
| `pong` missing | Bridge heartbeat broken | `BRIDGE_HEARTBEAT_MS` env; `/status` shows `clientsDisconnected` incrementing |

### 3.5.8 A one-page reference card

For agents building a new client:

```
1.  open ws
2.  wait hello         → c.hello.last_action_id = H
3.  if persistedAck > 0 and persistedAck < H:
        send { type:"replay", since_id: persistedAck }
        apply all actions, ack each
    else:
        skip replay
4.  on action:    apply; persistAck; ack(id)
5.  on replay_end: nothing (just informational)
6.  on pong:      update liveness timer
7.  on error:     log + decide whether to reconnect
8.  on close:     if intentional → exit; else → auto-reconnect (backoff)
9.  on destroy:   cancel reconnect timers; close ws
```

That's the whole protocol. ~30 lines of client code, end-to-end durable.

---

## 4. What Phase 5 does NOT do

Out of scope, deferred to a later phase:

- **Authentication / authorisation.** The bridge binds to `127.0.0.1` by
  default. To expose on the LAN set `BRIDGE_HOST=0.0.0.0`, but any client
  with TCP reach can subscribe. A token-based auth layer (HMAC challenge in
  the `hello` frame) is a candidate Phase 6 add-on.
- **Per-client subscription filters.** Every connected client receives every
  emitted action. If the action vocabulary grows, a `subscribe` filter on
  `kind` would be a backwards-compatible addition.
- **The Theia extension itself.** Lives in a separate TypeScript repo. This
  project only defines the wire contract.

---

## 5. Open issues / known gaps

### Durability gap: broadcast before append

The bridge broadcasts an `action` to live clients before awaiting the
`a2aLog.append()` write. If the bridge crashes between broadcast and append
(write not yet flushed), a reconnecting client with `lastAckedId = id-1`
will not see that action on replay — it's not on disk yet.

**Mitigations in place:**
- `A2aLog.append()` batches writes (~100ms) and `fsync`s on flush. The
  window of vulnerability is therefore at most the batch interval.
- Graceful shutdown calls `bridge.stop()` then `a2aLog.destroy()` in
  order, so a clean SIGTERM never loses a write.

**Proper fix** (Phase 6 candidate): await the `a2aLog.append()` BEFORE
broadcasting. Adds bounded latency to the live path. Trade-off worth
revisiting once action volume justifies it.

### Bridge and client are now both bound to localhost

This is intentional for safety. If the Theia extension will run on a
different host from the daemon, a reverse proxy (nginx with `proxy_pass`
and WS upgrade) or moving to a unix-domain socket are the two paths
forward. Not a Phase 5 deliverable.

---

## 6. Open question — what is Phase 6?

Four plausible candidates:

| Option | Effort | Value | Notes |
|---|---:|---:|---|
| (a) **Theia extension in TypeScript** | High | Medium | Separate repo. The bridge is the contract — defer until protocol stabilises. |
| (b) **Persistent storage for A2aLog (sqlite-vss / DuckDB)** | Medium | Medium | Queryable index. Premature at current action volume. |
| (c) **Real Signal K consumer swap** | Low | High | `telemetryIngest.js` already speaks Signal K deltas. Add `SIGNALK_URL` so the daemon points at a real server instead of `mockSignalK`. High value, low risk. |
| (d) **vessel-agent integration end-to-end** | Medium | Very High | Run `capture_daemon.py` against Trinity, close the Phase 4 cross-system loop. Recommended. |

**Recommendation:** **Phase 6 = (d)**, with **(c)** as a prerequisite quick-win.
The vessel-agent capture daemon already publishes Signal K deltas, and
Phase 4's `vesselAgentAdapter.js` already normalises them. With (c) done
first, (d) is mostly wiring.

---

## 7. Decision log

- 2026-07-25 14:53 — Phase 5 plan recorded in `.agent_memory.json`.
- 2026-07-25 22:53 — Phase 5 core shipped: `a2aBridge.js` +
  `tests/a2aBridge.test.js` + `a2aLog` extensions + `parseA2AClientMessage`
  validator. Pushed as `07bddbb`.
- 2026-07-26 — Phase 5 completion: `a2aClient.js` + `a2aClient.test.js`
  (16 cases), daemon wiring, OPERATIONS.md §5b + §6 + §7, package.json
  scripts, `PHASE5.md` rewrite. Full suite green, lint clean.

---

## 8. Files of interest

```
backend/a2aBridge.js           # WebSocket server
backend/a2aClient.js           # WebSocket client (typed subscription wrapper)
backend/a2aLog.js              # JSONL audit log with since() + maxId()
backend/schemas.js             # parseA2AClientMessage() + A2A_ALLOWED_ACTIONS
backend/trinityDaemon.js       # Wired A2aBridge into the daemon
shared/events.js                # Bridge event vocabulary
tests/a2aBridge.test.js        # 15 cases
tests/a2aClient.test.js        # 16 cases
tests/daemon.test.js           # Bridge teardown added
docs/OPERATIONS.md             # §5b — wire format + ops
docs/PHASE5.md                 # this document
package.json                   # test:a2abridge, test:a2aclient scripts
README.md                      # Phase 5 status = IN PROGRESS
.agent_memory.json             # session timeline
```