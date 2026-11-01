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

const loginSecret="isolated-maintenance-login-secret";
function gate(){let open!:()=>void,start!:()=>void;return{done:new Promise<void>(r=>open=r),waiting:new Promise<void>(r=>start=r),open:()=>open(),start:()=>start()};}
async function fixture(t:any){
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
  runner:async(input:any)=>{calls.push(input);if(input.command.includes("--confirm-remove-executor")){await removalHook?.(input);if(removeMode==="throw")throw Error("private remove "+input.password);return{stdout:removeMode==="success"?"executor_uninstalled=verified":"partial private output "+input.password,stderr:"private diagnostic "+input.password,stages:[]};}
   if(input.command.includes("--property=LoadState")){await absenceHook?.(input);if(absence==="throw")throw Error("private absence "+input.password);return{stdout:absence,stderr:"private absence diagnostic "+input.password,stages:[]};}
   probes++;await probeHook?.(input,probes);if(observation==="throw")throw Error("private probe "+input.password);return{stdout:typeof observation==="string"?observation:canonicalJSON(observation),stderr:"private probe diagnostic "+input.password,stages:[]};},
  safe:(handler:Handler):Handler=>async c=>{try{await handler(c)}catch(e){if(e instanceof HTTPError)c.json({error:e.message},e.status);else{logs.push(e);c.json({error:"failed"},500);}}}} as AgentUpdateAccess;
 const maintenance=registerMachineExecutorMaintenance(deps,access,executors);
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end()}});server.listen(0,"127.0.0.1");await once(server,"listening");const origin="http://127.0.0.1:"+(server.address() as any).port,path="/machines/host/executor-maintenance";
 const request=async(suffix:string,method="GET",value?:unknown,headers:Record<string,string>={})=>{const r=await fetch(origin+"/api/v1"+suffix,{method,headers:{cookie:"lm_session=fixture",...(value===undefined?{}:{"content-type":"application/json"}),...headers},body:value===undefined?undefined:JSON.stringify(value)}),raw=await r.text();return{status:r.status,raw,data:JSON.parse(raw)};};
 const plan=async()=>{const r=await request(path+"/plan","POST",{action:"uninstall",credential_id:"credential"});assert.equal(r.status,200,r.raw);return r.data;};
 const apply=(p:any,id=randomUUID())=>request(`${path}/plans/${p.id}/apply`,"POST",{confirm:true,expected_revision:p.revision,request_id:id});
 const reconcile=(p:any,v:unknown={})=>request(`${path}/plans/${p.id}/reconcile`,"POST",v);
 const wait=async(p:any,state:string)=>{let r:any;for(let n=0;n<100;n++){r=await request(`${path}/plans/${p.id}`);if(r.data.status===state)return r;await new Promise(resolve=>setTimeout(resolve,2))}assert.equal(r.data.status,state,r.raw);return r;};
 t.after(async()=>{for(const g of gates)g.open();await maintenance.close?.();await executors.close?.();await tasks.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();});
 return{db,request,plan,apply,reconcile,wait,path,calls,logs,user,credentials,executors,bootstrap,busy,get observation(){return observation},setObservation(v:any){observation=v},setRemove(v:string){removeMode=v},setAbsence(v:string){absence=v},onProbe(v:typeof probeHook){probeHook=v},onAbsence(v:typeof absenceHook){absenceHook=v},onRemoval(v:typeof removalHook){removalHook=v},advance(ms:number){clock=new Date(clock.getTime()+ms)},gate(){const g=gate();gates.push(g);return g;}};
}
const removes=(f:any)=>f.calls.filter((c:any)=>c.command.includes("--confirm-remove-executor"));
const absences=(f:any)=>f.calls.filter((c:any)=>c.command.includes("--property=LoadState")&&!c.command.includes("--confirm-remove-executor"));
async function unknown(f:any){const p=await f.plan();f.setRemove("throw");assert.equal((await f.apply(p)).status,200);await f.wait(p,"unknown");return p;}
function mutate(f:any,scenario:string){
 if(scenario==="address")f.db.run("UPDATE managed_machines SET address='replacement.example.test' WHERE id='host'");
 if(scenario==="name")f.db.run("UPDATE managed_machines SET name='Replacement name' WHERE id='host'");
 if(scenario==="agent")f.db.run("UPDATE managed_machines SET agent_id='replacement-agent' WHERE id='host'");
 if(scenario==="executor-binding")f.db.run("UPDATE privileged_executors SET agent_id='foreign-agent' WHERE id=?",f.bootstrap.executor_id);
 if(scenario==="executor-generation")f.db.run("UPDATE privileged_executors SET install_generation=2 WHERE id=?",f.bootstrap.executor_id);
 if(scenario==="credential")f.credentials.get("credential").secret_fingerprint="changed";
 if(scenario==="credential-expired")f.credentials.get("credential").expires_at="2026-01-01T00:00:00Z";
 if(scenario==="actor")f.db.run("UPDATE users SET active=0 WHERE id='admin'");
}

test("reviewed executor removal verifies exact identity and atomically revokes without nested transactions",async t=>{
 const f=await fixture(t),p=await f.plan(),id=randomUUID();assert.equal(p.plan.machine.name,"Reviewed host");assert.equal(p.plan.executor_id,f.bootstrap.executor_id);assert.equal(sha256(canonicalJSON(p.plan)),p.revision);
 const started=await f.apply(p,id);assert.equal(started.status,200,started.raw);const done=await f.wait(p,"succeeded");assert.equal(f.executors.getStatus("host").executor!.state,"revoked");assert.equal(f.executors.getStatus("host").capabilities["script.elevated.v1"].authorized,false);assert.equal(removes(f).length,1);
 assert.ok(removes(f)[0].command.includes("--expected-executor-id"));assert.ok(removes(f)[0].command.includes(f.bootstrap.executor_id));assert.ok(removes(f)[0].command.includes("--expected-install-generation"));assert.equal((await f.apply(p,id)).data.status,"succeeded");assert.equal(removes(f).length,1);
 for(const text of [JSON.stringify(p),started.raw,done.raw,JSON.stringify(f.logs)])assert.ok(!text.includes(loginSecret));
});

test("unresolved or malformed executor status cannot create a removal approval",async t=>{
 for(const variant of ["fenced","pending","identity","generation","extra","duplicate","throw"])await t.test(variant,async sub=>{
  const f=await fixture(sub),s={...f.observation};if(variant==="fenced")s.fenced={job_id:"unknown"};if(variant==="pending")s.pending_results=1;if(variant==="identity")s.executor_id="wrong-executor";if(variant==="generation")s.install_generation=2;if(variant==="extra")s.private_output=loginSecret;
  f.setObservation(variant==="duplicate"?'{"executor_id":"first","executor_id":"second"}':variant==="throw"?"throw":s);
  const r=await f.request(f.path+"/plan","POST",{action:"uninstall"});assert.equal(r.status,409,r.raw);assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_executor_maintenance")!.n,0);assert.equal(removes(f).length,0);assert.ok(!r.raw.includes(loginSecret));assert.ok(!JSON.stringify(f.logs).includes(loginSecret));
 });
});

test("prepare and apply revalidate host executor credential and actor after awaited SSH probes",async t=>{
 for(const stage of ["prepare","apply"])for(const scenario of ["address","name","agent","executor-binding","executor-generation","credential","credential-expired","actor"])await t.test(stage+" "+scenario,async sub=>{
  const f=await fixture(sub);let p:any;if(stage==="apply")p=await f.plan();f.onProbe(()=>mutate(f,scenario));const r=stage==="apply"?await f.apply(p):await f.request(f.path+"/plan","POST",{action:"uninstall"});assert.ok(r.status===409||r.status===403,r.raw);assert.equal(removes(f).length,0);assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_executor_maintenance WHERE status='running'")!.n,0);
 });
});

test("ambiguous removal remains unknown and approval retries never replay it",async t=>{
 const f=await fixture(t),p=await f.plan(),id=randomUUID();f.setRemove("throw");assert.equal((await f.apply(p,id)).status,200);const r=await f.wait(p,"unknown");assert.equal(f.executors.getStatus("host").executor!.state,"active");assert.equal((await f.apply(p,id)).data.status,"unknown");assert.equal((await f.apply(p)).status,409);assert.equal((await f.request(f.path+"/plan","POST",{action:"uninstall"})).status,409);assert.equal(removes(f).length,1);assert.ok(!r.raw.includes(loginSecret));assert.ok(!JSON.stringify(f.logs).includes(loginSecret));
});

test("changed binding actor or new work during remote removal cannot revoke a different execution context",async t=>{
 for(const scenario of ["address","executor-generation","actor","new-work"])await t.test(scenario,async sub=>{
  const f=await fixture(sub),p=await f.plan();f.onRemoval(()=>{if(scenario==="new-work")f.db.run("INSERT INTO agent_jobs VALUES('unexpected-new-work','agent-host','queued')");else mutate(f,scenario);});
  const r=await f.apply(p);assert.equal(r.status,200,r.raw);
  for(let n=0;n<100&&f.db.get<any>("SELECT status FROM machine_executor_maintenance WHERE id=?",p.id)!.status==="running";n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.db.get<any>("SELECT status FROM machine_executor_maintenance WHERE id=?",p.id)!.status,"unknown");assert.equal(f.db.get<any>("SELECT state FROM privileged_executors WHERE id=?",f.bootstrap.executor_id)!.state,"active");assert.equal(removes(f).length,1);
 });
});

test("unknown removal accepts a new credential only for read-only absence verification",async t=>{
 const f=await fixture(t),p=await unknown(f),before=JSON.stringify(p.plan);f.credentials.get("credential").revoked_at="revoked";assert.equal((await f.reconcile(p)).status,409);assert.equal(absences(f).length,0);
 f.credentials.set("new-credential",{...f.credentials.get("credential"),id:"new-credential",revoked_at:"",secret:"isolated-new-secret",secret_fingerprint:"new-fingerprint"});
 const r=await f.reconcile(p,{credential_id:"new-credential"});assert.equal(r.status,200,r.raw);assert.equal(r.data.status,"succeeded");assert.equal(JSON.stringify(r.data.plan),before);assert.equal(removes(f).length,1);assert.equal(absences(f).length,1);assert.equal(absences(f)[0].password,"isolated-new-secret");assert.ok(!absences(f)[0].stdin);assert.ok(!absences(f)[0].command.includes("--confirm-remove-executor"));assert.match(absences(f)[0].command,/flock/);assert.match(absences(f)[0].command,/not-found/);assert.ok(!r.raw.includes("isolated-new-secret"));
});

test("executor removal remains possible after its ordinary Agent control credential expires",async t=>{
 const f=await fixture(t);
 f.db.exec("CREATE TABLE agent_credentials(id TEXT PRIMARY KEY,agent_id TEXT,audience TEXT,revoked_at TEXT,expires_at TEXT)");
 f.db.run("INSERT INTO agent_credentials VALUES('expired-agent-control','agent-host','control',NULL,'2026-01-01T00:00:00Z')");
 const p=await f.plan(),r=await f.apply(p);assert.equal(r.status,200,r.raw);await f.wait(p,"succeeded");assert.equal(f.executors.getStatus("host").executor!.state,"revoked");assert.equal(removes(f).length,1);
});

test("absence failure or changed awaited evidence preserves unknown and never revokes",async t=>{
 for(const scenario of ["throw","partial","extra","address","name","agent","executor-binding","executor-generation","credential","credential-expired","actor"])await t.test(scenario,async sub=>{
  const f=await fixture(sub),p=await unknown(f);if(["throw","partial","extra"].includes(scenario))f.setAbsence(scenario==="extra"?"executor_uninstalled=verified\nprivate extra":scenario);else f.onAbsence(()=>mutate(f,scenario));
  const r=await f.reconcile(p);assert.ok(r.status===409||r.status===403,r.raw);assert.equal(f.db.get<any>("SELECT status FROM machine_executor_maintenance WHERE id=?",p.id)!.status,"unknown");assert.equal(f.db.get<any>("SELECT state FROM privileged_executors WHERE id=?",f.bootstrap.executor_id)!.state,"active");assert.equal(removes(f).length,1);assert.ok(!r.raw.includes(loginSecret));assert.ok(!JSON.stringify(f.logs).includes(loginSecret));
 });
});

test("concurrent reconciliation holds the host busy and performs one read-only probe",async t=>{
 const f=await fixture(t),p=await unknown(f),g=f.gate();f.onAbsence(async()=>{g.start();await g.done});const first=f.reconcile(p);await g.waiting;assert.equal((await f.reconcile(p)).status,409);assert.equal(absences(f).length,1);g.open();assert.equal((await first).status,200);assert.equal((await f.reconcile(p)).status,409);assert.equal(removes(f).length,1);assert.equal(absences(f).length,1);
});

test("maintenance requires strict human admin input and never accepts a bearer caller",async t=>{
 const f=await fixture(t),p=await f.plan();f.user.role="member";assert.equal((await f.request(f.path+"/plans")).status,403);f.user.role="admin";
 assert.equal((await f.request(f.path+"/plans","GET",undefined,{authorization:"Bearer ordinary-agent-or-mcp"})).status,403);
 assert.equal((await f.request(`${f.path}/plans/${p.id}/apply`,"POST",{confirm:true,expected_revision:p.revision,request_id:randomUUID()},{authorization:"Bearer ordinary-agent-or-mcp"})).status,403);
 assert.equal((await f.request(`${f.path}/plans/${p.id}/apply`,"POST",{confirm:true,expected_revision:p.revision,request_id:randomUUID(),arbitrary:true})).status,400);
 assert.equal((await f.request(`${f.path}/plans/${p.id}/reconcile`,"POST",{credential_id:"credential",arbitrary:true})).status,400);assert.equal(removes(f).length,0);
});

test("Docker installation acquired during maintenance probe blocks plan and apply",async t=>{
 for(const stage of ["plan","apply"])for(const state of ["running","unknown"])await t.test(stage+" "+state,async sub=>{
  const f=await fixture(sub);
  f.db.exec("CREATE TABLE machine_docker_installations(id TEXT,machine_id TEXT,agent_id TEXT,state TEXT)");
  const p=stage==="apply"?await f.plan():undefined;
  f.onProbe(()=>f.db.run("INSERT INTO machine_docker_installations VALUES('docker','host','agent-host',?)",state));
  const r=p?await f.apply(p):await f.request(f.path+"/plan","POST",{action:"uninstall",credential_id:"credential"});
  assert.equal(r.status,409,r.raw);assert.match(r.raw,/docker_installation_pending/);
  assert.equal(removes(f).length,0);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_executor_maintenance WHERE status='running'")!.n,0);
 });
});
