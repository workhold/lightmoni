import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { InstrumentationService } from "../src/assistant/instrumentation.js";
import { Store as UsageStore } from "../src/assistant/usage.js";
import { registerAssistant } from "../src/assistant/index.js";
import { ExecutionGrantRegistry } from "../src/capabilities/execution-grants.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
const source=["import express from 'express';","import { createLightMoni } from '@lightmoni/sdk';","const app = express();","const mon = createLightMoni({ service: 'checkout', env: 'prod' });","app.get('/health', async (req, res) => {","  res.send('ok');","});",""].join("\n");
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),"lm-instrumentation-proposal-"));mkdirSync(join(root,"src"));
  writeFileSync(join(root,"package.json"),JSON.stringify({dependencies:{"@lightmoni/sdk":"^0.3.0",express:"^5"}}));writeFileSync(join(root,"src","server.ts"),source);
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const router=new Router(),deps={db,router,now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,33)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  deps.auth={user:()=>admin,requireAdmin(ctx:any){if(ctx.user.role!=="admin")fail(403,"administrator required");}} as any;router.auth=deps.auth;
  const usage=new UsageStore(db,deps.now),store={get:<T>(key:string)=>{const saved=usage.get<string>(key);return saved?JSON.parse(deps.decrypt(saved)) as T:undefined},put:(key:string,value:unknown)=>usage.put(key,deps.encrypt(JSON.stringify(value)))};
  const instrumentation=new InstrumentationService(root,{now:deps.now,store}),grants=new ExecutionGrantRegistry(deps),runs=new TaskRunStore(deps);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};let revoked=false;
  const access=new CapabilityAccess(deps,{validate(){if(revoked)throw Error("revoked")},validateGrant(){if(revoked)throw Error("revoked");return structuredClone(principal)}});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,instrumentation,executionGrants:grants});
  const assistant=registerAssistant(deps,{capabilities:dispatcher,instrumentationService:instrumentation,runtime:async()=>{}});
  const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.statusCode=404;res.end();}}));server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as any).port}`,request=async(path:string,method="GET",body?:any)=>{const response=await fetch(base+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();return{status:response.status,raw,data:raw?JSON.parse(raw):undefined};};
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  const input={workspace:".",intent:"instrument requests",service:"checkout",env:"prod",reason:"review instrumentation",idempotency_key:"instrumentation-one"};
  return{db,deps,root,instrumentation,grants,access,dispatcher,principal,input,invoke,request,revoke:()=>{revoked=true},close:async()=>{await assistant.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(root,{recursive:true,force:true});}};
}

test("external instrumentation plans use transactional idempotency, bounded diffs and native review/apply",async()=>{
 const f=await fixture();try{
  const scan=await f.invoke("lightmoni_code_instrumentation_scan",{workspace:"."}),created=await f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:scan.data.base_revision}),proposal=created.data.proposal;
  assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.native_status,"awaiting_approval");assert.ok(proposal.review_url.startsWith("https://moni.example.test/api/v1/instrumentation-plans/"));
  assert.equal(created.data.plan.diff_omitted.includes("Full diff"),true);assert.equal(created.data.plan.files[0].patch,undefined);assert.equal(readFileSync(join(f.root,"src","server.ts"),"utf8"),source);
  const review=await f.request(`/api/v1/instrumentation-plans/${proposal.id}`);assert.equal(review.status,200,review.raw);assert.match(review.data.plan.files[0].patch,/mon\.record/);assert.equal(Object.hasOwn(review.data,"before"),false);
  const replay=await f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:scan.data.base_revision});assert.equal(replay.data.proposal.id,proposal.id);assert.equal(replay.data.idempotency_replayed,true);
  const changedRevision=await f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:"changed-target-revision"});assert.equal(changedRevision.data.proposal.id,proposal.id);assert.equal(changedRevision.data.idempotency_replayed,true);
  const concurrent=await Promise.all([f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:scan.data.base_revision,idempotency_key:"concurrent"}),f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:scan.data.base_revision,idempotency_key:"concurrent"})]);assert.equal(concurrent[0].data.proposal.id,concurrent[1].data.proposal.id);
  await assert.rejects(f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:scan.data.base_revision,reason:"changed"}),/idempotency_conflict/);
  const applied=await f.request(`/api/v1/instrumentation-plans/${proposal.id}/apply`,"POST",{base_revision:scan.data.base_revision,approval:"apply"});assert.equal(applied.status,200,applied.raw);assert.equal(applied.data.state,"applied");
  assert.match(readFileSync(join(f.root,"src","server.ts"),"utf8"),/mon\.record\("service", "requests_total"/);
  const completed=await f.invoke("lightmoni_code_instrumentation_plan",{...f.input,base_revision:scan.data.base_revision});assert.equal(completed.data.proposal.status,"completed");assert.equal(completed.data.applied.state,"applied");
 }finally{await f.close();}
});

test("instrumentation proposal requires both scopes, admin and installation access",async()=>{
 const f=await fixture();try{
  for(const scopes of [["code.workspace.propose"],["code.workspace.detail.read"]]){const p={...structuredClone(f.principal),scopes};assert.equal(f.dispatcher.list(p).some(d=>d.name==="lightmoni_code_instrumentation_plan"),false);await assert.rejects(f.invoke("lightmoni_code_instrumentation_plan",f.input,p),/scope_required|capability_forbidden/);}
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};await assert.rejects(f.invoke("lightmoni_code_instrumentation_plan",f.input,hostScoped),/capability_forbidden/);
  const session=f.access.sessionPrincipal(member,"assistant");await assert.rejects(f.invoke("lightmoni_code_instrumentation_plan",f.input,session),/capability_forbidden/);
 }finally{await f.close();}
});

test("revoked and unbound external plans cannot modify workspace files",async()=>{
 const f=await fixture();try{
  const created=await f.invoke("lightmoni_code_instrumentation_plan",f.input),proposal=created.data.proposal,base=created.data.plan.base_revision;f.revoke();
  const denied=await f.request(`/api/v1/instrumentation-plans/${proposal.id}/apply`,"POST",{base_revision:base,approval:"apply"});assert.equal(denied.status,403,denied.raw);assert.equal(denied.data.error,"authorization_revoked");assert.equal(readFileSync(join(f.root,"src","server.ts"),"utf8"),source);
  const unbound=await f.instrumentation.propose({workspace:".",intent:"instrument requests"},new AbortController().signal,{source:{source:"mcp",user_id:admin.id,grant_id:"missing",reason:"unbound"}});
  const missing=await f.request(`/api/v1/instrumentation-plans/${unbound.plan_id}/apply`,"POST",{base_revision:unbound.base_revision,approval:"apply"});assert.equal(missing.status,403,missing.raw);assert.equal(missing.data.error,"authorization_revoked");assert.equal(readFileSync(join(f.root,"src","server.ts"),"utf8"),source);
 }finally{await f.close();}
});

test("acceptance rollback leaves no durable or cached instrumentation plan",async()=>{
 const f=await fixture();try{
  f.db.exec("CREATE TRIGGER fail_instrumentation_accept BEFORE INSERT ON capability_idempotency WHEN NEW.capability='lightmoni_code_instrumentation_plan' BEGIN SELECT RAISE(ABORT,'forced_accept_failure'); END;");
  await assert.rejects(f.invoke("lightmoni_code_instrumentation_plan",f.input),/forced_accept_failure/);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM assistant_records WHERE id LIKE 'instrumentation-plan/%'")!.n,0);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM capability_execution_grants WHERE domain='instrumentation'")!.n,0);
  assert.equal((f.instrumentation as any).records.size,0);
 }finally{await f.close();}
});

test("internal instrumentation proposal preserves the full plan and native apply without an external grant",async()=>{
 const f=await fixture();try{
  const tools=f.dispatcher.assistantTools(),tool=tools.find(t=>t.name==="propose_sdk_instrumentation")!;
  assert.equal(Object.hasOwn(tool.schema.properties,"idempotency_key"),false);assert.equal(Object.hasOwn(tool.schema.properties,"reason"),false);
  const plan=await tool.execute({workspace:".",intent:"instrument requests"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(plan.state,"awaiting_approval");assert.match(plan.files[0].patch,/mon\.record/);assert.equal(plan.diff_omitted,undefined);
  assert.equal(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='instrumentation' AND native_id=?",plan.plan_id),undefined);
  const applied=await f.request(`/api/v1/instrumentation-plans/${plan.plan_id}/apply`,"POST",{base_revision:plan.base_revision,approval:"apply"});assert.equal(applied.status,200,applied.raw);assert.equal(applied.data.state,"applied");
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_code_instrumentation_plan'"));
 }finally{await f.close();}
});
