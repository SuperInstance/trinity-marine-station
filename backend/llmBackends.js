/**
 * backend/llmBackends.js
 * ----------------------------------------------------------------------------
 * Pluggable LLM backends for the LlmNarrator.
 *
 * Today: HttpLlmBackend (Ollama) and OpenAiCompatibleBackend (cloud).
 * Plus MockLlmBackend for deterministic tests.
 *
 * Every backend implements the same interface:
 *
 *   class LlmBackend {
 *     async generate(req) -> AsyncIterable<LlmChunk>
 *     async embed(req)    -> EmbeddingResult      // optional
 *     async listModels()  -> string[]
 *     async dispose()     -> void                 // optional
 *   }
 *
 * The narrator consumes the AsyncIterable. We use Node's async-generator
 * pattern rather than EventEmitter so cancellation is trivial via AbortSignal.
 *
 * Pull-and-play mode:
 *   Set the environment variables CLOUD_LLM_BASE_URL, CLOUD_LLM_API_KEY,
 *   and CLOUD_LLM_MODEL. The factory createBackend() at the bottom of this
 *   file will choose OpenAiCompatibleBackend automatically. Leave them unset
 *   to keep running on local Ollama.
 * ----------------------------------------------------------------------------
 */

const { request } = require("http");
const { request: httpsRequest } = require("https");

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
   *   - model, system, user, maxTokens, temperature, stop  - passed through
   *   - think: false                                      - disable CoT
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
// OpenAiCompatibleBackend — talks to any OpenAI-shaped /v1/chat/completions
// endpoint. Works with OpenAI, Together, Groq, Anyscale, OpenRouter, vLLM,
// LM Studio (in OpenAI mode), llama.cpp's server, etc.
//
// Pull-and-play:
//   Set CLOUD_LLM_BASE_URL, CLOUD_LLM_API_KEY, CLOUD_LLM_MODEL in your env
//   and createBackend() at the bottom will pick this backend automatically.
// ===========================================================================

class OpenAiCompatibleBackend {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   e.g. "https://api.openai.com"
   * @param {string} opts.apiKey    Bearer token. May be omitted for local servers.
   * @param {string} opts.model     e.g. "gpt-4o-mini", "llama-3.1-8b-instant"
   * @param {string} [opts.path="/v1/chat/completions"]
   * @param {number} [opts.requestTimeoutMs=30000]
   */
  constructor(opts) {
    if (!opts?.baseUrl) throw new Error("OpenAiCompatibleBackend: baseUrl is required");
    if (!opts?.model)   throw new Error("OpenAiCompatibleBackend: model is required");
    this._baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this._apiKey  = opts.apiKey ?? "";
    this._model   = opts.model;
    this._path    = opts.path ?? "/v1/chat/completions";
    this._timeout = opts.requestTimeoutMs ?? 30_000;
  }

  /**
   * Stream a chat completion. SSE format:
   *   data: {"choices":[{"delta":{"content":"..."}}]}
   *   data: [DONE]
   *
   * @param {LlmGenerateRequest} req
   */
  async *generate(req) {
    const body = {
      model:       req.model ?? this._model,
      stream:      true,
      temperature: req.temperature ?? 0.7,
      max_tokens:  req.maxTokens   ?? 256,
    };
    if (req.stop) body.stop = req.stop;
    // OpenAI chat format requires a messages array. We translate our
    // (system, user) shape into that.
    body.messages = [];
    if (typeof req.system === "string" && req.system.length > 0) {
      body.messages.push({ role: "system", content: req.system });
    }
    if (typeof req.user === "string" && req.user.length > 0) {
      body.messages.push({ role: "user", content: req.user });
    }
    if (body.messages.length === 0) {
      throw new Error("OpenAiCompatibleBackend.generate: system or user prompt required");
    }

    const url = new URL(this._baseUrl + this._path);
    const isHttps = url.protocol === "https:";
    const requester = isHttps ? httpsRequest : null;

    const headers = {
      "content-type": "application/json",
      "accept": "text/event-stream",
    };
    if (this._apiKey) headers["authorization"] = `Bearer ${this._apiKey}`;

    const stream = httpPostSse({
      host:     url.hostname,
      port:     url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      body:     JSON.stringify(body),
      headers,
      timeout:  this._timeout,
      signal:   req.signal,
      requester,
    });

    let sentDone = false;
    for await (const evt of stream) {
      if (req.signal?.aborted) break;
      // SSE format: data: <payload>\n\n  (we strip the "data: " prefix)
      const payload = evt.data;
      if (payload === "[DONE]") {
        if (!sentDone) { yield { text: "", done: true, finishReason: "stop" }; sentDone = true; }
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(payload); }
      catch { continue; } // ignore malformed lines
      const delta = parsed.choices?.[0]?.delta;
      if (delta && typeof delta.content === "string" && delta.content.length > 0) {
        yield { text: delta.content, done: false, kind: "response" };
      }
      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason && !sentDone) {
        yield { text: "", done: true, finishReason };
        sentDone = true;
      }
    }
  }

  /**
   * /v1/embeddings. Many OpenAI-compatible hosts expose this; some require
   * a different path. Override `embedPath` if needed.
   *
   * @param {EmbeddingRequest} req
   */
  async embed(req) {
    const url = new URL(this._baseUrl + "/v1/embeddings");
    const isHttps = url.protocol === "https:";
    const headers = { "content-type": "application/json" };
    if (this._apiKey) headers["authorization"] = `Bearer ${this._apiKey}`;
    const body = {
      model: req.model ?? this._model,
      input: req.text,
    };
    const json = await httpJsonPost({
      host:    url.hostname,
      port:    url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path:    url.pathname,
      useHttps: isHttps,
      headers,
      body,
      timeout: this._timeout,
      signal:  req.signal,
    });
    const arr = json.data?.[0]?.embedding ?? [];
    return { model: body.model, vector: Float32Array.from(arr) };
  }

  async listModels() {
    const url = new URL(this._baseUrl + "/v1/models");
    const isHttps = url.protocol === "https:";
    const headers = { accept: "application/json" };
    if (this._apiKey) headers["authorization"] = `Bearer ${this._apiKey}`;
    const json = await httpJsonGet({
      host: url.hostname,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path: url.pathname,
      useHttps: isHttps,
      headers,
      timeout: 5000,
    });
    return (json.data ?? []).map((m) => m.id);
  }

  async dispose() { /* nothing to release */ }

  get model() { return this._model; }
  get baseUrl() { return this._baseUrl; }
}

// ===========================================================================
// MockLlmBackend — deterministic, used by the lifecycle test.
// Streams tokens from a queue with simulated inter-token latency.
//
// Two queues:
//   - this._normalScript   consumed by normal-mode calls
//   - this._emergencyScript consumed by emergency-mode calls
//
// A generation is classified as emergency iff the user prompt contains the
// stable "# EMERGENCY" header line (we control both the prompt builder and
// the mock, so this is robust).
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

async function httpJsonPost({ host, port, path, body, useHttps, headers, timeout, signal }) {
  const json = JSON.stringify(body);
  const mergedHeaders = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
    "accept": "application/json",
    ...(headers ?? {}),
  };
  const res = await httpRequest({
    host, port, path,
    method: "POST",
    headers: mergedHeaders,
    body: json,
    timeout,
    signal,
    useHttps,
  });
  const text = await streamToString(res, signal);
  return JSON.parse(text);
}

async function httpJsonGet({ host, port, path, useHttps, headers, timeout }) {
  const mergedHeaders = { accept: "application/json", ...(headers ?? {}) };
  const res = await httpRequest({
    host, port, path,
    method: "GET",
    headers: mergedHeaders,
    timeout,
    useHttps,
  });
  const text = await streamToString(res, null);
  return JSON.parse(text);
}

/**
 * POST a JSON body and stream back Server-Sent Events. Each event is yielded
 * as { event: string, data: string, id: string }.
 */
async function* httpPostSse({ host, port, path, body, headers, timeout, signal, requester }) {
  const res = await httpRequest({
    host, port, path,
    method: "POST",
    headers,
    body,
    timeout,
    signal,
    requester,
  });

  let buf = "";
  const source = res && res[Symbol.asyncIterator] ? res : res?.body;
  if (!source) throw new Error("httpPostSse: response is not a Readable stream");
  for await (const chunk of source) {
    if (signal?.aborted) { res.destroy(); throw new DOMException("aborted", "AbortError"); }
    buf += chunk.toString("utf8");
    // SSE events are delimited by a blank line.
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield parseSseBlock(block);
    }
  }
  if (buf.trim().length > 0) yield parseSseBlock(buf);
}

function parseSseBlock(block) {
  const evt = { event: "message", data: "", id: "" };
  for (const raw of block.split("\n")) {
    if (raw.length === 0 || raw.startsWith(":")) continue;
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const field = raw.slice(0, colon);
    let value = raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data")    evt.data = value;
    else if (field === "event") evt.event = value;
    else if (field === "id")    evt.id = value;
  }
  return evt;
}

function httpRequest({ host, port, path, method, headers, body, timeout, signal, requester, useHttps }) {
  const opts = { host, port, path, method, headers };
  const reqFn = (requester ?? (useHttps ? httpsRequest : null)) ?? request;
  return new Promise((resolve, reject) => {
    const req = reqFn(opts, (res) => {
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

// ===========================================================================
// Pull-and-play factory: pick the right backend based on environment.
//
// Precedence:
//   1. Explicit `opts.backend`        — caller wins
//   2. CLOUD_LLM_BASE_URL + CLOUD_LLM_MODEL — OpenAI-compatible cloud
//   3. (default)                       — local Ollama
//
// Env vars:
//   CLOUD_LLM_BASE_URL   e.g. "https://api.openai.com" or "http://127.0.0.1:8080"
//   CLOUD_LLM_API_KEY    Bearer token (optional for local servers)
//   CLOUD_LLM_MODEL      e.g. "gpt-4o-mini", "llama-3.1-8b-instant"
//
//   LOCAL_LLM_MODEL      Override the default Ollama model (default: qwen3:4b)
//   LOCAL_LLM_EMBED      Override the embed model  (default: nomic-embed-text:latest)
// ===========================================================================

function createBackend(opts = {}) {
  if (opts.backend) return opts.backend;

  const cloudUrl   = process.env.CLOUD_LLM_BASE_URL;
  const cloudModel = process.env.CLOUD_LLM_MODEL;
  if (cloudUrl && cloudModel) {
    return new OpenAiCompatibleBackend({
      baseUrl: cloudUrl,
      apiKey:  process.env.CLOUD_LLM_API_KEY ?? "",
      model:   cloudModel,
    });
  }

  return new HttpLlmBackend({
    defaultModel:      process.env.LOCAL_LLM_MODEL   ?? "qwen3:4b",
    defaultEmbedModel: process.env.LOCAL_LLM_EMBED   ?? "nomic-embed-text:latest",
    ...(opts.httpOpts ?? {}),
  });
}

module.exports = {
  HttpLlmBackend,
  OpenAiCompatibleBackend,
  MockLlmBackend,
  createBackend,
};
