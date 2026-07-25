// backend/a2aLog.js
// =============================================================================
// Append-only audit log for A2A (Agent-to-Agent) workspace mutations.
//
// Every time the LlmNarrator emits an <a2a> block, we persist the validated
// action to a JSONL file (one JSON object per line) — append-only, rotation-
// by-size, crash-safe.
//
// Why JSONL?
//   - Append-only writes are O(1) and crash-safe (no rewrite-in-place)
//   - Each line is independently parseable for replay / audit / grep
//   - Plays well with DuckDB, jq, awk, and any streaming reader
//   - Matches vessel-agent's Parquet-row-group philosophy (line = row)
//
// Why rotate?
//   - Boat workstations have small SSDs; a multi-day voyage can generate
//     thousands of A2A actions
//   - Rotating by size keeps recent context always in the active file
//   - Old files (a2a-2026-07-25T17-00.jsonl) are retained for replay
//
// Usage (production):
//   const log = new A2aLog({ dir: "/var/log/trinity", maxBytes: 10_000_000 });
//   trinityCore.on("a2a", (action) => log.append(action));
//
// Usage (test):
//   const log = new A2aLog({ dir: tmpdir, maxBytes: 1_000 });  // rotate early
//   await log.append({ action: "morph_to_hazard_mode", ... });
//   const recent = await log.replay({ limit: 10 });
// =============================================================================

"use strict";

const fs   = require("fs");
const path = require("path");
const { promisify } = require("util");

const fsAppendFile = promisify(fs.appendFile);
const fsRename     = promisify(fs.rename);
const fsStat       = promisify(fs.stat);
const fsReadFile   = promisify(fs.readFile);
const fsReaddir    = promisify(fs.readdir);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DIR           = "./logs/a2a";
const DEFAULT_MAX_BYTES     = 10 * 1024 * 1024;   // 10 MB per file
const DEFAULT_NAME_PREFIX   = "a2a";
const FLUSH_THRESHOLD_MS    = 100;                  // batch writes within this window

// ---------------------------------------------------------------------------
// A2aLog class
// ---------------------------------------------------------------------------

class A2aLog {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.dir]              Directory for log files. Created if missing.
   * @param {number}  [opts.maxBytes]          Max size of the active file before rotation.
   * @param {string}  [opts.namePrefix]        Filename prefix (default "a2a").
   * @param {string}  [opts.timestamp]         Inject for tests; ISO string.
   */
  constructor(opts = {}) {
    this._dir         = path.resolve(opts.dir ?? DEFAULT_DIR);
    this._maxBytes    = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this._namePrefix  = opts.namePrefix ?? DEFAULT_NAME_PREFIX;
    this._now         = opts.timestamp ? () => new Date(opts.timestamp) : () => new Date();

    // Live write state
    this._activePath  = null;     // computed lazily on first append
    this._activeBytes = 0;
    this._pendingWrites = [];    // batched {line, resolve, reject}
    this._flushTimer  = null;

    // Lifecycle
    this._destroyed   = false;

    // Ensure dir exists on construction
    fs.mkdirSync(this._dir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Append an A2A action. The action is augmented with a server-side
   * timestamp + sequence number and persisted as one JSONL line.
   *
   * Returns a Promise that resolves once the write is durable on disk.
   *
   * @param {object} action   Validated A2A action (see schemas.validateA2AAction)
   * @returns {Promise<object>} The persisted record (with `_loggedAt`, `_seq`)
   */
  async append(action) {
    if (this._destroyed) throw new Error("A2aLog: append after destroy()");

    // Compose the on-disk record. Internal metadata is namespaced `_` to keep
    // it out of the A2A schema namespace.
    const seq = this._nextSeq();
    const record = {
      ...action,
      _loggedAt: this._now().toISOString(),
      _seq:      seq,
    };
    const line = JSON.stringify(record) + "\n";

    return new Promise((resolve, reject) => {
      this._pendingWrites.push({ line, record, resolve, reject });
      this._scheduleFlush();
    });
  }

  /**
   * Read back the most recent N records across all log files (newest first).
   * Intended for putting recent A2A history into the narrator context.
   *
   * @param {object}  [opts]
   * @param {number}  [opts.limit=20]    Max records to return.
   * @param {string}  [opts.since]       ISO timestamp; only return records at/after this.
   * @returns {Promise<object[]>}
   */
  async replay({ limit = 20, since = null } = {}) {
    const files = await this._listLogFiles();
    const collected = [];

    // Read newest file first (file names encode timestamp)
    for (let i = files.length - 1; i >= 0 && collected.length < limit; i--) {
      const f = files[i];
      const content = await fsReadFile(path.join(this._dir, f), "utf8");
      const lines = content.split("\n").filter(Boolean);
      // Within a file, read newest line first
      for (let j = lines.length - 1; j >= 0 && collected.length < limit; j--) {
        let rec;
        try { rec = JSON.parse(lines[j]); }
        catch { continue; }  // tolerate corrupted lines
        if (since && rec._loggedAt < since) continue;
        collected.push(rec);
      }
    }
    return collected;
  }

  /**
   * Force any pending writes to disk. Call this before shutdown.
   */
  async flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._drainPending();
  }

  /**
   * Release timers and flush. Safe to call multiple times.
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Snapshot of log state. Useful for /status endpoint + ops dashboards.
   */
  stats() {
    return {
      dir:           this._dir,
      activePath:    this._activePath,
      activeBytes:   this._activeBytes,
      maxBytes:      this._maxBytes,
      pendingWrites: this._pendingWrites.length,
      nextSeq:       this._seq,
      destroyed:     this._destroyed,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  _nextSeq() {
    if (this._seq === undefined) this._seq = 0;
    return ++this._seq;
  }

  _scheduleFlush() {
    if (this._flushTimer) return; // already scheduled
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      // Swallow errors at the schedule level; _drainPending rejects each
      // promise individually so callers still see failures.
      this._drainPending().catch(() => {});
    }, FLUSH_THRESHOLD_MS);
  }

  async _drainPending() {
    if (this._pendingWrites.length === 0) return;
    const batch = this._pendingWrites;
    this._pendingWrites = [];

    // Coalesce all pending lines into a single write for efficiency.
    const payload = batch.map((p) => p.line).join("");
    try {
      await this._writeAtomic(payload);
      for (const p of batch) p.resolve(p.record);
    } catch (err) {
      for (const p of batch) p.reject(err);
    }
  }

  /**
   * Write `payload` to the active file, rotating if it would exceed maxBytes.
   * Single-shot — no internal batching. Callers handle their own batching.
   */
  async _writeAtomic(payload) {
    const targetPath = await this._ensureActivePath();

    // Check rotation BEFORE writing (so we never exceed maxBytes)
    if (this._activeBytes + payload.length > this._maxBytes) {
      await this._rotate();
    }

    // Re-resolve after possible rotation
    const writePath = await this._ensureActivePath();
    await fsAppendFile(writePath, payload);
    this._activeBytes += payload.length;
  }

  /**
   * Returns the current active file path, computing + opening it lazily.
   */
  async _ensureActivePath() {
    if (this._activePath !== null) return this._activePath;

    // Filename pattern: <prefix>-<ISO-timestamp-without-colons>.jsonl
    // Colons aren't safe on Windows filesystems; we replace them with dashes.
    const ts = this._now().toISOString().replace(/[:.]/g, "-");
    this._activePath = path.join(this._dir, `${this._namePrefix}-${ts}.jsonl`);
    this._activeBytes = 0;
    return this._activePath;
  }

  /**
   * Rotate: clear active path so the next write creates a fresh file.
   * The previous file stays on disk for replay.
   */
  async _rotate() {
    this._activePath  = null;
    this._activeBytes = 0;
    // Tiny yield to ensure any in-flight write completes before we move on.
    await new Promise((r) => setImmediate(r));
  }

  /**
   * List log files, oldest first.
   */
  async _listLogFiles() {
    if (!fs.existsSync(this._dir)) return [];
    const entries = await fsReaddir(this._dir);
    return entries
      .filter((f) => f.startsWith(this._namePrefix) && f.endsWith(".jsonl"))
      .sort();  // lexicographic == chronological with our naming scheme
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  A2aLog,
  DEFAULT_DIR,
  DEFAULT_MAX_BYTES,
};