/**
 * tests/a2aQuery.test.js
 * ----------------------------------------------------------------------------
 * End-to-end tests for the A2aQuery read-side layer.
 *
 * Coverage:
 *   1. Empty / missing directory returns []
 *   2. Malformed lines are skipped, not crashed on
 *   3. Filters: kind, action, since, until, minPriority, maxPriority,
 *      reasonContains (each tested individually + combined)
 *   4. countBy groups correctly and skips records missing the field
 *   5. topBy returns sorted desc + respects limit
 *   6. bucketBy buckets time correctly across intervals
 *   7. summary computes totals, byKind, byAction, and time range
 *   8. Verbose mode emits warnings on stderr for malformed lines
 *
 * Each test creates a fresh temp directory and writes a deterministic
 * fixture log so we don't depend on the production log state.
 * ----------------------------------------------------------------------------
 */

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { run, test, assert, assertEq } = require("./_harness");
const { A2aQuery, recordMatches, isA2aLogFilename } = require("../backend/a2aQuery");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trinity-a2a-query-test-"));
}

/**
 * Write a synthetic A2aLog-style JSONL file into the temp dir.
 * Returns the full path.
 *
 * Each record is augmented with `_loggedAt`/`_seq` to mimic what
 * A2aLog actually writes — this catches accidental coupling on those
 * internal fields.
 */
function writeLog(dir, records, opts = {}) {
  const ts = opts.timestamp || new Date().toISOString();
  const safeTs = ts.replace(/[:.]/g, "-");
  const fname = `a2a-${safeTs}.jsonl`;
  const full = path.join(dir, fname);
  const lines = records.map((r, i) =>
    JSON.stringify({ ...r, _loggedAt: ts, _seq: i + 1 })
  );
  fs.writeFileSync(full, lines.join("\n") + "\n", "utf8");
  // Touch mtime explicitly so file ordering is deterministic.
  if (opts.mtimeMs !== undefined) {
    const atime = new Date(opts.mtimeMs);
    const mtime = new Date(opts.mtimeMs);
    fs.utimesSync(full, atime, mtime);
  }
  return full;
}

/**
 * Build a stable set of records covering all filter dimensions.
 * Returns 10 records spread across kinds, actions, priorities,
 * reasons, and timestamps.
 */
function buildFixtureRecords(baseIsoMs) {
  // Incrementing base times so `since`/`until` tests have headroom.
  const at = (offsetMs) => new Date(baseIsoMs + offsetMs).toISOString();
  return [
    { kind: "action", action: "morph_to_hazard_mode", priority: 0.95,
      reason: "depth plunge to 1.2 m", ts: at(0) },
    { kind: "action", action: "raise_alert", priority: 0.7,
      reason: "wind shift", ts: at(60_000) },
    { kind: "action", action: "raise_alert", priority: 0.4,
      reason: "minor course deviation", ts: at(120_000) },
    { kind: "action", action: "clear_alerts", priority: 0.3,
      reason: "all clear", ts: at(180_000) },
    { kind: "action", action: "morph_to_hazard_mode", priority: 0.6,
      reason: "depth plunge to 0.9 m", ts: at(240_000) },
    { kind: "ack", action_id: 1, ts: at(300_000) },
    { kind: "ack", action_id: 2, ts: at(360_000) },
    { kind: "action", action: "announce", priority: 0.5,
      reason: "shift change", ts: at(420_000) },
    { kind: "action", action: "raise_alert", priority: 0.99,
      reason: "MAYDAY relay", ts: at(480_000) },
    // Record with priority missing — should be filtered out by min/max tests
    // but still counted in summary.totalRecords if no filter.
    { kind: "action", action: "log_only", reason: "no priority set",
      ts: at(540_000) },
  ];
}

// ---------------------------------------------------------------------------
// Unit-level tests for pure helpers
// ---------------------------------------------------------------------------

run("a2aQuery helpers", async () => {

  await test("isA2aLogFilename accepts canonical names", () => {
    assert(isA2aLogFilename("a2a-2026-07-25T22-29-23-986Z.jsonl"));
    assert(isA2aLogFilename("a2a.jsonl"));
  });

  await test("isA2aLogFilename rejects foreign files", () => {
    assert(!isA2aLogFilename("notes.md"));
    assert(!isA2aLogFilename("trinity-2026.jsonl"));
    assert(!isA2aLogFilename("a2a.txt"));
    assert(!isA2aLogFilename(""));
    assert(!isA2aLogFilename(null));
    assert(!isA2aLogFilename(undefined));
  });

  await test("recordMatches: empty filter passes everything valid", () => {
    assert(recordMatches({ kind: "action", action: "x", ts: "2026-01-01" }, {}));
  });

  await test("recordMatches: kind exact match", () => {
    assert(recordMatches({ kind: "action" }, { kind: "action" }));
    assert(!recordMatches({ kind: "ack" }, { kind: "action" }));
    assert(!recordMatches({}, { kind: "action" }));
  });

  await test("recordMatches: action exact match", () => {
    assert(recordMatches({ action: "morph_to_hazard_mode" },
                          { action: "morph_to_hazard_mode" }));
    assert(!recordMatches({ action: "raise_alert" },
                          { action: "morph_to_hazard_mode" }));
  });

  await test("recordMatches: since / until time window", () => {
    const rec = { ts: "2026-07-25T12:00:00Z" };
    assert(recordMatches(rec, { since: "2026-07-25T11:00:00Z" }));
    assert(!recordMatches(rec, { since: "2026-07-25T13:00:00Z" }));
    assert(recordMatches(rec, { until: "2026-07-25T13:00:00Z" }));
    assert(!recordMatches(rec, { until: "2026-07-25T11:00:00Z" }));
    assert(recordMatches(rec, {
      since: "2026-07-25T11:00:00Z",
      until: "2026-07-25T13:00:00Z",
    }));
    assert(!recordMatches(rec, {
      since: "2026-07-25T11:00:00Z",
      until: "2026-07-25T12:00:00Z", // exclusive end
    }));
  });

  await test("recordMatches: priority range", () => {
    assert(recordMatches({ priority: 0.5 }, { minPriority: 0.4 }));
    assert(!recordMatches({ priority: 0.3 }, { minPriority: 0.4 }));
    assert(recordMatches({ priority: 0.5 }, { maxPriority: 0.9 }));
    assert(!recordMatches({ priority: 0.95 }, { maxPriority: 0.9 }));
    assert(recordMatches({ priority: 0.7 }, { minPriority: 0.5, maxPriority: 0.9 }));
    assert(!recordMatches({ priority: 0.4 }, { minPriority: 0.5, maxPriority: 0.9 }));
    // Missing priority excludes the record when min/max set
    assert(!recordMatches({}, { minPriority: 0.0 }));
  });

  await test("recordMatches: reasonContains substring", () => {
    assert(recordMatches({ reason: "depth plunge to 1.2 m" },
                          { reasonContains: "plunge" }));
    assert(!recordMatches({ reason: "all clear" },
                           { reasonContains: "plunge" }));
    assert(!recordMatches({}, { reasonContains: "anything" }));
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

run("a2aQuery", async () => {

  await test("empty directory returns []", async () => {
    const dir = tmpDir();
    try {
      const q = new A2aQuery({ dir });
      const out = await q.query();
      assertEq(out.length, 0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("missing directory returns [] (does not throw)", async () => {
    const dir = path.join(os.tmpdir(), "trinity-a2a-query-nonexistent-", Date.now().toString());
    const q = new A2aQuery({ dir });
    const out = await q.query();
    assertEq(out.length, 0);
  });

  await test("reads all records from a single file", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = buildFixtureRecords(baseMs);
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const out = await q.query();
      assertEq(out.length, records.length);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("reads across multiple files, oldest first by mtime", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = buildFixtureRecords(baseMs);

      // Write 3 NON-OVERLAPPING files in REVERSE mtime order to confirm
      // mtime (not filename) drives the iteration order. Each file holds
      // a unique subset; the concatenated count must equal the total.
      // Each call must use a unique `timestamp` so the filenames don't
      // collide and overwrite each other.
      writeLog(dir, records.slice(7, 10), { mtimeMs: baseMs + 200, timestamp: "2026-07-25T12:00:00.200Z" }); // 3
      writeLog(dir, records.slice(3, 7),  { mtimeMs: baseMs + 100, timestamp: "2026-07-25T12:00:00.100Z" }); // 4
      writeLog(dir, records.slice(0, 3),  { mtimeMs: baseMs,       timestamp: "2026-07-25T12:00:00.000Z" }); // 3

      const q = new A2aQuery({ dir });
      const out = await q.query();
      assertEq(out.length, records.length);
      // First record should be from the earliest file (file 1, slice 0).
      assertEq(out[0].action, records[0].action);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("filter: kind=action returns only action records", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const out = await q.query({ kind: "action" });
      // Fixture has 10 records; 2 are kind=ack.
      assertEq(out.length, 8);
      for (const r of out) assertEq(r.kind, "action");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("filter: action=morph_to_hazard_mode", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const out = await q.query({ action: "morph_to_hazard_mode" });
      assertEq(out.length, 2);
      for (const r of out) assertEq(r.action, "morph_to_hazard_mode");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("filter: combined kind+priority range", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const out = await q.query({ kind: "action", minPriority: 0.7 });
      // Fixture: morph_to_hazard_mode 0.95, raise_alert 0.7, raise_alert 0.99
      assertEq(out.length, 3);
      for (const r of out) {
        assertEq(r.kind, "action");
        assert(r.priority >= 0.7, `priority ${r.priority} below 0.7`);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("filter: time window narrows results", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      // Window covers records at offsets 60_000, 120_000, 180_000, 240_000.
      const out = await q.query({
        since: "2026-07-25T12:01:00Z",
        until: "2026-07-25T12:05:00Z",
      });
      assertEq(out.length, 4);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("filter: reasonContains substring", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const out = await q.query({ reasonContains: "plunge" });
      assertEq(out.length, 2);
      for (const r of out) assert(r.reason.includes("plunge"));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("malformed lines are skipped, not crashed", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const fname = path.join(dir, "a2a-bad.jsonl");
      const content = [
        JSON.stringify({ kind: "action", action: "good", ts: "2026-07-25T12:00:00Z" }),
        "{this is not valid json",
        "",
        JSON.stringify({ kind: "action", action: "also_good", ts: "2026-07-25T12:00:01Z" }),
        "[\"nope\"]", // valid JSON but wrong shape
      ].join("\n");
      fs.writeFileSync(fname, content, "utf8");
      fs.utimesSync(fname, new Date(baseMs), new Date(baseMs));

      const q = new A2aQuery({ dir });
      const out = await q.query();
      // Only the two valid object-shaped records survive. The array
      // shape `["nope"]` is valid JSON but recordMatches rejects arrays
      // (we want object records only, not arbitrary JSON values).
      assertEq(out.length, 2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("verbose mode emits warnings on stderr", async () => {
    const dir = tmpDir();
    try {
      const fname = path.join(dir, "a2a-bad.jsonl");
      fs.writeFileSync(fname, "this is not json\n", "utf8");
      const captured = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        captured.push(String(chunk));
        return true;
      };
      try {
        const q = new A2aQuery({ dir, verbose: true });
        await q.query();
      } finally {
        process.stderr.write = origWrite;
      }
      assert(captured.length > 0, "verbose mode should write a warning to stderr");
      assert(
        captured.some((s) => s.includes("[a2aQuery]")),
        `expected a2aQuery warning, got: ${captured.join("|")}`
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // countBy / topBy
  // -------------------------------------------------------------------------

  await test("countBy: groups by action and skips missing field", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const counts = await q.countBy({ field: "action" });
      assertEq(counts.get("raise_alert"), 3);
      assertEq(counts.get("morph_to_hazard_mode"), 2);
      assertEq(counts.get("clear_alerts"), 1);
      assertEq(counts.get("announce"), 1);
      // ack records don't have an action field, so they're skipped.
      assertEq(counts.has("undefined"), false);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("topBy: returns sorted desc and respects limit", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const top = await q.topBy({ field: "action", limit: 2 });
      assertEq(top.length, 2);
      assertEq(top[0].key, "raise_alert");
      assertEq(top[0].count, 3);
      assertEq(top[1].key, "morph_to_hazard_mode");
      assertEq(top[1].count, 2);
      // Strictly desc
      assert(top[0].count >= top[1].count);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("topBy: limit=0 returns []", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const top = await q.topBy({ field: "action", limit: 0 });
      assertEq(top.length, 0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("countBy: throws on missing field arg", async () => {
    const q = new A2aQuery({ dir: tmpDir() });
    let threw = false;
    try { await q.countBy({}); } catch (_) { threw = true; }
    assert(threw, "countBy without field should throw");
    threw = false;
    try { await q.topBy({}); } catch (_) { threw = true; }
    assert(threw, "topBy without field should throw");
  });

  // -------------------------------------------------------------------------
  // bucketBy
  // -------------------------------------------------------------------------

  await test("bucketBy: 1-minute buckets across 10 minutes", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      // 10 records, each offset by 1 minute from the previous.
      const records = [];
      for (let i = 0; i < 10; i++) {
        records.push({
          kind: "action",
          action: "tick",
          priority: 0.5,
          reason: `m${i}`,
          ts: new Date(baseMs + i * 60_000).toISOString(),
        });
      }
      writeLog(dir, records, { mtimeMs: baseMs });

      const q = new A2aQuery({ dir });
      const buckets = await q.bucketBy({ intervalMs: 60_000 });
      assertEq(buckets.length, 10);
      // Each bucket has exactly 1 record
      for (const b of buckets) assertEq(b.count, 1);
      // Sorted asc
      for (let i = 1; i < buckets.length; i++) {
        assert(buckets[i].ts > buckets[i - 1].ts);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("bucketBy: aggregates records into single bucket when within window", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [];
      for (let i = 0; i < 5; i++) {
        records.push({
          kind: "action",
          action: "burst",
          priority: 0.5,
          ts: new Date(baseMs + i * 100).toISOString(), // every 100ms
        });
      }
      writeLog(dir, records, { mtimeMs: baseMs });

      const q = new A2aQuery({ dir });
      const buckets = await q.bucketBy({ intervalMs: 60_000 });
      assertEq(buckets.length, 1);
      assertEq(buckets[0].count, 5);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("bucketBy: throws on invalid intervalMs", async () => {
    const q = new A2aQuery({ dir: tmpDir() });
    for (const bad of [0, -1, 1000.5, "x", null, undefined]) {
      let threw = false;
      try { await q.bucketBy({ intervalMs: bad }); } catch (_) { threw = true; }
      assert(threw, `bucketBy should throw on intervalMs=${JSON.stringify(bad)}`);
    }
  });

  // -------------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------------

  await test("summary: totals, byKind, byAction, timeRange", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const s = await q.summary();
      assertEq(s.totalRecords, 10);
      assertEq(s.byKind.get("action"), 8);
      assertEq(s.byKind.get("ack"), 2);
      assertEq(s.byAction.get("raise_alert"), 3);
      assertEq(s.byAction.get("morph_to_hazard_mode"), 2);
      // Time range spans from baseMs (offset 0) to baseMs + 540_000.
      assertEq(s.timeRange.earliest, new Date(baseMs).toISOString());
      assertEq(s.timeRange.latest, new Date(baseMs + 540_000).toISOString());
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("summary: empty log yields null timeRange", async () => {
    const dir = tmpDir();
    try {
      const q = new A2aQuery({ dir });
      const s = await q.summary();
      assertEq(s.totalRecords, 0);
      assertEq(s.timeRange.earliest, null);
      assertEq(s.timeRange.latest, null);
      assertEq(s.byKind.size, 0);
      assertEq(s.byAction.size, 0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("summary: respects filters", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      writeLog(dir, buildFixtureRecords(baseMs), { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });
      const s = await q.summary({ kind: "action", minPriority: 0.7 });
      assertEq(s.totalRecords, 3);
      assertEq(s.byKind.get("ack"), undefined); // filtered out
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // Source provenance filter (Phase 7+)
  //
  // Every A2A record carries a `source` field stamped at emission:
  //   "watcher"   - fired by WatcherRegistry (deterministic predicates)
  //   "narrator"  - proposed by the LLM narrator
  //   "system"    - default; replayed or synthesised records
  //
  // The `source` filter on `query()` lets retrospective queries answer
  // "what fraction of today's alerts came from watchers vs the LLM?".
  // -------------------------------------------------------------------------

  await test("recordMatches: source exact match", () => {
    assert(recordMatches({ source: "watcher" },  { source: "watcher" }));
    assert(recordMatches({ source: "narrator" }, { source: "narrator" }));
    assert(recordMatches({ source: "system" },   { source: "system" }));
    assert(!recordMatches({ source: "watcher" }, { source: "narrator" }));
    // Record missing source field does not match a source filter.
    assert(!recordMatches({}, { source: "watcher" }));
    // Empty filter does not constrain source.
    assert(recordMatches({ source: "watcher" }, {}));
  });

  await test("query: filters by source", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs).toISOString() },
        { kind: "action", action: "announce", priority: 0.5,
          source: "narrator", ts: new Date(baseMs + 60_000).toISOString() },
        { kind: "action", action: "clear_alerts", priority: 0.3,
          source: "watcher", ts: new Date(baseMs + 120_000).toISOString() },
        { kind: "action", action: "morph_to_hazard_mode", priority: 0.95,
          source: "narrator", ts: new Date(baseMs + 180_000).toISOString() },
        // Record without source (e.g. legacy pre-Phase-7 log line)
        { kind: "action", action: "raise_alert", priority: 0.7,
          ts: new Date(baseMs + 240_000).toISOString() },
      ];
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      const watcherActions = await q.query({ source: "watcher" });
      assertEq(watcherActions.length, 2);
      assert(watcherActions.every((r) => r.source === "watcher"));

      const narratorActions = await q.query({ source: "narrator" });
      assertEq(narratorActions.length, 2);
      assert(narratorActions.every((r) => r.source === "narrator"));

      // No record has source "system" in this fixture; result is empty.
      const systemActions = await q.query({ source: "system" });
      assertEq(systemActions.length, 0);

      // All 5 records are visible without source filter.
      const all = await q.query();
      assertEq(all.length, 5);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("query: source filter combines with other filters", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs).toISOString() },
        { kind: "action", action: "raise_alert", priority: 0.4,
          source: "watcher", ts: new Date(baseMs + 60_000).toISOString() },
        { kind: "action", action: "raise_alert", priority: 0.7,
          source: "narrator", ts: new Date(baseMs + 120_000).toISOString() },
      ];
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      // Watcher-fired raise_alerts with priority >= 0.5: 1 record.
      const out = await q.query({
        source: "watcher",
        action: "raise_alert",
        minPriority: 0.5,
      });
      assertEq(out.length, 1);
      assertEq(out[0].priority, 0.9);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("bySource: returns only records with matching source", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs).toISOString() },
        { kind: "action", action: "announce", priority: 0.5,
          source: "narrator", ts: new Date(baseMs + 60_000).toISOString() },
        { kind: "action", action: "clear_alerts", priority: 0.3,
          source: "watcher", ts: new Date(baseMs + 120_000).toISOString() },
      ];
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      const watcherHits = await q.bySource("watcher");
      assertEq(watcherHits.length, 2);
      assert(watcherHits.every((r) => r.source === "watcher"));

      const narratorHits = await q.bySource("narrator");
      assertEq(narratorHits.length, 1);

      // Unknown source -> empty result, not error.
      const none = await q.bySource("nonexistent");
      assertEq(none.length, 0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("bySource: applies limit", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [];
      for (let i = 0; i < 5; i++) {
        records.push({
          kind: "action", action: "raise_alert", priority: 0.7,
          source: "watcher", ts: new Date(baseMs + i * 60_000).toISOString(),
        });
      }
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      const one = await q.bySource("watcher", { limit: 1 });
      assertEq(one.length, 1);

      const three = await q.bySource("watcher", { limit: 3 });
      assertEq(three.length, 3);

      // limit: 0 means "no cap" — returns all 5.
      const all = await q.bySource("watcher", { limit: 0 });
      assertEq(all.length, 5);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("bySource: composes with additional filters", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs).toISOString() },
        { kind: "action", action: "announce", priority: 0.5,
          source: "watcher", ts: new Date(baseMs + 60_000).toISOString() },
        { kind: "action", action: "raise_alert", priority: 0.7,
          source: "watcher", ts: new Date(baseMs + 120_000).toISOString() },
        { kind: "action", action: "raise_alert", priority: 0.4,
          source: "narrator", ts: new Date(baseMs + 180_000).toISOString() },
      ];
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      const watcherRaise = await q.bySource("watcher", {
        filters: { action: "raise_alert" },
      });
      assertEq(watcherRaise.length, 2);
      assert(watcherRaise.every(
        (r) => r.source === "watcher" && r.action === "raise_alert"
      ));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("bySource: rejects invalid source arg", async () => {
    const dir = tmpDir();
    try {
      const q = new A2aQuery({ dir });
      let threw = false;
      try { await q.bySource(""); } catch (_) { threw = true; }
      assert(threw);
      threw = false;
      try { await q.bySource(null); } catch (_) { threw = true; }
      assert(threw);
      threw = false;
      try { await q.bySource(undefined); } catch (_) { threw = true; }
      assert(threw);
      threw = false;
      try { await q.bySource(42); } catch (_) { threw = true; }
      assert(threw);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("sourceBreakdown: returns Map of source -> count", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs).toISOString() },
        { kind: "action", action: "raise_alert", priority: 0.7,
          source: "watcher", ts: new Date(baseMs + 60_000).toISOString() },
        { kind: "action", action: "announce", priority: 0.5,
          source: "narrator", ts: new Date(baseMs + 120_000).toISOString() },
        { kind: "action", action: "morph_to_hazard_mode", priority: 0.95,
          source: "narrator", ts: new Date(baseMs + 180_000).toISOString() },
        { kind: "action", action: "log_only", priority: 0.1,
          source: "system", ts: new Date(baseMs + 240_000).toISOString() },
        // Legacy record missing source: silently skipped by countBy
        // (records without the field are NOT bucketed under "unknown").
        { kind: "action", action: "raise_alert", priority: 0.5,
          ts: new Date(baseMs + 300_000).toISOString() },
      ];
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      const breakdown = await q.sourceBreakdown();
      assertEq(breakdown.get("watcher"), 2);
      assertEq(breakdown.get("narrator"), 2);
      assertEq(breakdown.get("system"), 1);
      // 5 records had `source` set; the 6th (legacy) is dropped.
      assertEq(breakdown.size, 3);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test("sourceBreakdown: respects filters (e.g. last hour only)", async () => {
    const dir = tmpDir();
    try {
      const baseMs = Date.parse("2026-07-25T12:00:00Z");
      const records = [
        // Outside the window
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs).toISOString() },
        // Inside the window
        { kind: "action", action: "raise_alert", priority: 0.9,
          source: "watcher", ts: new Date(baseMs + 60_000).toISOString() },
        { kind: "action", action: "announce", priority: 0.5,
          source: "narrator", ts: new Date(baseMs + 120_000).toISOString() },
      ];
      writeLog(dir, records, { mtimeMs: baseMs });
      const q = new A2aQuery({ dir });

      // Window starts after the first record.
      const breakdown = await q.sourceBreakdown({
        since: new Date(baseMs + 30_000).toISOString(),
      });
      assertEq(breakdown.get("watcher"), 1);
      assertEq(breakdown.get("narrator"), 1);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});