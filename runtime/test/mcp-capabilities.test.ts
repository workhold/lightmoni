import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type AccessAuthority, type Principal } from "../src/capabilities/types.js";
import type { Dependencies } from "../src/shared/types.js";
import { SCRIPT_TASK_CAPABILITY } from "../src/shared/task-center.js";
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-10-30')");
  const now=new Date("2026-10-30T00:00:00Z");let revoked=false;
  const deps={db,router:new Router(),now:()=>now,externalURL:"https://moni.example.test",encrypt:(v:string)=>Buffer.from(v).toString("base64"),decrypt:(v:string)=>Buffer.from(v,"base64").toString(),cat:{list:async()=>[]},logger:{info(){},error(){},warn(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps);
  for(const id of ["one","two"])db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)",id,"Host "+id,id+".test","agent-"+id,now.toISOString(),now.toISOString());
  for(const host of ["one","two"])runs.nodes.task({name:"Only "+host,type:"script",enabled:true,target_all:false,host_ids:[host],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('private-source-"+host+"')",timeout_seconds:5,max_output_bytes:4096}},"script-"+host,true);
  const base:Principal={user:{id:"admin",name:"Admin",role:"admin"},scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"pat-one",grant_id:"grant-one",source:"mcp"},grants=new Map([["grant-one",structuredClone(base)]]);
  const refresh=(p:Principal)=>{const u=db.get<any>("SELECT id,name,role,active FROM users WHERE id=?",p.user.id);if(!u?.active)fail(403,"inactive");p.user={id:u.id,name:u.name,role:u.role};};
  const authority:AccessAuthority={authenticate:()=>structuredClone(base),validate:p=>{if(p.source==="mcp"&&revoked)fail(403,"revoked");refresh(p);},sessionPrincipal:(u,source)=>({...structuredClone(base),user:u,source,credential_id:"",grant_id:""}),validateGrant:(id,userID)=>{if(revoked)fail(403,"revoked");const p=structuredClone(grants.get(id)!);if(!p||userID&&p.user.id!==userID)fail(403,"invalid_grant");refresh(p);return p;}};
  const dispatcher=new CapabilityDispatcher(deps,authority,{taskCenter:runs});
  return {db,runs,base,grants,dispatcher,invoke:(name:string,input:unknown,p=structuredClone(base))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal}),revoke:()=>revoked=true,close:()=>db.close()};
}
const intent={operation:"task.dispatch",task_id:"script-one",host_ids:["one"],reason:"Inspect service",idempotency_key:"operation-one"};
test("scopes, strict schemas and host-scoped metadata prevent direct invocation leaks",async()=>{
  const f=fixture();try{
    const p={...structuredClone(f.base),host_ids:["one"],scopes:["hosts.read","tasks.read","executions.read"]};
    assert.equal(f.dispatcher.list(p).some(t=>t.name==="lightmoni_telemetry_catalog"),false);
    assert.deepEqual((await f.invoke("lightmoni_hosts_list",{},p)).data.hosts.map((h:any)=>h.id),["one"]);
    await assert.rejects(f.invoke("lightmoni_hosts_get",{id:"two"},p),/resource_not_found/);
    await assert.rejects(f.invoke("lightmoni_hosts_get",{id:"missing"},p),/resource_not_found/);
    await assert.rejects(f.invoke("lightmoni_hosts_list",{actor_id:"admin"},p),/invalid_input/);
    await assert.rejects(f.invoke("lightmoni_tasks_list",{},p),/host_id_required/);
    const tasks=await f.invoke("lightmoni_tasks_list",{host_id:"one"},p);
    assert.ok(tasks.data.tasks.some((t:any)=>t.id==="script-one"));assert.equal(JSON.stringify(tasks).includes("Only two"),false);assert.equal(JSON.stringify(tasks).includes("private-source"),false);
    assert.equal(Object.hasOwn(tasks.data.tasks[0],"host_ids"),false);
    await assert.rejects(f.invoke("lightmoni_tasks_get",{id:"script-two",host_id:"one"},p),/resource_not_found/);
    await assert.rejects(f.invoke("lightmoni_tasks_get",{id:"script-one",host_id:"one",include_source:true},p),/scope_required/);
    assert.match((await f.invoke("lightmoni_tasks_get",{id:"script-one",include_source:true})).data.task.script.code,/private-source/);
    assert.ok(f.db.get<any>("SELECT count(*) n FROM capability_invocations WHERE decision='denied'")!.n>=6);
    assert.equal(JSON.stringify(f.db.all("SELECT * FROM capability_invocations")).includes("private-source"),false);
  }finally{f.close();}
});
test("external proposals are durable, idempotent and have no fabricated assistant session",async()=>{
  const f=fixture();try{
    const p=(await f.invoke("lightmoni_tasks_plan",intent)).data.proposal;
    assert.equal(p.status,"awaiting_approval");assert.equal(f.runs.list().length,0);assert.match(p.review_url,/^https:\/\/moni.example.test\//);
    assert.equal(f.db.get<any>("SELECT session_id FROM assistant_task_proposals WHERE id=?",p.id)!.session_id,"");
    assert.equal((await f.invoke("lightmoni_tasks_plan",intent)).data.proposal.id,p.id);
    await assert.rejects(f.invoke("lightmoni_tasks_plan",{...intent,reason:"Different intention"}),/idempotency_conflict/);
    await assert.rejects(f.invoke("lightmoni_tasks_plan",{...intent,operation:"task.create"}),/invalid_input/);
    const run=(f.dispatcher.proposals.apply(f.base.user,p.id).result as any).runs[0];
    assert.equal(run.state,"queued");assert.equal(f.runs.list().length,1);assert.ok(f.db.get("SELECT * FROM capability_run_authorizations WHERE run_id=?",run.id));
    const execution=(await f.invoke("lightmoni_executions_get",{id:"task:"+run.id})).data.execution;
    assert.equal(execution.native_state,"queued");assert.equal(Object.hasOwn(execution,"snapshot"),false);assert.equal(Object.hasOwn(execution,"stdout"),false);
    assert.equal((await f.invoke("lightmoni_tasks_plan",intent)).data.proposal.status,"completed");
    assert.equal(f.db.get<any>("SELECT count(*) n FROM capability_invocations WHERE decision='idempotency_hit'")!.n,2);
  }finally{f.close();}
});
test("revocation blocks pending approval and cancels an already queued external run before claim",async()=>{
  const f=fixture();try{
    const pending=(await f.invoke("lightmoni_tasks_plan",intent)).data.proposal;
    const queued=(await f.invoke("lightmoni_tasks_plan",{...intent,idempotency_key:"queued"})).data.proposal;
    const run=(f.dispatcher.proposals.apply(f.base.user,queued.id).result as any).runs[0];
    f.revoke();assert.throws(()=>f.dispatcher.proposals.apply(f.base.user,pending.id),/revoked/);
    assert.equal(f.runs.claim("agent-one",[SCRIPT_TASK_CAPABILITY]),null);
    assert.equal(f.runs.get(run.id).state,"cancelled");assert.equal(f.runs.get(run.id).code,"authorization_revoked");assert.equal(f.runs.get(run.id).started_at,"");
  }finally{f.close();}
});
test("scoped proposals require explicit targets and recheck resource grants on approval",async()=>{
  const f=fixture();try{
    const p={...structuredClone(f.base),host_ids:["one"]};f.grants.set(p.grant_id,structuredClone(p));
    const {host_ids,...request}=intent;
    await assert.rejects(f.invoke("lightmoni_tasks_plan",request,p),/explicit_hosts_required/);
    await assert.rejects(f.invoke("lightmoni_tasks_plan",{...request,host_ids:["two"]},p),/resource_not_found/);
    const proposal=(await f.invoke("lightmoni_tasks_plan",intent,p)).data.proposal;
    f.grants.set(p.grant_id,{...structuredClone(p),host_ids:[]});
    await assert.rejects(f.invoke("lightmoni_proposals_get",{id:proposal.id},{...structuredClone(p),host_ids:[]}),/resource_not_found/);
    assert.throws(()=>f.dispatcher.proposals.apply(f.base.user,proposal.id),/resource_not_found/);assert.equal(f.runs.list().length,0);
  }finally{f.close();}
});
test("fresh user role blocks stale principals, and internal task adapters share the dispatcher",async()=>{
  const f=fixture();try{
    const tools=f.dispatcher.assistantTools(),signal=new AbortController().signal;
    const get=tools.find(t=>t.name==="get_task")!;
    assert.match((await get.execute({id:"script-one"},signal,f.base.user,{session_id:"session-one"})).task.script.code,/private-source/);
    const propose=tools.find(t=>t.name==="propose_task_action")!;
    const {idempotency_key,...request}=intent;
    const p=await propose.execute(request,signal,f.base.user,{session_id:"session-one"});
    assert.equal(f.dispatcher.proposals.source(f.base.user,p.proposal.id)?.source,"assistant");assert.equal(f.runs.list().length,0);
    assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_tasks_plan'"));
    const external=(await f.invoke("lightmoni_tasks_plan",intent)).data.proposal;
    f.db.run("UPDATE users SET role='member' WHERE id='admin'");
    assert.deepEqual(f.dispatcher.list(structuredClone(f.base)),[]);
    await assert.rejects(f.invoke("lightmoni_hosts_list",{}),/capability_forbidden/);
    assert.throws(()=>f.dispatcher.proposals.apply(f.base.user,external.id),/capability_forbidden/);
  }finally{f.close();}
});

test("task proposal scope does not grant execution receipt access through completed proposals or plan replay",async()=>{
  const f=fixture();try{
    const p={...structuredClone(f.base),scopes:["tasks.read","tasks.propose"]};
    const proposal=(await f.invoke("lightmoni_tasks_plan",intent,p)).data.proposal;
    const run=(f.dispatcher.proposals.apply(f.base.user,proposal.id).result as any).runs[0];
    const reference={id:run.id,execution_id:"task:"+run.id};
    const read=(await f.invoke("lightmoni_proposals_get",{id:proposal.id},p)).data.proposal;
    assert.equal(read.status,"completed");assert.deepEqual(read.result.runs,[reference]);
    for(const key of ["state","native_state","code","requested_by","created_at","started_at","finished_at"])assert.equal(Object.hasOwn(read.result.runs[0],key),false);
    const replay=(await f.invoke("lightmoni_tasks_plan",intent,p)).data.proposal;
    assert.deepEqual(replay.result.runs,[reference]);
    await assert.rejects(f.invoke("lightmoni_executions_get",{id:run.id},p),/capability_forbidden/);
    const full=(await f.invoke("lightmoni_proposals_get",{id:proposal.id})).data.proposal;
    assert.equal(full.result.runs[0].native_state,"queued");assert.equal(full.result.runs[0].requested_by,"admin");
  }finally{f.close();}
});
test("same task target set in a different order uses the same business idempotency record",async()=>{
  const f=fixture();try{
    const task=f.runs.nodes.getTask("script-one");
    f.runs.nodes.task({...task,host_ids:["one","two"]},task.id,false);
    const first=(await f.invoke("lightmoni_tasks_plan",{...intent,host_ids:["two","one"]})).data.proposal;
    const repeat=await f.invoke("lightmoni_tasks_plan",{...intent,host_ids:["one","two"]});
    assert.equal(repeat.data.proposal.id,first.id);assert.equal(repeat.data.idempotency_replayed,true);
    assert.equal(f.db.get<any>("SELECT count(*) n FROM assistant_task_proposals")!.n,1);
  }finally{f.close();}
});
