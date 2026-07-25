/**
 * backend/marineConstants.js
 * ----------------------------------------------------------------------------
 * Shared marine-domain constants used by both the mock Signal K streamer
 * and the telemetry ingestion pipeline. Centralizing these values keeps the
 * "physics" of our simulated world consistent across modules.
 *
 * Phase 1 deliberately keeps these hardcoded. Later phases will source them
 * from configuration files or environmental surveys.
 * ----------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// 1. TRAJECTORY WAYPOINTS
// ---------------------------------------------------------------------------
// We model a realistic coastal trajectory using a series of (lat, lon) waypoints
// that roughly follow the western coast of California, USA — moving from
// open water toward a shallow shoreline. The vessel will interpolate between
// these points to produce smooth, believable motion.

const TRAJECTORY_WAYPOINTS = [
  { lat:  37.8200, lon: -122.5200, label: "Golden Gate Approach" },
  { lat:  37.8100, lon: -122.4900, label: "Bay Entrance" },
  { lat:  37.8050, lon: -122.4600, label: "Alcatraz Waters" },
  { lat:  37.7950, lon: -122.4300, label: "Pier 39 Channel" },
  { lat:  37.7800, lon: -122.4100, label: "North Beach Shoals" },
  { lat:  37.7700, lon: -122.3950, label: "Marina Green Flats" },
];

// Maximum vessel speed (knots) and a realistic operational envelope.
const MAX_SPEED_KNOTS         = 8.5;
const MIN_SPEED_KNOTS         = 4.0;
const BASE_HEADING_DEGREES    = 045;   // North-East initial heading
const HEADING_DRIFT_DEGREES   = 6;     // Max random heading oscillation per tick

// ---------------------------------------------------------------------------
// 2. DEPTH FIELD (Mock bathymetry)
// ---------------------------------------------------------------------------
// We simulate a steadily shoaling bottom as the vessel moves along the
// trajectory. Depth is keyed to the segment index between waypoints so it
// changes deterministically and tells a consistent "running-aground" story.

const INITIAL_DEPTH_METERS   = 32.0;   // Deep water at the start
const FINAL_DEPTH_METERS     =  1.8;   // Shallow flats at the end
const DEPTH_JITTER_METERS    =  0.4;   // Small noise so the value breathes

// ---------------------------------------------------------------------------
// 3. NETWORK / TIMING
// ---------------------------------------------------------------------------

const STREAMER_PORT          = 3000;          // WebSocket port for raw telemetry
const STREAMER_HOST          = "127.0.0.1";   // Localhost-only by default
const HEARTBEAT_INTERVAL_MS  = 500;           // 2 Hz — typical marine instrument cadence
const MAX_CLIENT_BACKLOG     = 16;            // Drop frames if a client falls behind

// ---------------------------------------------------------------------------
// 4. FEATURE VECTOR SCHEMA
// ---------------------------------------------------------------------------
// The order of these indices matters — the telemetry consumer relies on
// a fixed-layout Float64Array so that the JEPA encoder (Phase 2) can
// consume the buffer without any per-frame allocation.

const FEATURE_VECTOR_LAYOUT = Object.freeze({
  LATITUDE:           0,
  LONGITUDE:          1,
  SPEED_OVER_GROUND:  2,   // knots
  HEADING_TRUE:       3,   // degrees (0..360)
  DEPTH:              4,   // meters below transducer
  TRAJECTORY_PROGRESS: 5, // 0..1, fraction of route completed
  VECTOR_DIM:         6,   // Total length of the feature vector
});

// Field names that map to each feature index. Useful for debugging.
const FEATURE_VECTOR_NAMES = Object.freeze([
  "latitude",
  "longitude",
  "speedOverGround",
  "headingTrue",
  "depth",
  "trajectoryProgress",
]);

module.exports = {
  TRAJECTORY_WAYPOINTS,
  MAX_SPEED_KNOTS,
  MIN_SPEED_KNOTS,
  BASE_HEADING_DEGREES,
  HEADING_DRIFT_DEGREES,
  INITIAL_DEPTH_METERS,
  FINAL_DEPTH_METERS,
  DEPTH_JITTER_METERS,
  STREAMER_PORT,
  STREAMER_HOST,
  HEARTBEAT_INTERVAL_MS,
  MAX_CLIENT_BACKLOG,
  FEATURE_VECTOR_LAYOUT,
  FEATURE_VECTOR_NAMES,
};