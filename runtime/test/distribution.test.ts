import { test } from "node:test";
import assert from "node:assert/strict";
import { distributionPoint } from "../src/server/distribution.js";
import { normalize, stamp } from "../src/server/ingest.js";
import { createLightMoni, type FrozenBatch } from "@lightmoni/sdk";

test("record groups dimensions, preserves summary totals and never fabricates a distribution", async () => {
  const batches: FrozenBatch[] = [];
  const mon = createLightMoni({
    service: "db",
    env: "test",
    service_version: "1.2",
    instance_id: "fixed",
    selfTelemetry: false,
    remoteConfig: false,
    exporter: {
      async deliver(batch) {
        batches.push(batch);
      },
    },
  });
  mon.record(
    "business",
    "db.duration",
    { key1: "isp", key2: "province" },
    128,
    1,
  );
  mon.record(
    "business",
    "db.duration",
    { key2: "province", key1: "isp" },
    132,
    1,
  );
  mon.record(
    "business",
    "db.duration",
    { key1: "isp", key2: "province" },
    100,
    5,
  );
  mon.record("other", "other.metric", {}, -5, 1);
  mon.record("other", "other.metric", {}, 0, 1);
  mon.record("other", "other.metric", {}, 10, 1);
  mon.record("business", "bad", {}, 1, 0);
  mon.record("business", "bad", { province: "bad" }, 1, 1);
  await mon.shutdown();
  assert.equal(mon.stats().invalidRecords, 2);
  const rows = batches.flatMap((batch) =>
    normalize(
      "metrics",
      JSON.parse(new TextDecoder().decode(batch.payload)),
      stamp(BigInt(Date.now()) * 1000000n),
      "key",
    ).map((row) => ({ ...row, table: batch.table })),
  );
  const db = rows.filter((row) => row.table === "business");
  assert.equal(db.length, 2);
  assert.equal(
    db.reduce((n, r) => n + Number(r.row.count), 0),
    7,
  );
  assert.equal(
    db.reduce((n, r) => n + r.row.sum, 0),
    360,
  );
  const complete = db.find(
    (r) => r.row.distribution_kind === "exponential",
  )!.row;
  assert.equal(complete.min, 128);
  assert.equal(complete.max, 132);
  assert.equal(complete.distribution_count, "2");
  assert.equal(
    complete.bucket_counts.reduce((n: number, v: string) => n + Number(v), 0),
    2,
  );
  const summary = db.find((r) => r.row.distribution_kind === "summary")!.row;
  assert.equal(summary.count, "5");
  assert.equal(summary.sum, 100);
  assert.equal(summary.min, null);
  assert.equal(summary.max, null);
  assert.deepEqual(summary.bucket_values, []);
  assert.equal(summary.distribution_count, "0");
  const resource = JSON.parse(complete.resource_json);
  assert.equal(resource["deployment.environment.name"], "test");
  assert.equal(resource["service.version"], "1.2");
  assert.equal(complete.instance_id, "fixed");
  const signed = rows.find((r) => r.table === "other")!.row;
  assert.equal(signed.count, "3");
  assert.equal(signed.sum, 5);
  assert.ok(signed.bucket_values.some((v: number) => v < 0));
  assert.ok(signed.bucket_values.includes(0));
});

test("distribution decoding rejects invalid buckets, nonfinite values and unmergeable summaries", () => {
  const point = {
    count: "1",
    sum: 1,
    min: 1,
    max: 1,
    scale: 8,
    positive: { offset: -1, bucketCounts: ["1"] },
    zeroCount: "0",
  };
  assert.equal(distributionPoint(point).count, "1");
  for (const invalid of [
    { ...point, count: "2" },
    { ...point, scale: 21 },
    { ...point, sum: Infinity },
    { ...point, min: 2 },
    { ...point, positive: { offset: 0, bucketCounts: Array(1025).fill("0") } },
    { ...point, zeroCount: "-1" },
  ])
    assert.throws(() => distributionPoint(invalid));
  assert.throws(() =>
    distributionPoint(
      { count: "5", sum: 100, quantileValues: [{ quantile: 0.95, value: 20 }] },
      true,
    ),
  );
});

test("automatic recording rotates and sends with self telemetry disabled; stop discards buffered observations", async () => {
  const batches: FrozenBatch[] = [];
  const mon = createLightMoni({
    service: "automatic",
    env: "test",
    selfTelemetry: false,
    remoteConfig: false,
    intervalMs: 20,
    exporter: {
      async deliver(batch) {
        batches.push(batch);
      },
    },
  });
  mon.record("database", "duration", {}, 10, 1);
  const until = Date.now() + 1000;
  while (!batches.length && Date.now() < until)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(batches.length, 1);
  mon.record("database", "discarded", {}, 20, 1);
  mon.setReportingEnabled(false);
  mon.setReportingEnabled(true);
  await mon.shutdown();
  assert.equal(batches.length, 1);
});
