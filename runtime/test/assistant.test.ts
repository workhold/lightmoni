import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { parseJSON } from "../src/shared/json.js";
import type { Dependencies } from "../src/shared/types.js";
import {
  registerAssistant,
  type AssistantOptions,
  type Runtime,
} from "../src/assistant/index.js";
import {
  CHAT,
  GOOGLE,
  ANTHROPIC,
  RESPONSES,
  canonicalBase,
  protocolBase,
} from "../src/assistant/provider.js";
import {
  Store,
  Recorder,
  identity,
  report,
  window as usageWindow,
  billingKey,
  decode,
} from "../src/assistant/usage.js";
import { monitoringTools } from "../src/assistant/tools.js";
import {
  worker,
  validateMetadata,
  RuntimeError,
} from "../src/assistant/worker.js";
const at = new Date("2026-10-17T03:00:00.000Z"),
  master = Buffer.alloc(32, 7),
  config = {
    base_url: "http://127.0.0.1:9999/v1",
    protocol: CHAT,
    model: "fixture",
    api_key: "fixture-secret-only",
    enabled: true,
  };
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function fixture(
  t: any,
  options: AssistantOptions = {},
  prepare?: (db: DB) => void,
) {
  const db = new DB(":memory:");
  prepare?.(db);
  const router = new Router(),
    encryption = cipher(master),
    user = { id: "alice", name: "Alice", role: "admin" },
    deps = {
      db,
      router,
      ...encryption,
      now: () => new Date(at),
      auth: {
        master,
        user: () => user,
        requireAdmin: () => {},
        validateKey: () => {
          throw Error("unused");
        },
      },
      cat: {
        list: async () => [
          {
            id: "logs",
            name: "log_app",
            kind: "log",
            columns: [{ name: "body", type: "String" }],
            services: ["app"],
          },
        ],
      },
      query: async () => ({
        request_id: "test",
        results: [
          {
            refId: "A",
            status: "success",
            complete: true,
            truncated: false,
            elapsed_ms: 0,
            frames: [
              {
                columns: [{ name: "body", type: "String" }],
                rows: Array.from({ length: 1002 }, (_, i) => [i]),
              },
            ],
          },
        ],
      }),
      referencedTables: async () => [],
      logger: { info() {}, warn() {}, error() {} },
      externalURL: "",
    } as unknown as Dependencies;
  router.auth = deps.auth;
  const module = registerAssistant(deps, options);
  await module.start?.();
  const server = createServer(async (req, res) => {
      if (!(await router.handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    }),
    url = await listen(server);
  t.after(async () => {
    await module.close?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
  const request = async (path: string, method = "GET", body?: any) => {
    const response = await fetch(url + "/api/v1/assistant" + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let data: any;
    try {
      data = parseJSON(raw);
    } catch {
      data = raw;
    }
    return { status: response.status, data, raw };
  };
  return { db, deps, router, user, request, url };
}
async function configure(f: any, cfg: any = config) {
  const result = await f.request("/config", "PUT", cfg);
  assert.equal(result.status, 200, result.raw);
  return result.data;
}
async function session(f: any) {
  const result = await f.request("/sessions", "POST", { title: "fixture" });
  assert.equal(result.status, 201, result.raw);
  return result.data.id;
}

test("assistant encrypted legacy config survives startup, key binds exact base, admin and strict fields", async (t) => {
  const f = await fixture(t, {}, (db) => {
    db.exec(
      "CREATE TABLE assistant_records(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    db.run(
      "INSERT INTO assistant_records VALUES(?,?)",
      "config",
      Buffer.from(
        JSON.stringify({
          ...config,
          api_key: cipher(master).encrypt(config.api_key),
        }),
      ),
    );
  });
  const view = await f.request("/config");
  assert.equal(view.data.has_key, true);
  assert.ok(!view.raw.includes(config.api_key));
  const preserved = await configure(f, { ...config, api_key: "" });
  assert.equal(preserved.has_key, true);
  assert.equal(
    (
      await f.request("/config", "PUT", {
        ...config,
        base_url: "https://other.invalid/v1",
        api_key: "",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/config", "PUT", {
        ...config,
        api_key: "",
        unexpected: true,
      })
    ).status,
    400,
  );
  f.user.role = "member";
  assert.equal((await f.request("/config", "PUT", config)).status, 403);
  assert.equal(
    (
      await f.request("/models", "POST", {
        base_url: "https://unreachable.invalid",
      })
    ).status,
    403,
  );
  assert.equal((await f.request("/usage")).status, 403);
  assert.equal((await f.request("/billing")).status, 403);
});
test("canonical base and protocol repair preserve tenant escapes and stored identity", () => {
  assert.equal(
    canonicalBase(
      "HTTPS://EXAMPLE.COM:443/tenant%2Falpha/v1/chat/completions/",
    ),
    "https://example.com/tenant%2Falpha/v1",
  );
  assert.equal(
    protocolBase("https://example.com/tenant/v1beta/messages", ANTHROPIC),
    "https://example.com/tenant/v1",
  );
  assert.equal(
    protocolBase("https://example.com/tenant%2Fv1beta", CHAT),
    "https://example.com/tenant%2Fv1beta",
  );
  assert.equal(
    canonicalBase("https://example.com/messages", false),
    "https://example.com/messages",
  );
  for (const url of [
    "http://user:secret@example.com",
    "https://example.com?",
    "https://example.com/#x",
    "file:///tmp/a",
    "https://example.com/\n",
  ])
    assert.throws(() => canonicalBase(url));
});
test("model discovery uses bounded fresh-root profiles, saved key exact binding and sanitized error", async (t) => {
  const requests: any[] = [];
  const supplier = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { id: "z" },
            { id: "a" },
            { id: "a" },
            { id: "fixture-secret-only" },
          ],
        }),
      );
    } else {
      res.writeHead(404);
      res.end("do not expose fixture-secret-only");
    }
  });
  const base = await listen(supplier);
  t.after(() => {
    supplier.closeAllConnections();
    supplier.close();
  });
  const f = await fixture(t);
  const r = await f.request("/models", "POST", {
    base_url: base,
    api_key: config.api_key,
    protocol: "auto",
  });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.base_url, base + "/v1");
  assert.deepEqual(r.data.protocol_options, [CHAT, RESPONSES]);
  assert.equal(r.data.requires_confirmation, true);
  assert.deepEqual(r.data.models, [{ id: "a" }, { id: "z" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, "Bearer " + config.api_key);
  await configure(f, { ...config, base_url: base });
  requests.length = 0;
  const saved = await f.request("/models", "POST", {
    base_url: base + "/v1",
    use_saved_key: true,
    protocol: CHAT,
  });
  assert.equal(saved.status, 400);
  assert.equal(saved.data.code, "saved_key_mismatch");
  assert.equal(requests.length, 0);
  const noFallback = await f.request("/models", "POST", {
    base_url: base,
    use_saved_key: true,
    protocol: CHAT,
  });
  assert.equal(noFallback.status, 502);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/models");
  assert.ok(!noFallback.raw.includes(config.api_key));
});
test("real Node worker streams tools, persists private host history and reports immutable usage", async (t) => {
  let calls = 0;
  const requests: any[] = [];
  const supplier = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    assert.equal(req.headers.authorization, "Bearer " + config.api_key);
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta =
      calls === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "fixture-call",
                type: "function",
                function: { name: "list_tables", arguments: "{}" },
              },
            ],
          }
        : { content: "已检查数据表" };
    res.write(
      "data: " +
        JSON.stringify({
          id: "fixture",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        "\n\n",
    );
    res.end(
      "data: " +
        JSON.stringify({
          id: "fixture",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: calls === 1 ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const base = await listen(supplier);
  t.after(() => {
    supplier.closeAllConnections();
    supplier.close();
  });
  const f = await fixture(t, {
    runtime: worker(process.execPath, resolve("../ai-runtime/dist/runner.js")),
  });
  await configure(f, { ...config, base_url: base + "/v1" });
  const b = (await f.request("/billing")).data;
  assert.equal(
    (
      await f.request("/billing", "PUT", {
        ...b,
        input_price_per_million: 1,
        output_price_per_million: 2,
      })
    ).status,
    200,
  );
  const sid = await session(f),
    r = await f.request("/sessions/" + sid + "/turns", "POST", {
      text: "检查数据表",
    });
  assert.equal(r.status, 200, r.raw);
  assert.match(r.raw, /turn.completed/);
  assert.match(r.raw, /已检查数据表/);
  assert.ok(!r.raw.includes(config.api_key));
  assert.equal(calls, 2);
  assert.ok(JSON.stringify(requests[1]).includes("log_app"));
  const s = (await f.request("/sessions/" + sid)).data;
  assert.ok(
    s.messages.some(
      (m: any) => m.role === "tool" && m.content.includes("log_app"),
    ),
  );
  const usage = (await f.request("/usage")).data;
  assert.equal(usage.totals.requests, 2);
  assert.equal(usage.totals.succeeded_requests, 2);
  assert.equal(usage.totals.total_tokens, 100);
  const details = (await f.request("/usage/details")).data;
  assert.equal(details.records[0].input_price_per_million, 1);
  assert.equal(details.records[0].cost_status, "complete");
  await f.request("/billing", "PUT", {
    ...b,
    input_price_per_million: 50,
    output_price_per_million: 50,
  });
  assert.equal(
    (await f.request("/usage/details")).data.records[0].input_price_per_million,
    1,
  );
});
test("private continuation metadata is stored, cleaned from public session and reused next turn", async (t) => {
  const inputs: any[] = [];
  const runtime: Runtime = async (input, _signal, _tool, emit) => {
    inputs.push(input);
    await emit({
      type: "checkpoint",
      messages: [
        {
          role: "assistant",
          content: "answer",
          provider_state: [
            {
              type: "reasoning",
              provider_options: {
                openai: { reasoningEncryptedContent: "opaque-private" },
              },
            },
            {
              type: "text",
              text: "answer",
              provider_options: { openai: { itemId: "item-1" } },
            },
          ],
        },
      ],
    });
    await emit({
      type: "event",
      name: "assistant.message",
      data: { text: "answer" },
    });
  };
  const f = await fixture(t, { runtime });
  await configure(f);
  const sid = await session(f);
  await f.request("/sessions/" + sid + "/turns", "POST", { text: "first" });
  const publicValue = await f.request("/sessions/" + sid);
  assert.ok(!publicValue.raw.includes("opaque-private"));
  assert.ok(!publicValue.raw.includes("provider_state"));
  await f.request("/sessions/" + sid + "/turns", "POST", { text: "second" });
  assert.ok(JSON.stringify(inputs[1].messages).includes("opaque-private"));
  const row = f.db.get<any>(
    "SELECT value FROM assistant_records WHERE id=?",
    "session/alice/" + sid,
  );
  assert.ok(Buffer.from(row.value).toString().includes("opaque-private"));
  f.user.id = "bob";
  assert.equal((await f.request("/sessions/" + sid)).status, 404);
  assert.deepEqual((await f.request("/sessions")).data.items, []);
});
test("credential echo is rejected before public SSE, summary and checkpoint commit", async (t) => {
  for (const frame of [
    { type: "event", name: "assistant.delta", data: { text: config.api_key } },
    {
      type: "checkpoint",
      messages: [{ role: "assistant", content: config.api_key }],
    },
    { type: "compacted", summary: config.api_key, through: 1 },
  ]) {
    const f = await fixture(t, {
      runtime: async (_input, _signal, _tool, emit) => {
        await emit(frame);
      },
    });
    await configure(f);
    const sid = await session(f),
      r = await f.request("/sessions/" + sid + "/turns", "POST", {
        text: "first",
      });
    assert.match(r.raw, /turn.failed/);
    assert.ok(!r.raw.includes(config.api_key));
    assert.ok(
      !(await f.request("/sessions/" + sid)).raw.includes(config.api_key),
    );
  }
  assert.throws(
    () =>
      validateMetadata([
        {
          role: "assistant",
          content: "",
          provider_state: [
            { type: "reasoning", text: "private chain", provider_options: {} },
          ],
        },
      ]),
    /plaintext/,
  );
});
test("concurrent turn rejects, cancellation releases slot and accounts unknown consumption", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const runtime: Runtime = async (_input, signal, _tool, emit) => {
    await emit({
      type: "event",
      name: "model.request.started",
      data: { request_id: "request-1", phase: "execute" },
    });
    entered();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
  };
  const f = await fixture(t, { runtime });
  await configure(f);
  const sid = await session(f),
    turn = f.request("/sessions/" + sid + "/turns", "POST", { text: "wait" });
  await started;
  assert.equal(
    (await f.request("/sessions/" + sid + "/turns", "POST", { text: "second" }))
      .status,
    409,
  );
  assert.equal(
    (await f.request("/sessions/" + sid + "/cancel", "POST", {})).data
      .cancelled,
    true,
  );
  assert.match((await turn).raw, /turn.cancelled/);
  assert.equal(
    (await f.request("/sessions/" + sid + "/cancel", "POST", {})).data
      .cancelled,
    false,
  );
  const records = (await f.request("/usage/details")).data.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "cancelled");
  assert.equal(records[0].input_tokens, null);
  assert.equal(records[0].estimated_cost, null);
});
test("startup backfills all retained Go session usage, leaves terminal bytes and recovers pending once", () => {
  const db = new DB(":memory:"),
    store = new Store(db, () => at);
  try {
    const billing = identity(config),
      recorder = new Recorder(
        store,
        "assistant",
        "alice",
        "session",
        "turn",
        billing,
      );
    recorder.record({
      sequence: 0,
      session_id: "session",
      turn_id: "turn",
      timestamp: "2026-10-17T03:00:00.123456789Z",
      type: "model.request.started",
      data: { request_id: "request-1" },
    });
    const terminal = JSON.stringify({
      id: "immutable",
      timestamp: "2026-10-17T03:00:00Z",
      status: "succeeded",
      custom_legacy_field: "preserved",
      input_tokens: 9007199254740993,
    });
    db.run(
      "INSERT INTO assistant_usage VALUES(?,?,?,?)",
      "immutable",
      Math.floor(at.getTime() / 1000),
      0,
      Buffer.from(terminal),
    );
    for (let n = 0; n < 205; n++)
      store.put("session/alice/legacy-" + n, {
        id: "legacy-" + n,
        user_id: "alice",
        created_at: "2026-10-16T03:00:00Z",
        updated_at: "2026-10-16T03:00:00Z",
        messages: [],
        events: [
          {
            sequence: 1,
            session_id: "legacy-" + n,
            turn_id: "old",
            type: "turn.usage",
            timestamp: "2026-10-16T03:00:00Z",
            data: {
              input_tokens: 2,
              output_tokens: 3,
              estimated_cost: 0,
              currency: "USD",
            },
          },
        ],
      });
    store.recover();
    store.recover();
    const rows = store.list("", "");
    assert.equal(rows.length, 207);
    const pending = rows.find((r) => r.request_id === "request-1")!;
    assert.equal(pending.status, "failed");
    assert.equal(pending.failure_reason, "service_interrupted");
    assert.equal(pending.timestamp, "2026-10-17T03:00:00.123456789Z");
    assert.equal(
      Buffer.from(
        db.get<any>("SELECT value FROM assistant_usage WHERE id=?", "immutable")
          .value,
      ).toString(),
      terminal,
    );
    assert.equal(rows.filter((r) => r.id.includes("legacy-")).length, 205);
    assert.equal(
      String(
        decode(Buffer.from('{"input_tokens":9007199254740993}')).input_tokens,
      ),
      "9007199254740993",
    );
  } finally {
    db.close();
  }
});
test("ledger terminal snapshot keeps original rates and unknown/free/partial costs distinct", () => {
  const db = new DB(":memory:"),
    store = new Store(db, () => at);
  try {
    const billing = {
        ...identity(config),
        input_price_per_million: 0,
        output_price_per_million: 2,
      },
      recorder = new Recorder(store, "assistant", "alice", "s", "t", billing),
      event = {
        sequence: 0,
        session_id: "s",
        turn_id: "t",
        timestamp: at.toISOString(),
        type: "model.request.started",
        data: { request_id: "request-1", phase: "execute" },
      };
    recorder.record(event);
    recorder.record({
      ...event,
      type: "turn.usage",
      data: { request_id: "request-1", status: "succeeded", input_tokens: 100 },
    });
    recorder.record({
      ...event,
      type: "turn.usage",
      data: { request_id: "request-1", status: "failed", output_tokens: 100 },
    });
    const [record] = store.list("", "");
    assert.equal(record.status, "succeeded");
    assert.equal(record.input_tokens, 100);
    assert.equal(record.output_tokens, null);
    assert.equal(record.input_estimated_cost, 0);
    assert.equal(record.estimated_cost, 0);
    assert.equal(record.cost_status, "partial");
    const usage = report([record], at, 7, "Asia/Shanghai");
    assert.equal(usage.totals.partial_priced_requests, 1);
    assert.equal(usage.totals.unpriced_requests, 0);
    assert.equal(usage.totals.output_missing, 1);
    assert.equal(usage.totals.estimated_costs[0].partial_requests, 1);
    assert.equal(billingKey(billing).length, 72);
  } finally {
    db.close();
  }
});
test("calendar usage window respects DST and unknown historical int64 stays exact", () => {
  const bounds = usageWindow(
    new Date("2026-03-09T12:00:00Z"),
    7,
    "America/New_York",
  );
  assert.equal((Date.parse(bounds.to) - Date.parse(bounds.from)) / 36e5, 167);
  assert.equal(bounds.dates.length, 7);
  const r = decode(
    Buffer.from(
      '{"id":"legacy","timestamp":"2026-10-17T03:00:00Z","source":"assistant","base_url":"a","protocol":"p","model":"m","input_tokens":9007199254740993,"output_tokens":null,"total_tokens":null,"estimated_cost":null}',
    ),
  );
  const usage = report([r], at, 7, "UTC");
  assert.equal(String(usage.totals.input_tokens), "9007199254740993");
});
test("monitoring tools use shared bounded queries, accurate failures and review-only drafts", async (t) => {
  const f = await fixture(t),
    tools = monitoringTools(f.deps),
    run = tools.find((t) => t.name === "run_query")!;
  const result = await run.execute(
    {
      sql: "SELECT body FROM log_app WHERE $__timeFilter(event_time)",
      range: { from: "2026-10-16T00:00:00Z", to: "2026-10-17T00:00:00Z" },
      interval_ms: 1000,
    },
    new AbortController().signal,
  );
  assert.equal(result.sample_limit, 1000);
  assert.equal(result.sample_truncated, true);
  assert.equal(result.query.results[0].frames[0].rows.length, 1000);
  f.deps.query = async () => ({
    request_id: "x",
    results: [
      {
        refId: "A",
        status: "error",
        complete: false,
        truncated: false,
        frames: [],
        elapsed_ms: 0,
        error: "fixture query error",
      },
    ],
  });
  await assert.rejects(
    run.execute(
      {
        sql: "SELECT body FROM log_app",
        range: { from: "2026-10-16T00:00:00Z", to: "2026-10-17T00:00:00Z" },
        interval_ms: 1000,
      },
      new AbortController().signal,
    ),
    /fixture query error/,
  );
  const draft = await tools
    .find((t) => t.name === "draft_dashboard")!
    .execute(
      {
        title: "test",
        panels: [
          {
            title: "logs",
            type: "table",
            queries: [{ refId: "A", sql: "SELECT body FROM log_app" }],
          },
        ],
      },
      new AbortController().signal,
    );
  assert.equal(draft.saved, false);
  assert.equal(draft.requires_review, true);
  assert.ok(draft.draft.panels[0].id);
});
test("connection probe uses one fixed budget and preserves failed usage without changing config or sessions", async (t) => {
  const inputs: any[] = [];
  const f = await fixture(t, {
    runtime: async (input, _signal, _tool, emit) => {
      inputs.push(input);
      await emit({
        type: "event",
        name: "model.request.started",
        data: { request_id: "request-1", phase: "execute" },
      });
      await emit({
        type: "event",
        name: "turn.usage",
        data: { request_id: "request-1", status: "failed", input_tokens: 10 },
      });
      throw Error("private provider fixture-secret-only");
    },
  });
  await configure(f);
  const original = Buffer.from(
    f.db.get<any>("SELECT value FROM assistant_records WHERE id=?", "config")
      .value,
  ).toString();
  const result = await f.request("/test-connection", "POST", {
    base_url: config.base_url,
    protocol: CHAT,
    model: "probe",
    use_saved_key: true,
  });
  assert.equal(result.status, 502);
  assert.equal(result.data.code, "provider_unavailable");
  assert.ok(!result.raw.includes("private provider"));
  assert.equal(inputs[0].connection_test, true);
  assert.deepEqual(inputs[0].tools, []);
  assert.equal(inputs[0].config.api_key, config.api_key);
  assert.equal(inputs[0].config.max_output_tokens, 256);
  assert.equal(inputs[0].config.max_steps, 1);
  assert.equal((await f.request("/sessions")).data.items.length, 0);
  assert.equal(
    Buffer.from(
      f.db.get<any>("SELECT value FROM assistant_records WHERE id=?", "config")
        .value,
    ).toString(),
    original,
  );
  const details = (await f.request("/usage/details")).data;
  assert.equal(details.records[0].source, "connection-test");
  assert.equal(details.records[0].status, "failed");
  assert.equal(details.records[0].input_tokens, 10);
  assert.equal(details.records[0].output_tokens, null);
});
test("connection probe distinguishes test budget, output limit and timeout with sanitized codes", async (t) => {
  for (const code of [
    "test_budget_exceeded",
    "output_limit",
    "provider_error",
  ]) {
    const f = await fixture(t, {
      runtime: async () => {
        throw new RuntimeError(code);
      },
    });
    const result = await f.request("/test-connection", "POST", {
      base_url: config.base_url,
      protocol: CHAT,
      model: "fixture",
    });
    assert.equal(result.status, code === "test_budget_exceeded" ? 422 : 502);
    assert.equal(
      result.data.code,
      code === "provider_error" ? "provider_unavailable" : code,
    );
  }
  const f = await fixture(t, {
    connectionTimeout: 20,
    runtime: async (_input, signal) => {
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  const result = await f.request("/test-connection", "POST", {
    base_url: config.base_url,
    protocol: CHAT,
    model: "fixture",
  });
  assert.equal(result.status, 504);
  assert.equal(result.data.code, "timeout");
});
test("automatic model discovery exhausts exactly seven catalog candidates and never returns provider body", async (t) => {
  const paths: string[] = [];
  const supplier = createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(401);
      res.end("private supplier secret");
    }),
    base = await listen(supplier);
  t.after(() => {
    supplier.closeAllConnections();
    supplier.close();
  });
  const f = await fixture(t);
  const result = await f.request("/models", "POST", {
    base_url: base,
    api_key: "fixture-key",
    protocol: "auto",
  });
  assert.equal(result.status, 502);
  assert.equal(result.data.code, "credentials_rejected");
  assert.equal(paths.length, 7);
  assert.deepEqual(
    paths.map((p) => p.split("?")[0]),
    [
      "/v1/models",
      "/models",
      "/v1/models",
      "/models",
      "/v1/models",
      "/v1beta/models",
      "/models",
    ],
  );
  assert.ok(!result.raw.includes("private supplier"));
});
test("native model directories use protocol headers, Google generation filtering and pagination", async (t) => {
  for (const protocol of [ANTHROPIC, GOOGLE]) {
    const paths: any[] = [];
    const supplier = createServer((req, res) => {
        paths.push({ url: req.url, headers: req.headers });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            protocol === GOOGLE
              ? {
                  models: [
                    {
                      name: "models/generate",
                      supportedGenerationMethods: ["generateContent"],
                    },
                    {
                      name: "models/embed",
                      supportedGenerationMethods: ["embedContent"],
                    },
                  ],
                  nextPageToken: "next",
                }
              : { data: [{ id: "claude-fixture" }], has_more: true },
          ),
        );
      }),
      base = await listen(supplier);
    t.after(() => {
      supplier.closeAllConnections();
      supplier.close();
    });
    const f = await fixture(t),
      result = await f.request("/models", "POST", {
        base_url: base,
        api_key: "native-key",
        protocol,
      });
    assert.equal(result.status, 200, result.raw);
    assert.equal(result.data.truncated, true);
    assert.equal(result.data.protocol, protocol);
    assert.equal(
      paths[0].headers[protocol === GOOGLE ? "x-goog-api-key" : "x-api-key"],
      "native-key",
    );
    assert.equal(paths[0].headers.authorization, undefined);
    assert.deepEqual(result.data.models, [
      { id: protocol === GOOGLE ? "generate" : "claude-fixture" },
    ]);
  }
});

test("code capability is opt-in, admin-only and binds the user workspace before executing the tool", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(resolve(tmpdir(), "lightmoni-code-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disabled = await fixture(t);
  assert.equal(
    (await disabled.request("/config")).data.code_tasks_enabled,
    false,
  );
  assert.equal(
    (
      await disabled.request("/code-tasks", "POST", {
        task: "inspect",
        workspace: ".",
      })
    ).status,
    503,
  );
  let observed: any,
    offered: string[] = [];
  const f = await fixture(t, {
    codeWorkspaceRoot: root,
    tools: [
      {
        name: "code_task",
        effect: "code",
        schema: { type: "object" },
        description: "fixture",
        execute: async (input) => {
          observed = input;
          return { status: "completed" };
        },
      },
    ],
    runtime: async (input, _signal, call) => {
      offered = input.tools.map((tool) => tool.name);
      if (offered.includes("code_task"))
        await call!("code_task", {
          task: "inspect files",
          workspace: "model-picked-wrong-directory",
        });
    },
  });
  await configure(f);
  assert.equal((await f.request("/config")).data.code_tasks_enabled, true);
  const s = await session(f);
  assert.equal(
    (
      await f.request(`/sessions/${s}/turns`, "POST", {
        text: "inspect",
        context: { code_workspace: "chosen-by-admin" },
      })
    ).status,
    200,
  );
  assert.equal(observed.workspace, "chosen-by-admin");
  assert.equal(
    (
      await f.request("/code-tasks", "POST", {
        task: "inspect",
        workspace: ".",
        max_steps: 0,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/code-tasks", "POST", {
        task: "inspect",
        workspace: ".",
        timeout_ms: 999999,
      })
    ).status,
    400,
  );
  f.user.role = "member";
  assert.equal((await f.request("/config")).data.code_tasks_enabled, false);
  for (const [path, method] of [
    ["/code-tasks", "POST"],
    ["/code-tasks/abc", "GET"],
    ["/code-tasks/abc/apply", "POST"],
    ["/code-tasks/abc/cancel", "POST"],
  ])
    assert.equal(
      (await f.request(path!, method!, method === "POST" ? {} : undefined))
        .status,
      403,
    );
  await f.request(`/sessions/${s}/turns`, "POST", { text: "inspect" });
  assert.ok(!offered.includes("code_task"));
});

test("code-task receipts fit the Mastra channel and later turns reload the approved state", async (t) => {
  const task = "a".repeat(32);
  const result = {
    id: task,
    status: "awaiting_approval",
    diff: "+".repeat(200000),
    changed_files: ["app.js"],
    checks: [],
    steps: [],
    created_at: at.toISOString(),
    expires_at: new Date(at.getTime() + 100000).toISOString(),
    summary: "preview",
  };
  const tools = monitoringTools({} as Dependencies, {
    codeTask: { run: async () => result as any },
  });
  const receipt = await tools
    .find((tool) => tool.name === "code_task")!
    .execute({ task: "repair", workspace: "." }, new AbortController().signal, {
      id: "alice",
      role: "admin",
    });
  assert.equal(receipt.id, task);
  assert.equal(receipt.diff_available, true);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 128 << 10);
  let observed: any;
  const f = await fixture(t, {
    codeWorkspaceRoot: ".",
    runtime: async (input) => {
      observed = input.messages.find((message) => message.role === "tool");
    },
  });
  await configure(f);
  const s = await session(f),
    store = new Store(f.db, () => at);
  const history: any = store.get(`session/alice/${s}`);
  history.messages = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "code-call",
          type: "function",
          function: { name: "code_task", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "code-call",
      content: JSON.stringify(receipt),
    },
  ];
  store.put(`session/alice/${s}`, history);
  store.put(
    `code-task/${task}`,
    f.deps.encrypt(
      JSON.stringify({
        result: { ...result, status: "completed" },
        owner: "alice",
        workspace: ".",
        changes: [],
        applied: true,
      }),
    ),
  );
  await f.request(`/sessions/${s}/turns`, "POST", {
    text: "Has it been applied?",
  });
  assert.equal(JSON.parse(observed.content).status, "completed");
});
