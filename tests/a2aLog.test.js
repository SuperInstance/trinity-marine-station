// tests/a2aLog.test.js
// =============================================================================
// Unit tests for A2aLog — the append-only audit log for A2A workspace mutations.
//
// Covers:
//   - Construction defaults + custom options
//   - append() basic write + record augmentation (_loggedAt, _seq)
//   - Sequence numbering monotonic across calls
//   - Batched flush coalescing (single underlying write for many appends)
//   - Size-based rotation triggers at maxBytes
//   - replay() reads across multiple files, newest-first
//   - replay({since}) filters by timestamp
//   - replay() tolerates corrupted lines
//   - flush() drains pending writes
//   - destroy() flushes + rejects further appends
//   - Directory is created on construction
//   - Multiple A2aLog instances don't collide
//   - Concurrent appends don't lose records
// =============================================================================

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, run, assert, assertEq } = require("./_harness");
const { A2aLog, DEFAULT_DIR, DEFAULT_MAX_BYTES } = require("../backend/a2aLog");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trinity-a2alog-${label}-`));
  return dir;
}

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // tolerate cleanup failures
  }
}

async function readAllLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const lines = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of content.split("\n")) {
      if (line) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

run("a2aLog", async () => {

test("A2aLog: constructor defaults", async () => {
  const log = new A2aLog();
  assert(log.stats().dir === path.resolve(DEFAULT_DIR), "default dir");
  assert(log.stats().maxBytes === DEFAULT_MAX_BYTES, "default maxBytes");
  assert(log.stats().activeBytes === 0, "starts at 0 bytes");
  assert(log.stats().pendingWrites === 0, "no pending writes");
  assert(log.stats().destroyed === false, "not destroyed");
  await log.destroy();
});

test("A2aLog: constructor custom opts", async () => {
  const dir = makeTempDir("opts");
  try {
    const log = new A2aLog({
      dir,
      maxBytes: 500,
      namePrefix: "custom",
      timestamp: "2026-07-25T18:00:00.000Z",
    });
    assert(log.stats().maxBytes === 500, "maxBytes honored");
    assert(log.stats().dir === dir, "dir honored");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: directory is created on construction", async () => {
  const nested = path.join(os.tmpdir(), "trinity-a2alog-nested-" + Date.now(), "deep");
  try {
    assert(!fs.existsSync(nested), "precondition: dir doesn't exist");
    const log = new A2aLog({ dir: nested });
    assert(fs.existsSync(nested), "dir created");
    await log.destroy();
  } finally {
    cleanupDir(path.dirname(nested));
  }
});

test("A2aLog: append returns augmented record with _loggedAt and _seq", async () => {
  const dir = makeTempDir("append");
  try {
    const log = new A2aLog({ dir, timestamp: "2026-07-25T18:00:00.000Z" });
    const rec = await log.append({
      action: "morph_to_hazard_mode",
      priority: 0.95,
      reason: "Shallow water ahead",
    });
    assert(rec._loggedAt === "2026-07-25T18:00:00.000Z", "_loggedAt set");
    assert(rec._seq === 1, "_seq starts at 1");
    assert(rec.action === "morph_to_hazard_mode", "action preserved");
    assert(rec.priority === 0.95, "priority preserved");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: sequence is monotonic across calls", async () => {
  const dir = makeTempDir("seq");
  try {
    const log = new A2aLog({ dir });
    const r1 = await log.append({ action: "raise_alert", priority: 0.5 });
    const r2 = await log.append({ action: "raise_alert", priority: 0.6 });
    const r3 = await log.append({ action: "raise_alert", priority: 0.7 });
    assert(r1._seq === 1, "first seq");
    assert(r2._seq === 2, "second seq");
    assert(r3._seq === 3, "third seq");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: batches writes into a single underlying file write", async () => {
  const dir = makeTempDir("batch");
  try {
    // Long flush window so we can confirm batching
    const log = new A2aLog({ dir });
    // Fire 5 appends in the same tick — they should all batch
    const promises = [
      log.append({ action: "raise_alert", priority: 0.1 }),
      log.append({ action: "raise_alert", priority: 0.2 }),
      log.append({ action: "raise_alert", priority: 0.3 }),
      log.append({ action: "raise_alert", priority: 0.4 }),
      log.append({ action: "raise_alert", priority: 0.5 }),
    ];
    assert(log.stats().pendingWrites === 5, "all 5 queued before flush");
    const results = await Promise.all(promises);
    await log.destroy();
    assert(results.length === 5, "all resolve");
    // All 5 records should be on disk in a single file
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert(files.length === 1, "exactly one log file (" + files.length + ")");
    const lines = await readAllLines(dir);
    assert(lines.length === 5, "5 records persisted");
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: rotation triggers when active file exceeds maxBytes", async () => {
  const dir = makeTempDir("rotate");
  try {
    const log = new A2aLog({ dir, maxBytes: 1000 });
    // Each record is roughly 200-300 bytes; write enough to force >1 rotation
    const action = { action: "raise_alert", priority: 0.5, reason: "x".repeat(150) };
    for (let i = 0; i < 20; i++) {
      await log.append(action);
    }
    await log.destroy();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert(files.length >= 2, "rotated to >=2 files (got " + files.length + ")");
    // Verify all records survived
    const lines = await readAllLines(dir);
    assert(lines.length === 20, "all 20 records persisted across rotations");
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: replay returns newest records first across files", async () => {
  const dir = makeTempDir("replay");
  try {
    const log = new A2aLog({ dir, maxBytes: 500 });
    for (let i = 0; i < 15; i++) {
      await log.append({ action: "raise_alert", priority: i / 10 });
    }
    await log.flush();
    const recent = await log.replay({ limit: 5 });
    assert(recent.length === 5, "returns 5 newest");
    // Newest should be the last appended (priority 1.4)
    assert(recent[0].priority === 1.4, "newest first (priority 1.4)");
    // And the records should be in descending order
    assert(recent[0].priority > recent[4].priority, "descending order");
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: replay honors since filter", async () => {
  const dir = makeTempDir("since");
  try {
    const log = new A2aLog({ dir, timestamp: "2026-07-25T10:00:00.000Z" });
    await log.append({ action: "raise_alert", priority: 0.1 });
    await log.flush();
    const recent = await log.replay({ limit: 10, since: "2026-07-25T09:00:00.000Z" });
    assert(recent.length === 1, "since filter includes the record");
    const tooLate = await log.replay({ limit: 10, since: "2026-07-25T11:00:00.000Z" });
    assert(tooLate.length === 0, "since filter excludes old records");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: replay tolerates corrupted lines", async () => {
  const dir = makeTempDir("corrupt");
  try {
    const log = new A2aLog({ dir, timestamp: "2026-07-25T12:00:00.000Z" });
    await log.append({ action: "raise_alert", priority: 0.5 });
    await log.flush();
    // Inject corrupted line directly into the file
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    fs.appendFileSync(path.join(dir, file), "this is not valid JSON\n");
    await log.append({ action: "raise_alert", priority: 0.9 });
    await log.flush();
    const recent = await log.replay({ limit: 10 });
    assert(recent.length === 2, "skips corrupted line, returns 2 valid");
    assert(recent[0].priority === 0.9, "newest first");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: flush drains pending writes immediately", async () => {
  const dir = makeTempDir("flush");
  try {
    const log = new A2aLog({ dir });
    const p = log.append({ action: "raise_alert", priority: 0.5 });
    const before = log.stats().pendingWrites;
    assert(before === 1, "1 pending before flush");
    await log.flush();
    assert(log.stats().pendingWrites === 0, "0 pending after flush");
    await p;  // resolves
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: destroy flushes and rejects subsequent appends", async () => {
  const dir = makeTempDir("destroy");
  try {
    const log = new A2aLog({ dir });
    await log.append({ action: "raise_alert", priority: 0.5 });
    await log.destroy();
    assert(log.stats().destroyed === true, "marked destroyed");
    let threw = false;
    try {
      await log.append({ action: "raise_alert", priority: 0.6 });
    } catch (e) {
      threw = true;
      assert(/destroy/.test(e.message), "error mentions destroy");
    }
    assert(threw, "append after destroy throws");
    // destroy is idempotent
    await log.destroy();
    assert(log.stats().destroyed === true, "still destroyed (idempotent)");
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: concurrent appends all persist", async () => {
  const dir = makeTempDir("concurrent");
  try {
    const log = new A2aLog({ dir });
    const N = 50;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(log.append({ action: "raise_alert", priority: i / 100, _marker: i }));
    }
    const results = await Promise.all(promises);
    await log.destroy();
    const lines = await readAllLines(dir);
    assert(lines.length === N, "all " + N + " records persisted");
    // All seqs should be unique
    const seqs = new Set(results.map((r) => r._seq));
    assert(seqs.size === N, "all seqs unique");
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: multiple instances don't collide", async () => {
  const dir = makeTempDir("multi");
  try {
    const a = new A2aLog({ dir, namePrefix: "alpha" });
    const b = new A2aLog({ dir, namePrefix: "beta" });
    await a.append({ action: "raise_alert", priority: 0.1 });
    await b.append({ action: "morph_to_hazard_mode", priority: 0.9 });
    await a.destroy();
    await b.destroy();
    const files = fs.readdirSync(dir);
    assert(files.some((f) => f.startsWith("alpha")), "alpha file exists");
    assert(files.some((f) => f.startsWith("beta")), "beta file exists");
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: record round-trips through JSON losslessly", async () => {
  const dir = makeTempDir("roundtrip");
  try {
    const log = new A2aLog({ dir });
    const original = {
      action: "morph_to_hazard_mode",
      priority: 0.87,
      reason: "Multi-line\nreason with special chars: \"quotes\", \u00e9\u00e8",
      params: { depth: 1.2, sog: 5.4, hdg: 45 },
    };
    await log.append(original);
    await log.flush();
    const lines = await readAllLines(dir);
    assert(lines.length === 1, "1 record");
    const r = lines[0];
    assert(r.action === original.action, "action preserved");
    assert(r.priority === original.priority, "priority preserved");
    assert(r.reason === original.reason, "unicode/newlines preserved");
    assert(r.params.depth === 1.2, "nested params preserved");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: empty replay returns empty array", async () => {
  const dir = makeTempDir("empty");
  try {
    const log = new A2aLog({ dir });
    const recent = await log.replay({ limit: 10 });
    assert(Array.isArray(recent), "returns array");
    assert(recent.length === 0, "empty when no files");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: respect timestamp injection for deterministic filenames", async () => {
  const dir = makeTempDir("deterministic");
  try {
    const log = new A2aLog({ dir, timestamp: "2026-07-25T18:00:00.000Z" });
    await log.append({ action: "raise_alert", priority: 0.5 });
    await log.flush();
    const files = fs.readdirSync(dir);
    assert(files.length === 1, "one file");
    assert(files[0].includes("2026-07-25T18-00-00-000Z"), "filename has timestamp");
    assert(!files[0].includes(":"), "no colons in filename (Windows-safe)");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

test("A2aLog: stats reflects pending writes accurately", async () => {
  const dir = makeTempDir("stats");
  try {
    const log = new A2aLog({ dir });
    const p1 = log.append({ action: "raise_alert", priority: 0.1 });
    const p2 = log.append({ action: "raise_alert", priority: 0.2 });
    assert(log.stats().pendingWrites === 2, "2 pending");
    await Promise.all([p1, p2]);
    assert(log.stats().pendingWrites === 0, "0 pending after drain");
    await log.destroy();
  } finally {
    cleanupDir(dir);
  }
});

}); // end run("a2aLog")
