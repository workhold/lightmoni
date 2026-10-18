import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CodeTaskService,
  type CodeTaskOptions,
  type CodeTaskResult,
} from "../src/assistant/code.js";
import { Store } from "../src/assistant/usage.js";
import { DB } from "../src/shared/sqlite.js";
import type { Config } from "../src/assistant/types.js";

const at = new Date("2026-10-18T03:00:00.000Z");
const secret = "code-task-fixture-secret";
const original = "console.log('original');\n";
const broken = "console.log('broken'\n";
const fixed = "console.log('fixed');\n";
const check = "node --check app.js";

type Action =
  | { tool: string; input: Record<string, unknown> }
  | { text: string; finish?: string }
  | { error: number; message: string }
  | { hang: true }
  | { raw: string };
interface Request {
  url?: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

function deferred<T = void>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolveValue = done;
  });
  return { promise, resolve: resolveValue };
}

function reply(res: ServerResponse, action: Action, index: number) {
  if ("error" in action) {
    res.writeHead(action.error, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: action.message } }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  if ("hang" in action) {
    res.write(": awaiting fixture cancellation\n\n");
    return;
  }
  if ("raw" in action) {
    res.end(action.raw);
    return;
  }
  const tool = "tool" in action;
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `fixture-call-${index}`,
            type: "function",
            function: {
              name: action.tool,
              arguments: JSON.stringify(action.input),
            },
          },
        ],
      }
    : { role: "assistant", content: action.text };
  const chunks = [
    {
      id: `fixture-${index}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id: `fixture-${index}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: tool ? "tool_calls" : (action.finish ?? "stop"),
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ];
  res.end(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );
}

async function provider(
  t: TestContext,
  actions: Action[] | ((index: number, request: Request) => Action),
  options: { protocol?: string; basePath?: string; model?: string } = {},
) {
  const requests: Request[] = [],
    failures: Error[] = [],
    first = deferred(),
    closed = deferred();
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = {
        url: req.url,
        authorization: req.headers.authorization,
        headers: req.headers,
        body: JSON.parse(raw),
      };
      const index = requests.push(request) - 1;
      res.once("close", () => closed.resolve());
      first.resolve();
      const action =
        typeof actions === "function"
          ? actions(index, request)
          : actions[index];
      if (!action) throw Error(`unexpected model request ${index + 1}`);
      reply(res, action, index);
    } catch (error) {
      failures.push(error instanceof Error ? error : Error(String(error)));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}${options.basePath ?? "/tenant/v1"}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    assert.deepEqual(failures, [], failures.map((e) => e.message).join("\n"));
  });
  const config: Config = {
    base_url: base,
    protocol: options.protocol ?? "openai-chat-completions",
    model: options.model ?? "fixture",
    api_key: secret,
    enabled: true,
    max_input_tokens: 32768,
    max_output_tokens: 1024,
    max_steps: 8,
    reasoning_effort: "none",
  };
  return { requests, config, first: first.promise, closed: closed.promise };
}

async function workspace(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "lightmoni-code-test-"));
  const project = resolve(root, "project");
  await mkdir(project);
  await writeFile(resolve(project, "app.js"), original);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, app: resolve(project, "app.js") };
}

function memoryStore() {
  const records = new Map<string, any>();
  return {
    records,
    get<T>(key: string): T | undefined {
      const value = records.get(key);
      return value == null ? undefined : structuredClone(value);
    },
    put<T>(key: string, value: T) {
      records.set(key, structuredClone(value));
    },
  };
}

function service(
  root: string,
  config: Config,
  options: Partial<CodeTaskOptions> = {},
) {
  return new CodeTaskService({
    workspaceRoot: root,
    now: () => new Date(at),
    config: () => config,
    ...options,
  });
}

function protocolText(protocol: string, withUsage: boolean): Action {
  const text = "No source changes are needed.";
  const sse = (events: Record<string, unknown>[], named = false) => ({
    raw: events
      .map(
        (event) =>
          `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  });
  if (protocol === "anthropic-messages")
    return sse(
      [
        {
          type: "message_start",
          message: {
            id: "fixture-message",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [],
            stop_reason: null,
            usage: withUsage
              ? {
                  input_tokens: 11,
                  output_tokens: 1,
                  cache_read_input_tokens: 3,
                  cache_creation_input_tokens: 2,
                }
              : {},
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          ...(withUsage ? { usage: { output_tokens: 7 } } : {}),
        },
        { type: "message_stop" },
      ],
      true,
    );
  if (protocol === "openai-responses") {
    const item = {
      id: "fixture-item",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    return sse([
      {
        type: "response.created",
        response: { id: "fixture-response", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "fixture-response",
          status: "completed",
          output: [item],
          ...(withUsage
            ? {
                usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
              }
            : {}),
        },
      },
    ]);
  }
  if (protocol === "google-generative-ai")
    return sse([
      {
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text }] },
            finishReason: "STOP",
          },
        ],
        ...(withUsage
          ? {
              usageMetadata: {
                promptTokenCount: 13,
                candidatesTokenCount: 5,
                thoughtsTokenCount: 2,
                totalTokenCount: 20,
              },
            }
          : {}),
      },
    ]);
  return sse([
    {
      id: "fixture-chat",
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "fixture-chat",
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(withUsage
        ? {
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
            },
          }
        : {}),
    },
  ]);
}

test(
  "real Pi adapters preserve tenant endpoints, credentials, request shapes and raw token accounting",
  { timeout: 20000 },
  async (t) => {
    for (const protocol of [
      "openai-chat-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ]) {
      for (const withUsage of [true, false]) {
        await t.test(
          `${protocol} ${withUsage ? "with" : "without"} usage`,
          async (child) => {
            const w = await workspace(child),
              usage = usageRecorder();
            const google = protocol === "google-generative-ai";
            const p = await provider(
              child,
              [protocolText(protocol, withUsage)],
              {
                protocol,
                basePath: google ? "/tenant/v1beta" : "/tenant/v1",
                model: google ? "models/fixture" : "fixture",
              },
            );
            const s = service(w.root, p.config, { usage: usage.usage });
            const result = await s.run(
              input,
              "alice",
              new AbortController().signal,
            );
            assert.equal(result.status, "completed", JSON.stringify(result));
            assert.equal(p.requests.length, 1);
            const request = p.requests[0],
              body = request.body;
            const paths: Record<string, string> = {
              "openai-chat-completions": "/tenant/v1/chat/completions",
              "openai-responses": "/tenant/v1/responses",
              "anthropic-messages": "/tenant/v1/messages",
              "google-generative-ai":
                "/tenant/v1beta/models/fixture:streamGenerateContent?alt=sse",
            };
            const actualUrl = new URL(request.url!, "http://fixture"),
              expectedUrl = new URL(paths[protocol], "http://fixture");
            assert.equal(
              actualUrl.pathname,
              expectedUrl.pathname,
              "the protocol SDK must preserve the configured tenant/version path",
            );
            if (google) assert.equal(actualUrl.search, expectedUrl.search);
            if (protocol === "anthropic-messages") {
              assert.equal(request.headers["x-api-key"], secret);
              assert.equal(request.headers["anthropic-version"], "2023-06-01");
              assert.equal(body.model, "fixture");
              assert.equal(body.max_tokens, 1024);
              assert.equal(body.stream, true);
              assert.ok(Array.isArray(body.messages));
              assert.ok(
                body.tools.every((tool: any) => tool.name && tool.input_schema),
              );
            } else if (google) {
              assert.equal(request.headers["x-goog-api-key"], secret);
              assert.ok(Array.isArray(body.contents));
              assert.ok(
                body.contents[0].parts.some((part: any) =>
                  part.text?.includes(input.task),
                ),
              );
              assert.equal(body.generationConfig.maxOutputTokens, 1024);
              assert.ok(
                body.tools[0].functionDeclarations.some(
                  (tool: any) => tool.name === "read",
                ),
              );
              assert.ok(body.systemInstruction.parts[0].text);
            } else {
              assert.equal(request.authorization, `Bearer ${secret}`);
              assert.equal(body.model, "fixture");
              assert.equal(body.stream, true);
              assert.ok(
                Array.isArray(
                  protocol === "openai-responses" ? body.input : body.messages,
                ),
              );
              assert.ok(
                body.tools.some(
                  (tool: any) => (tool.name ?? tool.function?.name) === "read",
                ),
              );
            }
            const [receipt] = usageReceipts(usage.events, 1);
            assert.equal(receipt.status, "succeeded");
            if (withUsage) {
              const expected = google
                ? [13, 7, 20]
                : protocol === "anthropic-messages"
                  ? [16, 7, 23]
                  : [12, 4, 16];
              assert.deepEqual(
                [
                  receipt.input_tokens,
                  receipt.output_tokens,
                  receipt.total_tokens,
                ],
                expected,
              );
            } else {
              for (const key of [
                "input_tokens",
                "output_tokens",
                "total_tokens",
              ])
                assert.equal(
                  Object.hasOwn(receipt, key),
                  false,
                  `missing provider ${key} must stay unknown`,
                );
            }
            assert.equal(await readFile(w.app, "utf8"), original);
          },
        );
      }
    }
  },
);

test(
  "close during workspace preflight prevents a later model request",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, []),
      s = service(w.root, p.config);
    const pending = s.run(input, "alice", new AbortController().signal);
    const rejection = assert.rejects(pending, /closed|closing|stopping/i);
    await s.close();
    await rejection;
    assert.equal(p.requests.length, 0);
    assert.equal(await readFile(w.app, "utf8"), original);
    await assert.rejects(
      s.run(input, "alice", new AbortController().signal),
      /closed|closing|stopping/i,
    );
  },
);

test(
  "apply changes only the approved hardlink path and preserves executable permissions",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, preview()),
      outside = resolve(w.root, "outside.js");
    await writeFile(outside, original, { mode: 0o755 });
    await rm(w.app);
    await link(outside, w.app);
    await chmod(w.app, 0o755);
    const s = service(w.root, p.config),
      result = await s.run(input, "alice", new AbortController().signal);
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    await s.apply(result.id, "alice");
    assert.equal(await readFile(w.app, "utf8"), fixed);
    assert.equal(
      await readFile(outside, "utf8"),
      original,
      "applying one path must not rewrite a different hardlink",
    );
    assert.equal((await stat(w.app)).mode & 0o777, 0o755);
  },
);

test(
  "cancellation cannot acknowledge success after a task becomes approvable",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, preview());
    let accepted: boolean | undefined;
    const s = service(w.root, p.config, {
      usage: (id) => ({
        record() {},
        finish() {
          accepted = s.cancel(id, "alice");
        },
      }),
    });
    const result = await s.run(input, "alice", new AbortController().signal);
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    assert.equal(
      accepted,
      false,
      "a terminal task must not claim it was cancelled while keeping its diff applicable",
    );
    assert.equal(await readFile(w.app, "utf8"), original);
  },
);

test(
  "failure to persist a preview never exposes an applicable cached diff",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, preview()),
      persisted = memoryStore();
    let failed = false;
    const s = service(w.root, p.config, {
      store: {
        get: persisted.get,
        put(key, value: any) {
          if (!failed && value.result.status === "awaiting_approval") {
            failed = true;
            throw Error("transient fixture storage failure");
          }
          persisted.put(key, value);
        },
      },
    });
    await assert.rejects(
      s.run(input, "alice", new AbortController().signal),
      /storage|persist|preview/i,
    );
    assert.equal(failed, true);
    const id = [...persisted.records.keys()][0].slice("code-task/".length);
    assert.notEqual(s.get(id, "alice")?.status, "awaiting_approval");
    await assert.rejects(s.apply(id, "alice"));
    assert.equal(await readFile(w.app, "utf8"), original);
  },
);

test(
  "a failed apply persistence rolls back source contents and permits a later approved retry",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, preview()),
      persisted = memoryStore();
    let failed = false;
    const s = service(w.root, p.config, {
      store: {
        get: persisted.get,
        put(key, value: any) {
          if (!failed && value.result.status === "completed") {
            failed = true;
            throw Error("transient fixture storage failure");
          }
          persisted.put(key, value);
        },
      },
    });
    const result = await s.run(input, "alice", new AbortController().signal);
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    await assert.rejects(s.apply(result.id, "alice"), /storage/i);
    assert.equal(await readFile(w.app, "utf8"), original);
    assert.equal(s.get(result.id, "alice")?.status, "awaiting_approval");
    await s.apply(result.id, "alice");
    assert.equal(await readFile(w.app, "utf8"), fixed);
  },
);

test(
  "unrecognized provider tool names cannot expose the configured key in task steps",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, [
        { tool: secret, input: {} },
        { text: "The unknown operation was refused." },
      ]);
    const s = service(w.root, p.config),
      result = await s.run(input, "alice", new AbortController().signal);
    assert.equal(p.requests.length, 2);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(result.steps.some((step) => step.action === "tool:unknown"));
    assert.equal(await readFile(w.app, "utf8"), original);
  },
);

test(
  "a check that creates binary output fails without turning the original into a deletion",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      command = "node binary.js";
    await writeFile(
      resolve(w.project, "binary.js"),
      "require('node:fs').writeFileSync('app.js', Buffer.from([0, 1, 2]));\n",
    );
    const p = await provider(t, [
      { tool: "bash", input: { command } },
      { text: "Finished the check." },
    ]);
    const s = service(w.root, p.config, { allowedCommands: [command] });
    const result = await s.run(
      {
        ...input,
        allowed_paths: ["app.js", "binary.js"],
        allowed_commands: [command],
      },
      "alice",
      new AbortController().signal,
    );
    assert.equal(p.requests.length, 2);
    assert.equal(
      result.checks[0]?.status,
      "passed",
      "the approved command really ran before output validation failed",
    );
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.diff, "");
    assert.deepEqual(result.changed_files, []);
    await assert.rejects(s.apply(result.id, "alice"));
    assert.equal(await readFile(w.app, "utf8"), original);
  },
);

test(
  "concurrent parent and child workspace approvals share an apply lock",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, preview()),
      store = memoryStore();
    const nested = resolve(w.project, "child");
    await mkdir(nested);
    await writeFile(resolve(nested, "app.js"), original);
    const s = service(w.root, p.config, { store }),
      result = await s.run(input, "alice", new AbortController().signal);
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    const childId = "b".repeat(32),
      childRecord = store.get<any>(`code-task/${result.id}`)!;
    childRecord.workspace = resolve(childRecord.workspace, "child");
    childRecord.result.id = childId;
    store.put(`code-task/${childId}`, childRecord);
    const [parent, child] = await Promise.allSettled([
      s.apply(result.id, "alice"),
      s.apply(childId, "alice"),
    ]);
    assert.equal(parent.status, "fulfilled");
    assert.equal(child.status, "rejected");
    if (child.status === "rejected")
      assert.match(String(child.reason), /already applying/i);
    assert.equal(await readFile(w.app, "utf8"), fixed);
    assert.equal(await readFile(resolve(nested, "app.js"), "utf8"), original);
  },
);

function usageRecorder() {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const usage: CodeTaskOptions["usage"] = () => ({
    record(type, data) {
      events.push({ type, data: structuredClone(data) });
    },
    finish() {},
  });
  return { events, usage };
}

function usageReceipts(
  events: ReturnType<typeof usageRecorder>["events"],
  count: number,
) {
  const starts = events
    .filter((e) => e.type === "model.request.started")
    .map((e) => e.data);
  const receipts = events
    .filter((e) => e.type === "turn.usage")
    .map((e) => e.data);
  assert.equal(starts.length, count, "each real request needs a start receipt");
  assert.equal(
    receipts.length,
    count,
    "each real request needs exactly one usage receipt",
  );
  assert.equal(new Set(starts.map((e) => e.request_id)).size, count);
  assert.deepEqual(
    receipts.map((e) => e.request_id),
    starts.map((e) => e.request_id),
  );
  return receipts;
}

async function requestStarted(
  first: Promise<void>,
  pending: Promise<CodeTaskResult>,
) {
  await Promise.race([
    first,
    pending.then((result) =>
      assert.fail(
        `Task ended before contacting the provider: ${JSON.stringify(result)}`,
      ),
    ),
  ]);
}

const edit = (oldText: string, newText: string): Action => ({
  tool: "edit",
  input: { path: "app.js", edits: [{ oldText, newText }] },
});
const preview = (): Action[] => [
  { tool: "read", input: { path: "app.js" } },
  edit(original, fixed),
  { text: "Prepared the requested change." },
];
const input = {
  task: "Repair app.js and verify its syntax",
  workspace: "project",
  allowed_paths: ["app.js"],
  max_steps: 8,
};

test(
  "Pi performs real read/edit/check/repair/check rounds and persists review before approval",
  { timeout: 20000 },
  async (t) => {
    const w = await workspace(t);
    const p = await provider(t, [
      { tool: "read", input: { path: "app.js" } },
      edit(original, broken),
      { tool: "bash", input: { command: check } },
      edit(broken, fixed),
      { tool: "bash", input: { command: check } },
      { text: "The syntax check now passes." },
    ]);
    const dbPath = resolve(w.root, "tasks.sqlite");
    let db = new DB(dbPath);
    t.after(() => db.close());
    const usage = usageRecorder();
    const first = service(w.root, p.config, {
      allowedCommands: [check],
      store: new Store(db, () => new Date(at)),
      usage: usage.usage,
    });
    const result = await first.run(
      { ...input, allowed_commands: [check] },
      "alice",
      new AbortController().signal,
    );
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    assert.equal(p.requests.length, 6);
    for (const receipt of usageReceipts(usage.events, p.requests.length)) {
      assert.deepEqual(
        [
          receipt.input_tokens,
          receipt.output_tokens,
          receipt.total_tokens,
          receipt.status,
        ],
        [12, 4, 16, "succeeded"],
      );
    }
    assert.ok(
      p.requests.every(
        (r) =>
          r.url === "/tenant/v1/chat/completions" &&
          r.authorization === `Bearer ${secret}`,
      ),
    );
    assert.ok(
      JSON.stringify(p.requests[1].body).includes("original"),
      "Pi must receive the read tool result before editing",
    );
    assert.match(
      JSON.stringify(p.requests[3].body),
      /SyntaxError|Unexpected|missing|Unexpected token/i,
      "the failed real syntax check must reach the next model round",
    );
    assert.deepEqual(result.changed_files, ["app.js"]);
    assert.match(result.diff, /original/);
    assert.match(result.diff, /fixed/);
    assert.deepEqual(
      result.checks.map((item) => [item.command, item.status]),
      [
        [check, "failed"],
        [check, "passed"],
      ],
    );
    assert.ok(
      result.steps.filter(
        (step) =>
          step.action.includes("read") ||
          step.action.includes("edit") ||
          step.action.includes("bash"),
      ).length >= 5,
    );
    assert.equal(
      await readFile(w.app, "utf8"),
      original,
      "preview must leave the original workspace untouched",
    );
    assert.ok(!JSON.stringify(result).includes(secret));

    db.close();
    db = new DB(dbPath);
    const restarted = service(w.root, p.config, {
      allowedCommands: [check],
      store: new Store(db, () => new Date(at)),
    });
    assert.equal(restarted.get(result.id, "bob"), undefined);
    await assert.rejects(restarted.apply(result.id, "bob"));
    assert.equal(
      restarted.get(result.id, "alice")?.status,
      "awaiting_approval",
    );
    assert.equal(
      (await restarted.apply(result.id, "alice")).status,
      "completed",
    );
    assert.equal(await readFile(w.app, "utf8"), fixed);
    assert.equal(
      (await restarted.apply(result.id, "alice")).status,
      "completed",
      "approved apply must be idempotent",
    );
  },
);

test(
  "approval rejects a changed original or a newly introduced symbolic link",
  { timeout: 15000 },
  async (t) => {
    const w = await workspace(t);
    const p = await provider(t, (index) => preview()[index % 3]);
    const s = service(w.root, p.config);
    const conflict = await s.run(input, "alice", new AbortController().signal);
    assert.equal(
      conflict.status,
      "awaiting_approval",
      JSON.stringify(conflict),
    );
    await writeFile(w.app, "console.log('concurrent edit');\n");
    await assert.rejects(s.apply(conflict.id, "alice"), /changed|conflict/i);
    assert.equal(
      await readFile(w.app, "utf8"),
      "console.log('concurrent edit');\n",
    );

    await writeFile(w.app, original);
    const linked = await s.run(input, "alice", new AbortController().signal);
    assert.equal(linked.status, "awaiting_approval", JSON.stringify(linked));
    const outside = resolve(w.root, "outside.js");
    await writeFile(outside, original);
    await rm(w.app);
    await symlink(outside, w.app);
    await assert.rejects(s.apply(linked.id, "alice"), /symbolic|link|path/i);
    assert.equal(await readFile(outside, "utf8"), original);
  },
);

test(
  "a running Pi task is owner scoped and cancellation aborts the provider request",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t);
    const p = await provider(t, [{ hang: true }]);
    const store = memoryStore();
    const s = service(w.root, p.config, { store });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = s.run(input, "alice", controller.signal);
    await requestStarted(p.first, pending);
    const id = [...store.records.keys()]
      .find((key) => key.startsWith("code-task/"))
      ?.slice("code-task/".length);
    assert.ok(
      id,
      "the running task must have a persisted identity so it can be cancelled",
    );
    assert.equal(s.get(id, "bob"), undefined);
    assert.equal(s.cancel(id, "bob"), false);
    assert.equal(s.cancel(id, "alice"), true);
    const result = await pending;
    await p.closed;
    assert.equal(result.status, "cancelled", JSON.stringify(result));
    assert.equal(p.requests.length, 1);
    assert.equal(s.cancel(id, "alice"), false);
    assert.equal(await readFile(w.app, "utf8"), original);
  },
);

test(
  "a restart marks an interrupted persisted task failed and never makes it applicable",
  { timeout: 10000 },
  async (t) => {
    const w = await workspace(t),
      p = await provider(t, [{ hang: true }]),
      store = memoryStore();
    const s = service(w.root, p.config, { store }),
      controller = new AbortController();
    t.after(() => controller.abort());
    const pending = s.run(input, "alice", controller.signal);
    await requestStarted(p.first, pending);
    const [key, record] = [...store.records.entries()].find(([key]) =>
      key.startsWith("code-task/"),
    )!;
    const recoveredStore = memoryStore();
    recoveredStore.put(key, record);
    controller.abort();
    await pending;
    const restarted = service(w.root, p.config, { store: recoveredStore }),
      id = key.slice("code-task/".length);
    assert.equal(restarted.get(id, "bob"), undefined);
    assert.equal(restarted.get(id, "alice")?.status, "failed");
    assert.match(
      restarted.get(id, "alice")?.summary ?? "",
      /restart|interrupted/i,
    );
    await assert.rejects(restarted.apply(id, "alice"));
    assert.equal(await readFile(w.app, "utf8"), original);
  },
);

test(
  "parent cancellation and task timeout stop the provider and leave no approvable changes",
  { timeout: 10000 },
  async (t) => {
    for (const mode of ["parent", "timeout"] as const) {
      await t.test(mode, async (child) => {
        const w = await workspace(child),
          p = await provider(child, [{ hang: true }]);
        const controller = new AbortController(),
          s = service(w.root, p.config);
        const pending = s.run(
          { ...input, timeout_ms: 1000 },
          "alice",
          controller.signal,
        );
        await requestStarted(p.first, pending);
        if (mode === "parent") controller.abort();
        const result = await pending;
        await p.closed;
        assert.equal(result.status, "cancelled", JSON.stringify(result));
        await assert.rejects(s.apply(result.id, "alice"));
        assert.equal(await readFile(w.app, "utf8"), original);
      });
    }
  },
);

test(
  "Pi task limits stop before an extra model request and provider failures never become approval",
  { timeout: 15000 },
  async (t) => {
    await t.test("step limit", async (child) => {
      const w = await workspace(child),
        p = await provider(child, (index) =>
          index === 0
            ? edit(original, fixed)
            : { tool: "read", input: { path: "app.js" } },
        );
      const usage = usageRecorder(),
        s = service(w.root, p.config, { maxSteps: 2, usage: usage.usage });
      const result = await s.run(
        { ...input, max_steps: 2 },
        "alice",
        new AbortController().signal,
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(
        p.requests.length,
        2,
        "step limit must be checked before model invocation",
      );
      usageReceipts(usage.events, p.requests.length);
      assert.match(result.summary, /step|limit/i);
      assert.equal(result.diff, "");
      assert.deepEqual(result.changed_files, []);
      assert.equal(await readFile(w.app, "utf8"), original);
      await assert.rejects(s.apply(result.id, "alice"));
    });
    for (const failure of ["check", "provider"] as const) {
      await t.test(
        `partial edits are discarded after ${failure} failure`,
        async (child) => {
          const w = await workspace(child);
          const actions: Action[] =
            failure === "check"
              ? [
                  edit(original, broken),
                  { tool: "bash", input: { command: check } },
                  { text: "Could not repair the syntax error." },
                ]
              : [
                  edit(original, fixed),
                  { error: 401, message: `provider leaked ${secret}` },
                ];
          const p = await provider(child, actions),
            s = service(w.root, p.config, { allowedCommands: [check] });
          const result = await s.run(
            { ...input, allowed_commands: [check] },
            "alice",
            new AbortController().signal,
          );
          assert.equal(result.status, "failed", JSON.stringify(result));
          assert.equal(p.requests.length, actions.length);
          assert.equal(result.diff, "");
          assert.deepEqual(result.changed_files, []);
          assert.ok(!JSON.stringify(result).includes(secret));
          if (failure === "check")
            assert.equal(result.checks[0]?.status, "failed");
          await assert.rejects(s.apply(result.id, "alice"));
          assert.equal(await readFile(w.app, "utf8"), original);
        },
      );
    }
    for (const action of [
      { error: 401, message: `provider leaked ${secret}` },
      { text: "Partial output", finish: "length" },
      { raw: "data: malformed-fixture-json\n\n" },
    ] satisfies Action[]) {
      await t.test(JSON.stringify(action), async (child) => {
        const w = await workspace(child),
          p = await provider(child, [action]);
        const s = service(w.root, p.config);
        const result = await s.run(
          input,
          "alice",
          new AbortController().signal,
        );
        assert.equal(result.status, "failed", JSON.stringify(result));
        assert.equal(p.requests.length, 1);
        assert.ok(!JSON.stringify(result).includes(secret));
        await assert.rejects(s.apply(result.id, "alice"));
        assert.equal(await readFile(w.app, "utf8"), original);
      });
    }
  },
);

test(
  "Pi rejects workspace traversal, link reads and commands outside the server allowlist",
  { timeout: 20000 },
  async (t) => {
    await t.test(
      "workspace traversal is rejected before a provider request",
      async (child) => {
        const w = await workspace(child),
          p = await provider(child, []),
          s = service(w.root, p.config);
        await assert.rejects(
          s.run(
            { ...input, workspace: "../" },
            "alice",
            new AbortController().signal,
          ),
          /workspace|path/i,
        );
        await assert.rejects(
          s.run(
            { ...input, allowed_paths: ["../outside.js"] },
            "alice",
            new AbortController().signal,
          ),
          /path/i,
        );
        assert.equal(p.requests.length, 0);
      },
    );
    for (const denied of [
      {
        name: "traversal read",
        action: { tool: "read", input: { path: "../outside.js" } },
      },
      {
        name: "symbolic-link read",
        action: { tool: "read", input: { path: "outside-link.js" } },
      },
      {
        name: "file outside requested paths",
        action: { tool: "read", input: { path: "private.js" } },
      },
      {
        name: "credential-file read",
        action: { tool: "read", input: { path: ".env" } },
      },
      {
        name: "absolute write",
        action: {
          tool: "write",
          input: { path: "ABSOLUTE_OUTSIDE", content: "modified" },
        },
      },
      {
        name: "request cannot grant a command",
        action: { tool: "bash", input: { command: "node app.js" } },
      },
      {
        name: "shell metacharacters",
        action: { tool: "bash", input: { command: `${check}; node app.js` } },
      },
    ] satisfies { name: string; action: Action }[]) {
      await t.test(denied.name, async (child) => {
        const w = await workspace(child),
          outside = resolve(w.root, "outside.js");
        const protectedValue = "outside-fixture-value-must-stay-private\n";
        await writeFile(outside, protectedValue);
        await writeFile(resolve(w.project, "private.js"), protectedValue);
        await writeFile(resolve(w.project, ".env"), protectedValue);
        await symlink(outside, resolve(w.project, "outside-link.js"));
        const action = JSON.parse(
          JSON.stringify(denied.action).replace("ABSOLUTE_OUTSIDE", outside),
        ) as Action;
        const p = await provider(child, [
          action,
          { text: "The requested operation was refused." },
        ]);
        const s = service(w.root, p.config, { allowedCommands: [check] });
        const requestedCommands =
          denied.name === "request cannot grant a command"
            ? ["node app.js"]
            : [];
        const allowedPaths =
          denied.name === "file outside requested paths"
            ? ["app.js"]
            : undefined;
        const result = await s.run(
          {
            ...input,
            allowed_paths: allowedPaths,
            allowed_commands: requestedCommands,
          },
          "alice",
          new AbortController().signal,
        );
        assert.ok(
          ["failed", "completed"].includes(result.status),
          JSON.stringify(result),
        );
        assert.equal(
          p.requests.length,
          2,
          "the actual Pi tool refusal must reach a subsequent provider request",
        );
        assert.deepEqual(result.changed_files, []);
        assert.equal(await readFile(outside, "utf8"), protectedValue);
        assert.equal(await readFile(w.app, "utf8"), original);
        assert.ok(
          !JSON.stringify(p.requests).includes(protectedValue.trim()),
          "outside contents must never be sent to the provider",
        );
        assert.ok(!JSON.stringify(result).includes(protectedValue.trim()));
        assert.ok(
          !result.checks.some((item) => item.status === "passed"),
          "a refused command must never have a passed check receipt",
        );
        assert.match(
          JSON.stringify(p.requests[1].body),
          /error|not allowed|not found|ENOENT|path|workspace|disabled|Unknown tool/i,
        );
      });
    }
  },
);
