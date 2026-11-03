import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { MANAGED_AGENT_DATA_DIR, MANAGED_AGENT_TASKS_DIR } from "../src/privileged-executor/config.js";
import { executeTaskScript, ordinaryTaskAccount, verifyOrdinaryTaskExecutionIdentity } from "../src/agent/task-runner.js";

let available = process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0
  && existsSync("/usr/bin/setpriv") && existsSync(MANAGED_AGENT_TASKS_DIR) && existsSync(MANAGED_AGENT_DATA_DIR);
if (available) {
  try {
    const root = lstatSync(MANAGED_AGENT_TASKS_DIR), state = lstatSync(MANAGED_AGENT_DATA_DIR);
    const account = ordinaryTaskAccount();
    available = root.isDirectory() && !root.isSymbolicLink() && root.uid === 0 && (root.mode & 0o022) === 0
      && state.isDirectory() && !state.isSymbolicLink() && state.uid === 0 && (state.mode & 0o022) === 0
      && account.uid > 0 && account.gid > 0;
  } catch { available = false; }
}

test("helper executes a real script as lightmoni-agent with no supplementary groups or capabilities", { skip: !available }, async () => {
  const account = ordinaryTaskAccount();
  verifyOrdinaryTaskExecutionIdentity(account);
  const script = {
    runtime: "node" as const,
    code: String.raw`import fs from 'node:fs';const status=fs.readFileSync('/proc/self/status','utf8');const field=n=>status.match(new RegExp('^'+n+':[\\t ]*([^\\n]*)$','m'))?.[1]?.trim()??'';console.log(JSON.stringify({uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),groups:field('Groups').split(/[\t ]+/).filter(Boolean).map(Number),nnp:field('NoNewPrivs'),capInh:field('CapInh'),capPrm:field('CapPrm'),capEff:field('CapEff'),capBnd:field('CapBnd'),capAmb:field('CapAmb')}));`,
    timeout_seconds: 5,
    max_output_bytes: 4096,
  };
  const result = await executeTaskScript(script, {
    dataDir: MANAGED_AGENT_DATA_DIR,
    runID: "agent-task-helper-linux-smoke",
    expectedAccount: account,
  });
  assert.equal(result.state, "succeeded");
  const observed = JSON.parse(result.stdout.trim());
  assert.deepEqual({ uid: observed.uid, euid: observed.euid, gid: observed.gid }, {
    uid: account.uid, euid: account.uid, gid: account.gid,
  });
  assert.deepEqual(observed.groups, []);
  assert.equal(observed.nnp, "1");
  for (const key of ["capInh", "capPrm", "capEff", "capBnd", "capAmb"])
    assert.equal(BigInt("0x" + observed[key]), 0n, key);
});
