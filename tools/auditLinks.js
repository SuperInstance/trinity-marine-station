#!/usr/bin/env node
// Cross-doc link auditor.
// Walks every .md, .json, .jsonl file in the repo, extracts every relative
// file reference, and reports any that don't resolve to an existing file.
// Also verifies that every repo-relative path mentioned in STATUS.json
// (under cross_references) resolves.
//
// Usage: node tools/auditLinks.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Files we audit (skip node_modules, .git, logs).
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.name === "logs" && dir === ROOT) continue;
    if (entry.name === ".research") continue;  // upstream research notes, not part of this repo's docs
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(md|json|jsonl|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Extract every relative path mentioned in a string.
// Markdown: [text](path), ![alt](path), and bare backticked `path`.
// JSON: any string that looks like a relative path (starts with ./ or ../ or matches a file in the repo).
function extractLinks(filePath, content) {
  const links = new Set();
  const rel = (p) => path.relative(ROOT, path.resolve(path.dirname(filePath), p));

  // Markdown links [text](path) - these are real links
  const mdLinks = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  // Markdown images ![alt](path)
  const mdImages = [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);

  for (const raw of [...mdLinks, ...mdImages]) {
    const clean = raw.trim().split("#")[0].split("?")[0];
    if (!clean) continue;
    if (/^(https?|mailto|ftp|ws|wss):/i.test(clean)) continue;
    if (clean.startsWith("#")) continue;
    try {
      links.add(rel(clean));
    } catch (_) {}
  }

  // Backticked paths - only treat as file ref if it looks like a path:
//   - starts with `./` or `../`, OR
//   - starts with a known directory prefix (backend/, shared/, tests/, tools/, docs/)
//   - has a file extension
//   - contains no illegal path characters or whitespace
// This is a heuristic; reviewers should `npm run audit:links` after edits.
const mdBackticks = [...content.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
for (const raw of mdBackticks) {
  if (raw.includes(" ")) continue;
  if (/[(){}[\]<>=;,:*?"|\\]/.test(raw)) continue;
  if (!/^(.{0,3}\/|backend\/|shared\/|tests\/|tools\/|docs\/)/.test(raw) &&
      !/^\.\.?\/[^/]+\.[a-z]{1,5}$/i.test(raw)) {
    continue;
  }
  if (!/\.[a-z0-9]{1,5}$/i.test(raw)) continue;
  const abs =
    raw.startsWith("./") || raw.startsWith("../")
      ? path.resolve(path.dirname(filePath), raw)
      : path.resolve(ROOT, raw);
  try {
    links.add(path.relative(ROOT, abs));
  } catch (_) {}
}
  return [...links];
}

function main() {
  const files = walk(ROOT);
  const broken = [];
  const checked = [];

  for (const file of files) {
    let content = fs.readFileSync(file, "utf8");

    // For .js files, strip line and block comments AND regex literals so we
    // don't audit code like require("path"), console.log("x"), or /`([^`]+)`/g.
    if (file.endsWith(".js")) {
      content = content
        .replace(/\/\*[\s\S]*?\*\//g, " ")   // /* ... */
        .replace(/^\s*\/\/.*$/gm, " ")        // // ...
        .replace(/^#.*$/gm, " ");             // # ...
      // Strip string literals (single, double, template) and regex literals.
      // Heuristic: a `/` followed by non-greedy chars until the next `/`.
      content = content
        .replace(/'([^'\\\n]|\\.)*'/g, " ")
        .replace(/"([^"\\\n]|\\.)*"/g, " ")
        .replace(/`([^`\\]|\\.)*`/g, " ")
        .replace(/\/[^\/\n]+\/[gimsuy]*/g, " ");
    }

    const links = extractLinks(file, content);
    for (const link of links) {
      const abs = path.resolve(ROOT, link);
      const exists = fs.existsSync(abs);
      checked.push({ from: path.relative(ROOT, file), to: link, exists });
      if (!exists) broken.push({ from: path.relative(ROOT, file), to: link });
    }
  }

  // Special: STATUS.json cross_references section
  const statusPath = path.join(ROOT, "docs", "STATUS.json");
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const refs = status.cross_references || {};
    for (const [key, target] of Object.entries(refs)) {
      const abs = path.resolve(ROOT, target);
      const exists = fs.existsSync(abs);
      checked.push({ from: "docs/STATUS.json#cross_references." + key, to: target, exists });
      if (!exists) broken.push({ from: "docs/STATUS.json#cross_references." + key, to: target });
    }
  }

  console.log(`Checked ${checked.length} cross-references in ${files.length} files.`);
  if (broken.length === 0) {
    console.log("All cross-references resolve. ✓");
    process.exit(0);
  } else {
    console.log(`\nBroken cross-references (${broken.length}):`);
    for (const b of broken) {
      console.log(`  ${b.from} -> ${b.to}  (NOT FOUND)`);
    }
    process.exit(1);
  }
}

main();