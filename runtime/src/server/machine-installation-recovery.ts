import { fail, HTTPError } from "../shared/http.js";
import type { Dependencies, Handler } from "../shared/types.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
import { hasActiveTaskRuns } from "./agent-hosts.js";
import { agentProbeCommand, parseAgentProbe } from "./machine-agent-lifecycle.js";
import { machineCredentialCurrent } from "./machine-credential-policy.js";
import type { MachineSummary } from "./managed-machines.js";
import type { SSHRunner } from "./machine-ssh.js";

type Row = Record<string, any>;
const decode = (value: string) => { try { return JSON.parse(value); } catch { return {}; } };
export function createInstallationRecoverySchema(deps: Dependencies) {
  deps.db.run("UPDATE machine_deployments SET status='unknown',error=? WHERE status='running'", "平台在 Agent 安装期间重启，远端结果未知；请只读核对或明确结束，不要重复安装");
}
interface Access {
  get(id: string): MachineSummary; idle(id: string): void; revision(machine: any): string;
  credential(machineID: string, credentialID?: string): { machine: MachineSummary; credential: any };
  authentication(machineID: string, credential: any): { privateKey: string; password?: string };
  markCredentialUsed(credentialID: string): void;
  activated(machineID: string, actorID: string): void;
  deployment(machineID: string, deploymentID: string): any;
  busy: Set<string>; runner: SSHRunner; safe(handler: Handler): Handler;
}
export function registerInstallationRecovery(deps: Dependencies, access: Access, credentials?: AgentCredentialStore) {
  const {db,router} = deps, at = () => deps.now().toISOString();
  const table = (name: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name);
  const body = async (ctx: any, fields: string[]) => {
    const value = await ctx.body();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail(400,"invalid recovery request");
    return value;
  };
  const row = (machineID: string, deploymentID: string): Row => {
    const value = db.get<Row>("SELECT * FROM machine_deployments WHERE id=? AND machine_id=?",deploymentID,machineID);
    if (!value) fail(404,"部署记录不存在");
    if (value.status !== "unknown" || value.resolved_at) fail(409,"只有尚未明确结束的未知安装可以核对或结束");
    return value;
  };
  const target = (operation: Row, machine: any) => {
    const plan = decode(operation.plan_json);
    if (!plan.target_revision || access.revision(machine) !== plan.target_revision) fail(409,"原安装的 SSH 目标已变化，不能核对另一台主机");
    return plan;
  };
  const assertCredential = (machineID: string, credentialID: string) => {
    const value = db.get<Row>("SELECT * FROM effective_machine_credentials WHERE id=? AND machine_id=?",credentialID,machineID);
    if (!value || value.revoked_at || value.secret_cleared_at || !value.secret_encrypted || !machineCredentialCurrent(value as any,deps.now())) fail(409,"核对凭据已失效，请选择新的有效凭据");
  };
  const ownEnrollment = (operation: Row) => {
    if (!operation.enrollment_id || !table("agent_enrollments")) return undefined;
    const enrollment=db.get<Row>("SELECT * FROM agent_enrollments WHERE id=?",operation.enrollment_id);
    if (!enrollment) return undefined;
    const previous=decode(operation.plan_json).machine?.agent_id || "";
    return enrollment.machine_id===operation.machine_id && (enrollment.replaces_agent_id || "")===previous ? enrollment : undefined;
  };
  const cancelOwnEnrollment = (operation: Row) => {
    const enrollment=ownEnrollment(operation);
    if (!enrollment || !["issued","pending_activation","cancelled"].includes(enrollment.status)) return false;
    credentials?.cancelEnrollment?.(enrollment.id);
    return db.get<Row>("SELECT status FROM agent_enrollments WHERE id=?",enrollment.id)?.status === "cancelled";
  };
  const healthy = (operation: Row, machine: any, observed: ReturnType<typeof parseAgentProbe>) => {
    if (!ownEnrollment(operation)) return false;
    const enrollment = operation.enrollment_id && credentials?.enrollmentStatus(operation.enrollment_id);
    if (!enrollment || enrollment.status !== "active" || !enrollment.agent_id || machine.agent_id !== enrollment.agent_id
      || observed.agent_id !== enrollment.agent_id || !credentials?.has(enrollment.agent_id,"control")) return false;
    if (observed.installation !== "present" || !observed.program_complete || !observed.unit_managed || !observed.service_running
      || !observed.data_retained || observed.lifecycle_locked || observed.operation_lock) return false;
    const node = table("agents") ? db.get<Row>("SELECT * FROM agents WHERE id=?",enrollment.agent_id) : undefined;
    const seen = Date.parse(node?.last_seen || ""), started = Date.parse(operation.started_at || ""), now = deps.now().getTime();
    const heartbeat = decode(node?.heartbeat || "{}");
    return Number.isFinite(seen) && Number.isFinite(started) && seen >= started && now-seen < 180_000 && seen-now <= 30_000
      && node?.version === operation.version && node?.arch === operation.arch && heartbeat.last_error === "";
  };
  const base = "/api/v1/machines/:id/deployments/:deploymentId";
  router.post(base+"/reconcile",access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = await body(ctx,["credential_id"]);
    if (input.credential_id !== undefined && (typeof input.credential_id !== "string" || !input.credential_id || input.credential_id.length>64)) fail(400,"invalid credential_id");
    access.idle(ctx.params.id);
    const operation = row(ctx.params.id,ctx.params.deploymentId), machine = access.get(operation.machine_id);
    target(operation,machine);
    if (!credentials) fail(503,"Agent enrollment 尚未配置");
    const enrollment = operation.enrollment_id && credentials.enrollmentStatus(operation.enrollment_id);
    const persistedEnrollment = ownEnrollment(operation);
    const beforeIssue = ["planned","preflight"].includes(operation.execution_stage) && !operation.enrollment_id;
    const unstarted = operation.execution_stage === "enrollment_issued" && operation.enrollment_id && enrollment?.status !== "active" && persistedEnrollment && ["issued","pending_activation","cancelled","expired"].includes(persistedEnrollment.status);
    if (beforeIssue || unstarted) {
      db.transaction(() => {
        const current = row(operation.machine_id,operation.id);
        if (current.execution_stage !== operation.execution_stage || current.enrollment_id !== operation.enrollment_id) fail(409,"安装阶段已变化，请重新核对");
        if (unstarted && table("agent_enrollments") && db.get("SELECT id FROM agent_enrollments WHERE id=? AND status='active'",operation.enrollment_id)) fail(409,"安装预约已激活，必须核对远端健康证据");
        if (unstarted && !cancelOwnEnrollment(current) && persistedEnrollment?.status!=="expired") fail(409,"无法撤销本次安装预约，结果保持未知");
        db.run("UPDATE machine_deployments SET status='failed',finished_at=?,error=?,receipt_json=? WHERE id=? AND status='unknown' AND resolved_at=''",at(),"核对确认未派发远端安装，可重新检查",JSON.stringify({...decode(operation.receipt_json),remote_not_dispatched:true,verified_at:at()}),operation.id);
      });
      ctx.json(access.deployment(operation.machine_id,operation.id)); return;
    }
    if (!operation.enrollment_id) fail(409,"缺少可核验的安装预约，保留未知结果；请人工检查后明确结束");
    let selected: ReturnType<Access["credential"]>;
    if (input.credential_id) selected=access.credential(machine.id,input.credential_id);
    else { try { selected=access.credential(machine.id,operation.credential_id); } catch { selected=access.credential(machine.id); } }
    access.busy.add(machine.id);
    try {
      const output = await access.runner({machine,...access.authentication(machine.id,selected.credential),credentialID:selected.credential.id,
        command:agentProbeCommand(),signal:ctx.signal,port:machine.port,timeoutMs:60_000});
      access.markCredentialUsed(selected.credential.id);
      const observed = parseAgentProbe(output.stdout);
      access.credential(machine.id,selected.credential.id);
      db.transaction(() => {
        const current = row(machine.id,operation.id), currentMachine = db.get<Row>("SELECT * FROM managed_machines WHERE id=?",machine.id)!;
        target(current,currentMachine); assertCredential(machine.id,selected.credential.id);
        if (current.enrollment_id !== operation.enrollment_id || !healthy(current,currentMachine,observed)) fail(409,"尚无同一安装预约、受管程序和新鲜 Agent 健康证据，结果保持未知");
        const receipt = {...decode(current.receipt_json),agent_id:observed.agent_id,enrollment_id:current.enrollment_id,reconciled:true,verified_at:at(),remote_healthy:true};
        db.run("UPDATE machine_deployments SET status='succeeded',finished_at=?,error='',receipt_json=? WHERE id=? AND status='unknown' AND resolved_at=''",at(),JSON.stringify(receipt),operation.id);
        db.run("UPDATE managed_machines SET agent_last_seen=?,last_error='',updated_at=? WHERE id=?",at(),at(),machine.id);
        access.activated(machine.id,ctx.user.id);
      });
      ctx.json(access.deployment(machine.id,operation.id));
    } catch (error) {
      if (error instanceof HTTPError) throw error;
      fail(502,"只读安装核对失败，结果保持未知；未重新执行安装");
    } finally { access.busy.delete(machine.id); }
  }));
  router.post(base+"/resolve",access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = await body(ctx,["confirm","reason"]);
    if (input.confirm !== true || typeof input.reason !== "string" || !input.reason.trim() || Buffer.byteLength(input.reason)>1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) fail(400,"请明确确认并填写人工核查结论");
    access.idle(ctx.params.id);
    const operation = row(ctx.params.id,ctx.params.deploymentId);
    db.transaction(() => {
      const current = row(operation.machine_id,operation.id), enrollment = ownEnrollment(current);
      const previous = decode(current.plan_json).machine?.agent_id || "";
      const agentID = enrollment && enrollment.machine_id === current.machine_id && enrollment.agent_id && enrollment.agent_id !== previous ? enrollment.agent_id : "";
      const bound = db.get<Row>("SELECT agent_id FROM managed_machines WHERE id=?",current.machine_id)?.agent_id || "";
      if (hasActiveTaskRuns(db,agentID || bound,current.machine_id) || table("agent_jobs") && db.get("SELECT id FROM agent_jobs WHERE agent_id IN (?,?) AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",agentID,bound)) fail(409,"主机仍有未结束的任务，请先处理后再结束安装记录");
      const cancelled=cancelOwnEnrollment(current);
      const revoked = agentID && table("agent_credentials") ? db.run("UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=? AND audience IN ('control','data') AND revoked_at IS NULL",at(),"Administrator resolved an unknown Agent installation",agentID).changes : 0;
      const receipt = {...decode(current.receipt_json),manual_resolution:{at:at(),actor_id:ctx.user.id,reason:input.reason.trim(),enrollment_cancelled:cancelled,revoked_agent_id:agentID,revoked_credentials:revoked}};
      db.run("UPDATE machine_deployments SET resolved_at=?,resolved_by=?,resolution_reason=?,receipt_json=? WHERE id=? AND status='unknown' AND resolved_at=''",at(),ctx.user.id,input.reason.trim(),JSON.stringify(receipt),current.id);
    });
    ctx.json(access.deployment(operation.machine_id,operation.id));
  }));
}
