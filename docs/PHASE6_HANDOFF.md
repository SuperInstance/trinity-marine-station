# Phase 6 — In-Repo Handoff

> **Audience:** future agent (or Casey, after reboot) resuming Phase 6 work.
> **Status:** in-repo Phase 6 is **structurally complete**. Cross-repo work remains.

---

## TL;DR — Where We Are

| Phase | What | Status |
|---|---|---|
| Phase 1 | Telemetry ingest (Signal K deltas → feature vectors) | ✅ shipped |
| Phase 3 | Conscious narrator (JEPA + local LLM) | ✅ shipped |
| Phase 4 | vessel-agent anti-corruption adapter | ✅ shipped |
| Phase 4.5 | A2A audit log (JSONL) | ✅ shipped |
| Phase 5 | A2A WebSocket bridge + typed client + daemon wiring | ✅ shipped |
| Phase 6 — sync-then-broadcast | Durable bridge (await log before broadcast) | ✅ shipped (`486c1e9`) |
| Phase 6 — read-side query | `a2aQuery.js` (38 tests, pure-JS) | ✅ shipped (`db6285d`) |
| Phase 6 — schema SoT | Schema + examples derived from `A2A_ALLOWED_ACTIONS`; tripwire audit | ✅ shipped (`7e8ddf2`) |

The in-repo cognitive layer is **feature-complete and structurally hardened**:

- All 15 test suites pass, lint clean, all 4 auditors green (`audit:links`, `audit:status`, `audit:schema`, `lint`).
- A bug-class (allow-list drift between docs and code) is now **structurally impossible** — the audit will catch any regression before it ships.

---

## What's Left — Cross-Repo Work

Two Phase 6 candidates remain, both **outside this repo**:

### Candidate 1: Theia extension (TypeScript)

**Repo:** separate TS workspace (does not yet exist in `SuperInstance/` org).

**Purpose:** close the L3 → L4 loop. The A2A bridge fans out to subscribers; currently no real UI exists. A Theia IDE extension would consume the bridge.

**Estimated size:** ~200 LOC TS.

**Why it matters:** "operator visibility" — without a frontend, the L3 → L4 loop is open-circuited.

**Wiring it up — what the consumer needs to know:**

1. **Connect to `ws://127.0.0.1:3002`** (configurable via `BRIDGE_HOST` / `BRIDGE_PORT`).
2. **Wait for `{type: "hello", last_action_id: N}`** before deciding whether to request replay.
3. **Send `{type: "ack", action_id: N}` after applying each action** — the server persists the checkpoint; on reconnect, it replays only `id > lastAckedId`.
4. **Listen for `{type: "action", id, action, ts}`** and dispatch on `action.action`:
   - `morph_to_hazard_mode`, `morph_to_navigation_mode`, `morph_to_engineering_mode` — change the workspace's mode.
   - `highlight_waypoint` — render a marker on the chart.
   - `raise_alert` / `clear_alerts` — alert panel state.
   - `set_panel_focus` — focus a specific panel.
   - `announce` — speak text into the UI / accessibility.
5. **Optional manual replay:** send `{type: "replay", since_id: N}` to backfill on demand.
6. **Handle heartbeats:** send `{type: "ping"}` every 30s, expect `{type: "pong", ts}` within 45s.

Reference client: `backend/a2aClient.js` (~570 LOC) implements all of the above. Port its logic to TS.

Authoritative schema: `docs/a2a/SCHEMA.json` (now machine-checked against the allow-list).

### Candidate 2: Real vessel-agent Python WS bridge

**Repo:** `SuperInstance/vessel-agent` (Python).

**Purpose:** replace `backend/mockSignalK.js` (synthetic Signal K deltas) with the real upstream vessel-agent. This makes the whole L1 → L4 loop run against live vessel telemetry instead of a simulator.

**Estimated size:** ~80 LOC Python (a WebSocket client + Signal K delta adapter).

**What it needs to do:**

1. Connect to vessel-agent's WS endpoint (TBD; check vessel-agent repo for the actual port/path).
2. Receive raw messages (likely Signal K delta format: `{context, updates: [{timestamp, values: {...}}]}`).
3. Translate each update into a `TrinityFrame` using the **existing** `vesselAgentAdapter` pattern in `backend/vesselAgentAdapter.js`. The adapter already handles:
   - Signal K delta → TrinityFrame mapping
   - vessel-agent native delta (with `crewReport`, `fleetReport`, `timestamp_ns`) → TrinityFrame
   - H3 spatial indexing
   - provenance triple (`source.vesselUuid`, `source.hardwareSource`, `source.pipelineVersion`)
4. Send frames over a localhost socket that `trinityDaemon.js` ingests.

The pattern is in `backend/vesselAgentAdapter.js` (271 LOC). It's pure (no IO), so it can be **transpiled to Python** or wrapped in a thin Python WS server that calls into Node.

**Cleanest cross-language option:** expose `vesselAgentAdapter` as a small Node subprocess that Python talks to over stdio. That keeps the validation logic in one place.

---

## Recommended Order

```
[ ] 1. Theia extension        — closes the L4 loop; user-visible payoff
[ ] 2. Real vessel-agent     — closes the L1 loop; the "real ship" payoff
```

These can be parallelized. Theia extension unblocks anyone watching the daemon;
vessel-agent unblocks anyone with a real boat.

---

## How to Resume (after reboot / new agent)

```bash
# 1. Orient yourself
cat AGENTS.md                          # the 11-section onboarding doc
cat docs/PHASE5.md                     # the canonical Phase 5 handover
cat docs/STATUS.json | head -50        # current state manifest

# 2. Verify the codebase is trustworthy
npm run verify                         # 4 audits + lint + 15 test suites

# 3. If verify is green, you can pick up Candidate 1 or Candidate 2
```

If `npm run verify` is **not** green, do not start new work. Fix the regression first.

---

## Files of Interest (in-repo)

| File | LOC | What |
|---|---|---|
| `backend/a2aBridge.js` | 526 | WebSocket server: hello handshake, replay, ack, heartbeat |
| `backend/a2aClient.js` | 570 | Typed client w/ auto-reconnect, bounded replay, exponential backoff |
| `backend/a2aLog.js` | 345 | JSONL audit log: append, since(), maxId(), rotate, persistAck |
| `backend/a2aQuery.js` | 363 | Read-side query layer: filter, countBy, bucketBy, topActions, summary |
| `backend/schemas.js` | 464 | All payload validators incl. `A2A_ALLOWED_ACTIONS` (the SoT) |
| `backend/trinityDaemon.js` | 538 | Top-level orchestrator |
| `backend/vesselAgentAdapter.js` | 271 | Signal K / vessel-agent → TrinityFrame |
| `tools/regenSchema.js` | 314 | Single source of truth for `docs/a2a/SCHEMA.json` |
| `tools/auditSchema.js` | 160 | Tripwire: docs must match allow-list |
| `tests/a2aBridge.test.js` | 18 tests | Sync-then-broadcast, replay gap-fill, ack persistence |
| `tests/a2aClient.test.js` | 23 tests | Reconnect, bounded replay, overflow callback |

Total LOC: ~25k. Total tests: ~225 assertions across 15 suites.

---

## What the Verifier Checks (so you don't have to remember)

| Check | Tool | Catches |
|---|---|---|
| Cross-doc links | `tools/auditLinks.js` | Broken Markdown/JSON refs |
| STATUS.json integrity | `tools/auditStatus.js` | Stale commit, line-count drift |
| A2A allow-list drift | `tools/auditSchema.js` | Docs list actions the bridge rejects |
| `require()` resolution | `tools/auditRequires.js` | Typo'd imports |
| Module-level rules | `tools/lint.js` | `console.log` in backend, tabs, syntax |
| 15 test suites | `tests/run.js` | Contract violations, regressions |

Run all of them at once: `npm run verify`.

---

## Lessons Learned (for future agents)

1. **Code is authoritative; docs are derived.** Any time a list of values lives in two places (code + docs), one of them will drift. Fix: a regen tool + an audit tool. The drift class becomes structurally impossible.

2. **Don't fire-and-forget durability-critical writes.** The bridge had a subtle bug where broadcast preceded `a2aLog.append()`. Fix: await the write before broadcasting. ~5ms latency, full crash-recovery.

3. **Reconnect storms need bounded replay.** Clients offline for hours would OOM on replay. Fix: `maxReplayBytes` cap + `onReplayOverflow` callback + `replay_truncated` event. Default 8 MiB.

4. **When a test fails after a code change, check the allow-list first.** Last round's churn (`tag_waypoint`) was caused by docs lying. The audit now catches this before it ships.

5. **A clean round is: full suite green + lint clean + audits green + committed + pushed.** Don't stop one short.

6. **PowerShell `git push` returns exit 1 with `NativeCommandError` even on success.** Verify via `git ls-remote origin main`.

---

## Cross-References

- `AGENTS.md` — full agent onboarding
- `docs/PHASE5.md` — Phase 5 handover
- `docs/LIVE_PATH.md` — end-to-end runtime sequence
- `docs/MESH_TEST_REPORT.md` — last verification round
- `docs/SYNERGY.md` — vessel-agent integration architecture
- `docs/a2a/SCHEMA.json` — wire protocol (machine-checked)
- `docs/a2a/QUICKREF.md` — wire protocol cheat sheet
- `docs/a2a/EXAMPLES.jsonl` — 9 canonical exchanges
- `docs/STATUS.json` — current state manifest