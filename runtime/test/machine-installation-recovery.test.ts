import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {DB} from "../src/shared/sqlite.js";
import {Router,fail} from "../src/shared/http.js";
import {cipher} from "../src/shared/crypto.js";
import type {Dependencies} from "../src/shared/types.js";
import {registerAgentCredentials} from "../src/server/agent-credentials.js";
import {registerManagedMachines,type SSHRunner} from "../src/server/managed-machines.js";
import {NodeStore} from "../src/server/nodes-model.js";
import {TaskRunStore} from "../src/server/task-center.js";
import {registerAgentJobs} from "./helpers/domain-jobs.js";
import {SSHError} from "../src/server/machine-ssh.js";
import {fixturePrivateKey} from "./helpers/ssh-key.js";
import {pendingMachineInstallation} from "../src/server/machine-installations-guard.js";
import {SCRIPT_TASK_CAPABILITY} from "../src/shared/task-center.js";

const preflight="LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\nprivilege_state=root\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
const probe=(id:string,extra:Record<string,string>={})=>Object.entries({LMAGENT:"1",agent_id:id,installation:"present",program_complete:"1",unit_managed:"1",service_running:"1",lifecycle_locked:"0",operation_lock:"0",data_retained:"1",...extra}).map(([key,value])=>`${key}=${value}`).join("\n")+"\n";
async function fixture(t:any){
 const db=new DB(":memory:"),user={id:"admin",name:"Admin",role:"admin"};let clock=new Date("2026-10-31T08:00:00Z"),router=new Router();
 const deps={db,...cipher(Buffer.alloc(32,4)),now:()=>clock,externalURL:"https://platform.example.test",auth:{user:()=>user,requireAdmin(ctx:any){if(ctx.user.role!=="admin")fail(403,"administrator required");}},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
 new NodeStore(db,deps.now);
 let bootstraps=0,probes=0,enrollmentToken="",observedID="unknown-agent",observation:Record<string,string>={};
 const runner:SSHRunner=async input=>{
  if(input.enrollmentToken){bootstraps++;enrollmentToken=input.enrollmentToken;throw new SSHError("timed_out");}
  if(input.command.includes("LMAGENT")){probes++;return {stdout:probe(observedID,observation),stderr:"",stages:[]};}
  return {stdout:preflight,stderr:"",stages:[]};
 };
 let credentials:ReturnType<typeof registerAgentCredentials>,machines:ReturnType<typeof registerManagedMachines>;
 const instances:ReturnType<typeof registerManagedMachines>[]=[];
 const mount=()=>{router=new Router();router.auth=deps.auth;deps.router=router;credentials=registerAgentCredentials(deps);machines=registerManagedMachines(deps,{agentCredentials:credentials,sshRunner:runner});instances.push(machines);};mount();
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});server.listen(0,"127.0.0.1");await once(server,"listening");
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{for(const instance of instances)await instance.close?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();});
 const request=async(path:string,method="GET",body?:any,bearer?:string)=>{const result=await fetch(base+"/api/v1"+path,{method,headers:{"content-type":"application/json",...(bearer?{authorization:"Bearer "+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body)});const raw=await result.text();return {status:result.status,raw,data:JSON.parse(raw)};};
 const host=async(name="Recovery host")=>{
  const made=await request("/machines","POST",{name,address:"ssh.example.test",username:"root"});assert.equal(made.status,201,made.raw);
  db.run("UPDATE managed_machines SET host_key_fingerprint='SHA256:fixture-pin' WHERE id=?",made.data.id);
  const credential=await request(`/machines/${made.data.id}/credentials`,"POST",{method:"ssh_key",secret:fixturePrivateKey(),confirm_managed:true});assert.equal(credential.status,201,credential.raw);
  const check=await request(`/machines/${made.data.id}/ssh-check`,"POST",{});assert.equal(check.data.ready,true,check.raw);
  const plan=await request(`/machines/${made.data.id}/deployments/plan`,"POST",{check_id:check.data.id,version:"0.1.0",arch:"amd64"});assert.equal(plan.status,201,plan.raw);
  return {id:made.data.id,cid:credential.data.id,check:check.data.id,plan:plan.data.id,path:`/machines/${made.data.id}/deployments/${plan.data.id}`};
 };
 const activate=async(token=enrollmentToken)=>{
  const exchanged=await request("/agents/enroll","POST",{enrollment_token:token,install_nonce:"recovery-fixture",agent_public_key:"fixture-public",version:"0.1.0",arch:"amd64"});assert.equal(exchanged.status,201,exchanged.raw);
  const active=await request(`/agents/${exchanged.data.agent_id}/activate`,"POST",{install_nonce:"recovery-fixture",health:{service:"ready",config_checked:true}},exchanged.data.bootstrap_credential);assert.equal(active.status,200,active.raw);
  observedID=exchanged.data.agent_id;
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES(?,?,?,'0.1.0','linux','amd64',?,?)",observedID,"client-host","observed-host",clock.toISOString(),JSON.stringify({last_error:"",task_capabilities:[SCRIPT_TASK_CAPABILITY]}));
  return {id:observedID,...active.data};
 };
 const interrupt=async(h:Awaited<ReturnType<typeof host>>)=>{const result=await request(h.path+"/apply","POST",{confirm:true});assert.equal(result.status,502,result.raw);const saved=await request(h.path);assert.equal(saved.data.status,"unknown",saved.raw);return saved.data;};
 return {db,deps,user,request,host,activate,interrupt,get machines(){return machines!;},get credentials(){return credentials!;},get clock(){return clock;},get bootstraps(){return bootstraps;},get probes(){return probes;},get enrollmentToken(){return enrollmentToken;},advance(ms:number){clock=new Date(clock.getTime()+ms);},async restart(){await machines!.close?.();mount();},observe(id:string,extra:Record<string,string>={}){observedID=id;observation=extra;}};
}

test("restart preserves unknown legacy history while a proven preflight-only attempt can fail safely",async t=>{
 const f=await fixture(t),h=await f.host();
 f.db.run("UPDATE machine_deployments SET status='running',execution_stage='legacy_unknown',started_at=? WHERE id=?",f.clock.toISOString(),h.plan);
 await f.restart();let saved=await f.request(h.path);assert.equal(saved.data.status,"unknown");assert.equal(saved.data.execution_stage,"legacy_unknown");
 assert.equal((await f.request(h.path+"/reconcile","POST",{})).status,409);assert.equal(f.probes,0);assert.ok(pendingMachineInstallation(f.db,h.id));
 f.db.run("UPDATE machine_deployments SET execution_stage='preflight' WHERE id=?",h.plan);
 const known=await f.request(h.path+"/reconcile","POST",{});assert.equal(known.status,200,known.raw);assert.equal(known.data.status,"failed");assert.equal(known.data.receipt.remote_not_dispatched,true);assert.equal(f.bootstraps,0);
});

test("unstarted enrollment is atomically bound, cancelled on recovery and cannot later activate",async t=>{
 const f=await fixture(t),h=await f.host();
 f.db.run("UPDATE machine_deployments SET status='running',execution_stage='enrollment_issuing',started_at=? WHERE id=?",f.clock.toISOString(),h.plan);
 const issued=f.credentials.issueEnrollment({endpoint_origin:f.deps.externalURL,version:"0.1.0",created_by:"admin",machine_id:h.id,deployment_id:h.plan});
 assert.equal(f.db.get<any>("SELECT enrollment_id FROM machine_deployments WHERE id=?",h.plan)!.enrollment_id,issued.enrollment_id);
 await f.restart();const done=await f.request(h.path+"/reconcile","POST",{});assert.equal(done.status,200,done.raw);assert.equal(done.data.status,"failed");
 assert.equal(f.credentials.enrollmentStatus(issued.enrollment_id)?.status,"cancelled");assert.equal(f.bootstraps,0);
 assert.ok((await f.request("/agents/enroll","POST",{enrollment_token:issued.token_display_once,install_nonce:"late",agent_public_key:"fixture",version:"0.1.0",arch:"amd64"})).status>=400);
});

test("interrupted activated installation succeeds only after fixed read-only proof without replay",async t=>{
 const f=await fixture(t),h=await f.host(),saved=await f.interrupt(h);assert.equal(saved.execution_stage,"bootstrap_dispatched");assert.ok(saved.enrollment_id);assert.ok(!JSON.stringify(saved).includes(f.enrollmentToken));
 f.advance(1000);const active=await f.activate();await f.restart();
 const result=await f.request(h.path+"/reconcile","POST",{});assert.equal(result.status,200,result.raw);assert.equal(result.data.status,"succeeded");assert.equal(result.data.machine_id,h.id);assert.equal(result.data.receipt.agent_id,active.id);assert.equal(result.data.receipt.remote_healthy,true);assert.equal(f.bootstraps,1);assert.equal(f.probes,1);assert.equal(f.credentials.has(active.id,"control"),true);
 assert.equal((await f.request(h.path+"/reconcile","POST",{})).status,409);assert.equal(f.bootstraps,1);
});

test("reconciliation refuses stale, pre-start, future, unhealthy, wrong-build, wrong-binding and revoked evidence",async t=>{
 for(const scenario of ["stale","pre-start","future","version","arch","error","binding","revoked","unmanaged","partial","inactive","task-lock","wrong-agent","enrollment-host","enrollment-replacement"]){
  const f=await fixture(t),h=await f.host();await f.interrupt(h);f.advance(1000);const active=await f.activate();
  if(scenario==="stale")f.advance(180_001);
  if(scenario==="pre-start")f.db.run("UPDATE agents SET last_seen=? WHERE id=?",new Date(f.clock.getTime()-2000).toISOString(),active.id);
  if(scenario==="future")f.db.run("UPDATE agents SET last_seen=? WHERE id=?",new Date(f.clock.getTime()+30_001).toISOString(),active.id);
  if(scenario==="version")f.db.run("UPDATE agents SET version='different' WHERE id=?",active.id);
  if(scenario==="arch")f.db.run("UPDATE agents SET arch='arm64' WHERE id=?",active.id);
  if(scenario==="error")f.db.run("UPDATE agents SET heartbeat=? WHERE id=?",JSON.stringify({last_error:"control unavailable"}),active.id);
  if(scenario==="binding")f.db.run("UPDATE managed_machines SET agent_id='other-agent' WHERE id=?",h.id);
  if(scenario==="revoked")f.db.run("UPDATE agent_credentials SET revoked_at=? WHERE agent_id=? AND audience='control'",f.clock.toISOString(),active.id);
  if(scenario==="unmanaged")f.observe(active.id,{unit_managed:"0"});
  if(scenario==="partial")f.observe(active.id,{program_complete:"0"});
  if(scenario==="inactive")f.observe(active.id,{service_running:"0"});
  if(scenario==="task-lock")f.observe(active.id,{operation_lock:"1"});
  if(scenario==="wrong-agent")f.observe("another-agent");
  if(scenario==="enrollment-host")f.db.run("UPDATE agent_enrollments SET machine_id='another-host' WHERE agent_id=?",active.id);
  if(scenario==="enrollment-replacement")f.db.run("UPDATE agent_enrollments SET replaces_agent_id='another-agent' WHERE agent_id=?",active.id);
  const result=await f.request(h.path+"/reconcile","POST",{});assert.equal(result.status,409,scenario+": "+result.raw);assert.equal((await f.request(h.path)).data.status,"unknown",scenario);assert.equal(f.bootstraps,1);
 }
});

test("recovery fixes the reviewed SSH target and accepts a newly selected valid credential",async t=>{
 const f=await fixture(t),h=await f.host();await f.interrupt(h);f.advance(1000);await f.activate();
 const before=f.probes;f.db.run("UPDATE managed_machines SET address='different.example.test' WHERE id=?",h.id);
 assert.equal((await f.request(h.path+"/reconcile","POST",{})).status,409);assert.equal(f.probes,before);
 f.db.run("UPDATE managed_machines SET address='ssh.example.test' WHERE id=?",h.id);
 assert.equal((await f.request(`/machines/${h.id}/credentials/${h.cid}`,"DELETE")).status,200);
 const added=await f.request(`/machines/${h.id}/credentials`,"POST",{method:"password",secret:"new-recovery-password",confirm_managed:true});assert.equal(added.status,201,added.raw);
 const result=await f.request(h.path+"/reconcile","POST",{credential_id:added.data.id});assert.equal(result.status,200,result.raw);assert.equal(result.data.status,"succeeded");assert.ok(!result.raw.includes("new-recovery-password"));
});

test("manual resolution retains unknown history, revokes only this new identity and releases its fence",async t=>{
 const f=await fixture(t),h=await f.host();const saved=await f.interrupt(h);const active=await f.activate();
 const otherHost=await f.request("/machines","POST",{name:"Other",address:"other.example.test",username:"root"});assert.equal(otherHost.status,201);
 const otherEnrollment=f.credentials.issueEnrollment({endpoint_origin:f.deps.externalURL,version:"0.1.0",created_by:"admin",machine_id:otherHost.data.id});const other=await f.activate(otherEnrollment.token_display_once);
 const taskStore=new TaskRunStore(f.deps,f.credentials);f.db.run("INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,request_id,requested_by,created_at,expires_at) VALUES('existing','task',?,?, '{}','queued','manual','before-install','admin',?,?)",h.id,active.id,f.clock.toISOString(),new Date(f.clock.getTime()+60000).toISOString());
 assert.equal((await f.request(h.path+"/resolve","POST",{confirm:true,reason:"Already checked"})).status,409);
 f.db.run("UPDATE task_runs SET state='failed' WHERE id='existing'");
 const result=await f.request(h.path+"/resolve","POST",{confirm:true,reason:"已人工检查并结束本次未知安装"});assert.equal(result.status,200,result.raw);assert.equal(result.data.status,"unknown");assert.equal(result.data.resolved_by,"admin");assert.ok(result.data.resolved_at);assert.equal(result.data.receipt.manual_resolution.revoked_agent_id,active.id);assert.equal(result.data.receipt.manual_resolution.revoked_credentials,2);
 assert.equal(f.credentials.has(active.id,"control"),false);assert.equal(f.credentials.has(other.id,"control"),true);assert.equal(pendingMachineInstallation(f.db,h.id),undefined);assert.equal((await f.request(h.path+"/reconcile","POST",{})).status,409);assert.equal((await f.request(h.path+"/apply","POST",{confirm:true})).status,409);assert.equal(result.data.enrollment_id,saved.enrollment_id);assert.ok(taskStore);
});

test("manual resolution cancels a pending ticket and requires administrator confirmation and reason",async t=>{
 const f=await fixture(t),h=await f.host();const saved=await f.interrupt(h);
 for(const input of [{},{confirm:true},{confirm:false,reason:"checked"},{confirm:true,reason:" "},{confirm:true,reason:"bad\nreason"}])assert.equal((await f.request(h.path+"/resolve","POST",input)).status,400);
 f.user.role="member";assert.equal((await f.request(h.path+"/resolve","POST",{confirm:true,reason:"checked"})).status,403);assert.equal((await f.request(h.path+"/reconcile","POST",{})).status,403);f.user.role="admin";
 const result=await f.request(h.path+"/resolve","POST",{confirm:true,reason:"checked remotely"});assert.equal(result.status,200,result.raw);assert.equal(result.data.status,"unknown");assert.equal(f.credentials.enrollmentStatus(saved.enrollment_id)?.status,"cancelled");
 assert.ok((await f.request("/agents/enroll","POST",{enrollment_token:f.enrollmentToken,install_nonce:"late",agent_public_key:"fixture",version:"0.1.0",arch:"amd64"})).status>=400);
});

test("unknown installation fences lifecycle edits and finite task APIs, with no accidental standalone-table dependency",async t=>{
 const f=await fixture(t),h=await f.host();await f.interrupt(h);const active=await f.activate();
 for(const [path,method,input] of [[`/machines/${h.id}`,"PUT",{name:"changed"}],[`/machines/${h.id}`,"DELETE",undefined],[`/machines/${h.id}/deployments/plan`,"POST",{check_id:h.check,arch:"amd64",version:"0.1.0"}],[`/machines/${h.id}/uninstallations/plan`,"POST",{check_id:h.check}],[`/machines/${h.id}/agent-updates/plan`,"POST",{action:"upgrade",target_sha256:"a".repeat(64)}]] as const)assert.equal((await f.request(path,method,input)).status,409,path);
 const tasks=new TaskRunStore(f.deps,f.credentials),task=tasks.nodes.task({name:"Script",type:"script",enabled:true,target_all:false,host_ids:[h.id],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('ok')",timeout_seconds:5,max_output_bytes:1024}},"recovery-script",true);
 assert.throws(()=>tasks.dispatch(task.id,{confirm:true},"admin"),/安装/);assert.equal(tasks.claim(active.id,[SCRIPT_TASK_CAPABILITY]),null);
 const jobs=registerAgentJobs(f.deps,{agentCredentials:f.credentials});assert.throws(()=>jobs.enqueue({agentID:active.id,deploymentID:"service",operationID:"inspect",capabilities:["health.systemd"],actions:[{kind:"health_check",check:{kind:"systemd-active",unit:"app.service"}}]}),/安装/);assert.equal(jobs.claim(active.id,[]),null);jobs.close?.();
 assert.equal(f.machines.get(h.id).capabilities.deploy_agent.reason,"installation_unknown");
 const independent=new DB(":memory:");assert.equal(pendingMachineInstallation(independent,"host","agent"),undefined);independent.close();
});

test("internal enrollment reservation refuses a finished installation attempt without issuing a token",async t=>{
 const f=await fixture(t),h=await f.host();f.db.run("UPDATE machine_deployments SET status='unknown',execution_stage='enrollment_issuing',resolved_at=?,resolved_by='admin',resolution_reason='finished' WHERE id=?",f.clock.toISOString(),h.plan);
 assert.throws(()=>f.credentials.issueEnrollment({endpoint_origin:f.deps.externalURL,version:"0.1.0",created_by:"admin",machine_id:h.id,deployment_id:h.plan}),/恢复流程/);assert.equal(f.db.get<any>("SELECT count(*) AS n FROM agent_enrollments")!.n,0);
});

test("a mismatched persisted enrollment never cancels or revokes another host's reservation",async t=>{
 const f=await fixture(t),h=await f.host();await f.interrupt(h);
 const other=await f.request("/machines","POST",{name:"Other reservation",address:"other.example.test",username:"root"});
 const foreign=f.credentials.issueEnrollment({endpoint_origin:f.deps.externalURL,version:"0.1.0",created_by:"admin",machine_id:other.data.id});
 f.db.run("UPDATE machine_deployments SET enrollment_id=?,execution_stage='enrollment_issued' WHERE id=?",foreign.enrollment_id,h.plan);
 assert.equal((await f.request(h.path+"/reconcile","POST",{})).status,409);assert.equal(f.credentials.enrollmentStatus(foreign.enrollment_id)?.status,"issued");
 const resolved=await f.request(h.path+"/resolve","POST",{confirm:true,reason:"Confirmed local installation history is inconsistent"});assert.equal(resolved.status,200,resolved.raw);assert.equal(resolved.data.receipt.manual_resolution.enrollment_cancelled,false);assert.equal(resolved.data.receipt.manual_resolution.revoked_agent_id,"");assert.equal(f.credentials.enrollmentStatus(foreign.enrollment_id)?.status,"issued");
});
