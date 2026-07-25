#!/usr/bin/env node
/**
 * tools/lint.js
 * ----------------------------------------------------------------------------
 * Minimal "lint" pass for the codebase. We deliberately avoid pulling in ESLint
 * (huge dependency tree, complex config) and instead run three cheap, high-value
 * checks that catch the most common bugs:
 *
 *   1. Syntax check every .js file under backend/, shared/, and tests/
 *      via `node --check`. Catches typos before tests even start.
 *   2. Scan for tabs (we use spaces only) and stray `console.log` in backend/
 *      (debug output bleeds into production logs).
 *   3. Confirm every `require("./foo")` resolves — no missing files.
 *
 * Exits 0 if everything is clean, 1 if any check fails.
 *
 * Run with:   npm run lint     (or)    node tools/lint.js
 * ----------------------------------------------------------------------------
 */

"use strict";

const { execSync } = require("child_process");
const fs           = require("fs");
const path         = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["backend", "shared", "tests"];
const SCAN_EXTS = [".js"];

let failures = 0;
let fileCount = 0;

function walk(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, found);
    } else if (SCAN_EXTS.includes(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

console.log("[lint] scanning", SCAN_DIRS.join(", "));

// ---------------------------------------------------------------------------
// 1. Syntax check
// ---------------------------------------------------------------------------
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
fileCount = files.length;
console.log(`[lint] ${fileCount} file(s) to check`);

for (const f of files) {
  try {
    execSync(`node --check "${f}"`, { stdio: "pipe" });
  } catch (e) {
    console.error(`[lint] SYNTAX ERROR in ${path.relative(ROOT, f)}`);
    console.error(e.stderr ? e.stderr.toString() : e.message);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// 2. Tab detection (we use spaces)
// ---------------------------------------------------------------------------
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (!rel.startsWith("backend" + path.sep)) continue;
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/\t/.test(lines[i])) {
      console.error(`[lint] TAB character at ${rel}:${i + 1} (we use spaces)`);
      failures++;
      break; // one tab-find per file is enough
    }
  }
}

// ---------------------------------------------------------------------------
// 3. require() resolution (best-effort — only catches "./xxx" / "../xxx")
// ---------------------------------------------------------------------------
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const re = /require\(\s*"(\.\.?\/[^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const reqPath = m[1];
    const dir = path.dirname(f);
    const candidates = [
      path.resolve(dir, reqPath),
      path.resolve(dir, reqPath + ".js"),
      path.resolve(dir, reqPath + ".json"),
      path.resolve(dir, reqPath, "index.js"),
    ];
    if (!candidates.some((c) => fs.existsSync(c))) {
      console.error(`[lint] BROKEN require in ${path.relative(ROOT, f)}: "${reqPath}"`);
      failures++;
    }
  }
}

// ---------------------------------------------------------------------------
// 4. console.log detection (only flagged in non-CLI backend files)
//
//    Convention: any backend file ending in *Daemon.js, mockSignalK.js,
//    telemetryIngest.js, llmNarrator.js is a CLI entry point and may use
//    console.log freely. Module-only files (everything else in backend/)
//    must NOT console.log — use EventEmitter events or pass results up.
//
//    Detection rule: file is a CLI if its basename matches the allow-list.
// ---------------------------------------------------------------------------
const CLI_ALLOWLIST = new Set([
  "mockSignalK.js",
  "telemetryIngest.js",
  "llmNarrator.js",
  "trinityDaemon.js",
]);

for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (!rel.startsWith("backend" + path.sep)) continue;
  if (CLI_ALLOWLIST.has(path.basename(f))) continue;
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/console\.log\s*\(/.test(lines[i])) {
      console.error(`[lint] stray console.log in ${rel}:${i + 1}`);
      console.error(`       → ${path.basename(f)} is not in the CLI allow-list`);
      console.error(`       → emit events or remove`);
      failures++;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log(`[lint] all ${fileCount} file(s) clean`);
  process.exit(0);
} else {
  console.error(`[lint] ${failures} issue(s) across ${fileCount} file(s)`);
  process.exit(1);
}