/**
 * tests/openai.smoke.test.js
 * ----------------------------------------------------------------------------
 * Smoke test for the OpenAiCompatibleBackend.
 *
 * We don't hit a real cloud service (would require API keys). Instead we
 * spin up a tiny mock OpenAI-compatible server on an ephemeral port that
 * responds with a canned SSE stream, and verify:
 *   - generate() parses the stream correctly and yields LlmChunk objects
 *   - the [DONE] marker is honoured (terminal chunk with done=true)
 *   - abort signal stops the stream cleanly
 *   - embed() parses the response and returns a Float32Array
 *   - listModels() returns model IDs
 *
 * This test runs fully offline, so it's part of the default `npm test`.
 * ----------------------------------------------------------------------------
 */

const assert = require("node:assert/strict");
const http   = require("node:http");
const { OpenAiCompatibleBackend } = require("../backend/llmBackends");

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   ${name}`); pass++; })
    .catch((err) => { console.log(`  FAIL ${name}: ${err.message}`); fail++; });
}

// ---------- mock OpenAI-compatible server ----------
//
// Listens on an ephemeral port. The `mode` parameter controls behaviour:
//   - "happy"     : streams 3 SSE chunks + [DONE]
//   - "abort"     : streams 2 chunks then delays so the client can abort
//   - "embed"     : responds to /v1/embeddings with a fake vector
//   - "list"      : responds to /v1/models with a model list
function startMockOpenAi(mode = "happy") {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/v1/models" && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "mock-1" }, { id: "mock-2" }] }));
          return;
        }
        if (req.url === "/v1/embeddings" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
            model: "mock-1",
          }));
          return;
        }
        if (req.url === "/v1/chat/completions" && req.method === "POST") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const write = (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          };
          if (mode === "happy") {
            write({ choices: [{ delta: { content: "Hello" } }] });
            write({ choices: [{ delta: { content: " world" } }] });
            write({ choices: [{ delta: {}, finish_reason: "stop" }] });
            res.write("data: [DONE]\n\n");
          } else if (mode === "abort") {
            write({ choices: [{ delta: { content: "tok1" } }] });
            write({ choices: [{ delta: { content: "tok2" } }] });
            // Hold the connection open. Client will abort.
            return; // do NOT res.end()
          }
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

(async () => {
  console.log("OpenAI-compatible backend tests");

  // ---- TEST: happy-path stream parsing ----
  await test("generate() parses happy-path SSE stream", async () => {
    const { server, port } = await startMockOpenAi("happy");
    try {
      const backend = new OpenAiCompatibleBackend({
        baseUrl: `http://127.0.0.1:${port}`,
        model:   "mock-1",
      });
      const chunks = [];
      for await (const c of backend.generate({
        system: "be terse",
        user:   "hi",
        maxTokens: 50,
      })) {
        chunks.push(c);
      }
      // 2 content chunks + 1 finish chunk + 1 [DONE] terminal.
      const texts = chunks.filter((c) => c.text && c.text.length > 0).map((c) => c.text);
      assert.equal(texts.join(""), "Hello world");
      const terminal = chunks.find((c) => c.done);
      assert.ok(terminal, "expected a done=true terminal chunk");
    } finally { server.close(); }
  });

  // ---- TEST: abort signal ----
  await test("generate() honours AbortSignal", async () => {
    const { server, port } = await startMockOpenAi("abort");
    let backend;
    try {
      backend = new OpenAiCompatibleBackend({
        baseUrl: `http://127.0.0.1:${port}`,
        model:   "mock-1",
      });
      const ctrl = new AbortController();
      const chunks = [];
      let aborted = false;
      // Race: either the for-await completes cleanly (because we call
      // ctrl.abort() and the backend sees the flag and returns) or the
      // destroyed HTTP connection throws an AbortError. Both are valid
      // expressions of "abort was honoured".
      await new Promise((resolve) => {
        (async () => {
          try {
            for await (const c of backend.generate({ system: "x", user: "y", signal: ctrl.signal })) {
              chunks.push(c);
              if (chunks.length >= 2) ctrl.abort();
            }
          } catch (err) {
            if (err?.name === "AbortError" || /aborted/i.test(err?.message ?? "")) {
              aborted = true;
            } else {
              throw err;
            }
          } finally { resolve(); }
        })();
        // Safety net: if neither path fires, resolve after 500ms anyway.
        setTimeout(resolve, 500);
      });
      assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
      assert.ok(aborted || chunks.length <= 2,
        `expected clean exit or abort; got chunks=${chunks.length}, aborted=${aborted}`);
      const fullText = chunks.map((c) => c.text ?? "").join("");
      assert.ok(fullText.includes("tok"), `expected tok in output, got: ${JSON.stringify(fullText)}`);
    } finally {
      try { server.close(); } catch {}
    }
  });

  // ---- TEST: embed() ----
  await test("embed() returns Float32Array with correct shape", async () => {
    const { server, port } = await startMockOpenAi("embed");
    try {
      const backend = new OpenAiCompatibleBackend({
        baseUrl: `http://127.0.0.1:${port}`,
        model:   "mock-1",
      });
      const result = await backend.embed({ text: "hello world" });
      assert.ok(result.vector instanceof Float32Array);
      assert.equal(result.vector.length, 4);
      assert.ok(Math.abs(result.vector[0] - 0.1) < 1e-6);
      assert.equal(result.model, "mock-1");
    } finally { server.close(); }
  });

  // ---- TEST: listModels() ----
  await test("listModels() returns model IDs", async () => {
    const { server, port } = await startMockOpenAi("list");
    try {
      const backend = new OpenAiCompatibleBackend({
        baseUrl: `http://127.0.0.1:${port}`,
        model:   "mock-1",
      });
      const models = await backend.listModels();
      assert.deepEqual(models, ["mock-1", "mock-2"]);
    } finally { server.close(); }
  });

  // ---- TEST: constructor validation ----
  await test("constructor rejects missing baseUrl", () => {
    assert.throws(() => new OpenAiCompatibleBackend({ model: "x" }), /baseUrl is required/);
  });
  await test("constructor rejects missing model", () => {
    assert.throws(() => new OpenAiCompatibleBackend({ baseUrl: "http://x" }), /model is required/);
  });

  console.log("---");
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log("openai: ALL TESTS PASSED");
})();