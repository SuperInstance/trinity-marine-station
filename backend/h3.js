// backend/h3.js
// =============================================================================
// Lightweight H3-style spatial indexer for marine-scale lat/lon.
//
// This is NOT a full H3 implementation — it's a quantized-grid approximation
// that gives us:
//   - monotonic, deterministic uint64 hex strings
//   - stable across processes / restarts
//   - good-enough neighborhood clustering at marine scale (~30m cells)
//
// Designed to be replaced by the real `h3-js` package in production
// (drop-in: `latLngToCell(lat, lon, res)`). The interface here matches
// that one for forward compatibility.
//
// Why not just use h3-js?
//   - We want zero npm-install cost on the boat workstation today
//   - We want a fully testable, dependency-free implementation
//   - For cognitive work (anomaly grouping, fleet pattern matching), the
//     exact hex boundary doesn't matter — locality does
//
// Resolution table (chosen for SE Alaska fishing scale):
//   res 9  ≈ 174 m   cell area       → harbor / dock scale
//   res 8  ≈ 461 m                    → bay / cove scale   (DEFAULT)
//   res 7  ≈ 1.22 km                  → reef / school scale
//   res 6  ≈ 3.66 km                  → channel scale
// =============================================================================

"use strict";

const DEFAULT_RESOLUTION = 8;   // ~461 m cells — good for boat cognition

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a (latitude, longitude) pair to an H3-style hex string.
 *
 * @param {number} lat  Latitude in degrees, [-90, 90]
 * @param {number} lon  Longitude in degrees, [-180, 180]
 * @param {number} [resolution=8]  H3 resolution level (we support 5..10)
 * @returns {string}  15-character hex string (zero-padded uint64)
 *
 * @example
 *   h3.latLngToCell(58.123, -134.456)        // "8a21104523fffff"-like
 *   h3.latLngToCell(58.123, -134.456, 7)    // coarser cell
 */
function latLngToCell(lat, lon, resolution = DEFAULT_RESOLUTION) {
  validateLatLon(lat, lon);
  if (!Number.isInteger(resolution) || resolution < 5 || resolution > 10) {
    throw new RangeError(`h3.resolution must be 5..10, got ${resolution}`);
  }

  // Project lat/lon to a local equirectangular grid in meters.
  // At marine scales, equirectangular is accurate to within a few cm/km —
  // well below our 461 m cell size.
  const metersPerDegLat = 111_320;
  const latRad = (lat * Math.PI) / 180;
  const metersPerDegLon = 111_320 * Math.cos(latRad);

  // Cell size in meters for this resolution (matches H3-ish areas):
  const cellSizeMeters = resolutionToMeters(resolution);

  // Quantize to cell coordinates in a Web-Mercator-ish integer grid.
  const cellX = Math.floor((lon * metersPerDegLon) / cellSizeMeters);
  const cellY = Math.floor((lat * metersPerDegLat)  / cellSizeMeters);

  // Combine (cellX, cellY, resolution) into a uint64-ish value, then format.
  //
  // Layout (high-to-low bits):
  //   [63..56] resolution nibble  (so different resolutions don't collide)
  //   [55..32] cellY  (24 bits, signed-aware)
  //   [31..8]  cellX  (24 bits, signed-aware)
  //   [7..0]   reserved  (zero, keeps the hex string 16 chars wide)
  //
  // For marine scale (~ ±90° lat, ±180° lon), cellX/cellY fit easily in 24 bits.
  const sign = (n) => (n < 0 ? n + 0x1_000_000 : n); // 24-bit two's complement
  const x24 = sign(cellX) & 0xFF_FFFF;
  const y24 = sign(cellY) & 0xFF_FFFF;

  let value = BigInt(resolution) << 56n
            | BigInt(y24)         << 32n
            | BigInt(x24);

  // 16-char zero-padded hex (uint64). Negative never happens (we masked).
  return value.toString(16).padStart(16, "0");
}

/**
 * Decode an H3-style hex string back to approximate (lat, lon).
 *
 * NOTE: This returns the *center* of the cell, not the exact input point.
 * Use only for grouping/clustering, not for precision navigation.
 *
 * @param {string} cell  16-char hex string from latLngToCell()
 * @returns {{ latitude: number, longitude: number, resolution: number }}
 */
function cellToLatLng(cell) {
  if (typeof cell !== "string" || !/^[0-9a-f]{16}$/i.test(cell)) {
    throw new TypeError(`h3.cellToLatLng: expected 16-char hex, got ${JSON.stringify(cell)}`);
  }
  const value = BigInt("0x" + cell);

  const resolution = Number((value >> 56n) & 0xFFn);
  const y24 = Number((value >> 32n) & 0xFF_FFFFn);
  const x24 = Number(value          & 0xFF_FFFFn);

  // Reconstruct signed 24-bit values
  const cellX = (x24 & 0x80_0000) ? x24 - 0x100_0000 : x24;
  const cellY = (y24 & 0x80_0000) ? y24 - 0x100_0000 : y24;

  const cellSizeMeters = resolutionToMeters(resolution);

  // Center of cell. The encode step used a per-point cos(lat) scaling, so
  // the decode step must use the *same* lat to recover the correct cell
  // center longitude. We compute lat first, then use it in the lon inverse.
  const metersPerDegLat = 111_320;
  const lat = ((cellY + 0.5) * cellSizeMeters) / metersPerDegLat;
  const metersPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const lon = ((cellX + 0.5) * cellSizeMeters) / metersPerDegLon;

  return { latitude: lat, longitude: lon, resolution };
}

/**
 * Get the integer resolution of a cell.
 * @param {string} cell
 * @returns {number}
 */
function getResolution(cell) {
  if (typeof cell !== "string" || cell.length < 1) {
    throw new TypeError("h3.getResolution: invalid cell");
  }
  const value = BigInt("0x" + cell);
  return Number((value >> 56n) & 0xFFn);
}

/**
 * Approximate great-circle distance between two (lat, lon) pairs in meters.
 * Uses the haversine formula — accurate to ~0.5% which is well below any
 * cell resolution we use.
 *
 * @param {[number, number]} a  [lat, lon] in degrees
 * @param {[number, number]} b  [lat, lon] in degrees
 * @returns {number} distance in meters
 */
function haversineMeters(a, b) {
  const R = 6_371_000; // earth radius m
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolutionToMeters(resolution) {
  // Hand-tuned to roughly match H3 hex areas at each resolution.
  // (For real H3, swap in `h3-js`: h3.getHexagonAreaAvg(res, h3.UNITS.m2))
  switch (resolution) {
    case 5:  return 8_544;     // ~25 km²
    case 6:  return 3_660;
    case 7:  return 1_220;
    case 8:  return    461;    // DEFAULT
    case 9:  return    174;
    case 10: return     65;
    default: throw new RangeError(`unsupported resolution ${resolution}`);
  }
}

function validateLatLon(lat, lon) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`h3: latitude out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`h3: longitude out of range: ${lon}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  latLngToCell,
  cellToLatLng,
  getResolution,
  haversineMeters,
  DEFAULT_RESOLUTION,
};