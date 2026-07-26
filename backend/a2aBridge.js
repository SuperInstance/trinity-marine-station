/**
 * backend/a2aBridge.js
 * ----------------------------------------------------------------------------
 * The A2A Bridge — a transport closer to the cognitive engine.
 *
 * The Trinity daemon produces `A2AAction` objects (validated by
 * `backend/schemas.js`). They are emitted by `trinityCore` as Node events
 * and persisted by `a2aLog` for durable history. But the frontend (Eclipse
 * Theia panels, browser dashboards, etc.) lives in a different process and
 * needs:
 *
 *   1. A TRUSTED SOURCE OF TRUTH for which actions are currently in effect.
 *   2. AN EVENT STREAM of new actions as they happen.
 *   3. SAFE RECONNECTION — if a frontend disconnects and reconnects, it
 *      must not miss any action it has already acknowledged. It must not
 *      double-apply actions it has already applied.
 *
 * This module solves all three with a small, deterministic WebSocket
 * server that:
 *
 *   - On connect: sends a `{ type: "hello", server, ack_id, last_action_id }`
 *     handshake. The client compares `server.last_action_id` against its
 *     own `last_acked_action_id` and requests a replay of the gap.
 *   - On a `{ type: "replay", since_id }` request: streams all actions with
 *     `id > since_id` from the A2aLog, oldest-first, then resumes live feed.
 *   - On a `{ type: "ack", action_id }` request: records that the client
 *     has acknowledged the action up to that point (recorded back to the
 *     log as a synthetic `ack` record so the bridge can be crashed and
 *     restarted without losing client state).
 *   - On a `core 'a2a'` event: assigns a monotonic `id`, broadcasts to all
 *     live clients, and persists to the A2aLog for replay.
 *
 * Design notes:
 *   - The bridge is the *only* component that mutates `a2aLog` for replay
 *     data. It listens to `core.on('a2a', ...)` and writes the canonical
 *     record. This avoids race conditions between producers and the log.
 *   - Backpressure: if a client's send buffer grows beyond
 *     `MAX_CLIENT_BACKLOG`, we close it. Slow clients cannot lag the stream.
 *   - Frame format: text messages, JSON. We do not use binary frames here
 *     because the payload is small and human-readable for debugging.
 *   - Concurrency: actions are assigned IDs synchronously before broadcast,
 *     so an `{id: 42}` always identifies exactly one action. New clients
 *     replaying `since_id=42` will see exactly the actions created after 42.
 *
 * What this is NOT:
 *   - It is NOT a Theia-specific extension. That is a separate concern.
 *   - It is NOT a generic RPC server. It is a one-way (server → client)
 *     action stream with a small request channel for hello/replay/ack.
 *   - It does NOT pull from the LLM directly. It only forwards already-
 *     validated `A2AAction` objects from the core pipeline.
 * ----------------------------------------------------------------------------
 */

"use strict";

const { WebSocketServer } = require("ws");
const { parseA2AClientMessage, validateA2AAction } = require("./schemas");
const EVENTS = require("../shared/events").EVENTS;

// Tunables. Kept at module scope so tests can import & override.
const DEFAULT_PORT = 3002;
const MAX_CLIENT_BACKLOG = 1024; // bytes of unsent data
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * A2aBridge
 * --------
 * A WebSocket server that fans out A2AAction events to subscribed frontends
 * with replay support.
 *
 * Construction:
 *   const bridge = new A2aBridge({ port: 3002, core, a2aLog });
 *   bridge.start();
 *
 * The core must emit `'a2a'` events carrying validated A2AAction objects.
 * The a2aLog is optional — if absent, the bridge will still work but will
 * not persist or replay any actions.
 */
class A2aBridge {
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_PORT;
    this.core = opts.core; // required: must emit 'a2a' events
    this.a2aLog = opts.a2aLog || null; // optional: for persistence + replay
    this.verbose = Boolean(opts.verbose);

    // Monotonic action ID. Starts at 0; every broadcast increments.
    // Persisted to log on each action so restarts can resume.
    this._nextId = 1;

    // Live client set. Each entry is `{ ws, lastAckedId }`.
    this._clients = new Set();

    // Server and core listener handles.
    this._wss = null;
    this._onCoreA2a = null;
    this._heartbeatTimer = null;

    // Stats for observability.
    this._stats = {
      actionsBroadcast: 0,
      replaysServed: 0,
      acksRecorded: 0,
      clientsConnected: 0,
      clientsDisconnected: 0,
      malformedFromClient: 0,
    };

    if (!this.core) {
      throw new Error("A2aBridge: opts.core is required and must emit 'a2a' events");
    }
  }

  /**
   * Start listening on the configured port. Idempotent.
   * Resolves once the WebSocket server is actually accepting connections.
   */
  start() {
    if (this._wss) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

      const onError = (err) => {
        wss.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = async () => {
        wss.removeListener("error", onError);
        this._wss = wss;
        // Resume monotonic IDs from the log so newly-issued IDs don't
        // collide with replayed ones.
        if (this.a2aLog) {
          try {
            const max = await this.a2aLog.maxId();
            if (max >= this._nextId) this._nextId = max + 1;
          } catch (err) {
            if (this.verbose) {
              console.warn(`[a2aBridge] maxId() failed: ${err.message}`);
            }
          }
        }
        this._wireCore();
        this._wireHeartbeat();
        if (this.verbose) {
          process.stdout.write(`[a2aBridge] listening on ws://127.0.0.1:${this.port} (nextId=${this._nextId})\n`);
        }
        resolve();
      };

      wss.once("listening", onListening);
      wss.once("error", onError);

      wss.on("connection", (ws) => this._onConnection(ws));
    });
  }

  /**
   * Stop the bridge. Closes all clients, stops the server, detaches from
   * the core. Resolves once everything is closed.
   */
  stop() {
    if (!this._wss) return Promise.resolve();

    // Detach from core first so no new actions come in during shutdown.
    if (this._onCoreA2a) {
      this.core.off("a2a", this._onCoreA2a);
      this._onCoreA2a = null;
    }

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // Close all clients cleanly.
    for (const c of this._clients) {
      try {
        c.ws.close(1001, "bridge_shutdown");
      } catch (_) {
        // ignore
      }
    }
    this._clients.clear();

    return new Promise((resolve) => {
      this._wss.close(() => {
        this._wss = null;
        if (this.verbose) process.stdout.write("[a2aBridge] stopped\n");
        resolve();
      });
    });
  }

  /**
   * Number of currently connected clients.
   */
  clientCount() {
    return this._clients.size;
  }

  /**
   * Get a snapshot of stats for the daemon's /status endpoint.
   */
  stats() {
    return {
      ...this._stats,
      nextId: this._nextId,
      connectedClients: this._clients.size,
      port: this.port,
    };
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  /**
   * Wire the bridge to core 'a2a' events. Each event becomes a broadcast
   * with a monotonically assigned ID.
   */
  _wireCore() {
    this._onCoreA2a = (action) => {
      // Validate again at the bridge boundary in case the core somehow
      // emitted a malformed payload. The cost is negligible (~µs).
      const v = validateA2AAction(action);
      if (!v.ok) {
        if (this.verbose) {
          console.error(`[a2aBridge] core 'a2a' payload failed validation: ${v.errors.join("; ")}`);
        }
        return;
      }
      this._broadcastAction(v.value);
    };
    this.core.on("a2a", this._onCoreA2a);
  }

  /**
   * Periodic heartbeat — sends a tiny ping to all clients to keep
   * middleboxes and NAT mappings alive. Closes unresponsive clients.
   */
  _wireHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      for (const c of this._clients) {
        if (c.ws.readyState !== c.ws.OPEN) {
          this._clients.delete(c);
          continue;
        }
        // readyState==1 is OPEN. We ping; if the underlying socket has
        // queued bytes already, terminate early.
        if (c.ws.bufferedAmount > MAX_CLIENT_BACKLOG) {
          if (this.verbose) {
            console.warn(`[a2aBridge] client lagging (bufferedAmount=${c.ws.bufferedAmount}); closing`);
          }
          try { c.ws.close(1009, "backpressure"); } catch (_) { /* ignore */ }
          this._clients.delete(c);
          this._stats.clientsDisconnected++;
          continue;
        }
        try { c.ws.ping(); } catch (_) { /* ignore */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Don't let the timer keep the process alive.
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  /**
   * Handle a new WebSocket connection. Sends the hello handshake first.
   */
  _onConnection(ws) {
    this._stats.clientsConnected++;
    const client = { ws, lastAckedId: 0 };
    this._clients.add(client);

    // Compute the highest action ID we've ever issued. We pull this from
    // the log if available (most recent persisted action), otherwise from
    // memory. Reconnect semantics: client compares this with its own
    // last_acked and requests any gap.
    const lastIssuedId = this._nextId - 1;

    const hello = {
      type: "hello",
      server: "trinity-a2a-bridge",
      version: 1,
      last_action_id: lastIssuedId,
      ts: new Date().toISOString(),
    };
    this._safeSend(ws, hello);

    ws.on("message", (raw) => {
      this._onClientMessage(client, raw).catch((err) => {
        if (this.verbose) console.error(`[a2aBridge] client message handler error: ${err.message}`);
      });
    });

    ws.on("close", () => {
      this._clients.delete(client);
      this._stats.clientsDisconnected++;
    });

    ws.on("error", (err) => {
      if (this.verbose) console.error(`[a2aBridge] client socket error: ${err.message}`);
    });
  }

  /**
   * Parse and dispatch a single client message.
   *
   * Validation result is classified into one of three error categories:
   *   - "malformed": JSON itself is unparseable or not an object
   *   - "unknown_type": JSON parsed but the type isn't supported
   *   - "bad_field":  JSON parsed + type known, but a field is wrong
   */
  async _onClientMessage(client, raw) {
    const parsed = parseA2AClientMessage(raw);
    if (!parsed.ok) {
      // Inspect the error text to choose the right code. We classify
      // by string match because the validator already returns precise
      // messages; coupling on that is fine for an internal protocol.
      const errs = parsed.errors || [];
      const isUnknownType = errs.some((e) => e.startsWith("unknown client message type"));
      const isBadField = errs.some((e) => e.startsWith("ack.") || e.startsWith("replay."));
      const code = isUnknownType ? "unknown_type" : (isBadField ? "bad_field" : "malformed_message");
      this._stats.malformedFromClient++;
      this._safeSend(client.ws, {
        type: "error",
        code,
        errors: errs,
      });
      return;
    }

    const msg = parsed.value;

    switch (msg.type) {
      case "replay": {
        const sinceId = Number.isInteger(msg.since_id) && msg.since_id >= 0
          ? msg.since_id : 0;
        await this._serveReplay(client, sinceId);
        break;
      }
      case "ack": {
        const id = Number.isInteger(msg.action_id) && msg.action_id >= 0
          ? msg.action_id : 0;
        client.lastAckedId = Math.max(client.lastAckedId, id);
        this._stats.acksRecorded++;
        this._safeSend(client.ws, { type: "ack_ok", action_id: id });
        // Persist the ack so the bridge can be restarted without losing
        // the client's progress.
        if (this.a2aLog) {
          await this.a2aLog.append({
            kind: "ack",
            from: "client",
            action_id: id,
            ts: new Date().toISOString(),
          });
        }
        break;
      }
      case "ping": {
        this._safeSend(client.ws, { type: "pong", ts: new Date().toISOString() });
        break;
      }
      default:
        // Unknown message type. Be strict: tell the client.
        this._safeSend(client.ws, {
          type: "error",
          code: "unknown_type",
          errors: [`unknown message type '${msg.type}'`],
        });
    }
  }

  /**
   * Stream all actions with id > sinceId to the client, oldest-first.
   * Once the gap is filled, the client simply keeps receiving from the
   * live feed.
   */
  async _serveReplay(client, sinceId) {
    if (!this.a2aLog) {
      this._safeSend(client.ws, {
        type: "replay_end",
        replayed: 0,
        reason: "no_log",
      });
      return;
    }

    let replayed = 0;
    try {
      // Fetch with `since` filter if supported.
      const records = await this.a2aLog.since(sinceId);
      for (const rec of records) {
        if (rec.kind !== "action") continue; // skip ack records
        if (!Number.isInteger(rec.id) || rec.id <= sinceId) continue;
        const sent = this._safeSend(client.ws, {
          type: "action",
          id: rec.id,
          action: rec.action,
          ts: rec.ts,
        });
        if (!sent) break; // client went away
        replayed++;
      }
      this._stats.replaysServed++;
      this._safeSend(client.ws, {
        type: "replay_end",
        replayed,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      this._safeSend(client.ws, {
        type: "error",
        code: "replay_failed",
        errors: [err.message],
      });
    }
  }

  /**
   * Assign the next ID, persist, and broadcast to all live clients.
   */
  _broadcastAction(action) {
    const id = this._nextId++;
    const ts = new Date().toISOString();
    const envelope = { type: "action", id, action, ts };

    // Persist first (so a crash between persist and broadcast doesn't
    // leave the log missing an action that a client might have received).
    // If a2aLog is missing, we still broadcast but log a warning.
    if (this.a2aLog) {
      this.a2aLog.append({
        kind: "action",
        id,
        action,
        ts,
      }).catch((err) => {
        if (this.verbose) console.error(`[a2aBridge] a2aLog.append failed: ${err.message}`);
      });
    }

    // Broadcast to all live clients. Skip any that are lagging.
    for (const c of this._clients) {
      if (c.ws.readyState !== c.ws.OPEN) {
        this._clients.delete(c);
        continue;
      }
      if (c.ws.bufferedAmount > MAX_CLIENT_BACKLOG) {
        if (this.verbose) {
          console.warn(`[a2aBridge] closing lagging client (bufferedAmount=${c.ws.bufferedAmount})`);
        }
        try { c.ws.close(1009, "backpressure"); } catch (_) { /* ignore */ }
        this._clients.delete(c);
        this._stats.clientsDisconnected++;
        continue;
      }
      this._safeSend(c.ws, envelope);
    }
    this._stats.actionsBroadcast++;
  }

  /**
   * Send a JSON message to a client. Returns true if the send was
   * scheduled, false if the client is gone.
   */
  _safeSend(ws, payload) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { A2aBridge, DEFAULT_PORT, MAX_CLIENT_BACKLOG };
