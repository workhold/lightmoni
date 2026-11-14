import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { registerManagedMachines } from "../src/server/managed-machines.js";
import { registerAssistant } from "../src/assistant/index.js";
import { ExecutionGrantRegistry } from "../src/capabilities/execution-grants.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { fixturePrivateKey } from "./helpers/ssh-key.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
const checkOutput="LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\nprivilege_state=root\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
async function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '',heartbeat TEXT NOT NULL DEFAULT '{}')");
  const router=new Router(),deps={db,router,now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,31)),cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  deps.auth={user:()=>admin,requireAdmin(ctx:any){if(ctx.user.role!=="admin")fail(403,"administrator required");}} as any;router.auth=deps.auth;
  let sshCalls=0,enrollments=0;
  const agentCredentials={has:()=>true,issueEnrollment(){enrollments++;throw Error("must not issue in authorization test");},cancelEnrollment(){}} as any;
  const grants=new ExecutionGrantRegistry(deps),machines=registerManagedMachines(deps,{agentCredentials,executionGrants:grants,installationReadinessTimeoutMs:0,sshRunner:async()=>{sshCalls++;return{stdout:checkOutput,stderr:"",stages:[]};}});
  const runs=new TaskRunStore(deps),principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};let revoked=false,grantPrincipal=structuredClone(principal);
  const access=new CapabilityAccess(deps,{validate(){if(revoked)throw Error("revoked")},validateGrant(){if(revoked)throw Error("revoked");return structuredClone(grantPrincipal)}});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,machines,executionGrants:grants});
  const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.statusCode=404;res.end();}}));server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=async(path:string,method="GET",body?:any)=>{const response=await fetch(base+"/api/v1"+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();return{status:response.status,raw,data:raw?JSON.parse(raw):undefined};};
  const machine=await request("/machines","POST",{name:"Host one",address:"one.test",port:22,connection_method:"direct_ssh"});assert.equal(machine.status,201,machine.raw);
  const machineID=machine.data.id;db.run("UPDATE managed_machines SET host_key_fingerprint='SHA256:fixture-pin' WHERE id=?",machineID);
  const account=await request(`/machines/${machineID}/accounts`,"POST",{username:"root",make_default:true});assert.equal(account.status,201,account.raw);
  const credential=await request(`/machines/${machineID}/accounts/${account.data.id}/credentials`,"POST",{method:"ssh_key",secret:fixturePrivateKey(),confirm_managed:true});assert.equal(credential.status,201,credential.raw);
  const checked=await request(`/machines/${machineID}/ssh-check`,"POST",{});assert.equal(checked.status,200,checked.raw);assert.equal(checked.data.ready,true,checked.raw);
  const input={machine_id:machineID,check_id:checked.data.id,version:"0.1.0",arch:"amd64",reason:"review Agent installation",idempotency_key:"agent-install-one"};
  const invoke=(name:string,value:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,value,{signal:new AbortController().signal});
  return{db,deps,machines,grants,access,dispatcher,principal,input,invoke,request,revoke:()=>{revoked=true},shrinkGrant:()=>{grantPrincipal={...grantPrincipal,host_ids:["another-host"]};},counts:()=>({sshCalls,enrollments}),close:async()=>{await machines.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}};
}

test("external Agent installation plans preserve native review, idempotency and stable grant binding",async()=>{
 const f=await fixture();try{
  const before=f.counts(),created=await f.invoke("lightmoni_agent_installations_plan",f.input),proposal=created.data.proposal;
  assert.equal(created.kind,"proposal");assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.native_status,"awaiting_approval");assert.equal(created.data.plan.status,"awaiting_approval");
  assert.ok(proposal.review_url.startsWith("https://moni.example.test/machines?"));assert.equal(created.data.plan.review_url.startsWith("/machines?"),true);
  assert.deepEqual(f.counts(),before);assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?",proposal.id).status,"awaiting_approval");
  const replay=await f.invoke("lightmoni_agent_installations_plan",f.input);assert.equal(replay.data.proposal.id,proposal.id);assert.equal(replay.data.idempotency_replayed,true);
  const indexed=await f.invoke("lightmoni_domain_proposals_get",{id:`agent_installation:${proposal.id}`});assert.equal(indexed.data.proposal.status,"awaiting_approval");assert.equal(indexed.data.proposal.native_id,proposal.id);
  const defaults=await f.invoke("lightmoni_agent_installations_plan",{...f.input,runtime_mode:"root",initial_label_id:""});assert.equal(defaults.data.proposal.id,proposal.id);assert.equal(defaults.data.idempotency_replayed,true);
  await assert.rejects(f.invoke("lightmoni_agent_installations_plan",{...f.input,reason:"changed"}),/idempotency_conflict/);
  f.grants.assert("agent_installation",proposal.id);f.revoke();assert.throws(()=>f.grants.assert("agent_installation",proposal.id),/authorization_revoked/);
 }finally{await f.close();}
});

test("Agent installation proposal requires both scopes, admin and the target host grant",async()=>{
 const f=await fixture();try{
  for(const scopes of [["agents.read"],["agents.maintain.propose"]]){const p={...structuredClone(f.principal),scopes};assert.equal(f.dispatcher.list(p).some(d=>d.name==="lightmoni_agent_installations_plan"),false);await assert.rejects(f.invoke("lightmoni_agent_installations_plan",f.input,p),/scope_required|capability_forbidden/);}
  const wrongHost={...structuredClone(f.principal),host_ids:["another-host"]};await assert.rejects(f.invoke("lightmoni_agent_installations_plan",f.input,wrongHost),/resource_not_found/);
  const memberSession=f.access.sessionPrincipal(member,"assistant");await assert.rejects(f.invoke("lightmoni_agent_installations_plan",f.input,memberSession),/capability_forbidden/);
  const allowed={...structuredClone(f.principal),host_ids:[f.input.machine_id]};const created=await f.invoke("lightmoni_agent_installations_plan",f.input,allowed);assert.equal(created.data.proposal.status,"awaiting_approval");
 }finally{await f.close();}
});

test("revocation blocks native Apply before enrollment or SSH installation",async()=>{
 const f=await fixture();try{
  const proposal=(await f.invoke("lightmoni_agent_installations_plan",f.input)).data.proposal,before=f.counts();f.revoke();
  const response=await f.request(`/machines/${f.input.machine_id}/deployments/${proposal.id}/apply`,"POST",{confirm:true});
  assert.equal(response.status,403,response.raw);assert.equal(response.data.error,"authorization_revoked");assert.deepEqual(f.counts(),before);
  assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?",proposal.id).status,"awaiting_approval");
 }finally{await f.close();}
});

test("host grant shrink blocks native Apply before enrollment or SSH installation",async()=>{
 const f=await fixture();try{
  const proposal=(await f.invoke("lightmoni_agent_installations_plan",f.input)).data.proposal,before=f.counts();f.shrinkGrant();
  const response=await f.request(`/machines/${f.input.machine_id}/deployments/${proposal.id}/apply`,"POST",{confirm:true});
  assert.equal(response.status,403,response.raw);assert.equal(response.data.error,"authorization_revoked");assert.deepEqual(f.counts(),before);
  assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?",proposal.id).status,"awaiting_approval");
 }finally{await f.close();}
});

test("internal Agent installation proposal uses dispatcher without an external grant or duplicate tool",async()=>{
 const f=await fixture();try{
  const tools=f.dispatcher.assistantTools(),tool=tools.find(t=>t.name==="propose_agent_install")!;
  assert.equal(Object.hasOwn(tool.schema.properties,"idempotency_key"),false);assert.equal(Object.hasOwn(tool.schema.properties,"reason"),false);
  const plan=await tool.execute({machine_id:f.input.machine_id,check_id:f.input.check_id,version:"0.1.0",arch:"amd64"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(plan.machine_id,f.input.machine_id);assert.equal(plan.status,"awaiting_approval");assert.ok(plan.review_url.startsWith("/machines?"));
  assert.equal(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='agent_installation' AND native_id=?",plan.id),undefined);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_agent_installations_plan'"));
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,machines:f.machines,runtime:async()=>{}});await module.close?.();
 }finally{await f.close();}
});
