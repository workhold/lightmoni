import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {generateKeyPairSync,randomBytes,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DB} from "../src/shared/sqlite.js";
import {Router,fail,HTTPError} from "../src/shared/http.js";
import {cipher} from "../src/shared/crypto.js";
import type {Dependencies,Handler} from "../src/shared/types.js";
import type {AgentUpdateAccess} from "../src/server/machine-agent-updates.js";
import {registerTaskCenter} from "../src/server/task-center.js";
import {registerPrivilegedExecutors} from "../src/server/privileged-executors.js";
import {registerMachineExecutorMaintenance,executorProgramApplyCommand} from "../src/server/machine-executor-maintenance.js";
import {canonicalJSON,sha256,signJWS} from "../src/shared/privileged-executor.js";

const secret="fixture-only-ssh-secret";
const oldRelease={version:"old",build_id:"old-build",source_revision:"1".repeat(40),artifact_sha256:"2".repeat(64),state_schema:1,arch:"arm64",fingerprint:"3".repeat(64)};
const previous={...oldRelease,version:"previous",build_id:"previous-build",source_revision:"4".repeat(40),artifact_sha256:"5".repeat(64),fingerprint:"6".repeat(64)};
async function fixture(t:any){
 const directory=mkdtempSync(join(tmpdir(),"executor-program-api-")),downloads=join(directory,"downloads");mkdirSync(downloads);
 const bytes=Buffer.from("immutable approved bundle"),target={version:"new",build_id:"new-build",source_revision:"7".repeat(40),artifact_sha256:sha256(bytes),state_schema:1,arch:"arm64",fingerprint:"8".repeat(64)};
 const release={version:target.version,build_id:target.build_id,source_revision:target.source_revision,state_schema:1,platform:"linux",arch:"arm64",sha256:target.artifact_sha256,size:bytes.length,file:"lightmoni-agent_new_linux_arm64.tar.gz",build_time:"2026-11-01T00:00:00Z"};
 writeFileSync(join(downloads,release.file),bytes);writeFileSync(join(downloads,"agent-releases.json"),JSON.stringify({schema:1,releases:[release]}));
 const db=new DB(":memory:"),logs:unknown[]=[],calls:any[]=[],busy=new Set<string>(),router=new Router(e=>logs.push(e)),user={id:"admin",name:"Admin",role:"admin"};let clock=new Date("2026-11-01T00:00:00Z");
 const deps={db,router,...cipher(Buffer.alloc(32,29)),now:()=>clock,externalURL:"https://platform.example.test",auth:{user(req:any){return req.headers.cookie==="lm_session=fixture"&&db.get("SELECT id FROM users WHERE id=? AND active=1",user.id)?user:undefined},requireAdmin(c:any){if(c.user.role!=="admin")fail(403,"admin_required")}},logger:{info(...v:any[]){logs.push(v)},warn(...v:any[]){logs.push(v)},error(...v:any[]){logs.push(v)}}} as unknown as Dependencies;
 router.auth=deps.auth;const tasks=registerTaskCenter(deps);
 db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,execution_principal TEXT NOT NULL DEFAULT 'ordinary_agent')");db.run("INSERT INTO users VALUES('admin','Admin','admin',1)");
 db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES('host','Exact host','host.example.test',22,'root','direct_ssh','agent-host',?,?)",clock.toISOString(),clock.toISOString());
 const executors=registerPrivilegedExecutors(deps,{dataDir:directory}),policy=executors.preparePolicyPlan("host",{capabilities:["script.elevated.v1"]},"admin");executors.applyPolicy("host",policy.id,{confirm:true,expected_revision:policy.revision},"admin");
 const bootstrap=executors.issueBootstrap("host",["script.elevated.v1"],"admin"),keys=generateKeyPairSync("ed25519"),pub=keys.publicKey.export({type:"spki",format:"pem"}).toString(),iat=Math.floor(clock.getTime()/1000);
 executors.enroll({token:bootstrap.enrollment_token,public_key:pub,proof:signJWS({version:1,purpose:"enrollment",token_sha256:sha256(bootstrap.enrollment_token),public_key_sha256:sha256(pub),executor_nonce:randomBytes(24).toString("base64url"),iat,exp:iat+60},keys.privateKey,bootstrap.executor_id)});
 let observation:any={schema:1,activation_id:randomUUID(),executor_id:bootstrap.executor_id,machine_id:"host",agent_id:"agent-host",center_instance_id:executors.centerInstanceID,public_key_sha256:sha256(pub),install_generation:bootstrap.install_generation,policy_generation:1,fenced:null,pending_results:0,service_active:true,current:{...oldRelease},previous:{...previous},repairable:false,phase:"ready"},receipt:any=null,applyMode="success";
 let probeHook:undefined|(()=>Promise<void>|void),applyHook:undefined|((input:any)=>Promise<void>|void),statusHook:undefined|(()=>Promise<void>|void),applies=0;
 const credentials=new Map<string,any>([["credential",{id:"credential",method:"password",secret,secret_fingerprint:sha256(secret),retention:"permanent",expires_at:null,revoked_at:"",secret_cleared_at:""}]]);
 const credential=(host:string,id="credential")=>{const m=db.get<any>("SELECT * FROM managed_machines WHERE id=?",host),c=credentials.get(id);if(!m||!c||c.revoked_at||c.secret_cleared_at||c.expires_at&&Date.parse(c.expires_at)<=clock.getTime())fail(409,"credential_unavailable");return{machine:m,credential:{...c}}};
 const access={get(host:string){const m=db.get<any>("SELECT * FROM managed_machines WHERE id=?",host);if(!m)fail(404,"host_not_found");return m},idle(host:string){if(busy.has(host))fail(409,"host_busy")},revision(m:any){return sha256(canonicalJSON([m.address,m.port,m.username,m.connection_method,m.host_key_fingerprint]))},credential,authentication(host:string,c:any){credential(host,c.id);return{privateKey:"",password:c.secret}},markCredentialUsed(){},busy,
 runner:async(input:any)=>{calls.push(input);let output:any;
  if(input.command.includes('maintenance.mjs" apply')){applies++;const request=JSON.parse(input.stdin.slice(input.stdin.indexOf("\n")+1));await applyHook?.(input);receipt={schema:1,operation_id:request.operation_id,action:request.action,executor_id:bootstrap.executor_id,machine_id:"host",install_generation:1,agent_id:request.agent_id,center_instance_id:request.center_instance_id,public_key_sha256:request.public_key_sha256,policy_generation:request.expected_policy_generation,activation_id:request.operation_id,source:{...observation.current},status:"started",target:request.action==="upgrade"?{...target}:request.target};observation={...observation,activation_id:request.operation_id,current:{...receipt.target},service_active:true,repairable:false,phase:"ready"};if(applyMode==="throw")throw Error("lost reply "+secret);output={receipt,observation};
  }else if(input.command.includes('maintenance.mjs" status')){await statusHook?.();output={receipt,observation};}
  else {await probeHook?.();output=observation;}
  return{stdout:typeof output==="string"?output:canonicalJSON(output),stderr:"private diagnostic "+secret,stages:[]};},
 safe:(handler:Handler):Handler=>async c=>{try{await handler(c)}catch(e){if(e instanceof HTTPError)c.json({error:e.message},e.status);else{logs.push(e);c.json({error:"failed"},500)}}}} as AgentUpdateAccess;
 const maintenance=registerMachineExecutorMaintenance(deps,access,executors,{downloadsDir:downloads,dataDir:directory});
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end()}});server.listen(0,"127.0.0.1");await once(server,"listening");const origin="http://127.0.0.1:"+(server.address() as any).port,path="/machines/host/executor-maintenance";
 const request=async(suffix:string,method="GET",value?:unknown,headers:Record<string,string>={})=>{const r=await fetch(origin+"/api/v1"+suffix,{method,headers:{cookie:"lm_session=fixture",...(value===undefined?{}:{"content-type":"application/json"}),...headers},body:value===undefined?undefined:JSON.stringify(value)}),raw=await r.text();return{status:r.status,raw,data:JSON.parse(raw)}};
 const plan=async(action="upgrade",extra:any={})=>{const r=await request(path+"/plan","POST",{action,...extra});assert.equal(r.status,200,r.raw);return r.data};
 const apply=(p:any,id=randomUUID())=>request(`${path}/plans/${p.id}/apply`,"POST",{confirm:true,expected_revision:p.revision,request_id:id});
 const wait=async(p:any,state:string)=>{let r:any;for(let n=0;n<100;n++){r=await request(`${path}/plans/${p.id}`);if(r.data.status===state)return r;await new Promise(resolve=>setTimeout(resolve,2))}assert.equal(r.data.status,state,r.raw);return r};
 const heartbeat=(r=observation.current,activation=observation.activation_id)=>{clock=new Date(clock.getTime()+1000);const value={version:r.version,activation_id:activation,release:{build_id:r.build_id,source_revision:r.source_revision,artifact_sha256:r.artifact_sha256,state_schema:1},boot_id:randomBytes(24).toString("base64url"),policy_generation:1,capabilities:["script.elevated.v1"],account_profiles:[{name:"root",uid:0,gid:0,groups:[0]}],interpreter_profiles:[{runtime:"shell",sha256:"9".repeat(64)}]},body=Buffer.from(canonicalJSON(value)),path=`/api/v1/privileged-executors/${bootstrap.executor_id}/heartbeat`,iat=Math.floor(clock.getTime()/1000),signature=signJWS({version:1,purpose:"request",executor_id:bootstrap.executor_id,center_instance_id:executors.centerInstanceID,install_generation:1,method:"POST",path,body_sha256:sha256(body),request_id:randomUUID(),iat,exp:iat+60},keys.privateKey,bootstrap.executor_id);return executors.signedRequest(bootstrap.executor_id,"POST",path,body,signature,(e,v)=>executors.heartbeat(e,v))};
 t.after(async()=>{await maintenance.close?.();await executors.close?.();await tasks.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(directory,{recursive:true,force:true})});
 return {db,request,plan,apply,wait,heartbeat,path,origin,release,target,downloads,directory,logs,calls,credentials,user,executors,bootstrap, get observation(){return observation},get receipt(){return receipt},get applies(){return applies},setObservation(v:any){observation=v},setReceipt(v:any){receipt=v},setApplyMode(v:string){applyMode=v},onProbe(v:typeof probeHook){probeHook=v},onApply(v:typeof applyHook){applyHook=v},onStatus(v:typeof statusHook){statusHook=v},advance(ms:number){clock=new Date(clock.getTime()+ms)}};
}

test("program maintenance exposes immutable catalog and exact independent identity probe",async t=>{
 const f=await fixture(t),releases=await f.request(f.path+"/releases"),probe=await f.request(f.path+"/probe");assert.equal(releases.status,200);assert.equal(releases.data.releases[0].sha256,f.target.artifact_sha256);assert.equal(probe.status,200);assert.equal(probe.data.public_key_sha256,f.observation.public_key_sha256);
 const p=await f.plan();assert.equal(p.plan.action,"upgrade");assert.deepEqual(p.plan.current,oldRelease);assert.equal(p.plan.target.artifact_sha256,f.target.artifact_sha256);assert.equal(p.plan.policy_generation,1);assert.equal(sha256(canonicalJSON(p.plan)),p.revision);assert.ok(!JSON.stringify(p).includes(secret));
});

test("upgrade requires local durable receipt and a new independently signed exact heartbeat",async t=>{
 const f=await fixture(t),p=await f.plan(),id=randomUUID();assert.equal((await f.apply(p,id)).status,200);await new Promise(r=>setTimeout(r,10));assert.equal((await f.request(`${f.path}/plans/${p.id}`)).data.status,"running");f.heartbeat(oldRelease);assert.equal((await f.request(`${f.path}/plans/${p.id}`)).data.status,"running");f.heartbeat(f.target);assert.equal((await f.wait(p,"succeeded")).data.receipt.status,"started");assert.equal((await f.apply(p,id)).data.status,"succeeded");assert.equal(f.applies,1);assert.equal((await f.apply(p)).status,409);
});

test("lost SSH reply stays unknown despite heartbeat until read-only exact receipt reconciliation",async t=>{
 const f=await fixture(t),p=await f.plan(),id=randomUUID();f.setApplyMode("throw");assert.equal((await f.apply(p,id)).status,200);await f.wait(p,"unknown");f.heartbeat(f.target);assert.equal((await f.request(`${f.path}/plans/${p.id}`)).data.status,"unknown");assert.equal((await f.apply(p,id)).data.status,"unknown");assert.equal(f.applies,1);
 const r=await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{});assert.equal(r.status,200,r.raw);assert.equal(r.data.status,"succeeded");assert.equal(f.applies,1);assert.equal(f.calls.filter(c=>c.command.includes('maintenance.mjs" status')).length,1);
 for(const value of [r.raw,JSON.stringify(f.logs),JSON.stringify(p)])assert.ok(!value.includes(secret));
});

test("rollback uses only retained exact fingerprint and preserves executor generation and policy",async t=>{
 const f=await fixture(t),p=await f.plan("rollback");assert.deepEqual(p.plan.target,previous);assert.equal((await f.apply(p)).status,200);await new Promise(r=>setTimeout(r,10));f.heartbeat(previous);await f.wait(p,"succeeded");assert.equal(f.executors.getStatus("host").executor!.id,f.bootstrap.executor_id);assert.equal(f.executors.getStatus("host").policy_generation,1);
});

test("repair requires provable partial stage and completes only its matching unknown bootstrap",async t=>{
 const f=await fixture(t);f.setObservation({...f.observation,service_active:false,repairable:true,phase:"unit"});
 f.db.exec("CREATE TABLE machine_executor_bootstraps(id TEXT PRIMARY KEY,machine_id TEXT,agent_id TEXT,executor_id TEXT,install_generation INTEGER,status TEXT,plan_json TEXT,revision TEXT,token_hash TEXT,finished_at TEXT,error TEXT)");
 const original={release:{sha256:oldRelease.artifact_sha256,build_id:oldRelease.build_id}};f.db.run("INSERT INTO machine_executor_bootstraps VALUES('interrupted','host','agent-host',?,1,'unknown',?,?,?,'','')",f.bootstrap.executor_id,canonicalJSON(original),sha256(canonicalJSON(original)),"");
 const p=await f.plan("repair");assert.equal(p.plan.source_bootstrap_id,"interrupted");assert.deepEqual(p.plan.target,oldRelease);assert.equal((await f.apply(p)).status,200);await new Promise(r=>setTimeout(r,10));f.heartbeat(oldRelease);await f.wait(p,"succeeded");assert.equal(f.db.get<any>("SELECT status FROM machine_executor_bootstraps")!.status,"succeeded");
});

test("malformed privilege identity or unresolved local execution never receives maintenance approval",async t=>{
 for(const scenario of ["fence","pending","key","center","agent","generation","policy","legacy","repair-phase","not-active"])await t.test(scenario,async sub=>{
  const f=await fixture(sub),s={...f.observation,current:{...oldRelease}};let action="upgrade";
  if(scenario==="fence")s.fenced={job_id:"unknown-job",state:"unknown"};if(scenario==="pending")s.pending_results=1;if(scenario==="key")s.public_key_sha256="0".repeat(64);if(scenario==="center")s.center_instance_id="other-center";if(scenario==="agent")s.agent_id="other-agent";if(scenario==="generation")s.install_generation=2;if(scenario==="policy")s.policy_generation=2;if(scenario==="legacy")delete s.current.state_schema;if(scenario==="repair-phase")action="repair";if(scenario==="not-active")f.db.run("UPDATE privileged_executors SET state='pending'");f.setObservation(s);
  const r=await f.request(f.path+"/plan","POST",{action});assert.equal(r.status,409,r.raw);assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_executor_maintenance")!.n,0);assert.equal(f.applies,0);
 });
});

test("program approval revalidates awaited host credentials policy actor and retained fingerprint",async t=>{
 for(const scenario of ["host","credential","policy","actor","fingerprint","unknown-task"])await t.test(scenario,async sub=>{
  const f=await fixture(sub),p=await f.plan();f.onProbe(()=>{if(scenario==="host")f.db.run("UPDATE managed_machines SET name='different'");if(scenario==="credential")f.credentials.get("credential").secret_fingerprint="changed";if(scenario==="policy")f.db.run("UPDATE privileged_machine_policies SET generation=2");if(scenario==="actor")f.db.run("UPDATE users SET active=0");if(scenario==="fingerprint")f.setObservation({...f.observation,current:{...oldRelease,fingerprint:"0".repeat(64)}});if(scenario==="unknown-task")f.db.run("INSERT INTO agent_jobs VALUES('unknown-work','agent-host','unknown')")});
  const r=await f.apply(p);assert.ok([403,409].includes(r.status),r.raw);assert.equal(f.applies,0);assert.equal(f.db.get<any>("SELECT status FROM machine_executor_maintenance WHERE id=?",p.id)!.status,"awaiting_approval");
 });
});

test("unknown interrupted maintenance is inspected without replay and may release only its own clean fence",async t=>{
 const f=await fixture(t),p=await f.plan();f.setApplyMode("throw");await f.apply(p);await f.wait(p,"unknown");f.setReceipt({...f.receipt,status:"unknown"});f.setObservation({...f.observation,service_active:false,repairable:true,phase:"start"});
 const r=await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{});assert.equal(r.status,200,r.raw);assert.equal(r.data.status,"failed");assert.equal(f.applies,1);assert.equal(f.executors.getStatus("host").executor!.state,"active");const repair=await f.plan("repair");assert.equal(repair.plan.target.artifact_sha256,f.target.artifact_sha256);assert.equal(f.applies,1);
});

test("read-only reconciliation cannot release an actual unknown execution fence or mismatched receipt",async t=>{
 for(const scenario of ["fence","receipt","wrong-target","wrong-source","wrong-key","wrong-center","wrong-agent","wrong-policy","active-failed","no-receipt-changed"])await t.test(scenario,async sub=>{
  const f=await fixture(sub),p=await f.plan();f.setApplyMode("throw");await f.apply(p);await f.wait(p,"unknown");
  if(scenario==="fence")f.setObservation({...f.observation,fenced:{job_id:"real-unknown",state:"unknown"}});if(scenario==="receipt")f.setReceipt({...f.receipt,executor_id:"other"});if(scenario==="wrong-target")f.setReceipt({...f.receipt,target:previous});if(scenario==="wrong-source")f.setReceipt({...f.receipt,source:previous});if(scenario==="wrong-key")f.setReceipt({...f.receipt,public_key_sha256:"0".repeat(64)});if(scenario==="wrong-center")f.setReceipt({...f.receipt,center_instance_id:"other"});if(scenario==="wrong-agent")f.setReceipt({...f.receipt,agent_id:"other"});if(scenario==="wrong-policy")f.setReceipt({...f.receipt,policy_generation:2});if(scenario==="active-failed")f.setReceipt({...f.receipt,status:"unknown"});if(scenario==="no-receipt-changed")f.setReceipt(null);
  const r=await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{});assert.equal(r.status,409,r.raw);assert.equal((await f.request(`${f.path}/plans/${p.id}`)).data.status,"unknown");assert.equal(f.applies,1);
 });
});

test("program archive ticket is exact-operation scoped, stdin-only and cleared after dispatch",async t=>{
 const f=await fixture(t),p=await f.plan();let successfulDownload=false;f.onApply(async input=>{
  const ticket=input.stdin.split("\n")[0];assert.match(ticket,/^lm_executor_maintenance_/);assert.ok(!input.command.includes(ticket));assert.ok(!input.command.includes(secret));
  const route=`${f.origin}/downloads/executor-maintenance/${p.id}/bundle.tar.gz`;assert.equal((await fetch(route)).status,403);assert.equal((await fetch(route,{headers:{authorization:"Bearer wrong"}})).status,403);const downloaded=await fetch(route,{headers:{authorization:"Bearer "+ticket}});assert.equal(downloaded.status,200);assert.equal(sha256(Buffer.from(await downloaded.arrayBuffer())),f.target.artifact_sha256);successfulDownload=true;
 });await f.apply(p);await new Promise(r=>setTimeout(r,30));assert.ok(successfulDownload);const ticket=f.calls.find(c=>c.command.includes('maintenance.mjs" apply')).stdin.split("\n")[0];assert.equal((await fetch(`${f.origin}/downloads/executor-maintenance/${p.id}/bundle.tar.gz`,{headers:{authorization:"Bearer "+ticket}})).status,403);
 assert.throws(()=>executorProgramApplyCommand("http://invalid.test",randomUUID(),true));assert.throws(()=>executorProgramApplyCommand("https://valid.test",";id",true));
});

test("maintenance probe and new actions require human admin sessions and strict input",async t=>{
 const f=await fixture(t);assert.equal((await f.request(f.path+"/probe","GET",undefined,{authorization:"Bearer token"})).status,403);assert.equal((await f.request(f.path+"/plan","POST",{action:"repair",target_sha256:f.target.artifact_sha256})).status,400);f.user.role="member";assert.equal((await f.request(f.path+"/releases")).status,403);
});

test("same-release repair rejects a fresh signed heartbeat captured by the previous process",async t=>{
 const f=await fixture(t),oldActivation=f.observation.activation_id;f.setObservation({...f.observation,service_active:false,repairable:true,phase:"start"});const p=await f.plan("repair");await f.apply(p);await new Promise(r=>setTimeout(r,10));f.heartbeat(oldRelease,oldActivation);
 assert.equal((await f.request(`${f.path}/plans/${p.id}`)).data.status,"running","fresh timestamp and exact build cannot attest the new activation");f.heartbeat(oldRelease,p.id);await f.wait(p,"succeeded");
});

test("read-only absence of an operation intent releases only an unchanged not-started maintenance",async t=>{
 const f=await fixture(t),p=await f.plan();f.setApplyMode("throw");await f.apply(p);await f.wait(p,"unknown");f.setReceipt(null);f.setObservation({...p.plan.observation});const r=await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{});assert.equal(r.status,200,r.raw);assert.equal(r.data.status,"failed");assert.equal(f.applies,1);assert.equal(f.executors.getStatus("host").executor!.state,"active");
});

test("explicit reconciliation proves ready activation without falsifying a lost terminal receipt",async t=>{
 const f=await fixture(t),p=await f.plan();f.setApplyMode("throw");await f.apply(p);await f.wait(p,"unknown");f.setReceipt({...f.receipt,status:"switching"});f.heartbeat(f.target,p.id);
 assert.equal((await f.request(`${f.path}/plans/${p.id}`)).data.status,"unknown");const r=await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{});assert.equal(r.status,200,r.raw);assert.equal(r.data.status,"succeeded");assert.equal(r.data.receipt.status,"switching");assert.equal(r.data.receipt.reconciliation.kind,"read_only_activation");assert.equal(r.data.receipt.reconciliation.activation_id,p.id);assert.equal(f.applies,1);
});

test("explicit reconciliation ends a refused stop without starting or replaying and permits reviewed repair",async t=>{
 const f=await fixture(t),p=await f.plan();f.setApplyMode("throw");await f.apply(p);await f.wait(p,"unknown");f.setReceipt({...f.receipt,status:"unknown"});f.setObservation({...p.plan.observation,phase:"start",repairable:true});
 const r=await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{});assert.equal(r.status,200,r.raw);assert.equal(r.data.status,"failed");assert.equal(f.applies,1);const repair=await f.plan("repair");assert.equal(repair.plan.target.fingerprint,p.plan.current.fingerprint);assert.equal(f.applies,1);
});
