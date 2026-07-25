/**
 * tests/circuitBreaker.test.js
 * ----------------------------------------------------------------------------
 * Unit tests for backend/circuitBreaker.js.
 * ----------------------------------------------------------------------------
 */

const { CircuitBreaker, CircuitOpenError, STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN } =
  require("../backend/circuitBreaker");

let pass = 0, fail = 0;
function ok(name)      { pass++; console.log(`  ok   ${name}`); }
function bad(name, e)  { fail++; console.error(`  FAIL ${name}: ${e?.message ?? e}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Track all in-flight test promises so we can wait for them before printing
// the summary. Without this the synchronous "tail" of the file would print
// `0 passed, 0 failed` before any async test has resolved.
const _inflight = [];

async function test(name, fn) {
  const p = (async () => {
    try { await fn(); ok(name); }
    catch (e) { bad(name, e); }
  })();
  _inflight.push(p);
  return p;
}

/**
 * Make a breaker with a clock we can advance from the test.
 */
function makeBreaker(opts = {}) {
  let now = 0;
  const b = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    successThreshold: 1,
    now: () => now,
    ...opts,
  });
  b._advance = (ms) => { now += ms; };
  return b;
}

console.log("CircuitBreaker tests");

// ---------------------------------------------------------------------------
// Closed → Open on consecutive failures
// ---------------------------------------------------------------------------
test("opens after N consecutive failures", async () => {
  const b = makeBreaker({ failureThreshold: 3 });
  const fails = async () => { throw new Error("nope"); };
  for (let i = 0; i < 3; i++) {
    try { await b.exec(fails); } catch {}
  }
  assert(b.isOpen, "should be open");
  assert(b.stats.totalOpens === 1, "totalOpens");
});

test("one success resets the failure counter", async () => {
  const b = makeBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 2; i++) {
    try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  }
  assert(b.isClosed, "still closed");
  await b.exec(async () => "ok");
  assert(b.isClosed, "still closed after success");
  // Now we need 3 *more* failures to trip.
  for (let i = 0; i < 2; i++) {
    try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  }
  assert(b.isClosed, "still closed (only 2 in a row)");
});

// ---------------------------------------------------------------------------
// Open → Half-open → Closed
// ---------------------------------------------------------------------------
test("open breaker rejects calls before cooldown", async () => {
  const b = makeBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  for (let i = 0; i < 2; i++) {
    try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  }
  try {
    await b.exec(async () => "ok");
    throw new Error("expected reject");
  } catch (err) {
    assert(err instanceof CircuitOpenError, "should throw CircuitOpenError");
    assert(err.retryInMs > 0, "should report retryInMs");
  }
  assert(b.stats.totalRejects === 1, "should have rejected");
});

test("open breaker tries a probe after cooldown", async () => {
  const b = makeBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  for (let i = 0; i < 2; i++) {
    try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  }
  assert(b.isOpen, "open");
  b._advance(1500);
  const result = await b.exec(async () => "probe-success");
  assert(result === "probe-success", "probe should succeed");
  assert(b.isClosed, "should close after probe success");
});

test("probe failure re-opens the breaker", async () => {
  const b = makeBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  for (let i = 0; i < 2; i++) {
    try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  }
  b._advance(1500);
  try { await b.exec(async () => { throw new Error("still broken"); }); } catch {}
  assert(b.isOpen, "should re-open");
  assert(b.stats.totalOpens === 2, "should have opened twice");
});

// ---------------------------------------------------------------------------
// Manual control
// ---------------------------------------------------------------------------
test("trip() immediately opens the breaker", async () => {
  const b = makeBreaker();
  b.trip();
  assert(b.isOpen, "should be open");
  try { await b.exec(async () => "ok"); throw new Error("expected reject"); }
  catch (err) { assert(err instanceof CircuitOpenError, "should reject"); }
});

test("reset() clears state and counters", async () => {
  const b = makeBreaker();
  for (let i = 0; i < 3; i++) {
    try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  }
  assert(b.isOpen, "open");
  assert(b.stats.totalOpens > 0, "has lifetime counter");
  b.reset();
  assert(b.isClosed, "reset");
  assert(b.stats.totalOpens === 0, "reset clears lifetime counters");
  assert(b.stats.consecutiveFailures === 0, "reset clears consecutive failures");
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
test("stats surface is stable", async () => {
  const b = makeBreaker();
  const s = b.stats;
  assert(s.state === STATE_CLOSED, "initial state");
  assert(s.consecutiveFailures === 0, "initial failures");
  assert(s.consecutiveSuccesses === 0, "initial successes");
  assert(s.totalOpens === 0, "initial opens");
  assert(s.totalRejects === 0, "initial rejects");
  assert(s.millisecondsUntilProbe === null, "no probe pending");
});

test("stats report msUntilProbe when open", async () => {
  const b = makeBreaker({ failureThreshold: 1, cooldownMs: 5000 });
  try { await b.exec(async () => { throw new Error("x"); }); } catch {}
  assert(b.stats.millisecondsUntilProbe !== null, "should report");
  assert(b.stats.millisecondsUntilProbe <= 5000, "should be within cooldown");
});

// ---------------------------------------------------------------------------
// Successes pass through transparently
// ---------------------------------------------------------------------------
test("successful exec returns the underlying value", async () => {
  const b = makeBreaker();
  const result = await b.exec(async () => 42);
  assert(result === 42, "should pass through");
});

test("successful exec with object payload", async () => {
  const b = makeBreaker();
  const obj = { hello: "world" };
  const result = await b.exec(async () => obj);
  assert(result === obj, "should pass through");
});

// ---------------------------------------------------------------------------
// execStream — for async-iterable (async-generator) operations.
//
// Background: the original exec() would consume the first iteration step on
// `await` and return the first chunk instead of the iterator. execStream()
// preserves the iterator and tracks success/failure across the FULL
// iteration. The narrator uses this to wrap backend.generate() which is an
// async generator.
// ---------------------------------------------------------------------------

/** Drain an async iterable to an array. */
async function drain(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

test("execStream yields every value from a successful async generator", async () => {
  const b = makeBreaker();
  async function* gen() { yield 1; yield 2; yield 3; }
  const out = await drain(b.execStream(gen));
  assert(JSON.stringify(out) === "[1,2,3]", "yields 1,2,3");
  assert(b.isClosed, "closed after success");
  assert(b.stats.consecutiveFailures === 0, "no failures");
});

test("execStream records failure when the generator throws mid-stream", async () => {
  const b = makeBreaker({ failureThreshold: 2 });
  async function* gen() {
    yield "a"; yield "b"; throw new Error("boom");
  }
  let caught = null;
  try { await drain(b.execStream(gen)); } catch (e) { caught = e; }
  assert(caught && caught.message === "boom", "propagates mid-stream error");
  assert(b.stats.consecutiveFailures === 1, "first failure recorded");
  assert(b.isClosed, "still closed (only 1 failure)");
});

test("execStream trips the breaker after N mid-stream failures", async () => {
  const b = makeBreaker({ failureThreshold: 2 });
  async function* gen() { throw new Error("always fails"); }
  for (let i = 0; i < 2; i++) {
    try { await drain(b.execStream(gen)); } catch {}
  }
  assert(b.isOpen, "open after 2 failures");
});

test("execStream records failure when fn() throws synchronously", async () => {
  const b = makeBreaker({ failureThreshold: 1 });
  const bad = () => { throw new Error("sync boom"); };
  let caught = null;
  try { await drain(b.execStream(bad)); } catch (e) { caught = e; }
  assert(caught && caught.message === "sync boom", "propagates sync error");
  assert(b.isOpen, "opens after single sync failure");
});

test("execStream rejects with CircuitOpenError when open", async () => {
  const b = makeBreaker({ failureThreshold: 1 });
  async function* fail() { throw new Error("x"); }
  try { await drain(b.execStream(fail)); } catch {}
  assert(b.isOpen, "open");
  let caught = null;
  try { await drain(b.execStream(fail)); } catch (e) { caught = e; }
  assert(caught instanceof CircuitOpenError, "should throw CircuitOpenError");
});

test("execStream aborts cleanly when caller signal fires mid-iteration", async () => {
  const b = makeBreaker();
  const ac = new AbortController();
  async function* gen() {
    yield 1;
    yield 2;
    yield 3;
    yield 4;
  }
  // Manually walk two values then abort.
  const out = [];
  let aborted = false;
  try {
    for await (const v of b.execStream(gen, { signal: ac.signal })) {
      out.push(v);
      if (out.length === 2) ac.abort();
    }
  } catch (e) { aborted = e?.name === "AbortError"; }
  // We didn't throw — abort is silent by design.
  assert(out.length === 2, "yielded exactly 2 before abort");
  assert(b.stats.consecutiveFailures === 0, "no failure recorded on abort");
  assert(b.stats.consecutiveSuccesses === 0, "no success recorded on abort (caller-driven)");
});

test("execStream throws TypeError if fn does not return an iterable", async () => {
  const b = makeBreaker();
  let caught = null;
  try { await drain(b.execStream(() => 42)); } catch (e) { caught = e; }
  assert(caught instanceof TypeError, "should throw TypeError");
  assert(b.stats.consecutiveFailures === 1, "sync error recorded as failure");
});

test("execStream does NOT consume the first iteration step on enter (the bug exec() had)", async () => {
  // Regression test: the original `exec(fn)` would `await fn()` and
  // accidentally consume one step of an async generator, returning the
  // first chunk instead of the iterable. execStream preserves the iterable.
  const b = makeBreaker();
  async function* gen() {
    yield "first-chunk-must-not-be-consumed";
    yield "second";
  }
  const iter = b.execStream(gen);
  const first = await iter.next();
  assert(first.value === "first-chunk-must-not-be-consumed", "first chunk preserved");
  const second = await iter.next();
  assert(second.value === "second", "second chunk delivered");
  const third = await iter.next();
  assert(third.done === true, "natural end reached");
});

test("execStream probe success closes the breaker (HALF_OPEN recovery)", async () => {
  const b = makeBreaker({ failureThreshold: 1, cooldownMs: 100 });
  async function* fail() { throw new Error("x"); }
  try { await drain(b.execStream(fail)); } catch {}
  assert(b.isOpen, "open");
  b._advance(150); // past cooldown
  async function* succeed() { yield "ok"; }
  const out = await drain(b.execStream(succeed));
  assert(out[0] === "ok", "probe yields");
  assert(b.isClosed, "closed after probe success");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
(async () => {
  await Promise.all(_inflight);
  console.log("---");
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
