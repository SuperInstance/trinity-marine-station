# Phase 5 — The A2A Bridge (continuation plan)

> **Status:** core implementation shipped in commit `07bddbb`.
> This document is the **handover / continuation plan** for the remaining
> Phase 5 work plus the open question of what Phase 6 should be.

---

## 1. Where Phase 5 stands right now

Committed and pushed (`origin/main @ 07bddbb`):

| Artifact | Purpose |
|---|---|
| `backend/a2aBridge.js` | WebSocket server. Validates `A2AAction` payloads from `core.on('a2a', …)`, assigns monotonic ids, persists to `A2aLog`, broadcasts to all live clients with backpressure-aware fanout. Handles `replay` (gap-fill from log) and `ack` (persist client progress) requests. |
| `backend/a2aLog.js` (modified) | `append()` now accepts arbitrary `{ kind, id?, action?, ts, … }` records. Adds `since(sinceId)` for replay and `maxId()` for id-resume. |
| `backend/schemas.js` (modified) | Exports `parseA2AClientMessage()` — strict validator for the three client request types (`ping`, `ack`, `replay`). |
| `tests/a2aBridge.test.js` | 15 cases: hello, live broadcast, monotonic ids, malformed-payload drop, replay-fills-gap across restart, ack persistence, ping/pong, malformed JSON, unknown type, bad-field rejection, no-log replay, multi-client fanout, stats endpoint, graceful shutdown. |

**Test suite:** 14 suites, 178+ assertions, **all green**. **Lint:** clean.

---

## 2. What's still missing for Phase 5 to be feature-complete

The Phase 5 plan (`.agent_memory.json` entry 14:53:20 on day of reboot)
explicitly listed three deliverables. Two are done. One is not:

- [x] `backend/a2aBridge.js` — **done**
- [x] `tests/a2aBridge.test.js` — **done**
- [ ] `backend/a2aClient.js` — **NOT STARTED**

Plus three integration tasks that were implicit in "wire it into the
daemon so it isn't a dead library":

- [ ] **Wire `A2aBridge` into `backend/trinityDaemon.js`.** It needs to
      start when the daemon starts (port 3002 by default), stop on
      graceful shutdown, and its stats should flow into the daemon's
      `/status` aggregator alongside the existing ring buffer / JEPA /
      narrator stats.

- [ ] **Documentation.** Add a `Phase 5 — A2A Bridge` section to
      `docs/OPERATIONS.md` covering: wire format (text JSON frames),
      port (3002), protocol flow (connect → hello → optional replay →
      live feed → periodic ack), idempotency rules (id is monotonic
      across restarts, replay gap is always safe, ack is monotonic),
      and a minimal client code snippet.

- [ ] **npm scripts.** Add `test:a2abridge` (already covered by the
      unified runner, but worth a dedicated alias for parity with the
      other `test:*` scripts) and `bridge:dev` for running the bridge
      standalone against an in-memory fake core.

- [ ] **Cross-link updates.** The README's "What's in this repo" table
      and `SYNERGY.md` should mention the bridge so consumers can find
      it. One-line updates only.

---

## 3. Concrete next steps for the next session

In order:

1. **`backend/a2aClient.js`** — a typed client wrapping the
   subscription API. The intended consumer is the Eclipse Theia
   extension (separate repo), but the client itself lives in this
   repo so the test suite can exercise it end-to-end against a real
   bridge.

   API surface (proposed):
   ```js
   const client = new A2aClient({ url: "ws://127.0.0.1:3002" });
   await client.connect();                     // resolves after hello
   const { last_action_id } = client.hello;   // public field
   await client.replay({ since_id: 0 });      // drains the gap
   client.on("action", (env) => { ... });     // live feed
   client.ack(env.id);                          // persist client progress
   await client.ping();                         // health check
   client.close();
   ```
   - Auto-reconnect with exponential backoff on socket close.
   - Exposes the same `lastAckedId` semantics as the bridge tracks per
     client so the application layer can persist its own progress.
   - No third-party deps (uses native `ws` from the project's existing
     dependency).

2. **`tests/a2aClient.test.js`** — spin up a real `A2aBridge` + real
   `A2aClient` pair, exercise the full flow: connect → hello → emit
   action → receive → ack → restart bridge → reconnect → replay →
   resume. At least 8 cases.

3. **Wire into `trinityDaemon.js`.** Find the existing pattern in
   `trinityDaemon.js` where `A2aLog` is instantiated and wired into
   `core.on('a2a', …)`. Add an `A2aBridge` instance next to it,
   passing the same `core` and `a2aLog`. Default port 3002, overridable
   via `BRIDGE_PORT` env var. Stop it in the existing shutdown chain
   **before** destroying the `A2aLog` (so the bridge can flush its
   final acks). Add its `stats()` to the `/status` aggregator.

4. **Documentation updates.** Add the Phase 5 section to
   `docs/OPERATIONS.md`. Add one row to the README's "What's in this
   repo" table. Add a one-line cross-link from `docs/SYNERGY.md`.

5. **npm scripts.** Add `"test:a2abridge": "node tests/a2aBridge.test.js"`,
   `"test:a2aclient": "node tests/a2aClient.test.js"`.

6. **Verify and push.** `npm run lint && npm test` → green → commit →
   `git push origin main`. Expected commit message:
   `Phase 5 (cont): a2aClient + daemon wiring + docs`.

---

## 4. Open question — what is Phase 6?

The README's phase ladder ends at Phase 5 (Theia workspace). Phase 5
is the **transport layer** that lets the Theia extension consume
Trinity's actions safely. The actual **Theia extension** itself is a
TypeScript repo that depends on this bridge.

Four plausible Phase 6 candidates:

| Option | Effort | Value | Notes |
|---|---:|---:|---|
| **(a) Theia extension in TypeScript** | High | Medium | Lives in a separate repo. Adds zero runtime value to this Node project; the bridge is the contract. **Defer** until the bridge protocol stabilises. |
| **(b) Persistent storage for A2aLog (sqlite-vss / DuckDB)** | Medium | Medium | Replaces the JSONL append-only log with a queryable index. Useful if replay latency becomes a problem at 10⁶+ actions. **Premature** for current volume. |
| **(c) Real Signal K consumer swap** | Low | High | `backend/telemetryIngest.js` already speaks Signal K deltas (Phase 1). Add `SIGNALK_URL` env var so the daemon points at a real Signal K server instead of `mockSignalK`. **High value, low risk.** |
| **(d) vessel-agent integration: actually run `capture_daemon.py` and publish real deltas** | Medium | Very High | Closes the loop on the Phase 4 cross-system synthesis plan that has so far been document-only. Would prove the full marine-cognitive pipeline end-to-end with real data. **Recommended Phase 6.** |

**Recommendation:** Phase 6 = **(d)**, with **(c)** as a quick-win
prerequisite because the vessel-agent capture daemon already publishes
Signal K deltas — once we can consume them, the integration is mostly
already done by Phase 4's `vesselAgentAdapter.js`.

---

## 5. Decision log

- 2026-07-25 14:53 — Phase 5 plan recorded in `.agent_memory.json`.
- 2026-07-25 22:53 — Phase 5 core shipped: `a2aBridge.js` +
  `tests/a2aBridge.test.js` + `a2aLog` extensions + `parseA2AClientMessage`
  validator. Pushed as `07bddbb`. (this document)

---

## 6. Files of interest

```
backend/a2aBridge.js           # 478 LOC, the bridge
backend/a2aLog.js              # modified: since() + maxId()
backend/schemas.js             # modified: parseA2AClientMessage()
tests/a2aBridge.test.js        # 15 cases
docs/PHASE5.md                 # this document
.agent_memory.json             # session timeline (entry 14:53:20 = plan)
```