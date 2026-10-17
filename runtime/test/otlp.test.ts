import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  encodeOTLP,
  decodeOTLP,
  encodeOTLPResponse,
  decodeOTLPResponse,
  inputHash,
  parseNanoTime,
  formatNanoTime,
  type Signal,
} from "../src/shared/otlp.js";
const repo = resolve(import.meta.dirname, "../.."),
  dir = mkdtempSync(join(tmpdir(), "lightmoni-otlp-")),
  go = process.env.LIGHTMONI_GO ?? join(repo, ".local-dev/go/bin/go"),
  binary = join(dir, "otlp-baseline");
before(() => {
  if (!existsSync(go)) return;
  writeFileSync(
    join(dir, "main.go"),
    `package main
import("crypto/sha256";"encoding/base64";"encoding/json";"encoding/hex";"fmt";"os";"time";"google.golang.org/protobuf/proto";"google.golang.org/protobuf/encoding/protojson";logs "go.opentelemetry.io/proto/otlp/collector/logs/v1";metrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1";traces "go.opentelemetry.io/proto/otlp/collector/trace/v1")
func main(){var x struct{Signal,Data,JSON,Table,Created string};json.NewDecoder(os.Stdin).Decode(&x);var m proto.Message;switch x.Signal{case "logs":m=&logs.ExportLogsServiceRequest{};case "metrics":m=&metrics.ExportMetricsServiceRequest{};case "traces":m=&traces.ExportTraceServiceRequest{}};var err error;if x.JSON!=""{err=protojson.Unmarshal([]byte(x.JSON),m)}else{b,_:=base64.StdEncoding.DecodeString(x.Data);err=proto.Unmarshal(b,m)};if err!=nil{json.NewEncoder(os.Stdout).Encode(map[string]string{"error":err.Error()});return};out,err:=proto.MarshalOptions{Deterministic:true}.Marshal(m);if err!=nil{panic(err)};created,err:=time.Parse(time.RFC3339Nano,x.Created);if err!=nil{panic(err)};sum:=sha256.Sum256(append([]byte(fmt.Sprintf("%s%c%s%c%s%c",x.Signal,0,x.Table,0,created.UTC().Format(time.RFC3339Nano),0)),out...));json.NewEncoder(os.Stdout).Encode(map[string]string{"data":base64.StdEncoding.EncodeToString(out),"hash":hex.EncodeToString(sum[:])})}
`,
  );
  execFileSync(go, ["build", "-o", binary, join(dir, "main.go")], {
    cwd: repo,
    timeout: 120000,
  });
});
after(() => rmSync(dir, { recursive: true, force: true }));
const samples: [Signal, any][] = [
  [
    "logs",
    {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "test" } },
              { key: "max", value: { intValue: "9223372036854775807" } },
              { key: "min", value: { intValue: "-9223372036854775808" } },
              { key: "empty", value: { stringValue: "" } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: "scope" },
              logRecords: [
                {
                  timeUnixNano: "18446744073709551615",
                  body: { boolValue: false },
                  traceId: "0123456789abcdef0123456789abcdef",
                  spanId: "0123456789abcdef",
                  attributes: [
                    {
                      key: "nested",
                      value: {
                        kvlistValue: {
                          values: [
                            {
                              key: "x",
                              value: {
                                arrayValue: {
                                  values: [
                                    { intValue: "0" },
                                    { doubleValue: -0 },
                                  ],
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  [
    "metrics",
    {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "hist",
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        startTimeUnixNano: "1728888000123456789",
                        timeUnixNano: "1728889000123456789",
                        count: "18446744073709551615",
                        sum: 0,
                        min: 0,
                        max: 0,
                        bucketCounts: ["0", "9223372036854775808"],
                        explicitBounds: [0, 1.5],
                      },
                    ],
                  },
                },
                {
                  name: "sum",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        timeUnixNano: "1728889000123456789",
                        asInt: "-9223372036854775808",
                      },
                    ],
                  },
                },
                {
                  name: "exp",
                  exponentialHistogram: {
                    dataPoints: [
                      {
                        count: "5",
                        scale: -1,
                        zeroCount: "1",
                        positive: { offset: -2, bucketCounts: ["1", "2"] },
                        negative: { offset: 0, bucketCounts: ["1"] },
                        zeroThreshold: 0,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  [
    "traces",
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0123456789abcdef0123456789abcdef",
                  spanId: "0123456789abcdef",
                  startTimeUnixNano: "1234567890123456789",
                  endTimeUnixNano: "1234567890123456799",
                  kind: 1,
                  status: { code: 0 },
                  events: [
                    { timeUnixNano: "18446744073709551615", name: "event" },
                  ],
                  links: [
                    {
                      traceId: "ffffffffffffffffffffffffffffffff",
                      spanId: "ffffffffffffffff",
                      flags: 257,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
];
test("exact integer JSON and protobuf retain oneof/optional zero, hex IDs and nested values", () => {
  for (const [signal, obj] of samples) {
    const bytes = encodeOTLP(signal, obj),
      decoded = decodeOTLP(signal, bytes, "application/x-protobuf");
    assert.deepEqual(encodeOTLP(signal, decoded), bytes);
    assert.deepEqual(
      encodeOTLP(
        signal,
        decodeOTLP(
          signal,
          Buffer.from(JSON.stringify(obj)),
          "application/json",
        ),
      ),
      bytes,
    );
  }
});
test("three OTLP signals and receipt input hashes match Go deterministic marshal", (t) => {
  if (!existsSync(binary)) {
    t.skip("Go baseline toolchain unavailable");
    return;
  }
  for (const [signal, obj] of samples) {
    const bytes = encodeOTLP(signal, obj),
      created = "2026-10-17T10:00:00.123456789+08:00",
      result = JSON.parse(
        execFileSync(binary, {
          input: JSON.stringify({
            signal,
            data: bytes.toString("base64"),
            table: "business",
            created,
          }),
          encoding: "utf8",
        }),
      );
    assert.equal(result.error, undefined);
    assert.deepEqual(bytes, Buffer.from(result.data, "base64"));
    assert.equal(inputHash(signal, "business", created, obj), result.hash);
  }
});
test("unknown protobuf fields survive canonicalization at every message level", (t) => {
  const bytes = Buffer.from("0a0c0a0878010a040a0278797802", "hex");
  const decoded = decodeOTLP("logs", bytes, "application/x-protobuf"),
    canonical = encodeOTLP("logs", decoded);
  if (existsSync(binary)) {
    const result = JSON.parse(
      execFileSync(binary, {
        input: JSON.stringify({
          signal: "logs",
          data: bytes.toString("base64"),
          table: "business",
          created: "2026-10-17T00:00:00Z",
        }),
        encoding: "utf8",
      }),
    );
    assert.deepEqual(canonical, Buffer.from(result.data, "base64"));
  }
  assert(canonical.includes(Buffer.from("7801", "hex")));
  assert(canonical.includes(Buffer.from("7802", "hex")));
});
test("protobuf response detects explicitly present empty partialSuccess", () => {
  for (const s of ["logs", "metrics", "traces"] as Signal[]) {
    assert.deepEqual(decodeOTLPResponse(s, encodeOTLPResponse(s, {})), {});
    assert.deepEqual(
      decodeOTLPResponse(s, encodeOTLPResponse(s, { partialSuccess: {} })),
      { partialSuccess: {} },
    );
  }
});
test("JSON validation rejects unknown fields, bad IDs, unsafe/out of range integers and conflicting oneof", () => {
  for (const obj of [
    { unknown: 1 },
    { resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId: "01" }] }] }] },
    {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "x", value: { intValue: "9223372036854775808" } },
            ],
          },
        },
      ],
    },
    {
      resourceLogs: [
        {
          scopeLogs: [
            { logRecords: [{ body: { intValue: "0", stringValue: "x" } }] },
          ],
        },
      ],
    },
  ])
    assert.throws(() =>
      decodeOTLP("logs", Buffer.from(JSON.stringify(obj)), "application/json"),
    );
});
test("timestamps normalize Go RFC3339Nano without losing submillisecond precision", () => {
  assert.equal(
    formatNanoTime(parseNanoTime("2026-10-17T10:00:00.123456789+08:00")),
    "2026-10-17T02:00:00.123456789Z",
  );
  assert.equal(formatNanoTime(-1n), "1969-12-31T23:59:59.999999999Z");
  assert.equal(
    formatNanoTime(parseNanoTime("2026-10-17T00:00:00.120000000Z")),
    "2026-10-17T00:00:00.12Z",
  );
  assert.throws(() => parseNanoTime("2026-10-17"));
});
test("duplicate binary message tags merge and preserve Go canonical behavior", () => {
  const bytes = Buffer.from("0a100a060a040a0261610a060a040a026262", "hex"),
    decoded = decodeOTLP("logs", bytes, "application/x-protobuf");
  assert.deepEqual(
    decoded.resourceLogs[0].resource.attributes.map((a: any) => a.key),
    ["aa", "bb"],
  );
  if (existsSync(binary)) {
    const result = JSON.parse(
      execFileSync(binary, {
        input: JSON.stringify({
          signal: "logs",
          data: bytes.toString("base64"),
          table: "business",
          created: "2026-10-17T00:00:00Z",
        }),
        encoding: "utf8",
      }),
    );
    assert.deepEqual(
      encodeOTLP("logs", decoded),
      Buffer.from(result.data, "base64"),
    );
  }
});
test("JSON numeric exponents remain exact and unsafe JS integers are rejected", () => {
  const source =
      '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":18446744073709551615,"body":{"intValue":"9.223372036854775807e18"}}]}]}]}',
    decoded = decodeOTLP("logs", Buffer.from(source), "application/json");
  assert.equal(
    decoded.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano,
    "18446744073709551615",
  );
  assert.equal(
    decoded.resourceLogs[0].scopeLogs[0].logRecords[0].body.intValue,
    "9223372036854775807",
  );
  assert.throws(
    () =>
      encodeOTLP("logs", {
        resourceLogs: [
          { scopeLogs: [{ logRecords: [{ timeUnixNano: 9007199254740992 }] }] },
        ],
      }),
    /unsafe/,
  );
  assert.throws(() => parseNanoTime("2026-02-31T00:00:00Z"));
});
test("NaN uses Go JSON canonical bits and retains arbitrary binary payload bits", () => {
  const raw = Buffer.from(
    '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"doubleValue":"NaN"}}]}]}]}',
  );
  assert.equal(
    encodeOTLP("logs", decodeOTLP("logs", raw, "application/json")).toString(
      "hex",
    ),
    "0a0f120d120b2a0921010000000000f87f",
  );
  for (const hex of [
    "0a0f120d120b2a0921010000000000f07f",
    "0a0f120d120b2a0921ff0000000000f87f",
  ])
    assert.equal(
      encodeOTLP(
        "logs",
        decodeOTLP("logs", Buffer.from(hex, "hex"), "application/x-protobuf"),
      ).toString("hex"),
      hex,
    );
});
