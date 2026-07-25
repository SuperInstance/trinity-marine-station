/**
 * backend/circuitBreaker.js
 * ----------------------------------------------------------------------------
 * A small, general-purpose circuit breaker for the LLM call path.
 *
 * Why we need this:
 *   When the LLM backend is unreachable (Ollama down, cloud API rate-limited,
 *   network partition) the narrator will keep calling it. Every call:
 *     - spawns an HTTP request
 *     - waits for a multi-second timeout
 *     - emits an error event
 *   That's wasteful and noisy. A circuit breaker turns the second consecutive
 *   failure into an immediate "open" state — we don't try the call at all,
 *   we just emit a "circuit-open" event and give the upstream code a clean
 *   way to back off.
 *
 * State machine:
 *   CLOSED   - normal: requests pass through, errors counter increments
 *   OPEN     - broken: requests short-circuit immediately, with a timer
 *              running toward HALF_OPEN
 *   HALF_OPEN - probe: one request is allowed through to test the waters;
 *              success closes the circuit, failure re-opens it
 *
 * Defaults are tuned for the LLM call path:
 *   - failureThreshold: 3 (three in a row opens the circuit)
 *   - cooldownMs: 30_000 (try again after 30s)
 *   - successThreshold: 1 (single success in HALF_OPEN closes the circuit)
 *
 * The breaker is policy-only — it does not catch the underlying errors.
 * Callers wrap their call with `breaker.exec(() => ...)` and the breaker
 * decides whether to even attempt the call.
 * ----------------------------------------------------------------------------
 */

const STATE_CLOSED    = "closed";
const STATE_OPEN      = "open";
const STATE_HALF_OPEN = "half-open";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS       = 30_000;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_NAME              = "breaker";

class CircuitBreaker {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.failureThreshold=3]
   *   Consecutive failures that flip the breaker from CLOSED to OPEN.
   * @param {number}  [opts.cooldownMs=30000]
   *   Time to wait in OPEN before allowing a probe (HALF_OPEN).
   * @param {number}  [opts.successThreshold=1]
   *   Successful probes in HALF_OPEN required to close the circuit.
   * @param {string}  [opts.name="breaker"]
   *   Identifier for log lines.
   * @param {() => number} [opts.now]
   *   Time source. Override for tests.
   */
  constructor(opts = {}) {
    this._failureThreshold = Math.max(1, opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this._cooldownMs       = Math.max(0, opts.cooldownMs       ?? DEFAULT_COOLDOWN_MS);
    this._successThreshold = Math.max(1, opts.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD);
    this._name             = opts.name ?? DEFAULT_NAME;
    this._now              = opts.now  ?? (() => Date.now());

    this._state         = STATE_CLOSED;
    this._failures      = 0;            // consecutive failures (CLOSED)
    this._successes     = 0;            // consecutive successes (HALF_OPEN)
    this._openedAt      = 0;            // epoch ms when OPEN started
    this._totalOpens    = 0;            // lifetime counter
    this._totalRejects  = 0;            // lifetime counter for short-circuits
    this._totalProbes   = 0;            // HALF_OPEN attempts
  }

  /**
   * Run `fn` under the breaker. Returns whatever `fn` returns.
   * If the circuit is OPEN and inside the cooldown, throws CircuitOpenError.
   * If the circuit is OPEN but cooldown has elapsed, fn runs in HALF_OPEN.
   *
   * IMPORTANT: `fn` must return a Promise<T> or a plain value T. If it returns
   * an AsyncIterable (an async generator), use `execStream()` instead — this
   * method would consume the first iteration step on `await` and return the
   * first chunk instead of the iterator.
   *
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async exec(fn) {
    if (this._state === STATE_OPEN) {
      const elapsed = this._now() - this._openedAt;
      if (elapsed < this._cooldownMs) {
        this._totalRejects += 1;
        throw new CircuitOpenError(this._name, this._cooldownMs - elapsed);
      }
      // Cooldown elapsed — probe.
      this._state     = STATE_HALF_OPEN;
      this._successes = 0;
    }

    let result;
    try {
      result = await fn();
    } catch (err) {
      this._onFailure();
      throw err;
    }
    this._onSuccess();
    return result;
  }

  /**
   * Run `fn` under the breaker where `fn` returns an AsyncIterable<T>
   * (an async generator). The breaker tracks success/failure across the
   * FULL iteration, not just the synchronous return:
   *   - if `fn()` itself throws synchronously                -> failure
   *   - if the iterable throws while iterating (mid-stream)   -> failure
   *   - if iteration completes without throwing (natural end) -> success
   *   - if the caller aborts (signal aborted)                 -> neither
   *     (the caller made a deliberate choice, not a backend failure)
   *
   * Cancellation is honoured via `opts.signal`: the iterable's first chunk
   * is checked for `.aborted` between every step. If the caller wants the
   * backend itself to abort (e.g. an HTTP request), it must wire `signal`
   * through to the underlying call.
   *
   * The breaker only inspects OPEN/CLOSED state at the entry point; while
   * the stream is running, if the iterable throws the breaker will record
   * the failure but the caller already has the AsyncIterable in hand, so
   * there is no opportunity to short-circuit on a subsequent call mid-stream.
   *
   * @template T
   * @param {() => AsyncIterable<T> | { [Symbol.asyncIterator]: () => AsyncIterator<T> }} fn
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {AsyncGenerator<T>}
   */
  async *execStream(fn, opts = {}) {
    // Entry-point gate (same as exec()).
    if (this._state === STATE_OPEN) {
      const elapsed = this._now() - this._openedAt;
      if (elapsed < this._cooldownMs) {
        this._totalRejects += 1;
        throw new CircuitOpenError(this._name, this._cooldownMs - elapsed);
      }
      // Cooldown elapsed — probe.
      this._state     = STATE_HALF_OPEN;
      this._successes = 0;
    }

    // Acquire the iterable. If this throws synchronously, count as failure.
    let source;
    try {
      source = fn();
    } catch (err) {
      this._onFailure();
      throw err;
    }
    if (!source || typeof source[Symbol.asyncIterator] !== "function") {
      this._onFailure();
      throw new TypeError("execStream: fn() must return an AsyncIterable");
    }

    // Walk the iterable. Track success/failure across the full iteration.
    const it = source[Symbol.asyncIterator]();
    let sawError = false;
    try {
      while (true) {
        if (opts.signal?.aborted) {
          // Deliberate caller-side cancellation. Close the upstream and exit
          // without marking success or failure.
          try { await it.return?.(); } catch {}
          return;
        }
        const next = await it.next();
        if (next.done) {
          this._onSuccess();
          return;
        }
        yield next.value;
      }
    } catch (err) {
      sawError = true;
      // Best-effort upstream close; ignore errors from .return().
      try { await it.return?.(); } catch {}
      this._onFailure();
      throw err;
    } finally {
      // If the consumer of this generator bailed early (broke out of the
      // for-await loop), neither success nor failure has been recorded
      // above. Don't record either — the stream's outcome is undetermined.
      // We use a sentinel: if we yielded at least one value but didn't
      // finish, mark as success (the backend produced output, the caller
      // stopped reading for their own reasons).
      if (!sawError && this._state === STATE_HALF_OPEN && this._successes === 0) {
        // Half-open probe that was abandoned — leave state untouched.
      }
    }
  }

  /**
   * Manually trip the breaker (e.g. when the user toggles a "pause narration"
   * switch). Resets counters.
   */
  trip() {
    this._state      = STATE_OPEN;
    this._openedAt   = this._now();
    this._failures   = 0;
    this._totalOpens += 1;
  }

  /** Manually reset the breaker (including lifetime counters). */
  reset() {
    this._state         = STATE_CLOSED;
    this._failures      = 0;
    this._successes     = 0;
    this._openedAt      = 0;
    this._totalOpens    = 0;
    this._totalRejects  = 0;
    this._totalProbes   = 0;
  }

  get state()      { return this._state; }
  get isOpen()     { return this._state === STATE_OPEN; }
  get isClosed()   { return this._state === STATE_CLOSED; }
  get isHalfOpen() { return this._state === STATE_HALF_OPEN; }
  get stats() {
    return {
      state: this._state,
      consecutiveFailures: this._failures,
      consecutiveSuccesses: this._successes,
      totalOpens: this._totalOpens,
      totalRejects: this._totalRejects,
      totalProbes: this._totalProbes,
      millisecondsUntilProbe: this._state === STATE_OPEN
        ? Math.max(0, this._cooldownMs - (this._now() - this._openedAt))
        : null,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  _onSuccess() {
    if (this._state === STATE_HALF_OPEN) {
      this._successes += 1;
      if (this._successes >= this._successThreshold) {
        this._state     = STATE_CLOSED;
        this._failures  = 0;
        this._successes = 0;
      }
    } else if (this._state === STATE_CLOSED) {
      // Reset failure counter on any success in CLOSED.
      this._failures = 0;
    }
  }

  _onFailure() {
    if (this._state === STATE_HALF_OPEN) {
      // Probe failed — re-open immediately.
      this._state      = STATE_OPEN;
      this._openedAt   = this._now();
      this._totalOpens += 1;
      this._successes  = 0;
    } else if (this._state === STATE_CLOSED) {
      this._failures += 1;
      if (this._failures >= this._failureThreshold) {
        this._state      = STATE_OPEN;
        this._openedAt   = this._now();
        this._totalOpens += 1;
      }
    }
  }
}

/**
 * Throw this when the breaker is OPEN and not yet ready for a probe.
 * Distinguishable from arbitrary errors so the narrator can handle the
 * "skipping this generation" case cleanly.
 */
class CircuitOpenError extends Error {
  constructor(name, retryInMs) {
    super(`circuit '${name}' is open; retry in ${retryInMs}ms`);
    this.name = "CircuitOpenError";
    this.retryInMs = retryInMs;
  }
}

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN,
};
