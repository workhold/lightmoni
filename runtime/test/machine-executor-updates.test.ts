import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {generateKeyPairSync,randomBytes,randomUUID} from "node:crypto";
import {DB} from "../src/shared/sqlite.js";
import {Router,fail,HTTPError} from "../src/shared/http.js";
import {cipher} from "../src/shared/crypto.js";
import type {Dependencies,Handler} from "../src/shared/types.js";
import type {AgentUpdateAccess} from "../src/server/machine-agent-updates.js";
import {registerTaskCenter} from "../src/server/task-center.js";
import {registerPrivilegedExecutors} from "../src/server/privileged-executors.js";
import {registerMachineExecutorMaintenance} from "../src/server/machine-executor-maintenance.js";
import {canonicalJSON,sha256,signJWS} from "../src/shared/privileged-executor.js";

import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerMachineExecutorUpdates} from '../src/server/machine-executor-updates.js';
import {signExecutorRequest} from '../src/shared/privileged-executor.js';
const loginSecret="isolated-maintenance-login-secret";
function gate(){let open!:()=>void,start!:()=>void;return{done:new Promise<void>(r=>open=r),waiting:new Promise<void>(r=>start=r),open:()=>open(),start:()=>start()};}
async function fixture(t:any){
 const temp=mkdtempSync(join(tmpdir(),'lm-executor-update-')),downloads=join(temp,'downloads');mkdirSync(downloads);
 const archive=Buffer.from('fixed-target-fixture-archive'),targetSHA=sha256(archive),release={version:'0.1.0',source_revision:'b'.repeat(40),build_id:'target-build',state_schema:1,platform:'linux',arch:'arm64',file:'lightmoni-agent_0.1.0_linux_arm64.tar.gz',sha256:targetSHA,size:archive.length,build_time:'2026-11-01T00:00:00Z'};
 for(const file of [release.file,'update.sh','update-runner.mjs'])writeFileSync(join(downloads,file),file===release.file?archive:Buffer.from('fixture'));
 writeFileSync(join(downloads,'agent-releases.json'),JSON.stringify({schema:1,releases:[release]}));
 const original={version:'0.1.0',build_id:'old-build',source_revision:'a'.repeat(40),arch:'arm64',state_schema:1,artifact_sha256:'a'.repeat(64)};
 let releases={current:original,previous:null as any},updateMode='success',downloadStatus=0;
 const db=new DB(":memory:"),logs:unknown[]=[],calls:any[]=[],busy=new Set<string>(),gates:ReturnType<typeof gate>[]=[];
 const router=new Router(e=>logs.push(e)),user={id:"admin",name:"Admin",role:"admin"};let clock=new Date("2026-11-01T00:00:00Z");
 const deps={db,router,...cipher(Buffer.alloc(32,19)),now:()=>clock,externalURL:"https://platform.example.test",
  auth:{user(req:any){return req.headers.cookie==="lm_session=fixture"&&db.get("SELECT id FROM users WHERE id=? AND active=1",user.id)?user:undefined;},requireAdmin(c:any){if(c.user.role!=="admin")fail(403,"admin_required");}},
  logger:{info(...v:any[]){logs.push(v)},warn(...v:any[]){logs.push(v)},error(...v:any[]){logs.push(v)}}} as unknown as Dependencies;
 router.auth=deps.auth;const tasks=registerTaskCenter(deps);
 db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT)");
 db.run("INSERT INTO users VALUES('admin','Admin','admin',1)");
 db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES('host','Reviewed host','host.example.test',22,'root','direct_ssh','agent-host',?,?)",clock.toISOString(),clock.toISOString());
 const executors=registerPrivilegedExecutors(deps,{dataDir:"/unused"});
 const policy=executors.preparePolicyPlan("host",{capabilities:["script.elevated.v1"]},"admin");executors.applyPolicy("host",policy.id,{confirm:true,expected_revision:policy.revision},"admin");
 const bootstrap=executors.issueBootstrap("host",["script.elevated.v1"],"admin"),keys=generateKeyPairSync("ed25519"),pub=keys.publicKey.export({type:"spki",format:"pem"}).toString(),iat=Math.floor(clock.getTime()/1000);
 executors.enroll({token:bootstrap.enrollment_token,public_key:pub,proof:signJWS({version:1,purpose:"enrollment",token_sha256:sha256(bootstrap.enrollment_token),public_key_sha256:sha256(pub),executor_nonce:randomBytes(24).toString("base64url"),iat,exp:iat+60},keys.privateKey,bootstrap.executor_id)});
 const credentials=new Map<string,any>([["credential",{id:"credential",method:"password",secret:loginSecret,secret_fingerprint:sha256(loginSecret),retention:"permanent",expires_at:null,revoked_at:"",secret_cleared_at:""}]]);
 let observation:any={executor_id:bootstrap.executor_id,machine_id:"host",install_generation:bootstrap.install_generation,policy_generation:policy.generation,fenced:null,pending_results:0};
 let removeMode="success",absence="executor_uninstalled=verified",probeHook:((input:any,count:number)=>Promise<void>|void)|undefined,absenceHook:((input:any)=>Promise<void>|void)|undefined,removalHook:((input:any)=>Promise<void>|void)|undefined,probes=0;
 const credential=(host:string,id="credential")=>{if(host!=="host")fail(404,"host_not_found");const c=credentials.get(id);if(!c||c.revoked_at||c.secret_cleared_at||c.expires_at&&Date.parse(c.expires_at)<=clock.getTime())fail(409,"credential_unavailable");return{machine:db.get<any>("SELECT * FROM managed_machines WHERE id=?",host),credential:{...c}};};
 const access={get(host:string){const m=db.get<any>("SELECT * FROM managed_machines WHERE id=?",host);if(!m)fail(404,"host_not_found");return m;},idle(host:string){if(busy.has(host))fail(409,"host_busy");},revision(m:any){return sha256(canonicalJSON([m.address,m.port,m.username,m.connection_method,m.host_key_fingerprint]));},credential,
  authentication(host:string,c:any){credential(host,c.id);return{privateKey:"",password:c.secret};},markCredentialUsed(){},busy,
  runner:async(input:any)=>{calls.push(input);
   if(input.command.includes('/executor-updates/')){
    if(updateMode==='throw')throw Error('private update '+input.password);
    const id=input.command.match(/executor-updates\/([a-f0-9-]{36})\/bundle/)![1],ticket=input.stdin.trim();
    const response=await fetch(origin+'/downloads/executor-updates/'+id+'/bundle.tar.gz',{headers:{authorization:'Bearer '+ticket}});downloadStatus=response.status;assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),archive);
    assert.equal((await fetch(origin+'/downloads/executor-updates/'+id+'/bundle.tar.gz',{headers:{authorization:'Bearer '+ticket}})).status,401);
    releases={current:{...original,build_id:release.build_id,source_revision:release.source_revision,artifact_sha256:targetSHA},previous:original};
    const raw=canonicalJSON({version:'test',boot_id:'boot_1234567890123456',policy_generation:policy.generation,capabilities:['script.elevated.v1'],account_profiles:[],interpreter_profiles:[],release:{build_id:release.build_id,source_revision:release.source_revision,artifact_sha256:targetSHA,state_schema:1,activation_id:id}}),path='/api/v1/privileged-executors/'+bootstrap.executor_id+'/heartbeat',now=Math.floor(clock.getTime()/1000),signature=signExecutorRequest({center_instance_id:executors.centerInstanceID,executor_id:bootstrap.executor_id,install_generation:1,method:'POST',path,body:raw,request_id:randomBytes(24).toString('base64url'),iat:now,exp:now+60},keys.privateKey);
    executors.signedRequest(bootstrap.executor_id,'POST',path,Buffer.from(raw),signature,(e,v)=>executors.heartbeat(e,v));
    return{stdout:'executor_upgrade=ready',stderr:'',stages:[]};
   }
if(input.command.includes("--confirm-remove-executor")){await removalHook?.(input);if(removeMode==="throw")throw Error("private remove "+input.password);return{stdout:removeMode==="success"?"executor_uninstalled=verified":"partial private output "+input.password,stderr:"private diagnostic "+input.password,stages:[]};}
   if(input.command.includes("--property=LoadState")){await absenceHook?.(input);if(absence==="throw")throw Error("private absence "+input.password);return{stdout:absence,stderr:"private absence diagnostic "+input.password,stages:[]};}
   probes++;await probeHook?.(input,probes);if(observation==="throw")throw Error("private probe "+input.password);return{stdout:typeof observation==="string"?observation:canonicalJSON(observation)+"\n"+canonicalJSON(releases),stderr:"private probe diagnostic "+input.password,stages:[]};},
  safe:(handler:Handler):Handler=>async c=>{try{await handler(c)}catch(e){if(e instanceof HTTPError)c.json({error:e.message},e.status);else{logs.push(e);c.json({error:"failed"},500);}}}} as AgentUpdateAccess;
 const maintenance=registerMachineExecutorMaintenance(deps,access,executors);
 const updates=registerMachineExecutorUpdates(deps,access,executors,{downloadsDir:downloads,dataDir:temp,verificationTimeoutMs:20});
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end()}});server.listen(0,"127.0.0.1");await once(server,"listening");const origin="http://127.0.0.1:"+(server.address() as any).port,path="/machines/host/executor-updates";
 const request=async(suffix:string,method="GET",value?:unknown,headers:Record<string,string>={})=>{const r=await fetch(origin+"/api/v1"+suffix,{method,headers:{cookie:"lm_session=fixture",...(value===undefined?{}:{"content-type":"application/json"}),...headers},body:value===undefined?undefined:JSON.stringify(value)}),raw=await r.text();return{status:r.status,raw,data:JSON.parse(raw)};};
 const plan=async()=>{const r=await request(path+"/plan","POST",{action:"upgrade",credential_id:"credential"});assert.equal(r.status,200,r.raw);return r.data;};
 const apply=(p:any,id=randomUUID())=>request(`${path}/plans/${p.id}/apply`,"POST",{confirm:true,expected_revision:p.revision,request_id:id});
 const reconcile=(p:any,v:unknown={})=>request(`${path}/plans/${p.id}/reconcile`,"POST",v);
 const wait=async(p:any,state:string)=>{let r:any;for(let n=0;n<1000;n++){r=await request(`${path}/plans/${p.id}`);if(r.data.status===state)return r;await new Promise(resolve=>setTimeout(resolve,2))}assert.equal(r.data.status,state,r.raw);return r;};
 t.after(async()=>{for(const g of gates)g.open();await updates.close?.();await maintenance.close?.();await executors.close?.();await tasks.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(temp,{recursive:true,force:true});});
 return{temp,release,targetSHA,download:()=>downloadStatus,setUpdate:(v:string)=>updateMode=v,db,request,plan,apply,reconcile,wait,path,calls,logs,user,credentials,executors,bootstrap,busy,get observation(){return observation},setObservation(v:any){observation=v},setRemove(v:string){removeMode=v},setAbsence(v:string){absence=v},onProbe(v:typeof probeHook){probeHook=v},onAbsence(v:typeof absenceHook){absenceHook=v},onRemoval(v:typeof removalHook){removalHook=v},advance(ms:number){clock=new Date(clock.getTime()+ms)},gate(){const g=gate();gates.push(g);return g;}};
}

const updates=(f:any)=>f.calls.filter((c:any)=>c.command.includes('/executor-updates/'));
test('executor program update uses an immutable review, one-use private ticket and signed build proof',async t=>{
 const f=await fixture(t),p=await f.plan(),id=randomUUID();assert.equal(p.plan.action,'upgrade');assert.equal(p.plan.release.sha256,f.targetSHA);assert.equal(sha256(canonicalJSON(p.plan)),p.revision);
 assert.equal((await f.apply(p,id)).status,200);const done=await f.wait(p,'succeeded');assert.equal(done.data.plan.executor_id,f.bootstrap.executor_id);assert.equal(f.download(),200);assert.equal(updates(f).length,1);assert.equal((await f.apply(p,id)).data.status,'succeeded');assert.equal(updates(f).length,1);
 assert.equal(f.executors.getStatus('host').executor!.id,f.bootstrap.executor_id);assert.equal(f.executors.getStatus('host').executor!.release?.artifact_sha256,f.targetSHA);
 for(const text of [JSON.stringify(p),done.raw,JSON.stringify(f.logs)]){assert.ok(!text.includes(loginSecret));assert.ok(!text.includes('lm_executor_maint_'));}
});
test('an update record cannot be submitted to the removal endpoint',async t=>{const f=await fixture(t),p=await f.plan();const r=await f.request('/machines/host/executor-maintenance/plans/'+p.id+'/apply','POST',{confirm:true,expected_revision:p.revision,request_id:randomUUID()});assert.equal(r.status,409);assert.equal(updates(f).length,0);assert.equal(f.calls.some((c:any)=>c.command.includes('--confirm-remove-executor')),false);});
test('target, credentials and expired approvals stop executor program changes',async t=>{
 for(const scenario of ['target','credential','expiry','actor'])await t.test(scenario,async sub=>{const f=await fixture(sub),p=await f.plan();if(scenario==='target')f.db.run("UPDATE managed_machines SET address='replacement.test' WHERE id='host'");if(scenario==='credential')f.credentials.get('credential').secret_fingerprint='changed';if(scenario==='expiry')f.advance(301000);if(scenario==='actor')f.db.run("UPDATE users SET active=0 WHERE id='admin'");const r=await f.apply(p);assert.ok([401,403,409].includes(r.status),r.raw);assert.equal(updates(f).length,0);});
});
test('an unknown SSH update is never redispatched and can only be closed by read-only original-program proof',async t=>{const f=await fixture(t),p=await f.plan();f.setUpdate('throw');await f.apply(p);await f.wait(p,'unknown');assert.equal(updates(f).length,1);const r=await f.reconcile(p);assert.equal(r.status,200,r.raw);assert.equal(r.data.status,'failed');assert.equal(updates(f).length,1);});
test('expired or modified pinned archives cannot mint a program update approval',async t=>{const f=await fixture(t);writeFileSync(join(f.temp,'downloads',f.release.file),'replacement');const r=await f.request(f.path+'/plan','POST',{action:'upgrade',credential_id:'credential'});assert.equal(r.status,409);assert.equal(updates(f).length,0);});
