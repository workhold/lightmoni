import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities } from "../src/domains/alert-capabilities.js";
import { AlertProposalService } from "../src/assistant/alert-proposals.js";
import { encode } from "../src/domains/common.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
async function fixture() {
  let clock=new Date("2026-11-14T00:00:00Z");
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>clock,externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,26)),
    cat:{list:async()=>[{id:"log_app",name:"log_app",logical_name:"app",kind:"log",columns:[],services:["api"],system:false,retention_days:null,effective_retention_days:7}]},
    referencedTables:async()=>["log_app"],query:async()=>({request_id:"",results:[]}),logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const alerts=new Alerts(deps),capabilities=new AlertCapabilities(alerts),proposals=new AlertProposalService(db,capabilities,deps.now,deps.encrypt,deps.decrypt);
  db.run("INSERT INTO alert_groups VALUES('group-one','Ops',?)",encode({id:"group-one",name:"Ops",enabled:true,members:["admin","member"],policies:{},targets:[]}));
  const prepared=await capabilities.prepareRuleSave(admin,{name:"API errors",enabled:true,kind:"sql",severity:"P2",sql:"SELECT count() AS value FROM log_app",value_field:"value",source_table_ids:["log_app"],group_ids:["group-one"],threshold:"1",operator:"gt",interval_seconds:10,window_seconds:60,evidence_profile:{}});
  const rule=db.transaction(()=>capabilities.commitRuleSave(admin,prepared)),runs=new TaskRunStore(deps),principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};let revoked=false,grantPrincipal=structuredClone(principal);
  db.run("INSERT INTO alert_responses(id,episode,group_id,state,created_at,body) VALUES('incident-one','episode-one','group-one','firing',?,?)",deps.now().toISOString(),encode({id:"incident-one",episode:"episode-one",group_id:"group-one",group_name:"Ops",rule_id:rule.id,state:"firing",priority:"P1",original_priority:"P1",generation:0,stage:"primary",created_at:deps.now().toISOString(),last_tick:deps.now().toISOString(),owner_id:"",owner_name:"",group:{id:"group-one",name:"Ops",members:["admin"],policies:{},targets:[]},evidence:{logs:"private-evidence"}}));
  const access=new CapabilityAccess(deps,{validate(){if(revoked)throw Error("revoked")},validateGrant(){if(revoked)throw Error("revoked");return structuredClone(grantPrincipal)}});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,alerts:capabilities,alertProposals:proposals});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,alerts,capabilities,proposals,rule,dispatcher,principal,access,invoke,advance:(ms:number)=>{clock=new Date(clock.getTime()+ms);},revoke:()=>{revoked=true},shrinkIncidents:()=>{grantPrincipal={...grantPrincipal,scopes:grantPrincipal.scopes.filter(s=>s!=="alerts.incidents.read")};},close:async()=>{await alerts.close();db.close();}};
}

test("external alert rule and silence proposals use native approval and transactional idempotency",async()=>{
 const f=await fixture();try{
  const input={operation:"rule.update",target_id:f.rule.id,patch:{threshold:"2"},reason:"review",idempotency_key:"rule-one"};
  const created=await f.invoke("lightmoni_alerts_plan",input),proposal=created.data.proposal;assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.session_id,"");assert.equal(f.capabilities.getRule(admin,f.rule.id).threshold,"1");
  assert.equal((await f.invoke("lightmoni_alerts_plan",input)).data.proposal.id,proposal.id);assert.equal((await f.invoke("lightmoni_alerts_plan",input)).data.idempotency_replayed,true);
  const concurrent=await Promise.all([f.invoke("lightmoni_alerts_plan",{...input,idempotency_key:"concurrent"}),f.invoke("lightmoni_alerts_plan",{...input,idempotency_key:"concurrent"})]);assert.equal(concurrent[0].data.proposal.id,concurrent[1].data.proposal.id);
  await assert.rejects(f.invoke("lightmoni_alerts_plan",{...input,patch:{threshold:"3"}}),/idempotency_conflict/);
  const applied=await f.proposals.apply(admin,proposal.id,new AbortController().signal);assert.equal(applied.status,"completed");assert.equal(f.capabilities.getRule(admin,f.rule.id).threshold,"2");
  const silence=await f.invoke("lightmoni_alerts_plan",{operation:"silence.create",silence:{scope:"rule",rule_id:f.rule.id,until:"2026-11-14T02:00:00Z",reason:"maintenance"},reason:"silence",idempotency_key:"silence-one"});
  await f.proposals.apply(admin,silence.data.proposal.id,new AbortController().signal);assert.equal(f.capabilities.listSilences(admin).length,1);
  assert.equal(f.dispatcher.definitions.some(d=>/apply|approve/.test(d.name)),false);
 }finally{await f.close();}
});

test("alert proposals require both scopes, installation access and live grant at approval",async()=>{
 const f=await fixture();try{
  const withoutDetail={...structuredClone(f.principal),scopes:["alerts.propose"]};assert.equal(f.dispatcher.list(withoutDetail).some(d=>d.name==="lightmoni_alerts_plan"),false);await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"rule.update",target_id:f.rule.id,patch:{threshold:"2"},reason:"x",idempotency_key:"x"},withoutDetail),/scope_required/);
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"rule.update",target_id:f.rule.id,patch:{threshold:"2"},reason:"x",idempotency_key:"host"},hostScoped),/capability_forbidden/);
  const pending=await f.invoke("lightmoni_alerts_plan",{operation:"rule.update",target_id:f.rule.id,patch:{threshold:"3"},reason:"pending",idempotency_key:"pending"});f.revoke();await assert.rejects(f.proposals.apply(admin,pending.data.proposal.id,new AbortController().signal),/revoked/);assert.equal(f.capabilities.getRule(admin,f.rule.id).threshold,"1");
 }finally{await f.close();}
});

test("internal propose_alert_change uses dispatcher without changing native approval",async()=>{
 const f=await fixture();try{
  const tool=f.dispatcher.assistantTools().find(t=>t.name==="propose_alert_change")!;assert.equal(Object.hasOwn(tool.schema.properties,"idempotency_key"),false);
  const created=await tool.execute({operation:"rule.update",target_id:f.rule.id,patch:{threshold:"4"},reason:"internal"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(created.proposal.session_id,"session-one");assert.equal(f.capabilities.getRule(admin,f.rule.id).threshold,"1");
  await f.proposals.apply(admin,created.proposal.id,new AbortController().signal);assert.equal(f.capabilities.getRule(admin,f.rule.id).threshold,"4");
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_alerts_plan'"));
 }finally{await f.close();}
});

test("incident acknowledgement proposals preserve native state, safe previews and reviewed execution",async()=>{
 const f=await fixture();try{
  const input={operation:"incident.ack",target_id:"incident-one",reason:"take ownership",idempotency_key:"incident-one"};
  const created=await f.invoke("lightmoni_alerts_plan",input),proposal=created.data.proposal;
  assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.before.state,"firing");assert.equal(proposal.after.state,"acknowledged");assert.equal(alertsState(f),"firing");
  assert.ok(proposal.review_url.startsWith("https://moni.example.test/api/v1/assistant/alert-proposals/"));assert.equal(JSON.stringify(created).includes("private-evidence"),false);
  assert.equal((await f.invoke("lightmoni_alerts_plan",input)).data.proposal.id,proposal.id);await assert.rejects(f.invoke("lightmoni_alerts_plan",{...input,reason:"changed"}),/idempotency_conflict/);
  const applied=await f.proposals.apply(admin,proposal.id,new AbortController().signal);assert.equal(applied.status,"completed");assert.equal(alertsState(f),"acknowledged");assert.equal(f.alerts.response("incident-one").owner_id,"admin");assert.equal(JSON.stringify(applied).includes("private-evidence"),false);
  const read=await f.invoke("lightmoni_alert_incidents_get",{id:"incident-one"});assert.equal(read.data.incident.state,"acknowledged");
 }finally{await f.close();}
});
function alertsState(f:any){return f.alerts.response("incident-one").state;}

test("incident proposals require incident scope and live grant, and reject changed rule revisions",async()=>{
 const f=await fixture();try{
  const withoutIncidents={...structuredClone(f.principal),scopes:f.principal.scopes.filter(s=>s!=="alerts.incidents.read")};
  await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"x",idempotency_key:"scope"},withoutIncidents),/scope_required|capability_forbidden/);
  await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"incident.escalate",target_id:"incident-one",reason:"x",idempotency_key:"scope-escalate"},withoutIncidents),/scope_required|capability_forbidden/);
  await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"incident.renew",target_id:"incident-one",reason:"x",idempotency_key:"scope-renew"},withoutIncidents),/scope_required|capability_forbidden/);
  const ruleCompatible=await f.invoke("lightmoni_alerts_plan",{operation:"rule.update",target_id:f.rule.id,patch:{threshold:"2"},reason:"compatible",idempotency_key:"compatible"},withoutIncidents);assert.equal(ruleCompatible.data.proposal.status,"awaiting_approval");
  const hostScoped={...structuredClone(f.principal),host_ids:["one"]};await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"x",idempotency_key:"host"},hostScoped),/capability_forbidden/);
  const memberSession=f.access.sessionPrincipal(member,"assistant");await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"x",idempotency_key:"member"},memberSession),/capability_forbidden/);
  const narrowed=await f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"narrowed",idempotency_key:"narrowed"});f.shrinkIncidents();
  await assert.rejects(f.proposals.apply(admin,narrowed.data.proposal.id,new AbortController().signal),/capability_forbidden/);assert.equal(alertsState(f),"firing");
  const pending=await f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"pending",idempotency_key:"pending"});f.revoke();await assert.rejects(f.proposals.apply(admin,pending.data.proposal.id,new AbortController().signal),/revoked/);assert.equal(alertsState(f),"firing");
 }finally{await f.close();}
});

test("incident proposal rejects a changed rule before modifying the response",async()=>{
 const f=await fixture();try{
  const pending=(await f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"pending",idempotency_key:"pending"})).data.proposal;
  const current=f.capabilities.getRule(admin,f.rule.id),prepared=await f.capabilities.prepareRuleSave(admin,{...current,threshold:"9"},current.id);f.db.transaction(()=>f.capabilities.commitRuleSave(admin,prepared));assert.equal(f.capabilities.getRule(admin,f.rule.id).revision,current.revision+1);
  await assert.rejects(f.proposals.apply(admin,pending.id,new AbortController().signal),/revision_conflict|告警已恢复/);assert.notEqual(alertsState(f),"acknowledged");assert.equal(f.proposals.get(admin,pending.id).status,"awaiting_approval");
 }finally{await f.close();}
});

test("internal incident acknowledgement uses the same native proposal and apply path",async()=>{
 const f=await fixture();try{
  const tool=f.dispatcher.assistantTools().find(t=>t.name==="propose_alert_change")!;
  const created=await tool.execute({operation:"incident.ack",target_id:"incident-one",reason:"internal"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(created.proposal.session_id,"session-one");assert.equal(alertsState(f),"firing");await f.proposals.apply(admin,created.proposal.id,new AbortController().signal);assert.equal(alertsState(f),"acknowledged");
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_alerts_plan'"));
 }finally{await f.close();}
});

test("incident transfer proposals assign a valid group member only after native approval",async()=>{
 const f=await fixture();try{
  const input={operation:"incident.transfer",target_id:"incident-one",user_id:"member",reason:"transfer ownership",idempotency_key:"transfer-one"};
  const created=await f.invoke("lightmoni_alerts_plan",input),proposal=created.data.proposal;
  assert.equal(proposal.status,"awaiting_approval");assert.equal(proposal.after.state,"unclaimed");assert.equal(proposal.after.transfer_to.id,"member");assert.equal(alertsState(f),"firing");
  assert.equal((await f.invoke("lightmoni_alerts_plan",input)).data.proposal.id,proposal.id);await assert.rejects(f.invoke("lightmoni_alerts_plan",{...input,user_id:"admin"}),/idempotency_conflict/);
  const applied=await f.proposals.apply(admin,proposal.id,new AbortController().signal),response=f.alerts.response("incident-one");
  assert.equal(applied.status,"completed");assert.equal(applied.result.transfer_to.id,"member");assert.equal(response.state,"unclaimed");assert.equal(response.owner_id,"");assert.deepEqual(response.group.fallback,["member"]);assert.equal(response.stage,"fallback");
  assert.equal(JSON.stringify(applied).includes("private-evidence"),false);
  await assert.rejects(f.invoke("lightmoni_alerts_plan",{operation:"incident.transfer",target_id:"incident-one",user_id:"missing",reason:"invalid",idempotency_key:"invalid-member"}),/有效组成员/);
 }finally{await f.close();}
});

test("internal incident transfer uses the same proposal and native transfer path",async()=>{
 const f=await fixture();try{
  const created=await f.dispatcher.assistantTools().find(t=>t.name==="propose_alert_change")!.execute({operation:"incident.transfer",target_id:"incident-one",user_id:"member",reason:"internal transfer"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(created.proposal.session_id,"session-one");assert.equal(alertsState(f),"firing");await f.proposals.apply(admin,created.proposal.id,new AbortController().signal);
  assert.equal(alertsState(f),"unclaimed");assert.deepEqual(f.alerts.response("incident-one").group.fallback,["member"]);
 }finally{await f.close();}
});

test("incident escalation proposals preserve native stage and paging semantics",async()=>{
 const f=await fixture();try{
  const input={operation:"incident.escalate",target_id:"incident-one",reason:"escalate now",idempotency_key:"escalate-one"},created=await f.invoke("lightmoni_alerts_plan",input),proposal=created.data.proposal;
  assert.equal(proposal.before.stage,"primary");assert.equal(proposal.after.stage,"backup");assert.equal(proposal.after.state,"unclaimed");assert.equal(alertsState(f),"firing");
  assert.equal((await f.invoke("lightmoni_alerts_plan",input)).data.proposal.id,proposal.id);await assert.rejects(f.invoke("lightmoni_alerts_plan",{...input,reason:"changed"}),/idempotency_conflict/);
  const applied=await f.proposals.apply(admin,proposal.id,new AbortController().signal),response=f.alerts.response("incident-one");
  assert.equal(applied.result.stage,"backup");assert.equal(response.stage,"backup");assert.equal(response.state,"unclaimed");assert.equal(response.owner_id,"");assert.equal(response.generation,1);
  assert.equal(JSON.stringify(applied).includes("private-evidence"),false);
  f.db.run("UPDATE alert_responses SET state='resolved',body=json_set(body,'$.state','resolved') WHERE id='incident-one'");
  await assert.rejects(f.invoke("lightmoni_alerts_plan",{...input,idempotency_key:"escalate-ended"}),/恢复/);
 }finally{await f.close();}
});

test("internal incident escalation uses the same proposal and native commit path",async()=>{
 const f=await fixture();try{
  const created=await f.dispatcher.assistantTools().find(t=>t.name==="propose_alert_change")!.execute({operation:"incident.escalate",target_id:"incident-one",reason:"internal escalate"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(created.proposal.session_id,"session-one");assert.equal(alertsState(f),"firing");await f.proposals.apply(admin,created.proposal.id,new AbortController().signal);
  assert.equal(alertsState(f),"unclaimed");assert.equal(f.alerts.response("incident-one").stage,"backup");
 }finally{await f.close();}
});

test("incident renewal extends only the current owner's handling deadline",async()=>{
 const f=await fixture();try{
  const ack=(await f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"ack",idempotency_key:"ack-for-renew"})).data.proposal;await f.proposals.apply(admin,ack.id,new AbortController().signal);
  f.advance(60_000);const before=f.alerts.response("incident-one"),input={operation:"incident.renew",target_id:"incident-one",reason:"still working",idempotency_key:"renew-one"},created=await f.invoke("lightmoni_alerts_plan",input),proposal=created.data.proposal;
  assert.equal(proposal.after.renewal,"extend_handling_deadline");assert.equal(f.alerts.response("incident-one").handling_until,before.handling_until);
  assert.equal((await f.invoke("lightmoni_alerts_plan",input)).data.proposal.id,proposal.id);await assert.rejects(f.invoke("lightmoni_alerts_plan",{...input,reason:"changed"}),/idempotency_conflict/);
  const applied=await f.proposals.apply(admin,proposal.id,new AbortController().signal),response=f.alerts.response("incident-one");
  assert.equal(applied.result.renewal,"extend_handling_deadline");assert.ok(Date.parse(response.handling_until)>Date.parse(before.handling_until));assert.equal(response.generation,before.generation);assert.equal(response.state,"acknowledged");
  assert.throws(()=>f.alerts.renew("incident-one",member),/只有当前接手人/);
  assert.equal(JSON.stringify(applied).includes("private-evidence"),false);
 }finally{await f.close();}
});

test("internal incident renewal uses the same proposal and native commit path",async()=>{
 const f=await fixture();try{
  const ack=(await f.invoke("lightmoni_alerts_plan",{operation:"incident.ack",target_id:"incident-one",reason:"ack",idempotency_key:"ack-for-internal-renew"})).data.proposal;await f.proposals.apply(admin,ack.id,new AbortController().signal);
  f.advance(60_000);const before=f.alerts.response("incident-one").handling_until,created=await f.dispatcher.assistantTools().find(t=>t.name==="propose_alert_change")!.execute({operation:"incident.renew",target_id:"incident-one",reason:"internal renew"},new AbortController().signal,admin,{session_id:"session-one"});
  assert.equal(created.proposal.session_id,"session-one");await f.proposals.apply(admin,created.proposal.id,new AbortController().signal);
  assert.ok(Date.parse(f.alerts.response("incident-one").handling_until)>Date.parse(before));assert.equal(f.alerts.response("incident-one").generation,1);
 }finally{await f.close();}
});
