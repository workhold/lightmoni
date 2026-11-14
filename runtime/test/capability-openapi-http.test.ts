import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { McpAccess, registerMcpAccess } from "../src/mcp/access.js";
import { CapabilityDispatcher, registerCapabilities } from "../src/capabilities/index.js";
import { taskHelperFixture } from "./helpers/task-helper.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"};
async function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14')");
  const router=new Router(),deps={db,router,now:()=>new Date(),externalURL:"",...cipher(Buffer.alloc(32,37)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps),at=deps.now().toISOString();db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('one','Host one','one.test',22,'direct_ssh','agent-one',?,?)",at,at);taskHelperFixture(deps,runs);
  deps.auth={user:()=>admin} as any;router.auth=deps.auth;
  const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.statusCode=404;res.end();}}));server.listen(0,"127.0.0.1");await once(server,"listening");
  deps.externalURL=`http://127.0.0.1:${(server.address() as any).port}`;
  const access=new McpAccess(deps);registerMcpAccess(deps,access);const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs});registerCapabilities(deps,dispatcher,access,access);
  const token=access.createToken(admin,{name:"Capability HTTP",scopes:["hosts.read"],host_ids:null});
  return{db,deps,access,dispatcher,token,base:deps.externalURL,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}};
}

test("PAT Bearer discovers and invokes capabilities with OpenAPI and isolated audit",async()=>{
 const f=await fixture();try{
  const headers={authorization:`Bearer ${f.token.token}`,"content-type":"application/json"};
  const listed=await fetch(f.base+"/api/v1/capabilities",{headers});assert.equal(listed.status,200);
  const tools=await listed.json() as any[];assert.ok(tools.some(tool=>tool.name==="lightmoni_hosts_list"));assert.equal(tools.some(tool=>tool.name==="lightmoni_tasks_list"),false);
  const invoked=await fetch(f.base+"/api/v1/capabilities/lightmoni_hosts_list/invoke",{method:"POST",headers,body:"{}"});assert.equal(invoked.status,200);
  const result=await invoked.json() as any;assert.equal(result.data.hosts[0].id,"one");assert.equal(f.db.get<any>("SELECT source FROM capability_invocations WHERE capability='lightmoni_hosts_list'")!.source,"mcp");
  const documentResponse=await fetch(f.base+"/api/v1/openapi.json",{headers});assert.equal(documentResponse.status,200);const raw=await documentResponse.text(),doc=JSON.parse(raw);
  assert.equal(doc.openapi,"3.1.0");assert.ok(doc.paths["/api/v1/capabilities/lightmoni_hosts_list/invoke"]);assert.equal(doc.paths["/api/v1/capabilities/lightmoni_tasks_list/invoke"],undefined);
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme,"bearer");assert.equal(doc.paths["/api/v1/capabilities/lightmoni_hosts_list/invoke"].post["x-lightmoni-capability"].required_scopes[0],"hosts.read");
  assert.equal(raw.includes(f.token.token),false);assert.equal(doc.servers[0].url,f.base);
 }finally{await f.close();}
});

test("capability HTTP preserves web sessions and rejects invalid bearer credentials",async()=>{
 const f=await fixture();try{
  const session=await fetch(f.base+"/api/v1/capabilities");assert.equal(session.status,200);const tools=await session.json() as any[];assert.ok(tools.some(tool=>tool.name==="lightmoni_tasks_list"));
  const invoked=await fetch(f.base+"/api/v1/capabilities/lightmoni_hosts_list/invoke",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert.equal(invoked.status,200);
  assert.equal(f.db.get<any>("SELECT source FROM capability_invocations WHERE capability='lightmoni_hosts_list'")!.source,"web");
  const denied=await fetch(f.base+"/api/v1/capabilities",{headers:{authorization:"Bearer invalid"}});assert.equal(denied.status,401);
 }finally{await f.close();}
});
