import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context, Dependencies, Module } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { canonicalJSON, sha256, strictRecord, parseStrictJSON, executorActivationID } from "../shared/privileged-executor.js";
import type { AgentUpdateAccess } from "./machine-agent-updates.js";
import type { PrivilegedExecutorStore } from "./privileged-executors.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
import { assertNoPendingMachineUninstallation } from "./machine-uninstallations-guard.js";
import { assertNoDockerInstallation } from "./machine-docker-guard.js";
import { agentMaintenanceShellGuards } from "../shared/agent-maintenance-shell.js";
import { executorHostLockShell, executorAbsenceProofShell } from "./executor-absence-shell.js";
import { AgentReleaseCatalog } from "./machine-agent-updates-catalog.js";

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
const SHA=/^[a-f0-9]{64}$/;
const programPreamble=`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
umask 077
[ "$(id -u)" = 0 ] || exit 1
${executorHostLockShell("bootstrap")}
${executorHostLockShell("lifecycle")}
${agentMaintenanceShellGuards}
for p in /opt /opt/lightmoni-executor /opt/lightmoni-executor/releases; do lm_root_entry "$p" directory; done
if [ -e /opt/lightmoni-executor/current ] || [ -L /opt/lightmoni-executor/current ]; then
  [ -L /opt/lightmoni-executor/current ] && [ "$(stat -c %u /opt/lightmoni-executor/current)" = 0 ] || exit 1
  release=$(readlink -f /opt/lightmoni-executor/current)
else
  lm_root_entry /opt/lightmoni-executor/install-state.json file
  [ -f /opt/lightmoni-executor/install-state.json ] || exit 1
  release_name=$(sed -n 's/.*"release_name"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9._-]*\\)".*/\\1/p' /opt/lightmoni-executor/install-state.json)
  case "$release_name" in ''|.|..|*[!A-Za-z0-9._-]*) exit 1;; esac
  [ "$(printf %s "$release_name" | wc -c)" -le 128 ] || exit 1
  release="/opt/lightmoni-executor/releases/$release_name"
fi
[ "$(dirname -- "$release")" = /opt/lightmoni-executor/releases ] || exit 1
lm_root_entry "$release" directory
lm_root_entry "$release/node" file
lm_root_entry "$release/executor" directory
lm_root_entry "$release/executor/maintenance.mjs" file`;
/** Every program operation shares the bootstrap and lifecycle fences. stdin is
 * data only; no credential, task code or arbitrary command is interpolated. */
export const executorProgramProbeCommand=()=>rootCommand(programPreamble+`
"$release/node" "$release/executor/maintenance.mjs" probe`);
export const executorProgramStatusCommand=()=>rootCommand(programPreamble+`
"$release/node" "$release/executor/maintenance.mjs" status`);
export function executorProgramApplyCommand(origin:string,operation:string,upgrade:boolean):string {
  if(!/^[a-f0-9-]{36}$/.test(operation))throw Error("invalid_executor_operation");
  const u=new URL(origin);if(u.protocol!=="https:"||u.origin!==origin)throw Error("https_center_origin_required");
  return rootCommand(programPreamble+`
work=$(mktemp -d /run/lightmoni-executor-maintenance.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
IFS= read -r ticket
cat > "$work/request.json"
${upgrade?`printf 'header = "Authorization: Bearer %s"\\n' "$ticket" > "$work/curl.conf"
unset ticket
curl --config "$work/curl.conf" --proto '=https' --max-redirs 0 --connect-timeout 15 --max-time 180 --fail --silent --show-error --output "$work/bundle.tar.gz" ${q(origin+"/downloads/executor-maintenance/"+operation+"/bundle.tar.gz")}
"$release/node" -e 'const fs=require("node:fs");const p=process.argv[1],v=JSON.parse(fs.readFileSync(p));v.archive_path=process.argv[2];fs.writeFileSync(p,JSON.stringify(v));' "$work/request.json" "$work/bundle.tar.gz"`:"unset ticket"}
"$release/node" "$release/executor/maintenance.mjs" apply < "$work/request.json"`);
}
const releaseView=(value:unknown,fingerprint:boolean)=>{
  const required=["version","build_id","source_revision","artifact_sha256","state_schema","arch"];
  let r:Row;try{r=strictRecord(value,[...required,"fingerprint"],fingerprint?[...required,"fingerprint"]:required)}catch{fail(409,"invalid_executor_program_observation");}
  if(!/^[A-Za-z0-9._-]{1,128}$/.test(r.version)||!/^[A-Za-z0-9._-]{1,128}$/.test(r.build_id)||!/^[a-f0-9]{40}$/.test(r.source_revision)
    ||!SHA.test(r.artifact_sha256)||r.state_schema!==1||!["amd64","arm64"].includes(r.arch)||(fingerprint||r.fingerprint!==undefined)&&!SHA.test(r.fingerprint))fail(409,"invalid_executor_program_observation");
  return r;
};
function programObservation(value:unknown):Row {
  let s:Row;try{s=strictRecord(value,["schema","executor_id","machine_id","agent_id","center_instance_id","public_key_sha256","activation_id","install_generation","policy_generation","fenced","pending_results","service_active","current","previous","repairable","phase"]);}catch{fail(409,"invalid_executor_program_observation");}
  for(const key of ["executor_id","machine_id","agent_id","center_instance_id"])if(typeof s[key]!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(s[key]))fail(409,"invalid_executor_program_observation");
  if(s.schema!==1||!SHA.test(s.public_key_sha256)||!executorActivationID(s.activation_id)||!Number.isSafeInteger(s.install_generation)||s.install_generation<1||!Number.isSafeInteger(s.policy_generation)||s.policy_generation<1
    ||!Number.isSafeInteger(s.pending_results)||s.pending_results<0||typeof s.service_active!=="boolean"||typeof s.repairable!=="boolean"||typeof s.phase!=="string"||!/^[a-z_]{1,64}$/.test(s.phase))fail(409,"invalid_executor_program_observation");
  if(s.fenced!==null){let f:Row;try{f=strictRecord(s.fenced,["job_id","state"])}catch{fail(409,"invalid_executor_program_observation");}if(typeof f.job_id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(f.job_id)||!["prepared","intent","running","unknown"].includes(f.state))fail(409,"invalid_executor_program_observation");}
  s.current=releaseView(s.current,true);if(s.previous!==null)s.previous=releaseView(s.previous,true);return s;
}
export function registerMachineExecutorMaintenance(deps:Dependencies,access:AgentUpdateAccess,executors:PrivilegedExecutorStore,
  options:{downloadsDir:string;dataDir:string}={downloadsDir:join(process.cwd(),"downloads"),dataDir:join(process.cwd(),".local-dev")}):Module {
  const {db,router}=deps,now=()=>deps.now().toISOString(),controller=new AbortController(),workers=new Set<Promise<void>>();
  db.exec(`CREATE TABLE IF NOT EXISTS machine_executor_maintenance(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,executor_id TEXT NOT NULL,credential_id TEXT NOT NULL,
    status TEXT NOT NULL,plan_json TEXT NOT NULL,revision TEXT NOT NULL,request_id TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',receipt_json TEXT NOT NULL DEFAULT '',token_hash TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS executor_maintenance_lane ON machine_executor_maintenance(machine_id) WHERE status IN ('awaiting_approval','running','unknown');`);
  for(const name of ["receipt_json","token_hash"])if(!db.all<{name:string}>("PRAGMA table_info(machine_executor_maintenance)").some(c=>c.name===name))db.exec(`ALTER TABLE machine_executor_maintenance ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  db.run("UPDATE machine_executor_maintenance SET status='unknown',token_hash='',error='平台在维护期间重启，请通过原记录只读核对' WHERE status='running'");
  const catalog=new AgentReleaseCatalog(options.downloadsDir,join(options.dataDir,"executor-maintenance-cache"));
  const human=(c:Context)=>{
    deps.auth.requireAdmin(c);
    if(c.req.headers.authorization||!c.req.headers.cookie?.split(";").some(p=>p.trim().startsWith("lm_session="))||deps.auth.user(c.req)?.id!==c.user.id)fail(403,"human_admin_session_required");
  };
  const input=(v:unknown,keys:string[],required=keys)=>{try{return strictRecord(v,keys,required);}catch{fail(400,"invalid_executor_maintenance_request");}};
  const body=async(c:Context)=>{try{return parseStrictJSON(await c.raw(65536),65536);}catch{fail(400,"invalid_executor_maintenance_request");}};
  const credentialRevision=(v:Row)=>sha256(canonicalJSON([v.id,v.connection_credential_id??"",v.method??"",v.secret_fingerprint,v.retention??"",v.expires_at,v.revoked_at??"",v.secret_cleared_at??""]));
  const row=(host:string,id:string)=>{const r=db.get<Row>("SELECT * FROM machine_executor_maintenance WHERE machine_id=? AND id=?",host,id);if(!r)fail(404,"executor_maintenance_not_found");return r;};
  const view=(r:Row)=>({id:r.id,status:r.status,revision:r.revision,plan:JSON.parse(r.plan_json),executor_id:r.executor_id,expires_at:r.expires_at,started_at:r.started_at,finished_at:r.finished_at,error:r.error,
    receipt:r.receipt_json?JSON.parse(r.receipt_json):null});
  const table=(name:string)=>!!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name);
  const checkOther=(host:string,agent:string,own="",sourceBootstrap="")=>{
    assertNoPendingAgentUpdate(db,agent,host);assertNoPendingMachineInstallation(db,host,agent,true);assertNoPendingMachineUninstallation(db,host,agent);
    assertNoDockerInstallation(db,host,agent);
    if(table("machine_executor_bootstraps")&&db.get("SELECT id FROM machine_executor_bootstraps WHERE (agent_id=? OR machine_id=?) AND id!=? AND status IN ('running','verifying','unknown') LIMIT 1",agent,host,sourceBootstrap))fail(409,"executor_maintenance_tasks_pending");
    if(table("task_runs")&&db.get("SELECT id FROM task_runs WHERE (agent_id=? OR host_id=?) AND (state IN ('queued','running') OR (state='unknown' AND superseded_by='' AND resolved_at='')) LIMIT 1",agent,host))fail(409,"executor_maintenance_tasks_pending");
    if(db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",agent))fail(409,"executor_maintenance_tasks_pending");
    if(table("privileged_jobs")&&db.get("SELECT id FROM privileged_jobs WHERE machine_id=? AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='')) LIMIT 1",host))fail(409,"executor_maintenance_tasks_pending");
    if(db.get("SELECT id FROM machine_executor_maintenance WHERE machine_id=? AND id!=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1",host,own))fail(409,"executor_maintenance_pending");
  };
  const ssh=async(host:string,credentialID:string,command:string,signal:AbortSignal,stdin?:string,timeoutMs=60_000)=>{
    const {machine,credential}=access.credential(host,credentialID);
    try {
      const output=await access.runner({machine,credentialID:credential.id,...access.authentication(host,credential),command,signal,stdin,port:machine.port,timeoutMs});
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
  const clean=(s:Row)=>{if(s.fenced!==null||s.pending_results!==0)fail(409,"executor_has_unresolved_local_state");};
  const programBinding=(host:string,s:Row)=>{
    const e=executors.getStatus(host).executor,m=access.get(host),identity=e&&db.get<Row>("SELECT * FROM privileged_executors WHERE id=? AND machine_id=?",e.id,host);
    if(!e||e.state!=="active"||!identity?.public_key||s.executor_id!==e.id||s.machine_id!==host||s.agent_id!==m.agent_id||identity.agent_id!==m.agent_id
      ||s.install_generation!==e.install_generation||s.center_instance_id!==executors.centerInstanceID||s.public_key_sha256!==sha256(identity.public_key))fail(409,"executor_identity_mismatch");
    return e;
  };
  const programProbe=async(host:string,credential:string,signal:AbortSignal)=>{
    let parsed:unknown;try{parsed=parseStrictJSON(await ssh(host,credential,executorProgramProbeCommand(),signal),65536)}catch{fail(409,"executor_program_probe_unverified");}
    const s=programObservation(parsed);programBinding(host,s);return s;
  };
  const sameRelease=(actual:Row,target:Row)=>["version","build_id","source_revision","artifact_sha256","state_schema","arch"].every(key=>actual[key]===target[key])&&(!target.fingerprint||actual.fingerprint===target.fingerprint);
  const bootstrapSource=(machine:Row,executor:Row,action:string)=>{
    if(action!=="repair"||!table("machine_executor_bootstraps"))return "";
    const b=db.get<Row>("SELECT * FROM machine_executor_bootstraps WHERE machine_id=? AND status IN ('running','verifying','unknown')",machine.id);
    if(!b)return "";
    if(b.status!=="unknown"||b.executor_id!==executor.id||b.agent_id!==machine.agent_id||b.install_generation!==executor.install_generation||b.token_hash)fail(409,"executor_bootstrap_recovery_unverified");
    return b.id as string;
  };
  const sourceBinding=(p:Row)=>{
    if(!p.source_bootstrap_id)return;
    const b=table("machine_executor_bootstraps")&&db.get<Row>("SELECT * FROM machine_executor_bootstraps WHERE id=?",p.source_bootstrap_id);
    if(!b||b.status!=="unknown"||b.executor_id!==p.executor_id||b.machine_id!==p.machine.id||b.install_generation!==p.install_generation||b.agent_id!==p.machine.agent_id||b.token_hash)fail(409,"executor_bootstrap_recovery_unverified");
    const original=JSON.parse(b.plan_json);
    if(sha256(canonicalJSON(original))!==b.revision||original.release?.sha256!==p.current.artifact_sha256||original.release?.build_id!==p.current.build_id)fail(409,"executor_bootstrap_recovery_unverified");
  };
  const programComplete=(r:Row,reconciliation?:Row)=>db.transaction(()=>{
    const current=row(r.machine_id,r.id),p=JSON.parse(current.plan_json);
    if(current.status==="succeeded")return current;
    if(!["running","unknown"].includes(current.status))fail(409,"executor_maintenance_state_changed");
    const machine=checkBinding(p,current);checkOther(machine.id,machine.agent_id,current.id,p.source_bootstrap_id??"");sourceBinding(p);
    if(reconciliation)db.run("UPDATE machine_executor_maintenance SET receipt_json=? WHERE id=?",canonicalJSON({...JSON.parse(current.receipt_json),reconciliation}),r.id);
    db.run("UPDATE machine_executor_maintenance SET status='succeeded',token_hash='',finished_at=?,error='' WHERE id=?",now(),r.id);
    if(p.source_bootstrap_id)db.run("UPDATE machine_executor_bootstraps SET status='succeeded',token_hash='',finished_at=?,error='' WHERE id=? AND status='unknown'",now(),p.source_bootstrap_id);
    return row(r.machine_id,r.id);
  });
  const signedActivation=(r:Row,p:Row)=>{
    const e=executors.getStatus(r.machine_id).executor;
    return !!e&&e.state==="active"&&e.id===r.executor_id&&e.install_generation===p.install_generation&&e.activation_id===r.id&&e.online&&Date.parse(e.last_seen)>Date.parse(r.started_at)
      &&e.release?.build_id===p.target.build_id&&e.release.source_revision===p.target.source_revision&&e.release.artifact_sha256===p.target.artifact_sha256&&e.release.state_schema===p.target.state_schema;
  };
  const refreshProgram=(r:Row)=>{
    const p=JSON.parse(r.plan_json);
    if(sha256(canonicalJSON(p))!==r.revision)fail(409,"executor_maintenance_plan_changed");
    if(p.action==="uninstall"||!["running","unknown"].includes(r.status)||!r.receipt_json)return r;
    const receipt=JSON.parse(r.receipt_json),s=receipt.observation;
    if(receipt.status!=="started"||receipt.activation_id!==r.id||s?.activation_id!==r.id||!s?.service_active||!sameRelease(s.current,p.target))return r;
    if(signedActivation(r,p))return programComplete(r);
    if(r.status==="running"&&Date.parse(r.started_at)+300_000<=deps.now().getTime()){
      db.run("UPDATE machine_executor_maintenance SET status='unknown',token_hash='',error='独立签名心跳未确认，请通过原记录只读核对' WHERE id=? AND status='running'",r.id);
      return row(r.machine_id,r.id);
    }
    return r;
  };
  const parseReceipt=(raw:string,r:Row,p:Row)=>{
    let v:Row;try{v=strictRecord(parseStrictJSON(raw,65536),["receipt","observation"])}catch{fail(409,"executor_maintenance_receipt_unverified");}
    const s=programObservation(v.observation);programBinding(r.machine_id,s);clean(s);
    if(s.policy_generation<p.policy_generation)fail(409,"executor_policy_watermark_changed");
    if(v.receipt===null)return {receipt:null,observation:s};
    const x=v.receipt;
    if(!x||typeof x!=="object"||x.schema!==1||x.operation_id!==r.id||x.action!==p.action||x.executor_id!==r.executor_id||x.machine_id!==r.machine_id||x.install_generation!==p.install_generation
      ||!["intent","switching","started","unknown"].includes(x.status))fail(409,"executor_maintenance_receipt_unverified");
    if(["agent_id","center_instance_id","public_key_sha256"].some(key=>x[key]!==p.observation[key])||x.policy_generation!==p.policy_generation||x.activation_id!==r.id)fail(409,"executor_maintenance_receipt_unverified");
    if(!sameRelease(releaseView(x.source,true),p.current))fail(409,"executor_maintenance_receipt_unverified");
    const target=releaseView(x.target,p.action==="rollback"||p.action==="repair");
    if(!sameRelease(target,p.target))fail(409,"executor_maintenance_receipt_unverified");
    return {receipt:{schema:1,operation_id:r.id,action:p.action,executor_id:r.executor_id,machine_id:r.machine_id,install_generation:p.install_generation,
      agent_id:x.agent_id,center_instance_id:x.center_instance_id,public_key_sha256:x.public_key_sha256,activation_id:x.activation_id,policy_generation:x.policy_generation,source:x.source,status:x.status,target},observation:s};
  };
  const storeReceipt=(r:Row,value:ReturnType<typeof parseReceipt>)=>{
    if(!value.receipt)return;
    db.run("UPDATE machine_executor_maintenance SET receipt_json=? WHERE id=? AND status IN ('running','unknown')",canonicalJSON({...value.receipt,observation:value.observation}),r.id);
  };
  const prepareProgram=async(c:Context,v:Row)=>{
    try{const endpoint=new URL(deps.externalURL);if(endpoint.protocol!=="https:"||endpoint.origin!==deps.externalURL.replace(/\/$/,""))throw Error();}catch{fail(409,"https_center_origin_required");}
    access.idle(c.params.id);const machine=access.get(c.params.id),e=executors.getStatus(machine.id).executor;
    if(!e||e.state!=="active")fail(409,"executor_active_identity_required");
    const source=bootstrapSource(machine,e,v.action);checkOther(machine.id,machine.agent_id,"",source);
    const selected=access.credential(machine.id,v.credential_id),s=await programProbe(machine.id,selected.credential.id,c.signal);clean(s);
    if(v.action==="repair"&&!s.repairable)fail(409,"executor_repair_phase_unverified");
    if(v.action!=="repair"&&(!s.service_active||s.repairable))fail(409,"executor_requires_reviewed_repair");
    if(s.policy_generation!==executors.getStatus(machine.id).policy_generation)fail(409,"executor_policy_watermark_changed");
    let target:Row,file:Row|undefined;
    if(v.action==="upgrade"){
      const release=v.target_sha256?catalog.get(v.target_sha256):catalog.list().find(r=>r.arch===s.current.arch&&r.sha256!==s.current.artifact_sha256);
      if(!release||release.arch!==s.current.arch||release.state_schema!==s.current.state_schema||release.sha256===s.current.artifact_sha256)fail(409,"executor_target_release_unavailable");
      const pinned=catalog.pinBundle(release.sha256);file=pinned.file;
      target={version:release.version,build_id:release.build_id,source_revision:release.source_revision,artifact_sha256:release.sha256,state_schema:release.state_schema,arch:release.arch};
    }else{
      target=v.action==="rollback"?s.previous:s.current;
      if(!target||target.state_schema!==s.current.state_schema||target.arch!==s.current.arch)fail(409,"executor_previous_release_unavailable");
      if(v.action==="rollback"&&target.fingerprint===s.current.fingerprint)fail(409,"executor_previous_release_unavailable");
    }
    const expires=new Date(deps.now().getTime()+300_000).toISOString(),id=randomUUID();
    const p={action:v.action,machine:{id:machine.id,name:machine.name,agent_id:machine.agent_id,address:machine.address,port:machine.port,username:machine.username},executor_id:e.id,install_generation:e.install_generation,
      target_revision:access.revision(machine),observation:s,current:s.current,target,policy_generation:s.policy_generation,source_bootstrap_id:source,
      credential_id:selected.credential.id,credential_revision:credentialRevision(selected.credential),...(file?{file}:{}),expires_at:expires,
      steps:["复核独立执行器身份、策略水位与完整本地日志","停止固定服务并取得唯一 writer 锁，拒绝未决副作用",v.action==="rollback"?"切回精确保留的旧程序；不恢复身份或执行日志":v.action==="repair"?"仅修复已证明中断的程序入口、固定服务与启动阶段":"验证固定发行摘要并原子切换程序；不恢复身份或执行日志","核对持久维护回执与新鲜独立签名心跳"]};
    human(c);const revision=sha256(canonicalJSON(p));
    db.transaction(()=>{
      checkBinding(p,{machine_id:machine.id,executor_id:e.id});checkOther(machine.id,machine.agent_id,"",source);sourceBinding(p);
      programBinding(machine.id,s);
      if(credentialRevision(access.credential(machine.id,selected.credential.id).credential)!==p.credential_revision||executors.getStatus(machine.id).policy_generation!==p.policy_generation)fail(409,"executor_maintenance_credential_or_policy_changed");
      db.run("INSERT INTO machine_executor_maintenance(id,machine_id,executor_id,credential_id,status,plan_json,revision,created_by,created_at,expires_at) VALUES(?,?,?,?,'awaiting_approval',?,?,?,?,?)",id,machine.id,e.id,selected.credential.id,canonicalJSON(p),revision,c.user.id,now(),expires);
    });return view(row(machine.id,id));
  };
  const applyProgram=async(c:Context,v:Row,r:Row,p:Row)=>{
    access.idle(r.machine_id);const machine=checkBinding(p,r);sourceBinding(p);checkOther(machine.id,machine.agent_id,r.id,p.source_bootstrap_id??"");
    const credential=access.credential(machine.id,r.credential_id).credential;
    if(credentialRevision(credential)!==p.credential_revision||executors.getStatus(machine.id).policy_generation!==p.policy_generation)fail(409,"executor_maintenance_credential_or_policy_changed");
    const s=await programProbe(machine.id,r.credential_id,c.signal);clean(s);
    if(canonicalJSON(s)!==canonicalJSON(p.observation))fail(409,"executor_maintenance_state_changed");
    if(p.file)catalog.verify(p.file);
    human(c);const ticket="lm_executor_maintenance_"+randomBytes(32).toString("base64url");
    db.transaction(()=>{
      const current=row(machine.id,r.id);checkBinding(p,current);sourceBinding(p);checkOther(machine.id,machine.agent_id,r.id,p.source_bootstrap_id??"");programBinding(machine.id,s);
      if(current.status!=="awaiting_approval"||current.request_id||Date.parse(current.expires_at)<=deps.now().getTime())fail(409,"executor_maintenance_state_changed");
      if(credentialRevision(access.credential(machine.id,r.credential_id).credential)!==p.credential_revision||executors.getStatus(machine.id).policy_generation!==p.policy_generation)fail(409,"executor_maintenance_credential_or_policy_changed");
      db.run("UPDATE machine_executor_maintenance SET status='running',request_id=?,started_at=?,token_hash=? WHERE id=?",v.request_id,now(),sha256(ticket),r.id);
    });
    access.busy.add(machine.id);
    const work=(async()=>{try{
      const request={operation_id:r.id,action:p.action,executor_id:r.executor_id,machine_id:r.machine_id,install_generation:p.install_generation,
        agent_id:p.observation.agent_id,center_instance_id:p.observation.center_instance_id,public_key_sha256:p.observation.public_key_sha256,
        expected_fingerprint:p.current.fingerprint,expected_policy_generation:p.policy_generation,target:p.target,start_deadline:new Date(deps.now().getTime()+240_000).toISOString()};
      const output=await ssh(machine.id,r.credential_id,executorProgramApplyCommand(new URL(deps.externalURL).origin,r.id,p.action==="upgrade"),
        AbortSignal.any([controller.signal,AbortSignal.timeout(270_000)]),ticket+"\n"+canonicalJSON(request),270_000);
      const result=parseReceipt(output,r,p);
      if(result.receipt?.status!=="started"||!result.observation.service_active||!sameRelease(result.observation.current,p.target))throw Error();
      checkBinding(p,r);sourceBinding(p);storeReceipt(r,result);
      db.run("UPDATE machine_executor_maintenance SET token_hash='' WHERE id=?",r.id);refreshProgram(row(machine.id,r.id));
    }catch{db.run("UPDATE machine_executor_maintenance SET status='unknown',token_hash='',error='维护结果未知，请通过原记录只读核对；不会自动回退或重试' WHERE id=? AND status='running'",r.id);}finally{access.busy.delete(machine.id);}})();
    workers.add(work);void work.finally(()=>workers.delete(work));return view(row(machine.id,r.id));
  };
  const reconcileProgram=async(c:Context,v:Row,r:Row,p:Row)=>{
    access.idle(r.machine_id);const machine=checkBinding(p,r);sourceBinding(p);checkOther(machine.id,machine.agent_id,r.id,p.source_bootstrap_id??"");
    const credential=access.credential(r.machine_id,v.credential_id??r.credential_id).credential,revision=credentialRevision(credential);
    access.busy.add(r.machine_id);
    try{
      const result=parseReceipt(await ssh(r.machine_id,credential.id,executorProgramStatusCommand(),c.signal,canonicalJSON({operation_id:r.id})),r,p);
      human(c);checkBinding(p,r);sourceBinding(p);checkOther(machine.id,machine.agent_id,r.id,p.source_bootstrap_id??"");
      if(credentialRevision(access.credential(r.machine_id,credential.id).credential)!==revision)fail(409,"executor_maintenance_credential_changed");
      const current=row(r.machine_id,r.id);if(current.status!=="unknown"||current.revision!==r.revision)fail(409,"executor_maintenance_state_changed");
      storeReceipt(r,result);
      if(result.receipt?.status==="started"&&result.observation.service_active&&sameRelease(result.observation.current,p.target)){
        const refreshed=refreshProgram(row(r.machine_id,r.id));
        if(refreshed.status!=="succeeded")fail(409,"executor_signed_heartbeat_not_confirmed");
        return view(refreshed);
      }
      const observed=result.observation;
      if(result.receipt&&observed.phase==="ready"&&observed.service_active&&observed.activation_id===r.id&&sameRelease(observed.current,p.target)&&signedActivation(r,p)){
        // A crash may follow durable ready but precede the final receipt write.
        // Only this explicit read-only reconciliation accepts that evidence;
        // retain the actual intent status rather than inventing "started".
        return view(programComplete(row(r.machine_id,r.id),{kind:"read_only_activation",activation_id:r.id,observed_at:now(),fingerprint:observed.current.fingerprint,
          signed_heartbeat_at:executors.getStatus(r.machine_id).executor!.last_seen}));
      }
      // Holding the same remote lifecycle lock plus an absent intent proves this
      // operation never started. A durable failed intent with an inactive exact
      // service can end only this maintenance fence; execution fences stay put.
      const notStarted=result.receipt===null&&canonicalJSON(observed)===canonicalJSON(p.observation);
      const interrupted=!!result.receipt&&["intent","switching","unknown"].includes(result.receipt.status)&&!observed.service_active
        &&(sameRelease(observed.current,p.current)||sameRelease(observed.current,p.target));
      const stopRefused=!!result.receipt&&["intent","unknown"].includes(result.receipt.status)&&observed.phase==="start"&&observed.service_active&&p.observation.service_active
        &&observed.activation_id===p.observation.activation_id&&sameRelease(observed.current,p.current)&&canonicalJSON(observed.previous)===canonicalJSON(p.observation.previous);
      if(!notStarted&&!interrupted&&!stopRefused)fail(409,"executor_maintenance_recovery_unverified");
      db.transaction(()=>{
        const fresh=row(r.machine_id,r.id);if(fresh.status!=="unknown"||fresh.revision!==r.revision)fail(409,"executor_maintenance_state_changed");
        checkBinding(p,fresh);sourceBinding(p);checkOther(machine.id,machine.agent_id,r.id,p.source_bootstrap_id??"");
        db.run("UPDATE machine_executor_maintenance SET status='failed',token_hash='',finished_at=?,error=? WHERE id=?",now(),notStarted?"已只读确认本次维护未开始；未执行重试":"已只读确认本次维护中断且无未决执行；保留程序和身份现场，请重新审阅修复",r.id);
      });return view(row(r.machine_id,r.id));
    }finally{access.busy.delete(r.machine_id);}
  };
  router.post("/api/v1/machines/:id/executor-maintenance/plan",access.safe(async c=>{
    human(c);const v=input(await body(c),["action","credential_id","target_sha256"],["action"]);if(!["uninstall","upgrade","rollback","repair"].includes(v.action))fail(400,"executor_maintenance_action_not_available");
    if(v.credential_id!==undefined&&(typeof v.credential_id!=="string"||!v.credential_id))fail(400,"invalid_credential_id");
    if(v.target_sha256!==undefined&&(v.action!=="upgrade"||typeof v.target_sha256!=="string"||!SHA.test(v.target_sha256)))fail(400,"invalid_target_release");
    if(v.action!=="uninstall"){c.json(await prepareProgram(c,v));return;}
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
    if(r.request_id){if(r.request_id!==v.request_id)fail(409,"executor_maintenance_already_applied");c.json(view(refreshProgram(r)));return;}
    if(r.status!=="awaiting_approval"||Date.parse(r.expires_at)<=deps.now().getTime())fail(409,"executor_maintenance_expired");
    if(p.action!=="uninstall"){c.json(await applyProgram(c,v,r,p));return;}
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
  router.get("/api/v1/machines/:id/executor-maintenance/plans",access.safe(c=>{human(c);c.json(db.all<Row>("SELECT * FROM machine_executor_maintenance WHERE machine_id=? ORDER BY created_at DESC LIMIT 30",c.params.id).map(r=>view(refreshProgram(r))));}));
  router.get("/api/v1/machines/:id/executor-maintenance/plans/:planId",access.safe(c=>{human(c);c.json(view(refreshProgram(row(c.params.id,c.params.planId))));}));
  router.post("/api/v1/machines/:id/executor-maintenance/plans/:planId/cancel",access.safe(c=>{human(c);const r=row(c.params.id,c.params.planId);if(r.status!=="awaiting_approval")fail(409,"only_unstarted_maintenance_can_be_cancelled");db.run("UPDATE machine_executor_maintenance SET status='cancelled',finished_at=? WHERE id=?",now(),r.id);c.json(view(row(r.machine_id,r.id)));}));
  router.post("/api/v1/machines/:id/executor-maintenance/plans/:planId/reconcile",access.safe(async c=>{
    human(c);const v=input(await body(c),["credential_id"],[]),r=row(c.params.id,c.params.planId),p=JSON.parse(r.plan_json);
    if(v.credential_id!==undefined&&(typeof v.credential_id!=="string"||!v.credential_id))fail(400,"invalid_credential_id");
    if(r.status!=="unknown")fail(409,"only_unknown_maintenance_can_be_reconciled");
    if(sha256(canonicalJSON(p))!==r.revision)fail(409,"executor_maintenance_plan_changed");
    if(p.action!=="uninstall"){c.json(await reconcileProgram(c,v,r,p));return;}
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
  router.get("/api/v1/machines/:id/executor-maintenance/releases",access.safe(c=>{human(c);access.get(c.params.id);c.json({releases:catalog.list()});}));
  router.get("/api/v1/machines/:id/executor-maintenance/probe",access.safe(async c=>{
    human(c);access.idle(c.params.id);const selected=access.credential(c.params.id,c.url.searchParams.get("credential_id")??undefined);
    const s=await programProbe(c.params.id,selected.credential.id,c.signal);human(c);c.json(s);
  }));
  router.get("/downloads/executor-maintenance/:operationId/bundle.tar.gz",access.safe(async c=>{
    const authorization=c.req.headers.authorization,r=db.get<Row>("SELECT * FROM machine_executor_maintenance WHERE id=?",c.params.operationId);
    if(typeof authorization!=="string"||!authorization.startsWith("Bearer ")||!r||r.status!=="running"||!r.token_hash||sha256(authorization.slice(7))!==r.token_hash
      ||!Number.isFinite(Date.parse(r.started_at))||Date.parse(r.started_at)>deps.now().getTime()||Date.parse(r.started_at)+240_000<=deps.now().getTime())fail(403,"executor_maintenance_ticket_invalid");
    const p=JSON.parse(r.plan_json);if(p.action!=="upgrade"||!p.file)fail(403,"executor_maintenance_ticket_invalid");
    const file=catalog.verify(p.file);c.res.statusCode=200;c.res.setHeader("Content-Type","application/gzip");c.res.setHeader("Content-Length",p.file.size);c.res.setHeader("Cache-Control","no-store");await pipeline(createReadStream(file),c.res);
  }),{public:true});
  return{async close(){controller.abort();await Promise.allSettled([...workers]);}};
}
