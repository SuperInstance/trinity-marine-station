/**
 * tests/vectorStore.test.js
 * ----------------------------------------------------------------------------
 * Unit + integration tests for the in-memory vector store and the
 * EmbeddingRetriever wrapper.
 *
 * Run with:  npm run test:vector
 * ----------------------------------------------------------------------------
 */

const assert = require("node:assert/strict");
const {
  InMemoryVectorStore,
  EmbeddingRetriever,
} = require("../backend/vectorStore");

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { console.log(`  ok   ${name}`); pass++; },
                     (err) => { console.log(`  FAIL ${name}: ${err.message}`); fail++; });
    }
    console.log(`  ok   ${name}`); pass++;
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`); fail++;
  }
}

(async () => {
  console.log("VectorStore tests");

  // ----------- basic add + query -----------
  await test("size starts at 0", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    assert.equal(s.size(), 0);
  });

  await test("add stores vector and assigns id", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    const id = s.add([1, 0, 0, 0], { text: "east" });
    assert.equal(typeof id, "number");
    assert.equal(s.size(), 1);
  });

  await test("add rejects wrong-dim vector", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    assert.equal(s.add([1, 2, 3]), null);
    assert.equal(s.size(), 0);
  });

  await test("query returns 0 results for empty store", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    assert.deepEqual(s.query([1, 0, 0, 0], 3), []);
  });

  await test("cosine similarity: same vector scores 1.0", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0], { text: "east" });
    const hits = s.query([1, 0, 0, 0], 1);
    assert.equal(hits.length, 1);
    assert.ok(Math.abs(hits[0].similarity - 1.0) < 1e-6, "expected 1.0");
    assert.equal(hits[0].metadata.text, "east");
  });

  await test("cosine similarity: orthogonal scores 0.0", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0]);
    const hits = s.query([0, 1, 0, 0], 1);
    assert.ok(Math.abs(hits[0].similarity - 0.0) < 1e-6, "expected 0.0");
  });

  await test("cosine similarity: 45-degree scores ~0.707", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 1, 0, 0]);
    const hits = s.query([1, 0, 0, 0], 1);
    assert.ok(Math.abs(hits[0].similarity - Math.SQRT1_2) < 1e-6,
              `expected ~0.707, got ${hits[0].similarity}`);
  });

  await test("query returns top-K sorted descending", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0], { text: "exact" });
    s.add([0.9, 0.1, 0, 0], { text: "near" });
    s.add([0.5, 0.5, 0, 0], { text: "half" });
    s.add([0, 1, 0, 0], { text: "orthogonal" });
    const hits = s.query([1, 0, 0, 0], 4);
    assert.equal(hits.length, 4);
    assert.equal(hits[0].metadata.text, "exact");
    assert.equal(hits[1].metadata.text, "near");
    assert.equal(hits[2].metadata.text, "half");
    assert.equal(hits[3].metadata.text, "orthogonal");
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i - 1].similarity >= hits[i].similarity,
                "results must be descending");
    }
  });

  await test("query respects k bound", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    for (let i = 0; i < 10; i++) s.add([Math.random(), Math.random(), 0, 0]);
    const hits = s.query([0.5, 0.5, 0, 0], 3);
    assert.equal(hits.length, 3);
  });

  await test("clear() empties the store", () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0]);
    s.add([0, 1, 0, 0]);
    assert.equal(s.size(), 2);
    s.clear();
    assert.equal(s.size(), 0);
    assert.deepEqual(s.query([1, 0, 0, 0], 5), []);
  });

  // ----------- metric: dot / l2 -----------
  await test("dot metric returns raw dot product", () => {
    const s = new InMemoryVectorStore({ dim: 4, metric: "dot" });
    s.add([1, 2, 3, 4]);
    const hits = s.query([1, 1, 1, 1], 1);
    assert.equal(hits[0].similarity, 10);
  });

  await test("l2 metric: exact match scores 0 (distance)", () => {
    const s = new InMemoryVectorStore({ dim: 4, metric: "l2" });
    s.add([1, 0, 0, 0]);
    const hits = s.query([1, 0, 0, 0], 1);
    // Math.sqrt(0) returns -0 in IEEE 754; use object equality to compare.
    assert.equal(Object.is(hits[0].similarity, 0) || Object.is(hits[0].similarity, -0), true);
  });

  await test("l2 metric: non-match returns negative distance", () => {
    const s = new InMemoryVectorStore({ dim: 4, metric: "l2" });
    s.add([1, 0, 0, 0]);
    const hits = s.query([0, 1, 0, 0], 1);
    assert.ok(hits[0].similarity < 0, `distance should be negative, got ${hits[0].similarity}`);
  });

  // ----------- geometric capacity growth -----------
  await test("grows capacity automatically when exceeding initial", () => {
    const s = new InMemoryVectorStore({ dim: 4, initialCapacity: 4 });
    for (let i = 0; i < 100; i++) s.add([Math.random(), Math.random(), Math.random(), Math.random()]);
    assert.equal(s.size(), 100);
    // Query should still work and return sane results.
    const hits = s.query([0.5, 0.5, 0.5, 0.5], 5);
    assert.equal(hits.length, 5);
  });

  // ----------- addText / queryText -----------
  await test("addText + queryText round-trip with fake embedFn", async () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    const fakeEmbed = (text) => {
      const v = new Float32Array(4);
      if (text.includes("east"))  v[0] = 1;
      if (text.includes("north")) v[1] = 1;
      return Promise.resolve(v);
    };
    await s.addText("wind from east",  fakeEmbed, { source: "log" });
    await s.addText("wind from north", fakeEmbed, { source: "log" });
    const hits = await s.queryText("east", fakeEmbed, 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text, "wind from east");
    assert.ok(hits[0].similarity > 0.99);
  });

  // ----------- EmbeddingRetriever -----------
  await test("EmbeddingRetriever with vector input", async () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0], { text: "east" });
    s.add([0, 1, 0, 0], { text: "north" });
    const r = new EmbeddingRetriever({ store: s, topK: 2 });
    const hits = await r.retrieve(new Float32Array([1, 0, 0, 0]));
    assert.equal(hits.length, 2);
    assert.equal(hits[0].text, "east");
  });

  await test("EmbeddingRetriever with text input requires embedFn", async () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0], { text: "east" });
    const r = new EmbeddingRetriever({ store: s });
    const hits = await r.retrieve("east");
    assert.deepEqual(hits, []);
    const r2 = new EmbeddingRetriever({
      store: s,
      embedFn: () => Promise.resolve(new Float32Array([1, 0, 0, 0])),
    });
    const hits2 = await r2.retrieve("east");
    assert.equal(hits2.length, 1);
    assert.equal(hits2[0].text, "east");
  });

  await test("EmbeddingRetriever returns [] for null input", async () => {
    const s = new InMemoryVectorStore({ dim: 4 });
    s.add([1, 0, 0, 0]);
    const r = new EmbeddingRetriever({ store: s });
    const hits = await r.retrieve(null);
    assert.deepEqual(hits, []);
  });

  // ----------- summary -----------
  console.log("---");
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log("vector store: ALL TESTS PASSED");
})();
