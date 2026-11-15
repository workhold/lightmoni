import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { McpAccess, registerMcpAccess, registerMcpServiceAccounts, serviceInputMatches } from "../src/mcp/access.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher, registerCapabilities } from "../src/capabilities/index.js";
import { registerMcpTransport } from "../src/mcp/transport.js";
import type { Dependencies, User } from "../src/shared/types.js";
import { taskHelperFixture } from "./helpers/task-helper.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"};
const other: User = {id:"other",name:"Other",role:"admin"};
const member: User = {id:"member",name:"Member",role:"member"};
const bearer = (token:string) => ({headers:{authorization:"Bearer "+token}} as IncomingMessage);

async function fixture(legacyAudit = false) {
  const db = new DB(":memory:");accountSchema(db);
  for (const user of [admin,other,member]) db.run("INSERT INTO users(id,name,role,active,created_at) VALUES(?,?,?,1,'2026-11-14')",user.id,user.name,user.role);
  const router = new Router();let now = new Date("2026-11-14T00:00:00.000Z");
  const server = createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.statusCode=404;res.end();}}));
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = {user(req:IncomingMessage) {
    const id = req.headers.cookie?.match(/(?:^|;\s*)test_user=([^;]+)/)?.[1];
    return id ? db.get<User>("SELECT id,name,role FROM users WHERE id=? AND active=1",id) : undefined;
  },requireAdmin(){}};
  const deps = {db,router,auth,now:()=>now,externalURL:base,...cipher(Buffer.alloc(32,41)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  router.auth = auth as any;router.externalURL = base;
  const runs = new TaskRunStore(deps);taskHelperFixture(deps,runs);
  for (const id of ["one","two"]) db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)",id,"Host "+id,id+".test","agent-"+id,now.toISOString(),now.toISOString());
  if (legacyAudit) {
    db.exec("CREATE TABLE capability_invocations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,credential_id TEXT NOT NULL,source TEXT NOT NULL,capability TEXT NOT NULL,input_hash TEXT NOT NULL,decision TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT '',proposal_id TEXT NOT NULL DEFAULT '')");
    db.run("INSERT INTO capability_invocations(id,user_id,credential_id,source,capability,input_hash,decision,created_at) VALUES('old','admin','','web','old','hash','allowed','2026-11-14')");
  }
  const access = new McpAccess(deps), authority = new CapabilityAccess(deps,access);registerMcpAccess(deps,access);
  const dispatcher = new CapabilityDispatcher(deps,authority,{taskCenter:runs});
  registerMcpServiceAccounts(deps,access,dispatcher.definitions);registerCapabilities(deps,dispatcher,authority,access);
  const mcp = registerMcpTransport(deps,access,dispatcher);
  const makeService = (input:Record<string,unknown> = {}) => access.createServiceAccount(admin,{
    name:"Inventory automation",capabilities:[{name:"lightmoni_hosts_list",version:1,input:{limit:1}},{name:"lightmoni_hosts_get",version:1,input:{id:"one"}}],
    host_ids:["one"],expires_in_hours:2,max_invocations:20,...input,
  },dispatcher.definitions);
  const api = async (path:string,options:{method?:string;body?:unknown;user?:string;token?:string;origin?:string} = {}) => {
    const headers:Record<string,string> = {"content-type":"application/json"};
    if(options.user)headers.cookie="test_user="+options.user;
    if(options.token)headers.authorization="Bearer "+options.token;
    if(options.origin)headers.origin=options.origin;
    else if(options.user || options.origin !== "")headers.origin=base;
    return fetch(base+path,{method:options.method??(options.body===undefined?"GET":"POST"),headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});
  };
  return {db,deps,access,authority,dispatcher,base,makeService,api,advance(hours:number){now=new Date(now.getTime()+hours*3600_000);},async close(){await mcp.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}};
}

test("service identity has isolated HTTP/MCP discovery, invocation, OpenAPI and audit",async()=>{
  const f=await fixture();let client:Client|undefined;
  try {
    const made=f.makeService();assert.match(made.token,/^lm_sat_[A-Za-z0-9_-]{43}$/);
    const principal=f.access.authenticate(bearer(made.token));
    assert.equal(principal.user.id,made.service_id);assert.notEqual(principal.user.id,admin.id);assert.equal(principal.subject_type,"service");assert.equal(principal.owner_user_id,admin.id);
    assert.equal(f.db.get("SELECT 1 FROM users WHERE id=?",made.service_id),undefined);
    assert.deepEqual(f.dispatcher.list(principal).map(d=>d.name),["lightmoni_hosts_list","lightmoni_hosts_get"]);

    const listed=await f.api("/api/v1/capabilities",{token:made.token,origin:""});assert.equal(listed.status,200);
    assert.deepEqual((await listed.json() as any[]).map(d=>d.name),["lightmoni_hosts_list","lightmoni_hosts_get"]);
    const invoked=await f.api("/api/v1/capabilities/lightmoni_hosts_list/invoke",{token:made.token,body:{limit:1},origin:""});
    assert.equal(invoked.status,200);assert.equal((await invoked.json() as any).data.hosts[0].id,"one");
    const document=await f.api("/api/v1/openapi.json",{token:made.token,origin:""});assert.equal(document.status,200);const doc=await document.json() as any;
    assert.equal(doc["x-lightmoni-capability-count"],2);assert.ok(doc.paths["/api/v1/capabilities/lightmoni_hosts_get/invoke"]);assert.equal(doc.paths["/api/v1/capabilities/lightmoni_tasks_list/invoke"],undefined);
    const audit=f.db.get<any>("SELECT user_id,subject_type,source,decision FROM capability_invocations WHERE capability='lightmoni_hosts_list'");
    assert.deepEqual(audit,{user_id:made.service_id,subject_type:"service",source:"mcp",decision:"allowed"});

    client=new Client({name:"service-fixture",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(f.base+"/api/v1/mcp"),{requestInit:{headers:{authorization:"Bearer "+made.token}}}));
    const tools=await client.listTools();assert.deepEqual(tools.tools.map(tool=>tool.name),["lightmoni_hosts_list","lightmoni_hosts_get"]);
    const called=await client.callTool({name:"lightmoni_hosts_get",arguments:{id:"one"}});
    assert.equal((called.structuredContent as any).data.host.id,"one");
  } finally {await client?.close();await f.close();}
});

test("service policy rejects writes, changed versions, unconstrained input and out-of-scope hosts without spending budget",async()=>{
  const f=await fixture();try{
    assert.equal(serviceInputMatches({target:{id:"one",labels:["a","b"]},limit:2},{target:{id:"one"}}),true);
    assert.equal(serviceInputMatches({target:{id:"two",labels:["a","b"]}},{target:{id:"one"}}),false);
    assert.equal(serviceInputMatches({target:{labels:["a"]}},{target:{labels:["a","b"]}}),false);
    const made=f.makeService({max_invocations:1});
    assert.throws(()=>f.makeService({name:"Write automation",capabilities:[{name:"lightmoni_tasks_plan",version:1,input:{}}]}),/automation_capability_forbidden/);
    const deniedInput=await f.api("/api/v1/capabilities/lightmoni_hosts_list/invoke",{token:made.token,body:{limit:2},origin:""});
    assert.equal(deniedInput.status,403);assert.equal((await deniedInput.json() as any).detail_code,"automation_input_forbidden");
    const deniedHost=await f.api("/api/v1/capabilities/lightmoni_hosts_get/invoke",{token:made.token,body:{id:"two"},origin:""});
    assert.equal(deniedHost.status,404);assert.equal((await deniedHost.json() as any).detail_code,"resource_not_found");
    const deniedCapability=await f.api("/api/v1/capabilities/lightmoni_tasks_list/invoke",{token:made.token,body:{host_id:"one"},origin:""});
    assert.equal(deniedCapability.status,403);
    assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",made.service_id)!.invocation_count,0);
    f.db.run("UPDATE mcp_service_accounts SET capabilities_json=? WHERE id=?",JSON.stringify([{id:"hosts.list",name:"lightmoni_hosts_list",version:2,input:{limit:1}}]),made.service_id);
    assert.equal(f.dispatcher.list(f.access.authenticate(bearer(made.token))).length,0);
    const drift=await f.api("/api/v1/capabilities/lightmoni_hosts_list/invoke",{token:made.token,body:{limit:1},origin:""});
    assert.equal(drift.status,403);assert.equal((await drift.json() as any).detail_code,"automation_capability_forbidden");
  }finally{await f.close();}
});

test("service budget is atomic and a post-admission failure is not refunded",async()=>{
  const f=await fixture();try{
    const made=f.makeService({capabilities:[{name:"lightmoni_hosts_list",version:1,input:{}}],max_invocations:2});
    const calls=Array.from({length:6},()=>f.api("/api/v1/capabilities/lightmoni_hosts_list/invoke",{token:made.token,body:{},origin:""}));
    const responses=await Promise.all(calls);assert.equal(responses.filter(r=>r.status===200).length,2);assert.equal(responses.filter(r=>r.status===429).length,4);
    for(const response of responses.filter(r=>r.status===429))assert.equal((await response.json() as any).detail_code,"automation_budget_exhausted");
    assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",made.service_id)!.invocation_count,2);
    assert.equal((await f.api("/api/v1/capabilities",{token:made.token,origin:""})).status,200);

    const failed=f.makeService({name:"Failure accounting",capabilities:[{name:"lightmoni_hosts_list",version:1,input:{}}],max_invocations:2});
    const definition=f.dispatcher.definitions.find(d=>d.name==="lightmoni_hosts_list")!,execute=definition.execute;
    definition.execute=()=>{throw Error("fixture failure");};
    await assert.rejects(f.dispatcher.invoke(f.access.authenticate(bearer(failed.token)),"lightmoni_hosts_list",{},{signal:new AbortController().signal}),/fixture failure/);
    definition.execute=execute;
    assert.equal(f.db.get<any>("SELECT invocation_count FROM mcp_service_accounts WHERE id=?",failed.service_id)!.invocation_count,1);
    assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE user_id=? AND decision='denied'",failed.service_id));
  }finally{await f.close();}
});

test("service revocation, expiry and owner changes invalidate cached principals",async()=>{
  for(const change of ["revoke","expire","demote","disable","grant_revoke","token_revoke"]){
    const f=await fixture();try{
      const made=f.makeService(),principal=f.access.authenticate(bearer(made.token));
      if(change==="revoke")f.access.revokeServiceAccount(admin,made.service_id);
      if(change==="expire")f.advance(3);
      if(change==="demote")f.db.run("UPDATE users SET role='member' WHERE id='admin'");
      if(change==="disable")f.db.run("UPDATE users SET active=0 WHERE id='admin'");
      if(change==="grant_revoke")f.db.run("UPDATE mcp_access_grants SET revoked_at=? WHERE id=?",f.deps.now().toISOString(),made.grant_id);
      if(change==="token_revoke")f.db.run("UPDATE mcp_access_tokens SET revoked_at=? WHERE id=?",f.deps.now().toISOString(),made.id);
      assert.throws(()=>f.access.authenticate(bearer(made.token)),/失效|变化/);
      assert.throws(()=>f.dispatcher.list(principal),/失效|变化/);
      assert.equal((await f.api("/api/v1/capabilities",{token:made.token,origin:""})).status,401);
    }finally{await f.close();}
  }
});

test("owner-only management returns metadata without secrets and preserves PAT/Web behavior",async()=>{
  const f=await fixture();try{
    assert.equal((await f.api("/api/v1/mcp-access/service-accounts",{user:"member",body:{}})).status,403);
    const created=await f.api("/api/v1/mcp-access/service-accounts",{user:"admin",body:{name:"Managed service",capabilities:[{name:"lightmoni_hosts_list",version:1,input:{}}],host_ids:null,expires_in_hours:2,max_invocations:5}});
    assert.equal(created.status,201);const made=await created.json() as any;
    const summary=await f.api("/api/v1/mcp-access",{user:"admin"});assert.equal(summary.status,200);const raw=await summary.text();
    assert.equal(raw.includes(made.token),false);assert.equal(raw.includes("token_hash"),false);assert.equal(JSON.parse(raw).service_accounts[0].id,made.service_id);
    const otherSummary=await f.api("/api/v1/mcp-access",{user:"other"});assert.equal((await otherSummary.json() as any).service_accounts.length,0);
    assert.equal((await f.api("/api/v1/mcp-access/service-accounts/"+made.service_id,{user:"other",method:"DELETE"})).status,404);
    assert.equal((await f.api("/api/v1/mcp-access",{user:made.service_id})).status,401);
    assert.equal((await f.api("/api/v1/mcp-access/service-accounts/"+made.service_id,{user:"admin",method:"DELETE",origin:"https://evil.example"})).status,403);
    assert.equal((await f.api("/api/v1/mcp-access/service-accounts/"+made.service_id,{user:"admin",method:"DELETE"})).status,200);
    assert.equal((await f.api("/api/v1/capabilities",{token:made.token,origin:""})).status,401);

    const pat=f.access.createToken(admin,{name:"Ordinary HTTP",scopes:["hosts.read"],host_ids:null});
    assert.equal((await f.api("/api/v1/capabilities",{token:pat.token,origin:""})).status,200);
    assert.equal((await f.api("/api/v1/capabilities",{origin:""})).status,401);
    assert.equal((await f.api("/api/v1/capabilities",{user:"admin"})).status,200);
    assert.equal((await f.api("/api/v1/capabilities/lightmoni_hosts_list/invoke",{user:"admin",body:{},origin:"https://evil.example"})).status,403);
  }finally{await f.close();}
});

test("legacy invocation audit gains a user subject default without rewriting history",async()=>{
  const f=await fixture(true);try{
    assert.equal(f.db.get<any>("SELECT subject_type FROM capability_invocations WHERE id='old'")!.subject_type,"user");
    const web=f.authority.sessionPrincipal(admin,"web");
    await f.dispatcher.invoke(web,"lightmoni_hosts_list",{},{signal:new AbortController().signal});
    assert.equal(f.db.get<any>("SELECT subject_type FROM capability_invocations WHERE capability='lightmoni_hosts_list'")!.subject_type,"user");
  }finally{await f.close();}
});
