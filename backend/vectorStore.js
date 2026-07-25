/**
 * backend/vectorStore.js
 * ----------------------------------------------------------------------------
 * In-process vector store for the JEPA associative memory.
 *
 * Phase 3.5 deliverable: a tiny, dependency-free, deterministic vector store
 * that supports the operations the rest of the Trinity needs:
 *
 *   add(vector, metadata)             insert (or update by id)
 *   addText(text, embedFn, metadata)  embed via a callback, then add
 *   query(vector, k)                  top-K by cosine similarity
 *   queryText(text, embedFn, k)       embed + query
 *   size()                            number of stored entries
 *   clear()                           wipe everything
 *
 * Storage shape:
 *   - one Float32Array laid out row-major: N x D  (N grows on demand)
 *   - one parallel array of metadata objects (kept small)
 *
 * Why this exists:
 *   The TrinityCore already calls `retriever.retrieve(featureVector)` and
 *   expects back an array of {similarity, text} chunks. Until now we passed
 *   a no-op retriever. This module gives us a real implementation that:
 *     1. Works fully offline (no sqlite-vss, no chroma, no docker).
 *     2. Is fast enough for the use case (256x768 cosine takes <1ms).
 *     3. Exposes a clean interface so swapping for a real store later is
 *        just changing the constructor in trinityDaemon.js.
 *
 * Future swap candidates:
 *   - sqlite-vss    (still embedded, persistent to disk)
 *   - chroma        (client/server, REST API)
 *   - lancedb       (columnar, fast for large N)
 *   - pgvector      (Postgres extension)
 *
 * All of those expose the same logical operations (insert, query-by-vector)
 * so the downstream Retriever does not need to change.
 * ----------------------------------------------------------------------------
 */

const DEFAULT_DIM = 768; // matches Ollama nomic-embed-text output

class InMemoryVectorStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.dim=768]                Expected embedding dimension.
   * @param {number} [opts.initialCapacity=1024]   Initial row capacity.
   * @param {string} [opts.metric="cosine"]        "cosine" | "dot" | "l2".
   */
  constructor(opts = {}) {
    this._dim     = opts.dim ?? DEFAULT_DIM;
    this._metric  = opts.metric ?? "cosine";
    this._cap     = opts.initialCapacity ?? 1024;
    // Row-major Float32Array. _size rows are valid; the rest are waste.
    this._matrix  = new Float32Array(this._cap * this._dim);
    this._meta    = new Array(this._cap).fill(null);
    this._size    = 0;
    this._nextId  = 0;
  }

  /** Current number of stored vectors. */
  size() { return this._size; }

  /** Fixed embedding dimension required by the store. */
  get dim()    { return this._dim; }
  get metric() { return this._metric; }

  /**
   * Add a vector with optional metadata. Returns the assigned id.
   * If the vector's length does not match the store's dim, returns null.
   *
   * @param {ArrayLike<number>|Float32Array} vector
   * @param {object} [metadata]
   * @returns {number|null}
   */
  add(vector, metadata = {}) {
    if (!vector || vector.length !== this._dim) return null;
    this._ensureCapacity(this._size + 1);

    const row = this._size * this._dim;
    // Copy into the row. If vector is already Float32Array, set() is fastest.
    if (vector instanceof Float32Array) {
      this._matrix.set(vector, row);
    } else {
      for (let i = 0; i < this._dim; i++) this._matrix[row + i] = vector[i];
    }
    const id = this._nextId++;
    this._meta[id] = { id, ...metadata };
    this._size += 1;
    return id;
  }

  /**
   * Convenience: embed a text via the supplied async function, then add.
   * Returns the id, or null on embedding failure.
   *
   * @param {string} text
   * @param {(text: string) => Promise<Float32Array>} embedFn
   * @param {object} [metadata]
   */
  async addText(text, embedFn, metadata = {}) {
    if (typeof embedFn !== "function") {
      throw new Error("VectorStore.addText: embedFn is required");
    }
    const vec = await embedFn(text);
    if (!(vec instanceof Float32Array) && !Array.isArray(vec)) {
      throw new Error("VectorStore.addText: embedFn must return Float32Array or array");
    }
    return this.add(vec, { ...metadata, text });
  }

  /**
   * Top-K vectors by the configured metric. Returns an array of
   *   { id, similarity, metadata }
   * sorted by descending similarity. Empty array if store is empty.
   *
   * @param {ArrayLike<number>|Float32Array} query
   * @param {number} [k=5]
   */
  query(query, k = 5) {
    if (!query || query.length !== this._dim) return [];
    if (this._size === 0) return [];
    const topK = Math.min(Math.max(1, k | 0), this._size);

    // Compute all scores, then partial-sort the top-K.
    // For N up to ~10k this is perfectly fine: 1 dot product per row.
    const scores = new Float32Array(this._size);
    for (let i = 0; i < this._size; i++) {
      scores[i] = this._score(query, i);
    }

    // Partial selection: O(N*k) which is fine for our small N.
    // We track the indices of the top-K scores seen so far.
    const top = new Array(topK).fill(-1);
    const topScores = new Float32Array(topK).fill(-Infinity);
    for (let i = 0; i < this._size; i++) {
      const s = scores[i];
      // Find the slot this score should occupy (smallest of the top-K).
      let minIdx = 0;
      for (let j = 1; j < topK; j++) {
        if (topScores[j] < topScores[minIdx]) minIdx = j;
      }
      if (s > topScores[minIdx]) {
        topScores[minIdx] = s;
        top[minIdx] = i;
      }
    }

    // Assemble results, sort descending by score.
    const out = [];
    for (let j = 0; j < topK; j++) {
      if (top[j] === -1) continue;
      const id = top[j];
      out.push({
        id:        id,
        similarity: topScores[j],
        metadata:  this._meta[id] ?? {},
      });
    }
    out.sort((a, b) => b.similarity - a.similarity);
    return out;
  }

  /**
   * Convenience: embed a text, then query top-K.
   *
   * @param {string} text
   * @param {(text: string) => Promise<Float32Array>} embedFn
   * @param {number} [k=5]
   */
  async queryText(text, embedFn, k = 5) {
    const vec = await embedFn(text);
    const hits = this.query(vec, k);
    // Normalize the result shape to what the rest of the system expects:
    //   { similarity: number, text: string }
    return hits.map((h) => ({
      similarity: h.similarity,
      text:       h.metadata?.text ?? "",
      id:         h.id,
    }));
  }

  /** Wipe all stored entries. Reuses the existing array capacity. */
  clear() {
    this._matrix.fill(0);
    for (let i = 0; i < this._cap; i++) this._meta[i] = null;
    this._size = 0;
    this._nextId = 0;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  _ensureCapacity(needed) {
    if (needed <= this._cap) return;
    // Grow geometrically (2x) to amortize O(n) copies.
    let newCap = this._cap;
    while (newCap < needed) newCap *= 2;
    const newMatrix = new Float32Array(newCap * this._dim);
    newMatrix.set(this._matrix);
    this._matrix = newMatrix;
    const newMeta = new Array(newCap).fill(null);
    for (let i = 0; i < this._cap; i++) newMeta[i] = this._meta[i];
    this._meta = newMeta;
    this._cap = newCap;
  }

  _score(query, rowIdx) {
    const row = rowIdx * this._dim;
    if (this._metric === "dot") {
      let s = 0;
      for (let i = 0; i < this._dim; i++) s += query[i] * this._matrix[row + i];
      return s;
    }
    if (this._metric === "l2") {
      // Return NEGATIVE distance so "higher = better" stays consistent.
      let s = 0;
      for (let i = 0; i < this._dim; i++) {
        const d = query[i] - this._matrix[row + i];
        s += d * d;
      }
      return -Math.sqrt(s);
    }
    // cosine (default)
    let dot = 0, qNorm = 0, rNorm = 0;
    for (let i = 0; i < this._dim; i++) {
      const q = query[i];
      const r = this._matrix[row + i];
      dot   += q * r;
      qNorm += q * q;
      rNorm += r * r;
    }
    const denom = Math.sqrt(qNorm) * Math.sqrt(rNorm);
    return denom === 0 ? 0 : dot / denom;
  }
}

// ===========================================================================
// EmbeddingRetriever — thin wrapper that combines a vector store with an
// embedding function. This is what TrinityCore actually consumes.
// ===========================================================================

class EmbeddingRetriever {
  /**
   * @param {object} opts
   * @param {InMemoryVectorStore} opts.store
   * @param {(text: string) => Promise<Float32Array>} [opts.embedFn]
   *   Embedding function used when callers hand us text. If omitted, only
   *   vector queries are supported.
   * @param {number} [opts.topK=3]   Default number of results to return.
   */
  constructor(opts) {
    if (!opts?.store) throw new Error("EmbeddingRetriever: store is required");
    this._store    = opts.store;
    this._embedFn  = opts.embedFn ?? null;
    this._topK     = opts.topK ?? 3;
  }

  /**
   * Retrieve top-K chunks. Accepts either:
   *   - a Float64Array feature vector (will be embedded via the configured
   *     embedFn if one is provided; otherwise rejected)
   *   - a plain text string (requires embedFn)
   *   - an object with shape { text, vector } to skip the embed call
   *
   * Returns an array of { similarity, text, id }.
   */
  async retrieve(input) {
    if (input == null) return [];

    // Object form: { text, vector }
    if (typeof input === "object" && !Array.isArray(input) &&
        !(input instanceof Float32Array) && !(input instanceof Float64Array)) {
      if (input.vector) {
        const vec = input.vector instanceof Float32Array
          ? input.vector
          : Float32Array.from(input.vector);
        return this._store.query(vec, this._topK).map((h) => ({
          similarity: h.similarity,
          text:       h.metadata?.text ?? "",
          id:         h.id,
        }));
      }
      if (typeof input.text === "string" && this._embedFn) {
        return this._store.queryText(input.text, this._embedFn, this._topK);
      }
      return [];
    }

    // Plain string
    if (typeof input === "string") {
      if (!this._embedFn) return [];
      return this._store.queryText(input, this._embedFn, this._topK);
    }

    // Typed-array feature vector
    if (input instanceof Float32Array || input instanceof Float64Array) {
      const vec = input instanceof Float32Array
        ? input
        : Float32Array.from(input);
      return this._store.query(vec, this._topK).map((h) => ({
        similarity: h.similarity,
        text:       h.metadata?.text ?? "",
        id:         h.id,
      }));
    }

    return [];
  }

  /** Number of stored entries. */
  get size() { return this._store.size(); }
  get store() { return this._store; }
}

module.exports = {
  InMemoryVectorStore,
  EmbeddingRetriever,
  DEFAULT_DIM,
};
