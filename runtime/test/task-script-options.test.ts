import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskRunner, executeTaskScript } from "../src/agent/task-runner.js";
import { SCRIPT_TASK_CAPABILITY, SCRIPT_TASK_CAPABILITIES, SCRIPT_TASK_V2_CAPABILITY, requiredTaskScriptCapability,
  validateTaskScript, type TaskScript } from "../src/shared/task-center.js";

const script = (value: Partial<TaskScript> = {}): TaskScript => ({ runtime: "node", code: "console.log('old snapshot')", timeout_seconds: 3, max_output_bytes: 4096, ...value });
function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), "lightmoni-script-options-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("script options validate types, UTF-8 byte bounds, NUL and absolute remote working directories", () => {
  for (const cwd of [undefined, "", "/srv/application", "C:\\service", "\\\\server\\share"])
    assert.doesNotThrow(() => validateTaskScript(script({ cwd, args: ["", "contains spaces", "你好"] })));
  const invalid: unknown[] = [
    script({ args: null as any }), script({ args: [1] as any }), script({ args: new Array(33).fill("") }),
    script({ args: ["a\0b"] }), script({ args: ["你".repeat(342)] }),
    script({ args: new Array(9).fill("a".repeat(1024)) }),
    script({ cwd: "relative/path" }), script({ cwd: "C:relative" }), script({ cwd: "/srv\0/path" }),
    script({ cwd: "/" + "你".repeat(1366) }), { ...script(), environment: { SECRET: "not accepted" } },
  ];
  for (const value of invalid) assert.throws(() => validateTaskScript(value), /invalid script/);
  assert.doesNotThrow(() => validateTaskScript(script({ args: new Array(8).fill("a".repeat(1024)) })));
});

test("only nonempty new execution options require task.script.v2", () => {
  assert.equal(requiredTaskScriptCapability(script()), SCRIPT_TASK_CAPABILITY);
  assert.equal(requiredTaskScriptCapability(script({ args: [], cwd: "" })), SCRIPT_TASK_CAPABILITY);
  assert.equal(requiredTaskScriptCapability(script({ args: [""] })), SCRIPT_TASK_V2_CAPABILITY);
  assert.equal(requiredTaskScriptCapability(script({ cwd: "/srv" })), SCRIPT_TASK_V2_CAPABILITY);
});

test("Node task receives literal argv and selected cwd without inheriting Agent environment", async t => {
  const dataDir = directory(t), cwd = join(dataDir, "application directory"), injected = join(dataDir, "injected");
  mkdirSync(cwd);
  const args = ["contains spaces", "", "$(touch " + injected + ")", "'; exit 19; #", "--eval", "你好"];
  const previous = process.env.LIGHTMONI_OPTION_TEST_SECRET;
  process.env.LIGHTMONI_OPTION_TEST_SECRET = "must-not-be-inherited";
  try {
    const outcome = await executeTaskScript(script({ args, cwd, code: "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),secret:process.env.LIGHTMONI_OPTION_TEST_SECRET??null,run:process.env.LIGHTMONI_TASK_RUN_ID}));" }), { dataDir, runID: "literal-arguments" });
    assert.equal(outcome.state, "succeeded");
    assert.deepEqual(JSON.parse(outcome.stdout), { args, cwd: realpathSync(cwd), secret: null, run: "literal-arguments" });
    assert.equal(existsSync(injected), false);
  } finally {
    if (previous === undefined) delete process.env.LIGHTMONI_OPTION_TEST_SECRET;
    else process.env.LIGHTMONI_OPTION_TEST_SECRET = previous;
  }
});

test("POSIX shell argv is passed after the script without interpolation or word splitting", async t => {
  if (process.platform === "win32") return t.skip("POSIX shell is unavailable");
  const dataDir = directory(t), cwd = join(dataDir, "cwd"), injected = join(dataDir, "injected");
  mkdirSync(cwd);
  const args = ["one two", "", "$(touch " + injected + ")", "$HOME", "a\nb", "--help"];
  const outcome = await executeTaskScript(script({ runtime: "shell", args, cwd, code: "printf '<%s>\\n' \"$@\"; printf 'cwd=%s\\n' \"$PWD\"" }), { dataDir, runID: "shell-arguments" });
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.stdout, args.map(value => `<${value}>\n`).join("") + `cwd=${realpathSync(cwd)}\n`);
  assert.equal(existsSync(injected), false);
});

test("missing selected cwd fails instead of falling back to the Agent or temporary directory", async t => {
  const dataDir = directory(t), marker = join(dataDir, "unexpected-execution");
  const outcome = await executeTaskScript(script({ cwd: join(dataDir, "missing"), code: `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');` }), { dataDir, runID: "missing-cwd" });
  assert.equal(outcome.state, "failed"); assert.equal(outcome.code, "runtime_unavailable");
  assert.equal(existsSync(marker), false);
});

test("custom cwd and arguments preserve timeout and cancellation boundaries", async t => {
  const dataDir = directory(t), cwd = join(dataDir, "cwd"); mkdirSync(cwd);
  const value = script({ cwd, args: ["literal"], timeout_seconds: 1, code: "setInterval(()=>{},1000);" });
  const timedOut = await executeTaskScript(value, { dataDir, runID: "v2-timeout" });
  assert.equal(timedOut.state, "failed"); assert.equal(timedOut.code, "timeout");
  const controller = new AbortController();
  const pending = executeTaskScript({ ...value, timeout_seconds: 3 }, { dataDir, runID: "v2-cancel", signal: controller.signal });
  setTimeout(() => controller.abort(Object.assign(new Error("cancel"), { code: "cancel_requested" })), 100);
  const cancelled = await pending;
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.code, "cancel_requested");
});

test("Agent advertises both execution capabilities and executes legacy snapshots", async t => {
  const dataDir = directory(t), calls: {url: string; body: any}[] = [];
  const lease = "a".repeat(64), id = "legacy-run";
  const run = { id, task_id: "task", host_id: "host", agent_id: "agent", lease_token: lease,
    snapshot: { task_id: "task", host_id: "host", agent_id: "agent", script: script() } };
  const runner = new AgentTaskRunner({ endpoint: "https://center.test", agentID: "agent", controlCredential: "control", dataDir }, {
    fetch: (async (url: any, options: any) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      return Response.json(url.endsWith("/claim") ? { run } : url.endsWith("/heartbeat") ? { state: "running" } : { state: body.state });
    }) as typeof fetch,
  });
  const outcome = await runner.pollOnce();
  assert.deepEqual(calls[0].body.capabilities, [...SCRIPT_TASK_CAPABILITIES]);
  assert.equal(outcome?.state, "succeeded"); assert.equal(outcome?.stdout, "old snapshot\n");
  assert.equal(calls.at(-1)?.body.state, "succeeded");
});
