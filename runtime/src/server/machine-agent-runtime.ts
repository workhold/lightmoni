import {blockingAgentJobSQL} from './agent-job-fence.js';
import { randomUUID } from "node:crypto";
import {
  canonicalJSON,
  parseStrictJSON,
  sha256,
  PRIVILEGED_CAPABILITIES,
} from "../shared/privileged-executor.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Module } from "../shared/types.js";
import type { AgentUpdateAccess } from "./machine-agent-updates.js";
import type { SSHCheckResult } from "./managed-machines.js";
import { assertSSHAccount, sshAccountSnapshot, sshCredentialRevision } from "./machine-ssh.js";
import type { PrivilegedExecutorStore } from "./privileged-executors.js";
import { hasActiveTaskRuns } from "./agent-hosts.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
import { assertNoPendingMachineUninstallation } from "./machine-uninstallations-guard.js";
import { assertNoDockerInstallation } from "./machine-docker-guard.js";
import {
  pendingAgentRuntime,
  assertNoPendingAgentRuntime,
} from "./machine-agent-runtime-guard.js";
type Row = Record<string, any>;
export type AgentRuntimeMode = "root" | "user";
export const validAgentRuntimeMode = (v: unknown): v is AgentRuntimeMode =>
  v === "root" || v === "user";
export function validAgentRuntimeObservation(
  value: unknown,
): value is {
  mode: AgentRuntimeMode;
  permission_generation: number;
  uid: number;
  gid: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Row;
  return (
    validAgentRuntimeMode(r.mode) &&
    Number.isSafeInteger(r.permission_generation) &&
    r.permission_generation > 0 &&
    Number.isSafeInteger(r.uid) &&
    Number.isSafeInteger(r.gid) &&
    r.uid > 0 && r.gid > 0
  );
}
const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const credentialRevision = sshCredentialRevision;
const table = (d: Dependencies, n: string) =>
  !!d.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", n);
export function createAgentRuntimeSchema(d: Dependencies) {
  d.db
    .exec(`CREATE TABLE IF NOT EXISTS machine_agent_runtime(machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,runtime_mode TEXT NOT NULL,permission_generation INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS machine_agent_runtime_plans(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,status TEXT NOT NULL,revision TEXT NOT NULL,plan_json TEXT NOT NULL,request_id TEXT NOT NULL DEFAULT '',executor_id TEXT NOT NULL DEFAULT '',executor_generation INTEGER NOT NULL DEFAULT 0,executor_policy_generation INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',receipt_json TEXT NOT NULL DEFAULT '{}');
 CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_lane ON machine_agent_runtime_plans(machine_id) WHERE status IN ('awaiting_approval','running','verifying','unknown');
 CREATE TABLE IF NOT EXISTS machine_agent_runtime_audit(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL,detail_json TEXT NOT NULL);`);
  const columns=d.db.all<{name:string}>("PRAGMA table_info(machine_agent_runtime_plans)").map(column=>column.name);
  if(!columns.includes("executor_generation"))d.db.exec("ALTER TABLE machine_agent_runtime_plans ADD COLUMN executor_generation INTEGER NOT NULL DEFAULT 0");
  if(!columns.includes("executor_policy_generation"))d.db.exec("ALTER TABLE machine_agent_runtime_plans ADD COLUMN executor_policy_generation INTEGER NOT NULL DEFAULT 0");
}
export function recordAgentRuntime(
  d: Dependencies,
  machineID: string,
  agentID: string,
  mode: AgentRuntimeMode,
  generation: number,
) {
  if (
    !validAgentRuntimeMode(mode) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    fail(400, "invalid_agent_runtime");
  d.db.run(
    "INSERT INTO machine_agent_runtime VALUES(?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET agent_id=excluded.agent_id,runtime_mode=excluded.runtime_mode,permission_generation=excluded.permission_generation,updated_at=excluded.updated_at",
    machineID,
    agentID,
    mode,
    generation,
    d.now().toISOString(),
  );
}
export function agentRuntimeState(d: Dependencies, machineID: string) {
  const h = d.db.get<Row>(
    "SELECT agent_id FROM managed_machines WHERE id=?",
    machineID,
  );
  if (!h) fail(404, "host_not_found");
  const saved = d.db.get<Row>(
    "SELECT * FROM machine_agent_runtime WHERE machine_id=? AND agent_id=?",
    machineID,
    h.agent_id,
  );
  const node = table(d, "agents")
    ? d.db.get<Row>(
        "SELECT last_seen,heartbeat FROM agents WHERE id=?",
        h.agent_id,
      )
    : undefined;
  let heartbeat: Row = {};
  try {
    heartbeat = JSON.parse(node?.heartbeat ?? "{}");
  } catch {}
  const r = heartbeat.runtime;
  const observed = validAgentRuntimeObservation(r)
    ? {
        mode: r.mode,
        permission_generation: r.permission_generation,
        uid: r.uid,
        gid: r.gid,
      }
    : null;
  return {
    machine_id: machineID,
    agent_id: h.agent_id,
    runtime_mode: saved?.runtime_mode ?? observed?.mode ?? null,
    permission_generation:
      saved?.permission_generation ?? observed?.permission_generation ?? 0,
    observed_runtime: observed,
    online: !!node && Date.parse(node.last_seen) > d.now().getTime() - 90_000,
    heartbeat,
    observed_at: node?.last_seen ?? "",
  };
}
export function agentRuntimeCommand(
  action: "probe" | "apply" | "status",
  operationID = "",
) {
  if (operationID && !/^[a-f0-9-]{36}$/.test(operationID))
    throw Error("invalid_runtime_operation_id");
  const script =
    "set -eu\nPATH=/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\n" +
    (action === "status"
      ? "printf %s " + q(canonicalJSON({ operation_id: operationID })) + " | "
      : "") +
    "/opt/lightmoni-agent/current/node /opt/lightmoni-agent/current/runtime-mode.mjs " +
    action;
  return (
    'if [ "$(id -u)" = 0 ]; then /bin/sh -c ' +
    q(script) +
    "; else sudo -n /bin/sh -c " +
    q(script) +
    "; fi"
  );
}
export function parseRuntimeProbe(raw: string): Row {
  let v: Row;
  try {
    v = parseStrictJSON(raw, 32 << 10);
  } catch {
    fail(409, "invalid_agent_runtime_probe");
  }
  if (
    !v ||
    Array.isArray(v) ||
    !validAgentRuntimeMode(v.runtime_mode) ||
    !Number.isSafeInteger(v.permission_generation) ||
    v.permission_generation < 1 ||
    typeof v.agent_id !== "string" ||
    !v.agent_id ||
    typeof v.boot_id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(v.boot_id) ||
    !Number.isSafeInteger(v.uid) ||
    !Number.isSafeInteger(v.gid) ||
    v.uid <= 0 || v.gid <= 0 ||
    !/^([a-f0-9]{64})$/.test(v.artifact_sha256 ?? "")
  )
    fail(409, "invalid_agent_runtime_probe");
  if (
    v.managed &&
    (typeof v.managed.executor_id !== "string" ||
      !v.managed.executor_id ||
      !Number.isSafeInteger(v.managed.install_generation) ||
      v.managed.install_generation < 1 ||
      v.managed.fenced ||
      v.managed.pending_results !== 0)
  )
    fail(409, "managed_execution_requires_reconciliation");
  if (
    (v.runtime_mode === "root" && !v.managed) ||
    (v.runtime_mode === "user" && v.managed)
  )
    fail(409, "agent_runtime_execution_identity_mismatch");
  return v;
}
function parseRuntimeReceipt(raw: string, r: Row): Row {
      const p = JSON.parse(r.plan_json);
  let v: Row;
  try {
    v = parseStrictJSON(raw, 32 << 10);
  } catch {
    fail(409, "agent_runtime_receipt_mismatch");
  }
  const base = [
      "schema",
      "operation_id",
      "agent_id",
      "runtime_mode",
      "permission_generation",
      "status",
      "restored",
      "error",
    ],
    success = ["uid", "gid", "boot_id", "artifact_sha256"];
  if (
    !v ||
    Array.isArray(v) ||
    typeof v !== "object" ||
    Object.keys(v).some((k) => ![...base, ...success].includes(k)) ||
    base.some((k) => !Object.hasOwn(v, k)) ||
    v.schema !== 1 ||
    v.operation_id !== r.id ||
    v.agent_id !== r.agent_id ||
    v.runtime_mode !== p.runtime_mode ||
    v.permission_generation !== p.permission_generation ||
    !["succeeded", "failed", "unknown", "running"].includes(v.status) ||
    typeof v.restored !== "boolean" ||
    typeof v.error !== "string" ||
    !/^([a-z0-9_]{1,128})?$/.test(v.error)
  )
    fail(409, "agent_runtime_receipt_mismatch");
  const result = {
    schema: 1,
    operation_id: r.id,
    agent_id: r.agent_id,
    runtime_mode: p.runtime_mode,
    permission_generation: p.permission_generation,
    status: v.status,
    restored: v.restored,
    error: v.error,
  };
  if (v.status !== "succeeded") {
    if (success.some((k) => Object.hasOwn(v, k)))
      fail(409, "agent_runtime_receipt_mismatch");
    return result;
  }
  if (
    v.restored ||
    v.error !== "" ||
    !Number.isSafeInteger(v.uid) ||
    !Number.isSafeInteger(v.gid) ||
    v.uid <= 0 || v.gid <= 0 ||
    typeof v.boot_id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(v.boot_id) ||
    v.boot_id === p.previous_boot_id ||
    v.artifact_sha256 !== p.release.artifact_sha256
  )
    fail(409, "agent_runtime_receipt_mismatch");
  return {
    ...result,
    uid: v.uid,
    gid: v.gid,
    boot_id: v.boot_id,
    artifact_sha256: v.artifact_sha256,
  };
}
interface Access extends AgentUpdateAccess {
  check(
    machineID: string,
    input: { credential_id?: string },
    actor: string,
    signal: AbortSignal,
  ): Promise<SSHCheckResult>;
}
export function registerMachineAgentRuntime(
  d: Dependencies,
  access: Access,
  executors: PrivilegedExecutorStore,
): Module {
  createAgentRuntimeSchema(d);
  const { db, router } = d,
    at = () => d.now().toISOString(),
    controller = new AbortController();
  db.run(
    "UPDATE machine_agent_runtime_plans SET status='unknown',error='平台在运行权限切换期间重启，请只读核对，不自动重放' WHERE status IN ('running','verifying')",
  );
  const human = (c: Context) => {
    d.auth.requireAdmin(c);
    if (
      c.req.headers.authorization ||
      !c.req.headers.cookie
        ?.split(";")
        .some((p) => p.trim().startsWith("lm_session=")) ||
      d.auth.user(c.req)?.id !== c.user.id ||
      !db.get(
        "SELECT id FROM users WHERE id=? AND role='admin' AND active=1",
        c.user.id,
      )
    )
      fail(403, "human_admin_session_required");
  };
  const actor = (id: string) => {
    if (
      !db.get(
        "SELECT id FROM users WHERE id=? AND role='admin' AND active=1",
        id,
      )
    )
      fail(403, "active_human_admin_required");
  };
  const audit = (
    machine: string,
    op: string,
    who: string,
    event: string,
    detail: Row = {},
  ) =>
    db.run(
      "INSERT INTO machine_agent_runtime_audit VALUES(?,?,?,?,?,?,?)",
      randomUUID(),
      machine,
      op,
      who,
      event,
      at(),
      canonicalJSON(detail),
    );
  const fields = (v: unknown, keys: string[]) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => !keys.includes(k))
    )
      fail(400, "invalid_agent_runtime_request");
    return v as Row;
  };
  const row = (machine: string, id: string) => {
    const r = db.get<Row>(
      "SELECT * FROM machine_agent_runtime_plans WHERE machine_id=? AND id=?",
      machine,
      id,
    );
    if (!r) fail(404, "agent_runtime_plan_not_found");
    return r;
  };
  const view = (r: Row) => ({
    id: r.id,
    status: r.status,
    revision: r.revision,
    expires_at: r.expires_at,
    plan: JSON.parse(r.plan_json),
    error: r.error,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
  });
  const idle = (machineID: string, agentID: string, exclude = "") => {
    assertNoPendingAgentRuntime(db, machineID, agentID, exclude);
    if (
      table(d, "machine_agent_updates") &&
      db.get(
        "SELECT id FROM machine_agent_updates WHERE machine_id=? AND status IN ('awaiting_approval','running','verifying','unknown') LIMIT 1",
        machineID,
      )
    )
      fail(409, "agent_update_pending");
    assertNoPendingMachineInstallation(db, machineID, agentID, true);
    assertNoPendingMachineUninstallation(db, machineID, agentID);
    assertNoDockerInstallation(db, machineID, agentID);
    if (
      hasActiveTaskRuns(db, agentID, machineID) ||
      (table(d, "agent_jobs") &&
        db.get(
          `SELECT id FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)} LIMIT 1`,
          agentID,
        )) ||
      (table(d, "privileged_jobs") &&
        db.get(
          "SELECT id FROM privileged_jobs WHERE machine_id=? AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='')) LIMIT 1",
          machineID,
        ))
    )
      fail(409, "machine_execution_locked");
  };
  const ssh = async (
    machine: Row,
    credential: Row,
    command: string,
    signal: AbortSignal,
    stdin?: string,
  ) => {
    const selected = access.credential(machine.id, credential.id);
    if (machine.account_id) assertSSHAccount(selected.machine, sshAccountSnapshot(machine as any));
    if (credentialRevision(selected.credential) !== credentialRevision(credential)) fail(409, "ssh_credential_changed");
    const out = await access.runner({
      machine: selected.machine,
      credentialID: credential.id,
      ...access.authentication(machine.id, credential),
      command,
      port: machine.port,
      signal: AbortSignal.any([controller.signal, signal]),
      timeoutMs: 180000,
      ...(stdin ? { stdin } : {}),
    });
    access.markCredentialUsed(credential.id);
    const verified = access.credential(machine.id, credential.id);
    assertSSHAccount(verified.machine, sshAccountSnapshot(selected.machine));
    if (credentialRevision(verified.credential) !== credentialRevision(credential)) fail(409, "ssh_credential_changed");
    return out;
  };
  const assertTarget = (r: Row, requireCredential = true) => {
    const p = JSON.parse(r.plan_json),
      m = access.get(r.machine_id),
      selected = requireCredential ? access.credential(r.machine_id, r.credential_id) : undefined,
      c = selected?.credential ?? {},
      s = agentRuntimeState(d, m.id);
    actor(r.created_by);
    if (selected) assertSSHAccount(selected.machine, p.ssh_account);
    if (
      access.revision(m) !== p.target_revision ||
      m.name !== p.machine.name ||
      m.agent_id !== r.agent_id ||
      (requireCredential && credentialRevision(c) !== p.credential_revision) ||
      s.runtime_mode !== p.from_mode ||
      s.permission_generation !== p.previous_generation
    )
      fail(409, "agent_runtime_target_changed");
    if (p.from_mode === "root") {
      const e = executors.getStatus(m.id);
      if (
        !e.executor ||
        e.executor.id !== p.execution_identity?.executor_id ||
        e.executor.install_generation !==
          p.execution_identity?.install_generation ||
        e.policy_generation !== p.execution_identity?.policy_generation ||
        r.executor_id !== p.execution_identity?.executor_id ||
        r.executor_generation !== p.execution_identity?.install_generation ||
        r.executor_policy_generation !== p.execution_identity?.policy_generation
      )
        fail(409, "agent_runtime_execution_identity_changed");
    }
    return { m: selected?.machine ?? m, c, p };
  };
  const refresh = (r: Row) => {
    if (!["verifying", "unknown"].includes(r.status)) return r;
    let receipt: Row;
    try {
      assertTarget(r, false);
      receipt = parseRuntimeReceipt(r.receipt_json, r);
      if (receipt.status !== "succeeded") return r;
    } catch {
      return r;
    }
    const p = JSON.parse(r.plan_json),
      s = agentRuntimeState(d, r.machine_id),
      o = s.observed_runtime;
    if (
      o &&
      s.agent_id === r.agent_id &&
      s.online &&
      Date.parse(s.observed_at) >= Date.parse(r.started_at) &&
      o.mode === p.runtime_mode &&
      o.permission_generation === p.permission_generation &&
      o.uid === receipt.uid &&
      o.gid === receipt.gid &&
      s.heartbeat.boot_id === receipt.boot_id &&
      s.heartbeat.release?.artifact_sha256 === p.release.artifact_sha256
    ) {
      if (p.runtime_mode === "root") {
        const e = executors.getStatus(r.machine_id).executor;
        const task = e?.ordinary_task_identity;
        if (!e || e.id !== r.executor_id || !e.online
          || e.install_generation !== r.executor_generation
          || executors.getStatus(r.machine_id).policy_generation !== r.executor_policy_generation
          || e.release?.artifact_sha256 !== p.release.artifact_sha256 || e.release?.state_schema !== 1
          || e.release?.build_id !== p.release.build_id || e.release?.source_revision !== p.release.source_revision
          || task?.account !== "lightmoni-agent" || task.permission_generation !== p.permission_generation
          || !Number.isSafeInteger(task.uid) || task.uid <= 0
          || !Number.isSafeInteger(task.gid) || task.gid <= 0) return r;
      }
      db.transaction(() => {
        const current = row(r.machine_id, r.id);
        if (!["verifying", "unknown"].includes(current.status)) return;
        assertTarget(current, false);
        if (p.runtime_mode === "user")
          executors.revokeUnifiedRuntime(r.machine_id, r.created_by, r.id);
        recordAgentRuntime(
          d,
          r.machine_id,
          r.agent_id,
          p.runtime_mode,
          p.permission_generation,
        );
        db.run(
          "UPDATE machine_agent_runtime_plans SET status='succeeded',finished_at=?,error='' WHERE id=?",
          at(),
          r.id,
        );
        audit(r.machine_id, r.id, r.created_by, "runtime_verified", {
          runtime_mode: p.runtime_mode,
          permission_generation: p.permission_generation,
          uid: o.uid,
          gid: o.gid,
        });
      });
    }
    return row(r.machine_id, r.id);
  };
  const path = "/api/v1/machines/:id/agent-runtime";
  router.get(
    path,
    access.safe((c) => {
      human(c);
      access.get(c.params.id);
      const pending = pendingAgentRuntime(db, c.params.id);
      const active = pending
        ? view(refresh(row(c.params.id, pending.id)))
        : null;
      const { heartbeat, observed_at, ...s } = agentRuntimeState(
        d,
        c.params.id,
      );
      c.json({ ...s, maintenance: active });
    }),
  );
  router.get(
    path + "/plans",
    access.safe((c) => {
      human(c);
      access.get(c.params.id);
      c.json(
        db
          .all<Row>(
            "SELECT * FROM machine_agent_runtime_plans WHERE machine_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
            c.params.id,
          )
          .map((r) => view(refresh(r))),
      );
    }),
  );
  router.get(
    path + "/plans/:planId",
    access.safe((c) => {
      human(c);
      c.json(view(refresh(row(c.params.id, c.params.planId))));
    }),
  );
  router.post(
    path + "/plans",
    access.safe(async (c) => {
      human(c);
      const input = fields(await c.body(), ["runtime_mode", "credential_id"]);
      if (
        !validAgentRuntimeMode(input.runtime_mode) ||
        (input.credential_id !== undefined &&
          (typeof input.credential_id !== "string" || !input.credential_id))
      )
        fail(400, "invalid_agent_runtime_request");
      access.idle(c.params.id);
      const machine = access.get(c.params.id);
      idle(machine.id, machine.agent_id);
      const state = agentRuntimeState(d, machine.id);
      if (
        !state.online ||
        !state.observed_runtime ||
        !state.runtime_mode ||
        state.observed_runtime.mode !== state.runtime_mode ||
        state.observed_runtime.permission_generation !==
          state.permission_generation
      )
        fail(409, "agent_runtime_unverified_upgrade_required");
      if (state.runtime_mode === input.runtime_mode)
        fail(409, "agent_runtime_already_selected");
      const check = await access.check(
        machine.id,
        { credential_id: input.credential_id },
        c.user.id,
        c.signal,
      );
      if (
        !check.ready ||
        !["root", "sudo_noninteractive"].includes(check.privilege.state)
      )
        { c.json({ error:"root_or_sudo_ssh_required",preflight:check },409); return; }
      const selected = access.credential(machine.id, check.credential_id);
      idle(machine.id, machine.agent_id);
      if (
        access.revision(selected.machine) !== access.revision(machine) ||
        selected.machine.agent_id !== machine.agent_id ||
        selected.machine.name !== machine.name
      )
        fail(409, "agent_runtime_target_changed");
      access.busy.add(machine.id);
      try {
        const observed = parseRuntimeProbe(
          (
            await ssh(
              selected.machine,
              selected.credential,
              agentRuntimeCommand("probe"),
              c.signal,
            )
          ).stdout,
        );
        if (
          observed.agent_id !== machine.agent_id ||
          observed.runtime_mode !== state.runtime_mode ||
          observed.permission_generation !== state.permission_generation ||
          state.heartbeat.boot_id !== observed.boot_id
        )
          fail(409, "agent_runtime_target_changed");
        const liveCredential = access.credential(
          machine.id,
          selected.credential.id,
        ).credential;
        actor(c.user.id);
        idle(machine.id, machine.agent_id);
        const currentState = agentRuntimeState(d, machine.id);
        if (
          credentialRevision(liveCredential) !==
            credentialRevision(selected.credential) ||
          access.revision(access.get(machine.id)) !==
            access.revision(machine) ||
          access.get(machine.id).agent_id !== machine.agent_id ||
          access.get(machine.id).name !== machine.name ||
          currentState.runtime_mode !== state.runtime_mode ||
          currentState.permission_generation !== state.permission_generation
        )
          fail(409, "agent_runtime_target_changed");
        const execution = executors.getStatus(machine.id);
        if (
          state.runtime_mode === "root" &&
          (!execution.executor ||
            execution.executor.state !== "active" ||
            observed.managed.executor_id !== execution.executor.id ||
            observed.managed.install_generation !==
              execution.executor.install_generation)
        )
          fail(409, "agent_runtime_execution_identity_changed");
        const currentRelease=state.heartbeat.release;
        if(!currentRelease||currentRelease.artifact_sha256!==observed.artifact_sha256||currentRelease.state_schema!==1
          ||!/^([a-f0-9]{40})$/.test(currentRelease.source_revision??"")||typeof currentRelease.build_id!=="string"||!currentRelease.build_id)
          fail(409,"agent_runtime_release_unverified");
        const id = randomUUID(),
          expires = new Date(d.now().getTime() + 300000).toISOString(),
          plan = {
            machine: {
              id: machine.id,
              name: machine.name,
              agent_id: machine.agent_id,
            },
            from_mode: state.runtime_mode,
            runtime_mode: input.runtime_mode,
            previous_generation: state.permission_generation,
            previous_boot_id: observed.boot_id,
            permission_generation: state.permission_generation + 1,
            release: { build_id:currentRelease.build_id,source_revision:currentRelease.source_revision,
              artifact_sha256:currentRelease.artifact_sha256,state_schema:currentRelease.state_schema },
            target_revision: access.revision(machine),
            ssh_account: sshAccountSnapshot(selected.machine),
            credential_id: selected.credential.id,
            credential_revision: credentialRevision(selected.credential),
            capabilities:
              input.runtime_mode === "root" ? [...PRIVILEGED_CAPABILITIES] : [],
            expires_at: expires,
            steps: [
              "核验 SSH 身份、固定发行和当前账户",
              "暂停新任务并复核执行结果；等待遥测队列全部发送",
              "常驻 Agent 始终以非 root 账户运行；按目标模式安装或移除同版本 root 管理组件",
              "验证 Agent 身份、管理组件发行摘要、任务账户、权限代次和新鲜心跳",
            ],
            warnings: [
              "普通脚本仍以专用普通账户执行；root任务继续逐任务授权和审计。",
              "切换前遥测队列必须为空；原普通账户缓存会隔离，不作为root可信状态直接读取。",
              "SSH 登录账户只用于本次受审阅的维护；不会改变常驻 Agent 的运行账户。",
            ],
          };
        const approvedPlan = {
          ...plan,
          execution_identity:
            state.runtime_mode === "root"
              ? {
                  executor_id: execution.executor!.id,
                  install_generation: execution.executor!.install_generation,
                  policy_generation: execution.policy_generation,
                }
              : null,
        };
        db.transaction(() => {
          idle(machine.id, machine.agent_id);
          db.run(
            "INSERT INTO machine_agent_runtime_plans(id,machine_id,agent_id,credential_id,status,revision,plan_json,executor_id,executor_generation,executor_policy_generation,created_by,created_at,expires_at) VALUES(?,?,?,?,'awaiting_approval',?,?,?,?,?,?,?,?)",
            id,
            machine.id,
            machine.agent_id,
            selected.credential.id,
            sha256(canonicalJSON(approvedPlan)),
            canonicalJSON(approvedPlan),
            execution.executor?.id ?? "",
            execution.executor?.install_generation ?? 0,
            execution.executor ? execution.policy_generation : 0,
            c.user.id,
            at(),
            expires,
          );
          audit(machine.id, id, c.user.id, "runtime_plan_created", {
            from_mode: plan.from_mode,
            runtime_mode: plan.runtime_mode,
            permission_generation: plan.permission_generation,
            ssh_account: plan.ssh_account,
          });
        });
        c.json(view(row(machine.id, id)), 201);
      } finally {
        access.busy.delete(machine.id);
      }
    }),
  );
  router.post(
    path + "/plans/:planId/cancel",
    access.safe(async (c) => {
      human(c);
      const input = fields(await c.body(), ["confirm"]);
      if (input.confirm !== true) fail(400, "explicit_confirmation_required");
      const r = row(c.params.id, c.params.planId);
      if (r.status !== "awaiting_approval")
        fail(409, "agent_runtime_already_dispatched");
      db.run(
        "UPDATE machine_agent_runtime_plans SET status='cancelled',finished_at=? WHERE id=? AND status='awaiting_approval'",
        at(),
        r.id,
      );
      audit(r.machine_id, r.id, c.user.id, "runtime_plan_cancelled");
      c.json(view(row(r.machine_id, r.id)));
    }),
  );
  router.post(
    path + "/plans/:planId/reconcile",
    access.safe(async (c) => {
      human(c);
      const input = fields(await c.body(), ["credential_id"]);
      if (
        input.credential_id !== undefined &&
        (typeof input.credential_id !== "string" || !input.credential_id)
      )
        fail(400, "invalid_credential_id");
      let r = refresh(row(c.params.id, c.params.planId));
      if (r.status === "succeeded") {
        c.json(view(r));
        return;
      }
      if (r.status !== "unknown") fail(409, "unknown_agent_runtime_required");
      access.idle(r.machine_id);
      const target = assertTarget(r, false);
      const selected = access.credential(r.machine_id, input.credential_id ?? r.credential_id);
      target.m = selected.machine;
      target.c = selected.credential;
      const verifyingAccount = sshAccountSnapshot(selected.machine);
      const selectedRevision = credentialRevision(selected.credential),
        recheck = () => {
          assertTarget(r, false);
          assertSSHAccount(access.credential(r.machine_id, selected.credential.id).machine, verifyingAccount);
          if (
            credentialRevision(
              access.credential(r.machine_id, selected.credential.id)
                .credential,
            ) !== selectedRevision
          )
            fail(409, "reconciliation_credential_changed");
          idle(r.machine_id, r.agent_id, r.id);
        };
      recheck();
      audit(r.machine_id, r.id, c.user.id, "runtime_reconciliation_started", { approved_ssh_account: target.p.ssh_account, verification_ssh_account: verifyingAccount, credential_id: selected.credential.id, credential_revision: selectedRevision });
      access.busy.add(r.machine_id);
      try {
        const receipt = parseRuntimeReceipt(
          (
            await ssh(
              target.m,
              target.c,
              agentRuntimeCommand("status", r.id),
              c.signal,
            )
          ).stdout,
          r,
        );
        recheck();
        if (receipt.status === "succeeded")
          db.run(
            "UPDATE machine_agent_runtime_plans SET receipt_json=? WHERE id=? AND status='unknown'",
            canonicalJSON(receipt),
            r.id,
          );
        r = refresh(row(r.machine_id, r.id));
        if (r.status === "succeeded") {
          c.json(view(r));
          return;
        }
        if (receipt.status === "failed" && receipt.restored === true) {
          const probe = parseRuntimeProbe(
            (
              await ssh(
                target.m,
                target.c,
                agentRuntimeCommand("probe"),
                c.signal,
              )
            ).stdout,
          );
          recheck();
          const s = agentRuntimeState(d, r.machine_id),
            o = s.observed_runtime;
          if (
            probe.agent_id !== r.agent_id ||
            probe.runtime_mode !== target.p.from_mode ||
            probe.permission_generation !== target.p.previous_generation ||
            probe.boot_id === target.p.previous_boot_id ||
            probe.artifact_sha256 !== target.p.release.artifact_sha256 ||
            !s.online ||
            !o ||
            o.mode !== target.p.from_mode ||
            o.permission_generation !== target.p.previous_generation ||
            o.uid !== probe.uid ||
            o.gid !== probe.gid ||
            s.heartbeat.boot_id !== probe.boot_id ||
            s.heartbeat.release?.artifact_sha256 !==
              target.p.release.artifact_sha256 ||
            Date.parse(s.observed_at) < Date.parse(r.started_at)
          )
            fail(409, "agent_runtime_restoration_unverified");
          db.transaction(() => {
            const current = row(r.machine_id, r.id);
            if (current.status !== "unknown")
              fail(409, "agent_runtime_plan_changed");
            assertTarget(current, false);
            if (target.p.runtime_mode === "root")
              executors.revokeFailedUnifiedBootstrap(
                r.machine_id,
                r.created_by,
                r.id,
              );
            db.run(
              "UPDATE machine_agent_runtime_plans SET status='failed',finished_at=?,error='已只读核对切换失败且恢复原账户；重新切换须创建新计划',receipt_json=? WHERE id=?",
              at(),
              canonicalJSON({
                restored: true,
                verified_at: at(),
                runtime_mode: target.p.from_mode,
                permission_generation: target.p.previous_generation,
              }),
              r.id,
            );
            audit(
              r.machine_id,
              r.id,
              c.user.id,
              "runtime_restoration_verified",
              {
                runtime_mode: target.p.from_mode,
                permission_generation: target.p.previous_generation,
              },
            );
          });
        }
        c.json(view(row(r.machine_id, r.id)));
      } finally {
        access.busy.delete(r.machine_id);
      }
    }),
  );
  router.post(
    path + "/plans/:planId/apply",
    access.safe(async (c) => {
      human(c);
      const input = fields(await c.body(), [
        "confirm",
        "expected_revision",
        "request_id",
      ]);
      if (
        input.confirm !== true ||
        typeof input.request_id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.request_id)
      )
        fail(400, "explicit_confirmation_and_request_id_required");
      const r = row(c.params.id, c.params.planId);
      const reviewedPlan=JSON.parse(r.plan_json);
      if (
        input.expected_revision !== r.revision ||
        sha256(canonicalJSON(reviewedPlan)) !== r.revision
      )
        fail(409, "agent_runtime_plan_changed");
      if (r.request_id) {
        if (r.request_id !== input.request_id)
          fail(409, "agent_runtime_replay_conflict");
        c.json(view(refresh(r)));
        return;
      }
      if (r.status !== "awaiting_approval" || r.expires_at <= at())
        fail(409, "agent_runtime_plan_expired");
      access.idle(r.machine_id);
      idle(r.machine_id, r.agent_id, r.id);
      let target = assertTarget(r);
      const check = await access.check(
        r.machine_id,
        { credential_id: r.credential_id },
        c.user.id,
        c.signal,
      );
      if (
        !check.ready ||
        !["root", "sudo_noninteractive"].includes(check.privilege.state)
      )
        { c.json({ error:"root_or_sudo_ssh_required",preflight:check },409); return; }
      target = assertTarget(r);
      idle(r.machine_id, r.agent_id, r.id);
      access.busy.add(r.machine_id);
      let dispatched = false;
      try {
        const observation = parseRuntimeProbe(
          (
            await ssh(
              target.m,
              target.c,
              agentRuntimeCommand("probe"),
              c.signal,
            )
          ).stdout,
        );
        if (
          observation.agent_id !== r.agent_id ||
          observation.runtime_mode !== target.p.from_mode ||
          observation.permission_generation !== target.p.previous_generation ||
          observation.boot_id !== target.p.previous_boot_id ||
          observation.artifact_sha256 !== target.p.release.artifact_sha256
        )
          fail(409, "agent_runtime_target_changed");
        if (
          target.p.from_mode === "root" &&
          (observation.managed?.executor_id !==
            target.p.execution_identity?.executor_id ||
            observation.managed?.install_generation !==
              target.p.execution_identity?.install_generation ||
            r.executor_id !== target.p.execution_identity?.executor_id ||
            r.executor_generation !== target.p.execution_identity?.install_generation ||
            r.executor_policy_generation !== target.p.execution_identity?.policy_generation)
        )
          fail(409, "agent_runtime_execution_identity_changed");
        target = assertTarget(r);
        idle(r.machine_id, r.agent_id, r.id);
        let managed: unknown;
        db.transaction(() => {
          const changed = db.run(
            "UPDATE machine_agent_runtime_plans SET status='running',request_id=?,started_at=? WHERE id=? AND status='awaiting_approval' AND request_id=''",
            input.request_id,
            at(),
            r.id,
          );
          if (!changed.changes) fail(409, "agent_runtime_already_dispatched");
          if (target.p.runtime_mode === "root") {
            managed = executors.issueUnifiedBootstrap(r.machine_id, c.user.id, {
              runtime_plan_id: r.id,
            });
            db.run(
              "UPDATE machine_agent_runtime_plans SET executor_id=?,executor_generation=?,executor_policy_generation=? WHERE id=?",
              (managed as Row).executor_id,
              (managed as Row).install_generation,
              (managed as Row).local_policy.generation,
              r.id,
            );
          }
          audit(r.machine_id, r.id, c.user.id, "runtime_approved", {
            from_mode: target.p.from_mode,
            runtime_mode: target.p.runtime_mode,
            permission_generation: target.p.permission_generation,
            capabilities: target.p.capabilities,
            ssh_account: target.p.ssh_account,
          });
        });
        const payload = {
          schema: 1,
          operation_id: r.id,
          agent_id: r.agent_id,
          from_mode: target.p.from_mode,
          runtime_mode: target.p.runtime_mode,
          previous_generation: target.p.previous_generation,
          permission_generation: target.p.permission_generation,
          artifact_sha256: target.p.release.artifact_sha256,
          endpoint: new URL(d.externalURL).origin,
          ...(managed ? { managed_bootstrap: managed } : {}),
        };
        dispatched = true;
        const output = await ssh(
          target.m,
          target.c,
          agentRuntimeCommand("apply"),
          c.signal,
          canonicalJSON(payload) + "\n",
        );
        managed = undefined;
        const receipt = parseRuntimeReceipt(output.stdout, r);
        if (receipt.status !== "succeeded")
          fail(409, "agent_runtime_receipt_mismatch");
        db.run(
          "UPDATE machine_agent_runtime_plans SET status='verifying',error='',receipt_json=? WHERE id=? AND status='running'",
          canonicalJSON(receipt),
          r.id,
        );
        audit(r.machine_id, r.id, c.user.id, "runtime_dispatched");
        c.json(view(refresh(row(r.machine_id, r.id))));
      } catch (error) {
        if (dispatched) {
          db.run(
            "UPDATE machine_agent_runtime_plans SET status='unknown',error='运行权限切换结果待核对；不会自动重放' WHERE id=? AND status IN ('running','verifying')",
            r.id,
          );
          audit(r.machine_id, r.id, c.user.id, "runtime_unknown");
          c.json(view(row(r.machine_id, r.id)));
        } else {
          if (row(r.machine_id, r.id).status === "running")
            db.run(
              "UPDATE machine_agent_runtime_plans SET status='failed',finished_at=?,error='切换派发前检查失败' WHERE id=?",
              at(),
              r.id,
            );
          throw error;
        }
      } finally {
        access.busy.delete(r.machine_id);
      }
    }),
  );
  return {
    close() {
      controller.abort();
    },
  };
}
