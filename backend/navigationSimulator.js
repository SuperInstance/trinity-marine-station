/**
 * backend/navigationSimulator.js
 * ----------------------------------------------------------------------------
 * Pure stateful simulator for a vessel moving along a predefined coastline
 * trajectory. It knows NOTHING about WebSockets, JSON, or Signal K — it just
 * advances an internal world model and produces a snapshot on demand.
 *
 * This separation matters for the Trinity architecture: the same simulator
 * will later be embedded into the cognitive engine's JEPA world-model during
 * Phase 2 for replay / prediction tasks.
 * ----------------------------------------------------------------------------
 */

const {
  TRAJECTORY_WAYPOINTS,
  MAX_SPEED_KNOTS,
  MIN_SPEED_KNOTS,
  BASE_HEADING_DEGREES,
  HEADING_DRIFT_DEGREES,
  INITIAL_DEPTH_METERS,
  FINAL_DEPTH_METERS,
  DEPTH_JITTER_METERS,
  FEATURE_VECTOR_NAMES,
} = require("./marineConstants");

class NavigationSimulator {
  constructor() {
    if (TRAJECTORY_WAYPOINTS.length < 2) {
      throw new Error("TRAJECTORY_WAYPOINTS must contain at least 2 points.");
    }

    // Start at the first waypoint, facing the second.
    this._waypoints   = TRAJECTORY_WAYPOINTS;
    this._segmentIdx  = 0;                                // current segment index
    this._segProgress = 0;                                // 0..1 within segment

    // Linear interpolation between current segment endpoints.
    const start = this._waypoints[0];
    this._lat = start.lat;
    this._lon = start.lon;

    // Dynamic scalars — jittered each tick for realism.
    this._speedKnots = MIN_SPEED_KNOTS + 1.5;             // gentle cruise start
    this._headingDeg = BASE_HEADING_DEGREES;
    this._depthMeters = INITIAL_DEPTH_METERS;
  }

  /**
   * Advance the world by `dtMs` milliseconds. Returns the new snapshot.
   * Pure function of state — same input always yields same delta.
   */
  tick(dtMs) {
    // --- 1. Decide speed for this tick ---------------------------------------
    // Slow-random walk between MIN and MAX so it doesn't look like a sine wave.
    const speedDelta = (Math.random() - 0.5) * 0.6;       // knots per tick
    this._speedKnots = clamp(
      this._speedKnots + speedDelta,
      MIN_SPEED_KNOTS,
      MAX_SPEED_KNOTS
    );

    // --- 2. Decide heading for this tick -------------------------------------
    // Small drift around a base heading. Heading wraps 0..360.
    const headingDelta = (Math.random() - 0.5) * HEADING_DRIFT_DEGREES;
    this._headingDeg = (this._headingDeg + headingDelta + 360) % 360;

    // --- 3. Move along trajectory --------------------------------------------
    // We advance proportionally to elapsed time, normalized to a "full segment"
    // taking ~12 seconds at nominal speed. This gives a steady visual pace.
    const SEGMENT_DURATION_S = 12;
    const advanceFraction    = (dtMs / 1000) / SEGMENT_DURATION_S;

    this._segProgress += advanceFraction;

    // Walk through segments while we have budget left.
    while (this._segProgress >= 1.0) {
      this._segProgress -= 1.0;
      this._segmentIdx  += 1;

      // Loop back to the start so the demo runs forever.
      if (this._segmentIdx >= this._waypoints.length - 1) {
        this._segmentIdx = 0;
        this._segProgress = 0;
      }
    }

    const a = this._waypoints[this._segmentIdx];
    const b = this._waypoints[this._segmentIdx + 1] ?? this._waypoints[0];
    this._lat = a.lat + (b.lat - a.lat) * this._segProgress;
    this._lon = a.lon + (b.lon - a.lon) * this._segProgress;

    // --- 4. Update depth based on overall route progress ----------------------
    // Linear interpolation from INITIAL -> FINAL across the entire route,
    // plus a small jitter so the value feels alive.
    const totalProgress = this._overallProgress();
    const targetDepth   = INITIAL_DEPTH_METERS +
                          (FINAL_DEPTH_METERS - INITIAL_DEPTH_METERS) * totalProgress;
    const jitter        = (Math.random() - 0.5) * DEPTH_JITTER_METERS;

    // Low-pass filter toward target depth — avoids abrupt changes.
    this._depthMeters += (targetDepth + jitter - this._depthMeters) * 0.35;

    return this.snapshot();
  }

  /**
   * Compute total progress (0..1) across the entire waypoint route.
   */
  _overallProgress() {
    const numSegments = this._waypoints.length - 1;
    return Math.min(1, (this._segmentIdx + this._segProgress) / numSegments);
  }

  /**
   * Produce a Signal K-flavored snapshot of current state.
   * This is the canonical "frame" the streamer will broadcast.
   */
  snapshot() {
    const totalProgress = this._overallProgress();
    const wp = this._waypoints[this._segmentIdx];

    return {
      timestamp: new Date().toISOString(),
      navigation: {
        position: {
          latitude:  this._lat,
          longitude: this._lon,
        },
        speedOverGround: round2(this._speedKnots),
        headingTrue:     round2(this._headingDeg),
      },
      environment: {
        depth: {
          belowTransducer: round2(this._depthMeters),
        },
      },
      meta: {
        trajectoryProgress: round2(totalProgress),
        currentWaypoint:    wp.label,
        segmentIndex:       this._segmentIdx,
      },
    };
  }

  /**
   * Return a fixed-order numeric feature vector matching FEATURE_VECTOR_LAYOUT.
   * The consumer pipeline uses this directly — zero allocation per frame.
   */
  featureVector(out) {
    const totalProgress = this._overallProgress();
    out[0] = this._lat;
    out[1] = this._lon;
    out[2] = this._speedKnots;
    out[3] = this._headingDeg;
    out[4] = this._depthMeters;
    out[5] = totalProgress;
    return out;
  }

  /**
   * Convenience: return the field names in feature-vector order.
   */
  static featureNames() {
    return FEATURE_VECTOR_NAMES;
  }
}

// ---------------------------------------------------------------------------
// Small numeric helpers (kept local — no need for a utils module yet).
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = NavigationSimulator;