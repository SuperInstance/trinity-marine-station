/**
 * backend/a2aClient.js
 * ----------------------------------------------------------------------------
 * The A2A Client — a typed subscription wrapper for the A2aBridge.
 *
 * While the `A2aBridge` is the server-side component (in
 * `backend/a2aBridge.js`) that fans out `A2AAction` objects from the
 * cognitive engine to subscribed frontends, this module is the *consumer*
 * side. It speaks the bridge's WebSocket protocol so an external process
 * (Eclipse Theia extension, browser dashboard, headless test harness) can:
 *
 *   1. Connect → wait for the `hello` handshake.
 *   2. Optionally replay the gap of missed actions since its last ack.
 *   3. Receive a live feed of `action` envelopes with monotonic ids.
 *   4. Persist its progress by sending `ack` messages.
 *   5. Survive server restarts via exponential-backoff reconnect that
 *      automatically re-runs the replay-on-reconnect dance.
 *
 * Design choices:
 *   - Zero deps: uses the project's existing `ws` dependency.
 *   - EventEmitter interface: emits `hello`, `action`, `replay_end`,
 *     `error`, `close`, `reconnect-scheduled`, `reconnect`. Consumers
 *     don't need to know anything about WebSocket frames.
 *   - Idempotency: every emitted `action` envelope carries a monotonic
 *     `id`. Consumers should `client.ack(env.id)` once they've durably
 *     applied it. The client tracks `lastAckedId` so the application can
 *     persist it for restart-time replay.
 *   - Auto-reconnect: enabled by default with exponential backoff
 *     (capped). Each reconnect re-runs the replay-from-last-ack dance
 *     so no action is lost AND no action is double-applied.
 *   - Strict mode: by default, the client validates every incoming
 *     message via `parseA2AClientMessage`. Malformed server traffic
 *     becomes an `error` event, never a thrown exception.
 *
 * Usage:
 *   const { A2aClient } = require("./a2aClient");
 *   const c = new A2aClient({ url: "ws://127.0.0.1:3002", lastAckedId: 0 });
 *   c.on("hello",     (hello)  => { /* ready *\/ });
 *   c.on("action",    (env)    => { apply(env.action); c.ack(env.id); });
 *   c.on("replay_end",(info)   => { /* gap filled *\/ });
 *   c.on("error",     (err)    => { console.error(err); });
 *   await c.connect();
 * ----------------------------------------------------------------------------
 */

"use strict";

const { EventEmitter } = require("events");
const WebSocket = require("ws");

// Tunables. Exported for tests.
const DEFAULTS = Object.freeze({
  url: "ws://127.0.0.1:3002",
  // Initial reconnect delay. Doubles each failure, capped at maxReconnectMs.
  reconnectInitialMs: 250,
  maxReconnectMs: 30 * 1000,
  // Hard ceiling on consecutive reconnect failures before we give up.
  maxReconnectAttempts: Infinity,
  // How long to wait for the hello handshake after a (re)connect.
  helloTimeoutMs: 5 * 1000,
  // If true, validate every incoming server frame. Tests may disable this
  // to inject malformed traffic on purpose.
  strict: true,
});

/**
 * @typedef {object} HelloEnvelope
 * @property {"hello"}      type
 * @property {string}       server
 * @property {number}       version
 * @property {number}       last_action_id
 * @property {string}       ts
 *
 * @typedef {object} ActionEnvelope
 * @property {"action"}     type
 * @property {number}       id
 * @property {object}       action    // a validated A2AAction
 * @property {string}       ts
 *
 * @typedef {object} ReplayEndEnvelope
 * @property {"replay_end"} type
 * @property {number}       replayed
 * @property {string}       [ts]
 * @property {string}       [reason]  // "no_log" when bridge has no log
 *
 * @typedef {object} ErrorEnvelope
 * @property {"error"}      type
 * @property {string}       code
 * @property {string[]}     errors
 *
 * @typedef {object} AckOkEnvelope
 * @property {"ack_ok"}     type
 * @property {number}       action_id
 *
 * @typedef {object} PongEnvelope
 * @property {"pong"}       type
 * @property {string}       ts
 */

/**
 * A2aClient — typed subscription wrapper for the A2aBridge protocol.
 *
 * Events:
 *   "hello"           (env: HelloEnvelope)        — handshake received on (re)connect
 *   "action"          (env: ActionEnvelope)       — a live or replayed action arrived
 *   "replay_end"      (env: ReplayEndEnvelope)    — gap-fill completed
 *   "ack_ok"          (env: AckOkEnvelope)        — ack acknowledged by server
 *   "pong"            (env: PongEnvelope)          — pong received
 *   "error"           (Error | {code, errors})    — protocol / socket error
 *   "close"           ({code, reason})            — socket closed
 *   "open"            ()                          — socket opened (pre-hello)
 *   "reconnect-scheduled" ({attempt, delayMs})     — about to attempt reconnect
 *   "reconnect"       ()                          — reconnect succeeded (post-hello)
 *
 * Public fields:
 *   url                  string   the configured WebSocket URL
 *   hello                HelloEnvelope | null   last hello received
 *   lastAckedId          number   monotonic ack progress (mutate via ack())
 *   state                "idle" | "connecting" | "open" | "closed"
 */
class A2aClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.url="ws://127.0.0.1:3002"]
   * @param {number}  [opts.lastAckedId=0]        start with a persisted ack cursor
   * @param {boolean} [opts.autoReconnect=true]
   * @param {number}  [opts.reconnectInitialMs=250]
   * @param {number}  [opts.maxReconnectMs=30000]
   * @param {number}  [opts.maxReconnectAttempts=Infinity]
   * @param {number}  [opts.helloTimeoutMs=5000]
   * @param {boolean} [opts.strict=true]          validate every server frame
   */
  constructor(opts = {}) {
    super();
    this._opts = { ...DEFAULTS, ...opts };

    /** @type {string} */
    this.url = this._opts.url;
    /** @type {HelloEnvelope | null} */
    this.hello = null;
    /** @type {number} */
    this.lastAckedId = Number.isInteger(this._opts.lastAckedId) && this._opts.lastAckedId >= 0
      ? this._opts.lastAckedId
      : 0;

    /** @type {"idle" | "connecting" | "open" | "closed"} */
    this.state = "idle";

    this._ws = null;
    this._helloTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._destroyed = false;
    this._inReplay = false;

    this._stats = {
      actionsReceived: 0,
      replaysDrained: 0,
      acksSent: 0,
      reconnects: 0,
      errors: 0,
    };
  }

  /**
   * Snapshot of stats for observability / tests.
   */
  stats() {
    return { ...this._stats };
  }

  /**
   * Open the WebSocket. Resolves AFTER the `hello` handshake arrives
   * (so callers can rely on `this.hello` being populated). Subsequent
   * `action`/`replay_end`/`ack_ok` events are delivered asynchronously
   * via the EventEmitter interface.
   *
   * @returns {Promise<HelloEnvelope>}
   */
  connect() {
    if (this._destroyed) {
      return Promise.reject(new Error("A2aClient: connect after destroy()"));
    }
    if (this._ws && this.state !== "closed") {
      return Promise.reject(new Error("A2aClient: already connecting/open"));
    }
    this.state = "connecting";

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this._opts.url);
      this._ws = ws;

      const onHello = (env) => {
        if (settled) return;
        settled = true;
        clearTimeout(this._helloTimer);
        this._helloTimer = null;
        this.state = "open";
        if (this._reconnectAttempt > 0) {
          this._stats.reconnects++;
          this.emit("reconnect");
        }
        // Drain the gap automatically if the caller has progress.
        if (this.lastAckedId > 0) {
          this._send({ type: "replay", since_id: this.lastAckedId });
          this._inReplay = true;
        }
        resolve(env);
      };

      ws.once("open", () => {
        this.emit("open");
        this._helloTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this._stats.errors++;
            const err = new Error(`A2aClient: hello timeout after ${this._opts.helloTimeoutMs}ms`);
            this.emit("error", err);
            try { ws.close(4008, "hello_timeout"); } catch (_) { /* ignore */ }
            reject(err);
          }
        }, this._opts.helloTimeoutMs);
        if (this._helloTimer.unref) this._helloTimer.unref();
      });

      ws.on("message", (raw) => {
        this.handleServerMessage(raw, onHello).catch((err) => {
          this._stats.errors++;
          this.emit("error", err);
        });
      });

      ws.on("close", (code, reason) => {
        this.state = "closed";
        this.emit("close", { code, reason: reason ? reason.toString() : "" });
        this._ws = null;
        if (!settled) {
          settled = true;
          clearTimeout(this._helloTimer);
          this._helloTimer = null;
          reject(new Error(`A2aClient: socket closed before hello (code=${code})`));
        }
        // If destroy() was called between connect() and the close event,
        // do not schedule another reconnect.
        if (!this._destroyed && this._opts.autoReconnect !== false) {
          this._scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this._stats.errors++;
        // Before hello: the close handler will reject connect() or
        // schedule reconnect — don't double-emit 'error' (a stray emit
        // here is what crashes a process with no listener installed).
        // After hello: surface it so consumers can react.
        if (settled) this.emit("error", err);
        // The 'close' handler will fire next; reconnect is handled there.
      });
    });
  }

  /**
   * Mark an action as durably applied. Updates `lastAckedId` (monotonic
   * max). The bridge persists the ack so a restart won't replay actions
   * the client has already acknowledged.
   *
   * @param {number} actionId  the `id` from the `action` envelope
   */
  ack(actionId) {
    if (!Number.isInteger(actionId) || actionId < 0) {
      throw new Error(`A2aClient.ack: action_id must be a non-negative integer, got ${actionId}`);
    }
    if (actionId < this.lastAckedId) {
      // Ack is allowed to be older than what we have — just keep the max.
      // We still send it because the bridge may not have seen it before.
    } else {
      this.lastAckedId = actionId;
    }
    this._send({ type: "ack", action_id: actionId });
    this._stats.acksSent++;
  }

  /**
   * Send a ping. The bridge will respond with a `pong` envelope, which
   * the client emits as a `pong` event.
   */
  ping() {
    this._send({ type: "ping" });
  }

  /**
   * Manually request a replay of all actions with id > sinceId. Useful
   * for backfills initiated by the application layer, not just reconnect.
   *
   * @param {number} [sinceId=0]
   */
  requestReplay(sinceId = 0) {
    if (!Number.isInteger(sinceId) || sinceId < 0) {
      throw new Error(`A2aClient.requestReplay: since_id must be a non-negative integer, got ${sinceId}`);
    }
    this._send({ type: "replay", since_id: sinceId });
    this._inReplay = true;
  }

  /**
   * Close the client permanently. Cancels any pending reconnect.
   *
   * @returns {Promise<void>}
   */
  destroy() {
    if (this._destroyed) return Promise.resolve();
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
    if (!this._ws) return Promise.resolve();
    const ws = this._ws;
    return new Promise((resolve) => {
      if (ws.readyState === ws.CLOSED) { resolve(); return; }
      ws.once("close", () => resolve());
      try { ws.close(1000, "client_shutdown"); } catch (_) { resolve(); }
    });
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  _send(obj) {
    const ws = this._ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this._stats.errors++;
      this.emit("error", err);
      return false;
    }
  }

  /**
   * Parse and dispatch a single server frame. Public for testability — the
   * harness uses this to verify parse-path behaviour without standing up a
   * full WebSocket. The first call also resolves the hello handshake via
   * the supplied callback (internal callers pass `onHello`; external test
   * callers may omit it and dispatch a non-hello frame).
   *
   * @param {string|Buffer} raw
   * @param {(env: HelloEnvelope) => void} [onHello]
   */
  async handleServerMessage(raw, onHello = () => {}) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch (err) {
      if (this._opts.strict) {
        throw new Error(`A2aClient: server frame JSON parse failed: ${err.message}`);
      }
      return;
    }

    // Defensive: every frame must be an object with a string `type`.
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      throw new Error("A2aClient: server frame missing or malformed 'type'");
    }

    switch (msg.type) {
      case "hello": {
        if (!Number.isInteger(msg.last_action_id) || msg.last_action_id < 0) {
          throw new Error("A2aClient: hello.last_action_id must be a non-negative integer");
        }
        const env = {
          type: "hello",
          server: msg.server,
          version: msg.version,
          last_action_id: msg.last_action_id,
          ts: msg.ts,
        };
        this.hello = env;
        this.emit("hello", env);
        onHello(env);
        break;
      }

      case "action": {
        if (!Number.isInteger(msg.id) || msg.id <= 0) {
          throw new Error("A2aClient: action envelope missing or invalid id");
        }
        if (!msg.action || typeof msg.action !== "object") {
          throw new Error("A2aClient: action envelope missing 'action' object");
        }
        const env = {
          type: "action",
          id: msg.id,
          action: msg.action,
          ts: msg.ts,
        };
        this._stats.actionsReceived++;
        this.emit("action", env);
        break;
      }

      case "replay_end": {
        if (this._inReplay) this._inReplay = false;
        this._stats.replaysDrained++;
        const env = {
          type: "replay_end",
          replayed: Number.isInteger(msg.replayed) ? msg.replayed : 0,
          ts: msg.ts,
          reason: typeof msg.reason === "string" ? msg.reason : undefined,
        };
        this.emit("replay_end", env);
        break;
      }

      case "ack_ok": {
        if (!Number.isInteger(msg.action_id) || msg.action_id < 0) {
          throw new Error("A2aClient: ack_ok envelope missing or invalid action_id");
        }
        this.emit("ack_ok", { type: "ack_ok", action_id: msg.action_id });
        break;
      }

      case "pong": {
        this.emit("pong", { type: "pong", ts: msg.ts });
        break;
      }

      case "error": {
        this._stats.errors++;
        this.emit("error", {
          code: typeof msg.code === "string" ? msg.code : "unknown",
          errors: Array.isArray(msg.errors) ? msg.errors : [],
        });
        break;
      }

      default:
        if (this._opts.strict) {
          throw new Error(`A2aClient: unknown server frame type '${msg.type}'`);
        }
        // Non-strict mode: silently ignore unknown frames.
        break;
    }
  }

  /** @deprecated Kept as a private alias for backwards compatibility. */
  async _onServerMessage(raw, onHello) {
    return this.handleServerMessage(raw, onHello);
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    if (this._reconnectAttempt >= this._opts.maxReconnectAttempts) {
      this.emit("error", new Error(
        `A2aClient: gave up after ${this._reconnectAttempt} reconnect attempts`
      ));
      return;
    }
    this._reconnectAttempt++;
    const delay = Math.min(
      this._opts.reconnectInitialMs * Math.pow(2, this._reconnectAttempt - 1),
      this._opts.maxReconnectMs
    );
    this.emit("reconnect-scheduled", { attempt: this._reconnectAttempt, delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch((err) => {
        // If we were destroyed mid-reconnect, swallow the error —
        // destroy() is the user-facing "I don't care" signal.
        if (this._destroyed) return;
        this._stats.errors++;
        this.emit("error", err);
        // connect() schedules another reconnect via the close handler if
        // the socket dies before hello; nothing else to do here.
      });
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }
}

module.exports = {
  A2aClient,
  DEFAULTS,
};