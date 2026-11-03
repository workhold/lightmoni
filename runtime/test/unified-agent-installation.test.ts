import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerTaskCenter } from "../src/server/task-center.js";
import { registerAgentCredentials } from "../src/server/agent-credentials.js";
import { registerManagedMachines } from "../src/server/managed-machines.js";
import { registerPrivilegedExecutors } from "../src/server/privileged-executors.js";
import { canonicalJSON, signExecutorRequest, signJWS, sha256 } from "../src/shared/privileged-executor.js";
const check =
  "LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\nprivilege_state=root\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
async function fixture(
  t: any,
  mode: "root" | "user",
  lostResponse = false,
  runtimeOverride?: Record<string, unknown>,
  loginName = "root",
) {
  const db = new DB(":memory:"),
    router = new Router(),
    user = { id: "admin", name: "Admin", role: "admin" },
    now = new Date("2026-11-02T00:00:00Z"),
    logs: any[] = [],
    calls: any[] = [];
  const release = {build_id:"first-reviewed-release",source_revision:"a".repeat(40),artifact_sha256:"b".repeat(64),state_schema:1};
  let origin = "",
    agentID = "",
    removed = false,
    activation: any;
  const deps = {
    db,
    router,
    ...cipher(Buffer.alloc(32, 28)),
    now: () => now,
    externalURL: "https://platform.example.test",
    auth: {
      master: Buffer.alloc(32, 28),
      user: () => user,
      requireAdmin(c: any) {
        if (c.user.role !== "admin") fail(403, "admin_required");
      },
    },
    logger: {
      info(...v: any[]) {
        logs.push(v);
      },
      warn(...v: any[]) {
        logs.push(v);
      },
      error(...v: any[]) {
        logs.push(v);
      },
    },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const tasks = registerTaskCenter(deps);
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER)",
  );
  db.run("INSERT INTO users VALUES('admin','Admin','admin',1)");
  const credentials = registerAgentCredentials(deps),
    executors = registerPrivilegedExecutors(deps, { dataDir: "/unused" });
  const request = async (
    path: string,
    method = "GET",
    body?: any,
    authorization?: string,
  ) => {
    const r = await fetch(origin + "/api/v1" + path, {
        method,
        headers: {
          cookie: "lm_session=fixture",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authorization
            ? { authorization: "Bearer " + authorization }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      raw = await r.text();
    return { status: r.status, data: raw ? JSON.parse(raw) : null, raw };
  };
  const machines = registerManagedMachines(deps, {
    agentCredentials: credentials,
    sshRunner: async (input: any) => {
      calls.push(input);
      if (input.enrollmentToken) {
        assert.match(input.command, new RegExp("--runtime-mode[^\n]*" + mode));
        const enrolled = await request("/agents/enroll", "POST", {
          enrollment_token: input.enrollmentToken,
          install_nonce: "installer-nonce",
          agent_public_key: "ed25519:fixture",
          version: "0.1.0",
          arch: "amd64",
        });
        assert.equal(enrolled.status, 201, enrolled.raw);
        agentID = enrolled.data.agent_id;
        const activated = await request(
          "/agents/" + agentID + "/activate",
          "POST",
          {
            install_nonce: "installer-nonce",
            health: { service: "ready", config_checked: true },
          },
          enrolled.data.bootstrap_credential,
        );
        assert.equal(activated.status, 200, activated.raw);
        activation = activated.data;
        assert.equal(activation.runtime_mode, mode);
        assert.equal(activation.permission_generation, 1);
        if (mode === "root") {
          const b = activation.managed_bootstrap,
            keys = generateKeyPairSync("ed25519"),
            pub = keys.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            iat = Math.floor(now.getTime() / 1000);
          assert.ok(b);
          executors.enroll({
            token: b.enrollment_token,
            public_key: pub,
            proof: signJWS(
              {
                version: 1,
                purpose: "enrollment",
                token_sha256: sha256(b.enrollment_token),
                public_key_sha256: sha256(pub),
                executor_nonce: randomBytes(24).toString("base64url"),
                iat,
                exp: iat + 60,
              },
              keys.privateKey,
              b.executor_id,
            ),
          });
          const heartbeat = {
            version: "0.1.0",
            boot_id: randomBytes(24).toString("base64url"),
            activation_id: randomUUID(),
            policy_generation: b.local_policy.generation,
            capabilities: b.local_policy.capabilities,
            release,
            ordinary_task_identity:{account:"lightmoni-task",uid:996,gid:996,permission_generation:1},
            account_profiles: [],
            interpreter_profiles: [],
          },path="/api/v1/privileged-executors/"+b.executor_id+"/heartbeat",raw=canonicalJSON(heartbeat);
          const signature=signExecutorRequest({body:raw,center_instance_id:executors.centerInstanceID,executor_id:b.executor_id,install_generation:b.install_generation,method:"POST",path,request_id:randomBytes(24).toString("base64url"),iat,exp:iat+60},keys.privateKey);
          executors.signedRequest(b.executor_id,"POST",path,Buffer.from(raw),signature,(executor,input)=>executors.heartbeat(executor,input));
        } else assert.equal(activation.managed_bootstrap, undefined);
        db.run(
          "INSERT INTO agents VALUES(?,?,?,?,?,?,?,?)",
          agentID,
          input.machine.id,
          "real-host",
          "0.1.0",
          "linux",
          "amd64",
          now.toISOString(),
          JSON.stringify({
            last_error: "",
            boot_id:randomUUID(),
            release,
            runtime: runtimeOverride ?? {
              mode,
              permission_generation: 1,
              uid: 995,
              gid: 995,
            },
          }),
        );
        if (lostResponse) {
          lostResponse = false;
          throw Error("lost response after managed enrollment");
        }
        return {
          stdout: "agent_installation_verified=1",
          stderr: "",
          stages: ["agent_active"],
        };
      }
      if (input.command.includes("LMAGENT=1"))
        return {
          stdout:
            "LMAGENT=1\nagent_id=" +
            agentID +
            "\ninstallation=present\nprogram_complete=1\nunit_managed=1\nservice_running=1\nlifecycle_locked=0\noperation_lock=0\ndata_retained=1\n",
          stderr: "",
          stages: [],
        };
      if (input.command.includes("LMREMOVE")) {
        if (input.command.includes("systemctl stop")) removed = true;
        return {
          stdout:
            "LMREMOVE=1\nagent_id=" +
            agentID +
            "\nidentity_state=valid\nidentity_sha256=" +
            "c".repeat(64) +
            "\nprogram_sha256=" +
            (removed ? "b" : "a").repeat(64) +
            "\ninstallation=" +
            (removed ? "absent" : "present") +
            "\nprogram_complete=" +
            (removed ? 0 : 1) +
            "\nunit_managed=1\nservice_running=" +
            (removed ? 0 : 1) +
            "\nlifecycle_locked=0\noperation_lock=0\npaths_safe=1\nconfig_present=1\ndata_present=1\nagent_state_present=1\nbusiness_data_retained=0\nhelper_present=" + (removed ? 0 : 1) + "\ntask_account_present=" + (removed ? 0 : 1) + "\n",
          stderr: "",
          stages: [],
        };
      }
      return {
        stdout:
          loginName === "root"
            ? check
            : check.replace(
                "privilege_state=root",
                "privilege_state=sudo_noninteractive",
              ),
        stderr: "",
        stages: [],
      };
    },
  });
  const runtime = machines.registerExecutorBootstrap(executors);
  const server = createServer(async (req, res) => {
    if (!(await router.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + (server.address() as any).port;
  t.after(async () => {
    await runtime.close?.();
    await machines.close?.();
    await executors.close?.();
    await tasks.close?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
  const host = await request("/machines", "POST", {
    name: "Reviewed host",
    address: "host.example.test",
    connection_method: "direct_ssh",
  });
  assert.equal(host.status, 201, host.raw);
  const account = await request(
    "/machines/" + host.data.id + "/accounts",
    "POST",
    { username: loginName, make_default: true },
  );
  assert.equal(account.status, 201, account.raw);
  db.run(
    "UPDATE managed_machines SET host_key_fingerprint='SHA256:abcdefghijklmnop' WHERE id=?",
    host.data.id,
  );
  const login = await request(
    "/machines/" + host.data.id + "/accounts/" + account.data.id + "/credentials",
    "POST",
    {
      method: "password",
      secret: "isolated-unified-login",
      retention: "permanent",
      confirm_permanent: true,
    },
  );
  assert.equal(login.status, 201, login.raw);
  const checked = await request(
    "/machines/" + host.data.id + "/ssh-check",
    "POST",
    { credential_id: login.data.credential_id },
  );
  assert.equal(checked.status, 200, checked.raw);
  const planned = await request(
    "/machines/" + host.data.id + "/deployments/plan",
    "POST",
    {
      check_id: checked.data.id,
      credential_id: login.data.credential_id,
      version: "0.1.0",
      arch: "amd64",
      ...(mode === "user" ? { runtime_mode: "user" } : {}),
    },
  );
  assert.equal(planned.status, 201, planned.raw);
  assert.equal(planned.data.plan.runtime_mode, mode);
  const expectedFailure = lostResponse || !!runtimeOverride,
    applied = await request(
      "/machines/" +
        host.data.id +
        "/deployments/" +
        planned.data.id +
        "/apply",
      "POST",
      { confirm: true },
    );
  assert.equal(applied.status, expectedFailure ? 502 : 200, applied.raw);
  if (!expectedFailure) assert.equal(applied.data.status, "succeeded");
  return {
    deploymentID: planned.data.id,
    db,
    request,
    machines,
    executors,
    hostID: host.data.id,
    accountID: account.data.id,
    credentialID: login.data.credential_id,
    agentID,
    activation,
    applied,
    calls,
    logs,
  };
}
test("non-root SSH login with noninteractive sudo completes reviewed installation without registering root credentials", async (t) => {
  for (const mode of ["root", "user"] as const)
    await t.test(mode, async (sub) => {
      const f = await fixture(sub, mode, false, undefined, "deploy");
      assert.equal(f.applied.data.status, "succeeded");
      assert.equal(
        f.db.get<any>(
          "SELECT count(*) n FROM machine_ssh_accounts WHERE username='root'",
        )!.n,
        0,
      );
      assert.equal(
        f.db.get<any>("SELECT count(*) n FROM machine_credentials")!.n,
        1,
      );
      assert.ok(f.calls.every((c) => c.machine.username === "deploy"));
      const installation = f.calls.find((c) => c.enrollmentToken);
      assert.ok(installation);
      assert.ok(installation.command.includes("sudo -n"));
      const runtime = f.db.get<any>(
        "SELECT * FROM machine_agent_runtime WHERE machine_id=?",
        f.hostID,
      )!;
      assert.equal(runtime.runtime_mode, mode);
      assert.equal(runtime.agent_id, f.agentID);
      assert.equal(
        f.executors.getStatus(f.hostID).executor?.state,
        mode === "root" ? "active" : undefined,
      );
    });
});
test("authenticated installer activation creates one runtime with its reviewed mode and no public bootstrap token", async (t) => {
  for (const mode of ["root", "user"] as const)
    await t.test(mode, async (sub) => {
      const f = await fixture(sub, mode),
        r = f.db.get<any>(
          "SELECT * FROM machine_agent_runtime WHERE machine_id=?",
          f.hostID,
        )!;
      assert.equal(r.runtime_mode, mode);
      assert.equal(r.agent_id, f.agentID);
      assert.equal(r.permission_generation, 1);
      assert.equal(
        f.executors.getStatus(f.hostID).executor?.state,
        mode === "root" ? "active" : undefined,
      );
      assert.equal(
        (await f.request("/machines/" + f.hostID + "/executor-bootstrap/plans"))
          .status,
        404,
      );
      for (const text of [
        f.applied.raw,
        JSON.stringify(f.machines.assistantGet(f.hostID)),
        JSON.stringify(f.logs),
      ]) {
        assert.ok(!text.includes("isolated-unified-login"));
        assert.ok(!text.includes("lm_executor_enroll_"));
      }
    });
});
test("verified unified Agent removal revokes ordinary and embedded signing credentials together", async (t) => {
  const f = await fixture(t, "root"),
    checked = await f.request("/machines/" + f.hostID + "/ssh-check", "POST", {
      credential_id: f.credentialID,
    });
  assert.equal(checked.status, 200, checked.raw);
  const p = await f.request(
    "/machines/" + f.hostID + "/uninstallations/plan",
    "POST",
    { credential_id: f.credentialID, check_id: checked.data.id },
  );
  assert.equal(p.status, 201, p.raw);
  assert.equal(
    p.data.plan.execution_identity.id,
    f.executors.getStatus(f.hostID).executor?.id,
  );
  const r = await f.request(
    "/machines/" + f.hostID + "/uninstallations/" + p.data.id + "/apply",
    "POST",
    { confirm: true },
  );
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "succeeded");
  assert.equal(f.executors.getStatus(f.hostID).executor?.state, "revoked");
  assert.equal(
    f.db.get<any>(
      "SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL",
      f.agentID,
    )!.n,
    0,
  );
  const command = f.calls.find((c) => c.command.includes("systemctl stop"));
  assert.ok(
    command.command.indexOf("lm_remove_managed_state\n") <
      command.command.indexOf("rm -rf /opt/lightmoni-agent"),
  );
});
test("resolving a failed root installation revokes its signing identity and permits a fresh reviewed installation", async (t) => {
  const f = await fixture(t, "root", true),
    original = f.executors.getStatus(f.hostID).executor!.id;
  assert.equal(
    f.db.get<any>(
      "SELECT status FROM machine_deployments WHERE id=?",
      f.deploymentID,
    )!.status,
    "unknown",
  );
  const done = await f.request(
    "/machines/" + f.hostID + "/deployments/" + f.deploymentID + "/resolve",
    "POST",
    {
      confirm: true,
      reason: "已人工核对本次安装回滚，远端程序和内部签名材料已清理",
    },
  );
  assert.equal(done.status, 200, done.raw);
  assert.equal(f.executors.getStatus(f.hostID).executor?.state, "revoked");
  assert.equal(
    f.db.get<any>(
      "SELECT count(*) n FROM privileged_enrollments WHERE executor_id=? AND state='issued'",
      original,
    )!.n,
    0,
  );
  const checked = await f.request(
    "/machines/" + f.hostID + "/ssh-check",
    "POST",
    { credential_id: f.credentialID },
  );
  assert.equal(checked.status, 200, checked.raw);
  const p = await f.request(
    "/machines/" + f.hostID + "/deployments/plan",
    "POST",
    {
      check_id: checked.data.id,
      credential_id: f.credentialID,
      version: "0.1.0",
      arch: "amd64",
    },
  );
  assert.equal(p.status, 201, p.raw);
  const installed = await f.request(
    "/machines/" + f.hostID + "/deployments/" + p.data.id + "/apply",
    "POST",
    { confirm: true },
  );
  assert.equal(installed.status, 200, installed.raw);
  assert.equal(installed.data.status, "succeeded");
  assert.equal(f.executors.getStatus(f.hostID).executor?.state, "active");
  assert.notEqual(f.executors.getStatus(f.hostID).executor?.id, original);
});
test("first-install and recovery require numeric nonzero user account identity in the runtime heartbeat", async (t) => {
  for (const uid of [undefined, "995", 0])
    await t.test(String(uid), async (sub) => {
      const f = await fixture(sub, "user", false, {
        mode: "user",
        permission_generation: 1,
        gid: 995,
        ...(uid === undefined ? {} : { uid }),
      });
      assert.equal(
        f.db.get<any>(
          "SELECT status FROM machine_deployments WHERE id=?",
          f.deploymentID,
        )!.status,
        "unknown",
      );
      const r = await f.request(
        "/machines/" +
          f.hostID +
          "/deployments/" +
          f.deploymentID +
          "/reconcile",
        "POST",
        {},
      );
      assert.equal(r.status, 409, r.raw);
      assert.equal(
        f.db.get<any>(
          "SELECT status FROM machine_deployments WHERE id=?",
          f.deploymentID,
        )!.status,
        "unknown",
      );
    });
});
test("failed root install resolution refuses an execution identity without its exact deployment issuance binding", async (t) => {
  const f = await fixture(t, "root", true),
    original = f.executors.getStatus(f.hostID).executor!.id,
    live = f.db.get<any>(
      "SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL",
      f.agentID,
    )!.n;
  f.db.run(
    "DELETE FROM privileged_audit WHERE machine_id=? AND event='agent_runtime_bootstrap_bound'",
    f.hostID,
  );
  const r = await f.request(
    "/machines/" + f.hostID + "/deployments/" + f.deploymentID + "/resolve",
    "POST",
    { confirm: true, reason: "核对本次安装回滚" },
  );
  assert.equal(r.status, 409, r.raw);
  assert.equal(f.executors.getStatus(f.hostID).executor?.id, original);
  assert.equal(f.executors.getStatus(f.hostID).executor?.state, "active");
  assert.equal(
    f.db.get<any>(
      "SELECT count(*) n FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL",
      f.agentID,
    )!.n,
    live,
  );
  assert.equal(
    f.db.get<any>(
      "SELECT resolved_at FROM machine_deployments WHERE id=?",
      f.deploymentID,
    )!.resolved_at,
    "",
  );
});
function pendingRuntimePlan(f: Awaited<ReturnType<typeof fixture>>, status: string) {
  const id = randomUUID(), machine = f.machines.get(f.hostID), plan = {machine: {id: machine.id, name: machine.name, agent_id: machine.agent_id}, from_mode: "user", runtime_mode: "root", previous_generation: 1, permission_generation: 2, credential_id: f.credentialID};
  f.db.run("INSERT INTO machine_agent_runtime_plans(id,machine_id,agent_id,credential_id,status,revision,plan_json,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, f.hostID, f.agentID, f.credentialID, status, sha256(JSON.stringify(plan)), JSON.stringify(plan), "admin", "2026-11-02T00:00:00Z", "2026-11-02T00:05:00Z");
  return id;
}
test("every pending runtime state freezes host identity and SSH target edits without cancelling the reviewed plan", async t => {
  for (const status of ["awaiting_approval", "running", "verifying", "unknown"]) await t.test(status, async sub => {
    const f = await fixture(sub, "user"), checked = await f.request("/machines/" + f.hostID + "/ssh-check", "POST", {credential_id: f.credentialID});
    assert.equal(checked.status, 200, checked.raw);
    const id = pendingRuntimePlan(f, status), original = f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID), reviewed = f.db.get<any>("SELECT * FROM machine_agent_runtime_plans WHERE id=?", id), checks = f.db.all<any>("SELECT * FROM machine_ssh_checks WHERE machine_id=? ORDER BY id", f.hostID), calls = f.calls.length;
    for (const input of [{name: "Renamed"}, {address: "replacement.example.test"}, {port: 2222}, {connection_method: "agent_only"}, {platform: "other"}]) {
      const r = await f.request("/machines/" + f.hostID, "PUT", input);
      assert.equal(r.status, 409, r.raw);
      assert.match(r.data.error, /^agent_runtime_maintenance_pending:/);
      assert.deepEqual(f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID), original);
      assert.deepEqual(f.db.get<any>("SELECT * FROM machine_agent_runtime_plans WHERE id=?", id), reviewed);
      assert.deepEqual(f.db.all<any>("SELECT * FROM machine_ssh_checks WHERE machine_id=? ORDER BY id", f.hostID), checks);
    }
    assert.equal(f.calls.length, calls);
  });
});
test("cancelling a runtime plan restores host editing and target change invalidates its old SSH checks", async t => {
  const f = await fixture(t, "user"), id = pendingRuntimePlan(f, "awaiting_approval"), path = "/machines/" + f.hostID;
  const generation = f.db.get<any>("SELECT ssh_target_generation FROM managed_machines WHERE id=?", f.hostID)!.ssh_target_generation;
  const cancelled = await f.request(path + "/agent-runtime/plans/" + id + "/cancel", "POST", {confirm: true});
  assert.equal(cancelled.status, 200, cancelled.raw);
  assert.equal(cancelled.data.status, "cancelled");
  const updated = await f.request(path, "PUT", {name: "New reviewed host", address: "replacement.example.test"});
  assert.equal(updated.status, 200, updated.raw);
  assert.equal(updated.data.name, "New reviewed host");
  const saved = f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID)!;
  assert.equal(saved.address, "replacement.example.test");
  assert.equal(f.db.get<any>("SELECT username FROM machine_ssh_accounts WHERE id=?", f.accountID)!.username, "root");
  assert.equal(saved.agent_id, f.agentID);
  assert.equal(saved.ssh_target_generation, generation + 1);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_ssh_checks WHERE machine_id=?", f.hostID)!.n, 0);
});
test("unknown runtime maintenance still permits a new same-account credential without rewriting its approval", async t => {
  const f = await fixture(t, "user"), id = pendingRuntimePlan(f, "unknown"), reviewed = f.db.get<any>("SELECT * FROM machine_agent_runtime_plans WHERE id=?", id), original = f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID)!;
  const added = await f.request("/machines/" + f.hostID + "/accounts/" + f.accountID + "/credentials", "POST", {method: "password", secret: "isolated-reconciliation-secret", retention: "temporary", make_default: false});
  assert.equal(added.status, 201, added.raw);
  assert.notEqual(added.data.credential_id, f.credentialID);
  assert.ok(!added.raw.includes("isolated-reconciliation-secret"));
  const current = f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID)!;
  for (const key of ["name", "address", "port", "connection_method", "agent_id", "ssh_target_generation", "default_account_id"]) assert.equal(current[key], original[key]);
  assert.deepEqual(f.db.get<any>("SELECT * FROM machine_agent_runtime_plans WHERE id=?", id), reviewed);
  assert.ok(f.db.get<any>("SELECT secret_encrypted FROM effective_machine_credentials WHERE id=?", added.data.credential_id)!.secret_encrypted);
});
test("host update rechecks runtime maintenance inside its write transaction", async t => {
  const f = await fixture(t, "user"), original = f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID), transaction = f.db.transaction.bind(f.db);
  let id = "", armed = true;
  f.db.transaction = ((fn: any) => {if (armed) {armed = false; id = pendingRuntimePlan(f, "unknown");} return transaction(fn);}) as typeof f.db.transaction;
  const r = await f.request("/machines/" + f.hostID, "PUT", {name: "A change racing maintenance"});
  assert.equal(r.status, 409, r.raw);
  assert.match(r.data.error, /^agent_runtime_maintenance_pending:/);
  assert.deepEqual(f.db.get<any>("SELECT * FROM managed_machines WHERE id=?", f.hostID), original);
  assert.equal(f.db.get<any>("SELECT status FROM machine_agent_runtime_plans WHERE id=?", id)!.status, "unknown");
});
