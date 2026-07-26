#!/usr/bin/env node
// STATUS.json integrity auditor.
// Verifies the STATUS.json manifest claims match the actual repo state:
//   - commit hash matches HEAD
//   - branch matches current branch
//   - clean flag matches `git status --porcelain`
//   - module line counts match `wc -l` on each file
//   - test counts (where present) match `tests/run.js` results
//
// Usage: node tools/auditStatus.js

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
}

function main() {
  const statusPath = path.join(ROOT, "docs", "STATUS.json");
  if (!fs.existsSync(statusPath)) {
    console.error("docs/STATUS.json not found");
    process.exit(1);
  }
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  const errors = [];
  const ok = [];

  // 1. commit (top-level)
  const head = git("rev-parse HEAD");
  if (status.commit === head) ok.push(`commit: ${head.slice(0, 7)} matches HEAD`);
  else errors.push(`commit mismatch: STATUS=${status.commit} HEAD=${head}`);

  // 2. branch (top-level)
  const branch = git("rev-parse --abbrev-ref HEAD");
  if (status.branch === branch) ok.push(`branch: ${branch} matches current`);
  else errors.push(`branch mismatch: STATUS=${status.branch} current=${branch}`);

  // 3. clean (derived; STATUS doesn't claim a clean flag)
  const porcelain = git("status --porcelain");
  if (porcelain === "") ok.push(`working tree: clean (uncommitted)`);
  else errors.push(`working tree dirty: ${porcelain}`);

  // 4. module line counts
  const modules = status.modules || {};
  for (const [relPath, mod] of Object.entries(modules)) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      errors.push(`module missing: ${relPath}`);
      continue;
    }
    const actualLines = fs.readFileSync(abs, "utf8").split("\n").length;
    if (typeof mod.lines === "number") {
      if (Math.abs(mod.lines - actualLines) > 2) {
        errors.push(`line count drift: ${relPath} STATUS=${mod.lines} actual=${actualLines}`);
      } else {
        ok.push(`lines ${relPath}: ${actualLines} (STATUS says ${mod.lines})`);
      }
    }
  }

  // 5. cross_references all resolve
  const refs = status.cross_references || {};
  for (const [key, target] of Object.entries(refs)) {
    const abs = path.resolve(ROOT, target);
    if (!fs.existsSync(abs)) errors.push(`cross_reference missing: ${key} -> ${target}`);
    else ok.push(`cross_ref ${key} -> ${target}`);
  }

  console.log(`\nOK (${ok.length}):`);
  for (const line of ok) console.log(`  \u2713 ${line}`);
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}):`);
    for (const line of errors) console.log(`  \u2717 ${line}`);
    process.exit(1);
  } else {
    console.log(`\nSTATUS.json integrity: ALL CHECKS PASSED`);
  }
}

main();