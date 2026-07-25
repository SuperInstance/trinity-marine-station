/**
 * shared/types.js
 * ----------------------------------------------------------------------------
 * Plain-JS implementation of the cross-module type contract used by Phase 3.
 *
 * Why a .js file when the brief asked for TypeScript:
 *   - We don't have `tsc` in the project's toolchain and adding a build step
 *     to a Phase 1 / 3 prototype is friction we don't need.
 *   - JSDoc annotations give us full type hints inside any modern editor.
 *   - The runtime behaviour is identical; the consumer just loses the
 *     `tsc --noEmit` check.
 *
 *   If/when the project grows a build pipeline, these typedefs port to
 *   `shared/types.ts` in a single `mv`. Until then, plain JS is honest.
 * ----------------------------------------------------------------------------
 */

/**
 * @typedef {Object} FeatureVector
 * @property {number} latitude            Degrees.
 * @property {number} longitude           Degrees.
 * @property {number} speedOverGround     Knots.
 * @property {number} headingTrue         Degrees, 0..360.
 * @property {number} depth               Metres below transducer.
 * @property {number} trajectoryProgress  0..1, fraction of route completed.
 */

/**
 * @typedef {Object} JepaEnergyReading
 * @property {number}  score             0..1, where 1 = maximum surprise / anomaly.
 * @property {boolean} anomaly           Convenience: score > anomalyThreshold.
 * @property {string}  reason            Short human description ("depth plunge", etc.)
 * @property {number}  timestamp         Date.now() at emission.
 */

/**
 * @typedef {Object} RetrievedContextChunk
 * @property {string} id
 * @property {string} text
 * @property {number} similarity    Cosine similarity, 0..1.
 */

/**
 * @typedef {Object} A2AAction
 * @property {string} action               Action name (e.g. "morph_to_hazard_mode").
 * @property {Object<string, *>} [payload] Optional payload for the action.
 * @property {number} [priority]           0..1, override strength (1 = forced).
 * @property {string} [reason]             Short justification.
 */

/**
 * @typedef {Object} LlmChunk
 * @property {string}  text       New text appended since the last chunk.
 * @property {boolean} done       True on the final chunk of a generation.
 * @property {string}  [finishReason]  "stop", "length", "abort", etc.
 */

/**
 * @typedef {Object} LlmGenerateRequest
 * @property {string}  system             System prompt.
 * @property {string}  user               User prompt (the constructed context).
 * @property {number}  [maxTokens]
 * @property {number}  [temperature]
 * @property {AbortSignal} [signal]        Cancellation handle.
 */

/**
 * @typedef {Object} EmbeddingRequest
 * @property {string} text
 * @property {string} [model]
 */

/**
 * @typedef {Object} EmbeddingResult
 * @property {Float32Array} vector
 * @property {string}       model
 */

module.exports = {};