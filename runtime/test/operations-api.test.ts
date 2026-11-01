import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerOperations } from "../src/server/operations.js";
import { operationTools } from "../src/assistant/operation-tools.js";
import type { Dependencies } from "../src/shared/types.js";
import type { OperationDefinition } from "../src/operations/types.js";
import { backupDefinition } from "../src/operations/backups.js";
import { composeDefinition } from "../src/operations/containers.js";
import { websiteDefinition } from "../src/operations/websites.js";
async function fixture(t: any) {
  const db = new DB(":memory:"), router = new Router(), crypto = cipher(Buffer.alloc(32, 7));
  let now = new Date("2026-10-27T00:00:00Z");
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY); INSERT INTO agents VALUES('agent-1'); CREATE TABLE services(id TEXT PRIMARY KEY)");
  const deps = { db, router, ...crypto, now: () => now, logger: { info() {}, warn() {}, error() {} }, auth: {
    requireAdmin: (ctx: any) => { if (ctx.user.role !== "admin") fail(403, "administrator required"); },
    user: (req: any) => req.headers["x-role"] === "agent" ? undefined : ({id: "admin",name:"Admin",role:req.headers["x-role"] ?? "admin"}),
  }} as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = { has: () => true, authenticate(req: any, agentID: string) { if (agentID !== "agent-1" || req.headers.authorization !== "Bearer control-secret") fail(403, "invalid agent credential"); return { agent_id: agentID }; } } as any;
  const jobs = registerAgentJobs(deps, { agentCredentials: credentials });
  const definition: OperationDefinition = { kind: "certificate", operations: ["inspect", "install"], readOnly: ["inspect"], validate: v => v as any, publicConfig: v => ({domains:v.domains,has_private_key:!!v.private_key_pem}), validateInput: (_op,v) => v as any };
  let resolved = 0;
  const ops = registerOperations(deps, { jobs, credentials, definitions: [definition, backupDefinition, composeDefinition, websiteDefinition], resolvePayload() { resolved++; throw Error("private payload resolver must not run"); } });
  const server = createServer((req, res) => void router.handle(req, res)); server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(() => { ops.close?.(); jobs.close?.(); server.close(); db.close(); });
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const req = async (path: string, method="GET", body?: any, headers: Record<string,string> = {}) => { const r = await fetch(base + "/api/v1" + path,{method,headers:{"content-type":"application/json",...headers},body:body === undefined ? undefined : JSON.stringify(body)}); return {status:r.status,body:await r.json(),headers:r.headers}; };
  const create = () => req("/operations/resources","POST",{kind:"certificate",name:"HTTPS",agent_id:"agent-1",config:{domains:["example.com"],private_key_pem:"SECRET-PRIVATE-MATERIAL"}});
  return { db, deps, ops, jobs, req, create, base, resolved: () => resolved, advance: (ms:number) => { now=new Date(now.getTime()+ms); } };
}

test("legacy resource configuration stays encrypted while unimplemented plans create no runs or jobs",async t=>{
  const f=await fixture(t),created=await f.create();assert.equal(created.status,201);
  const resource=created.body.resource;
  assert.doesNotMatch(JSON.stringify(created.body),/SECRET-PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.db.all("SELECT * FROM ops_resources")),/SECRET-PRIVATE/);
  f.deps.decrypt=()=>{throw Error("unimplemented plans must not decrypt configuration");};
  for(const operation of ["install","inspect"]){
    const response=await f.req(`/operations/resources/${resource.id}/plans`,"POST",{operation});
    assert.equal(response.status,409);assert.equal(response.body.error,"privileged_profile_not_implemented");
    assert.throws(()=>f.ops.plan(resource.id,operation,{},"admin"),/privileged_profile_not_implemented/);
  }
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_runs")!.n,0);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n,0);
});

test("all legacy operation kinds reject planning without leaving queued or awaiting approval records",async t=>{
  const f=await fixture(t);
  const cases=[
    {kind:"website",config:{domains:["example.test"],mode:"static"},operation:"apply"},
    {kind:"certificate",config:{domains:["example.test"],private_key_pem:"secret"},operation:"install"},
    {kind:"compose",config:{project_name:"denied",compose:{services:{web:{image:"nginx:1.27.5"}}}},operation:"apply"},
    {kind:"backup",config:{source_path:"/srv/source",storage:{type:"local",path:"/srv/backups"}},operation:"create"},
  ];
  for(const value of cases){
    const created=await f.req("/operations/resources","POST",{...value,name:value.kind,agent_id:"agent-1"});
    assert.equal(created.status,201,JSON.stringify(created));
    const planned=await f.req(`/operations/resources/${created.body.resource.id}/plans`,"POST",{operation:value.operation});
    assert.equal(planned.status,409);assert.equal(planned.body.error,"privileged_profile_not_implemented");
  }
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_runs")!.n,0);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n,0);
});

test("historical operation approvals cannot enqueue, decrypt, replay or change saved records",async t=>{
  const f=await fixture(t),resource=(await f.create()).body.resource;
  const before="2026-10-27T00:00:00Z";
  f.db.run("INSERT INTO ops_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)","historical",resource.id,1,"install","awaiting_approval","unreadable-cipher",JSON.stringify({operation:"install"}),"",before,"2099-01-01T00:00:00Z","admin","",before);
  f.deps.decrypt=()=>{throw Error("old approvals must not decrypt private data");};
  f.jobs.enqueue=()=>{throw Error("old approvals must not enqueue");};
  const row=f.db.get<any>("SELECT * FROM ops_runs WHERE id='historical'");
  for(const id of ["historical","missing"]){
    const response=await f.req(`/operations/runs/${id}/approve`,"POST",{revision:1});
    assert.equal(response.status,409);assert.equal(response.body.error,"privileged_profile_not_implemented");
  }
  assert.deepEqual(f.db.get("SELECT * FROM ops_runs WHERE id='historical'"),row);
  const historical=await f.req("/operations/runs/historical");assert.equal(historical.status,200);
  assert.equal(historical.body.run.state,"awaiting_approval");
  assert.doesNotMatch(JSON.stringify(historical.body),/unreadable-cipher|payload_cipher/);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n,0);
});

test("ordinary Agent private operations payload endpoint is permanently removed without resolving jobs or secrets",async t=>{
  const f=await fixture(t);
  f.deps.decrypt=()=>{throw Error("removed endpoint must not decrypt");};
  f.jobs.get=()=>{throw Error("removed endpoint must not load jobs");};
  for(const lease of [undefined,"old-lease"]){
    const headers:Record<string,string>={"x-role":"agent",authorization:"Bearer control-secret"};
    if(lease)headers["X-LightMoni-Job-Lease"]=lease;
    const response=await f.req("/agents/agent-1/jobs/nonexistent/operations","GET",undefined,headers);
    assert.equal(response.status,410);assert.equal(response.body.error,"legacy_agent_payload_removed");
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal(response.body.payload,undefined);
  }
  assert.equal(f.resolved(),0);
  assert.equal((await f.req("/agents/agent-1/jobs/missing/operations","GET",undefined,{"x-role":"agent",authorization:"Bearer wrong"})).status,403);
});

test("legacy operation actions remain administrator-only and AI tools cannot approve execution",async t=>{
  const f=await fixture(t),resource=(await f.create()).body.resource;
  for(const [path,body] of [
    [`/operations/resources/${resource.id}/plans`,{operation:"install"}],
    ["/operations/runs/historical/approve",{revision:1}],
  ] as const)assert.equal((await f.req(path,"POST",body,{"x-role":"member"})).status,403);
  const tools=operationTools(f.ops);assert.equal(tools.some(x=>/approve|execute/.test(x.name)),false);
  await assert.rejects(()=>tools[0].execute({},new AbortController().signal,{id:"member",role:"member"} as any),/administrator/);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM ops_runs")!.n,0);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n,0);
});

test("S3 edits reuse credentials only for the same target; service association can be cleared explicitly",async t=>{
 const f=await fixture(t);f.db.run("INSERT INTO services VALUES('service-1')");
 const config={source_path:'/srv/lightmoni/files',service_id:'service-1',storage:{type:'s3',endpoint:'https://storage.example',bucket:'backups',region:'us-east-1',prefix:'site',access_key_id:'test-access-id',secret_access_key:'test-s3-private'}};
 const created=await f.req('/operations/resources','POST',{kind:'backup',name:'Files',agent_id:'agent-1',config});assert.equal(created.status,201);
 const r=created.body.resource;
 assert.equal(JSON.stringify(created.body).includes('test-s3-private'),false);
 const publicStorage=created.body.resource.config.storage;
 const updated=await f.req(`/operations/resources/${r.id}`,'PUT',{revision:1,config:{storage:publicStorage,service_id:null}});assert.equal(updated.status,200);
 const privateConfig=JSON.parse(cipher(Buffer.alloc(32,7)).decrypt(f.db.get<any>('SELECT config_cipher FROM ops_resources WHERE id=?',r.id).config_cipher));
 assert.equal(privateConfig.storage.secret_access_key,'test-s3-private');
 assert.equal(privateConfig.service_id,undefined);
 const changed=await f.req(`/operations/resources/${r.id}`,'PUT',{revision:2,config:{storage:{...publicStorage,endpoint:'https://different.example'}}});
 assert.equal(changed.status,400);
 assert.equal(f.ops.get(r.id).revision,2);
 const cert=(await f.req('/operations/resources','POST',{kind:'certificate',name:'Linked',agent_id:'agent-1',config:{domains:['example.org'],service_id:'service-1'}})).body.resource;
 assert.equal((await f.req(`/operations/resources/${cert.id}`,'PUT',{revision:1,config:{service_id:null}})).status,200);
 const certConfig=JSON.parse(cipher(Buffer.alloc(32,7)).decrypt(f.db.get<any>('SELECT config_cipher FROM ops_resources WHERE id=?',cert.id).config_cipher));
 assert.equal(certConfig.service_id,undefined);
});

test("Compose edits preserve encrypted documents by default and reject public redaction placeholders",async t=>{
 const f=await fixture(t),created=await f.req('/operations/resources','POST',{kind:'compose',name:'App',agent_id:'agent-1',config:{project_name:'app',compose:{services:{app:{image:'node:24',environment:{PASSWORD:'private-example-value'}}}}}});
 assert.equal(created.status,201);const r=created.body.resource;
 assert.equal(r.config.compose.services.app.environment.PASSWORD,'[redacted]');
 const changed=await f.req(`/operations/resources/${r.id}`,'PUT',{revision:1,name:'New name',config:{}});assert.equal(changed.status,200);
 const privateConfig=JSON.parse(cipher(Buffer.alloc(32,7)).decrypt(f.db.get<any>('SELECT config_cipher FROM ops_resources WHERE id=?',r.id).config_cipher));
 assert.equal(privateConfig.compose.services.app.environment.PASSWORD,'private-example-value');
 const bad=await f.req(`/operations/resources/${r.id}`,'PUT',{revision:2,config:r.config});assert.equal(bad.status,400);
 assert.equal(f.ops.get(r.id).revision,2);
});

test('a certificate cannot drop domains required by its registered websites',async t=>{
 const f=await fixture(t);
 const cert=(await f.req('/operations/resources','POST',{kind:'certificate',name:'Shared',agent_id:'agent-1',config:{domains:['example.com','example.net']}})).body.resource;
 const site=await f.req('/operations/resources','POST',{kind:'website',name:'Site',agent_id:'agent-1',config:{domains:['example.net'],mode:'static',static_files:{'index.html':'hello'},certificate_id:cert.id}});assert.equal(site.status,201);
 const change=await f.req(`/operations/resources/${cert.id}`,'PUT',{revision:1,config:{domains:['example.com']}});assert.equal(change.status,409);
 assert.equal(f.ops.get(cert.id).revision,1);
});
