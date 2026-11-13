import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { InstrumentationService } from "../src/assistant/instrumentation.js";
import { Store as UsageStore } from "../src/assistant/usage.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"lm-instrumentation-capability-"));
  writeFileSync(join(root,"package.json"),JSON.stringify({dependencies:{"@lightmoni/sdk":"0.1.0",express:"5.0.0"}}));
  writeFileSync(join(root,"server.ts"),"import {createLightMoni} from '@lightmoni/sdk';\nimport express from 'express';\nconst app=express();\napp.get('/orders', async (_req,res)=>res.send('ok'));\n");
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,23)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const usage=new UsageStore(db,deps.now),store={get:<T>(key:string)=>{const saved=usage.get<string>(key);return saved?JSON.parse(deps.decrypt(saved)) as T:undefined},put:(key:string,value:unknown)=>usage.put(key,deps.encrypt(JSON.stringify(value)))};
  const instrumentation=new InstrumentationService(root,{now:deps.now,store}),runs=new TaskRunStore(deps);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,instrumentation});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,deps,root,instrumentation,access,dispatcher,principal,invoke,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

test("workspace scan and proposal read use the shared InstrumentationService",async()=>{
 const f=fixture();try{
  const scan=await f.invoke("lightmoni_code_instrumentation_scan",{workspace:"."});assert.equal(scan.data.sdk.found,true);assert.ok(scan.data.candidates.length>0);
  const plan=await f.instrumentation.propose({workspace:".",intent:"instrument requests",base_revision:scan.data.base_revision,service:"orders",env:"prod",mode:"direct",table:"service",metric:"requests_total"},new AbortController().signal);
  const read=await f.invoke("lightmoni_code_instrumentation_get",{plan_id:plan.plan_id});assert.equal(read.data.plan.plan_id,plan.plan_id);assert.equal(read.data.applied,null);assert.equal(Object.hasOwn(read.data,"before"),false);
  await assert.rejects(f.invoke("lightmoni_code_instrumentation_scan",{workspace:"../"}),/workspace/);
  assert.equal(f.dispatcher.definitions.some(d=>/propose|apply|code_task/.test(d.name)),false);
 }finally{f.close();}
});

test("instrumentation details require a separate admin installation scope",async()=>{
 const f=fixture();try{
  const scan=await f.instrumentation.scan(".");const plan=await f.instrumentation.propose({workspace:".",intent:"instrument requests",base_revision:scan.base_revision},new AbortController().signal);
  const ordinary={...structuredClone(f.principal),scopes:["code.workspace.read"]};assert.equal(f.dispatcher.list(ordinary).some(d=>d.name==="lightmoni_code_instrumentation_get"),false);await assert.rejects(f.invoke("lightmoni_code_instrumentation_get",{plan_id:plan.plan_id},ordinary),/capability_forbidden/);
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};assert.equal(f.dispatcher.list(hostScoped).some(d=>d.id.startsWith("code.")),false);
  const session=f.access.sessionPrincipal(member,"assistant");await assert.rejects(f.invoke("lightmoni_code_instrumentation_scan",{workspace:"."},session),/capability_forbidden/);
 }finally{f.close();}
});

test("internal scan and get use dispatcher without replacing native propose/apply",async()=>{
 const f=fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,instrumentationService:f.instrumentation,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();assert.ok(tools.some(t=>t.name==="scan_sdk_instrumentation"));assert.ok(tools.some(t=>t.name==="get_sdk_instrumentation"));
  const scan=await tools.find(t=>t.name==="scan_sdk_instrumentation")!.execute({workspace:"."},new AbortController().signal,admin);assert.equal(scan.sdk.found,true);
  const plan=await f.instrumentation.propose({workspace:".",intent:"instrument requests",base_revision:scan.base_revision},new AbortController().signal);
  const read=await tools.find(t=>t.name==="get_sdk_instrumentation")!.execute({plan_id:plan.plan_id},new AbortController().signal,admin);assert.equal(read.plan.plan_id,plan.plan_id);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_code_instrumentation_get'"));
 }finally{f.close();}
});
