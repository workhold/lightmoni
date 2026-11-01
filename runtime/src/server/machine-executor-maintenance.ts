import { randomUUID } from "node:crypto";
import type { Context, Dependencies, Module } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { canonicalJSON, sha256, strictRecord, parseStrictJSON } from "../shared/privileged-executor.js";
import type { AgentUpdateAccess } from "./machine-agent-updates.js";
import type { PrivilegedExecutorStore } from "./privileged-executors.js";
import { hasActiveTaskRuns } from "./agent-hosts.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
import { assertNoPendingMachineUninstallation } from "./machine-uninstallations-guard.js";
import { agentMaintenanceShellGuards } from "../shared/agent-maintenance-shell.js";
import { executorHostLockShell, executorAbsenceProofShell } from "./executor-absence-shell.js";

type Row=Record<string,any>;
const q=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const rootCommand=(script:string)=>`if [ "$(id -u)" = 0 ]; then /bin/sh -c ${q(script)}; else sudo -n /bin/sh -c ${q(script)}; fi`;
const programGuards=agentMaintenanceShellGuards+`
for lm_parent in /usr /usr/local /usr/local/bin /usr/local/sbin /opt /opt/lightmoni-executor /opt/lightmoni-executor/releases /etc /etc/lightmoni-executor /var /var/lib /var/lib/lightmoni-executor; do lm_root_entry "$lm_parent" directory; done
lm_root_entry /usr/local/bin/lightmoni-executor file
lm_root_entry /usr/local/sbin/lightmoni-executor-uninstall file
`;
const probeCommand=rootCommand(`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
[ "$(id -u)" = 0 ] || exit 1
${programGuards}
[ ! -L /usr/local/bin/lightmoni-executor ] && [ "$(stat -c %u /usr/local/bin/lightmoni-executor)" = 0 ] || exit 1
[ $((0$(stat -c %a /usr/local/bin/lightmoni-executor) & 0022)) -eq 0 ] || exit 1
exec /usr/local/bin/lightmoni-executor status --config /etc/lightmoni-executor/config.json`);
const removalCommand=(executorID:string,generation:number)=>rootCommand(`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
[ "$(id -u)" = 0 ] || exit 1
${programGuards}
[ ! -L /usr/local/sbin/lightmoni-executor-uninstall ] && [ "$(stat -c %u /usr/local/sbin/lightmoni-executor-uninstall)" = 0 ] || exit 1
[ $((0$(stat -c %a /usr/local/sbin/lightmoni-executor-uninstall) & 0022)) -eq 0 ] || exit 1
/usr/local/sbin/lightmoni-executor-uninstall --confirm-remove-executor --expected-executor-id ${q(executorID)} --expected-install-generation ${q(String(generation))} >/dev/null
${executorHostLockShell("lifecycle")}
${executorAbsenceProofShell}
printf 'executor_uninstalled=verified\\n'`);
/** An unknown removal can only release its fence after this fixed proof. */
export function executorMaintenanceAbsentCommand(): string { return rootCommand(`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
umask 077
[ "$(id -u)" = 0 ] || exit 1
${executorHostLockShell("lifecycle")}
${executorAbsenceProofShell}
printf 'executor_uninstalled=verified\\n'`); }
const absentCommand=executorMaintenanceAbsentCommand();
export function registerMachineExecutorMaintenance(deps:Dependencies,access:AgentUpdateAccess,executors:PrivilegedExecutorStore):Module {
  const {db,router}=deps,now=()=>deps.now().toISOString(),controller=new AbortController(),workers=new Set<Promise<void>>();
  db.exec(`CREATE TABLE IF NOT EXISTS machine_executor_maintenance(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,executor_id TEXT NOT NULL,credential_id TEXT NOT NULL,
    status TEXT NOT NULL,plan_json TEXT NOT NULL,revision TEXT NOT NULL,request_id TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS executor_maintenance_lane ON machine_executor_maintenance(machine_id) WHERE status IN ('awaiting_approval','running','unknown');`);
  db.run("UPDATE machine_executor_maintenance SET status='unknown',error='平台在卸载期间重启，请通过原记录只读核对' WHERE status='running'");
  const human=(c:Context)=>{
    deps.auth.requireAdmin(c);
    if(c.req.headers.authorization||!c.req.headers.cookie?.split(";").some(p=>p.trim().startsWith("lm_session="))||deps.auth.user(c.req)?.id!==c.user.id)fail(403,"human_admin_session_required");
  };
  const input=(v:unknown,keys:string[],required=keys)=>{try{return strictRecord(v,keys,required);}catch{fail(400,"invalid_executor_maintenance_request");}};
  const body=async(c:Context)=>{try{return parseStrictJSON(await c.raw(65536),65536);}catch{fail(400,"invalid_executor_maintenance_request");}};
  const credentialRevision=(v:Row)=>sha256(canonicalJSON([v.id,v.connection_credential_id??"",v.method??"",v.secret_fingerprint,v.retention??"",v.expires_at,v.revoked_at??"",v.secret_cleared_at??""]));
  const row=(host:string,id:string)=>{const r=db.get<Row>("SELECT * FROM machine_executor_maintenance WHERE machine_id=? AND id=?",host,id);if(!r)fail(404,"executor_maintenance_not_found");return r;};
  const view=(r:Row)=>({id:r.id,status:r.status,revision:r.revision,plan:JSON.parse(r.plan_json),executor_id:r.executor_id,expires_at:r.expires_at,started_at:r.started_at,finished_at:r.finished_at,error:r.error});
  const checkOther=(host:string,agent:string,own="")=>{
    assertNoPendingAgentUpdate(db,agent,host);assertNoPendingMachineInstallation(db,host,agent,true);assertNoPendingMachineUninstallation(db,host,agent);
    if(hasActiveTaskRuns(db,agent,host)||db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",agent))fail(409,"executor_maintenance_tasks_pending");
    if(db.get("SELECT id FROM machine_executor_maintenance WHERE machine_id=? AND id!=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1",host,own))fail(409,"executor_maintenance_pending");
  };
  const ssh=async(host:string,credentialID:string,command:string,signal:AbortSignal)=>{
    const {machine,credential}=access.credential(host,credentialID);
    try {
      const output=await access.runner({machine,credentialID:credential.id,...access.authentication(host,credential),command,signal,port:machine.port,timeoutMs:60_000});
      access.markCredentialUsed(credential.id);return output.stdout;
    } catch { fail(409,"executor_ssh_operation_failed_or_unknown"); }
  };
  const probe=async(host:string,credentialID:string,signal:AbortSignal)=>{
    const raw=await ssh(host,credentialID,probeCommand,signal);
    let s:Row;
    try{s=strictRecord(parseStrictJSON(raw,65536),["executor_id","machine_id","install_generation","policy_generation","fenced","pending_results"]);}catch{fail(409,"executor_has_unresolved_local_state");}
    if(typeof s.executor_id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(s.executor_id)||s.machine_id!==host||s.fenced!==null||s.pending_results!==0||!Number.isSafeInteger(s.install_generation)||s.install_generation<1||!Number.isSafeInteger(s.policy_generation)||s.policy_generation<1)fail(409,"executor_has_unresolved_local_state");
    return s;
  };
  const checkBinding=(p:Row,r:Row)=>{
    const machine=access.get(r.machine_id),executor=executors.getStatus(r.machine_id).executor;
    if(access.revision(machine)!==p.target_revision||machine.name!==p.machine.name||machine.agent_id!==p.machine.agent_id)fail(409,"executor_maintenance_target_changed");
    if(!executor||executor.id!==r.executor_id||executor.install_generation!==p.install_generation||executor.state==="revoked")fail(409,"executor_identity_mismatch");
    if(db.get<Row>("SELECT agent_id FROM privileged_executors WHERE id=? AND machine_id=?",r.executor_id,r.machine_id)?.agent_id!==machine.agent_id)fail(409,"executor_identity_mismatch");
    return machine;
  };
  const complete=(r:Row,actor:string)=>db.transaction(()=>{
    const current=row(r.machine_id,r.id),p=JSON.parse(current.plan_json);
    if(current.status==="succeeded")return view(current);
    if(!["running","unknown"].includes(current.status))fail(409,"executor_maintenance_state_changed");
    const machine=checkBinding(p,current);checkOther(machine.id,machine.agent_id,current.id);
    // Release only our lifecycle fence inside the same transaction as the
    // exact identity revocation; a failed revocation rolls back both writes.
    db.run("UPDATE machine_executor_maintenance SET status='succeeded',finished_at=?,error='' WHERE id=?",now(),r.id);
    executors.revokeExecutor(r.machine_id,r.executor_id,actor,true);
    return view(row(r.machine_id,r.id));
  });
  router.post("/api/v1/machines/:id/executor-maintenance/plan",access.safe(async c=>{
    human(c);const v=input(await body(c),["action","credential_id"],["action"]);if(v.action!=="uninstall")fail(400,"executor_maintenance_action_not_available");
    if(v.credential_id!==undefined&&(typeof v.credential_id!=="string"||!v.credential_id))fail(400,"invalid_credential_id");
    access.idle(c.params.id);const machine=access.get(c.params.id);checkOther(machine.id,machine.agent_id);
    const executor=executors.getStatus(machine.id).executor;if(!executor||executor.state==="revoked")fail(409,"executor_not_installed");
    const selected=access.credential(machine.id,v.credential_id),observation=await probe(machine.id,selected.credential.id,c.signal);
    if(observation.executor_id!==executor.id||observation.install_generation!==executor.install_generation)fail(409,"executor_identity_mismatch");
    if(access.revision(access.get(machine.id))!==access.revision(machine))fail(409,"executor_maintenance_target_changed");
    const expires=new Date(deps.now().getTime()+300000).toISOString(),id=randomUUID(),p={action:"uninstall",machine:{id:machine.id,name:machine.name,agent_id:machine.agent_id,address:machine.address,username:machine.username},
      executor_id:executor.id,install_generation:executor.install_generation,target_revision:access.revision(machine),observation,
      credential_id:selected.credential.id,credential_revision:credentialRevision(selected.credential),
      expires_at:expires,steps:["复核原执行器身份与本地未结束任务","停止 root 执行器并再次核对执行状态","删除执行器程序及独立身份、授权与日志","核实远端移除后撤销平台执行器身份"]};
    const revision=sha256(canonicalJSON(p));
    human(c);
    db.transaction(()=>{
      checkBinding(p,{machine_id:machine.id,executor_id:executor.id});checkOther(machine.id,machine.agent_id);
      if(credentialRevision(access.credential(machine.id,selected.credential.id).credential)!==p.credential_revision)fail(409,"executor_maintenance_credential_changed");
      db.run("INSERT INTO machine_executor_maintenance(id,machine_id,executor_id,credential_id,status,plan_json,revision,created_by,created_at,expires_at) VALUES(?,?,?,?,'awaiting_approval',?,?,?,?,?)",id,machine.id,executor.id,selected.credential.id,canonicalJSON(p),revision,c.user.id,now(),expires);
    });
    c.json(view(row(machine.id,id)));
  }));
  router.post("/api/v1/machines/:id/executor-maintenance/plans/:planId/apply",access.safe(async c=>{
    human(c);const v=input(await body(c),["confirm","expected_revision","request_id"]),r=row(c.params.id,c.params.planId),p=JSON.parse(r.plan_json);
    if(v.confirm!==true||typeof v.request_id!=="string"||!/^[a-f0-9-]{36}$/.test(v.request_id))fail(400,"explicit_confirmation_required");
    if(v.expected_revision!==r.revision||sha256(canonicalJSON(p))!==r.revision)fail(409,"executor_maintenance_plan_changed");
    if(r.request_id){if(r.request_id!==v.request_id)fail(409,"executor_maintenance_already_applied");c.json(view(r));return;}
    if(r.status!=="awaiting_approval"||Date.parse(r.expires_at)<=deps.now().getTime())fail(409,"executor_maintenance_expired");
    access.idle(r.machine_id);const machine=access.get(r.machine_id);checkOther(machine.id,machine.agent_id,r.id);
    checkBinding(p,r);
    const {credential}=access.credential(machine.id,r.credential_id);
    if(credentialRevision(credential)!==p.credential_revision)fail(409,"executor_maintenance_credential_changed");
    const observed=await probe(machine.id,r.credential_id,c.signal);
    if(canonicalJSON(observed)!==canonicalJSON(p.observation))fail(409,"executor_maintenance_state_changed");
    human(c);
    db.transaction(()=>{
      const current=row(machine.id,r.id);checkOther(machine.id,machine.agent_id,r.id);
      checkBinding(p,current);
      if(current.request_id||current.status!=="awaiting_approval"||Date.parse(current.expires_at)<=deps.now().getTime())fail(409,"executor_maintenance_state_changed");
      if(credentialRevision(access.credential(machine.id,r.credential_id).credential)!==p.credential_revision)fail(409,"executor_maintenance_credential_changed");
      db.run("UPDATE machine_executor_maintenance SET status='running',request_id=?,started_at=? WHERE id=?",v.request_id,now(),r.id);
    });
    access.busy.add(machine.id);
    const work=(async()=>{try{
      const output=await ssh(machine.id,r.credential_id,removalCommand(r.executor_id,p.install_generation),AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]));
      if(output.trim()!=="executor_uninstalled=verified")throw Error();complete(r,c.user.id);
    }catch{db.run("UPDATE machine_executor_maintenance SET status='unknown',error='卸载结果未知，请只读核对；不会自动重试' WHERE id=? AND status='running'",r.id);}finally{access.busy.delete(machine.id);}})();
    workers.add(work);void work.finally(()=>workers.delete(work));c.json(view(row(machine.id,r.id)));
  }));
  router.get("/api/v1/machines/:id/executor-maintenance/plans",access.safe(c=>{human(c);c.json(db.all<Row>("SELECT * FROM machine_executor_maintenance WHERE machine_id=? ORDER BY created_at DESC LIMIT 30",c.params.id).map(view));}));
  router.get("/api/v1/machines/:id/executor-maintenance/plans/:planId",access.safe(c=>{human(c);c.json(view(row(c.params.id,c.params.planId)));}));
  router.post("/api/v1/machines/:id/executor-maintenance/plans/:planId/cancel",access.safe(c=>{human(c);const r=row(c.params.id,c.params.planId);if(r.status!=="awaiting_approval")fail(409,"only_unstarted_maintenance_can_be_cancelled");db.run("UPDATE machine_executor_maintenance SET status='cancelled',finished_at=? WHERE id=?",now(),r.id);c.json(view(row(r.machine_id,r.id)));}));
  router.post("/api/v1/machines/:id/executor-maintenance/plans/:planId/reconcile",access.safe(async c=>{
    human(c);const v=input(await body(c),["credential_id"],[]),r=row(c.params.id,c.params.planId),p=JSON.parse(r.plan_json);
    if(v.credential_id!==undefined&&(typeof v.credential_id!=="string"||!v.credential_id))fail(400,"invalid_credential_id");
    if(r.status!=="unknown")fail(409,"only_unknown_maintenance_can_be_reconciled");
    access.idle(r.machine_id);checkBinding(p,r);
    const selected=access.credential(r.machine_id,v.credential_id??r.credential_id).credential,revision=credentialRevision(selected);
    access.busy.add(r.machine_id);
    try{
      if((await ssh(r.machine_id,selected.id,absentCommand,c.signal)).trim()!=="executor_uninstalled=verified")fail(409,"executor_removal_unverified");
      human(c);checkBinding(p,r);
      if(credentialRevision(access.credential(r.machine_id,selected.id).credential)!==revision)fail(409,"executor_maintenance_credential_changed");
      c.json(complete(r,c.user.id));
    }finally{access.busy.delete(r.machine_id);}
  }));
  return{async close(){controller.abort();await Promise.allSettled([...workers]);}};
}
