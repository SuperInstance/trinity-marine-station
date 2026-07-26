#!/usr/bin/env node
// Regenerate docs/STATUS.json from the actual repo state.
// Run: node tools/regenStatus.js
//
// This script preserves the manual schema/narrative fields and refreshes:
//   - generated_at
//   - commit (HEAD short hash)
//   - module line counts
//   - cross_references (auto-derived from file existence)
//
// Run BEFORE committing any change to STATUS.json so the file stays in sync.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const STATUS_PATH = path.join(ROOT, "docs", "STATUS.json");

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
}
function lineCount(file) {
  return fs.readFileSync(file, "utf8").split("\n").length;
}

const status = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
status.generated_at = new Date().toISOString();
status.commit = git("rev-parse HEAD");

// Refresh module line counts
const modules = status.modules || {};
for (const relPath of Object.keys(modules)) {
  const abs = path.join(ROOT, relPath);
  if (fs.existsSync(abs)) modules[relPath].lines = lineCount(abs);
  else delete modules[relPath];
}

// Add audit tools if not present
if (!modules["tools/auditLinks.js"]) {
  modules["tools/auditLinks.js"] = {
    lines: lineCount(path.join(ROOT, "tools/auditLinks.js")),
    phase: "5+",
    exports: ["main"],
    deps_internal: [],
    deps_external: ["fs", "path"],
    purpose: "Cross-doc link auditor. Walks every .md/.json/.jsonl file and verifies relative paths resolve."
  };
}
if (!modules["tools/auditStatus.js"]) {
  modules["tools/auditStatus.js"] = {
    lines: lineCount(path.join(ROOT, "tools/auditStatus.js")),
    phase: "5+",
    exports: ["main"],
    deps_internal: [],
    deps_external: ["fs", "path", "child_process"],
    purpose: "STATUS.json integrity auditor. Verifies commit, branch, line counts, and cross-references match the live repo."
  };
}
if (!modules["tools/auditRequires.js"]) {
  modules["tools/auditRequires.js"] = {
    lines: lineCount(path.join(ROOT, "tools/auditRequires.js")),
    phase: "5+",
    exports: ["main"],
    deps_internal: [],
    deps_external: ["fs", "path"],
    purpose: "Module resolution auditor. Resolves every require() in backend/ and tests/ to confirm the target file exists."
  };
}
if (!modules["tools/regenStatus.js"]) {
  modules["tools/regenStatus.js"] = {
    lines: lineCount(path.join(ROOT, "tools/regenStatus.js")),
    phase: "5+",
    exports: ["main"],
    deps_internal: [],
    deps_external: ["fs", "path", "child_process"],
    purpose: "Regenerates docs/STATUS.json from the live repo state (commit hash + line counts)."
  };
}
if (!modules["tools/smokeDaemon.js"]) {
  modules["tools/smokeDaemon.js"] = {
    lines: lineCount(path.join(ROOT, "tools/smokeDaemon.js")),
    phase: "5+",
    exports: ["main"],
    deps_internal: [],
    deps_external: ["http", "child_process", "path"],
    purpose: "Daemon end-to-end smoke test. Boots trinityDaemon, hits /health + /status, asserts a2aBridge section, graceful shutdown."
  };
}

// Update test suite total
const tests = status.tests || {};
if (tests.suites) {
  for (const suite of tests.suites) {
    if (!suite.file) continue;
    const abs = path.join(ROOT, suite.file);
    if (fs.existsSync(abs)) suite.lines = lineCount(abs);
  }
}

// Write back with 2-space indent (matches existing format)
fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + "\n");
console.log(`STATUS.json refreshed at ${status.generated_at} (commit ${status.commit.slice(0,7)})`);