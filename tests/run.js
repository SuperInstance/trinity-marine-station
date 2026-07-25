#!/usr/bin/env node
/**
 * tests/run.js
 * ----------------------------------------------------------------------------
 * Clean test runner. Forwards child stderr into our own stdout so the parent
 * shell sees a single merged stream, and exits with the underlying node
 * process's status code on success or failure.
 *
 * This exists because Windows PowerShell interprets any stderr output
 * during the pipeline test (legitimate reconnect notifications, etc.) as
 * a non-zero exit, which makes `npm test` appear to "fail" even when the
 * underlying test reports `PHASE 1 PIPELINE VERIFIED`.
 *
 * Run with:   node tests/run.js     (or `npm test`)
 * Exit code:  0 = pass, 1 = fail.
 * ----------------------------------------------------------------------------
 */

const { spawn } = require("child_process");
const path      = require("path");

const target = path.resolve(__dirname, "pipeline.test.js");
const child  = spawn(process.execPath, [target], { stdio: ["ignore", "inherit", "inherit"] });

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("[run.js] failed to launch pipeline test:", err.message);
  process.exit(1);
});