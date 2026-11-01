import { id } from '../shared/crypto.js';
import { fail } from '../shared/http.js';
import type { Context, Dependencies, Handler } from '../shared/types.js';
import type { MachineSummary } from './managed-machines.js';
import { SSHError, type SSHRunner } from './machine-ssh.js';
import { dockerInstallScript } from './docker-install-script.js';
import { assertNoDockerInstallation } from './machine-docker-guard.js';
import { hasActiveTaskRuns } from './agent-hosts.js';
import { assertNoPendingAgentUpdate } from './machine-agent-updates-guard.js';
import { assertNoPendingMachineInstallation } from './machine-installations-guard.js';
import { assertNoPrivilegedExecution } from './privileged-execution-guard.js';
interface Access {
 get(id:string):MachineSummary; idle(id:string):void; busy:Set<string>;
 credential(id:string,credentialID?:string):{machine:MachineSummary;credential:any};
 authentication(id:string,credential:any):{privateKey:string;password?:string};
 markCredentialUsed(id:string):void;runner:SSHRunner;safe(fn:Handler):Handler;
}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const privileged=(s:string,start=false)=>`if test "$(id -u)" = 0; then /bin/sh -c ${quote(s)}; elif sudo -n true >/dev/null 2>&1; then sudo -n /bin/sh -c ${quote(s)}; else printf '%s' '{"state":"${start?'failed':'unknown'}","phase":"${start?'checking_system':'unknown'}","code":"docker_install_privilege_required"}'; fi`;
export const DOCKER_INSTALL_CODES=['','docker_install_failed','docker_install_interrupted','docker_install_privilege_required','docker_install_unsupported','docker_install_busy','docker_install_package_conflict','docker_install_package_failed','docker_install_service_failed','docker_install_agent_access_failed','docker_install_verification_failed','docker_install_result_unavailable','host_key_mismatch','ssh_failed','timed_out','cancelled'];
const phases=['checking_system','installing_packages','starting_docker','configuring_agent','verifying_docker','verified','connecting','unknown'];
export function parseDockerInstallStatus(output:string) {
 let v:any;try{if(Buffer.byteLength(output)>2048)throw Error();v=JSON.parse(output);}catch{throw Error('docker_install_result_unavailable');}
 if(!['running','succeeded','failed','unknown'].includes(v?.state)||!phases.includes(v.phase)||!DOCKER_INSTALL_CODES.includes(v.code)||v.state==='succeeded'&&(v.phase!=='verified'||v.code!==''))throw Error('docker_install_result_unavailable');
 return {state:String(v.state),phase:String(v.phase),code:String(v.code)};
}
function remote(operationID:string,start:boolean,agentID='') {
 if(!/^[a-f0-9]{32}$/.test(operationID)||agentID!==''&&!/^[A-Za-z0-9._:-]{1,128}$/.test(agentID))throw Error('invalid_docker_installation');
 const directory='/var/lib/lightmoni-docker-installations',path=directory+'/'+operationID,unit='lightmoni-docker-'+operationID;
 // Root-only directories cannot be redirected through an Agent-writable path.
 const safe=`set -eu\numask 077\n[ ! -L ${directory} ]\n${start?`if [ ! -e ${directory} ]; then mkdir -m 0700 ${directory}; fi\n`:""}[ "$(stat -c '%u:%a' ${directory})" = '0:700' ]\n[ -d ${directory} ]\n`;
 if(!start)return privileged(safe+`[ -d ${path} ] && [ ! -L ${path} ] && [ "$(stat -c '%u:%a' ${path})" = '0:700' ]\ncat ${path}/status.json`);
 return privileged(safe+`[ ! -e ${path} ] && [ ! -L ${path} ]\nmkdir -m 0700 ${path}\nprintf '%s' ${quote(Buffer.from(dockerInstallScript).toString('base64'))} | base64 -d > ${path}/install.sh\nprintf '%s' '{"state":"running","phase":"checking_system","code":""}' > ${path}/status.json\nsystemd-run --quiet --unit=${unit} --property=Type=exec --property=RuntimeMaxSec=900 /bin/sh ${path}/install.sh ${path} ${quote(agentID)}\ncat ${path}/status.json`,true);
}
export const dockerInstallCommand=(id:string)=>remote(id,true);
export const dockerInstallStatusCommand=(id:string)=>remote(id,false);
export function registerMachineDocker(deps:Dependencies,access:Access) {
 const {db,router}=deps,now=()=>deps.now().toISOString(),workers=new Map<string,Promise<void>>(),controller=new AbortController();
 db.exec(`CREATE TABLE IF NOT EXISTS machine_docker_installations(
 id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,agent_id TEXT NOT NULL,
 request_id TEXT NOT NULL,credential_id TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,code TEXT NOT NULL,
 created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(machine_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS machine_docker_install_lane ON machine_docker_installations(machine_id) WHERE state IN ('running','unknown');`);
 db.run("UPDATE machine_docker_installations SET state='unknown',phase='unknown',code='docker_install_result_unavailable' WHERE state='running'");
 const view=(r:any)=>r?{id:r.id,machine_id:r.machine_id,state:r.state,phase:r.phase,code:r.code,created_by:r.created_by,created_at:r.created_at,updated_at:r.updated_at}:undefined;
 const human=(ctx:Context)=>{
  deps.auth.requireAdmin(ctx);
  const current=deps.auth.user(ctx.req);
  if(ctx.req.headers.authorization||!ctx.req.headers.cookie?.split(';').some(part=>part.trim().startsWith('lm_session='))||current?.id!==ctx.user.id||current.role!=='admin'||!db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",ctx.user.id))fail(403,'human_admin_session_required');
 };
 const row=(mid:string,op:string)=>{const r=db.get<any>('SELECT * FROM machine_docker_installations WHERE machine_id=? AND id=?',mid,op);if(!r)fail(404,'docker_installation_not_found');return r;};
 const update=(op:string,v:{state:string;phase:string;code:string})=>db.run('UPDATE machine_docker_installations SET state=?,phase=?,code=?,updated_at=? WHERE id=?',v.state,v.phase,v.code,now(),op);
 const read=async(r:any,start=false)=>{
   const {machine,credential}=access.credential(r.machine_id,r.credential_id);
   if(machine.agent_id!==r.agent_id)fail(409,'docker_install_target_changed');
   const output=await access.runner({machine,credentialID:credential.id,...access.authentication(machine.id,credential),command:remote(r.id,start,r.agent_id),signal:controller.signal,port:machine.port,timeoutMs:60000});
   access.markCredentialUsed(credential.id);const status=parseDockerInstallStatus(output.stdout);update(r.id,status);return status;
 };
 const launch=(r:any,start=true)=>{
  access.busy.add(r.machine_id);
  const work=(async()=>{try{
    let result=await read(r,start);
    for(let i=0;i<185&&result.state==='running';i++){
      await new Promise<void>(resolve=>{const timer=setTimeout(done,5000);function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();}controller.signal.addEventListener('abort',done,{once:true});if(controller.signal.aborted)done();});
      controller.signal.throwIfAborted();result=await read(r);
    }
    if(result.state==='running')throw Error('docker_install_result_unavailable');
  }catch(error){update(r.id,{state:'unknown',phase:'unknown',code:error instanceof SSHError?error.code:'docker_install_result_unavailable'});}
  finally{access.busy.delete(r.machine_id);workers.delete(r.id);}})();workers.set(r.id,work);
 };
 const path='/api/v1/machines/:id';
 router.get(path+'/docker-environment',access.safe(ctx=>{deps.auth.requireAdmin(ctx);const machine=access.get(ctx.params.id);ctx.json({machine,installation:view(db.get<any>('SELECT * FROM machine_docker_installations WHERE machine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',machine.id))});}));
 router.post(path+'/docker-installations',access.safe(async ctx=>{
  human(ctx);const body=await ctx.body<any>();
  if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['confirmed','request_id','credential_id'].includes(k))||body.confirmed!==true||typeof body.request_id!=='string'||!/^[a-zA-Z0-9-]{16,64}$/.test(body.request_id)||body.credential_id!==undefined&&typeof body.credential_id!=='string')fail(400,'invalid_docker_installation');
  const result=db.transaction(()=>{
   // Re-read the session and actor after the asynchronous body, in the same
   // write transaction that acquires the durable host installation fence.
   human(ctx);
   const machine=access.get(ctx.params.id),old=db.get<any>('SELECT * FROM machine_docker_installations WHERE machine_id=? AND request_id=?',machine.id,body.request_id);
   if(old){if(body.credential_id&&body.credential_id!==old.credential_id)fail(409,'docker_install_request_conflict');return {record:old,created:false};}
   access.idle(machine.id);assertNoDockerInstallation(db,machine.id,machine.agent_id);
   assertNoPrivilegedExecution(db,machine.id,machine.agent_id);
   assertNoPendingAgentUpdate(db,machine.agent_id,machine.id);assertNoPendingMachineInstallation(db,machine.id,machine.agent_id);
   if(!machine.capabilities.update_agent.available&&machine.capabilities.update_agent.reason!=='agent_not_linked')fail(409,'docker_install_host_unavailable');
   if(hasActiveTaskRuns(db,machine.agent_id,machine.id))fail(409,'docker_install_host_busy');
   if(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_jobs'")&&machine.agent_id&&db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",machine.agent_id))fail(409,'docker_install_host_busy');
   const {credential}=access.credential(machine.id,body.credential_id),op=id();
   db.run('INSERT INTO machine_docker_installations VALUES(?,?,?,?,?,?,?,?,?,?,?)',op,machine.id,machine.agent_id,body.request_id,credential.id,'running','connecting','',ctx.user.id,now(),now());
   return {record:row(machine.id,op),created:true};
  });
  if(result.created)launch(result.record);ctx.json(view(result.record),result.created?202:200);
 }));
 router.post(path+'/docker-installations/:operationID/verify',access.safe(async ctx=>{
  deps.auth.requireAdmin(ctx);const r=row(ctx.params.id,ctx.params.operationID);
  if(workers.has(r.id)){ctx.json(view(r));return;}
  // Recovery is strictly read-only and may replace an expired credential.
  const body=await ctx.body<any>();if(!body||Array.isArray(body)||Object.keys(body).some(k=>k!=='credential_id')||body.credential_id!==undefined&&typeof body.credential_id!=='string')fail(400,'invalid_docker_verification');
  if(body.credential_id){access.credential(r.machine_id,body.credential_id);r.credential_id=body.credential_id;db.run('UPDATE machine_docker_installations SET credential_id=? WHERE id=?',r.credential_id,r.id);}
  if(access.busy.has(r.machine_id))fail(409,'docker_install_host_busy');access.busy.add(r.machine_id);
  try{await read(r);}catch(error){update(r.id,{state:'unknown',phase:'unknown',code:error instanceof SSHError?error.code:'docker_install_result_unavailable'});}finally{access.busy.delete(r.machine_id);}
  const latest=row(r.machine_id,r.id);if(latest.state==='running')launch(latest,false);
  ctx.json(view(latest));
 }));
 return {async close(){controller.abort();await Promise.allSettled([...workers.values()]);}};
}
