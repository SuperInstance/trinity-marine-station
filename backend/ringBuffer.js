/**
 * backend/ringBuffer.js
 * ----------------------------------------------------------------------------
 * A pre-allocated, fixed-capacity ring buffer of Float64 feature vectors.
 *
 * Why this exists:
 *   Phase 1 requires zero per-frame allocation so the JEPA encoder (Phase 2)
 *   can stream over historical telemetry without GC pauses. Every JS object
 *   we *avoid* creating during a 2 Hz stream is one less pause on a vessel
 *   bridge at 0300 in 6-meter seas.
 *
 * Design:
 *   - Storage: a single Float64Array of length (capacity * featureDim).
 *     One contiguous block of doubles — perfect for WebGPU / WASM upload later.
 *   - Write pointer: monotonically increasing index modulo capacity.
 *   - "Latest" semantics: the buffer always holds the most recent `capacity`
 *     frames. Older frames are overwritten in place.
 *   - Counters: we track totalWrites for the lifetime of the buffer so
 *     consumers can tell "frame 137 of infinity".
 *
 * Concurrency model:
 *   Single-writer, single-reader. The writer is the ingest pipeline; the
 *   reader is the future JEPA batch sampler. No locks needed — both run on
 *   the Node event loop and never interleave within a tick.
 *
 * Memory cost at default settings:
 *   256 frames × 6 features × 8 bytes = 12,288 bytes (~12 KB). Negligible.
 * ----------------------------------------------------------------------------
 */

const { FEATURE_VECTOR_LAYOUT } = require("./marineConstants");

class TelemetryRingBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=256]   Number of frames to retain.
   * @param {number} [opts.featureDim]     Override feature dimensionality;
   *                                       defaults to FEATURE_VECTOR_LAYOUT.VECTOR_DIM.
   */
  constructor(opts = {}) {
    this._capacity  = opts.capacity   ?? 256;
    this._featureDim = opts.featureDim ?? FEATURE_VECTOR_LAYOUT.VECTOR_DIM;

    if (!Number.isInteger(this._capacity) || this._capacity <= 0) {
      throw new RangeError("capacity must be a positive integer");
    }
    if (!Number.isInteger(this._featureDim) || this._featureDim <= 0) {
      throw new RangeError("featureDim must be a positive integer");
    }

    // The big flat allocation. This happens ONCE per process lifetime.
    this._storage = new Float64Array(this._capacity * this._featureDim);

    // Ring write head — points to the slot that the NEXT frame will be
    // written into. After writing, we advance it.
    this._head = 0;

    // Lifetime write counter — useful for "frame N of N" reporting.
    this._totalWrites = 0;

    // Lifecycle flags.
    this._destroyed = false;
  }

  /**
   * Write a single feature vector into the ring buffer.
   * @param {Float64Array|number[]} vec  Must have length === featureDim.
   * @returns {number}  the ring slot index (0..capacity-1) where it landed
   */
  write(vec) {
    if (this._destroyed) throw new Error("TelemetryRingBuffer: write after destroy()");
    if (!vec || vec.length !== this._featureDim) {
      throw new RangeError(
        `vector length ${vec?.length} !== featureDim ${this._featureDim}`
      );
    }

    const slotStart = this._head * this._featureDim;

    // Tight loop, no allocations, no spreading, no Array.from().
    for (let i = 0; i < this._featureDim; i++) {
      this._storage[slotStart + i] = vec[i];
    }

    const slot = this._head;
    this._head = (this._head + 1) % this._capacity;
    this._totalWrites += 1;
    return slot;
  }

  /**
   * Read a previously-written frame.
   * @param {number} slot   0..capacity-1
   * @param {Float64Array} [out]   Optional caller-provided buffer to write into.
   *                               If omitted, a new Float64Array is allocated
   *                               (so caller allocates — not us).
   * @returns {Float64Array}
   */
  read(slot, out) {
    if (this._destroyed) throw new Error("TelemetryRingBuffer: read after destroy()");
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._capacity) {
      throw new RangeError(`slot ${slot} out of range [0, ${this._capacity})`);
    }

    const target = out ?? new Float64Array(this._featureDim);
    if (target.length !== this._featureDim) {
      throw new RangeError(
        `output buffer length ${target.length} !== featureDim ${this._featureDim}`
      );
    }

    const start = slot * this._featureDim;
    for (let i = 0; i < this._featureDim; i++) {
      target[i] = this._storage[start + i];
    }
    return target;
  }

  /**
   * Copy the most recent `count` frames (in chronological order — oldest first)
   * into a contiguous Float64Array. Allocates ONE array per call (the output)
   * — used for ML batch sampling where the caller wants a clean snapshot.
   *
   * @param {number} [count=this._capacity]   how many recent frames to return
   * @returns {Float64Array}  length = count * featureDim
   */
  snapshot(count = this._capacity) {
    if (this._destroyed) throw new Error("TelemetryRingBuffer: snapshot after destroy()");
    count = Math.min(count, this._capacity, this._totalWrites);

    const out = new Float64Array(count * this._featureDim);

    // If the ring hasn't wrapped yet, we just slice from 0..head-1.
    // If it has wrapped, "oldest" is at _head.
    if (this._totalWrites < this._capacity) {
      // Nothing overwritten yet — copy [0, count*featureDim) directly.
      const len = count * this._featureDim;
      out.set(this._storage.subarray(0, len));
      return out;
    }

    // Wrapped case — copy [head .. end] then [0 .. head] for chronological order.
    const halfA = (this._capacity - this._head) * this._featureDim;
    out.set(this._storage.subarray(this._head * this._featureDim,
                                   this._head * this._featureDim + halfA), 0);
    out.set(this._storage.subarray(0, this._head * this._featureDim), halfA);
    return out;
  }

  /**
   * Convenience: produce a *single* Float64Array suitable for handing to the
   * future JEPA encoder. Allocates a small vector, populates with the newest
   * frame, returns it.
   */
  latest() {
    if (this._totalWrites === 0) return null;
    // The slot we wrote most recently is one BEHIND the current head.
    const slot = (this._head - 1 + this._capacity) % this._capacity;
    return this.read(slot);
  }

  /**
   * Free the underlying ArrayBuffer. After this, the buffer is unusable.
   * Mostly for test cleanup / hot-reload scenarios.
   */
  destroy() {
    this._storage = null;
    this._destroyed = true;
  }

  // ----- Introspection (cheap) -----
  get capacity()    { return this._capacity; }
  get featureDim()  { return this._featureDim; }
  get totalWrites() { return this._totalWrites; }
  get filled() {
    return Math.min(this._totalWrites, this._capacity);
  }
  get storageBytes() {
    return this._storage ? this._storage.byteLength : 0;
  }
}

module.exports = TelemetryRingBuffer;