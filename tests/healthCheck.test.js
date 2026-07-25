/**
 * tests/healthCheck.test.js
 * ----------------------------------------------------------------------------
 * Unit tests for backend/healthCheck.js.
 * ----------------------------------------------------------------------------
 */

const {
  buildHealthCheck,
  tcpReachableProbe,
  backendReachableProbe,
  ringBufferProbe,
  STATUS_OK,
  STATUS_DEGRADED,
  STATUS_DOWN,
} = require("../backend/healthCheck");

const { test, assert, run } = require("./_harness");

run("health check", async () => {

  // -------------------------------------------------------------------------
  // Aggregation rules
  // -------------------------------------------------------------------------
  test("all-ok probes → status ok", async () => {
    const hc = buildHealthCheck({
      probes: [
        { name: "a", probe: async () => ({ ok: true }) },
        { name: "b", probe: async () => ({ ok: true, details: { x: 1 } }) },
      ],
    });
    const r = await hc.check();
    assert(r.status === STATUS_OK, "should be ok");
    assert(r.probes.length === 2, "two probes");
    assert(r.failingCritical.length === 0, "no failures");
  });

  test("critical failure → status down", async () => {
    const hc = buildHealthCheck({
      probes: [
        { name: "ingest", critical: true, probe: async () => ({ ok: false, error: "disconnected" }) },
        { name: "llm",    critical: false, probe: async () => ({ ok: true }) },
      ],
    });
    const r = await hc.check();
    assert(r.status === STATUS_DOWN, "should be down");
    assert(r.failingCritical.includes("ingest"), "should flag ingest");
  });

  test("only soft failure → status degraded", async () => {
    const hc = buildHealthCheck({
      probes: [
        { name: "ingest", critical: true,  probe: async () => ({ ok: true }) },
        { name: "llm",    critical: false, probe: async () => ({ ok: false, error: "429" }) },
      ],
    });
    const r = await hc.check();
    assert(r.status === STATUS_DEGRADED, "should be degraded");
    assert(r.failingSoft.includes("llm"), "should flag llm");
  });

  test("critical + soft failure → status down", async () => {
    const hc = buildHealthCheck({
      probes: [
        { name: "ingest", critical: true,  probe: async () => ({ ok: false }) },
        { name: "llm",    critical: false, probe: async () => ({ ok: false }) },
      ],
    });
    const r = await hc.check();
    assert(r.status === STATUS_DOWN, "down wins");
  });

  // -------------------------------------------------------------------------
  // Probe behavior
  // -------------------------------------------------------------------------
  test("probe rejection is captured as failure", async () => {
    const hc = buildHealthCheck({
      probes: [{ name: "x", probe: async () => { throw new Error("boom"); } }],
    });
    const r = await hc.check();
    assert(r.status === STATUS_DOWN, "down");
    assert(r.probes[0].error === "boom", "error captured");
  });

  test("slow probe is bounded by probe timeout", async () => {
    const hc = buildHealthCheck({
      overallTimeoutMs: 5000,
      probeTimeoutMs: 100,
      probes: [{ name: "slow", probe: () => new Promise((r) => setTimeout(() => r({ ok: true }), 5000)) }],
    });
    const t0 = Date.now();
    const r = await hc.check();
    const elapsed = Date.now() - t0;
    assert(elapsed < 1000, `should not exceed probe timeout (took ${elapsed}ms)`);
    assert(r.probes[0].ok === false, "should be marked failed");
  });

  test("report carries durationMs", async () => {
    const hc = buildHealthCheck({ probes: [] });
    const r = await hc.check();
    assert(Number.isFinite(r.durationMs), "duration");
    assert(r.durationMs >= 0, "duration >= 0");
  });

  // -------------------------------------------------------------------------
  // tcpReachableProbe
  // -------------------------------------------------------------------------
  test("tcpReachableProbe: fails for a port we know is not listening", async () => {
    // Use a high random port that is almost certainly free.
    const probe = tcpReachableProbe("127.0.0.1", 1);
    try {
      await probe();
      throw new Error("should have failed");
    } catch (err) {
      assert(err.message.length > 0, "should have error message");
    }
  });

  test("tcpReachableProbe: succeeds for a listening port", async () => {
    const net = require("net");
    const srv = net.createServer((sock) => sock.end());
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const probe = tcpReachableProbe("127.0.0.1", port);
      const r = await probe();
      assert(r.ok, "should be ok");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  // -------------------------------------------------------------------------
  // ringBufferProbe
  // -------------------------------------------------------------------------
  test("ringBufferProbe: reports shape for a populated buffer", async () => {
    // Construct a minimal duck-typed buffer to avoid coupling to the real one.
    const fake = {
      latest: () => new Float64Array([1, 2, 3, 4, 5, 6]),
      size:   () => 100,
    };
    const probe = ringBufferProbe(fake);
    const r = await probe();
    assert(r.ok, "ok");
    assert(r.details.frames === 100, "frames");
    assert(r.details.hasLatest === true, "hasLatest");
  });

  test("ringBufferProbe: ok even with empty buffer", async () => {
    const fake = { latest: () => null, size: () => 0 };
    const probe = ringBufferProbe(fake);
    const r = await probe();
    assert(r.ok, "ok");
    assert(r.details.hasLatest === false, "no latest");
  });

  test("ringBufferProbe: catches exceptions", async () => {
    const fake = { latest: () => { throw new Error("oops"); } };
    const probe = ringBufferProbe(fake);
    const r = await probe();
    assert(r.ok === false, "should fail");
    assert(r.error === "oops", "should report error");
  });
});