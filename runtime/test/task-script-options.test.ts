import { test } from "node:test";
import assert from "node:assert/strict";
import { ordinaryTaskCommand, ordinaryTaskCapabilityDrop } from "../src/agent/task-runner.js";
import { SCRIPT_TASK_CAPABILITY, SCRIPT_TASK_V2_CAPABILITY, requiredTaskScriptCapability,
  validateTaskScript, type TaskScript } from "../src/shared/task-center.js";

const script = (value: Partial<TaskScript> = {}): TaskScript => ({ runtime: "node", code: "console.log('old snapshot')", timeout_seconds: 3, max_output_bytes: 4096, ...value });

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

test("task runner always places the verified task account in front of the command", () => {
  const args = ["/var/lib/lightmoni-agent-helper/tasks/run/task.mjs", "literal $(touch marker)", "你好"];
  const command = ordinaryTaskCommand("/opt/lightmoni-agent/current/node", args, { uid: 1001, gid: 1002 }, "40\n");
  const drop = Array.from({length:41}, (_, index) => "-cap_" + index).join(",");
  assert.equal(command.file, "/usr/bin/setpriv");
  assert.deepEqual(command.args, [
    "--reuid=1001", "--regid=1002", "--clear-groups", "--no-new-privs",
    "--bounding-set=" + drop, "--inh-caps=" + drop, "--ambient-caps=" + drop,
    "--", "/opt/lightmoni-agent/current/node", ...args,
  ]);
});

test("capability drop covers the full kernel range and refuses unknown or truncated bounds", () => {
  assert.equal(ordinaryTaskCapabilityDrop("0\n"), "-cap_0");
  const maximum = ordinaryTaskCapabilityDrop("63").split(",");
  assert.equal(maximum.length, 64); assert.equal(maximum[63], "-cap_63");
  for (const raw of ["", "-1", "+40", "040", " 40", "40 ", "40\n\n", "40\r\n", "40.0", "1e1", "64", "999", "40\0", "40\n--keep-groups"])
    assert.throws(() => ordinaryTaskCapabilityDrop(raw), /ordinary_task_identity_check_failed/);
});
