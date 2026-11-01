import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  symlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createAgent, Agent } from "../src/agent/agent.js";
import {
  defaultConfig,
  normalizeRemote,
  validateRemote,
  glob,
  loadConfig,
  type Config,
} from "../src/agent/config.js";
import { Queue, type Batch } from "../src/agent/queue.js";
import { DB } from "../src/shared/sqlite.js";
import { execute } from "../src/agent/main.js";
import { checkProbe } from "../src/agent/probe.js";
import {
  decodeOTLP,
  resourceString,
  resources,
  nowNano,
  formatNanoTime,
} from "../src/shared/otlp.js";
function config(t: any, extra: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    ...defaultConfig(),
    data_dir: dir,
    endpoint: "http://127.0.0.1:1",
    control_credential: "test-control-credential",
    data_credential: "test-data-credential",
    listen: "127.0.0.1:0",
    min_free_bytes: 0,
    collect_interval_seconds: 3600,
    ...extra,
  };
}
function make(t: any, extra: Partial<Config> = {}): Agent {
  const agent = createAgent(config(t, extra));
  t.after(() => agent.close());
  return agent;
}
function batch(service = "orders", body = "hello"): Batch {
  return {
    id: randomUUID(),
    signal: "logs",
    table: "business",
    created_at: formatNanoTime(nowNano() + 123456n),
    content_type: "application/json",
    payload: Buffer.from(
      JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: service } },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "18446744073709551615",
                    body: { stringValue: body },
                    attributes: [
                      {
                        key: "large",
                        value: { intValue: "9223372036854775807" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  };
}
async function listen(agent: Agent): Promise<string> {
  const address = await agent.listen();
  return "http://127.0.0.1:" + (address as any).port;
}
async function mock(
  t: any,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {if(req.url==="/v1/center-endpoints"){res.writeHead(404);res.end();return;}void handler(req, res);});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: "http://127.0.0.1:" + (server.address() as any).port, server };
}
async function send(
  url: string,
  b: Batch,
  extra: Record<string, string> = {},
  body: Uint8Array = b.payload,
): Promise<Response> {
  return fetch(url + "/v1/" + b.signal, {
    method: "POST",
    headers: {
      "Content-Type": b.content_type,
      "X-Lightmoni-Table": b.table,
      "X-Lightmoni-Batch-ID": b.id,
      "X-Lightmoni-Batch-Created-At": b.created_at,
      ...extra,
    },
    body: new Uint8Array(body),
  });
}
function drain(agent: Agent): any[] {
  const records: any[] = [];
  for (;;) {
    const b = agent.queue.next();
    if (!b) return records;
    const msg = decodeOTLP(b.signal, b.payload, b.content_type);
    records.push(
      ...(msg.resourceLogs ?? []).flatMap((r: any) =>
        (r.scopeLogs ?? []).flatMap((s: any) => s.logRecords ?? []),
      ),
    );
    agent.queue.complete(b.id);
  }
}

test("legacy Go golden spool preserves identity, frozen bytes, retry state, exact cursors and completed receipts", async (t) => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "fixtures/go-agent-spool.json"),
      "utf8",
    ),
  );
  t.mock.method(Date, "now", () => Date.parse(fixture.generated_at));
  const cfg = config(t),
    db = new DB(join(cfg.data_dir, "queue.sqlite"));
  db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys=ON");
    for (const table of fixture.tables) db.exec(table.schema);
    for (const table of fixture.tables) {
      for (const row of table.rows) {
        const values = Object.values(row).map((v: any) =>
          v && typeof v === "object"
            ? "integer" in v
              ? BigInt(v.integer)
              : Buffer.from(v.base64, "base64")
            : v,
        );
        db.run(
          "INSERT INTO " +
            table.name +
            "(" +
            Object.keys(row).join(",") +
            ") VALUES(" +
            values.map(() => "?").join(",") +
            ")",
          ...values,
        );
      }
    }
  });
  db.close();
  writeFileSync(
    join(cfg.data_dir, "identity.json"),
    JSON.stringify(fixture.identity),
  );
  const inputs = fixture.inputs.map((v: any) => ({
    ...v,
    payload: Buffer.from(v.payload, "base64"),
  }));
  let a = createAgent(cfg);
  const old = a.queue.next()!,
    frozen = Buffer.from(old.payload);
  assert.deepEqual(a.identity, fixture.identity);
  assert.equal(old.created_at, inputs[0].created_at);
  assert.equal(old.attempts, 2);
  assert.equal(old.last_error, "upstream unavailable");
  assert.equal(
    a.queue.db.get<any>("SELECT offset FROM log_cursors")!.offset,
    "9007199254740993",
  );
  assert.deepEqual(
    a.queue.db.get<any>("SELECT prefix FROM log_cursors")!.prefix,
    Buffer.from([0, 255, 97]),
  );
  a.accept(inputs[0], true);
  a.accept(inputs[1], true);
  assert.equal(a.queue.stats().queue_batches, 1);
  assert.deepEqual(a.queue.next()!.payload, frozen);
  a.queue.complete(old.id);
  a.accept(inputs[0], true);
  assert.equal(a.queue.stats().queue_batches, 0);
  await a.close();
  a = createAgent(cfg);
  assert.deepEqual(a.identity, fixture.identity);
  for (const input of inputs) a.accept(input, true);
  assert.equal(a.queue.stats().queue_batches, 0);
  await a.close();
});

test("Agent rejects removed SDK relay routes and keeps authenticated diagnostics", async (t) => {
  const a = make(t, {local_token:"test-local-token"}), url = await listen(a);
  for(const path of ["/v1/logs","/v1/metrics","/v1/traces","/v1/sdk-config"]){
    const r=await fetch(url+path,{method:path.endsWith("sdk-config")?"GET":"POST",headers:{Authorization:"Bearer test-local-token"},body:path.endsWith("sdk-config")?undefined:"{}"});
    assert.equal(r.status,404);await r.text();
  }
  assert.equal(a.queue.stats().queue_batches,0);
  assert.equal((await fetch(url+"/healthz")).status,200);
  assert.equal((await fetch(url+"/status")).status,401);
  const status=await fetch(url+"/status",{headers:{Authorization:"Bearer test-local-token"}});assert.equal(status.status,200);
});

test("capacity and failed SQLite transactions do not acknowledge or advance log cursors", async (t) => {
  const a = make(t, { max_queue_batches: 1 }),
    url = await listen(a),
    first = batch();
  a.accept(first, true);
  const second = batch();
  assert.throws(() => a.accept(second, true), /capacity|queue/i);
  assert.equal(a.queue.stats().queue_batches, 1);
  assert.equal(a.queue.receipt(second.id), undefined);
  a.queue.complete(first.id);
  a.queue.db.exec(
    "CREATE TRIGGER reject_batches BEFORE INSERT ON batches BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;",
  );
  const failed = batch();
  assert.throws(() => a.accept(failed, true));
  assert.equal(a.queue.receipt(failed.id), undefined);
  assert.equal(a.queue.stats().queue_batches, 0);
});

test("lost upstream ACK retries exact frozen bytes; credentials pause and partial success quarantines", async (t) => {
  const seen: { id: string; body: Buffer; authorization: string }[] = [];
  let mode = "drop";
  const center = await mock(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const x of req) chunks.push(x);
    seen.push({
      id: String(req.headers["x-lightmoni-batch-id"]),
      body: Buffer.concat(chunks),
      authorization: String(req.headers.authorization),
    });
    if (mode === "drop") {
      req.socket.destroy();
      return;
    }
    if (mode === "credential") {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(mode === "partial" ? ' {"partialSuccess":{}}' : "{}");
  });
  const a = make(t, { endpoint: center.url }),
    b = batch();
  a.accept(b, true);
  const frozen = Buffer.from(a.queue.next()!.payload);
  assert((await a.forwardOnce()) > 0);
  assert.equal(a.queue.stats().queue_batches, 1);
  a.queue.db.run("UPDATE batches SET next_ns=0");
  mode = "credential";
  assert.equal(await a.forwardOnce(), 30000);
  assert.equal(a.queue.stats().quarantine_batches, 0);
  a.config.data_credential = "test-rotated-key";
  a.queue.db.run("UPDATE batches SET next_ns=0");
  mode = "ok";
  await a.forwardOnce();
  assert.equal(a.queue.stats().queue_batches, 0);
  assert.equal(seen.length, 3);
  for (const item of seen) {
    assert.equal(item.id, b.id);
    assert.deepEqual(item.body, frozen);
  }
  assert.equal(seen.at(-1)!.authorization, "Bearer test-rotated-key");
  mode = "partial";
  a.accept(batch(), true);
  await a.forwardOnce();
  assert.equal(a.queue.stats().quarantine_batches, 1);
  const quarantined = a.queue.quarantined()[0];
  a.queue.resolve(quarantined.id, false);
  assert.equal(a.queue.stats().quarantine_batches, 0);
  mode = "ok";
  await a.forwardOnce();
  assert.equal(a.queue.stats().queue_batches, 0);
});

test("directory logs keep checkpoints, rotations, UTF8 fragments and source identity across restart", async (t) => {
  const cfg = config(t),
    logs = join(cfg.data_dir, "logs");
  mkdirSync(logs);
  const path = join(logs, "app.log");
  writeFileSync(path, "before\n");
  let a = createAgent(cfg);
  const tasks = normalizeRemote({
    revision: "logs-1",
    collect_interval_seconds: 15,
    host_enabled: false,
    logs_enabled: true,
    group_id: "production",
    log_table: "directory_logs",
    log_sources: [
      {
        directory: logs,
        pattern: "*.log*",
        recursive: false,
        from_beginning: false,
      },
    ],
  });
  a.applyRemote(tasks);
  a.files.poll(tasks);
  assert.equal(a.queue.stats().queue_batches, 0);
  appendFileSync(path, "one\npartial");
  a.files.poll(tasks);
  let rows = drain(a);
  assert.deepEqual(
    rows.map((r) => r.body.stringValue),
    ["one"],
  );
  const identity = a.identity;
  await a.close();
  appendFileSync(path, " done\n");
  a = createAgent(cfg);
  assert.deepEqual(a.identity, identity);
  a.files.poll(tasks);
  rows = drain(a);
  assert.deepEqual(
    rows.map((r) => r.body.stringValue),
    ["partial done"],
  );
  renameSync(path, path + ".1");
  writeFileSync(path, "replacement\n");
  appendFileSync(path + ".1", "old descriptor\n");
  writeFileSync(join(logs, "skip.log.gz"), "compressed\n");
  symlinkSync(path, join(logs, "symlink.log"));
  a.files.poll(tasks);
  rows = drain(a);
  assert.deepEqual(rows.map((r) => r.body.stringValue).sort(), [
    "old descriptor",
    "replacement",
  ]);
  writeFileSync(path, "truncate\n");
  a.files.poll(tasks);
  assert.deepEqual(
    drain(a).map((r) => r.body.stringValue),
    ["truncate"],
  );
  appendFileSync(path, "你".repeat(30000) + "\n");
  a.files.poll(tasks);
  a.files.poll(tasks);
  rows = drain(a);
  assert.equal(
    rows.map((r) => r.body.stringValue).join(""),
    "你".repeat(30000),
  );
  assert(
    rows.some((r) => r.attributes.some((v: any) => v.key === "log_fragment")),
  );
  for (const r of rows) {
    assert.equal(r.timeUnixNano, undefined);
    assert(r.observedTimeUnixNano);
    assert(!r.body.stringValue.includes("�"));
  }
  await a.close();
});

test("file log checkpoint and queue commit together under storage failure", async (t) => {
  const a = make(t),
    logs = join(a.config.data_dir, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "app.log"), "one\n");
  const tasks = normalizeRemote({
    revision: "logs",
    collect_interval_seconds: 15,
    host_enabled: false,
    logs_enabled: true,
    log_sources: [
      {
        directory: logs,
        pattern: "*.log",
        recursive: false,
        from_beginning: true,
      },
    ],
  });
  a.queue.db.exec(
    "CREATE TRIGGER reject_batches BEFORE INSERT ON batches BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;",
  );
  assert.throws(() => a.files.poll(tasks));
  assert.equal(
    a.queue.db.get<any>("SELECT offset FROM log_cursors")!.offset,
    0,
  );
  assert.equal(a.queue.stats().receipts, 0);
  a.queue.db.exec("DROP TRIGGER reject_batches");
  a.files.poll(tasks);
  assert.deepEqual(
    drain(a).map((r) => r.body.stringValue),
    ["one"],
  );
});

test("control registers, acknowledges runtime events and persists tasks for offline recovery", async (t) => {
  const calls: string[] = [];
  const remote = normalizeRemote({
    revision: "remote-1",
    collect_interval_seconds: 3,
    host_enabled: false,
    host_collectors: [],
    probes: [],
  });
  const center = await mock(t, (req, res) => {
    calls.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer test-control-credential");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.method === "GET" ? JSON.stringify(remote) : "{}");
  });
  const cfg = config(t, { endpoint: center.url });
  let a = createAgent(cfg);
  const registered = await a.controlOnce(false);
  assert.equal(registered, true);
  assert.equal(a.revision, "remote-1");
  assert.equal(a.tasksReady, true);
  assert.equal(a.runtimeEvents.length, 1);
  assert.deepEqual(calls, [
    "/api/v1/agents/register",
    "/api/v1/agents/" + a.identity.agent_id + "/heartbeat",
    "/api/v1/agents/" + a.identity.agent_id + "/config",
  ]);
  assert.equal(
    JSON.parse(readFileSync(join(cfg.data_dir, "remote-config.json"), "utf8"))
      .revision,
    "remote-1",
  );
  assert.throws(() =>
    a.applyRemote({ ...remote, collect_interval_seconds: 0 }),
  );
  assert.equal(a.revision, "remote-1");
  await a.close();
  a = createAgent(cfg);
  a.applyRemote(
    JSON.parse(readFileSync(join(cfg.data_dir, "remote-config.json"), "utf8")),
    false,
  );
  assert.equal(a.revision, "remote-1");
  await a.close();
});

test("real host collection uses TS SDK and selected destination; HTTP/TCP probes report actual outcomes", async (t) => {
  const a = make(t);
  a.applyRemote({
    revision: "host-1",
    collect_interval_seconds: 15,
    host_table: "machine",
    host_collectors: ["memory", "system"],
  });
  await a.collectOnce();
  const q = a.queue.next()!;
  assert.equal(q.table, "host");
  const msg = decodeOTLP("metrics", q.payload, q.content_type),
    names = msg.resourceMetrics.flatMap((r: any) =>
      r.scopeMetrics.flatMap((s: any) => s.metrics.map((m: any) => m.name)),
    );
  assert(names.includes("host.memory.total"));
  assert(names.includes("host.uptime"));
  assert(!names.includes("host.cpu.utilization"));
  const center = await mock(t, (_req, res) => {
      res.writeHead(204);
      res.end();
    }),
    port = Number(new URL(center.url).port);
  assert.equal(
    (
      await checkProbe({
        id: "http",
        kind: "http",
        target: center.url,
        interval_seconds: 1,
        timeout_ms: 1000,
      })
    ).success,
    true,
  );
  assert.equal(
    (
      await checkProbe({
        id: "http",
        kind: "http",
        target: center.url,
        interval_seconds: 1,
        timeout_ms: 1000,
        expected_status: [200],
      })
    ).reason,
    "unexpected_status",
  );
  assert.equal(
    (
      await checkProbe({
        id: "tcp",
        kind: "tcp",
        target: "127.0.0.1:" + port,
        interval_seconds: 1,
        timeout_ms: 1000,
      })
    ).success,
    true,
  );
  assert.equal(
    (
      await checkProbe({
        id: "tcp",
        kind: "tcp",
        target: "127.0.0.1:1",
        interval_seconds: 1,
        timeout_ms: 1000,
      })
    ).reason,
    "connection",
  );
});

test("CLI config preserves identity/spool, protects files and requires explicit quarantine discard", async (t) => {
  const cfg = config(t),
    path = join(cfg.data_dir, "config.json");
  writeFileSync(path, JSON.stringify(cfg));
  const output: string[] = [],
    io = {
      input: (async function* () {
        throw Error("configure must not consume a shared key from stdin");
      })(),
      write: (s: string) => output.push(s),
    };
  await execute(
    [
      "configure",
      "--config",
      path,
      "--endpoint",
      cfg.endpoint,
      "--group-id",
      "production",
      "--require-data-dir",
      cfg.data_dir,
    ],
    io,
  );
  assert.equal(loadConfig(path).control_credential, "test-control-credential");
  assert.equal(loadConfig(path).data_credential, "test-data-credential");
  assert.equal(Object.hasOwn(loadConfig(path), "key"), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const a = createAgent(loadConfig(path)),
    id = a.identity.agent_id,
    b = batch();
  a.accept(b, true);
  a.queue.quarantine(b.id, "rejected");
  await a.close();
  await execute(["configure", "--config", path, "--group-id", "updated"], io);
  assert.equal(
    JSON.parse(readFileSync(join(cfg.data_dir, "identity.json"), "utf8"))
      .agent_id,
    id,
  );
  await execute(
    ["check", "--config", path, "--require-data-dir", cfg.data_dir],
    io,
  );
  await assert.rejects(
    () =>
      execute(
        ["quarantine", "--config", path, "--action", "discard", "--id", b.id],
        io,
      ),
    /confirm-data-loss/,
  );
  await execute(
    [
      "quarantine",
      "--config",
      path,
      "--action",
      "discard",
      "--id",
      b.id,
      "--confirm-data-loss",
    ],
    io,
  );
  const queue = new Queue(loadConfig(path));
  assert.equal(queue.stats().queue_batches, 0);
  assert.equal(
    queue.db.get<any>("SELECT action FROM queue_actions")!.action,
    "discard",
  );
  queue.close();
});

test("remote task validation and Go glob semantics reject malformed and reserved configurations", () => {
  assert.equal(normalizeRemote({}).collect_interval_seconds, 0);
  assert.equal(
    normalizeRemote({ host_table: "", probe_table: "", log_table: "" })
      .host_table,
    "host",
  );
  assert(glob("worker[0-9]?").test("worker12"));
  assert(glob("[^a]*").test("worker"));
  assert(!glob("*").test("path/name"));
  assert.throws(() => glob("["));
  assert.equal(normalizeRemote({host_table:"lightmoni_sdk",probe_table:"custom",log_table:"custom"}).host_table,"host");
  assert.throws(() => validateRemote({...normalizeRemote({revision:"x",collect_interval_seconds:15}),host_table:"lightmoni_sdk"}));
  assert.throws(() =>
    validateRemote(
      normalizeRemote({
        revision: "x",
        collect_interval_seconds: 15,
        host_collectors: ["process"],
        process_names: [],
      }),
    ),
  );
});
test("running Agent waits for assigned tasks, withdraws probes/logs and stops independently", async (t) => {
  let probes = 0;
  const signals: string[] = [];
  const center = await mock(t, async (req, res) => {
    if (req.url === "/probe") {
      probes++;
      res.end("ok");
      return;
    }
    if (req.url?.startsWith("/v1/")) {
      for await (const _ of req) {
      }
      signals.push(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(304);
      res.end();
      return;
    }
    for await (const _ of req) {
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const a = make(t, {
      endpoint: center.url,
      collect_interval_seconds: 1,
      control_interval_seconds: 1,
    }),
    logs = join(a.config.data_dir, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "app.log"), "first\n");
  await a.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(a.tasksReady, false);
  assert.equal(a.queue.stats().queue_batches, 0);
  assert.equal(signals.length, 0);
  a.applyRemote({
    revision: "assigned",
    collect_interval_seconds: 1,
    host_enabled: false,
    host_collectors: [],
    logs_enabled: true,
    log_sources: [
      {
        directory: logs,
        pattern: "*.log",
        recursive: false,
        from_beginning: true,
      },
    ],
    probes: [
      {
        id: "http",
        kind: "http",
        target: center.url + "/probe",
        interval_seconds: 1,
        timeout_ms: 300,
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  // A loaded event loop can legitimately run more than one one-second probe
  // before this timer resumes. Withdrawal must stop subsequent probes.
  assert(probes >= 1);
  const probesBeforeWithdrawal = probes;
  assert.equal(a.files.files.size, 1);
  appendFileSync(join(logs, "app.log"), "after withdrawal\n");
  a.applyRemote({
    revision: "withdrawn",
    collect_interval_seconds: 1,
    host_enabled: false,
    host_collectors: [],
    logs_enabled: false,
    probes: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(probes, probesBeforeWithdrawal);
  assert.equal(a.files.files.size, 0);
  assert(signals.includes("/v1/logs"));
  assert(signals.includes("/v1/metrics"));
  await a.close();
  assert.equal(a.server?.listening, false);
});


test("ordinary Agent heartbeat does not advertise privileged daemon access",async t=>{
  const agent=make(t);
  assert.equal("docker_capabilities" in agent.status(),false);
  assert.equal("docker_inventory" in agent.status(),false);
});
