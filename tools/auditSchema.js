/**
 * tools/auditSchema.js
 * ----------------------------------------------------------------------------
 * Audits A2A documentation against the runtime allow-list.
 *
 * Checks performed:
 *   1. SCHEMA.json's `action.action.enum` matches A2A_ALLOWED_ACTIONS exactly
 *      (delegated to regenSchema.js --check).
 *   2. Every action name appearing in EXAMPLES.jsonl is in the allow-list.
 *   3. Every action name appearing in *.md documentation is in the allow-list.
 *
 * Exits non-zero on any violation. Output is one line per issue, then a
 * summary, so it can be wired into CI without further parsing.
 *
 * Why
 * ---
 * We hit the failure mode where docs listed action names that the bridge
 * silently rejected (`tag_waypoint`, `dim_panel`, `broadcast_to_fleet`, etc.).
 * Anyone copying examples verbatim got a non-functional client. This tool
 * is the tripwire that catches that drift before it ships.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT       = path.resolve(__dirname, "..");
const SCHEMA_PATH     = path.join(REPO_ROOT, "docs", "a2a", "SCHEMA.json");
const EXAMPLES_PATH   = path.join(REPO_ROOT, "docs", "a2a", "EXAMPLES.jsonl");
const A2A_DOCS_GLOB   = ["docs", "a2a"]; // folder prefix
const SCAN_MD_FILES   = ["docs/PHASE5.md", "docs/SYNERGY.md", "docs/ARCHITECTURE.md", "docs/OPERATIONS.md", "README.md", "AGENTS.md", "docs/a2a/QUICKREF.md"];

const regenSchema = require("./regenSchema");
const allowed = regenSchema.loadAllowedActions();
const allowedSet = new Set(allowed);

function rel(p) { return path.relative(REPO_ROOT, p); }

function deepFindActionNames(obj, pathStack = []) {
  // Find every string that appears to be an A2A action name within an
  // `action` object in the JSON tree. We look for `*.action.action` patterns
  // because that's the shape used in the wire protocol.
  const found = [];
  if (obj === null || typeof obj !== "object") return found;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => found.push(...deepFindActionNames(v, [...pathStack, i])));
    return found;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "action" && typeof v === "string" && pathStack.length > 0) {
      found.push({ name: v, where: pathStack.join(".") });
    } else if (typeof v === "object" && v !== null) {
      found.push(...deepFindActionNames(v, [...pathStack, k]));
    }
  }
  return found;
}

function checkSchemaEnum() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    return [`[auditSchema] FAIL: ${rel(SCHEMA_PATH)} missing`];
  }
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const enumList = schema?.$defs?.a2a_action?.properties?.action?.enum;
  if (!Array.isArray(enumList)) {
    return [`[auditSchema] FAIL: ${rel(SCHEMA_PATH)} has no $defs.a2a_action.properties.action.enum`];
  }
  const schemaSet = new Set(enumList);
  const issues = [];
  // In-scope-but-missing
  for (const a of allowed) {
    if (!schemaSet.has(a)) issues.push(`[auditSchema] FAIL: ${rel(SCHEMA_PATH)} enum is missing allowed action '${a}'`);
  }
  // Out-of-scope-but-present
  for (const s of enumList) {
    if (!allowedSet.has(s)) issues.push(`[auditSchema] FAIL: ${rel(SCHEMA_PATH)} enum contains unknown action '${s}'`);
  }
  if (enumList.length !== allowed.length) {
    issues.push(`[auditSchema] FAIL: ${rel(SCHEMA_PATH)} enum length ${enumList.length} != allowed ${allowed.length}`);
  }
  return issues;
}

function checkExamples() {
  if (!fs.existsSync(EXAMPLES_PATH)) return [];
  const lines = fs.readFileSync(EXAMPLES_PATH, "utf8").split("\n").filter(Boolean);
  const issues = [];
  lines.forEach((line, idx) => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (e) { issues.push(`[auditSchema] FAIL: ${rel(EXAMPLES_PATH)}:${idx + 1} is not valid JSON`); return; }
    const found = deepFindActionNames(parsed);
    for (const { name, where } of found) {
      if (!allowedSet.has(name)) {
        issues.push(`[auditSchema] FAIL: ${rel(EXAMPLES_PATH)}:${idx + 1} uses unknown action '${name}' at ${where}`);
      }
    }
  });
  return issues;
}

// Action names are short snake_case strings. We match them as whole words
// bounded by backticks, quotes, or whitespace, to avoid false positives like
// matching "morph" inside prose. The list is intentionally the authoritative
// allow-list plus some common false-positive candidates that we *exclude*.
function checkMarkdownFiles() {
  const issues = [];
  const wordBoundary = /(?<![A-Za-z0-9_])([a-z][a-z0-9_]*[a-z0-9])(?![A-Za-z0-9_])/g;
  for (const relPath of SCAN_MD_FILES) {
    const abs = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    // Split out code fences so we don't audit code samples (the bridge source
    // itself references action names that are valid).
    const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
    const seen = new Set();
    let m;
    while ((m = wordBoundary.exec(stripped)) !== null) {
      seen.add(m[1]);
    }
    for (const word of seen) {
      // Only flag if the word is in our authoritative list AND the doc text
      // contains a near-miss variant. This is the inverse check: catch the
      // case where someone wrote 'tag_waypoint' (not in allowed) in prose.
      // We simply flag any snake_case word in doc prose that LOOKS LIKE an
      // action name but isn't in the allow-list, IF it shares a prefix with
      // at least one allowed action.
      if (allowedSet.has(word)) continue;
      // Heuristic: looks action-shaped?
      if (!/_/.test(word)) continue;
      // Heuristic: shares prefix with an allowed action?
      const prefix = word.split("_").slice(0, 1)[0];
      const looksAction = allowed.some(a => a.startsWith(prefix + "_"));
      if (looksAction) {
        issues.push(`[auditSchema] FAIL: ${relPath} mentions '${word}' (not in allow-list)`);
      }
    }
  }
  return issues;
}

function main() {
  const issues = [
    ...checkSchemaEnum(),
    ...checkExamples(),
    ...checkMarkdownFiles(),
  ];
  if (issues.length === 0) {
    console.log(`[auditSchema] OK: SCHEMA.json enum and EXAMPLES.jsonl match A2A_ALLOWED_ACTIONS (${allowed.length} actions)`);
    return;
  }
  for (const i of issues) console.error(i);
  console.error(`[auditSchema] ${issues.length} issue(s)`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = { checkSchemaEnum, checkExamples, checkMarkdownFiles };