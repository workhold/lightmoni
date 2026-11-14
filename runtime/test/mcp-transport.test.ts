import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { McpAccess, registerMcpAccess } from "../src/mcp/access.js";
import { registerMcpTransport } from "../src/mcp/transport.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import type { CapabilityDispatcherContract } from "../src/capabilities/types.js";
import { cipher } from "../src/shared/crypto.js";
import { taskHelperFixture } from "./helpers/task-helper.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities } from "../src/domains/alert-capabilities.js";
import { AlertProposalService } from "../src/assistant/alert-proposals.js";
import { registerAssistant } from "../src/assistant/index.js";
import { Logs } from "../src/domains/logs.js";
import { LogReadService } from "../src/domains/log-read.js";
import { TraceReadService } from "../src/domains/trace-read.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import { registerOperations } from "../src/server/operations.js";
import { registerOperationSchedules } from "../src/server/operation-schedules.js";
import { websiteDefinition } from "../src/operations/websites.js";
import { Dashboards, normalizeDashboard } from "../src/domains/dashboards.js";
import { DashboardReadService } from "../src/domains/dashboard-read.js";
import { ExecutionGrantRegistry } from "../src/capabilities/execution-grants.js";
import { InstrumentationService } from "../src/assistant/instrumentation.js";
import { Store as UsageStore } from "../src/assistant/usage.js";
import { registerAssistant } from "../src/assistant/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function fixture(wrap?:(d:CapabilityDispatcher)=>CapabilityDispatcherContract){
 const db=new DB(":memory:"),router=new Router(),user={id:"admin",name:"Admin",role:"admin"};accountSchema(db);
 db.run("INSERT INTO users(id,name,role,active,created_at) VALUES(?,?,?,1,?)",user.id,user.name,user.role,new Date().toISOString());
 const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));
 server.listen(0,"127.0.0.1");await once(server,"listening");const externalURL="http://127.0.0.1:"+(server.address() as any).port;
 const auth={user:()=>user,requireAdmin(){}};
 const deps={db,router,auth,externalURL,now:()=>new Date(),...cipher(Buffer.alloc(32,6)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
 router.auth=auth as any;router.externalURL=externalURL;const runs=new TaskRunStore(deps);
 for(const id of ["one","two"])db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)",id,"Host "+id,id+".example.test","agent-"+id,new Date().toISOString(),new Date().toISOString());
 taskHelperFixture(deps,runs);
 const access=new McpAccess(deps);registerMcpAccess(deps,access);const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs});
 const module=registerMcpTransport(deps,access,wrap?wrap(dispatcher):dispatcher),endpoint=externalURL+"/api/v1/mcp";
 const key=access.createToken(user,{name:"Test client",scopes:["hosts.read","tasks.read","tasks.propose","executions.read"],host_ids:null});
 const headers={authorization:"Bearer "+key.token,accept:"application/json, text/event-stream","content-type":"application/json","mcp-protocol-version":"2025-11-25"};
 const rpc=(body:unknown,extra:Record<string,string>={})=>fetch(endpoint,{method:"POST",headers:{...headers,...extra},body:typeof body==="string"?body:JSON.stringify(body)});
 const task=()=>runs.nodes.task({name:"Reviewed script",type:"script",enabled:true,target_all:false,host_ids:["one"],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('hidden-source')",timeout_seconds:5,max_output_bytes:4096}},"script-one",true);
 return {db,deps,user,runs,access,dispatcher,endpoint,externalURL,rpc,headers,key,task,async close(){await module.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}};
}
const call=(name:string,args:any={})=>({jsonrpc:"2.0",id:8,method:"tools/call",params:{name,arguments:args}});
const intent={operation:"task.dispatch",task_id:"script-one",host_ids:["one"],reason:"User requested dispatch",idempotency_key:"request-one"};
test("official SDK client discovers tools, creates an idempotent proposal and polls actual runs",async()=>{
 const f=await fixture(),client=new Client({name:"integration-test",version:"1"});try{
  const transport=new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:f.headers.authorization}}});await client.connect(transport);
  assert.equal(transport.sessionId,undefined);assert.equal(client.getServerVersion()?.name,"lightmoni");
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==="lightmoni_tasks_plan"));assert.ok(!tools.tools.some(t=>/apply|exec_ssh/.test(t.name)));
  const hostTool=tools.tools.find(t=>t.name==="lightmoni_hosts_list")!,planTool=tools.tools.find(t=>t.name==="lightmoni_tasks_plan")!;
  assert.ok(hostTool.outputSchema?.anyOf);assert.equal(hostTool.annotations?.readOnlyHint,true);assert.equal(hostTool.annotations?.openWorldHint,false);
  assert.equal(planTool.annotations?.readOnlyHint,false);assert.equal(planTool.annotations?.idempotentHint,true);assert.equal(planTool.annotations?.destructiveHint,false);
  const host=await client.callTool({name:"lightmoni_hosts_list",arguments:{}});assert.ok(!host.isError,JSON.stringify(host));assert.deepEqual((host.structuredContent as any).data.hosts.map((h:any)=>h.id),["one","two"]);
  f.task();const p=await client.callTool({name:"lightmoni_tasks_plan",arguments:intent});assert.ok(!p.isError,JSON.stringify(p));const proposal=(p.structuredContent as any).data.proposal;
  assert.ok(proposal.review_url.startsWith(f.externalURL));assert.equal(f.runs.list().length,0);
  const repeat=await client.callTool({name:"lightmoni_tasks_plan",arguments:intent});assert.equal((repeat.structuredContent as any).data.proposal.id,proposal.id);
  const applied=f.dispatcher.proposals.apply(f.user,proposal.id),run=(applied.result as any).runs[0];assert.equal(run.state,"queued");
  const state=await client.callTool({name:"lightmoni_executions_get",arguments:{id:run.id}});assert.equal((state.structuredContent as any).data.execution.native_state,"queued");
  assert.ok(!JSON.stringify(state).includes("hidden-source"));assert.ok(!JSON.stringify(state).includes("lease_token"));
  const bad=await client.callTool({name:"lightmoni_tasks_plan",arguments:{...intent,reason:"changed"}});assert.equal(bad.isError,true);assert.equal((bad.structuredContent as any).error.code,"conflict");assert.equal((bad.structuredContent as any).error.detail_code,"idempotency_conflict");
  assert.ok(f.db.get<any>("SELECT count(*) n FROM capability_invocations WHERE decision='idempotency_hit'")!.n>=1);
  const readKey=f.access.createToken(f.user,{name:"Read client",scopes:["hosts.read"],host_ids:["one"]}),readClient=new Client({name:"read-only",version:"1"});
  try{await readClient.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+readKey.token}}}));
   assert.deepEqual((await readClient.listTools()).tools.map(t=>t.name),["lightmoni_hosts_list","lightmoni_hosts_get"]);
   assert.equal((await readClient.callTool({name:"lightmoni_executions_get",arguments:{id:run.id}})).isError,true);
  }finally{await readClient.close();}
 }finally{await client.close();await f.close();}
});
test("official SDK client creates and updates task definitions only through reviewed proposals",async()=>{
 const f=await fixture(),client=new Client({name:"task-proposal",version:"1"});try{
  f.task();await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:f.headers.authorization}}}));
  const task={name:"External reviewed script",type:"script",enabled:true,target_all:false,host_ids:["one"],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('reviewed')",timeout_seconds:5,max_output_bytes:4096}};
  const created=await client.callTool({name:"lightmoni_tasks_plan",arguments:{operation:"task.create",task,reason:"create",idempotency_key:"create-one"}}),proposal=(created.structuredContent as any).data.proposal;
  assert.equal(proposal.status,"awaiting_approval");assert.throws(()=>f.runs.nodes.getTask(proposal.task_id));assert.equal(f.runs.list().length,0);
  f.dispatcher.proposals.apply(f.user,proposal.id);assert.equal(f.runs.nodes.getTask(proposal.task_id).name,task.name);
  const updated=await client.callTool({name:"lightmoni_tasks_plan",arguments:{operation:"task.update",task_id:proposal.task_id,task:{name:"External updated"},reason:"rename",idempotency_key:"update-one"}});
  f.dispatcher.proposals.apply(f.user,(updated.structuredContent as any).data.proposal.id);assert.equal(f.runs.nodes.getTask(proposal.task_id).name,"External updated");assert.equal(f.runs.list().length,0);
  const readback=await client.callTool({name:"lightmoni_proposals_get",arguments:{id:proposal.id}});assert.equal((readback.structuredContent as any).data.proposal.status,"completed");
 }finally{await client.close();await f.close();}
});
test("official SDK client follows bounded tools/list cursors without dropping tools",async()=>{
 const f=await fixture(),client=new Client({name:"pagination-test",version:"1"});try{
  const template=f.dispatcher.definitions.find(d=>d.name==="lightmoni_hosts_get")!;
  for(let i=0;i<55;i++)f.dispatcher.definitions.push({...template,id:`hosts.get.${i}`,name:`lightmoni_hosts_get_${i}`});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:f.headers.authorization}}}));
  const principal=f.access.authenticate({headers:{authorization:f.headers.authorization}} as any),expected=f.dispatcher.list(principal).length;
  const names:string[]=[];let cursor:string|undefined,pages=0;
  do{const page=await client.listTools(cursor?{cursor}:undefined);pages++;names.push(...page.tools.map(t=>t.name));cursor=page.nextCursor;}while(cursor);
  assert.equal(pages,2);assert.equal(names.length,expected);assert.equal(new Set(names).size,expected);
 }finally{await client.close();await f.close();}
});
test("telemetry capabilities use installation scopes through the official MCP client",async()=>{
 const f=await fixture();try{
  f.deps.cat.list=async()=>[{id:"table-one",name:"log_app",logical_name:"log_app",kind:"log",columns:[{name:"body",type:"String"}],services:["orders"],system:false,retention_days:7,effective_retention_days:7}];
  const sources:string[]=[];f.deps.query=async request=>{sources.push(request.source??"");return{request_id:"telemetry",results:[{refId:"A",status:"success",complete:true,truncated:false,elapsed_ms:1,frames:[{columns:[{name:"body",type:"String"}],rows:[["ok"]]}]}]};};
  const key=f.access.createToken(f.user,{name:"Telemetry",scopes:["telemetry.catalog.read","telemetry.query"],host_ids:null}),client=new Client({name:"telemetry-test",version:"1"});
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
   const tools=await client.listTools();for(const name of ["lightmoni_telemetry_catalog","lightmoni_telemetry_describe","lightmoni_telemetry_query"])assert.ok(tools.tools.some(t=>t.name===name),name);
   const described=await client.callTool({name:"lightmoni_telemetry_describe",arguments:{table:"table-one"}});assert.equal((described.structuredContent as any).data.table.name,"log_app");
   const result=await client.callTool({name:"lightmoni_telemetry_query",arguments:{sql:"SELECT body FROM log_app",range:{from:"2026-11-13T00:00:00Z",to:"2026-11-14T00:00:00Z"},interval_ms:1000}});
   assert.equal((result.structuredContent as any).data.query.results[0].frames[0].rows[0][0],"ok");assert.deepEqual(sources,["mcp"]);
  }finally{await client.close();}
  const scoped=f.access.createToken(f.user,{name:"Host scoped telemetry",scopes:["telemetry.catalog.read","telemetry.query"],host_ids:["one"]}),limited=new Client({name:"limited-telemetry",version:"1"});
  try{
   await limited.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+scoped.token}}}));
   assert.equal((await limited.listTools()).tools.some(t=>t.id?.startsWith?.("telemetry.")||t.name.startsWith("lightmoni_telemetry_")),false);
   const denied=await limited.callTool({name:"lightmoni_telemetry_catalog",arguments:{}});assert.equal(denied.isError,true);assert.equal((denied.structuredContent as any).error.detail_code,"capability_forbidden");
  }finally{await limited.close();}
 }finally{await f.close();}
});
test("alert read capabilities separate SQL details and proposals through the official MCP client",async()=>{
 let alerts!:Alerts,caps!:AlertCapabilities,proposals!:AlertProposalService,assistant:any;
 const f=await fixture(d=>{
  d.deps.cat.list=async()=>[{id:"log_app",name:"log_app",logical_name:"app",kind:"log",columns:[],services:["api"],system:false,retention_days:null,effective_retention_days:7}];
  d.deps.referencedTables=async()=>["log_app"];
  alerts=new Alerts(d.deps);caps=new AlertCapabilities(alerts);proposals=new AlertProposalService(d.deps.db,caps,d.deps.now,d.deps.encrypt,d.deps.decrypt);
  const dispatcher=new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,alerts:caps,alertProposals:proposals});assistant=registerAssistant(d.deps,{capabilities:dispatcher,alerts:caps,alertProposals:proposals,runtime:async()=>{}});return dispatcher;
 });
 let client:Client|undefined,ordinaryClient:Client|undefined;
 try{
  f.db.run("INSERT INTO alert_groups VALUES('group-one','Ops',?)",JSON.stringify({id:"group-one",name:"Ops",enabled:true,members:["admin"],policies:{},targets:[]}));
  const prepared=await caps.prepareRuleSave(f.user,{name:"API errors",enabled:true,kind:"sql",severity:"P2",sql:"SELECT count() AS value FROM log_app",value_field:"value",source_table_ids:["log_app"],group_ids:["group-one"],threshold:"1",operator:"gt",interval_seconds:10,window_seconds:60,evidence_profile:{}});
  const rule=f.db.transaction(()=>caps.commitRuleSave(f.user,prepared));
  const proposal=await proposals.create(f.user,"session-one",{operation:"rule.update",target_id:rule.id,patch:{threshold:"2"},reason:"review"},new AbortController().signal);
  const at=new Date().toISOString();f.db.run("INSERT INTO alert_responses(id,episode,group_id,state,created_at,body) VALUES('incident-one','episode-one','group-one','firing',?,?)",at,JSON.stringify({id:"incident-one",episode:"episode-one",group_id:"group-one",group_name:"Ops",rule_id:rule.id,original_priority:"P1",event:{rule_name:"API errors"},state:"firing",priority:"P1",generation:0,stage:"primary",created_at:at,group:{id:"group-one",name:"Ops",members:["admin"],policies:{},targets:[]},evidence:{logs:"private-evidence"}}));
  f.db.run("INSERT INTO alert_assignments(response_id,user_id,user_name,stage,priority,notified_at,ack_at,ack_method,outcome) VALUES('incident-one','admin','Admin','primary','P1',?,?,'web','acknowledged')",at,at);
  f.db.run("INSERT INTO alert_response_events(id,response_id,at,body) VALUES('response-event-one','incident-one',?,?)",at,JSON.stringify({state:"firing"}));
  f.db.run("INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES('delivery-one','event-one','channel-one','private-contact','failed','',?,?)",at,JSON.stringify({id:"delivery-one",response_id:"incident-one",rule_id:rule.id,status:"failed",attempts:1,error:"private-error"}));
  const key=f.access.createToken(f.user,{name:"Alert read",scopes:["alerts.read","alerts.detail.read","alerts.incidents.read","alerts.notifications.read","alerts.statistics.read","alerts.propose"],host_ids:null});client=new Client({name:"alert-read",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_alert_rules_list","lightmoni_alert_rules_get","lightmoni_alert_silences_list","lightmoni_alert_silences_get","lightmoni_alert_groups_list","lightmoni_alert_proposals_get","lightmoni_alert_incidents_list","lightmoni_alert_incidents_get","lightmoni_alert_deliveries_list","lightmoni_alert_response_statistics_get","lightmoni_alerts_plan"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/apply|approve|propose/.test(t.name)),false);
  const listed=await client.callTool({name:"lightmoni_alert_rules_list",arguments:{search:"API"}});assert.equal(Object.hasOwn((listed.structuredContent as any).data.items[0],"sql"),false);
  const detail=await client.callTool({name:"lightmoni_alert_rules_get",arguments:{id:rule.id}});assert.match((detail.structuredContent as any).data.rule.sql,/log_app/);
  const readback=await client.callTool({name:"lightmoni_alert_proposals_get",arguments:{id:proposal.id}});assert.equal((readback.structuredContent as any).data.proposal.status,"awaiting_approval");
  const incidents=await client.callTool({name:"lightmoni_alert_incidents_list",arguments:{state:"firing"}});assert.equal((incidents.structuredContent as any).data.items[0].id,"incident-one");
  const incident=await client.callTool({name:"lightmoni_alert_incidents_get",arguments:{id:"incident-one"}});assert.equal((incident.structuredContent as any).data.timeline.length,1);
  const deliveries=await client.callTool({name:"lightmoni_alert_deliveries_list",arguments:{status:"failed"}});assert.equal((deliveries.structuredContent as any).data.items[0].id,"delivery-one");assert.equal(JSON.stringify(deliveries).includes("private-contact"),false);assert.equal(JSON.stringify(deliveries).includes("private-error"),false);
  const statistics=await client.callTool({name:"lightmoni_alert_response_statistics_get",arguments:{group_id:"group-one"}});assert.equal((statistics.structuredContent as any).data.users[0].ack_rate,100);
  const acknowledged=await client.callTool({name:"lightmoni_alerts_plan",arguments:{operation:"incident.ack",target_id:"incident-one",reason:"take ownership",idempotency_key:"incident-plan-one"}});assert.ok(!acknowledged.isError,JSON.stringify(acknowledged));
  const ackData=(acknowledged.structuredContent as any).data;assert.equal(ackData.proposal.status,"awaiting_approval");assert.equal(ackData.proposal.before.state,"firing");assert.ok(ackData.proposal.review_url.includes("/api/v1/assistant/alert-proposals/"));assert.equal(JSON.stringify(ackData).includes("private-evidence"),false);
  const ackApplied=await fetch(f.externalURL+`/api/v1/assistant/alert-proposals/${ackData.proposal.id}/apply`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert.equal(ackApplied.status,200,await ackApplied.text());
  const ackRead=await client.callTool({name:"lightmoni_alert_incidents_get",arguments:{id:"incident-one"}});assert.equal((ackRead.structuredContent as any).data.incident.state,"acknowledged");assert.equal((ackRead.structuredContent as any).data.incident.owner_id,"admin");
  const changed=await client.callTool({name:"lightmoni_alerts_plan",arguments:{operation:"rule.update",target_id:rule.id,patch:{threshold:"2"},reason:"external review",idempotency_key:"alert-rule-one"}}),changedProposal=(changed.structuredContent as any).data.proposal;
  assert.equal(changedProposal.status,"awaiting_approval");assert.equal(changedProposal.session_id,"");assert.equal(caps.getRule(f.user,rule.id).threshold,"1");
  await proposals.apply(f.user,changedProposal.id,new AbortController().signal);assert.equal(caps.getRule(f.user,rule.id).threshold,"2");
  const completed=await client.callTool({name:"lightmoni_alert_proposals_get",arguments:{id:changedProposal.id}});assert.equal((completed.structuredContent as any).data.proposal.status,"completed");
  const ordinaryKey=f.access.createToken(f.user,{name:"Alert catalog",scopes:["alerts.read"],host_ids:null});ordinaryClient=new Client({name:"alert-catalog",version:"1"});
  await ordinaryClient.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+ordinaryKey.token}}}));
  assert.equal((await ordinaryClient.listTools()).tools.some(t=>t.name==="lightmoni_alert_rules_get"),false);
  const denied=await ordinaryClient.callTool({name:"lightmoni_alert_rules_get",arguments:{id:rule.id}});assert.equal(denied.isError,true);assert.equal((denied.structuredContent as any).error.detail_code,"capability_forbidden");
 }finally{await client?.close();await ordinaryClient?.close();await assistant.close?.();await alerts.close();await f.close();}
});
test("log and trace capabilities share frozen reads through the official MCP client",async()=>{
 let logs!:Logs;
 const f=await fixture(d=>{
  d.deps.cat.list=async()=>[
   {id:"log_app",name:"log_app",logical_name:"app",kind:"log",columns:["event_id","event_time","service","body","severity"].map(name=>({name,type:"String"})),services:["api"],system:false,retention_days:null,effective_retention_days:7},
   {id:"trace_app",name:"trace_app",logical_name:"trace",kind:"trace",columns:["event_id","event_time","service","trace_id","span_id","parent_span_id","name","start_time","end_time","duration_ns","status"].map(name=>({name,type:"String"})),services:["api"],system:false,retention_days:null,effective_retention_days:7}];
  d.deps.query=async request=>request.source==="logs"?{request_id:"logs",results:request.queries.map(q=>({refId:q.refId,status:"success",complete:true,truncated:false,elapsed_ms:1,frames:[q.refId==="rows"?{columns:["event_id","event_time","service","body"].map(name=>({name,type:"String"})),rows:[["e0","2026-11-13T00:00:00Z","api","zero"],["e1","2026-11-13T00:00:01Z","api","one"]]}:{columns:[{name:"time",type:"String"}],rows:[]}]}))}:{request_id:"trace",results:[{refId:"trace",status:"success",complete:true,truncated:false,elapsed_ms:1,frames:[{columns:["span_id","parent_span_id","service","trace_id","name","start_time","end_time"].map(name=>({name,type:"String"})),rows:[["root","","api","trace-one","root","2026-11-13T00:00:00Z","2026-11-13T00:00:01Z"]]}]}]};
  logs=new Logs(d.deps);return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,logs:new LogReadService(logs),traces:new TraceReadService(d.deps)});
 });
 const client=new Client({name:"log-trace-read",version:"1"});
 try{
  const key=f.access.createToken(f.user,{name:"Log Trace",scopes:["logs.read","traces.read"],host_ids:null});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==="lightmoni_logs_search"));assert.ok(tools.tools.some(t=>t.name==="lightmoni_traces_get"));
  const range={from:"2026-11-13T00:00:00Z",to:"2026-11-14T00:00:00Z"},spec={table_id:"log_app",range,services:["api"]};
  const first=await client.callTool({name:"lightmoni_logs_search",arguments:{spec,limit:1}}),data=(first.structuredContent as any).data;assert.equal(data.frame.rows[0][0],"e0");assert.equal(data.next_cursor,"1");
  const second=await client.callTool({name:"lightmoni_logs_search",arguments:{session_id:data.session_id,cursor:"1",limit:1}});assert.equal((second.structuredContent as any).data.frame.rows[0][0],"e1");
  const trace=await client.callTool({name:"lightmoni_traces_get",arguments:{trace_id:"trace-one",tables:["trace_app"],...range}});assert.equal((trace.structuredContent as any).data.spans.length,1);assert.equal((trace.structuredContent as any).data.incomplete,false);
 }finally{await client.close();logs.close();await f.close();}
});
test("deployment capabilities expose native service and receipt views through the official MCP client",async()=>{
 const f=await fixture(d=>{const grants=new ExecutionGrantRegistry(d.deps),store=registerServiceDeployments(d.deps,{executionGrants:grants});return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,deployments:store,executionGrants:grants});});
 const client=new Client({name:"deployment-read",version:"1"});
 try{
  const at=new Date().toISOString(),serviceID="a".repeat(32);
  f.db.run("INSERT INTO services(id,name,description,repository_url,created_at,updated_at,created_by) VALUES(?,'Checkout','Checkout API','',?,?,'admin')",serviceID,at,at);
  f.db.run("INSERT INTO service_targets(id,service_id,machine_id,adapter,config_json,desired_release_id,status,created_at,updated_at) VALUES('target-one',?,'one','systemd','{}','release-one','ready',?,?)",serviceID,at,at);
  f.db.run("INSERT INTO releases(id,service_id,version,source_type,source_ref,artifact_digest,artifact_size,manifest_json,status,created_at,created_by) VALUES('release-one',?,'2026.11.14','artifact','sha256:abc','sha256:abc',128,'{}','ready',?,'admin')",serviceID,at);
  f.db.run("INSERT INTO deployments(id,service_id,target_id,release_id,adapter,status,plan_json,target_snapshot_json,receipt_json,phase,operation_id,created_at,created_by) VALUES('deployment-one',?,'target-one','release-one','systemd','awaiting_approval','{}','{}','{}','awaiting_approval','operation-one',?,'admin')",serviceID,at);
  f.db.run("INSERT INTO deployment_events(id,deployment_id,phase,state,summary,actor,created_at) VALUES('event-one','deployment-one','awaiting_approval','awaiting_approval','计划已生成','admin',?)",at);
  const key=f.access.createToken(f.user,{name:"Deployments",scopes:["deployments.read","deployments.propose"],host_ids:null});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_services_list","lightmoni_services_get","lightmoni_deployments_list","lightmoni_deployments_get","lightmoni_deployments_events","lightmoni_deployments_plan"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/approve|rollback|upload/.test(t.name)),false);
  const detail=await client.callTool({name:"lightmoni_services_get",arguments:{service_id:serviceID}});assert.equal((detail.structuredContent as any).data.targets[0].id,"target-one");assert.equal((detail.structuredContent as any).data.releases[0].id,"release-one");
  const deployment=await client.callTool({name:"lightmoni_deployments_get",arguments:{deployment_id:"deployment-one"}});assert.equal((deployment.structuredContent as any).data.deployment.status,"awaiting_approval");
  const events=await client.callTool({name:"lightmoni_deployments_events",arguments:{deployment_id:"deployment-one"}});assert.equal((events.structuredContent as any).data.events[0].id,"event-one");
  const planned=await client.callTool({name:"lightmoni_deployments_plan",arguments:{service_id:serviceID,target_id:"target-one",release_id:"release-one",reason:"external review",idempotency_key:"deployment-plan-one"}}),plannedData=(planned.structuredContent as any).data;
  assert.equal(plannedData.proposal.status,"awaiting_approval");assert.equal(plannedData.proposal.native_status,"awaiting_approval");assert.ok(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='deployment' AND native_id=?",plannedData.proposal.id));
 }finally{await client.close();await f.close();}
});
test("operation capabilities expose resources, runs and schedules through the official MCP client",async()=>{
 let operations:any,schedules:any,jobs:any,grants:any;
 const f=await fixture(d=>{
  jobs=registerAgentJobs(d.deps,{agentCredentials:{has:()=>true} as any});grants=new ExecutionGrantRegistry(d.deps);
  operations=registerOperations(d.deps,{definitions:[websiteDefinition],credentials:{has:()=>true} as any,jobs,executionGrants:grants});schedules=registerOperationSchedules(d.deps,operations);
  return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,operations,operationSchedules:schedules,executionGrants:grants});
 });
 const client=new Client({name:"operation-read",version:"1"});
 try{
  const config=websiteDefinition.validate({domains:["example.test"],mode:"static",static_files:{"index.html":"private-body"}}),at=new Date().toISOString();
  f.db.run("INSERT INTO ops_resources(id,kind,name,agent_id,revision,config_cipher,created_at,updated_at,created_by) VALUES('site-one','website','Site','agent-one',1,?,?,?,'admin')",f.deps.encrypt(JSON.stringify(config)),at,at);
  const run=operations.plan("site-one","inspect",{},f.user.id),schedule=schedules.create({name:"Hourly",resource_id:"site-one",resource_revision:1,operation:"inspect",input:{},cron:"0 * * * *",timezone:"UTC",enabled:false},f.user.id);
  const key=f.access.createToken(f.user,{name:"Operations",scopes:["operations.read","operations.propose"],host_ids:null});await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_operations_resources_list","lightmoni_operations_resources_get","lightmoni_operations_runs_list","lightmoni_operations_runs_get","lightmoni_operations_schedules_list","lightmoni_operations_schedules_get","lightmoni_operations_plan"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/approve|delete|execute|trigger/.test(t.name)),false);
  const resources=await client.callTool({name:"lightmoni_operations_resources_list",arguments:{kind:"website"}});assert.equal(JSON.stringify(resources).includes("private-body"),false);
  const runRead=await client.callTool({name:"lightmoni_operations_runs_get",arguments:{id:run.id}});assert.equal((runRead.structuredContent as any).data.run.state,"awaiting_approval");
  const scheduleRead=await client.callTool({name:"lightmoni_operations_schedules_get",arguments:{id:schedule.id}});assert.equal((scheduleRead.structuredContent as any).data.schedule.operation,"inspect");
  const planned=await client.callTool({name:"lightmoni_operations_plan",arguments:{resource_id:"site-one",operation:"inspect",input:{},reason:"external review",idempotency_key:"operation-plan-one"}});assert.ok(!planned.isError,JSON.stringify(planned));
  const plannedData=(planned.structuredContent as any).data;assert.equal(plannedData.proposal.status,"awaiting_approval");assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")!.n,0);
  assert.ok(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='operation' AND native_id=?",plannedData.proposal.id));
  operations.approve(plannedData.proposal.id,f.user.id,1);
  const approved=await client.callTool({name:"lightmoni_operations_runs_get",arguments:{id:plannedData.proposal.id}});assert.equal((approved.structuredContent as any).data.run.state,"queued");
 }finally{await client.close();await schedules.close?.();await operations.close?.();await jobs.close?.();await f.close();}
});
test("host and Agent capabilities expose safe inventory and lifecycle receipts through the official MCP client",async()=>{
 const f=await fixture(d=>{
  let current={id:"install-one",machine_id:"one",status:"unknown",receipt:{stages:[]}};
  const machines={assistantList:()=>[{id:"one",name:"Host one",host_key_fingerprint:""}],assistantGet:(id:string)=>({id,name:"Host "+id,host_key_fingerprint:"",ssh_credentials:[]}),
   assistantDeployment:(id:string)=>(id===current.id?current:undefined),assistantPlan:(machine_id:string,input:any,actor:string)=>{
    current={id:"install-one",machine_id,status:"awaiting_approval",version:input.version,arch:input.arch,plan:{check_id:input.check_id,runtime_mode:input.runtime_mode??"root"},receipt:{stages:[]},created_by:actor,review_url:`/machines?machine=${machine_id}&deployment=install-one`};return current;
   },agentUpdates:{listReleases:()=>[{version:"1.2.3",sha256:"a".repeat(64)}],assistantGet:(machine_id:string,id:string)=>({id,machine_id,status:"rolled_back"})}} as any;
  const grants=new ExecutionGrantRegistry(d.deps);return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,machines,executionGrants:grants});
 });
 const client=new Client({name:"host-agent-read",version:"1"});
 try{
  const key=f.access.createToken(f.user,{name:"Host Agent",scopes:["hosts.read","agents.read","agents.maintain.propose"],host_ids:null});await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_hosts_inventory","lightmoni_hosts_details_get","lightmoni_agent_releases_list","lightmoni_agent_installations_get","lightmoni_agent_updates_get","lightmoni_agent_installations_plan"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/approve|apply|execute/.test(t.name)),false);
  const inventory=await client.callTool({name:"lightmoni_hosts_inventory",arguments:{}});assert.equal((inventory.structuredContent as any).data.machines[0].id,"one");
  const installation=await client.callTool({name:"lightmoni_agent_installations_get",arguments:{deployment_id:"install-one"}});assert.equal((installation.structuredContent as any).data.installation.status,"unknown");
  const update=await client.callTool({name:"lightmoni_agent_updates_get",arguments:{machine_id:"one",update_id:"update-one"}});assert.equal((update.structuredContent as any).data.update.status,"rolled_back");
  const planned=await client.callTool({name:"lightmoni_agent_installations_plan",arguments:{machine_id:"one",check_id:"check-one",version:"1.2.3",arch:"amd64",reason:"external review",idempotency_key:"agent-install-plan-one"}});assert.ok(!planned.isError,JSON.stringify(planned));
  const plannedData=(planned.structuredContent as any).data;assert.equal(plannedData.proposal.status,"awaiting_approval");assert.ok(plannedData.proposal.review_url.includes("/machines?"));
  assert.ok(f.db.get("SELECT 1 FROM capability_execution_grants WHERE domain='agent_installation' AND native_id='install-one'"));
  const queued=await client.callTool({name:"lightmoni_agent_installations_get",arguments:{deployment_id:"install-one"}});assert.equal((queued.structuredContent as any).data.installation.status,"awaiting_approval");
 }finally{await client.close();await f.close();}
});
test("dashboard capabilities expose real catalog, details and versions through the official MCP client",async()=>{
 let dashboards!:Dashboards;
 const f=await fixture(d=>{dashboards=new Dashboards(d.deps);return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,dashboards:new DashboardReadService(dashboards)});});
 const client=new Client({name:"dashboard-read",version:"1"}),ordinaryClient=new Client({name:"dashboard-catalog",version:"1"});
 try{
  const custom=dashboards.insert(normalizeDashboard({title:"Business",description:"Custom dashboard",panels:[],variables:[]}));
  const key=f.access.createToken(f.user,{name:"Dashboards",scopes:["dashboards.read","dashboards.detail.read"],host_ids:null});await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_dashboards_list","lightmoni_dashboards_get","lightmoni_dashboards_versions"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/save|copy|delete|draft/.test(t.name)),false);
  const listed=await client.callTool({name:"lightmoni_dashboards_list",arguments:{scope:"custom"}});assert.equal((listed.structuredContent as any).data.items[0].id,custom.id);
  const detail=await client.callTool({name:"lightmoni_dashboards_get",arguments:{id:custom.id}});assert.equal((detail.structuredContent as any).data.dashboard.description,"Custom dashboard");
  const versions=await client.callTool({name:"lightmoni_dashboards_versions",arguments:{id:custom.id}});assert.equal((versions.structuredContent as any).data.versions[0].revision,1);
  const ordinaryKey=f.access.createToken(f.user,{name:"Dashboard catalog",scopes:["dashboards.read"],host_ids:null});await ordinaryClient.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+ordinaryKey.token}}}));
  const denied=await ordinaryClient.callTool({name:"lightmoni_dashboards_get",arguments:{id:custom.id}});assert.equal(denied.isError,true);assert.equal((denied.structuredContent as any).error.detail_code,"capability_forbidden");
 }finally{await client.close();await ordinaryClient.close();await f.close();}
});
test("official MCP client creates an instrumentation proposal for native human apply and real workspace verification",async()=>{
 let instrumentation!:InstrumentationService,assistant:any;
 const root=mkdtempSync(join(tmpdir(),"lm-mcp-instrumentation-"));mkdirSync(join(root,"src"));writeFileSync(join(root,"package.json"),JSON.stringify({dependencies:{"@lightmoni/sdk":"0.3.0",express:"5.0.0"}}));
 writeFileSync(join(root,"src","server.ts"),["import express from 'express';","import { createLightMoni } from '@lightmoni/sdk';","const app = express();","const mon = createLightMoni({ service: 'checkout', env: 'prod' });","app.get('/health', async (req, res) => {","  res.send('ok');","});",""].join("\n"));
 const f=await fixture(d=>{
  const usage=new UsageStore(d.deps.db,d.deps.now),store={get:<T>(key:string)=>{const saved=usage.get<string>(key);return saved?JSON.parse(d.deps.decrypt(saved)) as T:undefined},put:(key:string,value:unknown)=>usage.put(key,d.deps.encrypt(JSON.stringify(value)))};
  instrumentation=new InstrumentationService(root,{store,now:d.deps.now});const grants=new ExecutionGrantRegistry(d.deps),dispatcher=new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,instrumentation,executionGrants:grants});
  assistant=registerAssistant(d.deps,{capabilities:dispatcher,instrumentationService:instrumentation,runtime:async()=>{}});return dispatcher;
 });
 const client=new Client({name:"instrumentation-read",version:"1"});
 try{
  const key=f.access.createToken(f.user,{name:"Instrumentation",scopes:["code.workspace.read","code.workspace.detail.read","code.workspace.propose"],host_ids:null});await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_code_instrumentation_scan","lightmoni_code_instrumentation_get","lightmoni_code_instrumentation_plan"])assert.ok(tools.tools.some(t=>t.name===name),name);assert.equal(tools.tools.some(t=>/apply|code_task/.test(t.name)),false);
  const scan=await client.callTool({name:"lightmoni_code_instrumentation_scan",arguments:{workspace:"."}}),scanData=(scan.structuredContent as any).data;assert.equal(scanData.sdk.found,true);
  const planned=await client.callTool({name:"lightmoni_code_instrumentation_plan",arguments:{workspace:".",intent:"instrument requests",base_revision:scanData.base_revision,reason:"external review",idempotency_key:"instrumentation-plan-one"}});assert.ok(!planned.isError,JSON.stringify(planned));
  const plannedData=(planned.structuredContent as any).data;assert.equal(plannedData.proposal.status,"awaiting_approval");assert.equal(plannedData.plan.files[0].patch,undefined);assert.ok(plannedData.proposal.review_url.includes("/api/v1/instrumentation-plans/"));
  const applied=await fetch(f.externalURL+`/api/v1/instrumentation-plans/${plannedData.proposal.id}/apply`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({base_revision:scanData.base_revision,approval:"apply"})});assert.equal(applied.status,200,await applied.text());
  assert.match(readFileSync(join(root,"src","server.ts"),"utf8"),/mon\.record\("service", "requests_total"/);
  const read=await client.callTool({name:"lightmoni_code_instrumentation_get",arguments:{plan_id:plannedData.proposal.id}});assert.equal((read.structuredContent as any).data.applied.state,"applied");assert.equal(Object.hasOwn((read.structuredContent as any).data,"before"),false);
 }finally{await client.close();await assistant.close?.();await f.close();rmSync(root,{recursive:true,force:true});}
});
test("transport rejects wrong credentials, Origin, methods, versions, oversized and malformed messages",async()=>{
 const f=await fixture();try{
  const unauth=await fetch(f.endpoint,{headers:{cookie:"lm_session=browser-cookie"}});assert.equal(unauth.status,401);assert.match(unauth.headers.get("www-authenticate")!,/oauth-protected-resource/);
  for(const method of ["GET","DELETE","PUT","PATCH"]){const r=await fetch(f.endpoint,{method,headers:{authorization:f.headers.authorization}});assert.equal(r.status,405);assert.equal(r.headers.get("allow"),"POST");}
  assert.equal((await f.rpc(call("lightmoni_hosts_list"),{origin:"https://evil.example"})).status,403);
  const valid=await f.rpc(call("lightmoni_hosts_list"),{origin:f.externalURL});assert.equal(valid.status,200);assert.equal(valid.headers.get("mcp-session-id"),null);
  assert.equal((await f.rpc("{")).status,400);assert.equal((await f.rpc([call("lightmoni_hosts_list")])).status,400);
  assert.equal((await f.rpc(call("lightmoni_hosts_list"),{"mcp-protocol-version":"2026-07-28"})).status,400);
  assert.equal((await f.rpc({padding:"x".repeat(129<<10)})).status,413);
  let nested:any={};for(let i=0;i<20;i++)nested={value:nested};assert.equal((await f.rpc(call("lightmoni_hosts_list",nested))).status,400);
  const extra=await(await f.rpc(call("lightmoni_hosts_list",{user_id:"some-admin"}))).json();assert.equal(extra.result.isError,true);assert.equal(extra.result.structuredContent.error.code,"invalid_input");
  const unknown=await(await f.rpc({jsonrpc:"2.0",id:1,method:"not-implemented"})).json();assert.equal(unknown.error.code,-32601);
  assert.equal((await fetch(f.endpoint+"?token=unused",{headers:{authorization:f.headers.authorization}})).status,400);
  const stored=JSON.stringify(f.db.all("SELECT * FROM mcp_security_events"));assert.ok(!stored.includes(f.key.token));assert.ok(stored.includes("authentication_failed"));
  f.access.revokeToken(f.user,f.key.id);assert.equal((await f.rpc(call("lightmoni_hosts_list"))).status,401);
 }finally{await f.close();}
});
test("disconnect after durable acceptance leaves one proposal when the client retries its business key",async()=>{
 let accepted!:()=>void;const ready=new Promise<void>(r=>{accepted=r;});
 const f=await fixture(d=>({list:p=>d.list(p),async invoke(p,n,i,c){const result=await d.invoke(p,n,i,c);accepted();await new Promise(r=>setTimeout(r,80));return result;}}));
 try{f.task();const controller=new AbortController();const pending=fetch(f.endpoint,{method:"POST",headers:f.headers,body:JSON.stringify(call("lightmoni_tasks_plan",intent)),signal:controller.signal}).catch(()=>undefined);
  await ready;controller.abort();await pending;const r=await(await f.rpc(call("lightmoni_tasks_plan",intent))).json();assert.ok(!r.result.isError,JSON.stringify(r));
  assert.equal(f.db.get<any>("SELECT count(*) n FROM assistant_task_proposals")!.n,1);assert.equal(f.runs.list().length,0);assert.equal(r.result.structuredContent.data.idempotency_replayed,true);
 }finally{await f.close();}
});
