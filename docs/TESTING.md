# Testing Guide — Phase 1

> How the test suite is structured, what each test proves, and how to extend it as Phase 2 lands.

---

## TL;DR

```bash
npm test
```

Exit code `0` on success, non-zero on failure. Prints `✅ PHASE 1 PIPELINE VERIFIED` on success.

If you want to see individual test sections clearly, run the inner test directly:

```bash
node tests/pipeline.test.js
```

---

## Why two test entry points?

| Script | Purpose |
|---|---|
| `tests/pipeline.test.js` | The real test — spawns child processes, asserts behaviors. |
| `tests/run.js` | A 25-line wrapper that forwards the test's stdout/stderr to the parent *inherited*, then exits with the test's status code. |

**Why we need `run.js`:** Windows PowerShell interprets any stderr output from a child node process as a non-zero exit code, even when the child exited `0`. The Phase 1 test legitimately writes to stderr (it's the ingest child's `console.warn` output), so without `run.js`, `npm test` would *appear* to fail in PowerShell while actually passing.

`run.js` uses `stdio: ["ignore", "inherit", "inherit"]` — both streams merged into the parent's stdout. The parent's stderr is empty, so PowerShell sees a clean exit.

> If you're on macOS/Linux or using Git Bash, you can run `node tests/pipeline.test.js` directly with no wrapper.

---

## What `pipeline.test.js` actually verifies

The test runs five sections in order. Each section is independent — if one fails, the test reports the error and exits.

### Section 1 — Unit: `TelemetryRingBuffer`

Verifies the ring buffer's pure math without any I/O:

- Capacity and feature-dim are what we asked for.
- Writing 6 frames into a capacity-4 buffer correctly wraps.
- `latest()` returns the most recent frame.
- `read(slot, out)` copies into a caller-supplied buffer with no allocation.
- `snapshot(n)` returns a contiguous chronological block.

**Why this is here:** if the ring buffer's invariants break, every downstream consumer breaks silently. Catching it in a 2-millisecond unit test is the cheapest possible insurance.

### Section 2 — Unit: `unpackDeltaInto`

Verifies that a synthetic Signal K delta maps cleanly onto the canonical 6-element feature vector layout, *and* that a partial delta (missing required fields) returns `false` rather than producing a corrupt vector.

**Why this is here:** the producer/consumer contract is encoded in the index constants in `marineConstants.js`. Any drift between what the streamer emits and what the ingest extracts would surface here first.

### Section 3 — End-to-end: streamer + ingest children

This is the real test. It:

1. Spawns `backend/mockSignalK.js` as a child process.
2. Waits for the child to print `"listening on"` — proves the WebSocket server bound the port.
3. Spawns `backend/telemetryIngest.js` as a child process.
4. Waits for the ingest child to print `"hello from mockSignalK"` — proves the handshake round-tripped.
5. Parses ≥5 consecutive `[telemetryIngest] frame #N …` lines from the ingest child's stdout.
6. For each captured frame, asserts every field is within its marine envelope:

   | Field | Valid range |
   |---|---|
   | `lat` | `37.70 ≤ lat ≤ 37.82` (SF Bay trajectory) |
   | `lon` | `-122.52 ≤ lon ≤ -122.39` |
   | `sog` | `4.0 ≤ sog ≤ 8.5` (knots envelope) |
   | `hdg` | `0 ≤ hdg ≤ 360` |
   | `depth` | `0 < depth < 32.5` |
   | `prog` | `0 ≤ prog ≤ 1` |
   | `ts`   | matches `^\d{4}-\d{2}-\d{2}T` |

7. Asserts frame counters and timestamps are monotonically increasing — proves no frames were dropped, replayed, or reordered between the streamer and the ingest.
8. Prints the captured vectors to stdout for human inspection.

**Why we read stdout instead of poking at the ingest process:**

Reaching inside the ingest child to inspect its in-memory ring buffer would require either:

- IPC (slow, adds complexity),
- a shared-memory segment (portability headache),
- or rewriting the ingest to expose a debug HTTP endpoint (pollutes production code).

Reading the canonical log line is faster, simpler, and validates the *exact same hot path* a real consumer would see. Future phases can add IPC-based introspection without disrupting this contract.

### Section 4 — Resilience: graceful shutdown

Sends SIGTERM to the streamer, waits for it to exit, then sends SIGTERM to the ingest. Both should exit cleanly with no orphaned sockets, no port leaks, no zombie processes.

**Why this matters:** the ingest's reconnect logic only kicks in if `disconnect()` has *not* been called. By SIGTERMing both children in close succession, we ensure the test is hermetic — running it back-to-back won't cause port-3000-already-in-use failures.

### Section 5 — Teardown

Asserts both child processes have fully terminated. If we reach this line, the test exits with `process.exit(0)`.

---

## Running tests in isolation

```bash
# Only the streamer
node backend/mockSignalK.js &
node tests/streamer.smoke.js    # legacy single-component check

# Only the ingest (requires a running streamer)
node backend/mockSignalK.js &
node backend/telemetryIngest.js

# Just the unit tests (no child processes)
# (currently embedded in pipeline.test.js sections 1-2; can be split later)
```

---

## Adding a new test

When Phase 2 lands, the test suite will need to grow. Patterns to follow:

| New component | Test pattern |
|---|---|
| A new pure module (e.g., `embeddingMemory.js`) | Add a new `── Unit: … ──` section before Section 3. |
| A new module that depends on the ingest | Add a new `── End-to-end: … ──` section after Section 3. Spawn the new module as a child and assert its stdout. |
| A new external dependency (e.g., a local LLM) | Use `describe`-style skip semantics — log a clear "SKIPPED (reason)" and exit `0` if the dependency isn't available. Don't fail CI on missing optional services. |

### Assertion style

We use Node's built-in `node:assert/strict`. No third-party assertion library needed.

```js
const assert = require("assert/strict");

assert.equal(actual, expected);     // value equality
assert.deepEqual(actual, expected); // structural equality (for arrays/objects)
assert.ok(value);                   // truthiness
assert.throws(() => fn());          // expected exceptions
```

### Logging style

The test uses a small set of log prefixes so the output stays scannable:

| Prefix | Meaning |
|---|---|
| `[pipeline.test] ── … ──` | A test section header. |
| `[pipeline.test] ✓ …` | An assertion that passed. |
| `[pipeline.test] · …` | An informational line (no assertion). |
| `[pipeline.test] ✗ …` | An assertion that failed. |

---

## Common failure modes and how to read them

| Symptom | Likely cause |
|---|---|
| `Timed out waiting for /listening on/` | Port 3000 is already in use by a previous test run. Find the orphan: `Get-NetTCPConnection -LocalPort 3000 -State Listen` and kill it. |
| `Only saw N/5 frames in 15000 ms` | Streamer is alive but ingest isn't connecting. Check that `ws://127.0.0.1:3000` is reachable. |
| `frame counter regressed` | A frame was duplicated in the stream. This would indicate a bug in the broadcaster's frame-counter logic, not the ingest. |
| `frame timestamp regressed` | The simulator's clock went backward — would indicate a real bug in `Date.now()` handling. |

---

## CI integration (future)

When this project gets CI, the recommended command is:

```yaml
- run: npm ci
- run: npm test
```

The exit code from `npm test` is `0` on success and non-zero on failure. No additional parsing needed.