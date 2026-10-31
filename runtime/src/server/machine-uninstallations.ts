import { hasActiveTaskRuns } from "./agent-hosts.js";
import { id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Context, Dependencies, Handler } from "../shared/types.js";
import { agentRemovalProbeCommand, agentRemovalCommand, parseAgentRemovalProbe, removalSnapshot, retainedAgentPaths, removedAgentPaths, type AgentRemovalObservation } from "./machine-agent-lifecycle.js";
import type { MachineSummary, SSHCheckResult } from "./managed-machines.js";
import type { SSHRunner } from "./machine-ssh.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
export type UninstallationStatus = "awaiting_approval" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
interface Access {
  get(id: string): MachineSummary; idle(id: string): void; revision(machine: MachineSummary): string;
  checked(machine: MachineSummary, checkID: string, credentialID?: string): SSHCheckResult;
  credential(machineID: string, credentialID?: string): { machine: MachineSummary; credential: any };
  authentication(machineID: string, credential: any): { privateKey: string; password?: string };
  markCredentialUsed(credentialID: string): void;
  busy: Set<string>; runner: SSHRunner; safe(handler: Handler): Handler;
}
export function createUninstallationSchema(deps: Dependencies) {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_uninstallations(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,status TEXT NOT NULL,plan_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT '',started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT ''
  ); CREATE INDEX IF NOT EXISTS machine_uninstallations_machine ON machine_uninstallations(machine_id,created_at);
  DROP INDEX IF EXISTS machine_uninstallations_node_lane;
  CREATE UNIQUE INDEX machine_uninstallations_node_lane ON machine_uninstallations(agent_id) WHERE agent_id!='' AND status IN ('awaiting_approval','running','unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS machine_uninstallations_host_lane ON machine_uninstallations(machine_id) WHERE status IN ('awaiting_approval','running','unknown');`);
  deps.db.run("UPDATE machine_uninstallations SET status='unknown',error='平台在卸载期间重启，请核对远端结果' WHERE status='running'");
}
export function registerMachineUninstallations(deps: Dependencies, access: Access) {
  const { db, router } = deps, at = () => deps.now().toISOString();
  const table = (name: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
  const taskBusy = (agentID: string, machineID="") => hasActiveTaskRuns(db, agentID, machineID) || !!(agentID && table("agent_jobs") && db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1", agentID));
  const pending = (machineID: string) => db.get<{status: UninstallationStatus}>("SELECT status FROM machine_uninstallations WHERE machine_id=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", machineID);
  const assertFree = (machineID: string) => { if (pending(machineID)) fail(409, "此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对"); };
  const decode = (row: any) => ({ ...row, plan: JSON.parse(row.plan_json), receipt: JSON.parse(row.receipt_json), plan_json: undefined, receipt_json: undefined });
  const list = (machineID: string) => db.all<any>("SELECT * FROM machine_uninstallations WHERE machine_id=? ORDER BY created_at DESC,id DESC LIMIT 100", machineID).map(decode);
  const row = (machineID: string, operationID: string) => {
    const value = db.get<any>("SELECT * FROM machine_uninstallations WHERE id=? AND machine_id=?", operationID, machineID);
    if (!value) fail(404, "卸载计划不存在");
    return value;
  };
  const body = async (ctx: Context, fields: string[]) => {
    const input = await ctx.body();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail(400, "invalid request");
    return input;
  };
  const relation = (machine: MachineSummary, agentID: string, mode: string) => {
    assertNoPendingAgentUpdate(db, agentID, machine.id);
    assertNoPendingMachineInstallation(db,machine.id,agentID,true);
    if (mode==="standard" && machine.agent_id && machine.agent_id!==agentID) fail(409,"远端 Agent 身份与主机关联不一致");
    if (mode==="standard" && (!agentID || !table("agent_credentials") || !db.get("SELECT id FROM agent_credentials WHERE agent_id=? LIMIT 1",agentID))) fail(409,"远端 Agent 不是本平台已登记的独立凭据节点，可审阅 SSH 恢复卸载");
    if (agentID && db.get("SELECT id FROM managed_machines WHERE agent_id=? AND id!=? LIMIT 1",agentID,machine.id)) fail(409,"此 Agent 已关联另一主机，请先核对身份");
    if (agentID && db.get("SELECT id FROM machine_uninstallations WHERE agent_id=? AND machine_id!=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1",agentID,machine.id)) fail(409,"此 Agent 已有其他主机的卸载流程，请先核对");
    if (taskBusy(agentID,machine.id) || machine.agent_id!==agentID && taskBusy(machine.agent_id,machine.id)) fail(409,"主机或实际 Agent 有未结束任务，请先完成或核对");
  };
  const revocationScope = (machine: MachineSummary, observation: AgentRemovalObservation) => {
    const agentID=observation.agent_id;
    const columns=table("agent_enrollments")?db.all<{name:string}>("PRAGMA table_info(agent_enrollments)"):[];
    const owned=observation.identity_state==="valid" && !!agentID && machine.agent_id===agentID && columns.some(c=>c.name==="machine_id")
      && !!db.get("SELECT id FROM agent_enrollments WHERE agent_id=? AND machine_id=? AND status='active' LIMIT 1",agentID,machine.id);
    return {eligible:!!owned,agent_id:owned?agentID:"",audiences:owned?["control","data"]:[],reason:owned?"当前主机绑定、远端身份及安装预约归属一致":"未证明实际身份归属当前主机，不撤销任何平台身份"};
  };
  const probe = async (machine: MachineSummary, credential: any, signal: AbortSignal) => {
    const output=await access.runner({machine,credentialID:credential.id,...access.authentication(machine.id,credential),command:agentRemovalProbeCommand(),signal,port:machine.port,timeoutMs:60_000});
    access.markCredentialUsed(credential.id); return parseAgentRemovalProbe(output.stdout);
  };
  const assertObservation = (machine: MachineSummary, observed: AgentRemovalObservation, mode: string) => {
    relation(machine,observed.agent_id,mode);
    if (!observed.paths_safe || observed.identity_state==="unsafe") fail(409,"远端 Agent 路径不安全，请人工核对");
    if (!observed.unit_managed) fail(409,"远端 Agent 使用非受管服务文件，请人工核对");
    if (observed.lifecycle_locked || observed.operation_lock) fail(409,"远端 Agent 存在生命周期锁或未完成操作，请先核对");
    if (mode==="standard" && (observed.identity_state!=="valid" || !observed.config_present || !observed.data_present)) fail(409,"远端身份、配置或状态目录缺失，请使用 SSH 恢复卸载");
  };
  const assertPlanTarget = (operation: any) => {
    const machine=access.get(operation.machine_id),plan=JSON.parse(operation.plan_json);
    if (plan.target_revision!==access.revision(machine) || machine.agent_id!==plan.machine.agent_id || machine.name!==plan.machine.name) fail(409,"主机名称、连接或节点关联已变化，请重新核对");
    relation(machine,operation.agent_id,plan.mode||"standard"); return machine;
  };
  const same = (left: AgentRemovalObservation, right: AgentRemovalObservation) => JSON.stringify(removalSnapshot(left))===JSON.stringify(removalSnapshot(right));
  const sameProgram = (left: AgentRemovalObservation, right: AgentRemovalObservation) => {
    const {service_running: leftRunning,...leftSnapshot}=removalSnapshot(left), {service_running: rightRunning,...rightSnapshot}=removalSnapshot(right);
    return JSON.stringify(leftSnapshot)===JSON.stringify(rightSnapshot);
  };
  const complete = (operation: any, observed: AgentRemovalObservation, expectedState: "running"|"unknown") => {
    const plan=JSON.parse(operation.plan_json), machine=assertPlanTarget(operation), legacy=!plan.observation;
    if(legacy && (expectedState!=="unknown" || observed.identity_state!=="valid" || observed.agent_id!==operation.agent_id || !observed.config_present || !observed.data_present)) fail(409,"旧卸载记录需核对原身份、完整移除及保留目录，结果保持未知");
    const before=(plan.observation || observed) as AgentRemovalObservation;
    if (observed.installation!=="absent" || observed.service_running || !observed.unit_managed || !observed.paths_safe || observed.lifecycle_locked || observed.operation_lock) fail(409,"尚未确认 Agent 服务和固定程序已安全移除");
    if (plan.purge ? observed.config_present || observed.data_present || observed.identity_state!=="missing" : observed.config_present!==before.config_present || observed.data_present!==before.data_present || observed.identity_state!==before.identity_state || observed.identity_sha256!==before.identity_sha256 || observed.agent_id!==before.agent_id) fail(409,"Agent 数据保留或清除策略尚未核实");
    db.transaction(()=>{
      const current=row(machine.id,operation.id); if(current.status!==expectedState) fail(409,"卸载记录状态已变化，请刷新");
      const live=db.get<MachineSummary>("SELECT * FROM managed_machines WHERE id=?",machine.id);
      if(!live || access.revision(live)!==plan.target_revision || live.agent_id!==plan.machine.agent_id || live.name!==plan.machine.name) fail(409,"核对期间主机目标或关联已变化，结果保持未知");
      relation(live,operation.agent_id,plan.mode||"standard");
      const scope=revocationScope(live,before), approved=plan.credential_revocation_scope;
      const eligible=scope.eligible && (legacy || approved?.eligible && scope.agent_id===approved.agent_id);
      const revoked=eligible && table("agent_credentials")?db.run("UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=? AND audience IN ('control','data') AND revoked_at IS NULL",at(),"Agent uninstalled through managed host",scope.agent_id).changes:0;
      const receipt={mode:plan.mode||"standard",purge:!!plan.purge,agent_id:before.agent_id,remote_removed:true,data_removed:!!plan.purge,data_retained:!plan.purge,credentials_revoked:!!eligible,revoked_credentials:revoked,credential_revocation_scope:eligible?scope:{...scope,eligible:false,agent_id:"",audiences:[],reason:scope.eligible?"可撤销范围未纳入原审批，不撤销任何平台身份":scope.reason},legacy_evidence:legacy,approved_snapshot_available:!legacy,verified_at:at(),stages:["ssh_target_verified",legacy?"legacy_identity_verified":"approved_evidence_verified","service_stopped","program_removed",plan.purge?"data_removed":"retained_data_verified",eligible?"owned_credentials_revoked":"credential_revocation_skipped"]};
      const changed=db.run("UPDATE machine_uninstallations SET status='succeeded',finished_at=?,receipt_json=?,error='' WHERE id=? AND status=?",at(),JSON.stringify(receipt),operation.id,expectedState); if(!changed.changes) fail(409,"卸载记录状态已变化");
      // An SSH observation never creates or replaces a platform Agent binding.
      db.run("UPDATE managed_machines SET agent_last_seen='',last_error='',updated_at=? WHERE id=?",at(),machine.id);
    });
  };
  const base="/api/v1/machines/:id/uninstallations";
  router.get(base,access.safe(ctx=>{deps.auth.requireAdmin(ctx);access.get(ctx.params.id);ctx.json(list(ctx.params.id));}));
  router.get(base+"/:uninstallationId",access.safe(ctx=>{deps.auth.requireAdmin(ctx);access.get(ctx.params.id);ctx.json(decode(row(ctx.params.id,ctx.params.uninstallationId)));}));
  router.post(base+"/plan",access.safe(async ctx=>{
    deps.auth.requireAdmin(ctx);const input=await body(ctx,["check_id","credential_id","mode","reason","purge"]);
    const mode=input.mode??"standard",purge=input.purge??false,reason=input.reason??"";
    if(!["standard","recovery"].includes(mode) || typeof purge!=="boolean" || typeof reason!=="string" || Buffer.byteLength(reason)>1000 || /[\u0000-\u001f\u007f]/.test(reason) || mode==="recovery"&&!reason.trim()) fail(400,"恢复卸载需要明确模式和非空原因，数据清除必须为布尔值");
    access.idle(ctx.params.id);assertFree(ctx.params.id);
    const {machine,credential}=access.credential(ctx.params.id,input.credential_id),check=access.checked(machine,input.check_id,credential.id);
    relation(machine,"",mode==="standard"?"recovery":mode);
    access.busy.add(machine.id);
    try{
      const observed=await probe(machine,credential,ctx.signal);assertObservation(machine,observed,mode);
      if(mode==="standard"&&observed.installation!=="present" || mode==="recovery"&&observed.installation==="absent"&&!observed.config_present&&!observed.data_present) fail(409,"远端 Agent 已移除，没有待卸载内容");
      const current=access.get(machine.id);access.credential(machine.id,credential.id);access.checked(current,input.check_id,credential.id);assertFree(machine.id);
      if(access.revision(current)!==access.revision(machine)||current.agent_id!==machine.agent_id||current.name!==machine.name)fail(409,"主机在检查期间变化，请重新计划");
      const operationID=id(),plan={mode,reason:reason.trim(),purge,machine:{id:machine.id,name:machine.name,address:machine.address,port:machine.port,username:machine.username,agent_id:machine.agent_id},agent_id:observed.agent_id,observation:observed,credential_revocation_scope:revocationScope(current,observed),credential:{id:credential.id,method:credential.method,retention:credential.retention,expires_at:credential.expires_at},check_id:check.id,target_revision:access.revision(machine),expires_at:check.expires_at,
        steps:["核对固定 SSH 目标和已审阅的远端证据","停止并禁用受管 Agent 服务","复验任务标记后移除固定程序",purge?"明确清除 Agent 配置、身份和缓存":"保留 Agent 配置、身份和缓存","核验结果并仅撤销确属本主机的凭据"],retained_paths:purge?[]:retainedAgentPaths,removed_paths:purge?[...removedAgentPaths,...retainedAgentPaths]:removedAgentPaths,warnings:["不会删除业务数据、系统账户或平台主机记录。",purge?"Agent 配置、身份及缓存将清除；完成后可进行全新接入。":"保留数据会继续触发 fresh 保护，重新接入前需明确清除。","派发后中断进入未知结果，仅可只读核对，不自动重放。"]};
      db.transaction(()=>{assertFree(machine.id);relation(current,observed.agent_id,mode);db.run("INSERT INTO machine_uninstallations(id,machine_id,agent_id,credential_id,status,plan_json,created_at,created_by) VALUES(?,?,?,?,? ,?,?,?)",operationID,machine.id,observed.agent_id,credential.id,"awaiting_approval",JSON.stringify(plan),at(),ctx.user.id);});
      ctx.json({...decode(row(machine.id,operationID)),review_url:`/machines?machine=${machine.id}&uninstallation=${operationID}`},201);
    }finally{access.busy.delete(machine.id);}
  }));
  router.post(base+"/:uninstallationId/cancel",access.safe(async ctx=>{deps.auth.requireAdmin(ctx);await body(ctx,[]);access.idle(ctx.params.id);const operation=row(ctx.params.id,ctx.params.uninstallationId);if(!["awaiting_approval","cancelled"].includes(operation.status))fail(409,"只能取消尚未执行的卸载计划");db.run("UPDATE machine_uninstallations SET status='cancelled',finished_at=? WHERE id=? AND status='awaiting_approval'",at(),operation.id);ctx.json(decode(row(operation.machine_id,operation.id)));}));
  router.post(base+"/:uninstallationId/apply",access.safe(async ctx=>{
    deps.auth.requireAdmin(ctx);const input=await body(ctx,["confirm"]);if(input.confirm!==true)fail(400,"必须明确确认卸载计划");access.idle(ctx.params.id);
    const operation=row(ctx.params.id,ctx.params.uninstallationId),plan=JSON.parse(operation.plan_json);
    if(operation.status!=="awaiting_approval")fail(409,"卸载计划已执行或结果待核对，不能重复执行");
    if(!plan.observation)fail(409,"旧卸载计划没有审批快照，请取消并重新生成计划");
    if(!Number.isFinite(Date.parse(plan.expires_at))||Date.parse(plan.expires_at)<=deps.now().getTime())fail(409,"卸载计划已过期，请取消并重新检查");
    const machine=assertPlanTarget(operation),{credential}=access.credential(machine.id,operation.credential_id);access.checked(machine,plan.check_id,credential.id);access.busy.add(machine.id);let destructive=false;
    try{
      const observed=await probe(machine,credential,ctx.signal);assertObservation(machine,observed,plan.mode||"standard");if(!plan.observation||!same(observed,plan.observation))fail(409,"远端 Agent 证据与审核计划不一致，请重新计划");
      access.credential(machine.id,credential.id);access.checked(access.get(machine.id),plan.check_id,credential.id);assertPlanTarget(operation);
      if(!db.run("UPDATE machine_uninstallations SET status='running',approved_at=?,started_at=? WHERE id=? AND status='awaiting_approval'",at(),at(),operation.id).changes)fail(409,"卸载计划已被其他请求执行");
      destructive=true;const result=await access.runner({machine,credentialID:credential.id,...access.authentication(machine.id,credential),command:agentRemovalCommand(plan.observation,!!plan.purge),signal:ctx.signal,port:machine.port,timeoutMs:120_000});access.markCredentialUsed(credential.id);
      complete(operation,parseAgentRemovalProbe(result.stdout),"running");ctx.json(decode(row(machine.id,operation.id)));
    }catch(error){const message=destructive?"卸载结果未知，请使用只读核对确认远端状态":error instanceof HTTPError?error.message:"卸载前检查失败，未执行移除";db.run("UPDATE machine_uninstallations SET status=?,error=?,finished_at=? WHERE id=? AND status=?",destructive?"unknown":"failed",message,at(),operation.id,destructive?"running":"awaiting_approval");if(error instanceof HTTPError&&!destructive)throw error;throw new HTTPError(502,message);}finally{access.busy.delete(machine.id);}
  }));
  router.post(base+"/:uninstallationId/reconcile",access.safe(async ctx=>{
    deps.auth.requireAdmin(ctx);const input=await body(ctx,["credential_id"]);if(input.credential_id!==undefined&&(typeof input.credential_id!=="string"||!input.credential_id||input.credential_id.length>64))fail(400,"invalid credential_id");access.idle(ctx.params.id);const operation=row(ctx.params.id,ctx.params.uninstallationId);if(operation.status!=="unknown")fail(409,"只有结果未知的卸载可以核对");const machine=assertPlanTarget(operation),plan=JSON.parse(operation.plan_json);
    let selected:ReturnType<Access["credential"]>;if(input.credential_id)selected=access.credential(machine.id,input.credential_id);else{try{selected=access.credential(machine.id,operation.credential_id);}catch{selected=access.credential(machine.id);}}
    access.busy.add(machine.id);try{const observed=await probe(machine,selected.credential,ctx.signal);access.credential(machine.id,selected.credential.id);assertPlanTarget(operation);
      if(observed.installation==="present"&&observed.program_complete&&plan.observation&&sameProgram(observed,plan.observation)){assertObservation(machine,observed,plan.mode||"standard");if(!db.run("UPDATE machine_uninstallations SET status='failed',error=?,receipt_json=?,finished_at=? WHERE id=? AND status='unknown'","核对确认原程序完整未移除，请重新审阅",JSON.stringify({mode:plan.mode||"standard",purge:!!plan.purge,remote_removed:false,credentials_revoked:false,remote_unchanged:true,service_stopped:!observed.service_running,verified_at:at()}),at(),operation.id).changes)fail(409,"卸载状态已变化");}
      else complete(operation,observed,"unknown");ctx.json(decode(row(machine.id,operation.id)));
    }finally{access.busy.delete(machine.id);}
  }));
  return {list,pending,assertFree,taskBusy};
}
