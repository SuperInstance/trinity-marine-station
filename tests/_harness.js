/**
 * tests/_harness.js
 * ----------------------------------------------------------------------------
 * Tiny shared test harness used by every *.test.js file.
 *
 * Why a shared harness:
 *   - Each test file used to declare its own `pass`, `fail`, `ok`, `bad`,
 *     `assert`, and `test()` helpers. The implementations drifted:
 *       * some printed summaries synchronously, before async tests resolved,
 *       * some did not await async fn(), silently skipping failures,
 *       * some had inconsistent error formatting.
 *   - Centralising means a single fix here fixes every test file.
 *
 * Exports:
 *   - test(name, fn)        register an async test
 *   - assert(cond, msg)     throw if `cond` is falsy
 *   - ok(label)             record a passing sub-assertion
 *   - bad(label, err)       record a failing sub-assertion
 *   - section(name)         print a section header
 *   - sleep(ms)             await a delay
 *   - run(suiteName, fn)    run the top-level async `fn` and wait for all
 *                           registered tests, then print a summary and
 *                           set process.exitCode on failure
 *
 * Usage:
 *   const { test, assert, section, run, sleep } = require("./_harness");
 *
 *   run("ring buffer", async () => {
 *     test("writes do not exceed capacity", async () => {
 *       assert(true, "trivially true");
 *     });
 *   });
 *
 * Behaviour:
 *   - All test() calls schedule a promise. run() awaits all of them before
 *     printing the summary, so the summary always reflects the real count.
 *   - process.exitCode is set to 1 if any test failed.
 *   - The harness deliberately does NOT call process.exit() — that lets
 *     callers (e.g. tests/run.js) inspect exitCode and aggregate suites.
 * ----------------------------------------------------------------------------
 */

"use strict";

let _pass = 0;
let _fail = 0;
const _inflight = [];

function ok(label) {
  _pass += 1;
  console.log(`  PASS  ${label}`);
}

function bad(label, err) {
  _fail += 1;
  const msg = err && err.message ? err.message : String(err);
  console.error(`  FAIL  ${label}: ${msg}`);
  if (err && err.stack && process.env.TEST_DEBUG) console.error(err.stack);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

/**
 * Assert that `fn` throws. Optionally match the thrown error message against
 * `msgPattern` (RegExp or string substring).
 *
 * @param {() => any} fn
 * @param {RegExp|string} [msgPattern]
 * @returns {Error} the thrown error, for further inspection
 */
function assertThrows(fn, msgPattern) {
  let thrown = null;
  try { fn(); }
  catch (e) { thrown = e; }
  if (thrown === null) {
    throw new Error("assertThrows: expected fn() to throw, but it did not");
  }
  if (msgPattern !== undefined) {
    const msg = thrown && thrown.message ? thrown.message : String(thrown);
    const matches = msgPattern instanceof RegExp
      ? msgPattern.test(msg)
      : msg.includes(String(msgPattern));
    if (!matches) {
      throw new Error(
        `assertThrows: error message ${JSON.stringify(msg)} did not match ${msgPattern}`
      );
    }
  }
  return thrown;
}

/**
 * Assert that `fn` does NOT throw. Returns whatever fn returns.
 */
function assertDoesNotThrow(fn, label) {
  try { return fn(); }
  catch (e) {
    throw new Error(`assertDoesNotThrow${label ? " (" + label + ")" : ""}: unexpected throw: ${e.message}`);
  }
}

/**
 * Assert two values are strictly equal (===). Throws with both sides' stringified
 * forms on failure. BigInts are stringified with the trailing 'n' preserved.
 */
function assertEq(actual, expected, label) {
  // BigInt equality — === is already correct but JSON.stringify throws on BigInt.
  if (typeof actual === "bigint" || typeof expected === "bigint") {
    if (actual !== expected) {
      throw new Error(
        `assertEq${label ? " (" + label + ")" : ""}: expected ${String(expected)}n, got ${String(actual)}n`
      );
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `assertEq${label ? " (" + label + ")" : ""}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

/**
 * Assert `actual` is within `tolerance` of `expected`.
 */
function assertNear(actual, expected, tolerance, label) {
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    throw new Error(`assertNear${label ? " (" + label + ")" : ""}: actual is not a finite number (${actual})`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `assertNear${label ? " (" + label + ")" : ""}: expected ${expected}±${tolerance}, got ${actual}`
    );
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

function test(name, fn) {
  const p = (async () => {
    try {
      await fn();
      ok(name);
    } catch (err) {
      bad(name, err);
    }
  })();
  _inflight.push(p);
  return p;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Run a top-level async suite. Awaits every test() registered before it,
 * prints a summary, and sets process.exitCode on failure.
 *
 * @param {string}   suiteName  Display name for the summary.
 * @param {() => Promise<void> | void} body
 *   Body of the suite. Call test() inside to register cases.
 */
async function run(suiteName, body) {
  const before = { pass: _pass, fail: _fail };
  try {
    await body();
  } catch (err) {
    console.error(`FATAL in ${suiteName}:`, err && err.stack ? err.stack : err);
    _fail += 1;
  }
  await Promise.all(_inflight);
  const suitePass = _pass - before.pass;
  const suiteFail = _fail - before.fail;
  console.log(`\n========================================`);
  console.log(`  ${suiteName}: ${suitePass} pass / ${suiteFail} fail`);
  console.log(`========================================`);
  if (_fail > before.fail) process.exitCode = 1;
}

module.exports = {
  test,
  assert,
  assertThrows,
  assertDoesNotThrow,
  assertEq,
  assertNear,
  ok,
  bad,
  section,
  sleep,
  run,
  /** Test-only getters for harness introspection. */
  _getCounts: () => ({ pass: _pass, fail: _fail, inflight: _inflight.length }),
};