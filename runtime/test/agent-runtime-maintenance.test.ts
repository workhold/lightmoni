import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync,
  realpathSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
// The installer helper intentionally ships as native ESM outside the TS tree.
// @ts-ignore
import { AgentRuntimeMaintenance } from "../../deploy/agent/runtime-mode.mjs";
// @ts-ignore
import {
  buildAgentService,
  buildHelperService,
  identifyAgentService,
} from "../../deploy/agent/service-unit.mjs";

type Mode = "root" | "user";
function fixture(t: any, mode: Mode = "user") {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "lightmoni-runtime-maintenance-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = (file: string) => join(root, file);
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(p(file)), { recursive: true, mode: 0o700 });
    writeFileSync(
      p(file),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  };
  const read = (file: string) => JSON.parse(readFileSync(p(file), "utf8"));
  write("/etc/lightmoni-agent/config.json", {
    runtime_mode: mode,
    permission_generation: 4,
    endpoint: "https://center.test",
    data_dir: "/var/lib/lightmoni-agent",
    control_credential: "control",
  });
  write("/etc/systemd/system/lightmoni-agent.service", buildAgentService(mode));
  write("/opt/lightmoni-agent/releases/release-1/installation.json", {
    schema: 1,
    artifact_sha256: "a".repeat(64),
  });
  symlinkSync("releases/release-1", p("/opt/lightmoni-agent/current"));
  write("/var/lib/lightmoni-agent/identity.json", {
    agent_id: "agent-1",
    host_id: "host-1",
  });
  write("/var/lib/lightmoni-agent/task-run-state.json", {});
  write("/var/lib/lightmoni-agent/cache.json", { retained: "diagnostic" });
  mkdirSync(p("/var/lib/lightmoni-agent/operations"), { mode: 0o700 });
  mkdirSync(p("/run"), { mode: 0o700 });
  const enroll = () => {
    write("/etc/lightmoni-agent-helper/helper.json", { agent_id: "agent-1", permission_generation: 4 });
    write("/etc/lightmoni-agent-helper/managed.json", { executor_id: "internal-1", install_generation: 1, permission_generation: 4 });
    write("/etc/lightmoni-agent-helper/managed-activation.json", { generation: 4 });
    write("/var/lib/lightmoni-agent-helper/managed/journal.json", {
      private_key: "old-signing-key",
    });
    write("/etc/systemd/system/lightmoni-agent-helper.service", buildHelperService());
  };
  if (mode === "root") enroll();
  const calls: string[] = [],
    owners: { file: string; uid: number; gid: number }[] = [];
  let boot = randomUUID(),
    active = "active",
    helperActive = mode === 'root' ? 'active' : 'inactive';
  const faults = {
    check: 0,
    stop: 0,
    prepare: 0,
    stopBusy: false,
    start: 0,
    wrongIdentity: false,
  };
  const command = (file: string, args: string[], _input?: string) => {
    calls.push([file, ...args].join(" "));
    if (file === "/usr/bin/id") {
      if (faults.prepare > 0) {
        faults.prepare--;
        throw Error("injected_account_failure");
      }
      const name=args.at(-1);
      if(name==='lightmoni-agent')return args[0]==='-u'?'19999':'19998';
    }
    if (file === "systemctl") {
      if (args[0] === "show") {
        const helper=args.includes('lightmoni-agent-helper.service');
        if(args.includes('--property=ActiveState'))return helper?helperActive:active;
        if(args.includes('--property=FragmentPath'))return helper&&existsSync(p('/etc/systemd/system/lightmoni-agent-helper.service'))?p('/etc/systemd/system/lightmoni-agent-helper.service'):helper?'':'/etc/systemd/system/lightmoni-agent.service';
        if(args.includes('--property=LoadState'))return helper&&!existsSync(p('/etc/systemd/system/lightmoni-agent-helper.service'))?'not-found':'loaded';
        if(args.includes('--property=DropInPaths'))return '';
        return '';
      }
      if (args[0] === "stop") {
        if(args[1]==='lightmoni-agent-helper.service')helperActive='inactive';else active = "inactive";
        if (faults.stopBusy) {
          faults.stopBusy = false;
          write("/var/lib/lightmoni-agent/operations/execution.lock", "busy");
        }
        if (faults.stop > 0) {
          faults.stop--;
          throw Error("injected_stop_transport_failure");
        }
      }
      if (args[0] === "start") {
        if (faults.start > 0) {
          faults.start--;
          throw Error("injected_start_failure");
        }
        if(args[1]==='lightmoni-agent-helper.service')helperActive='active';else active = "active";
        boot = randomUUID();
      }
      if(args[0]==='disable'&&args[1]==='lightmoni-agent-helper.service')helperActive='not-found';
      return "";
    }
    if (file === p("/usr/local/bin/lightmoni-agent")) {
      if (args[0] === "helper-status" || args[0] === "managed-status")
        return JSON.stringify({
          executor_id: "internal-1",
          install_generation: 1,
          fenced: null,
          pending_results: 0,
          permission_generation:read('/etc/lightmoni-agent/config.json').permission_generation,
          ordinary_task_identity:{account:'lightmoni-agent',uid:19999,gid:19998},
          ordinary_task_runner:{active:false,state:'idle'},
        });
      if (args[0] === "managed-enroll") {
        enroll();
        return "";
      }
      if(args[0]==='managed-activate')return JSON.stringify({activation_id:'refreshed'});
      if (args[0] === "check") {
        if (faults.check > 0) {
          faults.check--;
          throw Error("injected_check_failure");
        }
        return "";
      }
      if (args[0] === "status") {
        const config = read("/etc/lightmoni-agent/config.json");
        return JSON.stringify({
          agent_id: faults.wrongIdentity ? "wrong-agent" : "agent-1",
          boot_id: boot,
          queue_batches: 0,
          runtime: {
            mode: config.runtime_mode,
            permission_generation: config.permission_generation,
            uid: 19999,
            gid: 19998,
          },
        });
      }
    }
    throw Error("unexpected test command: " + file + " " + args.join(" "));
  };
  const m = new AgentRuntimeMaintenance({
    root,
    uid: process.getuid?.() ?? 0,
    command,
    chown: (file: string, uid: number, gid: number) => {
      owners.push({ file, uid, gid });
    },
    sleep: async () => {},
  });
  const request = (target: Mode = mode === "root" ? "user" : "root") => {
    const config = read("/etc/lightmoni-agent/config.json");
    return {
      schema: 1,
      operation_id: randomUUID(),
      agent_id: "agent-1",
      from_mode: config.runtime_mode,
      runtime_mode: target,
      previous_generation: config.permission_generation,
      permission_generation: config.permission_generation + 1,
      artifact_sha256: "a".repeat(64),
      endpoint: "https://center.test",
      ...(target === "root"
        ? { managed_bootstrap: { bootstrap: "one-time-enrollment" } }
        : {}),
    };
  };
  return {
    m,
    p,
    write,
    read,
    request,
    calls,
    owners,
    faults,
    active: () => active,
  };
}

for (const mode of ["user", "root"] as const)
  test(
    "runtime maintenance switches helper mode from " +
      mode +
      " while the Agent remains non-root and its state stays put",
    async (t) => {
      const f = fixture(t, mode),
        request = f.request();
      const result=await f.m.apply(request);
      assert.equal(result.status, "succeeded");
      assert.equal(result.permission_generation, 5);
      assert.equal(
        f.read("/etc/lightmoni-agent/config.json").runtime_mode,
        request.runtime_mode,
      );
      assert.equal(
        identifyAgentService(
          readFileSync(f.p("/etc/systemd/system/lightmoni-agent.service")),
        ),
        'user',
      );
      assert.equal(f.active(), "active");
      assert.equal(
        existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")),
        false,
      );
      assert.deepEqual(f.read("/var/lib/lightmoni-agent/identity.json"), {
        agent_id: "agent-1",
        host_id: "host-1",
      });
      assert.deepEqual(f.read("/var/lib/lightmoni-agent/cache.json"),{retained:'diagnostic'});
      assert.equal(
        existsSync(f.p("/etc/lightmoni-agent-helper/managed.json")),
        request.runtime_mode === "root",
      );
      assert.equal(existsSync(f.p('/etc/systemd/system/lightmoni-agent-helper.service')),request.runtime_mode==='root');
      assert.equal(f.calls.some(call=>/useradd|groupadd|userdel|groupdel/.test(call)),false,'mode switches reuse the Agent account');
      assert.equal(
        f.calls.some((value) => value.includes("lightmoni-executor")),
        false,
      );
      assert.ok(f.owners.every(value=>value.file===f.p('/etc/lightmoni-agent/config.json')),'mode changes never chown the network Agent data tree');
    },
  );

for (const mode of ["user", "root"] as const)
  test(
    "runtime maintenance restores " +
      mode +
      " identity, config and private state on failed validation",
    async (t) => {
      const f = fixture(t, mode),
        request = f.request();
      f.faults.check = 1;
      await assert.rejects(() => f.m.apply(request), /injected_check_failure/);
      assert.equal(
        f.read("/etc/lightmoni-agent/config.json").runtime_mode,
        mode,
        JSON.stringify({ receipt: f.m.status(request.operation_id), calls: f.calls }),
      );
      assert.equal(
        f.read("/etc/lightmoni-agent/config.json").permission_generation,
        4,
      );
      assert.equal(
        identifyAgentService(
          readFileSync(f.p("/etc/systemd/system/lightmoni-agent.service")),
        ),
        'user',
      );
      assert.deepEqual(f.read("/var/lib/lightmoni-agent/cache.json"), {
        retained: "diagnostic",
      });
      assert.equal(
        existsSync(f.p("/etc/lightmoni-agent-helper/managed.json")),
        mode === "root",
      );
      if (mode === "root")
        assert.equal(
          f.read("/var/lib/lightmoni-agent-helper/managed/journal.json").private_key,
          "old-signing-key",
        );
      assert.equal(f.active(), "active");
      assert.equal(f.m.status(request.operation_id).restored, true);
      assert.equal(f.m.status(request.operation_id).status, "failed");
      assert.equal(
        existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")),
        false,
      );
    },
  );

test("runtime maintenance rechecks busy execution after service stops and restores availability", async (t) => {
  const f = fixture(t),
    request = f.request();
  f.faults.stopBusy = true;
  await assert.rejects(() => f.m.apply(request), /agent_execution_not_idle/);
  assert.equal(f.m.status(request.operation_id).restored, true);
  assert.equal(f.active(), "active");
  assert.equal(f.read("/etc/lightmoni-agent/config.json").runtime_mode, "user");
  assert.equal(
    existsSync(f.p("/var/lib/lightmoni-agent/operations/execution.lock")),
    true,
  );
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
});

test("runtime maintenance rejects hardlinked mutable state without touching the external inode", async (t) => {
  const f = fixture(t),
    request = f.request();
  f.write("/outside-secret", "do not modify");
  linkSync(f.p("/outside-secret"), f.p("/var/lib/lightmoni-agent/hardlink"));
  await assert.rejects(() => f.m.apply(request), /unsafe_agent_state/);
  assert.equal(readFileSync(f.p("/outside-secret"), "utf8"), "do not modify");
  assert.equal(f.m.status(request.operation_id).restored, true);
  assert.equal(f.read("/etc/lightmoni-agent/config.json").runtime_mode, "user");
});

test("runtime maintenance refuses a nonempty operation directory and preserves its unknown evidence", async (t) => {
  const f = fixture(t),
    request = f.request();
  f.write("/var/lib/lightmoni-agent/operations/unknown-result.json", {
    state: "unknown",
    operation_id: "do-not-delete",
  });
  await assert.rejects(
    () => f.m.apply(request),
    /agent_execution_not_idle|unsafe_agent_state|operations/,
  );
  assert.deepEqual(
    f.read("/var/lib/lightmoni-agent/operations/unknown-result.json"),
    { state: "unknown", operation_id: "do-not-delete" },
  );
  assert.equal(f.read("/etc/lightmoni-agent/config.json").runtime_mode, "user");
  assert.equal(f.active(), "active");
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
});

test("runtime maintenance refuses stale plans before stopping the service", async (t) => {
  const f = fixture(t),
    request = { ...f.request(), artifact_sha256: "b".repeat(64) };
  await assert.rejects(() => f.m.apply(request), /runtime_plan_stale/);
  assert.equal(
    f.calls.some((value) => value === "systemctl stop lightmoni-agent.service"),
    false,
  );
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
});

test("runtime maintenance binds the plan again after obtaining the lifecycle lock", async (t) => {
  const f = fixture(t),
    request = f.request(),
    probe = f.m.probe.bind(f.m);
  let probes = 0;
  f.m.probe = () => {
    const state = probe();
    if (++probes === 1)
      f.write("/etc/lightmoni-agent/config.json", {
        ...f.read("/etc/lightmoni-agent/config.json"),
        permission_generation: 5,
      });
    return state;
  };
  await assert.rejects(() => f.m.apply(request), /runtime_plan_stale/);
  assert.equal(
    f.calls.some((value) => value === "systemctl stop lightmoni-agent.service"),
    false,
  );
  assert.equal(
    f.read("/etc/lightmoni-agent/config.json").permission_generation,
    5,
  );
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
});

test("runtime maintenance refuses a completed operation ID even with a fresh reverse plan", async (t) => {
  const f = fixture(t),
    request = f.request();
  await f.m.apply(request);
  const stopped = f.calls.filter(
    (value) => value === "systemctl stop lightmoni-agent.service",
  ).length;
  await assert.rejects(
    () =>
      f.m.apply({ ...f.request("user"), operation_id: request.operation_id }),
    /runtime_plan_already_applied/,
  );
  assert.equal(
    f.calls.filter(
      (value) => value === "systemctl stop lightmoni-agent.service",
    ).length,
    stopped,
  );
  assert.equal(f.m.status(request.operation_id).status, "succeeded");
});

test("runtime maintenance safely reuses its protected backup parent across both directions", async (t) => {
  const f = fixture(t),
    first = f.request("root");
  await f.m.apply(first);
  const second = f.request("user");
  const result = await f.m.apply(second);
  assert.equal(result.status, "succeeded");
  assert.equal(f.read("/etc/lightmoni-agent/config.json").runtime_mode, "user");
  assert.equal(
    f.read("/etc/lightmoni-agent/config.json").permission_generation,
    6,
  );
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
});

test("runtime maintenance releases its lock on preparation failure", async (t) => {
  const f = fixture(t),
    request = f.request();
  const account = f.m.account.bind(f.m);
  let reads = 0;
  f.m.account = () => {
    if (++reads === 2) throw Error("injected_preparation_failure");
    return account();
  };
  await assert.rejects(
    () => f.m.apply(request),
    /injected_preparation_failure/,
  );
  assert.equal(f.active(), "active");
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
  assert.equal(f.m.status(request.operation_id).status, "failed");
});

test("runtime maintenance restores a service when stop succeeded but its command transport failed", async (t) => {
  const f = fixture(t),
    request = f.request();
  f.faults.stop = 1;
  await assert.rejects(
    () => f.m.apply(request),
    /injected_stop_transport_failure/,
  );
  assert.equal(f.active(), "active");
  assert.equal(f.m.status(request.operation_id).restored, true);
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), false);
});

test("runtime maintenance preserves an unknown receipt and lock when rollback cannot restart", async (t) => {
  const f = fixture(t),
    request = f.request();
  f.faults.check = 1;
  f.faults.start = 1;
  await assert.rejects(() => f.m.apply(request), /injected_check_failure/);
  assert.equal(f.m.status(request.operation_id).status, "unknown");
  assert.equal(f.m.status(request.operation_id).restored, false);
  assert.equal(existsSync(f.p("/run/lightmoni-agent-lifecycle.lock")), true);
});

test("runtime maintenance probe cannot declare ready with a mismatched live Agent identity", (t) => {
  const f = fixture(t);
  f.faults.wrongIdentity = true;
  assert.throws(() => f.m.probe(), /runtime_health_unverified/);
});

test("runtime maintenance supports repeated bidirectional switches with complete atomic receipts", async (t) => {
  const f = fixture(t);
  for (const target of ["root", "user", "root"] as const) {
    const request = f.request(target),
      writes: any[] = [],
      atomic = f.m.atomic.bind(f.m);
    f.m.atomic = (file: string, value: any, permissions?: number) => {
      if (file.endsWith(request.operation_id + ".json"))
        writes.push(structuredClone(value));
      return atomic(file, value, permissions);
    };
    const result = await f.m.apply(request);
    assert.equal(result.runtime_mode, target);
    const succeeded = writes.filter((value) => value.status === "succeeded");
    assert.equal(succeeded.length, 1);
    assert.match(succeeded[0].boot_id, /^[a-f0-9-]{36}$/);
    assert.equal(succeeded[0].artifact_sha256, request.artifact_sha256);
      assert.equal(succeeded[0].uid, 19999, "the network Agent remains non-root in both modes");
    assert.deepEqual(f.m.status(request.operation_id), result);
  }
});

test("runtime maintenance refuses a reused quarantine directory with loose permissions", async (t) => {
  const f = fixture(t),
    dir = f.p("/var/lib/lightmoni-agent-maintenance");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o755);
  await assert.rejects(() => f.m.apply(f.request()), /unsafe_runtime_path/);
  assert.equal(
    f.calls.some((value) => value === "systemctl stop lightmoni-agent.service"),
    false,
  );
});
