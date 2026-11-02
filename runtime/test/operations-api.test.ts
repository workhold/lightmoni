import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { registerOperations } from "../src/server/operations.js";
import { operationTools } from "../src/assistant/operation-tools.js";
import type { Dependencies } from "../src/shared/types.js";
import type { OperationDefinition } from "../src/operations/types.js";
import { backupDefinition } from "../src/operations/backups.js";
import { composeDefinition } from "../src/operations/containers.js";
import { websiteDefinition } from "../src/operations/websites.js";
import { AgentJobRunner } from "../src/agent/jobs.js";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const ops = registerOperations(deps, { jobs, credentials, definitions: [definition, backupDefinition, composeDefinition, websiteDefinition] });
  const server = createServer((req, res) => void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}})); server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(() => { ops.close?.(); jobs.close?.(); server.close(); db.close(); });
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const req = async (path: string, method="GET", body?: any, headers: Record<string,string> = {}) => { const r = await fetch(base + "/api/v1" + path,{method,headers:{"content-type":"application/json",...headers},body:body === undefined ? undefined : JSON.stringify(body)}); return {status:r.status,body:await r.text().then(text=>text?JSON.parse(text):{}),headers:r.headers}; };
  const create = () => req("/operations/resources","POST",{kind:"certificate",name:"HTTPS",agent_id:"agent-1",config:{domains:["example.com"],private_key_pem:"SECRET-PRIVATE-MATERIAL"}});
  return { db, ops, jobs, req, create, base, advance: (ms:number) => { now=new Date(now.getTime()+ms); } };
}

test("operations encrypt configuration and payload; ordinary control never reads private material",async t=>{
  const f=await fixture(t), created=await f.create(); assert.equal(created.status,201); assert.equal(JSON.stringify(created.body).includes("SECRET-PRIVATE"),false);
  const resource=created.body.resource;
  assert.equal(JSON.stringify(f.db.all("SELECT * FROM ops_resources")).includes("SECRET-PRIVATE"),false);
  const draft=await f.req(`/operations/resources/${resource.id}/plans`,"POST",{operation:"install"}); assert.equal(draft.status,201);
  assert.equal(f.db.get<any>("SELECT count(*) n FROM agent_jobs")?.n,0);
  assert.equal(JSON.stringify(f.db.all("SELECT * FROM ops_runs")).includes("SECRET-PRIVATE"),false);
  const approve=await f.req(`/operations/runs/${draft.body.run.id}/approve`,"POST",{revision:1}); assert.equal(approve.status,200);
  const repeated=await f.req(`/operations/runs/${draft.body.run.id}/approve`,"POST",{revision:1}); assert.equal(repeated.body.run.job_id,approve.body.run.job_id);
  const j=f.jobs.claim("agent-1",["operations.certificate"]); assert.ok(j); assert.equal(JSON.stringify(j).includes("SECRET-PRIVATE"),false);
  const path=`/agents/agent-1/jobs/${j.id}/operations`;
  assert.equal((await f.req(path,"GET",undefined,{"x-role":"agent",authorization:"Bearer control-secret"})).status,404);
  const privateReply=await f.req(path,"GET",undefined,{"x-role":"agent",authorization:"Bearer control-secret","X-LightMoni-Job-Lease":j.lease_id});
  assert.equal(privateReply.status,404); assert.equal(JSON.stringify(privateReply.body).includes("SECRET-PRIVATE"),false);
  f.advance(46_000); assert.equal((await f.req(path,"GET",undefined,{"x-role":"agent",authorization:"Bearer control-secret","X-LightMoni-Job-Lease":j.lease_id})).status,404);
});

test("ordinary Agent runner does not claim or download an approved backup write operation",async t=>{
 const f=await fixture(t), root=await realpath(await mkdtemp(join(tmpdir(),"lightmoni-operations-api-")));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ["source","backups","agent"])await mkdir(join(root,dir),{mode:0o700});
 const original="<h1>Backup source remains untouched</h1>";
 await writeFile(join(root,"source","index.html"),original,{mode:0o600});
 const created=await f.req("/operations/resources","POST",{kind:"backup",name:"Website backup",agent_id:"agent-1",config:{source_path:join(root,"source"),storage:{type:"local",path:join(root,"backups")}}});
 assert.equal(created.status,201);const resource=created.body.resource;
 const planned=await f.req(`/operations/resources/${resource.id}/plans`,"POST",{operation:"create"});assert.equal(planned.status,201);
 const plan=planned.body.run;
 const approved=await f.req(`/operations/runs/${plan.id}/approve`,"POST",{revision:resource.revision});assert.equal(approved.status,200);
 assert.equal(approved.body.run.state,"queued");
 const jobID=approved.body.run.job_id;assert.ok(jobID);
 assert.deepEqual(f.jobs.get(jobID).capabilities,["operations.backup"]);
 const requests:Array<{path:string;method:string;body:any}>=[];
 const runner=new AgentJobRunner({endpoint:f.base,agentID:"agent-1",controlCredential:"control-secret",dataDir:join(root,"agent"),now:()=>new Date("2026-10-27T00:00:00Z")},{
   fetch:async(input,init)=>{
     const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
     requests.push({path:new URL(url).pathname,method:init?.method??"GET",body:typeof init?.body==="string"?JSON.parse(init.body):undefined});
     return fetch(input,init);
   },
 });
 assert.equal(await runner.pollOnce(),null);
 assert.equal(await runner.pollOnce(),null);
 assert.equal(requests.length,2);
 for(const request of requests){
   assert.equal(request.path,"/api/v1/agents/agent-1/jobs/claim");assert.equal(request.method,"POST");
   assert.ok(request.body.capabilities.length>0);
   assert.ok(request.body.capabilities.every((cap:string)=>cap==="systemd.probe"||cap==="docker.inventory"||cap.startsWith("health.")),"ordinary Agent must advertise only read-only capabilities");
 }
 assert.ok(!requests.some(request=>request.path.endsWith("/operations")),"private operation payload must not be downloaded");
 const saved=f.ops.getRun(plan.id);assert.equal(saved.state,"queued");assert.deepEqual(saved.receipt,{});
 const queued=f.jobs.get(jobID);assert.equal(queued.state,"queued");assert.equal(queued.lease_id,"");assert.equal(queued.attempts,0);assert.deepEqual(queued.receipt,{});
 assert.equal(JSON.stringify(saved).includes("control-secret"),false);
 assert.deepEqual(await readdir(join(root,"backups")),[],"ordinary Agent must not create a backup");
 assert.deepEqual(await readdir(join(root,"agent")),[],"unclaimed writes must not create a local execution marker");
 assert.equal(await readFile(join(root,"source","index.html"),"utf8"),original);
});

test("read-only jobs serialize domain work and mismatched receipts cannot succeed",async t=>{
 const f=await fixture(t),r=(await f.create()).body.resource,p=f.ops.plan(r.id,"inspect",{},"admin");f.ops.approve(p.id,"admin",1);
 const old=f.jobs.enqueue({agentID:"agent-1",deploymentID:"old",operationID:"old",actions:[],capabilities:["health.tcp"]});
 const readLease=f.jobs.claim("agent-1",["health.tcp"])!; assert.equal(readLease.id,old.id);
 assert.equal(f.jobs.claim("agent-1",["operations.certificate"]),null);
 f.jobs.result("agent-1",old.id,{lease_id:readLease.lease_id,state:"failed",summary:"read-only task complete"});
 const j=f.jobs.claim("agent-1",["operations.certificate"])!;
 for(const [i,phase]of["accepted","staging","activating","verifying"].entries())f.jobs.event("agent-1",j.id,{lease_id:j.lease_id,sequence:i+1,phase,summary:"step"});
 f.jobs.result("agent-1",j.id,{lease_id:j.lease_id,state:"succeeded",summary:"claimed",snapshot:{health:{healthy:true},operations:{operation_id:"wrong",resource_id:r.id}}});
 assert.equal(f.ops.getRun(p.id).state,"unknown");
});

test("operations reject member actions, stale approvals, busy edits and expired plans",async t=>{
 const f=await fixture(t);assert.equal((await f.req("/operations/resources","GET",undefined,{"x-role":"member"})).status,403);
 const r=(await f.create()).body.resource;
 const draft=(await f.req(`/operations/resources/${r.id}/plans`,"POST",{operation:"install"})).body.run;
 assert.equal((await f.req(`/operations/resources/${r.id}`,"PUT",{revision:1,config:{domains:["example.org"]}})).status,200);
 assert.equal((await f.req(`/operations/runs/${draft.id}/approve`,"POST",{revision:1})).status,409);
 const fresh=(await f.req(`/operations/resources/${r.id}/plans`,"POST",{operation:"inspect"})).body.run;
 f.advance(31*60_000);assert.equal((await f.req(`/operations/runs/${fresh.id}/approve`,"POST",{revision:2})).status,409);
 const active=(await f.req(`/operations/resources/${r.id}/plans`,"POST",{operation:"inspect"})).body.run;
 assert.equal((await f.req(`/operations/runs/${active.id}/approve`,"POST",{revision:2})).status,200);
 assert.equal((await f.req(`/operations/resources/${r.id}`,"PUT",{revision:2,config:{domains:["x.com"]}})).status,409);
 const tools=operationTools(f.ops);assert.equal(tools.some(x=>/approve|execute/.test(x.name)),false);
 await assert.rejects(()=>tools[0].execute({},new AbortController().signal,{id:"member",role:"member"} as any),/administrator/);
});

test("operations lifecycle updates only from actual verified Agent receipts",async t=>{
 const f=await fixture(t),r=(await f.create()).body.resource;
 const p=f.ops.plan(r.id,"inspect",{},"admin");f.ops.approve(p.id,"admin",1); const j=f.jobs.claim("agent-1",["operations.certificate"])!;
 for(const [i,phase] of ["accepted","staging","activating","verifying"].entries())f.jobs.event("agent-1",j.id,{lease_id:j.lease_id,sequence:i+1,phase,summary:"registered step"});
 f.jobs.result("agent-1",j.id,{lease_id:j.lease_id,state:"succeeded",summary:"verified",snapshot:{health:{healthy:true},operations:{operation_id:p.id,resource_id:r.id,data:{installed:false}}}});
 assert.equal(f.ops.getRun(p.id).state,"succeeded");
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
