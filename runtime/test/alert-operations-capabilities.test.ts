import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities } from "../src/domains/alert-capabilities.js";
import { encode } from "../src/domains/common.js";
import { AlertProposalService } from "../src/assistant/alert-proposals.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,24)),cat:{list:async()=>[]},query:async()=>({request_id:"",results:[]}),referencedTables:async()=>[],logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const alerts=new Alerts(deps),capabilities=new AlertCapabilities(alerts),proposals=new AlertProposalService(db,capabilities,deps.now,deps.encrypt,deps.decrypt),at=deps.now().toISOString();
  db.run("INSERT INTO alert_responses(id,episode,group_id,state,created_at,body) VALUES('incident-one','episode-one','group-one','firing',?,?)",at,encode({id:"incident-one",episode:"episode-one",group_id:"group-one",group_name:"Ops",rule_id:"rule-one",original_priority:"P1",event:{rule_name:"API errors"},state:"firing",priority:"P1",created_at:at,owner_id:"admin",ack_at:"",evidence:{logs:"private-evidence"}}));
  db.run("INSERT INTO alert_response_events(id,response_id,at,body) VALUES('event-one','incident-one',?,?)",at,encode({state:"firing",summary:" fired "}));
  db.run("INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES('delivery-one','event-one','channel-one','private-contact','failed','',?,?)",at,encode({id:"delivery-one",response_id:"incident-one",rule_id:"rule-one",group_ids:["group-one"],table_ids:["log_app"],service:"api",delivery_status:"failed",attempts:2,provider_id:"provider",error:"raw provider error",provider_response:"private-response",payload:"private-payload"}));
  db.run("INSERT INTO alert_assignments(response_id,user_id,user_name,stage,priority,notified_at,ack_at,ack_method,outcome) VALUES('incident-one','admin','Admin','primary','P1',?,?,'web','acknowledged')",at,"2026-11-14T00:01:00.000Z");
  const runs=new TaskRunStore(deps),principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,alerts:capabilities,alertProposals:proposals});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,deps,alerts,capabilities,proposals,access,dispatcher,principal,invoke,close:async()=>{await alerts.close();db.close();}};
}

test("incident and notification reads preserve real state while omitting private delivery material",async()=>{
 const f=fixture();try{
  const incidents=await f.invoke("lightmoni_alert_incidents_list",{state:"firing",priority:"P1"});assert.equal(incidents.data.items[0].id,"incident-one");assert.equal(Object.hasOwn(incidents.data.items[0],"evidence"),false);
  const incident=await f.invoke("lightmoni_alert_incidents_get",{id:"incident-one"});assert.equal(incident.data.incident.id,"incident-one");assert.equal(incident.data.timeline[0].summary," fired ");
  const deliveries=await f.invoke("lightmoni_alert_deliveries_list",{status:"failed"});assert.equal(deliveries.data.items[0].id,"delivery-one");assert.equal(deliveries.data.items[0].error_present,true);
  const raw=JSON.stringify(deliveries);for(const secret of ["private-contact","private-response","private-payload","raw provider error"])assert.equal(raw.includes(secret),false);
  assert.equal(f.dispatcher.definitions.some(d=>/ack|claim|retry|test|assign/.test(d.name)),false);
 }finally{await f.close();}
});

test("incident and notification scopes are independent and installation-bound",async()=>{
 const f=fixture();try{
  const incidentsOnly={...structuredClone(f.principal),scopes:["alerts.incidents.read"]};await assert.rejects(f.invoke("lightmoni_alert_deliveries_list",{},incidentsOnly),/capability_forbidden/);
  const notificationsOnly={...structuredClone(f.principal),scopes:["alerts.notifications.read"]};await assert.rejects(f.invoke("lightmoni_alert_incidents_list",{},notificationsOnly),/capability_forbidden/);
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};assert.equal(f.dispatcher.list(hostScoped).some(d=>["alerts.incidents.list","alerts.deliveries.list"].includes(d.id)),false);
  const session=f.access.sessionPrincipal(member,"assistant");assert.equal((await f.invoke("lightmoni_alert_incidents_list",{},session)).data.total,1);
 }finally{await f.close();}
});

test("internal incident and delivery tools use dispatcher without duplicate alert tools",async()=>{
 const f=fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,alerts:f.capabilities,alertProposals:f.proposals,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();for(const name of ["list_alert_incidents","get_alert_incident","list_alert_deliveries"])assert.ok(tools.some(t=>t.name===name),name);
  const result=await tools.find(t=>t.name==="get_alert_incident")!.execute({id:"incident-one"},new AbortController().signal,admin);assert.equal(result.incident.id,"incident-one");
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_alert_incidents_get'"));
 }finally{await f.close();}
});

test("response statistics use native assignments with independent scope and internal adapter",async()=>{
 const f=fixture();try{
  const result=await f.invoke("lightmoni_alert_response_statistics_get",{group_id:"group-one",priority:"P1"});
  assert.equal(result.data.users[0].notified,1);assert.equal(result.data.users[0].acknowledged,1);assert.equal(result.data.users[0].ack_rate,100);assert.equal(result.data.users[0].mean_ack_seconds,60);assert.equal(result.data.records.length,1);assert.equal(result.data.truncated,false);
  const incidentsOnly={...structuredClone(f.principal),scopes:["alerts.incidents.read"]};await assert.rejects(f.invoke("lightmoni_alert_response_statistics_get",{},incidentsOnly),/capability_forbidden/);
  const internal=f.dispatcher.assistantTools().find(t=>t.name==="get_alert_response_statistics")!;
  const adapted=await internal.execute({group_id:"group-one"},new AbortController().signal,admin);assert.equal(adapted.users[0].ack_rate,100);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_alert_response_statistics_get'"));
 }finally{await f.close();}
});
