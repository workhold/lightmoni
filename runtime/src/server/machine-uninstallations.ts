import { hasActiveTaskRuns } from "./agent-hosts.js";
import { id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler } from "../shared/types.js";
import { agentProbeCommand, agentUninstallCommand, parseAgentProbe, retainedAgentPaths, removedAgentPaths } from "./machine-agent-lifecycle.js";
import type { MachineSummary, SSHCheckResult } from "./managed-machines.js";
import type { SSHRunner } from "./machine-ssh.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
export type UninstallationStatus = "awaiting_approval" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
interface Access {
  get(id: string): MachineSummary; idle(id: string): void; revision(machine: MachineSummary): string;
  checked(machine: MachineSummary, checkID: string, credentialID?: string): SSHCheckResult;
  credential(machineID: string, credentialID?: string): { machine: MachineSummary; credential: any };
  authentication(machineID: string, credential: any): { privateKey: string; password?: string };
  busy: Set<string>; runner: SSHRunner;
  safe(handler: Handler): Handler;
}
export function createUninstallationSchema(deps: Dependencies) {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_uninstallations(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,status TEXT NOT NULL,plan_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT '',started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT ''
  ); CREATE INDEX IF NOT EXISTS machine_uninstallations_machine ON machine_uninstallations(machine_id,created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS machine_uninstallations_node_lane ON machine_uninstallations(agent_id) WHERE status IN ('awaiting_approval','running','unknown');`);
  // A process restart cannot establish whether a destructive remote command ran.
  deps.db.run("UPDATE machine_uninstallations SET status='unknown',error='平台在卸载期间重启，请核对远端结果' WHERE status='running'");
}
export function registerMachineUninstallations(deps: Dependencies, access: Access) {
  const { db, router } = deps;
  const at = () => deps.now().toISOString();
  const table = (name: string) => Boolean(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  const taskBusy = (agentID: string) => hasActiveTaskRuns(db, agentID) || Boolean(agentID && table("agent_jobs") && db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state IN ('queued','leased','accepted','preflighting','staging','activating','verifying','unknown') LIMIT 1", agentID));
  const pending = (machineID: string) => db.get<{status: UninstallationStatus}>("SELECT status FROM machine_uninstallations WHERE machine_id=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", machineID);
  const assertFree = (machineID: string) => { if (pending(machineID)) fail(409, "此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对"); };
  const decode = (row: any) => ({ ...row, plan: JSON.parse(row.plan_json), receipt: JSON.parse(row.receipt_json), plan_json: undefined, receipt_json: undefined });
  const list = (machineID: string) => db.all<any>("SELECT * FROM machine_uninstallations WHERE machine_id=? ORDER BY created_at DESC,id DESC LIMIT 100", machineID).map(decode);
  const row = (machineID: string, operationID: string) => {
    access.get(machineID);
    const value = db.get<any>("SELECT * FROM machine_uninstallations WHERE id=? AND machine_id=?", operationID, machineID);
    if (!value) fail(404, "卸载计划不存在");
    return value;
  };
  const body = async (ctx: Context, fields: string[]) => {
    const input = await ctx.body();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail(400, "invalid request");
    return input;
  };
  const knownAgent = (machine: MachineSummary, agentID: string) => {
    assertNoPendingAgentUpdate(db, agentID, machine.id);
    if (machine.agent_id && machine.agent_id !== agentID) fail(409, "远端 Agent 身份与主机关联不一致");
    if (!table("agent_credentials") || !db.get("SELECT id FROM agent_credentials WHERE agent_id=? LIMIT 1", agentID)) fail(409, "远端 Agent 不是本平台已登记的独立凭据节点，不能自动卸载");
    if (db.get("SELECT id FROM managed_machines WHERE agent_id=? AND id!=? LIMIT 1", agentID, machine.id)) fail(409, "此 Agent 已关联另一主机，请先核对身份");
    if (db.get("SELECT id FROM machine_uninstallations WHERE agent_id=? AND machine_id!=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", agentID, machine.id)) fail(409, "此 Agent 已有其他主机的卸载流程，请先核对");
    if (taskBusy(agentID)) fail(409, "Agent 有待执行、运行中或结果未知的任务，请先完成或核对");
  };
  const probe = async (machine: MachineSummary, credential: any, signal: AbortSignal) => {
    const output = await access.runner({ machine, ...access.authentication(machine.id, credential), command: agentProbeCommand(), signal, port: machine.port, timeoutMs: 60_000 });
    db.run("UPDATE machine_credentials SET last_used_at=? WHERE id=?", at(), credential.id);
    return parseAgentProbe(output.stdout);
  };
  const assertObservation = (machine: MachineSummary, observation: ReturnType<typeof parseAgentProbe>, expectedID?: string) => {
    if (expectedID && observation.agent_id !== expectedID) fail(409, "远端 Agent 身份与审核计划不一致");
    knownAgent(machine, observation.agent_id);
    if (!observation.unit_managed) fail(409, "远端 Agent 使用非受管服务文件，请人工核对");
    if (observation.lifecycle_locked) fail(409, "远端 Agent 生命周期操作尚未结束，请稍后核对");
    if (observation.operation_lock) fail(409, "远端 Agent 存在未完成操作标记，请先核对");
    if (!observation.data_retained) fail(409, "远端 Agent 配置或状态目录缺失，不能自动卸载");
  };
  const complete = (operation: any, observation: ReturnType<typeof parseAgentProbe>) => {
    if (observation.installation !== "absent" || observation.service_running || !observation.data_retained || observation.operation_lock || observation.agent_id !== operation.agent_id) fail(409, "尚未确认 Agent 服务和程序已移除且数据已保留");
    let receipt: any;
    const machine = access.get(operation.machine_id);
    db.transaction(() => {
      assertObservation(machine, observation, operation.agent_id);
      const revoked = db.run("UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=? AND revoked_at IS NULL", at(), "Agent uninstalled through managed host", operation.agent_id).changes;
      receipt = { agent_id: operation.agent_id, remote_removed: true, data_retained: true, credentials_revoked: true, revoked_credentials: revoked, verified_at: at(), stages: ["host_identity_verified", "service_stopped", "program_removed", "retained_data_verified", "credentials_revoked"] };
      db.run("UPDATE machine_uninstallations SET status='succeeded',finished_at=?,receipt_json=?,error='' WHERE id=?", at(), JSON.stringify(receipt), operation.id);
      db.run("UPDATE managed_machines SET agent_id=?,agent_last_seen='',last_error='',updated_at=? WHERE id=?", operation.agent_id, at(), operation.machine_id);
    });
    return receipt;
  };
  const assertPlanTarget = (operation: any) => {
    const machine = access.get(operation.machine_id), plan = JSON.parse(operation.plan_json);
    if (plan.target_revision !== access.revision(machine) || machine.agent_id !== plan.machine.agent_id || machine.name !== plan.machine.name) fail(409, "主机名称、连接或节点关联已变化，请重新核对");
    knownAgent(machine, operation.agent_id);
    return machine;
  };
  const base = "/api/v1/machines/:id/uninstallations";
  router.get(base, access.safe(ctx => { deps.auth.requireAdmin(ctx); access.get(ctx.params.id); ctx.json(list(ctx.params.id)); }));
  router.get(base + "/:uninstallationId", access.safe(ctx => { deps.auth.requireAdmin(ctx); ctx.json(decode(row(ctx.params.id, ctx.params.uninstallationId))); }));
  router.post(base + "/plan", access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = await body(ctx, ["check_id", "credential_id"]);
    access.idle(ctx.params.id); assertFree(ctx.params.id);
    if (db.get("SELECT id FROM machine_deployments WHERE machine_id=? AND status IN ('awaiting_approval','running') LIMIT 1", ctx.params.id)) fail(409, "请先完成或取消 Agent 安装计划");
    const { machine, credential } = access.credential(ctx.params.id, input.credential_id);
    const check = access.checked(machine, input.check_id, credential.id);
    access.busy.add(machine.id);
    try {
      const observed = await probe(machine, credential, ctx.signal);
      assertObservation(machine, observed);
      if (observed.installation !== "present") fail(409, "远端 Agent 程序已移除，请核对既有卸载记录");
      // Revalidate every mutable dependency after the asynchronous SSH observation.
      access.credential(machine.id, credential.id); access.checked(access.get(machine.id), input.check_id, credential.id); assertFree(machine.id); knownAgent(machine, observed.agent_id);
      const operationID = id(), plan = { machine: { id: machine.id, name: machine.name, address: machine.address, port: machine.port, username: machine.username, agent_id: machine.agent_id }, agent_id: observed.agent_id,
        credential: { id: credential.id, method: credential.method, retention: credential.retention, expires_at: credential.expires_at }, check_id: check.id, target_revision: access.revision(machine), expires_at: check.expires_at,
        steps: ["核对远端 Agent 身份", "停止并禁用 Agent 服务", "确认服务停止后移除 Agent 程序", "保留配置、身份与缓存", "核验移除结果并撤销节点凭据"], retained_paths: retainedAgentPaths, removed_paths: removedAgentPaths,
        warnings: ["采集和节点任务将停止；业务服务、制品、容器和卷保持不变。", "默认保留配置和缓存，但旧节点凭据将撤销，重装需重新接入。", "SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。"] };
      db.transaction(() => { knownAgent(machine, observed.agent_id); assertFree(machine.id); db.run("INSERT INTO machine_uninstallations(id,machine_id,agent_id,credential_id,status,plan_json,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)", operationID, machine.id, observed.agent_id, credential.id, "awaiting_approval", JSON.stringify(plan), at(), ctx.user.id); });
      ctx.json({ id: operationID, machine_id: machine.id, agent_id: observed.agent_id, status: "awaiting_approval", plan, review_url: `/machines?machine=${encodeURIComponent(machine.id)}&uninstallation=${operationID}` }, 201);
    } finally { access.busy.delete(machine.id); }
  }));
  router.post(base + "/:uninstallationId/cancel", access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); await body(ctx, []); access.idle(ctx.params.id);
    const operation = row(ctx.params.id, ctx.params.uninstallationId);
    if (!["awaiting_approval", "cancelled"].includes(operation.status)) fail(409, "只能取消尚未执行的卸载计划");
    db.run("UPDATE machine_uninstallations SET status='cancelled',finished_at=? WHERE id=? AND status='awaiting_approval'", at(), operation.id);
    ctx.json({ id: operation.id, machine_id: operation.machine_id, status: "cancelled" });
  }));
  router.post(base + "/:uninstallationId/apply", access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = await body(ctx, ["confirm"]);
    if (input.confirm !== true) fail(400, "必须明确确认卸载计划");
    access.idle(ctx.params.id);
    const operation = row(ctx.params.id, ctx.params.uninstallationId), plan = JSON.parse(operation.plan_json);
    if (operation.status !== "awaiting_approval") fail(409, "卸载计划已执行或结果待核对，不能重复执行");
    if (!Number.isFinite(Date.parse(plan.expires_at)) || Date.parse(plan.expires_at) <= deps.now().getTime()) fail(409, "卸载计划已过期，请取消并重新检查");
    const machine = assertPlanTarget(operation), { credential } = access.credential(machine.id, operation.credential_id);
    access.checked(machine, plan.check_id, credential.id);
    access.busy.add(machine.id);
    let destructive = false;
    try {
      const observed = await probe(machine, credential, ctx.signal); assertObservation(machine, observed, operation.agent_id);
      if (observed.installation !== "present") fail(409, "远端程序状态已变化，请核对后重新生成计划");
      access.credential(machine.id, credential.id); access.checked(access.get(machine.id), plan.check_id, credential.id); assertPlanTarget(operation);
      const changed = db.run("UPDATE machine_uninstallations SET status='running',approved_at=?,started_at=? WHERE id=? AND status='awaiting_approval'", at(), at(), operation.id);
      if (!changed.changes) fail(409, "卸载计划已被其他请求执行");
      destructive = true;
      const result = await access.runner({ machine, ...access.authentication(machine.id, credential), command: agentUninstallCommand(operation.agent_id), signal: ctx.signal, port: machine.port, timeoutMs: 120_000 });
      const removed = parseAgentProbe(result.stdout);
      complete(operation, removed);
      ctx.json(decode(row(machine.id, operation.id)));
    } catch (error) {
      const state = destructive ? "unknown" : "failed";
      // Remote errors are not persisted: arbitrary remote diagnostics may contain secrets.
      const message = destructive ? "卸载结果未知，请使用只读核对确认远端状态" : error instanceof HTTPError ? error.message : "卸载前检查失败，未执行移除";
      db.run("UPDATE machine_uninstallations SET status=?,error=?,finished_at=? WHERE id=? AND status IN ('awaiting_approval','running')", state, message, at(), operation.id);
      if (error instanceof HTTPError && !destructive) throw error;
      throw new HTTPError(502, message);
    } finally { access.busy.delete(machine.id); }
  }));
  router.post(base + "/:uninstallationId/reconcile", access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); await body(ctx, []); access.idle(ctx.params.id);
    const operation = row(ctx.params.id, ctx.params.uninstallationId);
    if (operation.status !== "unknown") fail(409, "只有结果未知的卸载可以核对");
    const machine = assertPlanTarget(operation);
    // A new valid key can be added after the old temporary key expires.
    let selected: ReturnType<Access["credential"]>;
    try { selected = access.credential(machine.id, operation.credential_id); } catch { selected = access.credential(machine.id); }
    access.busy.add(machine.id);
    try {
      const observed = await probe(machine, selected.credential, ctx.signal);
      assertObservation(machine, observed, operation.agent_id);
      access.credential(machine.id, selected.credential.id); assertPlanTarget(operation);
      if (observed.installation === "present" && observed.program_complete) {
        db.run("UPDATE machine_uninstallations SET status='failed',error=?,receipt_json=?,finished_at=? WHERE id=? AND status='unknown'", "核对确认 Agent 程序完整，卸载未完成；请重新审阅计划", JSON.stringify({ agent_id: operation.agent_id, remote_removed: false, credentials_revoked: false, remote_unchanged: true, service_stopped: !observed.service_running, verified_at: at() }), at(), operation.id);
        ctx.json(decode(row(machine.id, operation.id))); return;
      }
      const receipt = complete(operation, observed);
      ctx.json({ ...decode(row(machine.id, operation.id)), receipt });
    } finally { access.busy.delete(machine.id); }
  }));
  return { list, pending, assertFree, taskBusy };
}
