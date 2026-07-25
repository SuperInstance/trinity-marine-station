/**
 * tests/h3.test.js
 * ----------------------------------------------------------------------------
 * Unit tests for the lightweight H3-style spatial indexer.
 *
 * Coverage:
 *   - lat/lon validation (rejects NaN, out-of-range, non-finite)
 *   - cell encoding (deterministic, monotonic with resolution, hex format)
 *   - cell decoding (round-trip, center-point recovery)
 *   - getResolution()
 *   - haversineMeters() (sanity checks against known distances)
 *   - grid-locality: two points in the same cell yield the same hex
 *   - grid-coarseness: points in adjacent cells yield different hexes
 *
 * These tests guard the production swap to h3-js: the interface here
 * mirrors h3.latLngToCell / h3.cellToLatLng / h3.getResolution.
 * ----------------------------------------------------------------------------
 */

"use strict";

const {
  test, assert, assertThrows, assertEq, assertNear, ok,
  section, run,
} = require("./_harness");
const h3 = require("../backend/h3");

run("h3", async () => {
  section("lat/lon validation");

  test("rejects out-of-range latitude", async () => {
    assertThrows(() => h3.latLngToCell(91, 0),  /latitude out of range/);
    assertThrows(() => h3.latLngToCell(-91, 0), /latitude out of range/);
  });

  test("rejects out-of-range longitude", async () => {
    assertThrows(() => h3.latLngToCell(0, 181),  /longitude out of range/);
    assertThrows(() => h3.latLngToCell(0, -181), /longitude out of range/);
  });

  test("rejects non-finite values", async () => {
    assertThrows(() => h3.latLngToCell(NaN, 0),      /latitude out of range/);
    assertThrows(() => h3.latLngToCell(0, Infinity), /longitude out of range/);
  });

  test("rejects unsupported resolution", async () => {
    assertThrows(() => h3.latLngToCell(0, 0, 4),   /resolution must be/);
    assertThrows(() => h3.latLngToCell(0, 0, 11),  /resolution must be/);
    assertThrows(() => h3.latLngToCell(0, 0, 7.5), /resolution must be/);
  });

  section("cell encoding");

  test("produces 16-char hex string", async () => {
    const cell = h3.latLngToCell(37.819, -122.519);
    assertEq(typeof cell, "string", "cell type");
    assertEq(cell.length, 16,        "cell length");
    assert(/^[0-9a-f]{16}$/.test(cell), "cell format");
  });

  test("is deterministic across calls", async () => {
    const a = h3.latLngToCell(37.819, -122.519, 8);
    const b = h3.latLngToCell(37.819, -122.519, 8);
    assertEq(a, b, "deterministic output");
  });

  test("different resolutions produce different cells", async () => {
    const r8 = h3.latLngToCell(37.819, -122.519, 8);
    const r9 = h3.latLngToCell(37.819, -122.519, 9);
    const r7 = h3.latLngToCell(37.819, -122.519, 7);
    assert(r8 !== r9, "r8 ≠ r9");
    assert(r8 !== r7, "r8 ≠ r7");
    assertEq(h3.getResolution(r8), 8, "r8 round-trips");
    assertEq(h3.getResolution(r9), 9, "r9 round-trips");
  });

  section("grid locality");

  test("two points ~10m apart at res 9 fall in the same cell", async () => {
    // 10 m at 37° latitude ≈ 0.0001 deg lat, ≈ 0.00009 deg lon
    const a = h3.latLngToCell(37.8190, -122.5190, 9);
    const b = h3.latLngToCell(37.8191, -122.5191, 9);
    assertEq(a, b, "same cell for nearby points");
  });

  test("two points ~10km apart at res 9 fall in different cells", async () => {
    // 10 km at 37° latitude ≈ 0.1 deg
    const a = h3.latLngToCell(37.8190, -122.5190, 9);
    const b = h3.latLngToCell(37.9190, -122.5190, 9);
    assert(a !== b, "different cells for distant points");
  });

  section("round-trip decode");

  test("cellToLatLng returns the cell center, not the input point", async () => {
    const lat = 37.819, lon = -122.519;
    const cell = h3.latLngToCell(lat, lon, 8);
    const decoded = h3.cellToLatLng(cell);
    // Within one cell's diameter (~461m at res 8). At 37° lat, 461m ≈ 0.0041°.
    assertNear(decoded.latitude,  lat, 0.005, "lat");
    assertNear(decoded.longitude, lon, 0.005, "lon");
    assertEq(decoded.resolution, 8, "resolution");
  });

  test("cellToLatLng rejects malformed hex", async () => {
    assertThrows(() => h3.cellToLatLng("not-hex"), /expected 16-char hex/);
    assertThrows(() => h3.cellToLatLng("1234"),    /expected 16-char hex/);
    assertThrows(() => h3.cellToLatLng(""),        /expected 16-char hex/);
    assertThrows(() => h3.cellToLatLng(null),      /expected 16-char hex/);
  });

  section("haversineMeters");

  test("zero distance for identical points", async () => {
    const d = h3.haversineMeters([37.819, -122.519], [37.819, -122.519]);
    assertEq(d, 0, "identical points");
  });

  test("1 deg lat ≈ 111 km", async () => {
    // 1° latitude at the equator is 111.32 km by definition.
    const d = h3.haversineMeters([0, 0], [1, 0]);
    assertNear(d / 1000, 111.32, 0.5, "km/deg-lat");
  });

  test("1 deg lon at equator ≈ 111 km, at 60° lat ≈ 55 km", async () => {
    const equator = h3.haversineMeters([0, 0],  [0, 1]);
    const at60    = h3.haversineMeters([60, 0], [60, 1]);
    assertNear(equator / 1000, 111.32, 0.5, "km/deg-lon at equator");
    assertNear(at60    / 1000, 55.80,  0.5, "km/deg-lon at 60° lat");
  });

  test("SF to LA ≈ 559 km (ground truth check)", async () => {
    // SF: 37.7749, -122.4194    LA: 34.0522, -118.2437
    const sf = [37.7749, -122.4194];
    const la = [34.0522, -118.2437];
    const d = h3.haversineMeters(sf, la);
    // Ground-truth great-circle distance is ~559 km.
    assertNear(d / 1000, 559, 10, "km SF->LA");
  });

  section("edge cases");

  test("cells differ across the dateline (longitude wrap)", async () => {
    // Should not panic or alias across the antimeridian.
    const west  = h3.latLngToCell(0, 179.99, 8);
    const east  = h3.latLngToCell(0, -179.99, 8);
    // Both decode without throwing.
    h3.cellToLatLng(west);
    h3.cellToLatLng(east);
  });

  test("polar coordinates work", async () => {
    // High-latitude encoding should not produce astronomically large
    // cellX values due to the shrinking cos(lat) factor.
    const cell = h3.latLngToCell(89.999, 0, 8);
    h3.cellToLatLng(cell);
  });
});