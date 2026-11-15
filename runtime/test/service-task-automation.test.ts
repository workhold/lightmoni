import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { McpAccess } from "../src/mcp/access.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { SCRIPT_TASK_CAPABILITY } from "../src/shared/task-center.js";
import { taskHelperFixture } from "./helpers/task-helper.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"};
const other: User = {id:"other",name:"Other",role:"admin"};
const bearer = (token:string) => ({headers:{authorization:"Bearer "+token}} as IncomingMessage);
const definition = (id:string) => ({name:"Script "+id,type:"script",enabled:true,target_all:false,host_ids:[id],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('service fixture')",timeout_seconds:5,max_output_bytes:4096}});

function fixture(legacyRunAuthorization = false) {
  const db=new DB(":memory:");accountSchema(db);for(const user of [admin,other])db.run("INSERT INTO users(id,name,role,active,created_at) VALUES(?,?,?,1,'2026-11-14')",user.id,user.name,user.role);
  let now=new Date("2026-11-14T00:00:00.000Z");
  const deps={db,router:new Router(),now:()=>now,externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,57)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps);
  for(const id of ["one","two"]){
    db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)",id,"Host "+id,id+".test","agent-"+id,now.toISOString(),now.toISOString());
    runs.nodes.task(definition(id),"script-"+id,true);
  }
  if(legacyRunAuthorization)db.exec("CREATE TABLE capability_run_authorizations(run_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,user_id TEXT NOT NULL,host_id TEXT NOT NULL)");
  const helpers=taskHelperFixture(deps,runs),access=new McpAccess(deps),authority=new CapabilityAccess(deps,access),dispatcher=new CapabilityDispatcher(deps,authority,{taskCenter:runs});
  const makeService=(input:Record<string,unknown>={})=>access.createServiceAccount(admin,{
    name:"Task automation",capabilities:[{name:"lightmoni_tasks_plan",version:1,input:{operation:"task.dispatch",task_id:"script-one",host_ids:["one"]}}],
    host_ids:["one"],expires_in_hours:2,max_invocations:1,...input,
  },dispatcher.definitions);
  const principal=(made:any)=>access.authenticate(bearer(made.token));
  const invoke=async(made:any,input:any)=>dispatcher.invoke(principal(made),"lightmoni_tasks_plan",input,{signal:new AbortController().signal});
  const dispatchIntent=(key="dispatch-one")=>({operation:"task.dispatch",task_id:"script-one",host_ids:["one"],reason:"Reviewed service dispatch",idempotency_key:key});
  const serviceUser=(made:any)=>({id:made.service_id,name:"Task automation",role:"admin"});
  const submitAndApply=async(made:any,key="dispatch-one")=>{
    const proposal=(await invoke(made,dispatchIntent(key))).data.proposal,applied=dispatcher.proposals.apply(admin,proposal.id);
    return{proposal,run:(applied.result as any).runs[0]};
  };
  return{db,deps,runs,helpers,access,dispatcher,makeService,principal,invoke,dispatchIntent,serviceUser,submitAndApply,advance(seconds:number){now=new Date(now.getTime()+seconds*1000);},close:()=>db.close()};
}

test("service task proposal requires human Owner and completes through native claim/result without extra budget",async()=>{
  const f=await fixture();try{
    const made=f.makeService(),proposal=(await f.invoke(made,f.dispatchIntent())).data.proposal;
    assert.equal(proposal.status,"awaiting_approval");assert.equal(f.runs.list().length,0);
    const source=f.dispatcher.proposals.source(f.serviceUser(made),proposal.id)!;
    assert.equal(source.subject_type,"service");assert.equal(source.subject_id,made.service_id);assert.equal(source.owner_user_id,admin.id);
    assert.equal(source.capability?.id,"tasks.plan");assert.equal((source.capability?.input as any).operation,"task.dispatch");
    assert.equal(Object.hasOwn(proposal,"capability"),false);assert.equal(f.db.get<any>("SELECT owner_id FROM assistant_task_proposals WHERE id=?",proposal.id)!.owner_id,made.service_id);
    assert.throws(()=>f.dispatcher.proposals.get(other,proposal.id),/不存在/);assert.throws(()=>f.dispatcher.proposals.apply(other,proposal.id),/不存在/);
    assert.throws(()=>f.dispatcher.proposals.apply(f.serviceUser(made),proposal.id),/Owner 管理员/);assert.equal(f.runs.list().length,0);
    assert.equal(f.dispatcher.proposals.get(admin,proposal.id).status,"awaiting_approval");
    const applied=f.dispatcher.proposals.apply(admin,proposal.id),run=(applied.result as any).runs[0];
    assert.equal(applied.status,"completed");assert.equal(run.state,"queued");assert.equal(run.requested_by,admin.id);
    const binding=f.db.get<any>("SELECT * FROM capability_run_authorizations WHERE run_id=?",run.id)!;
    assert.equal(binding.user_id,made.service_id);assert.equal(binding.proposal_id,proposal.id);assert.equal(binding.grant_id,made.grant_id);
    assert.equal(f.db.get<any>("SELECT actor_id FROM assistant_task_audit WHERE proposal_id=?",proposal.id)!.actor_id,admin.id);
    const claimed=f.helpers.claim("agent-one",[SCRIPT_TASK_CAPABILITY])!;assert.ok(claimed);assert.equal(claimed.state,"running");
    f.helpers.result("agent-one",claimed.id,{lease_token:claimed.lease_token,state:"succeeded",code:"",summary:"done",stdout:"",stderr:"",exit_code:0});
    assert.equal(f.runs.get(run.id).state,"succeeded");assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",made.service_id)!.invocation_count,1);
  }finally{f.close();}
});

test("service task rules pin allowed operations and reject other writes or targets before budget",async()=>{
  const f=await fixture();try{
    assert.throws(()=>f.makeService({capabilities:[{name:"lightmoni_tasks_plan",version:1,input:{operation:"task.create"}}]}),/automation_capability_forbidden/);
    assert.throws(()=>f.makeService({capabilities:[{name:"lightmoni_alerts_plan",version:1,input:{operation:"rule.update"}}]}),/automation_capability_forbidden/);
    const made=f.makeService();
    await assert.rejects(f.invoke(made,{...f.dispatchIntent(),operation:"task.create"}),/automation_capability_forbidden/);
    await assert.rejects(f.invoke(made,{...f.dispatchIntent(),host_ids:["two"]}),/resource_not_found|automation_input_forbidden/);
    assert.throws(()=>f.dispatcher.proposals.createFrom(f.serviceUser(made),{source:"mcp",grant_id:made.grant_id,subject_type:"service",subject_id:made.service_id,owner_user_id:admin.id,
      capability:{id:"tasks.plan",name:"lightmoni_tasks_plan",version:1,input:{operation:"task.create"}}},{operation:"task.create",task:definition("one"),reason:"Bypass fixture"}),/固定既有任务/);
    assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",made.service_id)!.invocation_count,0);
    assert.deepEqual(f.dispatcher.definitions.filter(d=>/approve|apply|execute/.test(d.name)),[]);
  }finally{f.close();}
});

test("policy drift and service invalidation block Owner approval without creating a run",async()=>{
  for(const change of ["drift","revoke","expire","demote"]){
    const f=await fixture();try{
      const made=f.makeService(),proposal=(await f.invoke(made,f.dispatchIntent())).data.proposal;
      if(change==="drift")f.db.run("UPDATE mcp_service_accounts SET capabilities_json=? WHERE id=?",JSON.stringify([{id:"tasks.plan",name:"lightmoni_tasks_plan",version:1,input:{operation:"task.dispatch",task_id:"script-two",host_ids:["two"]}}]),made.service_id);
      if(change==="revoke")f.access.revokeServiceAccount(admin,made.service_id);
      if(change==="expire")f.advance(3*3600);
      if(change==="demote")f.db.run("UPDATE users SET role='member' WHERE id='admin'");
      assert.throws(()=>f.dispatcher.proposals.apply(admin,proposal.id),/automation|失效|变化/);assert.equal(f.runs.list().length,0);
      assert.equal(f.dispatcher.proposals.get(admin,proposal.id).status,"awaiting_approval");
    }finally{f.close();}
  }
});

test("policy drift or revocation after approval fences claim with authorization_revoked",async()=>{
  for(const change of ["drift","revoke"]){
    const f=await fixture();try{
      const made=f.makeService(),{run}=await f.submitAndApply(made);
      if(change==="drift")f.db.run("UPDATE mcp_service_accounts SET capabilities_json=? WHERE id=?",JSON.stringify([{id:"tasks.plan",name:"lightmoni_tasks_plan",version:1,input:{operation:"task.dispatch",task_id:"script-two",host_ids:["two"]}}]),made.service_id);
      else f.access.revokeServiceAccount(admin,made.service_id);
      assert.equal(f.helpers.claim("agent-one",[SCRIPT_TASK_CAPABILITY]),null);
      assert.equal(f.runs.get(run.id).state,"cancelled");assert.equal(f.runs.get(run.id).code,"authorization_revoked");assert.equal(f.runs.get(run.id).started_at,"");
    }finally{f.close();}
  }
});

test("automatic retries retain proposal/service authorization and revalidate before queueing and claim",async()=>{
  for(const revokeBeforeRetry of [false,true]){
    const f=await fixture();try{
      const task=f.runs.nodes.getTask("script-one");f.runs.nodes.task({...task,execution_policy:{retry_count:1,retry_delay_seconds:10}},task.id,false);
      const made=f.makeService(),{proposal,run:original}=await f.submitAndApply(made),claimed=f.helpers.claim("agent-one",[SCRIPT_TASK_CAPABILITY])!;assert.ok(claimed);
      f.helpers.result("agent-one",claimed.id,{lease_token:claimed.lease_token,state:"failed",code:"script_failed",summary:"fixture failure",stdout:"",stderr:"",exit_code:1});
      f.advance(10);if(revokeBeforeRetry)f.access.revokeServiceAccount(admin,made.service_id);f.runs.tick();
      if(revokeBeforeRetry){
        assert.equal(f.runs.list().length,1);assert.equal(f.db.get<any>("SELECT auto_retry_closed FROM task_runs WHERE id=?",original.id)!.auto_retry_closed,1);
      }else{
        const retry=f.runs.list().find(run=>run.retry_of===original.id)!;assert.ok(retry);
        const binding=f.db.get<any>("SELECT * FROM capability_run_authorizations WHERE run_id=?",retry.id)!;
        assert.equal(binding.proposal_id,proposal.id);assert.equal(binding.user_id,made.service_id);assert.equal(binding.grant_id,made.grant_id);
        assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",made.service_id)!.invocation_count,1);
        const next=f.helpers.claim("agent-one",[SCRIPT_TASK_CAPABILITY])!;assert.ok(next);assert.equal(next.id,retry.id);
      }
    }finally{f.close();}
  }
});

test("service cancel and retry remain native proposals with human approval and stable retry binding",async()=>{
  const f=await fixture();try{
    const original=f.runs.dispatch("script-one",{host_ids:["one"],confirm:true,request_id:"manual-fixture"},admin.id,true).runs[0];
    const cancel=f.makeService({capabilities:[{name:"lightmoni_tasks_plan",version:1,input:{operation:"run.cancel",run_id:original.id}}]});
    const cancelProposal=(await f.invoke(cancel,{operation:"run.cancel",run_id:original.id,reason:"Review cancellation",idempotency_key:"cancel-one"})).data.proposal;
    assert.equal(f.runs.get(original.id).state,"queued");f.dispatcher.proposals.apply(admin,cancelProposal.id);assert.equal(f.runs.get(original.id).state,"cancelled");
    const retry=f.makeService({capabilities:[{name:"lightmoni_tasks_plan",version:1,input:{operation:"run.retry",run_id:original.id}}]});
    const retryProposal=(await f.invoke(retry,{operation:"run.retry",run_id:original.id,reason:"Review retry",idempotency_key:"retry-one"})).data.proposal;
    const applied=f.dispatcher.proposals.apply(admin,retryProposal.id),created=(applied.result as any);
    assert.equal(created.retry_of,original.id);assert.equal(created.state,"queued");
    assert.equal(f.db.get<any>("SELECT proposal_id,user_id FROM capability_run_authorizations WHERE run_id=?",created.id)!.proposal_id,retryProposal.id);
    assert.equal(f.db.get<any>("SELECT user_id FROM capability_run_authorizations WHERE run_id=?",created.id)!.user_id,retry.service_id);
  }finally{f.close();}
});

test("service idempotent replay returns the same native proposal without duplicate execution",async()=>{
  const f=await fixture();try{
    const made=f.makeService({max_invocations:3}),first=(await f.invoke(made,f.dispatchIntent())).data.proposal;
    const replay=(await f.invoke(made,f.dispatchIntent())).data;assert.equal(replay.proposal.id,first.id);assert.equal(replay.idempotency_replayed,true);
    await assert.rejects(f.invoke(made,{...f.dispatchIntent(),reason:"Changed intention"}),/idempotency_conflict/);
    const applied=f.dispatcher.proposals.apply(admin,first.id);assert.equal((applied.result as any).runs.length,1);assert.equal(f.runs.list().length,1);
    // Initial acceptance, replay and the admitted idempotency conflict are three attempts; only one proposal/run exists.
    assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",made.service_id)!.invocation_count,3);
  }finally{f.close();}
});

test("legacy run authorization gains an empty proposal reference without changing personal semantics",()=>{
  const f=fixture(true);try{
    f.db.run("INSERT INTO capability_run_authorizations(run_id,grant_id,user_id,host_id) VALUES('legacy-run','legacy-grant','admin','one')");
    assert.equal(f.db.get<any>("SELECT proposal_id FROM capability_run_authorizations WHERE run_id='legacy-run'")!.proposal_id,"");
    assert.equal(f.db.get<any>("SELECT user_id FROM capability_run_authorizations WHERE run_id='legacy-run'")!.user_id,"admin");
  }finally{f.close();}
});
