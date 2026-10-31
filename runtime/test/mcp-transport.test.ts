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
async function fixture(wrap?:(d:CapabilityDispatcher)=>CapabilityDispatcherContract){
 const db=new DB(":memory:"),router=new Router(),user={id:"admin",name:"Admin",role:"admin"};accountSchema(db);
 db.run("INSERT INTO users(id,name,role,active,created_at) VALUES(?,?,?,1,?)",user.id,user.name,user.role,new Date().toISOString());
 const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));
 server.listen(0,"127.0.0.1");await once(server,"listening");const externalURL="http://127.0.0.1:"+(server.address() as any).port;
 const auth={user:()=>user,requireAdmin(){}};
 const deps={db,router,auth,externalURL,now:()=>new Date(),...cipher(Buffer.alloc(32,6)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
 router.auth=auth as any;router.externalURL=externalURL;const runs=new TaskRunStore(deps);
 for(const id of ["one","two"])db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)",id,"Host "+id,id+".example.test","agent-"+id,new Date().toISOString(),new Date().toISOString());
 const access=new McpAccess(deps);registerMcpAccess(deps,access);const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs});
 const module=registerMcpTransport(deps,access,wrap?wrap(dispatcher):dispatcher),endpoint=externalURL+"/api/v1/mcp";
 const key=access.createToken(user,{name:"Test client",scopes:["hosts.read","tasks.read","tasks.propose","executions.read"],host_ids:null});
 const headers={authorization:"Bearer "+key.token,accept:"application/json, text/event-stream","content-type":"application/json","mcp-protocol-version":"2025-11-25"};
 const rpc=(body:unknown,extra:Record<string,string>={})=>fetch(endpoint,{method:"POST",headers:{...headers,...extra},body:typeof body==="string"?body:JSON.stringify(body)});
 const task=()=>runs.nodes.task({name:"Reviewed script",type:"script",enabled:true,target_all:false,host_ids:["one"],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('hidden-source')",timeout_seconds:5,max_output_bytes:4096}},"script-one",true);
 return {db,user,runs,access,dispatcher,endpoint,externalURL,rpc,headers,key,task,async close(){await module.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}};
}
const call=(name:string,args:any={})=>({jsonrpc:"2.0",id:8,method:"tools/call",params:{name,arguments:args}});
const intent={operation:"task.dispatch",task_id:"script-one",host_ids:["one"],reason:"User requested dispatch",idempotency_key:"request-one"};
test("official SDK client discovers tools, creates an idempotent proposal and polls actual runs",async()=>{
 const f=await fixture(),client=new Client({name:"integration-test",version:"1"});try{
  const transport=new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:f.headers.authorization}}});await client.connect(transport);
  assert.equal(transport.sessionId,undefined);assert.equal(client.getServerVersion()?.name,"lightmoni");
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==="lightmoni_tasks_plan"));assert.ok(!tools.tools.some(t=>/apply|exec_ssh/.test(t.name)));
  const host=await client.callTool({name:"lightmoni_hosts_list",arguments:{}});assert.ok(!host.isError,JSON.stringify(host));assert.deepEqual((host.structuredContent as any).data.hosts.map((h:any)=>h.id),["one","two"]);
  f.task();const p=await client.callTool({name:"lightmoni_tasks_plan",arguments:intent});assert.ok(!p.isError,JSON.stringify(p));const proposal=(p.structuredContent as any).data.proposal;
  assert.ok(proposal.review_url.startsWith(f.externalURL));assert.equal(f.runs.list().length,0);
  const repeat=await client.callTool({name:"lightmoni_tasks_plan",arguments:intent});assert.equal((repeat.structuredContent as any).data.proposal.id,proposal.id);
  const applied=f.dispatcher.proposals.apply(f.user,proposal.id),run=(applied.result as any).runs[0];assert.equal(run.state,"queued");
  const state=await client.callTool({name:"lightmoni_executions_get",arguments:{id:run.id}});assert.equal((state.structuredContent as any).data.execution.native_state,"queued");
  assert.ok(!JSON.stringify(state).includes("hidden-source"));assert.ok(!JSON.stringify(state).includes("lease_token"));
  const bad=await client.callTool({name:"lightmoni_tasks_plan",arguments:{...intent,reason:"changed"}});assert.equal(bad.isError,true);assert.equal((bad.structuredContent as any).error.code,"conflict");
  assert.ok(f.db.get<any>("SELECT count(*) n FROM capability_invocations WHERE decision='idempotency_hit'")!.n>=1);
  const readKey=f.access.createToken(f.user,{name:"Read client",scopes:["hosts.read"],host_ids:["one"]}),readClient=new Client({name:"read-only",version:"1"});
  try{await readClient.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{authorization:"Bearer "+readKey.token}}}));
   assert.deepEqual((await readClient.listTools()).tools.map(t=>t.name),["lightmoni_hosts_list","lightmoni_hosts_get"]);
   assert.equal((await readClient.callTool({name:"lightmoni_executions_get",arguments:{id:run.id}})).isError,true);
  }finally{await readClient.close();}
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
