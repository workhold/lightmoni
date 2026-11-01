import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {createReadStream,copyFileSync,mkdirSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {Context,Dependencies,Module} from '../shared/types.js';
import {fail,HTTPError} from '../shared/http.js';
import {canonicalJSON,parseStrictJSON,sha256,strictRecord} from '../shared/privileged-executor.js';
import type {AgentUpdateAccess} from './machine-agent-updates.js';
import {AgentReleaseCatalog,type AgentRelease,type PinnedAgentFile} from './machine-agent-updates-catalog.js';
import type {PrivilegedExecutorStore} from './privileged-executors.js';
import {hasActiveTaskRuns} from './agent-hosts.js';
import {assertNoPendingAgentUpdate} from './machine-agent-updates-guard.js';
import {assertNoPendingMachineInstallation} from './machine-installations-guard.js';
import {assertNoPendingMachineUninstallation} from './machine-uninstallations-guard.js';
import {assertNoDockerInstallation} from './machine-docker-guard.js';
import {executorHostLockShell} from './executor-absence-shell.js';
import {agentMaintenanceShellGuards} from '../shared/agent-maintenance-shell.js';
type Row=Record<string,any>;
const q=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const root=(s:string)=>`if [ "$(id -u)" = 0 ]; then /bin/sh -c ${q(s)}; else sudo -n /bin/sh -c ${q(s)}; fi`;
export const executorUpdateProbeCommand=()=>root(`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
${agentMaintenanceShellGuards}
lm_root_entry /usr/local/bin/lightmoni-executor file
/usr/local/bin/lightmoni-executor status --config /etc/lightmoni-executor/config.json
/usr/local/bin/lightmoni-executor releases`);
export function executorUpdateCommand(origin:string,id:string,plan:Row):string {
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9]{64}$/.test(plan.release?.sha256??''))throw Error('invalid_executor_update_target');
 return root(`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
umask 077
${agentMaintenanceShellGuards}
lm_root_entry /opt directory
${executorHostLockShell('bootstrap')}
work=$(mktemp -d /opt/lightmoni-executor-update.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
IFS= read -r ticket
case "$ticket" in lm_executor_maint_*) ;; *) exit 1;; esac
printf 'header = "Authorization: Bearer %s"\\n' "$ticket" > "$work/curl.conf"
unset ticket
curl --config "$work/curl.conf" --proto '=https' --max-redirs 0 --connect-timeout 15 --max-time 180 --fail --silent --show-error --output "$work/bundle.tar.gz" ${q(origin+'/downloads/executor-updates/'+id+'/bundle.tar.gz')}
printf '%s  %s\\n' ${q(plan.release.sha256)} "$work/bundle.tar.gz" | sha256sum -c - >/dev/null
tar -tzf "$work/bundle.tar.gz" | awk 'BEGIN {n=0} /^\\// || /(^|\\/)\\.\\.(\\/|$)/ {exit 1} !/^(lightmoni-agent|lightmoni-agent.service|lightmoni-agent-runtime)(\\/|$)/ {exit 1} {n++} END {if(n<1)exit 1}'
mkdir "$work/unpacked"
tar -xzf "$work/bundle.tar.gz" --no-same-owner --no-same-permissions -C "$work/unpacked"
[ -f "$work/unpacked/lightmoni-agent-runtime/executor/upgrade.sh" ] && [ ! -L "$work/unpacked/lightmoni-agent-runtime/executor/upgrade.sh" ] || exit 1
/bin/sh "$work/unpacked/lightmoni-agent-runtime/executor/upgrade.sh" --release-dir "$work/unpacked/lightmoni-agent-runtime" --artifact-sha256 ${q(plan.release.sha256)} --action ${q(plan.action)} --activation-id ${q(id)} --expected-executor-id ${q(plan.executor_id)} --expected-install-generation ${q(String(plan.install_generation))} --expected-current-sha ${q(plan.original_release.artifact_sha256)}
`);
}
export function registerMachineExecutorUpdates(deps:Dependencies,access:AgentUpdateAccess,executors:PrivilegedExecutorStore,options:{downloadsDir:string;dataDir:string;verificationTimeoutMs?:number}):Module {
 const {db,router}=deps,now=()=>deps.now().toISOString(),prefix='/api/v1/machines/:id/executor-updates',catalog=new AgentReleaseCatalog(options.downloadsDir,join(options.dataDir,'executor-release-cache')),abort=new AbortController(),workers=new Set<Promise<void>>();
 for(const [name,type] of [['ticket_hash',"TEXT NOT NULL DEFAULT ''"],['ticket_expires_at',"TEXT NOT NULL DEFAULT ''"]])if(!db.all<{name:string}>('PRAGMA table_info(machine_executor_maintenance)').some(c=>c.name===name))db.exec('ALTER TABLE machine_executor_maintenance ADD COLUMN '+name+' '+type);
 const human=(c:Context)=>{deps.auth.requireAdmin(c);if(c.req.headers.authorization||!c.req.headers.cookie?.split(';').some(p=>p.trim().startsWith('lm_session='))||(deps.auth.user(c.req)?.id!==c.user.id||deps.auth.user(c.req)?.role!=="admin"||!deps.db.get("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'",c.user.id)))fail(403,'human_admin_session_required');};
 const fields=(v:unknown,keys:string[],required=keys)=>{try{return strictRecord(v,keys,required);}catch{fail(400,'invalid_executor_update_request')}};
 const body=async(c:Context)=>parseStrictJSON(await c.raw(65536),65536);
 const row=(host:string,id:string)=>{const r=db.get<Row>('SELECT * FROM machine_executor_maintenance WHERE machine_id=? AND id=?',host,id);if(!r||!['upgrade','rollback'].includes(JSON.parse(r.plan_json).action))fail(404,'executor_update_not_found');return r;};
 const view=(r:Row)=>({id:r.id,status:r.status,revision:r.revision,executor_id:r.executor_id,plan:JSON.parse(r.plan_json),expires_at:r.expires_at,started_at:r.started_at,finished_at:r.finished_at,error:r.error});
 const credentialHash=(v:Row)=>sha256(canonicalJSON([v.id,v.connection_credential_id??'',v.method??'',v.secret_fingerprint,v.retention??'',v.expires_at,v.revoked_at??'',v.secret_cleared_at??'']));
 const idle=(host:string,agent:string,own='')=>{assertNoPendingAgentUpdate(db,agent,host);assertNoPendingMachineInstallation(db,host,agent,true);assertNoPendingMachineUninstallation(db,host,agent);assertNoDockerInstallation(db,host,agent);if(hasActiveTaskRuns(db,agent,host)||db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",agent)||db.get("SELECT id FROM machine_executor_maintenance WHERE machine_id=? AND id<>? AND status IN ('awaiting_approval','running','unknown')",host,own))fail(409,'executor_update_tasks_pending');};
 const ssh=async(host:string,credentialID:string,command:string,signal:AbortSignal,stdin?:string)=>{const {machine,credential}=access.credential(host,credentialID);const result=await access.runner({machine,credentialID:credential.id,...access.authentication(host,credential),command,stdin,signal,port:machine.port,timeoutMs:300000});access.markCredentialUsed(credential.id);return result.stdout;};
 const probe=async(host:string,credentialID:string,signal:AbortSignal)=>{const raw=await ssh(host,credentialID,executorUpdateProbeCommand(),signal);let state:Row,releases:Row;try{const lines=raw.trim().split('\n');if(lines.length!==2)throw Error();state=parseStrictJSON(lines[0],65536);releases=parseStrictJSON(lines[1],65536);}catch{fail(409,'executor_update_probe_unavailable')};if(state.machine_id!==host||state.fenced!==null||state.pending_results!==0||!releases.current||!/^[a-f0-9]{64}$/.test(releases.current.artifact_sha256??''))fail(409,'executor_has_unresolved_local_state');return{state,releases};};
 const binding=(r:Row,p:Row)=>{const machine=access.get(r.machine_id),current=executors.getStatus(r.machine_id).executor;if(!current||current.id!==r.executor_id||current.install_generation!==p.install_generation||current.state==='revoked'||access.revision(machine)!==p.target_revision||machine.agent_id!==p.machine.agent_id||machine.name!==p.machine.name)fail(409,'executor_update_target_changed');return machine;};
 const pinned=(sha:string):{release:AgentRelease;file:PinnedAgentFile}=>{
   try{const p=catalog.pin(sha);return{release:p.release,file:p.files['bundle.tar.gz']};}catch(error){if(!(error instanceof HTTPError))throw error;}
   const tables=['machine_executor_maintenance','machine_executor_bootstraps'];
   for(const table of tables){if(!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table))continue;for(const r of db.all<Row>('SELECT plan_json FROM '+table+" WHERE status='succeeded'")){const p=JSON.parse(r.plan_json);if(p.release?.sha256!==sha||p.file?.sha256!==sha)continue;const source=new AgentReleaseCatalog(options.downloadsDir,join(options.dataDir,table==='machine_executor_bootstraps'?'executor-bootstrap-cache':'executor-release-cache')).verify(p.file);mkdirSync(catalog.cache,{recursive:true,mode:0o700});const destination=catalog.path(p.file);if(!existsSync(destination)){copyFileSync(source,destination);chmodSync(destination,0o600);}catalog.verify(p.file);return{release:p.release,file:p.file};}}
   fail(409,'executor_retained_release_unavailable');
 };
 const finish=(r:Row,status:'succeeded'|'failed',reason='')=>db.run("UPDATE machine_executor_maintenance SET status=?,finished_at=?,error=?,ticket_hash='' WHERE id=?",status,now(),reason,r.id);
 router.get(prefix+'/releases',access.safe(c=>{human(c);c.json({releases:catalog.list(),current:executors.getStatus(c.params.id).executor?.release??null});}));
 router.post(prefix+'/plan',access.safe(async c=>{
   human(c);const input=fields(await body(c),['action','credential_id','target_sha256'],['action']);if(!['upgrade','rollback'].includes(input.action)||input.credential_id!==undefined&&typeof input.credential_id!=='string'||input.target_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(input.target_sha256))fail(400,'invalid_executor_update_request');
   access.idle(c.params.id);const machine=access.get(c.params.id);idle(machine.id,machine.agent_id);const executor=executors.getStatus(machine.id).executor;if(!executor||executor.state!=='active')fail(409,'executor_not_installed');
   const selected=access.credential(machine.id,input.credential_id),observed=await probe(machine.id,selected.credential.id,c.signal);if(observed.state.executor_id!==executor.id||observed.state.install_generation!==executor.install_generation)fail(409,'executor_identity_mismatch');
   const target=input.action==='rollback'?observed.releases.previous?.artifact_sha256:input.target_sha256??catalog.list().find(r=>r.arch===observed.releases.current.arch)?.sha256;if(!target)fail(409,'executor_target_release_unavailable');const p=pinned(target);
   if(p.release.arch!==observed.releases.current.arch||p.release.sha256===observed.releases.current.artifact_sha256)fail(409,'executor_target_release_mismatch');
   const id=randomUUID(),expires=new Date(deps.now().getTime()+300000).toISOString(),plan={action:input.action,machine:{id:machine.id,name:machine.name,agent_id:machine.agent_id,address:machine.address,username:machine.username},executor_id:executor.id,install_generation:executor.install_generation,target_revision:access.revision(machine),original_release:observed.releases.current,release:p.release,file:p.file,observation:observed,credential_id:selected.credential.id,credential_revision:credentialHash(selected.credential),expires_at:expires,steps:['Verify the exact host, executor identity and idle journal','Verify the approved immutable shared release','Switch executor program; retain identity, policy, journal and business data','Restore the previous program on failure; never restore revoked permissions','Read back the signed executor build and installation identity']};
   human(c);db.transaction(()=>{binding({machine_id:machine.id,executor_id:executor.id},plan);idle(machine.id,machine.agent_id);if(credentialHash(access.credential(machine.id,selected.credential.id).credential)!==plan.credential_revision)fail(409,'executor_update_credential_changed');db.run("INSERT INTO machine_executor_maintenance(id,machine_id,executor_id,credential_id,status,plan_json,revision,created_by,created_at,expires_at) VALUES(?,?,?,?,'awaiting_approval',?,?,?,?,?)",id,machine.id,executor.id,selected.credential.id,canonicalJSON(plan),sha256(canonicalJSON(plan)),c.user.id,now(),expires);});c.json(view(row(machine.id,id)));
 }));
 router.post(prefix+'/plans/:planId/apply',access.safe(async c=>{
   human(c);const input=fields(await body(c),['confirm','expected_revision','request_id']),r=row(c.params.id,c.params.planId),p=JSON.parse(r.plan_json);if(input.confirm!==true||!/^[a-f0-9-]{36}$/.test(input.request_id??'')||input.expected_revision!==r.revision||sha256(canonicalJSON(p))!==r.revision)fail(409,'executor_update_plan_changed');if(r.request_id){if(r.request_id!==input.request_id)fail(409,'executor_update_already_applied');c.json(view(r));return;}if(r.status!=='awaiting_approval'||r.expires_at<=now())fail(409,'executor_update_expired');
   access.idle(r.machine_id);const machine=binding(r,p);idle(machine.id,machine.agent_id,r.id);if(credentialHash(access.credential(machine.id,r.credential_id).credential)!==p.credential_revision)fail(409,'executor_update_credential_changed');catalog.verify(p.file);const observed=await probe(machine.id,r.credential_id,c.signal);if(canonicalJSON(observed)!==canonicalJSON(p.observation))fail(409,'executor_update_state_changed');human(c);
   const ticket='lm_executor_maint_'+randomBytes(32).toString('base64url');db.transaction(()=>{const latest=row(machine.id,r.id);binding(latest,p);idle(machine.id,machine.agent_id,r.id);if(latest.request_id||latest.status!=='awaiting_approval'||latest.expires_at<=now())fail(409,'executor_update_state_changed');if(credentialHash(access.credential(machine.id,r.credential_id).credential)!==p.credential_revision)fail(409,'executor_update_credential_changed');db.run("UPDATE machine_executor_maintenance SET status='running',request_id=?,started_at=?,ticket_hash=?,ticket_expires_at=? WHERE id=?",input.request_id,now(),sha256(ticket),new Date(deps.now().getTime()+300000).toISOString(),r.id);});
   access.busy.add(machine.id);const work=(async()=>{try{const output=await ssh(machine.id,r.credential_id,executorUpdateCommand(new URL(deps.externalURL).origin,r.id,p),AbortSignal.any([abort.signal,AbortSignal.timeout(300000)]),ticket+'\n');if(output.trim()!=='executor_upgrade=ready')throw Error();const deadline=Date.now()+(options.verificationTimeoutMs??60000);let verified=false;while(Date.now()<deadline&&!abort.signal.aborted){binding(r,p);const e=executors.getStatus(machine.id).executor;if(e?.online&&e.release?.artifact_sha256===p.release.sha256&&e.release?.build_id===p.release.build_id&&e.release?.activation_id===r.id){verified=true;break;}await new Promise<void>(resolve=>setTimeout(resolve,500));}if(!verified)throw Error();finish(r,'succeeded');}catch{db.run("UPDATE machine_executor_maintenance SET status='unknown',ticket_hash='',error='Executor update outcome unknown; verify the original record read-only' WHERE id=? AND status='running'",r.id);}finally{access.busy.delete(machine.id);}})();workers.add(work);void work.finally(()=>workers.delete(work));c.json(view(row(machine.id,r.id)));
 }));
 router.get(prefix+'/plans',access.safe(c=>{human(c);c.json(db.all<Row>("SELECT * FROM machine_executor_maintenance WHERE machine_id=? AND json_extract(plan_json,'$.action') IN ('upgrade','rollback') ORDER BY created_at DESC LIMIT 30",c.params.id).map(view));}));
 router.get(prefix+'/plans/:planId',access.safe(c=>{human(c);c.json(view(row(c.params.id,c.params.planId)));}));
 router.post(prefix+'/plans/:planId/cancel',access.safe(c=>{human(c);const r=row(c.params.id,c.params.planId);if(r.status!=='awaiting_approval')fail(409,'executor_update_already_started');finish(r,'failed','Unstarted plan cancelled');db.run("UPDATE machine_executor_maintenance SET status='cancelled' WHERE id=?",r.id);c.json(view(row(r.machine_id,r.id)));}));
 router.post(prefix+'/plans/:planId/reconcile',access.safe(async c=>{human(c);const input=fields(await body(c),['credential_id'],[]),r=row(c.params.id,c.params.planId),p=JSON.parse(r.plan_json);if(r.status!=='unknown')fail(409,'only_unknown_can_be_reconciled');access.idle(r.machine_id);const machine=binding(r,p);idle(machine.id,machine.agent_id,r.id);const selected=access.credential(machine.id,input.credential_id??r.credential_id),fingerprint=credentialHash(selected.credential),observed=await probe(machine.id,selected.credential.id,c.signal);human(c);binding(r,p);if(credentialHash(access.credential(machine.id,selected.credential.id).credential)!==fingerprint)fail(409,'executor_update_credential_changed');if(observed.state.executor_id!==r.executor_id||observed.state.install_generation!==p.install_generation)fail(409,'executor_identity_mismatch');if(observed.releases.current.artifact_sha256===p.release.sha256){const actual=executors.getStatus(r.machine_id).executor;if(!actual?.online||actual.release?.artifact_sha256!==p.release.sha256||actual.release?.build_id!==p.release.build_id||actual.release?.activation_id!==r.id||observed.state.activation_id!==r.id)fail(409,'executor_signed_build_verification_pending');finish(r,'succeeded');}else if(canonicalJSON(observed.releases.current)===canonicalJSON(p.original_release))finish(r,'failed','Read-only verification confirmed the original program is retained');else fail(409,'executor_update_unverified');c.json(view(row(r.machine_id,r.id)));}));
 router.get('/downloads/executor-updates/:planId/bundle.tar.gz',access.safe(async c=>{const r=db.get<Row>("SELECT * FROM machine_executor_maintenance WHERE id=? AND status='running'",c.params.planId),token=String(c.req.headers.authorization??'').replace(/^Bearer /,'');if(!r||!r.ticket_hash||r.ticket_expires_at<=now()||!token.startsWith('lm_executor_maint_')||!timingSafeEqual(Buffer.from(sha256(token)),Buffer.from(r.ticket_hash)))fail(401,'executor_update_ticket_required');const p=JSON.parse(r.plan_json);if(!db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",r.created_by))fail(403,'active_human_admin_required');binding(r,p);const path=catalog.verify(p.file);db.run("UPDATE machine_executor_maintenance SET ticket_hash='' WHERE id=?",r.id);c.res.setHeader('Content-Type','application/gzip');c.res.setHeader('Cache-Control','no-store');c.res.setHeader('Content-Length',p.file.size);await pipeline(createReadStream(path),c.res);}),{public:true});
 return{async close(){abort.abort();await Promise.allSettled([...workers]);}};
}
