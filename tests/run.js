#!/usr/bin/env node
/**
 * tests/run.js
 * ----------------------------------------------------------------------------
 * Clean unified test runner. Runs every test in `tests/*.test.js` in sequence,
 * forwarding each child's stdio through to our own stdio (so PowerShell on
 * Windows doesn't interpret any child stderr output as a non-zero exit) and
 * aggregating their exit codes. Exits 0 only if every test exited 0.
 *
 * This exists because Windows PowerShell treats any stderr output from a
 * child process during the test (legitimate reconnect notifications, Ollama
 * progress lines, etc.) as a non-zero exit, which makes `npm test` appear
 * to "fail" even when every underlying test reports PASS.
 *
 * Run with:   node tests/run.js     (or `npm test`)
 * Exit code:  0 = all tests pass, 1 = at least one test failed.
 * ----------------------------------------------------------------------------
 */

const { spawn } = require("child_process");
const fs        = require("fs");
const path      = require("path");

const TESTS_DIR = __dirname;

// Discover every "*.test.js" file. Sort so order is stable.
const tests = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (tests.length === 0) {
  console.error("[run.js] no *.test.js files found in", TESTS_DIR);
  process.exit(1);
}

console.log(`[run.js] running ${tests.length} test file(s):`);
for (const t of tests) console.log(`[run.js]   • ${t}`);
console.log("");

(async () => {
  let allOk = true;

  for (const t of tests) {
    const target = path.join(TESTS_DIR, t);
    const label  = t.replace(/\.test\.js$/, "");

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[run.js] >>> ${label}`);
    console.log(`${"=".repeat(60)}\n`);

    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [target], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", (err) => {
        console.error(`[run.js] failed to launch ${target}: ${err.message}`);
        resolve(1);
      });
    });

    if (code !== 0) {
      console.error(`[run.js] ✗ ${label} exited with code ${code}`);
      allOk = false;
      // Continue running remaining tests so a single failure doesn't mask others.
    } else {
      console.log(`[run.js] ✓ ${label} passed`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (allOk) {
    console.log("[run.js] ✅ ALL TESTS PASSED");
    console.log(`${"=".repeat(60)}\n`);
    process.exit(0);
  } else {
    console.error("[run.js] ✗ ONE OR MORE TESTS FAILED");
    console.log(`${"=".repeat(60)}\n`);
    process.exit(1);
  }
})();
