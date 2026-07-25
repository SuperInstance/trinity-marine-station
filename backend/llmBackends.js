/**
 * backend/llmBackends.js
 * ----------------------------------------------------------------------------
 * Pluggable LLM backends for the LlmNarrator.
 *
 * Today: HttpLlmBackend (Ollama). Tomorrow: OpenAiCompatibleBackend (cloud).
 * Plus MockLlmBackend for deterministic tests.
 *
 * Every backend implements the same interface:
 *
 *   class LlmBackend {
 *     async generate(req) → AsyncIterable<LlmChunk>
 *     async embed(req)    → EmbeddingResult      // optional
 *     async listModels()  → string[]
 *     async dispose()     → void                 // optional
 *   }
 *
 * The narrator consumes the AsyncIterable. We use Node's `Readable.from` /
 * async-generator pattern rather than EventEmitter so cancellation is
 * trivial via AbortSignal.
 * ----------------------------------------------------------------------------
 */

const { request } = require("http");

// ===========================================================================
// HttpLlmBackend — talks to Ollama's /api/generate and /api/embed endpoints.
//                 Compatible with any OpenAI-shaped service that exposes
//                 /api/generate (LM Studio, vLLM, etc.) by overriding host.
// ===========================================================================

class HttpLlmBackend {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.host="127.0.0.1"]
   * @param {number}  [opts.port=11434]
   * @param {string}  [opts.generatePath="/api/generate"]
   * @param {string}  [opts.embedPath="/api/embed"]
   * @param {string}  [opts.defaultModel="qwen3:4b"]
   * @param {string}  [opts.defaultEmbedModel="nomic-embed-text:latest"]
   * @param {number}  [opts.requestTimeoutMs=30000]
   */
  constructor(opts = {}) {
    this.host              = opts.host ?? "127.0.0.1";
    this.port              = opts.port ?? 11434;
    this.generatePath      = opts.generatePath ?? "/api/generate";
    this.embedPath         = opts.embedPath    ?? "/api/embed";
    this.defaultModel      = opts.defaultModel ?? "qwen3:4b";
    this.defaultEmbedModel = opts.defaultEmbedModel ?? "nomic-embed-text:latest";
    this.requestTimeoutMs  = opts.requestTimeoutMs ?? 30_000;
  }

  /**
   * Issue an Ollama POST /api/generate with `stream: true`, parse the
   * newline-delimited JSON response, yield LlmChunk objects one at a time.
   * Cancellation is honoured via req.signal.
   *
   * Options (on `req`):
   *   - model, system, user, maxTokens, temperature, stop  — passed through
   *   - think: false                                         — disable CoT
   *     on reasoning models (qwen3, deepseek-r1) so the response
   *     doesn't spend its token budget on internal monologue.
   *
   * @param {LlmGenerateRequest} req
   * @returns {AsyncGenerator<LlmChunk>}
   */
  async *generate(req) {
    const body = {
      model:   req.model ?? this.defaultModel,
      system:  req.system,
      prompt:  req.user,
      stream:  true,
      options: {
        num_predict:  req.maxTokens   ?? 256,
        temperature:  req.temperature ?? 0.7,
        stop:         req.stop,
      },
    };

    // Only attach `think: false` when caller explicitly opts out. Reasoning
    // models (qwen3, deepseek-r1, ...) spend the entire budget on internal
    // thought by default; for short marine narrations we usually want a
    // direct response.
    if (req.think === false) body.think = false;

    const signal = req.signal;
    const chunks = httpNdjsonPost({
      host:    this.host,
      port:    this.port,
      path:    this.generatePath,
      body,
      timeout: this.requestTimeoutMs,
      signal,
    });

    for await (const json of chunks) {
      // Ollama's schema: { response: "...", thinking: "...", done: false|true, ... }
      // "thinking" models (qwen3, deepseek-r1, etc.) emit CoT tokens there
      // while "response" stays empty until the final answer.
      if (typeof json.thinking === "string" && json.thinking.length > 0) {
        yield { text: json.thinking, done: !!json.done, kind: "thinking" };
      }
      if (typeof json.response === "string" && json.response.length > 0) {
        yield { text: json.response, done: !!json.done, kind: "response" };
      } else if (json.done) {
        yield { text: "", done: true, finishReason: "stop" };
      }
    }
  }

  /**
   * Embedding via Ollama /api/embed. Returns a Float32Array.
   * @param {EmbeddingRequest} req
   * @returns {Promise<EmbeddingResult>}
   */
  async embed(req) {
    const body = {
      model: req.model ?? this.defaultEmbedModel,
      input: req.text,
    };

    const json = await httpJsonPost({
      host: this.host,
      port: this.port,
      path: this.embedPath,
      body,
      timeout: this.requestTimeoutMs,
      signal: req.signal,
    });

    // Ollama /api/embed returns { embeddings: [[...]] }
    const arr = json.embeddings?.[0] ?? json.embedding ?? [];
    return {
      model:  body.model,
      vector: Float32Array.from(arr),
    };
  }

  async listModels() {
    const json = await httpJsonGet({
      host: this.host, port: this.port, path: "/api/tags",
      timeout: 5000,
    });
    return (json.models ?? []).map((m) => m.name);
  }

  async dispose() { /* nothing to release */ }
}

// ===========================================================================
// MockLlmBackend — deterministic, used by the lifecycle test.
// Streams tokens from a queue with simulated inter-token latency.
//
// Two queues:
//   - this._normalScript   consumed by normal-mode calls
//   - this._emergencyScript consumed by emergency-mode calls
//
// A generation is classified as emergency iff the prompt system string
// starts with "You are the conscious narrator ... responding to an
// EMERGENCY event". That's brittle to wording changes; we instead detect
// emergency mode by checking the user prompt for the "# EMERGENCY" header
// (a stable seam — we control both the prompt builder and the mock).
// ===========================================================================

class MockLlmBackend {
  /**
   * @param {object} [opts]
   * @param {Array<string|null>} [opts.scriptedResponses]
   *   Legacy single-queue name for the normal-mode script. Still honoured.
   * @param {Array<string>} [opts.normalScript]
   *   Preferred name for the normal-mode script. Same as scriptedResponses.
   * @param {Array<string>} [opts.emergencyScript]
   *   Responses returned for emergency-mode calls. Defaults to one
   *   canned morph_to_hazard_mode payload.
   * @param {number} [opts.chunkDelayMs=12]   Simulated per-token latency.
   */
  constructor(opts = {}) {
    this._normalScript = [];
    this._emergencyScript = opts.emergencyScript ?? [
      "Shallow water detected ahead. <a2a>{\"action\":\"morph_to_hazard_mode\",\"priority\":0.98,\"reason\":\"depth plunge to 1.2 m\"}</a2a>",
    ];
    if (Array.isArray(opts.normalScript))      this._normalScript = [...opts.normalScript];
    else if (Array.isArray(opts.scriptedResponses)) this._normalScript = [...opts.scriptedResponses];
    this._delay = opts.chunkDelayMs ?? 12;
  }

  /** Replace the normal-script queue. */
  setScript(responses) {
    this._normalScript = [...responses];
  }

  /** Replace the emergency-script queue. */
  setEmergencyScript(responses) {
    this._emergencyScript = [...responses];
  }

  _isEmergency(req) {
    // Emergency prompt is tagged with a "# EMERGENCY" header line in the user prompt.
    return typeof req?.user === "string" && req.user.includes("# EMERGENCY");
  }

  async *generate(req) {
    const isEmerg = this._isEmergency(req);
    const queue = isEmerg ? this._emergencyScript : this._normalScript;
    const next = queue.length > 0 ? queue.shift() : "";
    const text = next ?? "";
    for (let i = 0; i < text.length; i++) {
      if (req.signal?.aborted) break;
      yield { text: text[i], done: false, kind: "response" };
      // Use setImmediate for sub-tick delays so tests don't suffer from
      // Node's ~15ms setTimeout floor. For delay <= 1 we still yield to the
      // event loop but don't sleep.
      if (this._delay > 0) {
        if (this._delay <= 1) await new Promise((r) => setImmediate(r));
        else                  await sleep(this._delay);
      }
    }
    yield { text: "", done: true, finishReason: "stop" };
  }

  async embed(/* req */) {
    // Deterministic 8-dim "embedding" derived from the input bytes.
    const vec = new Float32Array(8);
    for (let i = 0; i < 8; i++) vec[i] = 0.125; // not zero — distinguishes from missing
    return { model: "mock", vector: vec };
  }

  async listModels() { return ["mock:0"]; }
  async dispose()   { /* noop */ }
}

// ===========================================================================
// HTTP helpers — minimal, no third-party deps.
// ===========================================================================

/**
 * POST a JSON body to Ollama and parse the NDJSON response as an
 * async iterable of JSON objects.
 */
async function* httpNdjsonPost({ host, port, path, body, timeout, signal }) {
  const json = JSON.stringify(body);
  const res = await httpRequest({
    host, port, path,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(json),
      "accept": "application/x-ndjson",
    },
    body: json,
    timeout,
    signal,
  });

  let buf = "";
  // Node 18+: IncomingMessage is itself AsyncIterable.
  const source = res && res[Symbol.asyncIterator] ? res : res?.body;
  if (!source) throw new Error("httpNdjsonPost: response is not a Readable stream");
  for await (const chunk of source) {
    if (signal?.aborted) { res.destroy(); throw new DOMException("aborted", "AbortError"); }
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      try { yield JSON.parse(line); }
      catch (e) { /* ignore malformed lines, real streams occasionally emit one */ }
    }
  }
  // tail
  if (buf.trim().length > 0) {
    try { yield JSON.parse(buf); } catch {}
  }
}

async function httpJsonPost({ host, port, path, body, timeout, signal }) {
  const json = JSON.stringify(body);
  const res = await httpRequest({
    host, port, path,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(json),
      "accept": "application/json",
    },
    body: json,
    timeout,
    signal,
  });
  // Node 18+ IncomingMessage is itself AsyncIterable. Older Node (<18)
  // exposed the body as `res`. Pass `res` to streamToString which detects
  // both shapes.
  const text = await streamToString(res, signal);
  return JSON.parse(text);
}

async function httpJsonGet({ host, port, path, timeout }) {
  const res = await httpRequest({
    host, port, path,
    method: "GET",
    headers: { "accept": "application/json" },
    timeout,
  });
  const text = await streamToString(res, null);
  return JSON.parse(text);
}

function httpRequest({ host, port, path, method, headers, body, timeout, signal }) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method, headers }, (res) => {
      if (res.statusCode >= 400) {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${buf}`)));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);

    if (signal) {
      const onAbort = () => { req.destroy(new DOMException("aborted", "AbortError")); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeout > 0) {
      req.setTimeout(timeout, () => req.destroy(new Error(`request timeout ${timeout}ms`)));
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function streamToString(stream, signal) {
  // Node 18+: IncomingMessage is itself AsyncIterable. We accept both
  // `res` (Node 18+) and `res.body` (older / shimmed environments).
  const source = stream && stream[Symbol.asyncIterator] ? stream : stream?.body;
  if (!source) {
    throw new Error("streamToString: input is not a Readable/AsyncIterable stream");
  }
  let buf = "";
  for await (const chunk of source) {
    if (signal?.aborted) {
      try { stream?.destroy?.(); } catch {}
      throw new DOMException("aborted", "AbortError");
    }
    buf += chunk.toString("utf8");
  }
  return buf;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  HttpLlmBackend,
  MockLlmBackend,
};