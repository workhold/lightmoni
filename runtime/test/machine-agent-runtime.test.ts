import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail, HTTPError } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies, Handler } from "../src/shared/types.js";
import { registerTaskCenter } from "../src/server/task-center.js";
import { registerPrivilegedExecutors } from "../src/server/privileged-executors.js";
import {
  registerMachineAgentRuntime,
  recordAgentRuntime,
  createAgentRuntimeSchema,
  parseRuntimeProbe,
} from "../src/server/machine-agent-runtime.js";
import { canonicalJSON, sha256 } from "../src/shared/privileged-executor.js";
import { hasPendingAgentUpdate } from "../src/server/machine-agent-updates-guard.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";

const SECRET = "isolated-runtime-secret",
  BOOT = "11111111-1111-4111-8111-111111111111",
  OLD_BOOT = "00000000-0000-4000-8000-000000000000";
async function fixture(t: any, mode: "user" | "root" = "user", login = "root") {
  const db = new DB(":memory:"),
    router = new Router(),
    calls: any[] = [],
    logs: any[] = [],
    checks: any[] = [],
    busy = new Set<string>(),
    user = { id: "admin", name: "Admin", role: "admin" };
  let clock = new Date("2026-11-02T00:00:00Z");
  const deps = {
    db,
    router,
    ...cipher(Buffer.alloc(32, 27)),
    now: () => clock,
    externalURL: "https://platform.example.test",
    auth: {
      user(req: any) {
        return req.headers.cookie === "lm_session=fixture" &&
          db.get("SELECT id FROM users WHERE id='admin' AND active=1")
          ? user
          : undefined;
      },
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
  const jobs = registerAgentJobs(deps, {
    agentCredentials: { has: () => true } as any,
  });
  db.run(
    "INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES('host','Reviewed host','host.example.test',22,?,'direct_ssh','agent-host',?,?)",
    login,
    clock.toISOString(),
    clock.toISOString(),
  );
  const executors = registerPrivilegedExecutors(deps, { dataDir: "/unused" });
  createAgentRuntimeSchema(deps);
  recordAgentRuntime(deps, "host", "agent-host", mode, 1);
  let executorID = "";
  if (mode === "root") {
    const p = executors.preparePolicyPlan(
      "host",
      { capabilities: ["script.elevated.v1"] },
      "admin",
    );
    executors.applyPolicy(
      "host",
      p.id,
      { confirm: true, expected_revision: p.revision },
      "admin",
    );
    const b = executors.issueBootstrap("host", ["script.elevated.v1"], "admin");
    executorID = b.executor_id;
    db.run(
      "UPDATE privileged_executors SET state='active',last_seen=? WHERE id=?",
      clock.toISOString(),
      executorID,
    );
  }
  let observation: any = {
    schema: 1,
    status: "ready",
    boot_id: OLD_BOOT,
    agent_id: "agent-host",
    runtime_mode: mode,
    permission_generation: 1,
    artifact_sha256: "a".repeat(64),
    uid: mode === "root" ? 0 : 995,
    gid: mode === "root" ? 0 : 995,
    managed:
      mode === "root"
        ? {
            executor_id: executorID,
            install_generation: 1,
            fenced: null,
            pending_results: 0,
          }
        : null,
  };
  const beat = (m: "root" | "user", g: number, boot = BOOT) => {
    const h = JSON.stringify({
      boot_id: boot,
      runtime: {
        mode: m,
        permission_generation: g,
        uid: m === "root" ? 0 : 995,
        gid: m === "root" ? 0 : 995,
      },
      release: { artifact_sha256: "a".repeat(64) },
    });
    db.run(
      "INSERT INTO agents VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat,last_seen=excluded.last_seen",
      "agent-host",
      "host",
      "real-host",
      "0.1.0",
      "linux",
      "amd64",
      clock.toISOString(),
      h,
    );
  };
  beat(mode, 1, OLD_BOOT);
  const credentials = new Map<string, any>([
    [
      "credential",
      {
        id: "credential",
        method: "password",
        secret: SECRET,
        secret_fingerprint: sha256(SECRET),
        retention: "permanent",
        expires_at: null,
        revoked_at: "",
        secret_cleared_at: "",
      },
    ],
  ]);
  const get = (id: string) => {
    const h = db.get<any>("SELECT * FROM managed_machines WHERE id=?", id);
    if (!h) fail(404, "host_not_found");
    return h;
  };
  const credential = (id: string, cid = "credential") => {
    const c = credentials.get(cid);
    if (
      !c ||
      c.revoked_at ||
      c.secret_cleared_at ||
      (c.expires_at && Date.parse(c.expires_at) <= clock.getTime())
    )
      fail(409, "credential_unavailable");
    return { machine: get(id), credential: { ...c } };
  };
  let privilege = { state: "root", reason_code: "" },
    applyMode = "success",
    receipt: any = {},
    probeHook: undefined | (() => void);
  const access = {
    get,
    idle(id: string) {
      if (busy.has(id)) fail(409, "host_busy");
    },
    revision(m: any) {
      return sha256(
        canonicalJSON([m.address, m.port, m.username, m.connection_method]),
      );
    },
    credential,
    authentication(id: string, c: any) {
      credential(id, c.id);
      return { privateKey: "", password: c.secret };
    },
    markCredentialUsed() {},
    busy,
    check: async (machineID: string, input: any) => {
      checks.push({ machineID, ...input });
      return {
        ready: ["root", "sudo_noninteractive"].includes(privilege.state),
        credential_id: "credential",
        privilege: { ...privilege },
      };
    },
    runner: async (input: any) => {
      calls.push(input);
      if (input.command.includes("runtime-mode.mjs apply")) {
        const p = JSON.parse(input.stdin);
        receipt = {
          schema: 1,
          operation_id: p.operation_id,
          agent_id: p.agent_id,
          runtime_mode: p.runtime_mode,
          permission_generation: p.permission_generation,
          status: "failed",
          restored: true,
          error: "runtime_change_failed",
        };
        if (applyMode === "throw") {
          observation.boot_id = BOOT;
          throw Error("private " + SECRET);
        }
        clock = new Date(clock.getTime() + 1000);
        beat(p.runtime_mode, p.permission_generation);
        if (p.managed_bootstrap)
          db.run(
            "UPDATE privileged_executors SET state='active',last_seen=? WHERE id=?",
            clock.toISOString(),
            p.managed_bootstrap.executor_id,
          );
        receipt = {
          ...receipt,
          status: "succeeded",
          restored: false,
          error: "",
          uid: p.runtime_mode === "root" ? 0 : 995,
          gid: p.runtime_mode === "root" ? 0 : 995,
          boot_id: BOOT,
          artifact_sha256: p.artifact_sha256,
        };
        if (applyMode === "lost") throw Error("lost output");
        return {
          stdout: canonicalJSON(
            applyMode === "mismatch"
              ? { ...receipt, agent_id: "replacement" }
              : receipt,
          ),
          stderr: "",
          stages: [],
        };
      }
      if (input.command.includes("runtime-mode.mjs status"))
        return { stdout: canonicalJSON(receipt), stderr: "", stages: [] };
      probeHook?.();
      return {
        stdout:
          typeof observation === "string"
            ? observation
            : canonicalJSON(observation),
        stderr: "",
        stages: [],
      };
    },
    safe:
      (fn: Handler): Handler =>
      async (c) => {
        try {
          await fn(c);
        } catch (e) {
          if (e instanceof HTTPError) c.json({ error: e.message }, e.status);
          else c.json({ error: "failed" }, 500);
        }
      },
  };
  const runtime = registerMachineAgentRuntime(deps, access as any, executors),
    server = createServer(async (req, res) => {
      if (!(await router.handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as any).port,
    path = "/api/v1/machines/host/agent-runtime";
  const request = async (
    suffix = "",
    method = "GET",
    value?: any,
    headers: any = {},
  ) => {
    const r = await fetch(origin + path + suffix, {
        method,
        headers: {
          cookie: "lm_session=fixture",
          ...(value === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...headers,
        },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
      raw = await r.text();
    return { status: r.status, data: JSON.parse(raw), raw };
  };
  const plan = async () => {
      const r = await request("/plans", "POST", {
        runtime_mode: mode === "root" ? "user" : "root",
        credential_id: "credential",
      });
      assert.equal(r.status, 201, r.raw);
      return r.data;
    },
    apply = (p: any, id = randomUUID()) =>
      request("/plans/" + p.id + "/apply", "POST", {
        confirm: true,
        expected_revision: p.revision,
        request_id: id,
      });
  t.after(async () => {
    await runtime.close?.();
    await executors.close?.();
    await jobs.close?.();
    await tasks.close?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
  return {
    db,
    request,
    plan,
    apply,
    calls,
    checks,
    logs,
    user,
    credentials,
    executors,
    jobs,
    beat,
    observation,
    setPrivilege(state: string, reason_code = "") {
      privilege = { state, reason_code };
    },
    onProbe(fn: () => void) {
      probeHook = fn;
    },
    setApply(v: string) {
      applyMode = v;
    },
    getReceipt() {
      return { ...receipt };
    },
    setReceipt(v: any) {
      receipt = v;
      if (v.status === "failed" && v.restored) observation.boot_id = BOOT;
    },
    advance() {
      clock = new Date(clock.getTime() + 1000);
    },
    path,
  };
}
test("a non-root SSH login with passwordless sudo switches the ordinary Agent to root without any registered root login", async (t) => {
  const f = await fixture(t, "user", "deploy");
  f.setPrivilege("sudo_noninteractive");
  assert.equal(f.credentials.size, 1);
  assert.equal(
    f.db.get<any>(
      "SELECT count(*) n FROM managed_machines WHERE username='root'",
    )!.n,
    0,
  );
  const p = await f.plan(),
    r = await f.apply(p);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "succeeded");
  assert.equal((await f.request()).data.runtime_mode, "root");
  assert.equal(f.checks.length, 2);
  assert.ok(f.checks.every((c) => c.credential_id === "credential"));
  assert.ok(
    f.calls.every(
      (c) => c.machine.username === "deploy" && c.credentialID === "credential",
    ),
  );
  assert.ok(f.calls.every((c) => c.command.includes("sudo -n /bin/sh -c")));
  assert.equal(f.executors.getStatus("host").executor?.state, "active");
  assert.equal(f.credentials.size, 1);
  assert.equal(
    f.db.get<any>("SELECT username FROM managed_machines WHERE id='host'")!
      .username,
    "deploy",
  );
  assert.equal(
    f.db.get<any>(
      "SELECT count(*) n FROM machine_agent_runtime_audit WHERE event='runtime_approved'",
    )!.n,
    1,
  );
});
test("a non-root login without noninteractive sudo cannot plan or dispatch an account switch", async (t) => {
  for (const [state, reason] of [
    ["unavailable", "privilege_unavailable_or_interactive"],
    ["unknown", "privilege_probe_failed"],
  ])
    for (const stage of ["plan", "apply"])
      await t.test(stage + " " + state, async (sub) => {
        const f = await fixture(sub, "user", "deploy");
        f.setPrivilege("sudo_noninteractive");
        const p = stage === "apply" ? await f.plan() : undefined,
          callsBefore = f.calls.length;
        const credentialBefore = { ...f.credentials.get("credential") };
        f.setPrivilege(state, reason);
        const r = p
          ? await f.apply(p)
          : await f.request("/plans", "POST", {
              runtime_mode: "root",
              credential_id: "credential",
            });
        assert.equal(r.status, 409, r.raw);
        assert.equal(r.data.error, "root_or_sudo_ssh_required");
        assert.equal(f.calls.length, callsBefore);
        assert.equal(
          f.calls.filter((c) => c.command.includes("runtime-mode.mjs apply"))
            .length,
          0,
        );
        assert.equal(
          f.db.get<any>("SELECT count(*) n FROM privileged_executors")!.n,
          0,
        );
        assert.equal(
          f.db.get<any>("SELECT count(*) n FROM privileged_enrollments")!.n,
          0,
        );
        assert.equal(
          f.db.get<any>(
            "SELECT count(*) n FROM machine_agent_runtime_audit WHERE event='runtime_approved'",
          )!.n,
          0,
        );
        assert.equal((await f.request()).data.runtime_mode, "user");
        assert.deepEqual(f.credentials.get("credential"), credentialBefore);
        if (p) {
          const saved = f.db.get<any>(
            "SELECT status,request_id,executor_id FROM machine_agent_runtime_plans WHERE id=?",
            p.id,
          )!;
          assert.deepEqual(saved, {
            status: "awaiting_approval",
            request_id: "",
            executor_id: "",
          });
        } else
          assert.equal(
            f.db.get<any>("SELECT count(*) n FROM machine_agent_runtime_plans")!
              .n,
            0,
          );
      });
});
test("reviewed root/user transitions keep one Agent identity and bind permission generations", async (t) => {
  for (const mode of ["user", "root"] as const)
    await t.test(mode, async (sub) => {
      const f = await fixture(sub, mode),
        p = await f.plan(),
        id = randomUUID();
      assert.equal(p.plan.credential_id, "credential");
      assert.equal(sha256(canonicalJSON(p.plan)), p.revision);
      assert.equal(hasPendingAgentUpdate(f.db, "agent-host", "host"), true);
      const r = await f.apply(p, id);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.data.status, "succeeded");
      assert.equal(
        (await f.request()).data.runtime_mode,
        mode === "user" ? "root" : "user",
      );
      assert.equal((await f.request()).data.permission_generation, 2);
      assert.equal((await f.apply(p, id)).data.status, "succeeded");
      assert.equal(
        f.calls.filter((c) => c.command.includes("runtime-mode.mjs apply"))
          .length,
        1,
      );
      if (mode === "root")
        assert.equal(f.executors.getStatus("host").executor?.state, "revoked");
      else
        assert.equal(f.executors.getStatus("host").executor?.state, "active");
      for (const v of [r.raw, JSON.stringify(p), JSON.stringify(f.logs)])
        assert.ok(!v.includes(SECRET));
    });
});
test("account transitions revalidate reviewed target credential actor and generation after awaited probes", async (t) => {
  for (const stage of ["plan", "apply"])
    for (const scenario of [
      "address",
      "name",
      "agent",
      "credential",
      "actor",
      "generation",
    ])
      await t.test(stage + " " + scenario, async (sub) => {
        const f = await fixture(sub),
          p = stage === "apply" ? await f.plan() : undefined;
        f.onProbe(() => {
          if (scenario === "address")
            f.db.run(
              "UPDATE managed_machines SET address='replacement.test' WHERE id='host'",
            );
          if (scenario === "name")
            f.db.run(
              "UPDATE managed_machines SET name='Replacement' WHERE id='host'",
            );
          if (scenario === "agent")
            f.db.run(
              "UPDATE managed_machines SET agent_id='replacement' WHERE id='host'",
            );
          if (scenario === "credential")
            f.credentials.get("credential").revoked_at = "revoked";
          if (scenario === "actor")
            f.db.run("UPDATE users SET active=0 WHERE id='admin'");
          if (scenario === "generation")
            f.db.run(
              "UPDATE machine_agent_runtime SET permission_generation=2 WHERE machine_id='host'",
            );
        });
        const r = p
          ? await f.apply(p)
          : await f.request("/plans", "POST", { runtime_mode: "root" });
        assert.ok([403, 409].includes(r.status), r.raw);
        assert.equal(
          f.calls.filter((c) => c.command.includes("runtime-mode.mjs apply"))
            .length,
          0,
        );
      });
});
test("ambiguous account change never replays and verified restoration clears only its pending bootstrap", async (t) => {
  const f = await fixture(t),
    p = await f.plan(),
    id = randomUUID();
  f.setApply("throw");
  const r = await f.apply(p, id);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "unknown");
  assert.equal((await f.apply(p, id)).data.status, "unknown");
  assert.equal((await f.apply(p)).status, 409);
  assert.equal(
    f.calls.filter((c) => c.command.includes("runtime-mode.mjs apply")).length,
    1,
  );
  f.advance();
  f.beat("user", 1);
  const verified = await f.request("/plans/" + p.id + "/reconcile", "POST", {});
  assert.equal(verified.status, 200, verified.raw);
  assert.equal(verified.data.status, "failed");
  assert.equal(f.executors.getStatus("host").executor?.state, "revoked");
  assert.equal(hasPendingAgentUpdate(f.db, "agent-host", "host"), false);
  assert.ok(!verified.raw.includes(SECRET));
});
test("bearer clients and non-admins cannot change Agent accounts", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("", "GET", undefined, { authorization: "Bearer mcp" }))
      .status,
    403,
  );
  f.user.role = "member";
  assert.equal(
    (await f.request("/plans", "POST", { runtime_mode: "root" })).status,
    403,
  );
});
test("remote account probe rejects a root identity without its embedded execution channel", () => {
  assert.throws(() =>
    parseRuntimeProbe(
      canonicalJSON({
        runtime_mode: "root",
        permission_generation: 1,
        agent_id: "a",
        uid: 0,
        gid: 0,
        artifact_sha256: "a".repeat(64),
        managed: null,
      }),
    ),
  );
});
test("root runtime refuses the old ordinary job queue before enqueue and claim", async (t) => {
  const f = await fixture(t, "root");
  assert.throws(
    () =>
      f.jobs.enqueue({
        agentID: "agent-host",
        deploymentID: "legacy",
        operationID: "health",
        capabilities: ["health.http"],
        actions: [
          {
            kind: "health_check",
            check: { kind: "http", url: "http://127.0.0.1:8080" },
          },
        ],
      }),
    /root_agent_requires_signed_task/,
  );
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n, 0);
  assert.equal(f.jobs.claim("agent-host", ["health.http"]), null);
});
test("read-only mode reconciliation accepts a new credential without changing the original approval", async (t) => {
  const f = await fixture(t),
    p = await f.plan();
  f.setApply("throw");
  assert.equal((await f.apply(p)).data.status, "unknown");
  f.credentials.get("credential").revoked_at = "revoked";
  f.credentials.set("new-credential", {
    ...f.credentials.get("credential"),
    id: "new-credential",
    revoked_at: "",
    secret: "isolated-new-secret",
    secret_fingerprint: sha256("isolated-new-secret"),
  });
  f.advance();
  f.beat("user", 1);
  const r = await f.request("/plans/" + p.id + "/reconcile", "POST", {
    credential_id: "new-credential",
  });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "failed");
  assert.deepEqual(r.data.plan, p.plan);
  assert.equal(
    f.calls.filter((c) => c.command.includes("runtime-mode.mjs apply")).length,
    1,
  );
  assert.ok(!r.raw.includes("isolated-new-secret"));
});
test("a transient downgraded heartbeat cannot complete a switch without the helper success receipt", async (t) => {
  const f = await fixture(t, "root"),
    p = await f.plan();
  f.setApply("lost");
  const r = await f.apply(p);
  assert.equal(r.data.status, "unknown");
  assert.equal((await f.request("/plans/" + p.id)).data.status, "unknown");
  assert.equal((await f.request()).data.runtime_mode, "root");
  assert.equal(f.executors.getStatus("host").executor?.state, "active");
  assert.equal(
    f.db.get<any>(
      "SELECT receipt_json FROM machine_agent_runtime_plans WHERE id=?",
      p.id,
    )?.receipt_json,
    "{}",
  );
  const { uid, gid, boot_id, artifact_sha256, ...failed } = f.getReceipt();
  f.setReceipt({
    ...failed,
    status: "failed",
    restored: true,
    error: "runtime_change_failed",
  });
  f.advance();
  f.beat("root", 1);
  const restored = await f.request("/plans/" + p.id + "/reconcile", "POST", {});
  assert.equal(restored.status, 200, restored.raw);
  assert.equal(restored.data.status, "failed");
  assert.equal(f.executors.getStatus("host").executor?.state, "active");
});
test("a lost helper response is reconciled only with its bound success receipt and same target boot heartbeat", async (t) => {
  const f = await fixture(t, "root"),
    p = await f.plan();
  f.setApply("lost");
  assert.equal((await f.apply(p)).data.status, "unknown");
  const receipt = f.getReceipt();
  f.setReceipt({ ...receipt, boot_id: "22222222-2222-4222-8222-222222222222" });
  const otherBoot = await f.request(
    "/plans/" + p.id + "/reconcile",
    "POST",
    {},
  );
  assert.equal(otherBoot.status, 200, otherBoot.raw);
  assert.equal(otherBoot.data.status, "unknown");
  assert.equal(f.executors.getStatus("host").executor?.state, "active");
  f.setReceipt(receipt);
  const verified = await f.request("/plans/" + p.id + "/reconcile", "POST", {});
  assert.equal(verified.status, 200, verified.raw);
  assert.equal(verified.data.status, "succeeded");
  assert.equal(f.executors.getStatus("host").executor?.state, "revoked");
  const saved = JSON.parse(
    f.db.get<any>(
      "SELECT receipt_json FROM machine_agent_runtime_plans WHERE id=?",
      p.id,
    )!.receipt_json,
  );
  assert.deepEqual(saved, receipt);
});
test("invalid helper receipts are rejected without persisting remote output or revoking the old identity", async (t) => {
  for (const [key, value] of Object.entries({
    schema: 2,
    operation_id: randomUUID(),
    agent_id: "replacement",
    runtime_mode: "root",
    permission_generation: 3,
    artifact_sha256: "b".repeat(64),
    uid: 0,
    gid: 0,
    boot_id: "bad",
    restored: true,
    error: "private " + SECRET,
    private_key: SECRET,
  }))
    await t.test(key, async (sub) => {
      const f = await fixture(sub, "root"),
        p = await f.plan();
      f.setApply("lost");
      assert.equal((await f.apply(p)).data.status, "unknown");
      f.setReceipt({ ...f.getReceipt(), [key]: value });
      const r = await f.request("/plans/" + p.id + "/reconcile", "POST", {});
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.data.error, "agent_runtime_receipt_mismatch");
      assert.equal((await f.request("/plans/" + p.id)).data.status, "unknown");
      assert.equal(f.executors.getStatus("host").executor?.state, "active");
      assert.equal(
        f.db.get<any>(
          "SELECT receipt_json FROM machine_agent_runtime_plans WHERE id=?",
          p.id,
        )!.receipt_json,
        "{}",
      );
      assert.ok(!r.raw.includes(SECRET));
    });
});
test("invalid successful apply output remains unknown until read-only receipt reconciliation", async (t) => {
  const f = await fixture(t, "root"),
    p = await f.plan();
  f.setApply("mismatch");
  assert.equal((await f.apply(p)).data.status, "unknown");
  assert.equal((await f.request("/plans/" + p.id)).data.status, "unknown");
  assert.equal(f.executors.getStatus("host").executor?.state, "active");
  const r = await f.request("/plans/" + p.id + "/reconcile", "POST", {});
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "succeeded");
  assert.equal(
    f.calls.filter((c) => c.command.includes("runtime-mode.mjs apply")).length,
    1,
  );
});
test("failed switch restoration requires a new remote boot and its exact runtime heartbeat before releasing the fence", async (t) => {
  for (const mismatch of ["old_boot", "different_boot", "uid", "artifact"])
    await t.test(mismatch, async (sub) => {
      const f = await fixture(sub, "root"),
        p = await f.plan();
      f.setApply("throw");
      assert.equal((await f.apply(p)).data.status, "unknown");
      f.advance();
      f.beat("root", 1);
      if (mismatch === "old_boot") {
        f.observation.boot_id = OLD_BOOT;
        f.beat("root", 1, OLD_BOOT);
      }
      if (mismatch === "different_boot")
        f.beat("root", 1, "22222222-2222-4222-8222-222222222222");
      if (mismatch === "uid") f.observation.uid = 1;
      if (mismatch === "artifact") {
        const node = f.db.get<any>(
            "SELECT heartbeat FROM agents WHERE id='agent-host'",
          )!,
          beat = JSON.parse(node.heartbeat);
        beat.release.artifact_sha256 = "b".repeat(64);
        f.db.run(
          "UPDATE agents SET heartbeat=? WHERE id='agent-host'",
          JSON.stringify(beat),
        );
      }
      const r = await f.request("/plans/" + p.id + "/reconcile", "POST", {});
      assert.equal(r.status, 409, r.raw);
      assert.equal((await f.request("/plans/" + p.id)).data.status, "unknown");
      assert.equal(f.executors.getStatus("host").executor?.state, "active");
      assert.equal(hasPendingAgentUpdate(f.db, "agent-host", "host"), true);
    });
});
