/**
 * tests/ollama.smoke.test.js
 * ----------------------------------------------------------------------------
 * Live integration test for the Ollama-backed HTTP LLM backend.
 *
 * This test is **opt-in** — it requires a running Ollama instance at
 * http://127.0.0.1:11434 with the `qwen3:4b` and `nomic-embed-text` models
 * pulled. If Ollama isn't reachable, we exit 0 (not a failure) so that
 * `npm test` still works in offline / CI environments.
 *
 * What we verify:
 *   1. listModels() returns a non-empty list including the expected models.
 *   2. embed() returns a Float32Array of the right dimensionality.
 *   3. generate() against qwen3:4b actually streams tokens.
 *   4. The StreamSplitter correctly peels prose and <a2a> blocks apart when
 *      fed a hand-crafted stream that contains both.
 *   5. A full LlmNarrator emergency generation against real Ollama produces
 *      either:
 *        - a well-formed <a2a> block (success), or
 *        - prose only with no A2A, which we log as a soft warning but
 *          still treat as a pass (small models sometimes ignore the
 *          instruction, and we're not trying to be flaky).
 *
 * Run: `node tests/ollama.smoke.test.js` or via `npm test`.
 * ----------------------------------------------------------------------------
 */

const assert = require("assert/strict");
const { HttpLlmBackend } = require("../backend/llmBackends");
const {
  LlmNarrator,
  StreamSplitter,
  parseAndValidateA2A,
} = require("../backend/llmNarrator");
const { FEATURE_VECTOR_LAYOUT } = require("../backend/marineConstants");

const ok    = (...a) => console.log("[ollama.smoke] ✓", ...a);
const info  = (...a) => console.log("[ollama.smoke] ·", ...a);
const warn  = (...a) => console.log("[ollama.smoke] !", ...a); // soft warnings go to STDOUT
const fail  = (...a) => console.error("[ollama.smoke] ✗", ...a);

const OLLAMA_DEFAULT_HOST = "127.0.0.1";
const OLLAMA_DEFAULT_PORT = 11434;
const LLM_MODEL           = "qwen3:4b";
const EMBED_MODEL         = "nomic-embed-text:latest";
const GENERATION_TIMEOUT  = 25_000; // ms — qwen3:4b cold load can be slow

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to ping Ollama. Returns true if it's reachable, false otherwise.
 * We use a short timeout so this test never hangs CI.
 */
async function ollamaReachable(host, port) {
  return new Promise((resolve) => {
    const net = require("net");
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.once("connect", () => { sock.destroy(); finish(true); });
    sock.once("error",   () => finish(false));
    setTimeout(() => { sock.destroy(); finish(false); }, 1500);
  });
}

/**
 * Wrap a promise with a hard timeout. Rejects with a clear error if it
 * doesn't settle in time.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// The actual test
// ---------------------------------------------------------------------------

async function main() {
  const backend = new HttpLlmBackend({
    host: OLLAMA_DEFAULT_HOST,
    port: OLLAMA_DEFAULT_PORT,
    defaultModel: LLM_MODEL,
    defaultEmbedModel: EMBED_MODEL,
    requestTimeoutMs: GENERATION_TIMEOUT,
  });

  // ---- 0. Reachability check ---------------------------------------------
  info(`checking Ollama at http://${OLLAMA_DEFAULT_HOST}:${OLLAMA_DEFAULT_PORT}…`);
  const reachable = await ollamaReachable(OLLAMA_DEFAULT_HOST, OLLAMA_DEFAULT_PORT);
  if (!reachable) {
    warn(`Ollama not reachable at http://${OLLAMA_DEFAULT_HOST}:${OLLAMA_DEFAULT_PORT}.`);
    warn("This is normal in CI / offline environments. Skipping live smoke test.");
    console.log("\n[ollama.smoke] ============================================");
    console.log("[ollama.smoke]   ⏭  SKIPPED (Ollama not reachable)");
    console.log("[ollama.smoke] ============================================");
    process.exit(0);
  }
  ok("Ollama is reachable");

  // ---- 1. listModels -----------------------------------------------------
  let models;
  try {
    models = await withTimeout(backend.listModels(), 5000, "listModels");
  } catch (err) {
    fail(`listModels failed: ${err.message}`);
    process.exit(1);
  }
  assert.ok(Array.isArray(models) && models.length > 0, "listModels returned empty list");
  ok(`listModels returned ${models.length} model(s)`);
  info(`available: ${models.slice(0, 6).join(", ")}${models.length > 6 ? "…" : ""}`);
  if (!models.includes(LLM_MODEL))     warn(`${LLM_MODEL} not pulled — generation test will fail`);
  if (!models.includes(EMBED_MODEL))   warn(`${EMBED_MODEL} not pulled — embedding test will fail`);

  // ---- 2. embed() --------------------------------------------------------
  if (models.includes(EMBED_MODEL)) {
    let emb;
    try {
      emb = await withTimeout(
        backend.embed({ text: "vessel transiting Golden Gate in calm seas", model: EMBED_MODEL }),
        10_000, "embed"
      );
    } catch (err) {
      fail(`embed failed: ${err.message}`);
      process.exit(1);
    }
    assert.ok(emb.vector instanceof Float32Array, "embed did not return a Float32Array");
    assert.ok(emb.vector.length > 0, "embed returned zero-length vector");
    assert.equal(emb.model, EMBED_MODEL);
    // L2 norm should be > 0 (vectors are not zero).
    let norm2 = 0;
    for (let i = 0; i < emb.vector.length; i++) norm2 += emb.vector[i] * emb.vector[i];
    assert.ok(Math.sqrt(norm2) > 0.01, `embedding norm suspiciously small: ${Math.sqrt(norm2)}`);
    ok(`embed returned ${emb.vector.length}-dim Float32Array, L2=${Math.sqrt(norm2).toFixed(3)}`);
  } else {
    warn(`skipping embed test — ${EMBED_MODEL} not available`);
  }

  // ---- 3. generate() stream ----------------------------------------------
  if (models.includes(LLM_MODEL)) {
    let totalChars = 0;
    let doneReceived = false;
    let firstTokenAt = 0;
    const t0 = Date.now();
    // Wrap the async generator in a timeout by racing the inner iteration
    // against a timer. We collect chunks into an array so the for-await
    // stays simple and we can apply the timeout cleanly.
    const chunks = [];
    const iter = backend.generate({
      model: LLM_MODEL,
      system: "You are concise. Reply with one short sentence.",
      user: "What color is the sky on a clear day?",
      maxTokens: 32,
      temperature: 0.2,
    });
    const iteration = (async () => {
      for await (const chunk of iter) chunks.push(chunk);
    })();
    try {
      await withTimeout(iteration, GENERATION_TIMEOUT, "generate");
    } catch (err) {
      fail(`generate failed: ${err.message}`);
      process.exit(1);
    }
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) firstTokenAt = Date.now() - t0;
      if (chunks[i].text) totalChars += chunks[i].text.length;
      if (chunks[i].done)  doneReceived = true;
    }
    assert.ok(totalChars > 0, "generate emitted zero characters (model may be unloaded or thinking-only)");
    assert.ok(doneReceived,  "generate never emitted a done chunk");
    ok(`generate streamed ${totalChars} chars in ${Date.now() - t0}ms (first token at ${firstTokenAt}ms)`);
  } else {
    warn(`skipping generate test — ${LLM_MODEL} not available`);
  }

  // ---- 4. StreamSplitter (deterministic, no LLM needed) ------------------
  const splitter = new StreamSplitter();
  const fixture =
    "Calm seas, " +
    "course 045, " +
    "depth 18 m. " +
    "<a2a>{\"action\":\"highlight_waypoint\",\"payload\":{\"id\":\"Alcatraz\"},\"priority\":0.6,\"reason\":\"passing landmark\"}</a2a>" +
    " Continuing transit.";

  let prose = "";
  for (const ch of fixture) prose += splitter.feed(ch);
  prose += splitter.flush();
  const a2aBlocks = splitter.drainA2A();
  assert.equal(a2aBlocks.length, 1, `expected 1 a2a block, got ${a2aBlocks.length}`);
  const parsed = parseAndValidateA2A(a2aBlocks[0]);
  assert.ok(parsed, "parser rejected valid fixture");
  assert.equal(parsed.action, "highlight_waypoint");
  assert.equal(parsed.payload.id, "Alcatraz");
  assert.ok(!prose.includes("<a2a>"), "prose leaked a2a tags");
  assert.ok(prose.includes("Calm seas"), "prose missing opener");
  assert.ok(prose.includes("Continuing transit."), "prose missing closer");
  ok("StreamSplitter + parser happy-path on fixture");

  // ---- 5. Full LlmNarrator emergency gen against real Ollama -------------
  // This is the most expensive test — we only run it if qwen3:4b is present.
  if (models.includes(LLM_MODEL)) {
    info(`running LlmNarrator emergency generation against ${LLM_MODEL}…`);
    const narrator = new LlmNarrator({
      backend,
      normalIntervalMs: 50,  // override throttle so maybeGenerate fires fast
    });
    const fv = new Float64Array(FEATURE_VECTOR_LAYOUT.VECTOR_DIM);
    fv[FEATURE_VECTOR_LAYOUT.LATITUDE] = 37.82;
    fv[FEATURE_VECTOR_LAYOUT.LONGITUDE] = -122.52;
    fv[FEATURE_VECTOR_LAYOUT.SPEED_OVER_GROUND] = 5.5;
    fv[FEATURE_VECTOR_LAYOUT.HEADING_TRUE] = 90.0;
    fv[FEATURE_VECTOR_LAYOUT.DEPTH] = 1.2;        // anomaly condition
    fv[FEATURE_VECTOR_LAYOUT.TRAJECTORY_PROGRESS] = 0.5;

    const energy = { score: 0.92, anomaly: true, reason: "depth plunge to 1.2 m" };
    const proseChunks = [];
    const a2aActions  = [];
    const malformed   = [];

    narrator.on("prose",     (t) => proseChunks.push(t));
    narrator.on("a2a",       (a) => a2aActions.push(a));
    narrator.on("malformed", (m) => malformed.push(m));
    narrator.on("error",     (e) => fail("narrator error:", e.message));

    const t0 = Date.now();
    // forceEmergency is a regular promise, so withTimeout works directly.
    try {
      await withTimeout(
        narrator.forceEmergency({
          featureVector: fv,
          energy,
          retrieved: [{ similarity: 0.8, text: "past log: grounding near Alcatraz" }],
          emergencyHeader: "EMERGENCY",
        }),
        GENERATION_TIMEOUT,
        "narrator.forceEmergency"
      );
    } catch (err) {
      narrator.destroy();
      fail(`narrator emergency gen failed: ${err.message}`);
      process.exit(1);
    }
    narrator.destroy();
    const elapsed = Date.now() - t0;

    const totalProse = proseChunks.join("");
    info(`narrator returned in ${elapsed}ms: ${totalProse.length} chars prose, ${a2aActions.length} a2a, ${malformed.length} malformed`);

    if (a2aActions.length > 0) {
      assert.equal(a2aActions[0].action, "morph_to_hazard_mode",
        `expected morph_to_hazard_mode, got ${a2aActions[0].action}`);
      assert.ok(a2aActions[0].priority >= 0.5, "priority should be reasonable");
      ok(`real LLM emitted a2a action: ${a2aActions[0].action} (priority ${a2aActions[0].priority})`);
    } else if (malformed.length > 0) {
      warn(`LLM emitted ${malformed.length} malformed a2a block(s) — small model deviation`);
      for (const m of malformed.slice(0, 2)) warn(`  raw=${m.raw.slice(0, 80)}…`);
      ok("narrator parsed + rejected malformed block without crashing");
    } else {
      warn("LLM produced prose only (no <a2a> block). Small models sometimes skip this.");
      warn("Treating as soft pass — the splitter, parser, and pipeline all ran correctly.");
    }
    assert.ok(totalProse.length > 0, "narrator produced no prose at all");
    ok("full LlmNarrator emergency generation completed against real Ollama");
  } else {
    warn("skipping LlmNarrator live test — qwen3:4b not available");
  }

  console.log("\n[ollama.smoke] ============================================");
  console.log("[ollama.smoke]   ✅ OLLAMA SMOKE TEST PASSED");
  console.log("[ollama.smoke] ============================================");
  process.exit(0);
}

main().catch((err) => {
  fail(err.stack || err.message || String(err));
  process.exit(1);
});
