import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { taskHelperFixture } from "./helpers/task-helper.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"};
const definition = (name="Reviewed script") => ({name,type:"script",enabled:true,target_all:false,host_ids:["one"],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('reviewed')",timeout_seconds:5,max_output_bytes:4096}});
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('other','Other','admin',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,25)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps);for(const id of ["one","two"])db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)",id,"Host "+id,id+".test","agent-"+id,deps.now().toISOString(),deps.now().toISOString());taskHelperFixture(deps,runs);
  for(const id of ["one","two"])runs.nodes.task({...definition("Script "+id),host_ids:[id]},"script-"+id,true);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};let revoked=false;
  const access=new CapabilityAccess(deps,{validate(){if(revoked)throw Error("revoked")},validateGrant(){if(revoked)throw Error("revoked");return structuredClone(principal)}});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,runs,access,dispatcher,principal,invoke,revoke:()=>{revoked=true},close:()=>db.close()};
}

test("external task create/update remain proposals until native approval and preserve idempotency",async()=>{
 const f=fixture();try{
  const created=await f.invoke("lightmoni_tasks_plan",{operation:"task.create",task:definition(),reason:"create",idempotency_key:"create-one"});
  const proposal=created.data.proposal;assert.equal(proposal.status,"awaiting_approval");assert.throws(()=>f.runs.nodes.getTask(proposal.task_id));
  assert.equal((await f.invoke("lightmoni_tasks_plan",{operation:"task.create",task:definition(),reason:"create",idempotency_key:"create-one"})).data.proposal.id,proposal.id);
  await assert.rejects(f.invoke("lightmoni_tasks_plan",{operation:"task.create",task:definition(),reason:"changed",idempotency_key:"create-one"}),/idempotency_conflict/);
  assert.equal(f.dispatcher.proposals.apply(admin,proposal.id).status,"completed");assert.equal(f.runs.nodes.getTask(proposal.task_id).name,"Reviewed script");assert.equal(f.runs.list().length,0);
  const indexed=await f.invoke("lightmoni_domain_proposals_get",{id:`task:${proposal.id}`});assert.equal(indexed.data.proposal.status,"completed");assert.equal(indexed.data.proposal.native_id,proposal.id);assert.equal(indexed.data.proposal.capability,"lightmoni_tasks_plan");
  const updated=await f.invoke("lightmoni_tasks_plan",{operation:"task.update",task_id:proposal.task_id,task:{name:"Updated script"},reason:"rename",idempotency_key:"update-one"});
  assert.equal(f.runs.nodes.getTask(proposal.task_id).name,"Reviewed script");assert.equal(f.dispatcher.proposals.apply(admin,updated.data.proposal.id).status,"completed");assert.equal(f.runs.nodes.getTask(proposal.task_id).name,"Updated script");assert.equal(f.runs.list().length,0);
 }finally{f.close();}
});

test("host-scoped create/update require static before/after targets and revoke pending approval",async()=>{
 const f=fixture();try{
  const scoped={...structuredClone(f.principal),host_ids:["one"]};
  const allowed=await f.invoke("lightmoni_tasks_plan",{operation:"task.create",task:definition(),reason:"create",idempotency_key:"allowed"},scoped);assert.equal(allowed.data.proposal.status,"awaiting_approval");
  for(const [task,key] of [[{...definition(),host_ids:["two"]},"other-host"],[{...definition(),target_all:true},"all-hosts"],[{...definition(),label_ids:["dynamic"]},"labels"] ] as any[])
   await assert.rejects(f.invoke("lightmoni_tasks_plan",{operation:"task.create",task,reason:"create",idempotency_key:key},scoped));
  await assert.rejects(f.invoke("lightmoni_tasks_plan",{operation:"task.update",task_id:"script-one",task:{host_ids:["two"]},reason:"expand",idempotency_key:"expand"},scoped),/resource_not_found/);
  await assert.rejects(f.invoke("lightmoni_tasks_plan",{operation:"task.update",task_id:"script-two",task:{name:"No host change"},reason:"current host",idempotency_key:"current"},scoped),/resource_not_found/);
  f.revoke();assert.throws(()=>f.dispatcher.proposals.apply(admin,allowed.data.proposal.id),/revoked/);assert.throws(()=>f.runs.nodes.getTask(allowed.data.proposal.task_id));assert.equal(f.runs.list().length,0);
 }finally{f.close();}
});

test("internal create/update use the same dispatcher and proposal service",async()=>{
 const f=fixture();try{
  const tool=f.dispatcher.assistantTools().find(t=>t.name==="propose_task_action")!;
  const created=await tool.execute({operation:"task.create",task:definition("Internal script"),reason:"create"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(f.dispatcher.proposals.source(admin,created.proposal.id)?.source,"assistant");assert.throws(()=>f.runs.nodes.getTask(created.proposal.task_id));
  f.dispatcher.proposals.apply(admin,created.proposal.id);
  const updated=await tool.execute({operation:"task.update",task_id:created.proposal.task_id,task:{name:"Internal updated"},reason:"rename"},new AbortController().signal,admin,{session_id:"session-one"});
  f.dispatcher.proposals.apply(admin,updated.proposal.id);assert.equal(f.runs.nodes.getTask(created.proposal.task_id).name,"Internal updated");
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_tasks_plan'"));
 }finally{f.close();}
});

test("cross-domain proposal index enforces owner, scope, host and refreshed pagination",async()=>{
 const f=fixture();try{
  const first=(await f.invoke("lightmoni_tasks_plan",{operation:"task.create",task:definition(),reason:"one",idempotency_key:"index-one"})).data.proposal;
  const second=(await f.invoke("lightmoni_tasks_plan",{operation:"task.create",task:{...definition("Other host"),host_ids:["two"]},reason:"two",idempotency_key:"index-two"})).data.proposal;
  const scoped={...structuredClone(f.principal),host_ids:["one"]},page=await f.invoke("lightmoni_domain_proposals_list",{domain:"task",limit:1},scoped);
  assert.equal(page.data.items.length,1);assert.equal(page.data.items[0].native_id,first.id);
  const fullPage=await f.invoke("lightmoni_domain_proposals_list",{domain:"task",limit:1});assert.equal(fullPage.data.has_more,true);
  await assert.rejects(f.invoke("lightmoni_domain_proposals_get",{id:`task:${second.id}`},scoped),/resource_not_found/);
  const withoutIndex={...structuredClone(f.principal),scopes:f.principal.scopes.filter(s=>s!=="proposals.read")};await assert.rejects(f.invoke("lightmoni_domain_proposals_list",{},withoutIndex),/scope_required|capability_forbidden/);
  const withoutTasks={...structuredClone(f.principal),scopes:f.principal.scopes.filter(s=>s!=="tasks.read")};await assert.rejects(f.invoke("lightmoni_domain_proposals_get",{id:`task:${first.id}`},withoutTasks),/capability_forbidden/);
  const other={...structuredClone(f.principal),user:{id:"other",name:"Other",role:"admin"}};assert.equal((await f.invoke("lightmoni_domain_proposals_list",{},other)).data.total,0);
  f.dispatcher.proposals.apply(admin,first.id);const completed=await f.invoke("lightmoni_domain_proposals_list",{domain:"task",state:"completed"});assert.equal(completed.data.items.some(item=>item.native_id===first.id),true);
 }finally{f.close();}
});

test("cross-domain execution index preserves native runs and host authorization",async()=>{
 const f=fixture();try{
  const proposal=(await f.invoke("lightmoni_tasks_plan",{operation:"task.dispatch",task_id:"script-one",host_ids:["one"],reason:"dispatch",idempotency_key:"execution-index-one"})).data.proposal;
  const applied=f.dispatcher.proposals.apply(admin,proposal.id),run=(applied.result as any).runs[0];
  const scoped={...structuredClone(f.principal),host_ids:["one"]},execution=await f.invoke("lightmoni_domain_executions_get",{id:`task:${run.id}`},scoped);
  assert.equal(execution.data.execution.native_state,"queued");assert.equal(execution.data.execution.host_id,"one");
  const otherHost={...structuredClone(f.principal),host_ids:["two"]};await assert.rejects(f.invoke("lightmoni_domain_executions_get",{id:`task:${run.id}`},otherHost),/resource_not_found/);
  const withoutExecutions={...structuredClone(f.principal),scopes:f.principal.scopes.filter(s=>s!=="executions.read")};await assert.rejects(f.invoke("lightmoni_domain_executions_list",{},withoutExecutions),/scope_required|capability_forbidden/);
  const page=await f.invoke("lightmoni_domain_executions_list",{domain:"task",state:"queued",limit:1});assert.equal(page.data.items[0].native_state,"queued");
 }finally{f.close();}
});
