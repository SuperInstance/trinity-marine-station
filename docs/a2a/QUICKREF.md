# A2A Bridge — Quick Reference

> **Audience:** an agent or developer that needs to use the bridge, fast.
> Read this before `PHASE5.md`.

---

## 1. The 60-second protocol

| Direction | Frame | When |
|----------:|-------|------|
| `→` | `{type: "ping"}` | heartbeat probe |
| `←` | `{type: "pong", ts: "..."}` | response to ping |
| `←` | `{type: "action", id: N, action: {...}}` | a validated mutation |
| `→` | `{type: "ack", action_id: N}` | "I durably applied action N" |
| `←` | `{type: "ack_ok", action_id: N}` | ack was persisted |
| `→` | `{type: "replay", since_id: N}` | resend all `id > N` |
| `←` | `{type: "replay_end", replayed: K}` | end of replay gap |
| `←` | `{type: "hello", last_action_id: N}` | sent on every connect |
| `←` | `{type: "error", code: "...", errors: [...]}` | protocol violation |

`→` = client → bridge (you send). `←` = bridge → client (you receive).

---

## 2. The 5 verbs every client needs

### 2.1 Connect

```js
const ws = new WebSocket("ws://127.0.0.1:3002");
ws.on("open", () => {
  // server sends {type:"hello", last_action_id:N}  — we don't need to send
  // anything yet; the A2aClient class sends hello on connect automatically
});
```

### 2.2 Receive an action

```js
ws.on("message", (raw) => {
  const env = JSON.parse(raw);
  if (env.type === "action") {
    applyAction(env.action);
    ws.send(JSON.stringify({ type: "ack", action_id: env.id }));
  }
});
```

### 2.3 Reconnect with replay

Just reconnect. The `A2aClient` class handles hello + auto-replay:

```js
c.on("replay_end", ({ replayed }) => {
  console.log(`caught up after ${replayed} missed actions`);
});
```

### 2.4 Manual replay on demand

```js
ws.send(JSON.stringify({ type: "replay", since_id: 100 }));
```

### 2.5 Heartbeat

```js
setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
ws.on("message", (raw) => {
  const env = JSON.parse(raw);
  if (env.type === "pong") lastPong = Date.now();
});
```

---

## 3. The 5 things every server needs

### 3.1 Assign a monotonic id

```js
const nextId = (a2aLog?.maxId?.() ?? 0) + 1;
// persist first, then broadcast
const persisted = await a2aLog.append({ id: nextId, action, ts: Date.now() });
clients.forEach(ws => ws.send(JSON.stringify({
  type: "action", id: persisted.id, action, ts: persisted._loggedAt,
})));
```

### 3.2 Accept ack

```js
ws.on("message", (raw) => {
  const env = JSON.parse(raw);
  if (env.type === "ack") {
    a2aLog.persistAck(env.action_id, clientId);
    ws.send(JSON.stringify({ type: "ack_ok", action_id: env.action_id }));
  }
});
```

### 3.3 Handle replay

```js
if (env.type === "replay") {
  const gap = await a2aLog.since(env.since_id);
  gap.forEach(({ id, action, _loggedAt }) => {
    ws.send(JSON.stringify({ type: "action", id, action, ts: _loggedAt }));
  });
  ws.send(JSON.stringify({ type: "replay_end", replayed: gap.length }));
}
```

### 3.4 Heartbeat

```js
setInterval(() => {
  clients.forEach(ws => {
    if (Date.now() - ws.lastPong > 45000) ws.terminate();
    else ws.ping();
  });
}, 15000);
```

### 3.5 Graceful shutdown

```js
clients.forEach(ws => {
  ws.send(JSON.stringify({
    type: "error", code: "BRIDGE_STOPPED",
    errors: ["server is shutting down"],
  }));
  ws.close(1001, "going away");
});
a2aLog?.destroy?.();
```

---

## 4. The 3 guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| No duplicate application | Monotonic ids; client tracks `lastAckId`; replay only sends `id > lastAckId`. |
| No lost actions on reconnect | Client sends `lastAckId` in hello; server replays gap from the audit log. |
| Liveness under load | Server pings every 15s; client must pong within 45s or be terminated. |

---

## 5. The 3 error codes

| `code` | Meaning | Caller action |
|--------|---------|---------------|
| `BAD_JSON` | Inbound frame isn't valid JSON. | Stop sending bad frames; reconnect. |
| `BAD_TYPE` / `BAD_FIELD` / `BAD_ID` / `BAD_ACTION` | Frame is valid JSON but semantically wrong. | Fix the offending field; reconnect. |
| `BRIDGE_STOPPED` | Server is shutting down. | Reconnect (or destroy, if you also want to go down). |

---

## 6. The 5 environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `BRIDGE_HOST` | `127.0.0.1` | Bind address. |
| `BRIDGE_PORT` | `3002` | Port. Set to `0` to let the OS pick. |
| `BRIDGE_DISABLED` | `false` | Set to `1` to skip bridge startup entirely. |
| `A2A_LOG_DIR` | `./logs/a2a` | Where the JSONL audit log lives. |
| `A2A_LOG_DISABLED` | `false` | Set to `1` to skip persistence (ephemeral tests). |

---

## 7. The 1 thing you must never do

**Don't broadcast before the log write resolves.** The current `A2aBridge`
implementation has a known race (see `PHASE5.md §6 future work`). If you
fork the bridge, make your version `await a2aLog.append(...)` before
broadcasting. The latency difference is ~5ms; the safety difference is
crash-recovery.

---

## 8. The cheat sheet (one line per frame)

```
PING    { type: "ping" }
PONG    { type: "pong", ts: "2026-..." }
ACTION  { type: "action", id: int, action: {...}, ts: "..." }
ACK     { type: "ack", action_id: int }
ACK_OK  { type: "ack_ok", action_id: int }
REPLAY  { type: "replay", since_id: int }
REPLAY_END { type: "replay_end", replayed: int, reason?: string }
HELLO   { type: "hello", last_action_id: int, ts: "..." }
ERROR   { type: "error", code: "BAD_*", errors: [string, ...] }
```

---

## 9. Where to go next

- **`SCHEMA.json`** — formal JSON Schema (validatable with `ajv`, `jsonschema`, etc.)
- **`EXAMPLES.jsonl`** — 9 canonical exchange sessions
- **`../PHASE5.md`** — full protocol deep-dive (state machines, edge cases, the v1-only-known-bug)
- **`backend/a2aBridge.js`** — the reference server implementation (~450 LOC)
- **`backend/a2aClient.js`** — the reference client implementation (~450 LOC)
