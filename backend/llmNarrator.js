/**
 * backend/llmNarrator.js
 * ----------------------------------------------------------------------------
 * The Conscious Narrator.
 *
 * The narrator takes the latest 5D feature vector + JEPA energy reading +
 * retrieved context chunks and asks the LLM backend to generate a response.
 * While the response streams in, a "stream splitter" peels off two tracks:
 *
 *   TRACK 1 — Prose     : raw markdown tokens that flow to the bridge display.
 *   TRACK 2 — A2A JSON  : any text between <a2a>...</a2a> delimiters is
 *                          parsed, validated, and emitted as an A2AAction
 *                          for the Theia frontend to act on.
 *
 * Cancellation:
 *   When the JEPA energy crosses the anomaly threshold, TrinityCore
 *   calls `narrator.abort()` to kill any in-flight generation. The narrator
 *   then re-enters emergency mode and issues a new forced A2A prompt.
 *
 * Throttling:
 *   Under normal conditions the narrator generates at most every 3-5 s
 *   (configurable). Anomaly events override this throttle immediately.
 *
 * Event surface (extends EventEmitter):
 *   'prose'      (text: string)       — incremental markdown for the bridge
 *   'a2a'        (action: A2AAction)  — fully validated A2A action
 *   'malformed'  ({raw, error})       — bad <a2a> JSON, for diagnostics
 *   'generation-start' ({reason: 'normal'|'anomaly', prompt: string})
 *   'generation-end'   ({reason, aborted})
 * ----------------------------------------------------------------------------
 */

const EventEmitter = require("events");
const {
  HttpLlmBackend,
  OpenAiCompatibleBackend,
  MockLlmBackend,
  createBackend,
} = require("./llmBackends");

const DEFAULT_NORMAL_INTERVAL_MS = 4000;
const DEFAULT_EMERGENCY_INTERVAL_MS = 250;
const A2A_OPEN  = "<a2a>";
const A2A_CLOSE = "</a2a>";

// Allow-list of action names the frontend knows how to execute. Anything
// else is logged via 'malformed' and discarded — defense in depth.
const ALLOWED_ACTIONS = new Set([
  "morph_to_hazard_mode",
  "morph_to_navigation_mode",
  "morph_to_engineering_mode",
  "highlight_waypoint",
  "raise_alert",
  "clear_alerts",
  "set_panel_focus",
  "announce",
]);

class LlmNarrator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.backend                 LlmBackend instance.
   * @param {number} [opts.normalIntervalMs=4000] Throttle between normal generations.
   * @param {string} [opts.systemPrompt]          Override the default system prompt.
   * @param {number} [opts.maxTokens=200]         Token budget per generation.
   * @param {boolean} [opts.think=false]          Pass `think: false` to the backend
   *                                              (suppresses CoT on reasoning models).
   */
  constructor(opts) {
    super();
    if (!opts || !opts.backend) throw new Error("LlmNarrator: backend is required");

    this._backend        = opts.backend;
    this._normalInterval = opts.normalIntervalMs ?? DEFAULT_NORMAL_INTERVAL_MS;
    this._systemPrompt   = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this._maxTokens      = opts.maxTokens ?? 200;
    this._think          = opts.think ?? false;

    this._abortController = null;
    this._inFlight        = false;
    this._lastGeneration  = 0;
    this._destroyed       = false;

    // Stats for the test harness / ops dashboards.
    this._stats = {
      totalGenerations:    0,
      normalGenerations:   0,
      emergencyGenerations: 0,
      abortedGenerations:  0,
      a2aActionsEmitted:   0,
    };
  }

  /**
   * Build the *entire* prompt (system + user) for the LLM given the current
   * sensory + cognitive + memory context.
   *
   * If `ctx.emergencyHeader` is set, the system prompt is swapped to the
   * emergency variant which explicitly demands a UI mutation block.
   */
  buildPrompt(ctx) {
    const { featureVector, energy, retrieved } = ctx;
    const isEmergency = typeof ctx.emergencyHeader === "string" && ctx.emergencyHeader.length > 0;
    return {
      system: isEmergency ? EMERGENCY_SYSTEM_PROMPT : this._systemPrompt,
      user:   constructUserPrompt({
        featureVector,
        energy,
        retrieved: retrieved ?? [],
        emergencyHeader: isEmergency ? ctx.emergencyHeader : null,
      }),
    };
  }

  /**
   * Trigger a normal-mode generation if the throttle permits. Returns
   * `false` if the throttle blocked it, `true` if a generation was kicked
   * off.
   */
  async maybeGenerate(ctx) {
    if (this._destroyed)   return false;
    if (this._inFlight)    return false;

    const sinceLast = Date.now() - this._lastGeneration;
    if (sinceLast < this._normalInterval) return false;

    await this._startGeneration("normal", ctx);
    return true;
  }

  /**
   * Trigger an emergency generation immediately, aborting any in-flight
   * normal generation. Used by TrinityCore when JEPA flags an anomaly.
   *
   * The optional `ctx.emergencyHeader` string lets TrinityCore inject a
   * tag (default "EMERGENCY") into the system prompt to explicitly tell
   * the LLM that this is an emergency response and a UI mutation is
   * required.
   */
  async forceEmergency(ctx) {
    if (this._destroyed) return;
    this.abort();
    // Slight delay so the abort lands before the new request starts.
    await sleep(5);
    await this._startGeneration("anomaly", ctx);
  }

  /**
   * Abort any in-flight generation. Safe to call when nothing is running.
   */
  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._stats.abortedGenerations += 1;
    }
  }

  /** Tear down. */
  destroy() {
    this._destroyed = true;
    this.abort();
  }

  get stats()      { return { ...this._stats }; }
  get inFlight()   { return this._inFlight; }
  get backend()    { return this._backend; }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  async _startGeneration(reason, ctx) {
    if (this._destroyed) return;

    const prompt = this.buildPrompt(ctx);
    this._abortController = new AbortController();
    this._inFlight         = true;
    this._lastGeneration   = Date.now();
    this._stats.totalGenerations += 1;
    if (reason === "anomaly") this._stats.emergencyGenerations += 1;
    else                       this._stats.normalGenerations   += 1;

    this.emit("generation-start", { reason, prompt });

    // Track and reset on completion.
    let aborted = false;
    const splitter = new StreamSplitter();

    try {
      for await (const chunk of this._backend.generate({
        ...prompt,
        signal: this._abortController.signal,
        // Disable chain-of-thought on reasoning models (qwen3, deepseek-r1).
        // We want the *answer*, not a description of how the model is
        // thinking. Override by passing `think: true` to the constructor.
        think: this._think,
        maxTokens: this._maxTokens,
      })) {
        if (this._abortController.signal.aborted) { aborted = true; break; }

        // Prose track.
        const prose = splitter.feed(chunk.text);
        if (prose.length > 0) this.emit("prose", prose);

        // A2A track.
        const a2aTexts = splitter.drainA2A();
        for (const raw of a2aTexts) {
          const parsed = parseAndValidateA2A(raw);
          if (parsed) {
            this._stats.a2aActionsEmitted += 1;
            this.emit("a2a", parsed);
          } else {
            this.emit("malformed", { raw, error: "schema validation failed" });
          }
        }
      }

      // Flush any leftover buffered content on natural completion.
      const tail = splitter.flush();
      if (tail.length > 0) this.emit("prose", tail);
      for (const raw of splitter.drainA2A()) {
        const parsed = parseAndValidateA2A(raw);
        if (parsed) {
          this._stats.a2aActionsEmitted += 1;
          this.emit("a2a", parsed);
        } else {
          this.emit("malformed", { raw, error: "schema validation failed" });
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") aborted = true;
      else this.emit("error", err);
    } finally {
      this._inFlight = false;
      this._abortController = null;
      this.emit("generation-end", { reason, aborted });
    }
  }
}

// ===========================================================================
// StreamSplitter
// ----------------------------------------------------------------------------
// Scans a stream of incoming text chunks for <a2a>...</a2a> blocks. Anything
// outside those tags is "prose". Anything inside is held until the closing
// tag is seen, then released as an A2A candidate for parsing.
//
// This is a state machine over a tiny alphabet:
//   PROSE  → emit to consumer
//   SCAN   → looking for "<a2a>" prefix (could span chunks)
//   A2A    → accumulating JSON until "</a2a>" closes the block
//
// It is allocation-light: text outside A2A passes straight through. Text
// inside A2A is buffered in a small string.
// ===========================================================================

class StreamSplitter {
  constructor() {
    this._buf    = "";   // accumulator for partial A2A bodies
    this._mode   = "prose"; // "prose" | "a2a"
    this._tail   = "";   // unconsumed characters at end of last chunk (partial tag)
  }

  /**
   * Feed a chunk of LLM output. Returns prose that should be emitted.
   */
  feed(text) {
    if (!text) return "";

    let proseOut = "";

    // We hold a tiny tail of the *previous* chunk because "<a2a>" or
    // "</a2a>" may straddle chunk boundaries.
    const combined = this._tail + text;
    this._tail = "";

    let i = 0;
    while (i < combined.length) {
      if (this._mode === "prose") {
        const openIdx = combined.indexOf(A2A_OPEN, i);
        if (openIdx === -1) {
          // No tag boundary in sight. Emit everything up to the last
          // possible prefix position, hold the rest as tail.
          const safe = this._safeBoundary(combined, i);
          proseOut += combined.slice(i, safe);
          this._tail = combined.slice(safe);
          i = combined.length;
        } else {
          // Emit prose up to the tag, switch to A2A mode.
          proseOut += combined.slice(i, openIdx);
          i = openIdx + A2A_OPEN.length;
          this._mode = "a2a";
          this._buf = "";
        }
      } else { // "a2a"
        const closeIdx = combined.indexOf(A2A_CLOSE, i);
        if (closeIdx === -1) {
          // Hold everything; watch for a partial close-tag at the tail.
          const safe = this._safeBoundary(combined, i, A2A_CLOSE);
          this._buf += combined.slice(i, safe);
          this._tail = combined.slice(safe);
          i = combined.length;
        } else {
          this._buf += combined.slice(i, closeIdx);
          this._pendingA2A = this._pendingA2A ?? [];
          this._pendingA2A.push(this._buf);
          this._buf = "";
          i = closeIdx + A2A_CLOSE.length;
          this._mode = "prose";
        }
      }
    }
    return proseOut;
  }

  /**
   * Flush on natural completion. Returns any tail prose that wasn't emitted.
   */
  flush() {
    const tail = this._tail;
    this._tail = "";
    // If we ended mid-A2A, hold it for the next drainA2A() but don't emit prose.
    return this._mode === "prose" ? tail : "";
  }

  /**
   * Drain any completed A2A blocks (FIFO order).
   */
  drainA2A() {
    const out = this._pendingA2A ?? [];
    this._pendingA2A = [];
    return out;
  }

  /**
   * Find the largest safe cut point so we never split a tag across chunks.
   * For "<a2a>" (length 5) we need at least 4 trailing chars to guarantee
   * no false match; for "</a2a>" (length 6) we need 5.
   */
  _safeBoundary(text, from, tag = A2A_OPEN) {
    const minTail = tag.length - 1;
    return Math.max(from, text.length - minTail);
  }
}

// ===========================================================================
// A2A parsing & validation
// ===========================================================================

/**
 * Parse a candidate A2A body as JSON, then validate it against our schema.
 * Returns the validated object on success, null on failure.
 *
 * @param {string} raw
 * @returns {A2AAction | null}
 */
function parseAndValidateA2A(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { return null; }

  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.action !== "string")     return null;
  if (!ALLOWED_ACTIONS.has(parsed.action))   return null;

  // Optional fields with sane defaults.
  const out = {
    action:  parsed.action,
    payload: (parsed.payload && typeof parsed.payload === "object") ? parsed.payload : {},
    reason:  typeof parsed.reason === "string" ? parsed.reason : "",
  };
  if (typeof parsed.priority === "number") {
    out.priority = Math.max(0, Math.min(1, parsed.priority));
  } else {
    out.priority = 0.5;
  }
  return out;
}

// ===========================================================================
// ContextConstructor
// ----------------------------------------------------------------------------
// Builds the user-side prompt from current sensory + cognitive + memory state.
// Kept as a separate function (not a method) so it can be unit-tested without
// instantiating a full LlmNarrator.
// ===========================================================================

/**
 * @param {object}        args
 * @param {Float64Array}  args.featureVector
 * @param {JepaEnergyReading} args.energy
 * @param {RetrievedContextChunk[]} args.retrieved
 * @param {string|null}   [args.emergencyHeader]
 */
function constructUserPrompt({ featureVector, energy, retrieved, emergencyHeader }) {
  const FV = require("./marineConstants").FEATURE_VECTOR_NAMES;
  const fields = [
    `${FV[0]}=${fmt(featureVector[0])}°`,
    `${FV[1]}=${fmt(featureVector[1])}°`,
    `${FV[2]}=${fmt(featureVector[2])} kt`,
    `${FV[3]}=${fmt(featureVector[3])}°`,
    `${FV[4]}=${fmt(featureVector[4])} m`,
    `${FV[5]}=${fmt(featureVector[5], 3)}`,
  ].join(", ");

  const lines = [];
  if (emergencyHeader) lines.push(`# ${emergencyHeader}`);
  lines.push(`# Current state`);
  lines.push(`- Feature vector: ${fields}`);
  lines.push(`- JEPA energy: ${energy.score.toFixed(3)} ${energy.anomaly ? "(ANOMALY)" : ""}`);
  lines.push(`- Reason: ${energy.reason}`);
  lines.push(`- Retrieved context (top ${retrieved.length}):`);
  if (retrieved.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of retrieved) {
      lines.push(`  - [sim=${c.similarity.toFixed(2)}] ${c.text}`);
    }
  }
  lines.push("");
  lines.push(`# Output instructions`);
  if (emergencyHeader) {
    lines.push(`This is an ${emergencyHeader} response. You MUST include exactly one <a2a>{...}</a2a> JSON block in your reply.`);
    lines.push(`Choose an appropriate action from the allow-list and set priority to 0.95+ to reflect urgency.`);
  } else {
    lines.push(`Reply with one short paragraph of stream-of-consciousness prose about the vessel's situation.`);
    lines.push(`If AND ONLY IF a UI mutation is required, include exactly one <a2a>{...}</a2a> block with valid JSON.`);
  }
  lines.push(`Allowed action names: ${[...ALLOWED_ACTIONS].join(", ")}.`);
  return lines.join("\n");
}

function fmt(n, p = 4) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(p);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ===========================================================================
// Default system prompts — instructions for the LLM.
// ===========================================================================
const DEFAULT_SYSTEM_PROMPT =
`You are the conscious narrator of a marine navigation station. Your job is to:
1. Write a short, calm stream-of-consciousness paragraph describing the vessel's current state and your read of the situation.
2. Optionally embed exactly one <a2a>{...}</a2a> JSON block if the situation demands a UI mutation. The JSON must have an "action" string from the allow-list.
Never invent facts. Never exceed one <a2a> block per response. Keep prose under 60 words unless something dramatic has happened, in which case keep it under 120 words.`;

const EMERGENCY_SYSTEM_PROMPT =
`You are the conscious narrator of a marine navigation station responding to an EMERGENCY event detected by the world model.
Your response MUST include exactly one <a2a>{...}</a2a> JSON block (no prose-only responses). Choose the most appropriate action from the allow-list, set "priority" to 0.95 or higher, and supply a concise "reason" explaining the hazard.
Before the <a2a> block, write at most 20 words of calm, urgent prose to inform the captain that the workspace is about to morph.
Never exceed one <a2a> block per response. Never invent sensor values. Allowed action names: morph_to_hazard_mode, raise_alert, highlight_waypoint, set_panel_focus, announce, clear_alerts.`;

// ===========================================================================
// Factory helper — easy default construction.
// ===========================================================================

function createNarrator(opts = {}) {
  // Honour the caller-supplied backend, otherwise pick via env. This means
  //   set CLOUD_LLM_BASE_URL / CLOUD_LLM_MODEL  -> cloud
  //   leave alone                                -> local Ollama
  //   pass opts.backend = new MockLlmBackend()   -> deterministic tests
  const backend = opts.backend ?? createBackend({
    httpOpts: {
      defaultModel:      opts.model      ?? "qwen3:4b",
      defaultEmbedModel: opts.embedModel ?? "nomic-embed-text:latest",
    },
  });
  return new LlmNarrator({
    backend,
    normalIntervalMs: opts.normalIntervalMs,
    systemPrompt:     opts.systemPrompt,
  });
}

// ===========================================================================
// Standalone entry — `node backend/llmNarrator.js`
// Connects to the live telemetry stream and prints a narration every few
// seconds. Requires both the mockSignalK server and Ollama running locally.
// ===========================================================================
if (require.main === module) {
  const TelemetryIngest = require("./telemetryIngest");
  const { JepaWorldModel } = require("./jepaWorldModel");
  const { FEATURE_VECTOR_LAYOUT } = require("./marineConstants");

  const ingest = new TelemetryIngest({ standalone: false, autoReconnect: true });
  const jepa   = new JepaWorldModel({});
  const narrator = createNarrator({ normalIntervalMs: 4000 });

  ingest.on("frame", (vec) => {
    const energy = jepa.observe(vec);
    narrator.maybeGenerate({
      featureVector: vec,
      energy,
      retrieved: [],
    }).catch(() => {});
  });

  narrator.on("prose", (text) => {
    process.stdout.write(text);
  });
  narrator.on("a2a", (action) => {
    console.log("\n[narrator] A2A ACTION:", action);
  });
  narrator.on("malformed", ({ raw, error }) => {
    console.warn("\n[narrator] MALFORMED A2A:", error, raw);
  });

  const shutdown = (sig) => {
    console.log(`\n[narrator] ${sig} received, shutting down...`);
    narrator.destroy();
    ingest.disconnect();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[narrator] waiting for telemetry frames on ws://127.0.0.1:3000...");
  ingest.connect();
}

module.exports = {
  LlmNarrator,
  StreamSplitter,
  parseAndValidateA2A,
  constructUserPrompt,
  createNarrator,
  createBackend,
  ALLOWED_ACTIONS,
  // Re-export backend classes for convenience so callers can do
  //   const { LlmNarrator, MockLlmBackend, OpenAiCompatibleBackend } = require("./llmNarrator");
  HttpLlmBackend,
  OpenAiCompatibleBackend,
  MockLlmBackend,
};