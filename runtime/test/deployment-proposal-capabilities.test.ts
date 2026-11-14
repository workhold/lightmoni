import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import { registerCenterSSHDispatch } from "../src/server/center-ssh-dispatch.js";
import { ExecutionGrantRegistry } from "../src/capabilities/execution-grants.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
const serviceID="a".repeat(32);
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,27)),cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps);db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('one','Host one','one.test',22,'direct_ssh','agent-one',?,?)",deps.now().toISOString(),deps.now().toISOString());
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('agent-one','one','one','1','linux','amd64',?,'{}')",deps.now().toISOString());
  const jobs=registerAgentJobs(deps,{agentCredentials:{has:()=>true} as any}),grants=new ExecutionGrantRegistry(deps),store=registerServiceDeployments(deps,{jobs,executionGrants:grants});
  const at=deps.now().toISOString();db.run("INSERT INTO services(id,name,description,repository_url,created_at,updated_at,created_by) VALUES(?,'Checkout','','',?,?,'admin')",serviceID,at,at);
  db.run("INSERT INTO service_targets(id,service_id,machine_id,adapter,config_json,desired_release_id,status,created_at,updated_at) VALUES('target-one',?,'one','systemd','{}','release-one','ready',?,?)",serviceID,at,at);
  db.run("INSERT INTO releases(id,service_id,version,source_type,source_ref,artifact_digest,artifact_size,manifest_json,status,created_at,created_by) VALUES('release-one',?,'2026.11.14','artifact','sha256:abc','sha256:abc',128,'{}','ready',?,'admin')",serviceID,at);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};let revoked=false;
  const access=new CapabilityAccess(deps,{validate(){if(revoked)throw Error("revoked")},validateGrant(){if(revoked)throw Error("revoked");return structuredClone(principal)}});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,deployments:store,executionGrants:grants});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  deps.auth={user:()=>admin,requireAdmin(){}} as any;deps.router.auth=deps.auth;
  return{db,deps,runs,jobs,grants,store,access,dispatcher,principal,invoke,revoke:()=>{revoked=true},close:async()=>{await jobs.close?.();db.close();}};
}
const input={service_id:serviceID,target_id:"target-one",release_id:"release-one",reason:"review deployment",idempotency_key:"deploy-one"};

test("external deployment plans preserve native review, idempotency and stable grant binding",async()=>{
 const f=fixture();try{
  const created=await f.invoke("lightmoni_deployments_plan",input),proposal=created.data.proposal;assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.native_status,"awaiting_approval");assert.ok(proposal.review_url.startsWith("https://moni.example.test/"));
  assert.equal((await f.invoke("lightmoni_deployments_plan",input)).data.proposal.id,proposal.id);assert.equal((await f.invoke("lightmoni_deployments_plan",input)).data.plan.id,proposal.id);
  await assert.rejects(f.invoke("lightmoni_deployments_plan",{...input,reason:"changed"}),/idempotency_conflict/);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,0);f.grants.assert("deployment",proposal.id);f.revoke();assert.throws(()=>f.grants.assert("deployment",proposal.id),/authorization_revoked/);
 }finally{await f.close();}
});

test("deployment proposal requires read and propose scopes, admin and installation access",async()=>{
 const f=fixture();try{
  for(const scopes of [["deployments.read"],["deployments.propose"]]){const p={...structuredClone(f.principal),scopes};assert.equal(f.dispatcher.list(p).some(d=>d.name==="lightmoni_deployments_plan"),false);await assert.rejects(f.invoke("lightmoni_deployments_plan",input,p),/scope_required|capability_forbidden/);}
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};await assert.rejects(f.invoke("lightmoni_deployments_plan",input,hostScoped),/capability_forbidden/);
  const session=f.access.sessionPrincipal(member,"assistant");await assert.rejects(f.invoke("lightmoni_deployments_plan",input,session),/capability_forbidden/);
 }finally{await f.close();}
});

test("revocation blocks approval and an approved but not started SSH job",async()=>{
 const f=fixture();try{
  const proposal=(await f.invoke("lightmoni_deployments_plan",input)).data.proposal;
  const server=createServer((req,res)=>void f.deps.router.handle(req,res).then(found=>{if(!found){res.statusCode=404;res.end();}}));server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  f.revoke();const response=await fetch(base+`/api/v1/deployments/${proposal.id}/approve`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({confirm:true})});
  const responseText=await response.text();assert.equal(response.status,403,responseText);assert.equal(JSON.parse(responseText).error,"authorization_revoked");assert.equal(f.store.assistantDeployment(proposal.id).status,"awaiting_approval");assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,0);
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));

  const queued=f.jobs.enqueue({agentID:"agent-one",deploymentID:proposal.id,operationID:"operation-one",actions:[{kind:"health_check",check:{kind:"tcp",host:"127.0.0.1",port:80,timeoutMs:1000}}],capabilities:["health.tcp"]});assert.equal(queued.state,"queued");assert.equal(queued.execution_principal,"ordinary_agent");
  f.db.exec("CREATE TABLE privileged_jobs(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL)");
  let acquired=0;const dispatch=registerCenterSSHDispatch(f.deps,{acquireTerminal(){acquired++;throw Error("must not acquire");}} as any,f.jobs,{setSSHOnly(){},supportsSSHOnce:()=>true} as any,async()=>{},1000,undefined,f.grants);dispatch.tick();
  for(let i=0;i<20&&f.jobs.get(queued.id).state==="queued";i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(acquired,0);assert.equal(f.jobs.get(queued.id).state,"failed");assert.equal(f.jobs.get(queued.id).receipt.code,"authorization_revoked");
  await dispatch.close();
 }finally{await f.close();}
});

test("internal deployment proposal uses dispatcher without an external grant binding",async()=>{
 const f=fixture();try{
  const tool=f.dispatcher.assistantTools().find(t=>t.name==="propose_service_deployment")!;
  const plan=await tool.execute({service_id:serviceID,target_id:"target-one",release_id:"release-one"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(plan.service_id,serviceID);assert.equal(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='deployment' AND native_id=?",plan.id),undefined);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_deployments_plan'"));
 }finally{await f.close();}
});
