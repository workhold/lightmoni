import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { mkdtemp, realpath, readFile, stat, rm } from "node:fs/promises";
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
  const finish = () => {
    const job = jobs.claim("node-a", ["operations.platform"])!;
    const payload = platform.resolvePayload(job);
    for (const [n, phase] of [
      "accepted",
      "staging",
      "activating",
      "verifying",
    ].entries())
      jobs.event("node-a", job.id, {
        lease_id: job.lease_id,
        sequence: n + 1,
        phase,
        summary: "fixture",
      });
    jobs.result("node-a", job.id, {
      lease_id: job.lease_id,
      state: "succeeded",
      summary: "fixture",
      snapshot: {
        health: { healthy: true },
        operations: {
          operation_id: payload.operation_id,
          resource_id: payload.resource.id,
          data: { healthy: true, running: true },
        },
      },
    });
  };
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
    finish,
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
function clusterNode(f:Awaited<ReturnType<typeof setup>>,suffix:string,connected=true){
 if(connected)f.db.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)','node-'+suffix,'host-'+suffix,'Node '+suffix,'test','linux','arm64',new Date().toISOString(),'default','{}');
 f.db.run('INSERT INTO managed_machines VALUES(?,?,?,?)','machine-'+suffix,'Machine '+suffix,'127.0.0.1',connected?'node-'+suffix:null);
 const cluster=f.platform.store.get(f.cluster.id);f.cluster=f.platform.store.update(cluster.id,cluster.revision,cluster.name,{...cluster.spec,machine_ids:[...cluster.spec.machine_ids,'machine-'+suffix]},'admin');
}
function certificateReceipt(f:Awaited<ReturnType<typeof setup>>,agentID:string,state='succeeded',job=f.jobs.claim(agentID,['operations.platform'])!){
 assert.ok(job);const payload=f.platform.resolvePayload(job),config=payload.resource.config;
 for(const [n,phase] of ['accepted','staging','activating','verifying'].entries())f.jobs.event(agentID,job.id,{lease_id:job.lease_id,sequence:n+1,phase:phase as any,summary:'certificate QA'});
 f.jobs.result(agentID,job.id,{lease_id:job.lease_id,state:state as any,summary:'certificate QA',snapshot:{health:{healthy:state==='succeeded'},operations:{operation_id:payload.operation_id,resource_id:payload.resource.id,data:state==='succeeded'?{certificate_version:config.certificate_version,fingerprint_sha256:config.fingerprint_sha256}:{error:'qa_directory_failed'}}}});
 return payload;
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
test('cluster directory delivery tracks all machines, retains partial success, retries only failed members, and deduplicates beyond the history page',async t=>{
 const f=await setup(t);clusterNode(f,'b');const certificate=await issuedCertificate(f);
 const target=await f.create('certificate_target','Cluster TLS',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path:'/tmp/cluster-tls',enabled:true});
 const sync=await f.action(target,'sync');assert.equal(sync.status,202);assert.equal(sync.body.runs.length,2);
 assert.equal((await f.action(target,'sync')).body.runs.length,2);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,2);
 certificateReceipt(f,'node-a');let status=f.platform.store.get(target.id).status;assert.notEqual(status.state,'applied');assert.equal(status.applied_certificate_version,null);
 certificateReceipt(f,'node-b','failed');status=f.platform.store.get(target.id).status;assert.equal(status.state,'failed');assert.equal(status.machines.find((m:any)=>m.agent_id==='node-a').state,'applied');
 await f.platform.tick();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,2);
 const retry=await f.action(target,'retry');assert.equal(retry.body.runs.filter((r:any)=>r.state==='queued').length,1);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,3);certificateReceipt(f,'node-b');
 status=f.platform.store.get(target.id).status;assert.equal(status.state,'applied');assert.equal(status.applied_certificate_version,certificate.status.certificate_version);assert.equal(status.machines.length,2);
 for(let n=0;n<105;n++)await f.platform.store.run(f.platform.store.get(target.id),'historical_read','admin',async()=>({verified:true}));
 await f.action(target,'sync');await f.platform.tick();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,3);
 clusterNode(f,'c');await f.action(target,'retry');assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,3);await f.platform.tick();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,4);assert.notEqual(f.platform.store.get(target.id).status.state,'applied');certificateReceipt(f,'node-c');assert.equal(f.platform.store.get(target.id).status.state,'applied');
 assert.doesNotMatch(JSON.stringify((await f.req('/ops/overview')).body),/BEGIN (?:RSA )?PRIVATE KEY|BEGIN CERTIFICATE/);
});
test('unknown cluster writes require successful per-machine inspection and do not replay during ordinary or automatic synchronization',async t=>{
 const f=await setup(t);clusterNode(f,'b');const certificate=await issuedCertificate(f),target=await f.create('certificate_target','Unknown cluster',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path:'/tmp/unknown-tls',enabled:true});
 await f.action(target,'sync');certificateReceipt(f,'node-a');certificateReceipt(f,'node-b','unknown');
 assert.equal(f.platform.store.get(target.id).status.state,'unknown');assert.equal((await f.action(target,'retry')).status,409);
 await f.action(target,'sync');await f.platform.tick();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,2);
 const inspected=await f.action(target,'inspect');assert.equal(inspected.body.runs.length,2);certificateReceipt(f,'node-a');certificateReceipt(f,'node-b');assert.equal(f.platform.store.get(target.id).status.state,'applied');
 await f.action(target,'retry');assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,4);
});
test('a cancelled cluster member stays failed until explicit retry and cannot be mistaken for applied',async t=>{
 const f=await setup(t);clusterNode(f,'b');const certificate=await issuedCertificate(f),target=await f.create('certificate_target','Cancelled member',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path:'/tmp/cancelled-tls',enabled:true});
 const sync=await f.action(target,'sync'),cancelled=sync.body.runs.find((r:any)=>r.agent_id==='node-b');f.jobs.cancelQueuedDeployment('platform-'+target.id,cancelled.id,'admin');
 assert.equal(f.platform.store.get(target.id).status.state,'failed');await f.platform.tick();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,2);
 await f.action(target,'retry');assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,3);certificateReceipt(f,'node-a');certificateReceipt(f,'node-b');assert.equal(f.platform.store.get(target.id).status.state,'applied');
});
test('cluster delivery rejects empty or unready membership before dispatch and fences leaving or rebound machines, removed Agents and stale certificate payloads',async t=>{
 const f=await setup(t);clusterNode(f,'b',false);const certificate=await issuedCertificate(f),target=await f.create('certificate_target','Scope fence',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path:'/tmp/fence-tls'});
 assert.equal((await f.action(target,'sync')).status,409);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
 f.db.run('UPDATE managed_machines SET agent_id=? WHERE id=?','node-a','machine-b');assert.equal((await f.action(target,'sync')).status,409);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
 f.db.run('DELETE FROM managed_machines WHERE id=?','machine-b');const cluster=f.platform.store.get(f.cluster.id);f.cluster=f.platform.store.update(cluster.id,cluster.revision,cluster.name,{...cluster.spec,machine_ids:['machine-a']},'admin');
 await f.action(target,'sync');const job=f.jobs.claim('node-a',['operations.platform'])!;assert.ok(f.platform.resolvePayload(job).resource.config.private_key_pem);
 f.db.run('UPDATE managed_machines SET agent_id=NULL WHERE id=?','machine-a');assert.throws(()=>f.platform.resolvePayload(job),/membership_changed/);f.db.run('UPDATE managed_machines SET agent_id=? WHERE id=?','node-a','machine-a');
 f.db.run("INSERT INTO agent_lifecycle(agent_id,state) VALUES('node-a','removed')");assert.throws(()=>f.platform.resolvePayload(job),/membership_changed/);f.db.run("DELETE FROM agent_lifecycle WHERE agent_id='node-a'");
 f.platform.store.patchStatus(certificate.id,{certificate_version:'newer-version'});assert.throws(()=>f.platform.resolvePayload(job),/payload_version_changed/);f.platform.store.patchStatus(certificate.id,{certificate_version:certificate.status.certificate_version});
 const current=f.platform.store.get(f.cluster.id);f.platform.store.update(current.id,current.revision,current.name,{...current.spec,machine_ids:[],nodes:[]},'admin');assert.throws(()=>f.platform.resolvePayload(job),/membership_changed/);
 assert.equal((await f.action(target,'sync')).body.error,'certificate_cluster_empty');
 f.db.run("UPDATE users SET active=0 WHERE id='admin'");assert.throws(()=>f.platform.resolvePayload(job),/authorization_required/);
});
test('new certificate versions ignore late old-version receipts and restart retains each machine delivery identity',async t=>{
 const f=await setup(t);clusterNode(f,'b');const certificate=await issuedCertificate(f),target=await f.create('certificate_target','Version fencing',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path:'/tmp/version-tls'});
 await f.action(target,'sync');certificateReceipt(f,'node-a');const oldJob=f.jobs.claim('node-b',['operations.platform'])!,old=f.platform.resolvePayload(oldJob);
 const issue=await f.action(certificate,'issue');let run=issue.body.run;for(let n=0;n<200&&run.state==='running';n++){await new Promise(resolve=>setTimeout(resolve,10));run=(await f.req('/ops/runs/'+run.id)).body;}assert.equal(run.state,'succeeded');
 const newer=f.platform.store.get(certificate.id);assert.notEqual(newer.status.certificate_version,certificate.status.certificate_version);assert.throws(()=>f.platform.resolvePayload(oldJob),/payload_version_changed/);
 await f.action(target,'sync');
 for(const [n,phase] of ['accepted','staging','activating','verifying'].entries())f.jobs.event('node-b',oldJob.id,{lease_id:oldJob.lease_id,sequence:n+1,phase:phase as any,summary:'late receipt'});
 f.jobs.result('node-b',oldJob.id,{lease_id:oldJob.lease_id,state:'succeeded',snapshot:{health:{healthy:true},operations:{operation_id:old.operation_id,resource_id:target.id,data:{certificate_version:old.resource.config.certificate_version,fingerprint_sha256:old.resource.config.fingerprint_sha256}}}});
 assert.equal(f.platform.store.get(target.id).status.desired_certificate_version,newer.status.certificate_version);assert.notEqual(f.platform.store.get(target.id).status.state,'applied');
 certificateReceipt(f,'node-a');certificateReceipt(f,'node-b');assert.equal(f.platform.store.get(target.id).status.applied_certificate_version,newer.status.certificate_version);
 const enabled=f.platform.store.update(target.id,target.revision,target.name,{...target.spec,enabled:true},'admin');await f.action(enabled,'sync');certificateReceipt(f,'node-a');certificateReceipt(f,'node-b');
 const before=f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n;await f.platform.close();const restarted=registerOperationsPlatform(f.deps,{jobs:f.jobs,dataDir:f.root,intervalMs:0});t.after(()=>restarted.close());await restarted.tick();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,before);assert.equal(restarted.store.get(target.id).status.state,'applied');
});
test('cluster directory synchronization installs the same path independently on two real container Agents',{skip:process.env.LIGHTMONI_CERTIFICATE_DOCKER_QA!=='1',timeout:120000},async t=>{
 const f=await setup(t,undefined,true);clusterNode(f,'b');const certificate=await issuedCertificate(f),path='/tmp/lightmoni-057-tls';
 const target=await f.create('certificate_target','Real two-Agent directory',{certificate_id:certificate.id,type:'directory',cluster_id:f.cluster.id,path,enabled:true});await f.action(target,'sync');
 const docker=promisify(execFile),image=process.env.LIGHTMONI_CERTIFICATE_AGENT_IMAGE??'docker.heyphp.com/lightmoni/lightmoni:20261031-6dae46c';
 const endpoint=f.base.replace('127.0.0.1','host.docker.internal'),names=['a','b'].map(s=>'lm057-'+f.root.split('-').at(-1)+'-'+s);
 t.after(async()=>{for(const name of names)await docker('docker',['--context','desktop-linux','rm','-f',name]).catch(()=>{})});
 for(const [index,agentID] of ['node-a','node-b'].entries()){
  const script=`import {AgentJobRunner} from '/opt/lightmoni/runtime/dist/agent/jobs.js';import {readFile,stat} from 'node:fs/promises';import {X509Certificate,createPrivateKey} from 'node:crypto';const runner=new AgentJobRunner({endpoint:${JSON.stringify(endpoint)},agentID:${JSON.stringify(agentID)},controlCredential:'qa-control',dataDir:'/tmp/agent-data'});const receipt=await runner.pollOnce();if(receipt?.state!=='succeeded')throw Error('Agent installation failed: '+JSON.stringify(receipt));const cert=new X509Certificate(await readFile('${path}/fullchain.pem'));const key=createPrivateKey(await readFile('${path}/privkey.pem'));if(!cert.checkPrivateKey(key))throw Error('Pair mismatch');if(((await stat('${path}/.lightmoni-certificate-${certificate.id}/versions/${certificate.status.certificate_version}/privkey.pem')).mode&0o777)!==0o600)throw Error('Wrong key mode');console.log(JSON.stringify({agent:${JSON.stringify(agentID)},fingerprint:cert.fingerprint256,path:'${path}',key_matches:true}));`;
  const result=await docker('docker',['--context','desktop-linux','run','--rm','--name',names[index],'--entrypoint','node','--workdir','/opt/lightmoni',image,'--input-type=module','-e',script],{maxBuffer:1000000});const proof=JSON.parse(result.stdout.trim());assert.equal(proof.fingerprint,certificate.status.fingerprint_sha256);assert.equal(proof.key_matches,true);
 }
 const status=f.platform.store.get(target.id).status;assert.equal(status.state,'applied');assert.equal(status.machines.length,2);assert.ok(status.machines.every((m:any)=>m.state==='applied'));
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
test("self-signed certificate travels through real HTTP, private Agent lease, directory and update script", async (t) => {
  const f = await setup(t),
    cert = await f.create("certificate", "QA certificate", {
      source: "self_signed",
      domains: ["example.test"],
      validity_days: 3,
      auto_renew: false,
    });
  const issued = await f.action(cert, "issue");
  assert.equal(issued.status, 202, JSON.stringify(issued));
  assert.equal(issued.body.run.state, "running", JSON.stringify(issued));
  let issueReceipt = issued.body.run;
  for(let attempt=0;attempt<100&&issueReceipt.state==='running';attempt++) {
    await new Promise(resolve=>setTimeout(resolve,10));
    issueReceipt=(await f.req('/ops/runs/'+issueReceipt.id)).body;
  }
  assert.equal(issueReceipt.state,"succeeded",JSON.stringify(issueReceipt));
  const version = f.platform.store.get(cert.id).status.certificate_version;
  assert.ok(version);
  const directory = await f.create("certificate_target", "QA directory", {
    certificate_id: cert.id,
    type: "directory",
    enabled: true,
    agent_id: "node-a",
    path: join(f.root, "certificates"),
    mode: "0644",
    private_key_mode: "0600",
  });
  const sync = await f.action(directory, "sync");
  assert.equal(sync.status, 202, JSON.stringify(sync));
  const receipt = await f.runner.pollOnce();
  assert.equal(receipt?.state, "succeeded", JSON.stringify(receipt));
  assert.match(
    await readFile(join(f.root, "certificates", "fullchain.pem"), "utf8"),
    /BEGIN CERTIFICATE/,
  );
  assert.equal(
    (await stat(join(f.root, "certificates", "privkey.pem"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    f.platform.store.get(directory.id).status.applied_certificate_version,
    version,
  );
  const marker = join(f.root, "hook-version");
  const target = await f.create("certificate_target", "QA script", {
    certificate_id: cert.id,
    type: "hook",
    enabled: true,
    agent_id: "node-a",
    interpreter: "/bin/sh",
    timeout_ms: 10000,
    env: { QA_PRIVATE: "fixture-secret" },
    script: `test -s "$LIGHTMONI_CERTIFICATE_PATH" && test -s "$LIGHTMONI_PRIVATE_KEY_PATH" && test -n "$QA_PRIVATE" && printf '%s' "$LIGHTMONI_CERTIFICATE_VERSION" > '${marker}'`,
  });
  assert.equal(JSON.stringify(target).includes("fixture-secret"), false);
  assert.equal(target.spec.env, undefined);
  await f.action(target, "sync");
  const hook = await f.runner.pollOnce();
  assert.equal(hook?.state, "succeeded", JSON.stringify(hook));
  assert.equal(await readFile(marker, "utf8"), version);
  const before = f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n;
  await f.platform.tick();
  await f.platform.tick();
  assert.equal(f.db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, before);
  assert.equal(
    f.platform.store.get(target.id).status.applied_certificate_version,
    version,
  );
  assert.equal(
    JSON.stringify(f.db.all("SELECT * FROM ops_platform_runs")).includes(
      "fixture-secret",
    ),
    false,
  );
  assert.equal(
    JSON.stringify((await f.req("/ops/runs")).body).includes("fixture-secret"),
    false,
  );
});

test("HTTPS website deployment waits for a saved certificate without material before queuing gateways", async (t) => {
  const f = await setup(t),
    cert = f.platform.store.create("certificate", "First HTTPS certificate", {
      source: "self_signed",
      domains: ["first.example.test"],
      validity_days: 3,
      auto_renew: false,
    }, "admin"),
    group = await f.create("gateway_group", "First HTTPS gateways", {
      agent_ids: ["node-a"],
      http_port: 18088,
      https_port: 18488,
    });
  await f.action(group, "deploy");
  f.finish();
  const website = await f.create("website", "First HTTPS website", {
    mode: "static",
    domains: ["first.example.test"],
    static_files: { "index.html": "<h1>First HTTPS</h1>" },
    gateway_group_id: group.id,
    https: true,
    certificate_id: cert.id,
  });
  assert.equal(
    f.platform.store.get(cert.id).status.certificate_version,
    undefined,
  );
  const deployed = await f.action(website, "deploy");
  assert.equal(deployed.status, 202, JSON.stringify(deployed));
  assert.equal(deployed.body.runs.length, 1);
  assert.ok(f.platform.store.get(cert.id).status.certificate_version);
  const job = f.jobs.claim("node-a", ["operations.platform"])!,
    payload = f.platform.resolvePayload(job);
  assert.equal(payload.resource.config.task, "gateway.apply");
  assert.match(
    payload.resource.config.sites[0].certificate.certificate_pem,
    /BEGIN CERTIFICATE/,
  );
  assert.equal(JSON.stringify(job).includes("BEGIN CERTIFICATE"), false);
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
