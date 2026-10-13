import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLightMoni, traceHandler, extractTrace } from "../src/index.js";
import { createLightMoni as browserClient } from "../src/browser.js";
function sink() {
    const batches = [];
    return { batches, exporter: { async deliver(batch) { batches.push({ ...batch, payload: batch.payload.slice() }); } } };
}
function records(batches, signal) {
    return batches.filter(b => b.signal === signal).flatMap(b => {
        const data = JSON.parse(new TextDecoder().decode(b.payload));
        return signal === "logs" ? data.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)) : data.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
    });
}
test("Node scoped logs isolate concurrent async tasks and restore nested/error contexts", async () => {
    const capture = sink(), external = { traceId: "f".repeat(32), spanId: "e".repeat(16), flags: 1 };
    const mon = createLightMoni({ service: "scopes", table: "app", exporter: capture.exporter, selfTelemetry: false, intervalMs: 60_000, contextProvider: () => external });
    try {
        await Promise.all([1, 2].map(i => mon.withSpan(`request ${i}`, async (_client, root) => {
            await new Promise(resolve => setTimeout(resolve, 1));
            mon.withTable("other").log("info", `root ${i}`);
            await assert.rejects(mon.withSpan("child", async () => {
                await Promise.resolve();
                mon.log("info", `child ${i}`);
                throw new Error("scope failure");
            }), /scope failure/);
            mon.log("info", `restored ${i}`);
            assert.equal(mon.currentTrace().spanId, root.context.spanId);
            return i;
        }, {}, null)));
        mon.log("info", "outside");
        await mon.flush();
        const logs = new Map(records(capture.batches, "logs").map(log => [log.body.stringValue, log]));
        const spans = records(capture.batches, "traces");
        assert.equal(logs.size, 7);
        assert.equal(spans.length, 4);
        assert.notEqual(logs.get("root 1").traceId, logs.get("root 2").traceId);
        for (const i of [1, 2]) {
            const root = logs.get(`root ${i}`), child = logs.get(`child ${i}`), restored = logs.get(`restored ${i}`);
            assert.equal(root.traceId, child.traceId);
            assert.equal(root.spanId, restored.spanId);
            assert.notEqual(root.spanId, child.spanId);
            assert.notEqual(root.traceId, external.traceId);
            const childSpan = spans.find(span => span.spanId === child.spanId);
            assert.equal(childSpan.parentSpanId, root.spanId);
            assert.equal(childSpan.status.code, 2);
            assert.ok(childSpan.endTimeUnixNano);
        }
        assert.equal(logs.get("outside").traceId, external.traceId);
    }
    finally {
        await mon.shutdown();
    }
});
test("browser bound clients preserve task context across awaits, nested spans and caller mutation", async () => {
    const capture = sink(), mon = browserClient({ service: "web", table: "web", exporter: capture.exporter, selfTelemetry: false, intervalMs: 60_000 });
    try {
        const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16), flags: 0 };
        const bound = mon.withTrace(trace);
        trace.traceId = "c".repeat(32);
        await Promise.all([1, 2].map(i => bound.withSpan(`task ${i}`, async (client) => {
            await Promise.resolve();
            client.withTable("app").log("info", `task ${i}`);
            await client.withSpan("child", async (nested) => { await Promise.resolve(); nested.log("info", `child ${i}`); });
            client.log("info", `restored ${i}`);
        })));
        assert.throws(() => mon.withSpan("sync error", () => { throw new Error("scope failure"); }), /scope failure/);
        mon.log("info", "outside");
        await mon.flush();
        const logs = new Map(records(capture.batches, "logs").map(log => [log.body.stringValue, log]));
        for (const i of [1, 2]) {
            assert.equal(logs.get(`task ${i}`).traceId, "a".repeat(32));
            assert.equal(logs.get(`child ${i}`).flags, 0);
            assert.equal(logs.get(`task ${i}`).spanId, logs.get(`restored ${i}`).spanId);
        }
        assert.notEqual(logs.get("task 1").spanId, logs.get("task 2").spanId);
        assert.equal(logs.get("outside").traceId, undefined);
        const failed = records(capture.batches, "traces").find(span => span.name === "sync error");
        assert.equal(failed.status.code, 2);
        assert.ok(failed.endTimeUnixNano);
    }
    finally {
        await mon.shutdown();
    }
});
test("HTTP handlers and SDK fetch propagate W3C trace across two services", async () => {
    const upSink = sink(), downSink = sink();
    const up = createLightMoni({ service: "upstream", table: "http", exporter: upSink.exporter, selfTelemetry: false, intervalMs: 60_000 });
    const down = createLightMoni({ service: "downstream", table: "http", exporter: downSink.exporter, selfTelemetry: false, intervalMs: 60_000 });
    const headers = (req) => ({ traceparent: req.headers.traceparent, tracestate: req.headers.tracestate });
    const start = async (handler) => {
        const server = createServer((req, res) => { void handler(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        return { server, url: `http://127.0.0.1:${address.port}` };
    };
    const downstream = await start(traceHandler(down, "downstream HTTP", async (req, res) => {
        await Promise.resolve();
        down.log("info", `down ${req.url}`);
        res.end(JSON.stringify(down.currentTrace()));
    }, headers));
    const upstream = await start(traceHandler(up, "upstream HTTP", async (req, res) => {
        up.log("info", `up ${req.url}`);
        const original = new Headers({ "x-business": "preserved", tracestate: "stale=value" });
        const response = await up.fetch(downstream.url + req.url, { headers: original });
        assert.equal(original.get("tracestate"), "stale=value");
        assert.equal(response.status, 200);
        const trace = await response.json();
        up.log("info", `after ${req.url}`);
        res.end(JSON.stringify(trace));
    }, headers));
    try {
        const values = await Promise.all([0, 1, 2].map(async (i) => {
            const response = await fetch(upstream.url + `/${i}`, { headers: i === 0 ? { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00`, tracestate: "vendor=scope" } : i === 1 ? { traceparent: "invalid" } : {} });
            assert.equal(response.status, 200);
            return response.json();
        }));
        assert.equal(values[0].traceId, "a".repeat(32));
        assert.equal(values[0].flags, 0);
        assert.equal(values[0].traceState, "vendor=scope");
        assert.equal(new Set(values.map(value => value.traceId)).size, 3);
        assert.equal(values[1].traceState, undefined);
        up.log("info", "outside");
        await up.flush();
        await down.flush();
        const upLogs = new Map(records(upSink.batches, "logs").map(log => [log.body.stringValue, log]));
        const downLogs = new Map(records(downSink.batches, "logs").map(log => [log.body.stringValue, log]));
        const downSpans = records(downSink.batches, "traces");
        for (const i of [0, 1, 2]) {
            const root = upLogs.get(`up /${i}`), child = downLogs.get(`down /${i}`);
            assert.equal(root.traceId, child.traceId);
            assert.notEqual(root.spanId, child.spanId);
            assert.equal(downSpans.find(span => span.spanId === child.spanId).parentSpanId, root.spanId);
            assert.equal(upLogs.get(`after /${i}`).spanId, root.spanId);
        }
        assert.equal(upLogs.get("outside").traceId, undefined);
        assert.deepEqual(extractTrace({ TraceParent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` }), { traceId: "a".repeat(32), spanId: "b".repeat(16), flags: 1, traceState: undefined });
    }
    finally {
        await Promise.all([upstream.server, downstream.server].map(server => new Promise(resolve => server.close(() => resolve()))));
        await up.shutdown();
        await down.shutdown();
    }
});
