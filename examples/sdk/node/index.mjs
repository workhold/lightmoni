import { createLightMoni, withTrace } from "../../../sdk/typescript/dist/src/index.js";

const service = process.env.LIGHTMONI_SERVICE ?? "example-node-api";
const mon = createLightMoni({ selfTelemetry: process.env.LIGHTMONI_SELF_TELEMETRY !== "false",
  service, table: "http",
  endpoint: process.env.LIGHTMONI_ENDPOINT ?? "http://127.0.0.1:4318",
  key: process.env.LIGHTMONI_KEY,
});
const requests = mon.counter("http.requests", { unit: "{request}" });
const duration = mon.histogram("http.duration", { unit: "ms", boundaries: [5, 10, 25, 50, 100, 250] });
const active = mon.gauge("http.active", { unit: "{request}" });
const total = Number(process.env.LIGHTMONI_COUNT ?? 20);
for (let i = 0; i < total; i++) {
  const status = i % 5 === 0 ? 500 : 200;
  const span = mon.withTable("app").startSpan("POST /payments", { route: "/payments" });
  await withTrace(span.context, async () => {
    await Promise.resolve();
    const attrs = { route: "/payments", method: "POST", status };
    requests.add(1, attrs); duration.record(5 + i * 2, attrs); active.record(i % 4);
    if (status === 500) span.setError("sample payment failed");
    mon.withTable("app").log(status === 500 ? "error" : "info", "sample payment completed", { sample_id: i, status });
  });
  span.end();
}
try { await mon.shutdown({ timeoutMs: 15_000 }); console.log(`Delivered ${total} sample requests for ${service}.`, mon.stats()); }
catch (error) { console.error(error.message); process.exitCode = 1; }
