import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerOperations } from "../src/server/operations.js";
import { registerOperationsPlatform } from "../src/ops/index.js";
import { getCertificateMaterial } from "../src/ops/certificates.js";
import { certificateChain } from "./fixtures/certificate-material.js";
import { AgentJobRunner } from "../src/agent/jobs.js";
import type { Dependencies } from "../src/shared/types.js";
async function setup(t: any, certificate?: Parameters<typeof registerOperationsPlatform>[1]["certificate"], bindAll=false) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "lightmoni-platform-api-")),
    ),
    db = new DB(join(root, "control.db")),
    router = new Router();
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','Admin','admin',1),('member','Member','member',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);CREATE TABLE services(id TEXT PRIMARY KEY)",
  );
  db.run(
    "INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)",
    "node-a",
    "host-a",
    "Test node",
    "test",
    "linux",
    "amd64",
    new Date().toISOString(),
    "default",
    "{}",
  );
  const deps = {
    db,
    router,
    ...cipher(Buffer.alloc(32, 14)),
    now: () => new Date(),
    logger: { info() {}, warn() {}, error() {} },
    auth: {
      requireAdmin: (ctx: any) => {
        if (ctx.user.role !== "admin") fail(403, "administrator_required");
      },
      user: (req: any) => ({
        id: req.headers["x-role"] === "member" ? "member" : "admin",
        name: "Test",
        role: req.headers["x-role"] ?? "admin",
      }),
    },
  } as unknown as Dependencies;
  router.auth = deps.auth;
  const credentials = {
    has: (agentID: string, audience: string) => !!db.get('SELECT id FROM agents WHERE id=?',agentID) && audience === "control",
    authenticate(req: any, agentID: string) {
      if (
        !db.get('SELECT id FROM agents WHERE id=?',agentID) ||
        req.headers.authorization !== "Bearer qa-control"
      )
        fail(403, "invalid_agent_credential");
      return { agent_id: agentID };
    },
  } as any;
  const jobs = registerAgentJobs(deps, { agentCredentials: credentials }),
    platform = registerOperationsPlatform(deps, { jobs, dataDir: root, certificate });
  db.exec(
    "CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines VALUES('machine-a','Test node','127.0.0.1','node-a')",
  );
  const cluster = platform.store.create(
    "cluster",
    "API cluster",
    {
      machine_ids: ["machine-a"],
      nodes: [
        {
          machine_id: "machine-a",
          address: "127.0.0.1",
          cpu: 4,
          memory_mb: 4096,
        },
      ],
    },
    "admin",
  );
  const legacy = registerOperations(deps, {
    jobs,
    credentials,
    definitions: [],
    resolvePayload: platform.resolvePayload,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  server.listen(0, bindAll?"0.0.0.0":"127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  t.after(async () => {
    await platform.close();
    legacy.close?.();
    jobs.close?.();
    server.close();
    server.closeAllConnections();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const req = async (
    path: string,
    method = "GET",
    body?: any,
    headers: any = {},
  ) => {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const create = async (kind: string, name: string, spec: any) => {
    if (kind === "gateway_group") {
      kind = "application";
      spec = {
        deployments: [{ cluster_id: cluster.id, machine_ids: ["machine-a"] }],
        role: "openresty",
        deployment_mode: "manual",
        mode: "container",
        image: "openresty/openresty:1.27.1.2-0-alpine",
        ports: [
          { name: "http", host_port: 80, container_port: 80 },
          { name: "https", host_port: 443, container_port: 443 },
        ],
      };
    } else if (kind === "application")
      spec = {
        ...spec,
        deployments: [{ cluster_id: cluster.id, machine_ids: ["machine-a"] }],
        deployment_mode: "manual",
        ports: (spec.ports ?? []).map((p: any, n: number) => ({
          ...p,
          name: p.name ?? "port-" + n,
        })),
      };
    else if (kind === "website")
      spec = {
        ...spec,
        cluster_ids: [cluster.id],
        bindings: [
          {
            domains: spec.domains,
            https: spec.https,
            certificate_id: spec.certificate_id,
            locations: (spec.locations ?? []).map((l: any) => ({
              ...l,
              upstreams: undefined,
              cluster_targets: [
                {
                  cluster_id: cluster.id,
                  target: "proxy",
                  upstreams: l.upstreams,
                },
              ],
            })),
          },
        ],
      };
    const r = await req("/ops/resources", "POST", { kind, name, spec });
    assert.equal(r.status, 201, JSON.stringify(r));
    return r.body.resource;
  };
  const action = (resource: any, action: string, input: any = {}) =>
    req("/ops/resources/" + resource.id + "/actions", "POST", {
      revision: resource.revision,
      confirmed: true,
      action,
      input,
    });
  const runner = new AgentJobRunner({
    endpoint: base,
    agentID: "node-a",
    controlCredential: "qa-control",
    dataDir: join(root, "agent"),
  });
  return {
    base,
    deps,
    root,
    db,
    jobs,
    platform,
    req,
    create,
    action,
    runner,
    cluster,
  };
}
test("administrators view public certificate material and download immutable versions without exposing private keys elsewhere", async t => {
  const f = await setup(t);
  const cert = await f.create("certificate", "download \"证书", {source:"self_signed",domains:["download.example.test"],validity_days:3});
  for (let n=0;n<200&&!f.platform.store.get(cert.id).status.certificate_version;n++) await new Promise(resolve=>setTimeout(resolve,10));
  const material = getCertificateMaterial(f.platform.store,cert.id);
  const path = "/ops/resources/"+cert.id+"/certificate";
  const response = await fetch(f.base+"/api/v1"+path), view = (await response.json() as any).certificate;
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(view.certificate_version,material.certificate_version);
  assert.equal(view.chain_length,1);assert.equal(view.chain_pem,"");
  assert.equal(new X509Certificate(view.certificate_pem).fingerprint256,material.fingerprint_sha256);
  assert.deepEqual(view.domains,["download.example.test"]);
  assert.ok(!JSON.stringify(view).includes("PRIVATE KEY"));assert.ok(!("private_key_pem" in view));
  const download = (version:unknown,format:unknown,role="admin",origin?:string) => fetch(f.base+"/api/v1"+path+"/download",{method:"POST",headers:{"content-type":"application/json","x-role":role,...(origin?{origin}:{})},body:JSON.stringify({version,format})});
  for (const [format,expected,name] of [["cert",view.certificate_pem,"cert.pem"],["fullchain",view.fullchain_pem,"fullchain.pem"],["private_key",material.private_key_pem,"privkey.pem"]]) {
    const result=await download(view.certificate_version,format);
    assert.equal(result.status,200);assert.equal(result.headers.get("cache-control"),"no-store");assert.equal(result.headers.get("x-content-type-options"),"nosniff");
    assert.equal(result.headers.get("content-type"),"application/x-pem-file");assert.match(result.headers.get("content-disposition")!,new RegExp('^attachment; filename="[A-Za-z0-9_-]+-'+name+'"$'));
    assert.equal(await result.text(),expected);
  }
  assert.ok(new X509Certificate(view.certificate_pem).checkPrivateKey(createPrivateKey(material.private_key_pem)));
  assert.equal((await download(view.certificate_version,"chain")).status,409);
  assert.equal((await f.req(path,"GET",undefined,{"x-role":"member"})).status,403);
  const denied=await download(view.certificate_version,"private_key","member");assert.equal(denied.status,403);assert.equal(denied.headers.get("cache-control"),"no-store");assert.ok(!(await denied.text()).includes("PRIVATE KEY"));
  assert.equal((await download(view.certificate_version,"private_key","admin","https://evil.example")).status,403);
  assert.equal((await download("../key","private_key")).status,400);
  assert.equal((await download(view.certificate_version,"zip")).status,400);
  assert.equal((await download(undefined,"private_key")).status,400);
  const other=f.platform.store.create("certificate","not issued",{source:"self_signed",domains:["other.example.test"]},"admin");
  assert.equal((await f.req("/ops/resources/"+other.id+"/certificate")).body.error,"certificate_not_issued");
  assert.equal((await download(other.id,"private_key")).status,409);
  assert.equal((await f.req("/ops/resources/"+f.cluster.id+"/certificate")).status,400);
  // A renewal changes the active version; an open viewer must still download its original pair.
  const issue=await f.action(f.platform.store.get(cert.id),"issue");let run=issue.body.run;
  for(let n=0;n<200&&run.state==='running';n++){await new Promise(resolve=>setTimeout(resolve,10));run=(await f.req('/ops/runs/'+run.id)).body;}
  assert.equal(run.state,"succeeded");assert.notEqual(getCertificateMaterial(f.platform.store,cert.id).certificate_version,view.certificate_version);
  assert.equal(await(await download(view.certificate_version,"private_key")).text(),material.private_key_pem);
  f.platform.store.patchStatus(cert.id,{state:"failed",last_error:"renew_failed"});
  assert.equal((await f.req(path)).status,200);
  for(const snapshot of [(await f.req('/ops/overview')).body,(await f.req('/ops/resources/'+cert.id)).body,(await f.req('/ops/runs')).body]){
    assert.ok(!JSON.stringify(snapshot).includes("BEGIN CERTIFICATE"));assert.ok(!JSON.stringify(snapshot).includes("PRIVATE KEY"));
  }
});

async function issuedCertificate(f:Awaited<ReturnType<typeof setup>>,domain='cluster.example.test'){
 const certificate=await f.create('certificate','ignored display name',{source:'self_signed',domains:[domain],validity_days:3});
 for(let n=0;n<200&&!f.platform.store.get(certificate.id).status.certificate_version;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(f.platform.store.get(certificate.id).status.certificate_version);return f.platform.store.get(certificate.id);
}
test('new certificates derive normalized single-domain names while old multi-domain records and references remain intact',async t=>{
 const f=await setup(t),single=await issuedCertificate(f,'*.Example.TEST');assert.equal(single.name,'*.example.test');
 const response=await f.req('/ops/resources','POST',{kind:'certificate',spec:{source:'self_signed',domains:['other.example.test']}});assert.equal(response.status,201);assert.equal(response.body.resource.name,'other.example.test');
 const invalid=await f.req('/ops/resources','POST',{kind:'certificate',name:'anything',spec:{source:'self_signed',domains:['one.example.test','two.example.test']}});assert.equal(invalid.status,400);assert.equal(invalid.body.error,'certificate_single_domain_required');
 const edited=f.platform.store.update(single.id,single.revision,'arbitrary alias',single.spec,'admin');assert.equal(edited.name,'*.example.test');
 const legacy=f.platform.store.create('certificate','old',{source:'self_signed',domains:['legacy.example.test']},'admin');
 const spec={...legacy.spec,domains:['legacy.example.test','*.legacy.example.test']},encrypted=f.deps.encrypt(JSON.stringify(spec));
 f.db.run('UPDATE ops_platform_resources SET name=?,spec_cipher=? WHERE id=?','Historical display name',encrypted,legacy.id);f.db.run('UPDATE ops_platform_revisions SET spec_cipher=? WHERE resource_id=?',encrypted,legacy.id);
 const read=(await f.req('/ops/resources/'+legacy.id)).body.resource;assert.equal(read.name,'legacy.example.test · *.legacy.example.test');assert.deepEqual(read.spec.domains,spec.domains);
 const saved=f.platform.store.update(legacy.id,legacy.revision,'ignored',spec,'admin');assert.deepEqual(saved.spec.domains,spec.domains);
 assert.throws(()=>f.platform.store.update(saved.id,saved.revision,'ignored',{...spec,domains:['legacy.example.test']},'admin'),/single_domain_required/);
 assert.equal(f.platform.store.get(saved.id).revision,saved.revision);
});
test("unimplemented host actions reject before changing desired deployments, instances, runs or jobs",async t=>{
 const f=await setup(t),app=await f.create('application','Guarded app',{mode:'container',image:'nginx:1.27.5'});
 const website=await f.create('website','Guarded website',{mode:'static',domains:['guarded.example.test'],static_files:{'index.html':'hello'}});
 const saved=()=>({resources:f.db.all('SELECT * FROM ops_platform_resources ORDER BY id'),applications:f.db.all('SELECT * FROM ops_platform_application_deployments'),websites:f.db.all('SELECT * FROM ops_platform_website_deployments'),instances:f.db.all('SELECT * FROM ops_cluster_instances'),runs:f.db.all('SELECT * FROM ops_platform_runs'),jobs:f.db.all('SELECT * FROM agent_jobs')});
 const before=saved();
 for(const [resource,actions] of [[app,['deploy','inspect','stop','remove','logs','reconcile']],[website,['deploy','disable']],[f.cluster,['inspect']]] as const)
  for(const action of actions){const response=await f.action(resource,action);assert.equal(response.status,409,JSON.stringify({action,response}));assert.equal(response.body.error,'privileged_profile_not_implemented');}
 assert.deepEqual(saved(),before);
 assert.equal((await f.req('/ops/resources/'+app.id+'/actions','POST',{revision:app.revision,action:'deploy',confirmed:true},{'x-role':'member'})).status,403);
 assert.deepEqual(saved(),before);
});

test("platform queue and private payload resolver reject before inspecting arguments or decrypting",async t=>{
 const f=await setup(t);
 f.deps.decrypt=()=>{throw Error('removed channel decrypted data');};f.jobs.enqueue=()=>{throw Error('removed channel enqueued a job');};
 const poisoned=new Proxy({}, {get(){throw Error('removed channel inspected arguments');}});
 assert.throws(()=>f.platform.store.queue(poisoned as any,'node-a','deploy',poisoned,'admin'),/privileged_profile_not_implemented/);
 assert.throws(()=>f.platform.resolvePayload(poisoned),/legacy_agent_payload_removed/);
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
});

test("catalog confirmed installation rejects before resource creation while draft registration remains available",async t=>{
 const f=await setup(t),before=f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_resources')!.n;
 const input={name:'Catalog draft',deployment_mode:'manual',deployments:[{cluster_id:f.cluster.id,machine_ids:['machine-a']}],parameters:{},confirmed:true};
 const denied=await f.req('/ops/catalog/openresty/install','POST',input);assert.equal(denied.status,409);assert.equal(denied.body.error,'privileged_profile_not_implemented');
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_resources')!.n,before);
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_cluster_instances')!.n,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
 const draft=await f.req('/ops/catalog/openresty/install','POST',{...input,confirmed:false});assert.equal(draft.status,201,JSON.stringify(draft));assert.ok(draft.body.resource.id);
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
});

test("all host certificate targets reject before requiring, issuing or delivering private material",async t=>{
 const f=await setup(t),certificate=f.platform.store.create('certificate','Unissued',{source:'self_signed',domains:['unissued.example.test']},'admin');
 const targets=[
  await f.create('certificate_target','Cluster directory',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path:'/tmp/guarded-cluster-tls',enabled:true}),
  await f.create('certificate_target','Host directory',{certificate_id:certificate.id,type:'directory',agent_id:'node-a',path:'/tmp/guarded-host-tls',enabled:true}),
  await f.create('certificate_target','Host hook',{certificate_id:certificate.id,type:'hook',agent_id:'node-a',script:'exit 0',interpreter:'/bin/sh',enabled:true}),
 ];
 const before=f.db.all('SELECT * FROM ops_platform_resources ORDER BY id');
 for(const target of targets)for(const action of ['sync','inspect','retry']){const response=await f.action(target,action);assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');}
 assert.deepEqual(f.db.all('SELECT * FROM ops_platform_resources ORDER BY id'),before);
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);assert.equal(f.platform.store.get(certificate.id).status.certificate_version,undefined);
});

test("private registry host writes reject before creating system resources or changing cache settings",async t=>{
 const f=await setup(t),saved=()=>({resources:f.db.all('SELECT * FROM ops_platform_resources'),settings:f.db.all('SELECT * FROM ops_private_registry_settings'),systems:f.db.all('SELECT * FROM ops_system_applications')});const before=saved();
 for(const [path,method] of [['/ops/private-registry/deployments','POST'],['/ops/private-registry/external','PUT'],['/ops/private-registry/clusters/'+f.cluster.id+'/cache','PUT']]){
  const response=await f.req(path,method,{confirmed:true,revision:f.cluster.revision,cluster_id:f.cluster.id,machine_id:'machine-a',enabled:true});assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');
 }
 assert.deepEqual(saved(),before);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);assert.equal((await f.req('/ops/private-registry')).status,200);
});

test("uploaded signed chains split into leaf and intermediate attachments with a matching private key",async t=>{
 const f=await setup(t),material=await certificateChain(),cert=await f.create('certificate','chain download',{source:'uploaded',domains:['download.example.test'],...material});
 for(let n=0;n<200&&!f.platform.store.get(cert.id).status.certificate_version;n++)await new Promise(resolve=>setTimeout(resolve,10));
 const path='/ops/resources/'+cert.id+'/certificate',view=(await f.req(path)).body.certificate;
 assert.equal(view.chain_length,2);assert.ok(new X509Certificate(view.certificate_pem).verify(new X509Certificate(view.chain_pem).publicKey));
 assert.equal(view.fullchain_pem,view.certificate_pem+view.chain_pem);
 const result=await fetch(f.base+'/api/v1'+path+'/download',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:view.certificate_version,format:'chain'})});
 assert.equal(result.status,200);assert.equal(await result.text(),view.chain_pem);
 const other=f.platform.store.create('certificate','Other',{source:'self_signed',domains:['other.example.test']},'admin');
 const wrong=await f.req('/ops/resources/'+other.id+'/certificate/download','POST',{version:view.certificate_version,format:'private_key'});assert.equal(wrong.status,409);assert.equal(wrong.body.error,'certificate_version_missing');
});
test("certificate create and manual issuance return while ACME is blocked; progress, cause and secrets are handled durably", {timeout:10000}, async (t) => {
  let release!: () => void, started!: () => void;
  let gate = new Promise<void>(resolve => {release = resolve;});
  const entered = new Promise<void>(resolve => {started = resolve;});
  let registrations = 0;
  const secret = "qa-private-cloud-secret-053", eab = "qa-private-eab-053";
  const f = await setup(t, {acmeClientFactory: (() => ({
    createAccount: async () => {registrations++; started(); await gate; throw Object.assign(new Error('ACME rejected account: contact domain denied; token='+eab+' secret='+secret+' https://ca.example.test/problem?token=private-query'),{code:secret,request_id:'prefix-'+secret});},
  })) as any});
  const credential = await f.create("credential", "DNS", {provider:"aliyun",access_key_id:"qa-cloud-id-053",access_key_secret:secret});
  const zone = await f.create("dns_zone", "Zone", {domain:"example.test",credential_id:credential.id});
  const account = await f.create("acme_account", "CA", {email:"ops@example.test",directory_url:"letsencrypt-staging",terms_agreed:true,eab_kid:"qa-eab-kid-053",eab_hmac_key:eab});
  try {
    const response = await f.req('/ops/resources','POST',{kind:'certificate',name:'Async certificate',spec:{source:'acme',domains:['example.test'],acme_account_id:account.id,dns_zone_ids:[zone.id],auto_renew:false}});
    assert.equal(response.status,201,JSON.stringify(response));
    const {resource,run}=response.body;
    assert.equal(resource.status.state,'issuing'); assert.equal(run.state,'running');
    await entered;
    const active = await f.req('/ops/runs/'+run.id+'/events');
    assert.equal(active.body.run.state,'running');
    assert(active.body.events.some((e:any)=>e.phase==='acme_account'&&e.state==='running'));
    const duplicate = await f.action(resource,'issue');
    assert.equal(duplicate.status,202); assert.equal(duplicate.body.run.id,run.id); assert.equal(registrations,1);
    assert.equal((await f.action(resource,'issue','invalid input')).status,400);
    assert.equal((await f.req('/ops/runs/'+run.id+'/events','GET',undefined,{'x-role':'member'})).status,403);
    assert.equal((await f.req('/ops/runs/'+run.id+'/events?after=-1')).status,400);
    release();
    let receipt:any;
    for(let attempt=0;attempt<100;attempt++) {receipt=(await f.req('/ops/runs/'+run.id+'/events')).body;if(receipt.run.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(receipt.run.state,'failed');
    assert.equal(receipt.run.result.phase,'acme_account');
    assert.match(receipt.run.result.message,/contact domain denied/);
    assert.doesNotMatch(JSON.stringify(receipt),new RegExp(secret+'|'+eab+'|private-query|payload_cipher|BEGIN PRIVATE'));
    assert.deepEqual(receipt.events.map((e:any)=>e.sequence),receipt.events.map((_:any,i:number)=>i+1));
    assert(receipt.events.some((e:any)=>e.phase==='acme_account'&&e.state==='failed'));
    const cursor=receipt.events.at(-2).sequence;
    assert.equal((await f.req('/ops/runs/'+run.id+'/events?after='+cursor)).body.events.length,1);
    const updated=await f.req('/ops/resources/'+resource.id,'PUT',{name:'Edited',revision:1,spec:{...resource.spec,auto_renew:false}});
    assert.equal(updated.status,200,JSON.stringify(updated));
    assert.equal(f.platform.store.actions(resource.id).length,1);
    gate=new Promise<void>(resolve=>{release=resolve;});
    const manual=await f.action(updated.body.resource,'issue');
    assert.equal(manual.status,202);assert.notEqual(manual.body.run.id,run.id);assert.equal(manual.body.run.state,'running');
    release();
  } finally {release();}
});
test("historical log receipts remain readable beyond the overview limit and are redacted and admin-only", async (t) => {
  const f = await setup(t);
  const old = await f.platform.store.run(f.cluster, "inspect", "admin", async () => ({ state: "succeeded", stdout: "private-command-output" }));
  for (let i=0;i<101;i++) f.db.run("INSERT INTO ops_platform_runs(id,resource_id,resource_revision,agent_id,action,state,payload_cipher,result_json,job_id,actor,dedupe_key,created_at,updated_at) SELECT ?,resource_id,resource_revision,agent_id,action,state,payload_cipher,result_json,job_id,actor,NULL,created_at,updated_at FROM ops_platform_runs WHERE id=?",'new-'+i,old.id);
  assert(!(await f.req('/ops/runs')).body.runs.some((r:any)=>r.id===old.id));
  const receipt=await f.req('/ops/runs/'+old.id);assert.equal(receipt.status,200);assert.equal(receipt.body.id,old.id);assert.doesNotMatch(JSON.stringify(receipt.body),/private-command-output|payload_cipher/);
  assert.equal((await f.req('/ops/runs/'+old.id,'GET',undefined,{'x-role':'member'})).status,403);
  assert.equal((await f.req('/ops/runs/missing')).status,404);
});
test("real platform HTTP checks role, confirmation and revision with saved state readback", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.req("/ops/overview", "GET", undefined, { "x-role": "member" }))
      .status,
    403,
  );
  const app = await f.create("application", "API app", {
    mode: "container",
    image: "nginx:1.27.5",
    agent_ids: ["node-a"],
    environment: { PRIVATE_VALUE: "not-public" },
  });
  assert.equal(JSON.stringify(app).includes("not-public"), false);
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 0);
  assert.equal(
    (
      await f.req("/ops/resources/" + app.id + "/actions", "POST", {
        revision: 1,
        action: "deploy",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.req("/ops/resources/" + app.id, "PUT", {
        revision: 0,
        name: app.name,
        spec: { mode: "container", image: "nginx:1.27.5" },
      })
    ).status,
    409,
  );
  const read = await f.req("/ops/overview");
  assert.equal(read.status, 200);
  assert.equal(read.body.resources[0].id, app.id);
  assert.equal(read.body.agents[0].hostname, "Test node");
});
test("removed nodes disappear from deployment candidates and cannot become new deployment targets", async (t) => {
  const f = await setup(t);
  assert.equal((await f.req("/ops/overview")).body.agents.length, 1);
  f.db.run(
    "INSERT INTO agent_lifecycle(agent_id,state) VALUES('node-a','removed')",
  );
  assert.deepEqual((await f.req("/ops/overview")).body.agents, []);
  const saved = await f.req("/ops/resources", "POST", {
    kind: "application",
    name: "Removed target",
    spec: {
      mode: "container",
      image: "nginx:1.27.5",
      deployments: [{ cluster_id: f.cluster.id, machine_ids: ["machine-a"] }],
      deployment_mode: "manual",
    },
  });
  assert.equal(saved.status, 400);
  assert.equal(saved.body.error, "registered_agent_required");
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 0);
});
test("center certificate issuance and state inspection stay available without host execution",async t=>{
 const f=await setup(t),certificate=await issuedCertificate(f);
 const inspected=await f.action(certificate,'inspect');assert.equal(inspected.status,202);assert.equal(inspected.body.run.state,'succeeded');
 const website=await f.create('website','State only',{mode:'static',domains:['state.example.test'],static_files:{'index.html':'state'}});
 const state=await f.action(website,'inspect');assert.equal(state.status,202);assert.equal(state.body.run.state,'succeeded');
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);assert.ok(getCertificateMaterial(f.platform.store,certificate.id).certificate_pem.includes('BEGIN CERTIFICATE'));
});

test("unimplemented HTTPS deployment neither issues a certificate nor changes desired gateway state",async t=>{
 const f=await setup(t),certificate=f.platform.store.create('certificate','First certificate',{source:'self_signed',domains:['first.example.test'],auto_renew:false},'admin');
 const website=await f.create('website','First HTTPS',{mode:'static',domains:['first.example.test'],static_files:{'index.html':'first'},https:true,certificate_id:certificate.id});
 const before=f.db.all('SELECT * FROM ops_platform_website_deployments');
 const response=await f.action(website,'deploy');assert.equal(response.status,409);assert.equal(response.body.error,'privileged_profile_not_implemented');
 assert.equal(f.platform.store.get(certificate.id).status.certificate_version,undefined);assert.deepEqual(f.db.all('SELECT * FROM ops_platform_website_deployments'),before);
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
});

test("saved multi-path Nginx preview is administrator-only, redacted and does not deploy", async (t) => {
  const f = await setup(t);
  const group = await f.create("gateway_group", "Preview gateways", {
    agent_ids: ["node-a"],
    http_port: 18080,
    https_port: 18443,
  });
  const site = await f.create("website", "Multiple paths", {
    domains: ["routes.example.test"],
    gateway_group_id: group.id,
    mode: "proxy",
    nginx: { gzip: true, server_snippet: "client_body_timeout 45s;" },
    locations: [
      {
        path: "/api/",
        upstreams: [{ url: "http://127.0.0.1:3000", weight: 2 }],
        uri_mode: "strip_prefix",
        request_headers: { Authorization: "private-header-value" },
        custom_config: "proxy_cookie_path / /app/;",
      },
      {
        path: "/old",
        match: "exact",
        action: "return",
        return_status: 308,
        return_value: "https://$host/new",
      },
    ],
  });
  assert.equal(site.spec.bindings[0].locations.length, 2);
  const preview = await f.req(
    "/ops/resources/" + site.id + "/nginx?cluster_id=" + f.cluster.id,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.validated, false);
  assert.equal(preview.body.redacted, true);
  assert.ok(preview.body.config.includes('location "/api/"'));
  assert.ok(preview.body.config.includes("gzip on;"));
  assert.ok(preview.body.config.includes("[redacted]"));
  for (const value of [
    "private-header-value",
    "proxy_cookie_path",
    "client_body_timeout",
  ])
    assert.ok(!preview.body.config.includes(value));
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 0);
  assert.equal(
    (
      await f.req(
        "/ops/resources/" + site.id + "/nginx?cluster_id=" + f.cluster.id,
        "GET",
        undefined,
        {
          "x-role": "member",
        },
      )
    ).status,
    403,
  );
  const invalid = await f.req("/ops/resources/" + site.id, "PUT", {
    revision: site.revision,
    name: site.name,
    spec: {
      ...site.spec,
      bindings: [
        {
          ...site.spec.bindings[0],
          locations: [
            {
              ...site.spec.bindings[0].locations[0],
              custom_config: "} server { return 200; }",
            },
          ],
        },
      ],
    },
  });
  assert.equal(invalid.status, 400);
});

test('late operations observers project quarantined legacy jobs without decrypting or replaying and stay idempotent',async t=>{
 const f=await setup(t),at=f.deps.now().toISOString();
 for(const [name,state,attempts] of [['unclaimed','queued',0],['started','activating',1]] as const){
  const runID='legacy-'+name,jobID='job-'+name;
  f.db.run(`INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,target_json,issued_at,expires_at,attempts,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,jobID,'node-a','legacy-'+name,runID,state,JSON.stringify(['operations.platform']),JSON.stringify([{kind:'operations',operation_id:runID,domain:'platform'}]),JSON.stringify({operations_resource_id:f.cluster.id}),at,'2099-01-01T00:00:00Z',attempts,at,at);
  f.db.run('INSERT INTO ops_platform_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',runID,f.cluster.id,f.cluster.revision,'node-a','deploy',state,'unreadable-private-payload','{}',jobID,'admin',null,at,at);
  f.db.run('INSERT INTO ops_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',runID,f.cluster.id,f.cluster.revision,'apply',state,'unreadable-private-payload','{}',jobID,at,'2099-01-01T00:00:00Z','admin','admin',at);
 }
 await f.platform.close();f.jobs.close?.();
 let privateReads=0;const decrypt=f.deps.decrypt;
 f.deps.decrypt=(value:string)=>{if(value==='unreadable-private-payload'){privateReads++;throw Error('removed payload was decrypted');}return decrypt(value);};
 const credentials={has:()=>true,authenticate(){}} as any;
 const jobs=registerAgentJobs(f.deps,{agentCredentials:credentials});t.after(()=>jobs.close?.());
 const platform=registerOperationsPlatform(f.deps,{jobs,dataDir:f.root,intervalMs:0});t.after(()=>platform.close());
 const legacy=registerOperations(f.deps,{jobs,credentials,definitions:[]});t.after(()=>legacy.close?.());
 for(const [name,state] of [['unclaimed','cancelled'],['started','unknown']] as const){
  const runID='legacy-'+name,run=platform.store.action(runID);
  assert.equal(run.state,state);assert.deepEqual(run.result,{code:'legacy_agent_write_removed'});
  assert.equal(f.db.get<any>('SELECT state FROM ops_runs WHERE id=?',runID)!.state,state);
  assert.equal(jobs.get('job-'+name).attempts,name==='unclaimed'?0:1);
  assert.equal(platform.store.runEvents(runID).length,1);
 }
 assert.equal(privateReads,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,2);
 const eventCount=f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_run_events')!.n;
 await platform.close();
 const again=registerOperationsPlatform(f.deps,{jobs,dataDir:f.root,intervalMs:0});t.after(()=>again.close());
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_run_events')!.n,eventCount);
 assert.equal(privateReads,0);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_job_events')!.n,2);
});
