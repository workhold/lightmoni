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
import { Alerts } from "../src/domains/alerts.js";
import { AlertCapabilities } from "../src/domains/alert-capabilities.js";
import { AlertProposalService } from "../src/assistant/alert-proposals.js";
import { Logs } from "../src/domains/logs.js";
import { LogReadService } from "../src/domains/log-read.js";
import { TraceReadService } from "../src/domains/trace-read.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
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
 let alerts!:Alerts,caps!:AlertCapabilities,proposals!:AlertProposalService;
 const f=await fixture(d=>{
  d.deps.cat.list=async()=>[{id:"log_app",name:"log_app",logical_name:"app",kind:"log",columns:[],services:["api"],system:false,retention_days:null,effective_retention_days:7}];
  d.deps.referencedTables=async()=>["log_app"];
  alerts=new Alerts(d.deps);caps=new AlertCapabilities(alerts);proposals=new AlertProposalService(d.deps.db,caps,d.deps.now,d.deps.encrypt,d.deps.decrypt);
  return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,alerts:caps,alertProposals:proposals});
 });
 let client:Client|undefined,ordinaryClient:Client|undefined;
 try{
  const prepared=await caps.prepareRuleSave(f.user,{name:"API errors",enabled:true,kind:"sql",severity:"P2",sql:"SELECT count() AS value FROM log_app",value_field:"value",source_table_ids:["log_app"],threshold:"1",operator:"gt",interval_seconds:10,window_seconds:60,evidence_profile:{}});
  const rule=f.db.transaction(()=>caps.commitRuleSave(f.user,prepared));
  const proposal=await proposals.create(f.user,"session-one",{operation:"rule.update",target_id:rule.id,patch:{threshold:"2"},reason:"review"},new AbortController().signal);
  const key=f.access.createToken(f.user,{name:"Alert read",scopes:["alerts.read","alerts.detail.read"],host_ids:null});client=new Client({name:"alert-read",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_alert_rules_list","lightmoni_alert_rules_get","lightmoni_alert_silences_list","lightmoni_alert_silences_get","lightmoni_alert_groups_list","lightmoni_alert_proposals_get"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/apply|approve|propose/.test(t.name)),false);
  const listed=await client.callTool({name:"lightmoni_alert_rules_list",arguments:{search:"API"}});assert.equal(Object.hasOwn((listed.structuredContent as any).data.items[0],"sql"),false);
  const detail=await client.callTool({name:"lightmoni_alert_rules_get",arguments:{id:rule.id}});assert.match((detail.structuredContent as any).data.rule.sql,/log_app/);
  const readback=await client.callTool({name:"lightmoni_alert_proposals_get",arguments:{id:proposal.id}});assert.equal((readback.structuredContent as any).data.proposal.status,"awaiting_approval");
  const ordinaryKey=f.access.createToken(f.user,{name:"Alert catalog",scopes:["alerts.read"],host_ids:null});ordinaryClient=new Client({name:"alert-catalog",version:"1"});
  await ordinaryClient.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+ordinaryKey.token}}}));
  assert.equal((await ordinaryClient.listTools()).tools.some(t=>t.name==="lightmoni_alert_rules_get"),false);
  const denied=await ordinaryClient.callTool({name:"lightmoni_alert_rules_get",arguments:{id:rule.id}});assert.equal(denied.isError,true);assert.equal((denied.structuredContent as any).error.detail_code,"capability_forbidden");
 }finally{await client?.close();await ordinaryClient?.close();await alerts.close();await f.close();}
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
 const f=await fixture(d=>{const store=registerServiceDeployments(d.deps);return new CapabilityDispatcher(d.deps,d.authority,{taskCenter:d.options.taskCenter,deployments:store});});
 const client=new Client({name:"deployment-read",version:"1"});
 try{
  const at=new Date().toISOString(),serviceID="a".repeat(32);
  f.db.run("INSERT INTO services(id,name,description,repository_url,created_at,updated_at,created_by) VALUES(?,'Checkout','Checkout API','',?,?,'admin')",serviceID,at,at);
  f.db.run("INSERT INTO service_targets(id,service_id,machine_id,adapter,config_json,desired_release_id,status,created_at,updated_at) VALUES('target-one',?,'one','systemd','{}','release-one','ready',?,?)",serviceID,at,at);
  f.db.run("INSERT INTO releases(id,service_id,version,source_type,source_ref,artifact_digest,artifact_size,manifest_json,status,created_at,created_by) VALUES('release-one',?,'2026.11.14','artifact','sha256:abc','sha256:abc',128,'{}','ready',?,'admin')",serviceID,at);
  f.db.run("INSERT INTO deployments(id,service_id,target_id,release_id,adapter,status,plan_json,target_snapshot_json,receipt_json,phase,operation_id,created_at,created_by) VALUES('deployment-one',?,'target-one','release-one','systemd','awaiting_approval','{}','{}','{}','awaiting_approval','operation-one',?,'admin')",serviceID,at);
  f.db.run("INSERT INTO deployment_events(id,deployment_id,phase,state,summary,actor,created_at) VALUES('event-one','deployment-one','awaiting_approval','awaiting_approval','计划已生成','admin',?)",at);
  const key=f.access.createToken(f.user,{name:"Deployments",scopes:["deployments.read"],host_ids:null});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+key.token}}}));
  const tools=await client.listTools();for(const name of ["lightmoni_services_list","lightmoni_services_get","lightmoni_deployments_list","lightmoni_deployments_get","lightmoni_deployments_events"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.equal(tools.tools.some(t=>/approve|rollback|upload/.test(t.name)),false);
  const detail=await client.callTool({name:"lightmoni_services_get",arguments:{service_id:serviceID}});assert.equal((detail.structuredContent as any).data.targets[0].id,"target-one");assert.equal((detail.structuredContent as any).data.releases[0].id,"release-one");
  const deployment=await client.callTool({name:"lightmoni_deployments_get",arguments:{deployment_id:"deployment-one"}});assert.equal((deployment.structuredContent as any).data.deployment.status,"awaiting_approval");
  const events=await client.callTool({name:"lightmoni_deployments_events",arguments:{deployment_id:"deployment-one"}});assert.equal((events.structuredContent as any).data.events[0].id,"event-one");
 }finally{await client.close();await f.close();}
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
