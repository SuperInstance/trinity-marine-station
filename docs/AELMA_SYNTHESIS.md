# AELMA Synthesis — Mapping the VRDTA Vision onto Trinity Marine Station

> **Source document:** `## The Vessel-Roblox Digital Twin Archit.txt` (777 lines, 73KB)
> **Author:** research pass on 2026-07-26
> **Audience:** future agent builders, Casey, anyone evaluating what Trinity Marine Station is missing or could become.

This document is a **bridge**, not a translation. It maps the academic AELMA/VRDTA
(Roblox-based) vision onto the concrete code in this repository. It is intentionally
honest about both alignment and gaps.

If you are a new agent arriving at this repo, read this **after** `AGENTS.md` and
**before** making any Phase 7+ proposals.

---

## TL;DR — What AELMA Is, What We Are

| | AELMA (VRDTA) | Trinity Marine Station |
|---|---|---|
| **Premise** | Commercial fishing vessel as a real-time game engine, with local AI agents that see the world as 3D spatial context. | Marine telemetry ingest + JEPA world model + LLM narrator, exposing an A2A action stream to UI consumers. |
| **Stack** | Roblox Server (Luau) + Python/Go gateway + NVIDIA Jetsons + ESP32s. | Node.js daemon + Ollama/OpenAI + h3 spatial index + JSONL action log + WebSocket bridge. |
| **Loop direction** | Bidirectional: agent **commands hardware** (routing through HTTP REST gateway). | Read-only at the LLM level: narrator **observes and advises** via A2A actions; no hardware actuation. |
| **Spatial model** | Full 3D physics world in Roblox (rooms, raycasts, rigid bodies). | Flat feature vectors (numeric telemetry deltas). h3 spatial index added for coarse geographic reasoning. |
| **Decision model** | Watchers (fast Luau NPCs) + Master AI (LLM, slow path). | JEPA energy scoring (fast path) + LLM narrative generation (slow path). |
| **What ships first** | The "playable twin" — even before the real boat is wired, the 3D model is interactive. | The cognitive observability layer — works on synthetic data; the real boat is a future integration. |

**The 1-sentence version:** Trinity is a **read-side cognitive observability layer**;
AELMA is a **closed-loop spatial operating system**. We are a strict subset of AELMA's
concerns, deliberately scoped to a smaller, more shippable surface.

---

## Layer-by-Layer Mapping

### Layer 1: Perception & Actuation (Physical Vessel)

**AELMA:**
- NVIDIA Jetsons (vision), Raspberry Pis (thermal), ESP32s (GPIO/NMEA 2000).
- Air-gapped Gigabit Ethernet mesh.
- ESP32 fallback to manual mode if host connection drops >1000ms.

**Trinity equivalent:**
- `backend/telemetryIngest.js` — Signal K delta consumer.
- `backend/mockSignalK.js` — synthetic data feed for tests.
- No actuation path. **No hardware ownership.** The system is upstream of any physical
  bus; downstream consumers (e.g., vessel-agent, Theia IDE) are responsible for
  acting on our A2A actions.

**Gap (acknowledged):** No concept of a "peripheral watchdog" — we don't know if
the ESP32 that received our A2A action actually executed. AELMA's 1000ms fallback
is a hint: actuation paths in marine systems MUST have local safety fallbacks that
are independent of any network-attached cognitive layer.

### Layer 2: The Bridge Gateway (Hardware ↔ Digital)

**AELMA:**
- Python or Go daemon. Asymmetric protocol.
- **Outbound (telemetry):** WebSocket server streams JSON at 50Hz (volatile) / 250ms (low-volatility).
- **Inbound (actuation):** HTTP REST endpoints; Roblox POSTs to the daemon, daemon routes to bus.

**Trinity equivalent:**
- `backend/trinityDaemon.js` orchestrates the whole process; not a "gateway" in the
  AELMA sense.
- `backend/a2aBridge.js` is our **outbound** path: broadcasts validated A2A actions
  to subscribed WebSocket clients (e.g., Theia IDE).
- **We have no inbound actuation endpoint.** A2A actions are advisory.

**Architecture insight from AELMA worth stealing:** the **asymmetric protocol**
choice. Telemetry is high-frequency, small, push-based; actuation is low-frequency,
large, request/response. Our A2A bridge conflates them into a single WebSocket,
which works because both directions are low-frequency in our domain. If we ever
ship 50Hz telemetry, we will want to split these. The 50Hz/250ms split in AELMA
is a strong pattern: high-volatility channels at 50Hz, low-volatility at 250ms.

**Sub-pattern worth stealing:** AELMA's comma-delimited payload strings
(`nmea_gps: "59.34521,-151.43210,11.4,214.5"`) — chosen to minimize Wi-Fi
bandwidth on a marine mesh. Our JSONL action log is the opposite trade-off:
verbose, debuggable, low-frequency. Right for our domain, but worth noting if we
ever ingest raw NMEA.

### Layer 3: The Spatial Context Engine

**AELMA:**
- Roblox Server (Luau) maintains the live 3D world.
- State changes propagate to clients via Roblox's native replication.
- Spatial queries: `GetPartsInPart`, raycasts, bounding boxes.
- "Vessel MUD" metaphor: rooms as containers, hardware as interactive objects.

**Trinity equivalent:**
- No 3D engine. We have:
  - `backend/jepaWorldModel.js` — abstract world model, produces "anomaly"
    events from feature vectors.
  - `backend/h3.js` — coarse geographic spatial index (h3 hexagonal cells).
  - `backend/vectorStore.js` — semantic retrieval (chunk-based).
- The `shared/types.js` `FeatureVector` is our analog of a "spatial state" — but
  flat, not 3D.

**The major gap.** AELMA's spatial layer is what makes the AI cognition layer
**useful** — without it, the LLM is reasoning over numbers, not over geometry.
We have no equivalent of "this thermal anomaly is in the engine room, 1.2 feet
from a hydraulic line." Our narrator's prose is grounded in the *feature vector*
and *retrieved chunks*, not in *spatial relationships between components*.

**If we ever add a spatial layer** (Phase 7+ candidate), the natural shape is:
- A scene graph of physical components (engine, winch, hull, etc.) with edges
  representing physical/spatial relationships.
- Bounding-box or h3-cell spatial indexing.
- A "spatial query" API surface analogous to AELMA's `GetPartsInPart`: `query_zone(zone_id) -> contents_with_relationships`.

### Layer 4: AI Cognition Layer

**AELMA:**
- Local LLM (presumably Ollama or similar) with JSON tool-calling.
- "Spells" = declarative tool schemas (`cast_winch_brake`).
- "Watchers" = fast Luau scripts that handle deterministic sub-decisions and
  fire alerts to the master agent.
- Native STT/TTS with spatial audio (voice warnings emanate from the
  direction of the fault).

**Trinity equivalent:**
- `backend/llmNarrator.js` — local LLM narrator producing prose.
- `backend/trinityCore.js` — orchestrator that fuses JEPA, LLM, and A2A action
  emission.
- The A2A action allow-list (`schemas.js::A2A_ALLOWED_ACTIONS`) is a primitive
  form of AELMA's "spells" — eight spells, not a framework.
- **No watchers.** Every cycle goes through the full JEPA + LLM path.

**The "Watcher" pattern is the most important AELMA concept we don't have.**
A watcher in AELMA is:
- A **deterministic** script (no LLM) attached to a 3D component.
- Watches an attribute for a threshold breach.
- Fires an alert to the master agent.

The point: not every decision needs a 50ms LLM roundtrip. A temperature reading
that crosses 195°F does not need an LLM to declare "OVERHEATING" — a watcher
fires the event, the LLM is *awakened* on demand to reason about it.

In Trinity terms, this would be:
- A threshold-based event emitter on top of `FeatureVector` deltas.
- A "fast path" of A2A actions that bypass LLM narration.
- A "slow path" where the LLM is only invoked when the fast path can't decide.

This is a **clean Phase 7+ candidate** — see `docs/STATUS.json` `phase_7_candidates`.

---

## Conceptual Frameworks Worth Adopting

### 1. "Divination Sandbox" (Predictive Physics Before Actuation)

AELMA's most distinctive idea: clone the live world into `workspace.SimulationWorkspace`,
run the physics 5x faster, and let the agent test a maneuver before committing.

Trinity analog: **what-if queries against the JEPA world model.** We have
`backend/jepaWorldModel.js` — it produces a forward-looking "energy" score
(low = likely future state). It does not yet support a "roll forward the
counterfactual state and tell me what happens" API.

**Phase 7+ candidate:** a `predict(counterfactual_action)` method on JEPA that
returns the expected trajectory delta without committing the action. This is
the "divination" of our cognitive layer.

### 2. "Spells" — Declarative Tool-Calling

AELMA's spells are JSON schemas the LLM can invoke:
```json
{
  "name": "cast_winch_brake",
  "description": "Engages or releases the hydraulic brake on a specific deck winch.",
  "parameters": {
    "winch_id": { "type": "string", "enum": ["trawl_main", "aux_boom"] },
    "brake_engaged": { "type": "boolean" }
  }
}
```

Trinity analog: `A2A_ALLOWED_ACTIONS` in `backend/schemas.js`. Eight actions,
no parameter schemas, no LLM tool-calling integration.

**Gap (real):** our A2A actions are emitted by the deterministic trinityCore, not
chosen by the LLM. If we want the LLM to *propose* A2A actions (rather than just
narrate around them), we need:
- Parameter schemas per action (already partially in `A2AAction.payload`).
- Tool-calling integration in `llmNarrator.js` (currently the narrator outputs prose
  only; A2A emission is a separate code path).
- A "spell validation" step between LLM tool-call and A2A emission (our
  `validateA2AAction` is the foundation).

### 3. "Generational Log File Bridge" — Telemetry Replay as a Product

AELMA's vision: recorded fishing trips become Roblox replay files that children
load and play. This is the "log file is the product" idea applied to humans,
not just analysts.

Trinity analog: `backend/a2aQuery.js` lets you replay past A2A actions with
filters. This is **only the first 10%** of the AELMA vision. The full vision is:
- Replay on a real visual surface (3D twin, map, narrative timeline).
- A consumer-facing playback UX (a "watch my dad's last trip" experience).

This is **out of scope for this repo** (we are upstream of any UI), but the
underlying primitive (`a2aQuery`) is in place.

### 4. "Play-First Hardware Prototyping"

AELMA: build the 3D toy, play with it, then auto-transpile the Luau to ESP32
C++. The physical hardware is a *crystallization* of the playtested virtual model.

Trinity: we don't do hardware. But the philosophy applies: **build the
simulator first, then the integration.** Phase 1 of Trinity was a synthetic
telemetry source (`mockSignalK.js`) before any real Signal K connection. This is
the same philosophy. It worked. We should keep doing it.

### 5. "RLHF via Gamification"

AELMA: a remote gamer plays the simulation, generates good decision trajectories,
the agent learns from them.

Trinity: we have `backend/vectorStore.js` (retrieval) but no fine-tuning pipeline.
This is a stretch, but worth noting: if we ever want to improve JEPA, the
training data would come from human judgments on past frames, not from raw
supervised learning. AELMA's gamified RLHF is one way to collect that.

---

## Architectural Patterns We Already Use (And AELMA Validates)

| Pattern | Trinity location | AELMA equivalent |
|---|---|---|
| JSONL append-only log | `backend/a2aLog.js` | "Generational Log File Bridge" foundation |
| WebSocket fanout to clients | `backend/a2aBridge.js` | Roblox client-server replication |
| Hello-handshake on connect | `backend/a2aBridge.js` | `OnMessage:Connect` |
| Monotonic action IDs | `backend/a2aBridge.js` | Not explicit in AELMA, but required for replay |
| Sync-then-broadcast durability | `backend/a2aBridge.js` (Phase 6 fix) | Implicit in AELMA (Roblox replication is durable) |
| Replay-on-reconnect | `backend/a2aBridge.js` | "Generational Log File Bridge" foundation |
| Schema-validated actions | `backend/schemas.js` | Tool-call parameter validation |
| Allow-list with audit | `tools/auditSchema.js` | Not present in AELMA, but a clear improvement |
| Read-side query layer | `backend/a2aQuery.js` | "What-if" queries, post-hoc analysis |
| Local LLM as reasoning engine | `backend/llmNarrator.js` | "AI Cognition Layer" |
| Synthetic data for tests | `backend/mockSignalK.js` | "Spatial Toy" / "Play-First" |
| Circuit breaker for LLM backends | `backend/circuitBreaker.js` | Not in AELMA; resilience is implicit in fallback modes |

---

## Anti-Patterns AELMA Exposes

| Anti-pattern in AELMA | What we should do |
|---|---|
| **No durability story for telemetry replay** — AELMA assumes Roblox state is durable because Roblox replicates it; nothing about the gateway's WS stream being persisted. | Our `a2aLog.js` JSONL is the answer; sync-then-broadcast (Phase 6) closes the gap. |
| **Tool-call parameter validation is implicit** — the `cast_winch_brake` example has `brake_state: boolean` but no schema enforcement. | Our `validateA2AAction` is explicit. Keep it that way. |
| **No concept of "action allow-list"** — AELMA's spells are open-ended (the LLM can invent any tool name). | Our 8-action allow-list (`A2A_ALLOWED_ACTIONS`) is a discipline AELMA lacks. |
| **No replay/replay-overflow protection** — AELMA's Roblox server just replays the state; no concept of "client missed last 4 hours, do I dump everything?" | Our `maxReplayBytes` + `onReplayOverflow` (just shipped) is ahead of AELMA here. |
| **No offline-mode for the LLM** — AELMA assumes local LLM is always available. | Our circuit breaker + 3-backends (Ollama, OpenAI, mock) is more honest. |

---

## Phase 7+ Candidates Inferred From This Synthesis

In rough priority order:

1. **Watcher pattern (deterministic fast-path A2A actions).**
   - Without modifying the LLM path, add threshold-based event emission.
   - Bypasses the LLM for obvious cases (depth plunge, thermal overrun, RPM out of range).
   - ~150 LOC. Pure Node. No new deps.

2. **`predict(counterfactual)` on JEPA world model.**
   - "Divination" — what would happen if we raised an alert right now?
   - Returns expected trajectory delta.
   - ~200 LOC. No new deps.

3. **Spatial layer (scene graph of physical components).**
   - "Engine room" → "AuxGenerator_01" → thermal sensor, hydraulic line proximity.
   - Query API: `query_zone(zone_id)` returns contents with relationships.
   - ~300 LOC. Possible new dep: none (h3 already present).

4. **A2A action parameter schemas.**
   - Each `A2A_ALLOWED_ACTIONS` entry gets a `parameters: { type, properties, required }` block.
   - LLM tool-calling integration in `llmNarrator.js`.
   - ~250 LOC. No new deps.

5. **Replay UI primitives.**
   - Server-side endpoint that streams `a2aQuery` results to a WebSocket in time-bucketed form.
   - Lets a UI render a "trip timeline" view.
   - Cross-repo (Theia extension). Out of scope for this repo.

---

## What This Document Is Not

- **Not a roadmap.** The Phase 7+ candidates above are inferred from reading
  AELMA, not from a product plan. The actual roadmap is in `docs/STATUS.json`.
- **Not a port.** AELMA is Roblox-bound; Trinity is Node-bound. We are not
  porting AELMA. We are borrowing ideas.
- **Not a critique.** AELMA is a research/architectural document; some of its
  claims (e.g., "sub-50ms latency", "5x physics acceleration") are aspirational
  rather than measured. We treat it as a *vision document*, not a benchmark.

---

## Cross-References

- `AGENTS.md` — repo onboarding (read first)
- `docs/PHASE5.md` — A2A bridge + client
- `docs/PHASE6_HANDOFF.md` — current cross-repo handoff
- `docs/STATUS.json` — machine-readable project state (includes `phase_7_candidates`)
- `docs/SYNERGY.md` — architectural narrative
- `docs/LIVE_PATH.md` — end-to-end runtime sequence

---

## Provenance

This document was written on 2026-07-26 after a full read of
`C:\Users\casey\Downloads\## The Vessel-Roblox Digital Twin Archit.txt`.
The source document is **not committed to this repo** — it is an external
research input. If you need to re-derive this synthesis, re-read that file.
