import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function seed(db: DB) {
  const at="2026-11-14T00:00:00Z";
  db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('one','Host one','one.test',22,'direct_ssh','agent-one',?,?)",at,at);
  db.run("INSERT INTO services(id,name,description,repository_url,created_at,updated_at,created_by) VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Checkout','Checkout API','https://example.test/repo',?,?,'admin')",at,at);
  db.run("INSERT INTO service_targets(id,service_id,machine_id,adapter,config_json,desired_release_id,status,created_at,updated_at) VALUES('target-one','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','one','systemd',?,'release-one','ready',?,?)",JSON.stringify({unit:"checkout.service",release_directory:"/opt/lightmoni/services/checkout"}),at,at);
  db.run("INSERT INTO releases(id,service_id,version,source_type,source_ref,artifact_digest,artifact_size,manifest_json,status,created_at,created_by) VALUES('release-one','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026.11.14','artifact','sha256:abc','sha256:abc',128,'{}','ready',?,'admin')",at);
  db.run("INSERT INTO deployments(id,service_id,target_id,release_id,adapter,status,plan_json,target_snapshot_json,receipt_json,phase,operation_id,created_at,created_by) VALUES('deployment-one','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','target-one','release-one','systemd','awaiting_approval','{}','{}','{}','awaiting_approval','operation-one',?,'admin')",at);
  db.run("INSERT INTO deployment_events(id,deployment_id,phase,state,summary,actor,created_at) VALUES('event-one','deployment-one','awaiting_approval','awaiting_approval','计划已生成','admin',?)",at);
}
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,19)),
    cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps),store=registerServiceDeployments(deps);seed(db);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,deployments:store});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,deps,store,access,dispatcher,principal,invoke,close:()=>db.close()};
}

test("service details, deployment history and events use native store views",async()=>{
 const f=fixture();try{
  assert.equal((await f.invoke("lightmoni_services_list",{})).data.services[0].id,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const detail=await f.invoke("lightmoni_services_get",{service_id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});assert.equal(detail.data.targets[0].id,"target-one");assert.equal(detail.data.releases[0].id,"release-one");
  const listed=await f.invoke("lightmoni_deployments_list",{service_id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",limit:1});assert.equal(listed.data.total,1);assert.equal(listed.data.items[0].status,"awaiting_approval");
  const deployment=await f.invoke("lightmoni_deployments_get",{deployment_id:"deployment-one"});assert.equal(deployment.data.deployment.operation_id,"operation-one");assert.equal(deployment.data.deployment.status,"awaiting_approval");
  const events=await f.invoke("lightmoni_deployments_events",{deployment_id:"deployment-one"});assert.deepEqual(events.data.events.map((e:any)=>e.id),["event-one"]);
  assert.equal(f.dispatcher.definitions.some(d=>/approve|rollback|upload|execute/.test(d.name)),false);
 }finally{f.close();}
});

test("deployment reads require admin installation scope",async()=>{
 const f=fixture();try{
  const without={...structuredClone(f.principal),scopes:[]};await assert.rejects(f.invoke("lightmoni_services_list",{},without),/capability_forbidden/);
  const hostScoped={...structuredClone(f.principal),scopes:["deployments.read"],host_ids:["one"]};assert.equal(f.dispatcher.list(hostScoped).some(d=>["services.list","deployments.get"].includes(d.id)),false);await assert.rejects(f.invoke("lightmoni_deployments_get",{deployment_id:"deployment-one"},hostScoped),/capability_forbidden/);
  const session=f.access.sessionPrincipal(member,"assistant");assert.equal(f.dispatcher.list(session).some(d=>d.id.startsWith("deployments.")||d.id.startsWith("services.")),false);await assert.rejects(f.invoke("lightmoni_services_list",{},session),/capability_forbidden/);
 }finally{f.close();}
});

test("assistant legacy deployment reads use dispatcher and preserve output shapes",async()=>{
 const f=fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,deployments:f.store,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  const services=await tools.find(t=>t.name==="list_services")!.execute({},new AbortController().signal,admin);assert.equal(services.services[0].id,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const deployment=await tools.find(t=>t.name==="get_service_deployment")!.execute({deployment_id:"deployment-one"},new AbortController().signal,admin);assert.equal(deployment.status,"awaiting_approval");
  const events=await tools.find(t=>t.name==="get_service_deployment_events")!.execute({deployment_id:"deployment-one"},new AbortController().signal,admin);assert.equal(events.events[0].id,"event-one");
  const details=await tools.find(t=>t.name==="list_service_details")!.execute({service_id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},new AbortController().signal,admin);assert.equal(details.targets.length,1);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_deployments_get'"));
 }finally{f.close();}
});
