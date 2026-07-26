#!/usr/bin/env node
// Module resolution auditor.
// Resolves every require() / import in backend/ and tests/ to confirm the
// target file exists. Catches typos, missing files, and stale paths.
//
// Usage: node tools/auditRequires.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(ROOT, "backend")), ...walk(path.join(ROOT, "tests"))];

const errors = [];
const ok = [];
const internalDirs = ["backend", "shared", "tests"];

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  // Strip comments to avoid matching strings inside them.
  const cleaned = content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  // CommonJS require
  const requires = [...cleaned.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  // ESM static import
  const imports = [...cleaned.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

  for (const target of [...requires, ...imports]) {
    if (!target) continue;
    // Bare specifier -> node_modules
    if (!target.startsWith(".") && !target.startsWith("/")) {
      try {
        require.resolve(target, { paths: [ROOT] });
        ok.push(`${path.relative(ROOT, file)} -> ${target} (bare)`);
      } catch (e) {
        errors.push(`${path.relative(ROOT, file)} -> ${target}  (UNRESOLVED: ${e.code})`);
      }
      continue;
    }
    // Relative path -> check file exists with .js extension fallback
    const fromDir = path.dirname(file);
    let resolved = path.resolve(fromDir, target);
    if (fs.existsSync(resolved)) { ok.push(`${path.relative(ROOT, file)} -> ${target}`); continue; }
    if (fs.existsSync(resolved + ".js")) { ok.push(`${path.relative(ROOT, file)} -> ${target}.js`); continue; }
    if (fs.existsSync(resolved + "/index.js")) { ok.push(`${path.relative(ROOT, file)} -> ${target}/index.js`); continue; }
    errors.push(`${path.relative(ROOT, file)} -> ${target}  (NOT FOUND)`);
  }
}

console.log(`Checked ${ok.length} requires, ${errors.length} errors.`);
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(`  \u2717 ${e}`);
  process.exit(1);
} else {
  console.log("All requires resolve. \u2713");
}