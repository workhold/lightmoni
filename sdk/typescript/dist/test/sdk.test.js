import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLightMoni, withTrace } from "../src/index.js";
import { extractTrace, injectTrace } from "../src/core.js";
const decode = (batch) => JSON.parse(new TextDecoder().decode(batch.payload));
function captured() {
    const batches = [];
    const exporter = { async deliver(batch) { batches.push({ ...batch, payload: batch.payload.slice() }); } };
    return { batches, exporter };
}
test("complete dimensions, attribute types, Gauge, Histogram and trace context", async () => {
    const { batches, exporter } = captured();
    const mon = createLightMoni({ service: "test", table: "http", exporter, intervalMs: 60_000 });
    try {
        const requests = mon.counter("requests"), gauge = mon.gauge("active"), hist = mon.histogram("duration", { boundaries: [1, 2], unit: "ms" });
        const attrs = { route: "/pay", status: 200, method: "POST" };
        requests.add(3, attrs);
        attrs.route = "/mutated";
        requests.add(2, { method: "POST", status: 200, route: "/pay" });
        requests.add(1, { method: "POST", status: "200", route: "/pay" });
        gauge.record(1);
        gauge.record(3);
        for (const value of [-1, 1, 1.5, 3])
            hist.record(value);
        const span = mon.withTable("app").startSpan("pay");
        await withTrace(span.context, async () => { await Promise.resolve(); mon.withTable("app").log("info", "complete"); });
        span.end();
        span.end();
        assert.deepEqual(extractTrace(injectTrace(span.context)), { ...span.context, traceState: undefined });
        await mon.flush();
        const metrics = batches.filter(b => b.signal === "metrics").flatMap(b => decode(b).resourceMetrics[0].scopeMetrics[0].metrics);
        const count = metrics.find(m => m.name === "requests").sum;
        assert.equal(count.aggregationTemporality, 1);
        assert.equal(count.dataPoints.length, 2);
        assert.equal(count.dataPoints.reduce((n, p) => n + BigInt(p.asInt), 0n), 6n);
        assert.equal(metrics.find(m => m.name === "active").gauge.dataPoints[0].asDouble, 3);
        const histogram = metrics.find(m => m.name === "duration").histogram.dataPoints[0];
        assert.deepEqual(histogram.bucketCounts, ["2", "1", "1"]);
        assert.equal(histogram.count, "4");
        assert.equal(histogram.sum, 4.5);
        const log = decode(batches.find(b => b.signal === "logs")).resourceLogs[0].scopeLogs[0].logRecords[0];
        assert.equal(log.traceId, span.context.traceId);
        assert.equal(log.spanId, span.context.spanId);
        assert.equal(batches.filter(b => b.signal === "traces").length, 1);
    }
    finally {
        await mon.shutdown();
    }
});
test("ACK loss retries identical frozen batch while new window remains independent", async () => {
    const calls = [];
    const unique = new Map();
    let began, release;
    const started = new Promise(resolve => began = resolve), accepted = new Promise(resolve => release = resolve);
    const exporter = { async deliver(batch) { calls.push(batch); unique.set(batch.id, batch); if (calls.length === 1) {
            began();
            await accepted;
            throw new Error("ACK lost");
        } } };
    const mon = createLightMoni({ service: "test", table: "http", exporter, intervalMs: 60_000, retryMinMs: 1, retryMaxMs: 2 });
    try {
        const count = mon.counter("requests");
        count.add(7);
        const firstFlush = mon.flush();
        await started;
        count.add(3);
        release();
        await firstFlush;
        await mon.flush();
        assert.equal(calls.length, 3);
        assert.equal(calls[0].id, calls[1].id);
        assert.equal(calls[0].createdAt, calls[1].createdAt);
        assert.deepEqual(calls[0].payload, calls[1].payload);
        assert.notEqual(calls[0].id, calls[2].id);
        const total = [...unique.values()].reduce((sum, b) => sum + BigInt(decode(b).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt), 0n);
        assert.equal(total, 10n);
    }
    finally {
        await mon.shutdown();
    }
});
test("cardinality overflow preserves total; SDK queue loss is visible", async () => {
    const { batches, exporter } = captured();
    const mon = createLightMoni({ service: "test", table: "http", exporter, cardinalityLimit: 2 });
    try {
        const count = mon.counter("requests");
        for (let i = 0; i < 5; i++)
            count.add(2, { route: i });
        await mon.flush();
        const points = decode(batches[0]).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
        assert.equal(points.reduce((n, p) => n + BigInt(p.asInt), 0n), 10n);
        assert.equal(mon.stats().overflowRecords, 3);
    }
    finally {
        await mon.shutdown();
    }
    let release;
    const waiting = new Promise(resolve => release = resolve);
    const limited = createLightMoni({ service: "test", table: "http", queueBatches: 1, exporter: { async deliver() { await waiting; } } });
    const count = limited.counter("requests");
    count.add(1);
    await assert.rejects(limited.flush({ timeoutMs: 5 }), /timeout/);
    limited.withTable("app").log("info", "full");
    await assert.rejects(limited.flush({ timeoutMs: 5 }), /timeout/);
    assert.equal(limited.stats().pendingBatches, 1);
    assert.equal(limited.stats().droppedRecords, 1);
    release();
    await assert.rejects(limited.shutdown(), /capacity/);
});
test("HTTP authentication can rotate global Key without losing frozen data", async () => {
    const ids = [];
    const server = createServer((req, res) => { ids.push(String(req.headers["x-lightmoni-batch-id"])); req.resume(); if (req.headers.authorization !== "Bearer new-global-key") {
        res.writeHead(401);
        res.end();
        return;
    } assert.equal(req.headers["x-lightmoni-table"], "http"); assert.ok(req.headers["x-lightmoni-batch-created-at"]); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const mon = createLightMoni({ service: "test", table: "http", endpoint: `http://127.0.0.1:${address.port}`, key: "old-global-key" });
    try {
        mon.counter("requests").add(1);
        await assert.rejects(mon.flush({ timeoutMs: 40 }), /timeout/);
        mon.updateKey("new-global-key");
        await mon.flush({ timeoutMs: 1000 });
        assert.ok(ids.length >= 2);
        assert.equal(ids[0], ids[ids.length - 1]);
    }
    finally {
        await mon.shutdown();
        await new Promise(resolve => server.close(() => resolve()));
    }
});
test("OTLP partial success is not retried or silently reported delivered", async () => {
    let calls = 0;
    const server = createServer((req, res) => { calls++; req.resume(); res.setHeader("Content-Type", "application/json"); res.end('{"partialSuccess":{"rejectedDataPoints":"1"}}'); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const mon = createLightMoni({ service: "test", table: "http", endpoint: `http://127.0.0.1:${address.port}` });
    try {
        mon.counter("requests").add(1);
        await assert.rejects(mon.flush(), /partial/);
        assert.equal(calls, 1);
        assert.equal(mon.stats().rejectedRecords, 1);
        assert.equal(mon.stats().retriedBatches, 0);
    }
    finally {
        await assert.rejects(mon.shutdown(), /partial/);
        await new Promise(resolve => server.close(() => resolve()));
    }
});
