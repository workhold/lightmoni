import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { registerOperations } from "../src/server/operations.js";
import { registerOperationSchedules } from "../src/server/operation-schedules.js";
import { websiteDefinition } from "../src/operations/websites.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,20)),
    cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps),operations=registerOperations(deps,{definitions:[websiteDefinition],credentials:{has:()=>true} as any,jobs:{onUpdate:()=>()=>{}} as any});
  const config=websiteDefinition.validate({domains:["example.test"],mode:"static",static_files:{"index.html":"private-body"}});
  db.run("INSERT INTO ops_resources(id,kind,name,agent_id,revision,config_cipher,created_at,updated_at,created_by) VALUES('site-one','website','Site','agent-one',1,?,?,?,'admin')",deps.encrypt(JSON.stringify(config)),"2026-11-14T00:00:00Z","2026-11-14T00:00:00Z");
  const run=operations.plan("site-one","inspect",{},admin.id);
  const schedules=registerOperationSchedules(deps,operations),schedule=schedules.create({name:"Hourly inspect",resource_id:"site-one",resource_revision:1,operation:"inspect",input:{},cron:"0 * * * *",timezone:"UTC",enabled:false},admin.id);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,operations,operationSchedules:schedules});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,deps,operations,schedules,run,schedule,access,dispatcher,principal,invoke,close:async()=>{await schedules.close?.();await operations.close?.();db.close();}};
}

test("operations resources, runs and schedules share native safe read models",async()=>{
 const f=fixture();try{
  const resources=await f.invoke("lightmoni_operations_resources_list",{kind:"website"});assert.equal(resources.data.resources[0].config.static_files_summary.body_omitted,true);assert.equal(JSON.stringify(resources).includes("private-body"),false);
  const resource=await f.invoke("lightmoni_operations_resources_get",{id:"site-one"});assert.equal(resource.data.resource.config.static_files_summary.file_count,1);
  const runs=await f.invoke("lightmoni_operations_runs_list",{resource_id:"site-one"});assert.equal(runs.data.items[0].id,f.run.id);assert.equal(Object.hasOwn(runs.data.items[0],"preview"),false);
  const run=await f.invoke("lightmoni_operations_runs_get",{id:f.run.id});assert.equal(run.data.run.state,"awaiting_approval");
  const schedules=await f.invoke("lightmoni_operations_schedules_list",{});assert.equal(schedules.data.items[0].id,f.schedule.id);
  const schedule=await f.invoke("lightmoni_operations_schedules_get",{id:f.schedule.id});assert.equal(schedule.data.schedule.operation,"inspect");assert.deepEqual(schedule.data.fires,[]);
  assert.equal(f.dispatcher.definitions.some(d=>/approve|delete|execute|trigger/.test(d.name)),false);
 }finally{await f.close();}
});

test("operations reads require admin installation scope",async()=>{
 const f=fixture();try{
  const hostScoped={...structuredClone(f.principal),scopes:["operations.read"],host_ids:["one"]};assert.equal(f.dispatcher.list(hostScoped).some(d=>d.id.startsWith("operations.")),false);await assert.rejects(f.invoke("lightmoni_operations_resources_list",{},hostScoped),/capability_forbidden/);
  const session=f.access.sessionPrincipal(member,"assistant");assert.equal(f.dispatcher.list(session).some(d=>d.id.startsWith("operations.")),false);await assert.rejects(f.invoke("lightmoni_operations_runs_get",{id:f.run.id},session),/capability_forbidden/);
 }finally{await f.close();}
});

test("assistant operation aliases share dispatcher without duplicate native tools",async()=>{
 const f=fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,operations:f.operations,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();for(const name of ["list_operations_resources","get_operations_run","get_operations_resource","list_operations_runs","list_operation_schedules","get_operation_schedule"])assert.ok(tools.some(t=>t.name===name),name);
  const result=await tools.find(t=>t.name==="get_operations_run")!.execute({id:f.run.id},new AbortController().signal,admin);assert.equal(result.run.id,f.run.id);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_operations_runs_get'"));
 }finally{await f.close();}
});
