import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { registerOperations } from "../src/server/operations.js";
import { registerCenterSSHDispatch } from "../src/server/center-ssh-dispatch.js";
import { registerAssistant } from "../src/assistant/index.js";
import { websiteDefinition } from "../src/operations/websites.js";
import { ExecutionGrantRegistry } from "../src/capabilities/execution-grants.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,29)),cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps),at=deps.now().toISOString();
  db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('one','Host one','one.test',22,'direct_ssh','agent-one',?,?)",at,at);
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('agent-one','one','one','1','linux','amd64',?,'{}')",at);
  const jobs=registerAgentJobs(deps,{agentCredentials:{has:()=>true} as any}),grants=new ExecutionGrantRegistry(deps);
  const store=registerOperations(deps,{jobs,credentials:{has:()=>true} as any,definitions:[websiteDefinition],executionGrants:grants});
  const config=websiteDefinition.validate({domains:["example.test"],mode:"static",static_files:{"index.html":"private-body"}});
  db.run("INSERT INTO ops_resources(id,kind,name,agent_id,revision,config_cipher,created_at,updated_at,created_by) VALUES('site-one','website','Site','agent-one',1,?,?,?,'admin')",deps.encrypt(JSON.stringify(config)),at,at);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};let revoked=false;
  const access=new CapabilityAccess(deps,{validate(){if(revoked)throw Error("revoked")},validateGrant(){if(revoked)throw Error("revoked");return structuredClone(principal)}});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,operations:store,executionGrants:grants});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  deps.auth={user:()=>admin,requireAdmin(){}} as any;deps.router.auth=deps.auth;
  return{db,deps,runs,jobs,grants,store,access,dispatcher,principal,invoke,revoke:()=>{revoked=true},close:async()=>{await store.close?.();await jobs.close?.();db.close();}};
}
const input={resource_id:"site-one",operation:"inspect",input:{},reason:"review operation",idempotency_key:"operation-one"};

test("external operation plans preserve native review, safe metadata, idempotency and stable grant binding",async()=>{
 const f=fixture();try{
  const created=await f.invoke("lightmoni_operations_plan",input),proposal=created.data.proposal;
  assert.equal(created.kind,"proposal");assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.native_status,"awaiting_approval");assert.equal(created.data.run.state,"awaiting_approval");
  assert.ok(proposal.review_url.startsWith("https://moni.example.test/"));assert.equal(JSON.stringify(created).includes("private-body"),false);
  const replay=await f.invoke("lightmoni_operations_plan",input);assert.equal(replay.data.proposal.id,proposal.id);assert.equal(replay.data.idempotency_replayed,true);
  const indexed=await f.invoke("lightmoni_domain_proposals_get",{id:`operation:${proposal.id}`});assert.equal(indexed.data.proposal.status,"awaiting_approval");assert.equal(indexed.data.proposal.native_id,proposal.id);
  await assert.rejects(f.invoke("lightmoni_operations_plan",{...input,reason:"changed"}),/idempotency_conflict/);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,0);f.grants.assert("operation",proposal.id);f.revoke();assert.throws(()=>f.grants.assert("operation",proposal.id),/authorization_revoked/);
 }finally{await f.close();}
});

test("operation proposal requires read and propose scopes, admin and installation access",async()=>{
 const f=fixture();try{
  for(const scopes of [["operations.read"],["operations.propose"]]){const p={...structuredClone(f.principal),scopes};assert.equal(f.dispatcher.list(p).some(d=>d.name==="lightmoni_operations_plan"),false);await assert.rejects(f.invoke("lightmoni_operations_plan",input,p),/scope_required|capability_forbidden/);}
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};await assert.rejects(f.invoke("lightmoni_operations_plan",input,hostScoped),/capability_forbidden/);
  const session=f.access.sessionPrincipal(member,"assistant");await assert.rejects(f.invoke("lightmoni_operations_plan",input,session),/capability_forbidden/);
 }finally{await f.close();}
});

test("revocation blocks native approval before creating a job",async()=>{
 const f=fixture();try{
  const proposal=(await f.invoke("lightmoni_operations_plan",input)).data.proposal;f.revoke();
  assert.throws(()=>f.store.approve(proposal.id,admin.id,1),/authorization_revoked/);
  assert.equal(f.store.getRun(proposal.id).state,"awaiting_approval");assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,0);
 }finally{await f.close();}
});

test("revocation fails an approved privileged job before SSH lease acquisition",async()=>{
 const f=fixture();try{
  const proposal=(await f.invoke("lightmoni_operations_plan",input)).data.proposal,approved=f.store.approve(proposal.id,admin.id,1);
  assert.equal(approved.state,"queued");assert.equal(approved.job_id.length>0,true);
  f.db.exec("CREATE TABLE privileged_jobs(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL)");
  f.db.run("INSERT INTO privileged_jobs(id,machine_id,state,created_at) VALUES(?,'one','queued',?)",approved.job_id,f.deps.now().toISOString());
  let acquired=0;const executors={setSSHOnly(){},prepareSSH(){},supportsSSHOnce:()=>true,failQueuedSSH(id:string,code:string){f.db.run("UPDATE privileged_jobs SET state='failed' WHERE id=?",id);f.jobs.failQueuedSSH!(id,code);}} as any;
  const dispatch=registerCenterSSHDispatch(f.deps,{acquireTerminal(){acquired++;throw Error("must not acquire");}} as any,f.jobs,executors,async()=>{},1000,undefined,f.grants);
  f.revoke();dispatch.tick();for(let i=0;i<20&&f.jobs.get(approved.job_id).state==="queued";i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(acquired,0);assert.equal(f.jobs.get(approved.job_id).state,"failed");assert.equal(f.jobs.get(approved.job_id).receipt.code,"authorization_revoked");
  await dispatch.close();
 }finally{await f.close();}
});

test("internal operation proposal uses dispatcher without an external grant or duplicate assistant tool",async()=>{
 const f=fixture();try{
  const tools=f.dispatcher.assistantTools(),tool=tools.find(t=>t.name==="propose_operations_action")!;
  assert.equal(Object.hasOwn(tool.schema.properties,"idempotency_key"),false);assert.equal(Object.hasOwn(tool.schema.properties,"reason"),false);
  const result=await tool.execute({resource_id:"site-one",operation:"inspect",input:{}},new AbortController().signal,admin,{session_id:"session-one"});
  assert.deepEqual(Object.keys(result),["run"]);assert.equal(result.run.resource_id,"site-one");assert.equal(result.run.state,"awaiting_approval");assert.equal(Object.hasOwn(result.run,"preview"),false);
  assert.equal(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='operation' AND native_id=?",result.run.id),undefined);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_operations_plan'"));
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,operations:f.store,runtime:async()=>{}});await module.close?.();
 }finally{await f.close();}
});
