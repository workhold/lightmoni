import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { Dashboards, normalizeDashboard } from "../src/domains/dashboards.js";
import { DashboardReadService } from "../src/domains/dashboard-read.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,22)),
    cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps),dashboards=new Dashboards(deps),custom=dashboards.insert(normalizeDashboard({title:"Business",description:"Custom dashboard",panels:[],variables:[]}));
  const reads=new DashboardReadService(dashboards),principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,dashboards:reads});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,deps,dashboards,custom,access,dispatcher,principal,invoke,close:()=>db.close()};
}

test("dashboard lists, details and versions use real custom and system records",async()=>{
 const f=fixture();try{
  const all=await f.invoke("lightmoni_dashboards_list",{scope:"all"});assert.ok(all.data.items.some((d:any)=>d.kind==="system"));assert.ok(all.data.items.some((d:any)=>d.id===f.custom.id));
  const custom=await f.invoke("lightmoni_dashboards_list",{scope:"custom",search:"business"});assert.deepEqual(custom.data.items.map((d:any)=>d.id),[f.custom.id]);assert.equal(Object.hasOwn(custom.data.items[0],"panels"),false);
  const detail=await f.invoke("lightmoni_dashboards_get",{id:f.custom.id});assert.equal(detail.data.dashboard.description,"Custom dashboard");
  const versions=await f.invoke("lightmoni_dashboards_versions",{id:f.custom.id});assert.deepEqual(versions.data.versions.map((v:any)=>v.revision),[1]);
  await assert.rejects(f.invoke("lightmoni_dashboards_get",{id:"missing"}),/大盘不存在/);
  assert.equal(f.dispatcher.definitions.some(d=>/save|copy|delete|draft/.test(d.name)),false);
 }finally{f.close();}
});

test("dashboard detail scope, installation scope and member session are explicit",async()=>{
 const f=fixture();try{
  const ordinary={...structuredClone(f.principal),scopes:["dashboards.read"]};assert.equal(f.dispatcher.list(ordinary).some(d=>d.name==="lightmoni_dashboards_get"),false);await assert.rejects(f.invoke("lightmoni_dashboards_get",{id:f.custom.id},ordinary),/capability_forbidden/);
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};assert.equal(f.dispatcher.list(hostScoped).some(d=>d.id.startsWith("dashboards.")),false);
  const session=f.access.sessionPrincipal(member,"assistant");assert.equal((await f.invoke("lightmoni_dashboards_get",{id:f.custom.id},session)).data.dashboard.id,f.custom.id);
 }finally{f.close();}
});

test("internal dashboard tools share dispatcher and oversized details fail closed",async()=>{
 const f=fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();for(const name of ["list_dashboards","get_dashboard","get_dashboard_versions"])assert.ok(tools.some(t=>t.name===name),name);
  const result=await tools.find(t=>t.name==="get_dashboard")!.execute({id:f.custom.id},new AbortController().signal,admin);assert.equal(result.dashboard.id,f.custom.id);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_dashboards_get'"));
  f.db.run("UPDATE dashboards SET body=? WHERE id=?",JSON.stringify({...f.custom,description:"x".repeat(70_000)}),f.custom.id);
  await assert.rejects(f.invoke("lightmoni_dashboards_get",{id:f.custom.id}),/result_too_large/);
 }finally{f.close();}
});
