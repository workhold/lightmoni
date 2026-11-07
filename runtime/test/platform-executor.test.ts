import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  chmod,
  unlink,
  symlink,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "node:net";
import { executeOperation, operationCommand } from "../src/agent/operations.js";
import { normalizeApplication,executePlatform } from "../src/operations/platform.js";
import {commandDiagnostic} from '../src/operations/install-progress.js';
import { selfSignedCertificate } from "../src/ops/certificates.js";
import { certificateMetadata } from "../src/operations/certificates.js";
import {privateRoot} from '../src/operations/website-files.js';
import { gatewayStorage, observedMounts, fitStorageReceipt } from '../src/operations/storage.js';
import type {
  OperationPayload,
  OperationExecutionContext,
} from "../src/operations/types.js";
const resourceID = "a".repeat(32);
test('Docker failure diagnostics classify causes without returning raw output or secrets', () => {
 for(const [text,code] of [
  ['Error response: manifest unknown: qa-hidden-image','image_not_found'],
  ['pull access denied for qa-hidden-image, authorization failed token=qa-hidden-token','image_access_denied'],
  ['dial tcp registry: i/o timeout password=qa-hidden','image_network_failed'],
  ['no space left on device qa-hidden-path','disk_full'],
  ['permission denied while trying to connect to the Docker daemon','docker_permission_denied'],
  ['ports are not available: address already in use','host_port_occupied'],
  ['container qa-hidden is unhealthy','container_unhealthy'],
 ]){assert.equal(commandDiagnostic(text,true),code);assert.doesNotMatch(commandDiagnostic(text,true),/qa-hidden/)}
 assert.equal(commandDiagnostic('arbitrary upstream error qa-hidden',true),'operation_command_failed');
});
async function setup(t: any) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lightmoni-platform-executor-")),
  );
  const dataDir = join(root, "agent");
  await mkdir(dataDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    dataDir,
    context: {
      dataDir,
      signal: new AbortController().signal,
      now: () => new Date(),
      command: operationCommand,
    } as OperationExecutionContext,
  };
}
const payload = (config: any, operation = "apply"): OperationPayload => ({
  version: 1,
  operation_id: crypto.randomUUID().replaceAll("-", ""),
  operation,
  resource: {
    id: resourceID,
    kind: "platform",
    name: "test",
    agent_id: "node-a",
    revision: 1,
    config,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  input: {},
});
test("application validation accepts host mounts and Compose but rejects ambient file dependencies and traversal", () => {
  const app = normalizeApplication({
    mode: "container",
    image: "nginx:1.30.6-alpine",
    mounts: [
      { type: "data", source: "/srv/data", target: "/data" },
      { type: "config", target: "/etc/app", files: { "a/config.json": "{}" } },
    ],
  });
  assert.equal(app.mounts.length, 2);
  assert.throws(
    () =>
      normalizeApplication({
        mode: "compose",
        compose:
          "services:\n  app:\n    image: nginx:1.30.6-alpine\n    env_file: /etc/private",
      }),
    /MANAGED_FILES/,
  );
  assert.throws(
    () =>
      normalizeApplication({
        mode: "container",
        image: "nginx:1",
        mounts: [
          { type: "config", target: "/etc/app", files: { "../secret": "x" } },
        ],
      }),
    /FILE_PATH/,
  );
  assert.throws(
    () =>
      normalizeApplication({
        mode: "container",
        image: "nginx:1",
        network_mode: "host",
        ports: [{ host_port: 80, container_port: 80 }],
      }),
    /PORT_MAPPING/,
  );
});
test("certificate directory publishes a matching atomic pair and refuses unrelated files or immutable version replacement", async (t) => {
  const f = await setup(t),
    material = await selfSignedCertificate(["example.com"], 7, new Date()),
    meta = certificateMetadata(
      material.certificate_pem,
      material.private_key_pem,
      ["example.com"],
    ),
    path = join(f.root, "certs"),
    config = {
      task: "certificate.install",
      certificate_id: resourceID,
      certificate_version: "v1",
      path,
      domains: ["example.com"],
      fingerprint_sha256: meta.fingerprint_sha256,
      ...material,
    };
  const result = await executeOperation(
    payload(config, "install"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(
    await readFile(join(path, "fullchain.pem"), "utf8"),
    material.certificate_pem,
  );
  assert.equal((await lstat(join(path, "privkey.pem"))).isSymbolicLink(), true);
  assert.equal(
    JSON.stringify(result).includes(material.private_key_pem),
    false,
  );
  const other = await selfSignedCertificate(["example.com"], 7, new Date());
  const rejected = await executeOperation(
    payload({ ...config, ...other, fingerprint_sha256: undefined }, "install"),
    f.context,
    async () => {},
  );
  assert.equal(rejected.state, "failed");
  assert.equal(
    await readFile(join(path, "privkey.pem"), "utf8"),
    material.private_key_pem,
  );
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "fullchain.pem"), "user-owned");
  const conflict = await executeOperation(
    payload({ ...config, path: unrelated }, "install"),
    f.context,
    async () => {},
  );
  assert.equal(conflict.state, "failed");
  assert.equal(
    await readFile(join(unrelated, "fullchain.pem"), "utf8"),
    "user-owned",
  );
});
test("certificate hook runs a real script with explicit environment and file context without returning output or process secrets", async (t) => {
  const f = await setup(t),
    material = await selfSignedCertificate(["example.com"], 7, new Date()),
    output = join(f.root, "proof");
  process.env.LIGHTMONI_TEST_AMBIENT_SECRET = "ambient-private-value";
  t.after(() => delete process.env.LIGHTMONI_TEST_AMBIENT_SECRET);
  const config = {
    task: "hook.run",
    hook_id: resourceID,
    certificate_id: resourceID,
    certificate_version: "v7",
    interpreter: "/bin/sh",
    timeout_ms: 5000,
    env: { OUTPUT: output, EXPLICIT: "requested" },
    script:
      'test -s "$LIGHTMONI_CERTIFICATE_PATH"\ntest -s "$LIGHTMONI_PRIVATE_KEY_PATH"\nprintf "%s:%s:%s" "$EXPLICIT" "$LIGHTMONI_CERTIFICATE_VERSION" "$LIGHTMONI_TEST_AMBIENT_SECRET" > "$OUTPUT"\necho should-not-be-returned',
    certificate: { ...material, domains: ["example.com"] },
  };
  const result = await executeOperation(
    payload(config, "run"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(await readFile(output, "utf8"), "requested:v7:");
  assert.equal(
    JSON.stringify(result).includes("should-not-be-returned"),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes(material.private_key_pem),
    false,
  );
});
test("interrupted hook is unknown and leaves the durable writer fence", async (t) => {
  const f = await setup(t),
    config = {
      task: "hook.run",
      hook_id: resourceID,
      script: "sleep 4",
      timeout_ms: 1000,
    };
  const result = await executeOperation(
    payload(config, "run"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "unknown");
  assert.equal(
    JSON.parse(
      await readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"),
    ).state,
    "unknown",
  );
});
test("managed file traversal cannot follow a symlink into another directory", async (t) => {
  const f = await setup(t),
    outside = join(f.root, "outside");
  await mkdir(outside);
  await mkdir(join(f.dataDir, "operations"));
  await symlink(outside, join(f.dataDir, "operations", "platform"));
  const result = await executeOperation(
    payload({ task: "hook.run", script: "echo x" }, "run"),
    f.context,
    async () => {},
  );
  assert.equal(result.state, "failed");
});
test("explicit hook inspection confirms completion while retaining an unknown node writer fence", async (t) => {
  const f = await setup(t);
  const original = payload(
    {
      task: "hook.run",
      hook_id: resourceID,
      certificate_id: resourceID,
      certificate_version: "v1",
      script: "true",
    },
    "run",
  );
  const completed = await executeOperation(original, f.context, async () => {});
  assert.equal(completed.state, "succeeded");
  const lock = join(f.dataDir, "operations", "execution.lock");
  await writeFile(
    lock,
    JSON.stringify({
      state: "unknown",
      operation_id: original.operation_id,
      pid: process.pid,
    }),
  );
  const inspected = await executeOperation(
    payload(
      {
        task: "hook.inspect",
        hook_id: resourceID,
        original_operation_id: original.operation_id,
        certificate_version: "v1",
        script_sha256: completed.snapshot.operations.data.script_sha256,
      },
      "inspect",
    ),
    f.context,
    async () => {},
  );
  assert.equal(inspected.state, "succeeded");
  assert.equal(inspected.snapshot.operations.data.certificate_id, resourceID);
  assert.equal(JSON.parse(await readFile(lock, "utf8")).state, "unknown");
});
test("node discovery reads real OS capacity and reports Docker capability without a writer lock", async (t) => {
  const f = await setup(t);
  const result = await executeOperation(
    payload({ task: "node.inspect" }, "inspect"),
    {
      ...f.context,
      command: async () => ({ stdout: '"fixture-engine"', stderr: "" }),
    },
    async () => {},
  );
  assert.equal(result.state, "succeeded");
  const node = result.snapshot.operations.data.node;
  assert.ok(node.cpu > 0);
  assert.ok(node.memory_mb > 0);
  assert.equal(node.docker_available, true);
  await assert.rejects(
    readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"),
    { code: "ENOENT" },
  );
});
test("Docker configuration preflight failures retain the active state and release the writer fence", async (t) => {
  const f = await setup(t),
    calls: string[][] = [], events: any[] = [];
  const context = {
    ...f.context,
    command: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return { stdout: "", stderr: "" };
      throw Object.assign(Error("fixture failed read-only preflight"), {
        code: "operation_command_failed",
        diagnosticCode: 'image_network_failed',
      });
    },
  };
  const app = await executeOperation(
    payload({
      task: "workload.apply",
      instance_id: resourceID,
      application: { mode: "container", image: "alpine:3.23", mounts: [] },
    }),
    context,
    async event => {events.push(event)},
  );
  assert.equal(app.state, "failed");
  assert.equal(app.code, "compose_preflight_failed");
  assert.equal(app.snapshot.operations.data.cause_code,'image_network_failed');
  assert.equal(app.snapshot.operations.data.phase,'validating_config');
  assert.ok(events.some(e=>e.snapshot?.operations?.progress?.phase==='checking_docker'));
  assert.ok(events.some(e=>e.snapshot?.operations?.progress?.phase==='validating_config'));
  const gateway = await executeOperation(
    payload({
      task: "gateway.apply",
      instance_id: resourceID,
      image: "openresty/openresty:1.27.1.2-0-alpine",
      sites: [],
    }),
    context,
    async () => {},
  );
  assert.equal(gateway.state, "failed");
  assert.equal(gateway.code, "gateway_preflight_failed");
  assert.equal(
    calls.some((args) => args.includes("--detach")),
    false,
  );
  await assert.rejects(
    readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"),
    { code: "ENOENT" },
  );
});
test("low-port EACCES reaches Docker validation for workloads and OpenResty and reports the port phase", async (t) => {
  t.mock.method(Server.prototype, "listen", function (this: Server) {
    queueMicrotask(() => this.emit("error", Object.assign(Error("listen denied"), { code: "EACCES" })));
    return this;
  });
  for (const task of ["workload.apply", "gateway.apply"]) {
    const f = await setup(t), calls: string[][] = [], events: any[] = [];
    const result = await executeOperation(payload({
      task,
      instance_id: resourceID,
      ...(task === "workload.apply"
        ? { application: { mode: "container", image: "alpine:3.23", ports: [{ host_port: 80, container_port: 80 }] } }
        : { image: "openresty/openresty:1.27.1.2-0-alpine", sites: [] }),
    }), {
      ...f.context,
      command: async (_file, args) => {
        calls.push(args);
        if (args[0] === "ps") return { stdout: "", stderr: "" };
        // Docker's later failure must still reject the operation after the local probe was skipped.
        throw Object.assign(Error("hidden Docker details"), {
          code: "operation_command_failed", diagnosticCode: "host_port_occupied",
        });
      },
    }, async event => { events.push(event); });
    const phase = task === "workload.apply" ? "validating_config" : "validating_gateway";
    assert.equal(result.state, "failed");
    assert.equal(result.code, task === "workload.apply" ? "compose_preflight_failed" : "gateway_preflight_failed");
    assert.equal(result.snapshot.operations.data.cause_code, "host_port_occupied");
    assert.equal(result.snapshot.operations.data.phase, phase);
    const phases = events.flatMap(e => e.snapshot?.operations?.progress?.phase ?? []);
    assert.ok(phases.indexOf("checking_ports") > phases.indexOf("checking_docker"));
    assert.ok(phases.indexOf(phase) > phases.indexOf("checking_ports"));
    assert.ok(calls.some(args => args[0] === (task === "workload.apply" ? "compose" : "run")));
    assert.doesNotMatch(JSON.stringify(result), /hidden Docker details/);
    await assert.rejects(readFile(join(f.dataDir, "operations", "execution.lock"), "utf8"), { code: "ENOENT" });
  }
});

test('modern application log receipts redact deployed SDK and custom environment values',async t=>{
 const f=await setup(t),root=join(await privateRoot(f.context,'platform'),'applications',resourceID,'instances',resourceID),containerID='b'.repeat(64),secret='lm_'+'a'.repeat(43);
 await mkdir(root,{recursive:true,mode:0o700});const manifest=join(root,'compose.json');
 await writeFile(manifest,JSON.stringify({services:{app:{environment:{LIGHTMONI_KEY:secret,CUSTOM_SECRET:'custom$$value'}}}}));
 await writeFile(join(root,'state.json'),JSON.stringify({manifest}));
 const context={...f.context,command:async(_command:string,args:string[])=>({code:0,stdout:args[0]==='ps'?containerID:args[0]==='inspect'?JSON.stringify([{Id:containerID,Config:{Labels:{'io.lightmoni.platform.instance':resourceID,'io.lightmoni.platform.application':resourceID,'io.lightmoni.platform.owner':'lightmoni'}}}]):'sdk='+secret+' custom=custom$value ordinary line',stderr:''})};
 const result=await executePlatform(payload({task:'workload.logs',instance_id:resourceID},'logs'),context);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));assert.doesNotMatch(JSON.stringify(result),/custom\$value/);assert.match(JSON.stringify(result),/ordinary line/);assert.match(JSON.stringify(result),/redacted/);
});

test('managed certificate actual inspection repairs damaged immutable release, verifies permissions and removes only owned entrypoints',async t=>{
  const f=await setup(t),material=await selfSignedCertificate(['drift.example.test'],7,new Date());
  const meta=certificateMetadata(material.certificate_pem,material.private_key_pem,['drift.example.test']);
  const c={task:'certificate.install',certificate_id:resourceID,certificate_version:'logical-v1',path:join(f.root,'managed-tls'),domains:['drift.example.test'],fingerprint_sha256:meta.fingerprint_sha256,...material};
  const execute=(config:any,op='inspect')=>executeOperation(payload(config,op),f.context,async()=>{});
  assert.equal((await execute(c,'install')).state,'succeeded');
  const inspect={...c,task:'certificate.inspect',reconciliation_hash:'test-proof'};
  assert.equal((await execute(inspect)).snapshot.operations?.data.configuration_matches,true);
  await chmod(join(c.path,'privkey.pem'),0o644);
  let check=await execute(inspect);assert.equal(check.state,'succeeded');assert.equal(check.snapshot.operations?.data.configuration_matches,false);
  assert.equal((await execute({...c,repair:true},'install')).state,'succeeded');
  assert.equal((await execute(inspect)).snapshot.operations?.data.configuration_matches,true);
  await writeFile(join(c.path,'fullchain.pem'),'damaged-certificate');
  check=await execute(inspect);assert.equal(check.snapshot.operations?.data.configuration_matches,false);
  assert.equal((await execute({...c,repair:true},'install')).state,'succeeded');
  check=await execute(inspect);assert.equal(check.snapshot.operations?.data.configuration_matches,true);assert.equal(check.snapshot.operations?.data.certificate_version,'logical-v1');
  await unlink(join(c.path,'privkey.pem'));await writeFile(join(c.path,'privkey.pem'),'user-owned-key');
  assert.equal((await execute({...c,task:'certificate.remove'},'remove')).state,'failed');assert.equal(await readFile(join(c.path,'privkey.pem'),'utf8'),'user-owned-key');
  await unlink(join(c.path,'privkey.pem'));await symlink('.lightmoni-certificate-'+resourceID+'/current/privkey.pem',join(c.path,'privkey.pem'));
  assert.equal((await execute({...c,task:'certificate.remove'},'remove')).state,'succeeded');
  check=await execute({...inspect,expected_absent:true});assert.equal(check.snapshot.operations?.data.absent,true);assert.equal(check.snapshot.operations?.data.configuration_matches,true);
});

test('workload inspection compares live Docker fields and actual managed file bytes against current desired content',async t=>{
  const {renderManifest}=await import('../src/operations/platform.js'),{desiredHash}=await import('../src/shared/desired-state.js'),{hash}=await import('../src/operations/website-files.js');
  const f=await setup(t),id='workload-content-check',app=normalizeApplication({mode:'container',image:'example:1',environment:{VALUE:'expected'},mounts:[{type:'config',target:'/etc/example',files:{'config.json':'{"mode":"expected"}'}}]});
  const manifest=await renderManifest(f.context,id,app,1,resourceID),root=join(await privateRoot(f.context,'platform'),'applications',resourceID,'instances',id),manifestPath=join(root,'compose.json');
  await writeFile(manifestPath,JSON.stringify(manifest));await writeFile(join(root,'state.json'),JSON.stringify({manifest:manifestPath,digest:hash(JSON.stringify(manifest)),configuration_hash:desiredHash(app)}));
  const service=manifest.services.app,container:any={Id:'f'.repeat(64),Name:'/managed-test',Config:{Image:'example:1',Env:['VALUE=expected'],Labels:service.labels},State:{Running:true,Status:'running'},HostConfig:{RestartPolicy:{Name:'unless-stopped'},ReadonlyRootfs:false,PortBindings:{}},NetworkSettings:{Ports:{}},Mounts:service.volumes.map((v:any)=>({Source:v.source,Destination:v.target,Type:v.type,RW:!v.read_only}))};
  container.Config.Labels['com.docker.compose.service']='app';
  const context={...f.context,command:async(_file:string,args:string[])=>({stdout:args[0]==='ps'?container.Id:args[0]==='inspect'?JSON.stringify([container]):'',stderr:''})};
  const inspect=()=>executePlatform(payload({task:'workload.inspect',instance_id:id,application:app,reconciliation_hash:'current'}),context);
  assert.equal((await inspect()).data.configuration_matches,true);
  container.Config.Env=['VALUE=drift'];assert.equal((await inspect()).data.configuration_matches,false);container.Config.Env=['VALUE=expected'];
  await writeFile(join(service.volumes[0].source,'config.json'),'drift');assert.equal((await inspect()).data.configuration_matches,false);
});

test('workload inspection resolves Compose scoped, named and external volume identities and still rejects foreign volumes and access drift',async t=>{
 const {renderManifest}=await import('../src/operations/platform.js'),{desiredHash}=await import('../src/shared/desired-state.js'),{hash}=await import('../src/operations/website-files.js');
 for(const [definition,name] of [[{},'lm-'+resourceID+'-volume-check-data'],[{name:'explicit-data'},'explicit-data'],[{external:true},'data'],[{external:true,name:'external-data'},'external-data']] as const){
  const f=await setup(t),id='volume-check',app=normalizeApplication({mode:'compose',compose:{services:{db:{image:'example:1',volumes:[{type:'volume',source:'data',target:'/data'}]}},volumes:{data:definition}}});
  const manifest=await renderManifest(f.context,id,app,1,resourceID),root=join(await privateRoot(f.context,'platform'),'applications',resourceID,'instances',id),path=join(root,'compose.json');
  await writeFile(path,JSON.stringify(manifest));await writeFile(join(root,'state.json'),JSON.stringify({manifest:path,digest:hash(JSON.stringify(manifest)),configuration_hash:desiredHash(app)}));
  const mount:any={Type:'volume',Name:name,Source:'/var/lib/docker/volumes/'+name+'/_data',Destination:'/data',RW:true};
  const container={Id:'a'.repeat(64),Config:{Image:'example:1',Labels:{...manifest.services.db.labels,'com.docker.compose.service':'db'}},State:{Running:true,Status:'running'},HostConfig:{ReadonlyRootfs:false,PortBindings:{}},Mounts:[mount]};
  const context={...f.context,command:async(_file:string,args:string[])=>({stdout:args[0]==='ps'?container.Id:args[0]==='inspect'?JSON.stringify([container]):'',stderr:''})};
  const inspect=()=>executePlatform(payload({task:'workload.inspect',instance_id:id,application:app}),context);
  assert.equal((await inspect()).data.configuration_matches,true,JSON.stringify(definition));
  mount.Name='another-project_'+name;assert.equal((await inspect()).data.configuration_matches,false);mount.Name=name;
  mount.RW=false;assert.equal((await inspect()).data.configuration_matches,false);mount.RW=true;
  assert.equal((await inspect()).data.configuration_matches,true);
 }
});

test('container empty command overrides inherit image defaults while explicit commands and Compose empties remain authoritative',async t=>{
 const {renderManifest}=await import('../src/operations/platform.js'),{desiredHash}=await import('../src/shared/desired-state.js'),{hash}=await import('../src/operations/website-files.js');
 const f=await setup(t),id='image-default-command',app=normalizeApplication({mode:'container',image:'example:1',command:[],entrypoint:[]});
 assert.equal(app.command,undefined);assert.equal(app.entrypoint,undefined);
 const explicit=normalizeApplication({mode:'container',image:'example:1',command:['node','custom.mjs'],entrypoint:['node']});
 assert.deepEqual(explicit.command,['node','custom.mjs']);assert.deepEqual(explicit.entrypoint,['node']);
 const compose=normalizeApplication({mode:'compose',compose:{services:{app:{image:'example:1',command:[],entrypoint:[]}}}});
 assert.deepEqual(compose.compose.services.app.command,[]);assert.deepEqual(compose.compose.services.app.entrypoint,[]);
 const root=join(await privateRoot(f.context,'platform'),'applications',resourceID,'instances',id),path=join(root,'compose.json');
 let container:any;
 const context={...f.context,command:async(_file:string,args:string[])=>({stdout:args[0]==='ps'?container.Id:args[0]==='inspect'?JSON.stringify([container]):'',stderr:''})};
 for(const application of [app,explicit]){
  const manifest=await renderManifest(f.context,id,application,1,resourceID);await writeFile(path,JSON.stringify(manifest));await writeFile(join(root,'state.json'),JSON.stringify({manifest:path,digest:hash(JSON.stringify(manifest)),configuration_hash:desiredHash(application)}));
  container={Id:'d'.repeat(64),Config:{Image:'example:1',Cmd:['node','server.mjs'],Entrypoint:['docker-entrypoint.sh'],Labels:{...manifest.services.app.labels,'com.docker.compose.service':'app'}},State:{Running:true,Status:'running'},HostConfig:{RestartPolicy:{Name:'unless-stopped'},ReadonlyRootfs:false,PortBindings:{}},Mounts:[]};
  const inspect=()=>executePlatform(payload({task:'workload.inspect',instance_id:id,application}),context);
  assert.equal((await inspect()).data.configuration_matches,application===app);
  if(application===explicit){container.Config.Cmd=explicit.command;container.Config.Entrypoint=explicit.entrypoint;assert.equal((await inspect()).data.configuration_matches,true);}
 }
});

test('storage receipts use actual bind and Docker data-root paths and retain initialization',async t=>{
 const {renderManifest}=await import('../src/operations/platform.js');
 const f=await setup(t),id='storage-layout',app=normalizeApplication({mode:'container',image:'example:1',mounts:[
  {type:'config',target:'/etc/example',files:{'site.conf':'secret configuration'}},
  {type:'init',target:'/init',files:{'once.sql':'initial'}},{type:'data',target:'/data'},
  {type:'data',target:'/external',source:join(f.root,'custom-data')},{type:'volume',target:'/volume',source:'database'},
 ]});
 const doc=await renderManifest(f.context,id,app,1,resourceID),root=join(f.dataDir,'operations/platform/applications',resourceID,'instances',id);
 assert.match(doc.services.app.volumes[0].source,/\/config\/[a-f0-9]{64}\/0$/);
 assert.equal(doc.services.app.volumes[1].source,join(root,'initial/1'));assert.equal(doc.services.app.volumes[2].source,join(root,'data/2'));assert.equal(doc.services.app.volumes[3].source,join(f.root,'custom-data'));
 const init=join(doc.services.app.volumes[1].source,'once.sql');await writeFile(init,'user changed');await renderManifest(f.context,id,app,2,resourceID);assert.equal(await readFile(init,'utf8'),'user changed');
 const container={Id:'f'.repeat(64),Config:{Labels:{'io.lightmoni.platform.instance':id,'io.lightmoni.platform.application':resourceID,'io.lightmoni.platform.owner':'lightmoni','com.docker.compose.service':'app'},Env:['SECRET=hidden']},State:{Running:false},Mounts:doc.services.app.volumes.map((v:any)=>({Type:v.type,Source:v.type==='volume'?'/srv/docker/volumes/lm-storage-layout_database/_data':v.source,Name:v.type==='volume'?'lm-storage-layout_database':'',Destination:v.target,RW:!v.read_only}))};
 const context={...f.context,command:async(_file:string,args:string[])=>({stdout:args[0]==='ps'?container.Id:args[0]==='inspect'?JSON.stringify([container]):'',stderr:''})};
 const result=await executePlatform(payload({task:'workload.inspect',instance_id:id},'inspect'),context);
 assert.equal(result.data.storage.instance_root,root);assert.equal(result.data.storage.mounts.length,5);assert.equal(result.data.storage.mounts.at(-1).source,'/srv/docker/volumes/lm-storage-layout_database/_data');
 assert.equal(result.data.storage.mounts[0].read_only,true);assert.doesNotMatch(JSON.stringify(result.data.storage),/hidden|secret configuration/);
});
test('gateway storage identifies independent website ID versions and bounds metadata',()=>{
 const root='/var/lib/lightmoni-managed/operations/platform',digest='a'.repeat(64),state={digest,website_versions:{'website-one':digest,'website-two':'b'.repeat(64)}};
 const storage=gatewayStorage(root,'entry-one',state,[]);
 assert.equal(storage.config_file,root+'/gateways/entry-one/current/nginx.conf');assert.equal(storage.sites[0].root,root+'/websites/website-one');
 assert.equal(storage.sites[0].config_file,root+'/websites/website-one/versions/'+digest+'/nginx.conf');assert.equal(storage.sites[0].public_dir,root+'/websites/website-one/versions/'+digest+'/public');assert.equal(storage.sites[1].website_id,'website-two');
 const large=observedMounts([{Mounts:Array.from({length:500},()=>({Source:'/srv/'+('x'.repeat(1000)),Destination:'/data',Type:'bind',RW:true}))}]);assert.equal(large.mounts_truncated,true);assert(Buffer.byteLength(JSON.stringify(large))<9000);
 assert.throws(()=>gatewayStorage(root,'../outside',state,[]),/INVALID_RESOURCE_ID/);
});
test('optional storage metadata cannot exceed the existing receipt budget',()=>{
 const content='x'.repeat(59*1024),result=fitStorageReceipt({verified:true,data:{content,storage:{layout_version:1,instance_root:'/data',mounts:Array.from({length:20},()=>({source:'x'.repeat(500)})),sites:[]}}});
 assert.equal(result.data.content,content);assert.equal(result.data.storage.mounts_truncated,true);assert(Buffer.byteLength(JSON.stringify(result.data))<=60*1024);
 const full='x'.repeat(60*1024-14),fallback=fitStorageReceipt({verified:true,data:{content:full,storage:{layout_version:1,instance_root:'x'.repeat(500)}}});assert.equal(fallback.data.content,full);assert.equal(fallback.data.storage,undefined);
});

test('application and instance IDs isolate managed files, initialization, data and default volume names',async t=>{
 const {renderManifest}=await import('../src/operations/platform.js');const f=await setup(t);
 const app=normalizeApplication({mode:'container',image:'example:1',mounts:[{type:'init',target:'/init',files:{value:'default'}},{type:'data',target:'/data'},{type:'volume',target:'/volume',source:'database'}]});
 const first=await renderManifest(f.context,'instance',app,1,'application-a'),second=await renderManifest(f.context,'instance',app,1,'application-b'),replica=await renderManifest(f.context,'replica',app,1,'application-a');
 const mounts=(doc:any)=>doc.services.app.volumes;
 assert.match(mounts(first)[0].source,/applications\/application-a\/instances\/instance\/initial\/0$/);
 assert.notEqual(mounts(first)[1].source,mounts(second)[1].source);assert.notEqual(mounts(first)[1].source,mounts(replica)[1].source);
 assert.equal(first.volumes.database.name,'lm-application-a-instance-database');assert.notEqual(first.volumes.database.name,second.volumes.database.name);
 await writeFile(join(mounts(first)[0].source,'value'),'changed');await renderManifest(f.context,'instance',app,2,'application-a');
 assert.equal(await readFile(join(mounts(first)[0].source,'value'),'utf8'),'changed');assert.equal(await readFile(join(mounts(second)[0].source,'value'),'utf8'),'default');
 await assert.rejects(executePlatform(payload({task:'workload.apply',instance_id:'instance',application_id:'application-b',application:app}),f.context),/APPLICATION_IDENTITY_MISMATCH/);
});
test('website ID versions own nginx, SSL, authentication and static files independently and restore pointers',async t=>{
 const {stageWebsites,activateWebsitePointers,restoreWebsitePointers,gatewayIdentity,loadGatewayState}=await import('../src/operations/website-storage.js');
 const {renderWebsiteConfig,renderGateway}=await import('../src/operations/platform.js');const {readlink}=await import('node:fs/promises');const {hashSync}=await import('bcryptjs');
 const f=await setup(t),platform=await privateRoot(f.context,'platform'),material=await selfSignedCertificate(['one.example.test'],7,new Date());
 const c:any={instance_id:'entry',http_port:23881,https_port:23882,sites:[{id:'one',website_id:'website-a',domains:['one.example.test'],mode:'static',static_files:{'index.html':'first'},certificate:material,auth:{mode:'basic',realm:'secure',users:[{username:'qa',password_hash:hashSync('private-password',10)}]}},{id:'two',website_id:'website-b',domains:['two.example.test'],mode:'static',static_files:{'index.html':'second'}}]};
 const versions=await stageWebsites(f.context,c,renderWebsiteConfig,v=>v),rootA=join(platform,'websites/website-a'),rootB=join(platform,'websites/website-b'),versionA=join(rootA,'versions',versions['website-a']),versionB=join(rootB,'versions',versions['website-b']);
 assert.equal(await readFile(join(versionA,'ssl/one/privkey.pem'),'utf8'),material.private_key_pem);assert.match(await readFile(join(versionA,'auth/one/site.htpasswd'),'utf8'),/^qa:\$2/);assert.equal(await readFile(join(versionA,'public/one/index.html'),'utf8'),'first');
 assert.equal((await lstat(join(versionA,'ssl/one/privkey.pem'))).mode&0o777,0o600);
 const identity=gatewayIdentity(c,versions),global=renderGateway({...c,website_versions:versions},identity.digest,false,true);
 assert.match(global,/include "\/etc\/lightmoni-websites\/website-a\/versions\/[^/]+\/nginx.conf"/);assert.doesNotMatch(global,/ssl_certificate_key|auth_basic_user_file|BEGIN PRIVATE|qa:/);assert(!JSON.stringify(identity).includes(material.private_key_pem));
 await activateWebsitePointers(platform,versions);const before=(await lstat(join(versionB,'nginx.conf'))).ino;
 const next=structuredClone(c);next.sites[0].static_files['index.html']='updated';const updated=await stageWebsites(f.context,next,renderWebsiteConfig,v=>v);
 assert.notEqual(updated['website-a'],versions['website-a']);assert.equal(updated['website-b'],versions['website-b']);assert.equal((await lstat(join(versionB,'nginx.conf'))).ino,before);
 const previous=await activateWebsitePointers(platform,updated);await restoreWebsitePointers(platform,previous);assert.equal(await readlink(join(rootA,'current')),'versions/'+versions['website-a']);
 const restored=await loadGatewayState(platform,{version:2,...identity,image:c.image??'openresty/openresty:1.27.1.2-0-alpine'});assert.equal(restored!.config.sites.length,2);
});
test('website cleanup rejects active references, prunes obsolete indexes and deletes only its owned ID root',async t=>{
 const {stageWebsites,activateWebsitePointers,gatewayIdentity,removeWebsite,inspectWebsiteRemoval}=await import('../src/operations/website-storage.js');const {renderWebsiteConfig,renderGateway}=await import('../src/operations/platform.js');const {symlink}=await import('node:fs/promises');
 const f=await setup(t),platform=await privateRoot(f.context,'platform'),c:any={instance_id:'entry',sites:[{id:'one',website_id:'website-a',domains:['one.test'],mode:'static',static_files:{'index.html':'one'}},{id:'two',website_id:'website-b',domains:['two.test'],mode:'static',static_files:{'index.html':'two'}}]};
 const refs=await stageWebsites(f.context,c,renderWebsiteConfig,v=>v);await activateWebsitePointers(platform,refs);
 const root=join(platform,'gateways/entry');await mkdir(root,{recursive:true});await writeFile(join(root,'owner.json'),JSON.stringify({layout_version:2,instance_id:'entry'}));
 const save=async(refs:any)=>{const value=gatewayIdentity(c,refs),version=join(root,'versions',value.digest);await mkdir(version,{recursive:true});await writeFile(join(version,'websites.json'),JSON.stringify(refs));await writeFile(join(version,'nginx.conf'),renderGateway({...c,website_versions:refs},value.digest,false,true));await writeFile(join(root,'state.json'),JSON.stringify({version:2,...value,retained_website_versions:{...refs,'website-a':Object.values(refs)[0]}}));return value;};
 const prior=await save(refs);const context={...f.context,command:async(_file:string,args:string[])=>({stdout:args[0]==='ps'?'a'.repeat(64):JSON.stringify([{Id:'a'.repeat(64),Config:{Labels:{'io.lightmoni.platform.instance':'entry','io.lightmoni.platform.owner':'lightmoni'}},State:{Running:true}}]),stderr:''})};
 const render=(config:any,digest:string)=>renderGateway(config,digest,false,true);
 await assert.rejects(removeWebsite(context,'website-a',render),/WEBSITE_STILL_ACTIVE/);assert(await readFile(join(platform,'websites/website-a/owner.json')));
 const current=await save({'website-b':refs['website-b']});await symlink('versions/'+current.digest,join(root,'current'));
 const result=await removeWebsite(context,'website-a',render);assert.equal(result.absent,true);await assert.rejects(lstat(join(platform,'websites/website-a')),{code:'ENOENT'});await assert.rejects(lstat(join(root,'versions',prior.digest)),{code:'ENOENT'});
 assert.equal(await readFile(join(platform,'websites/website-b/versions',refs['website-b'],'public/two/index.html'),'utf8'),'two');assert.equal((await removeWebsite(context,'website-a',render)).absent,true);
 assert.equal((await inspectWebsiteRemoval(context,'website-a')).absent,true);const retained=JSON.parse(await readFile(join(root,'state.json'),'utf8'));retained.retained_website_versions['website-a']=refs['website-a'];await writeFile(join(root,'state.json'),JSON.stringify(retained));
 assert.equal((await inspectWebsiteRemoval(context,'website-a')).absent,false);await removeWebsite(context,'website-a',render);assert.equal((await inspectWebsiteRemoval(context,'website-a')).absent,true);
 await assert.rejects(removeWebsite(context,'../outside',render),/INVALID_RESOURCE_ID/);
 const outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'keep');await symlink(outside,join(platform,'websites/unsafe'));
 await assert.rejects(removeWebsite(context,'unsafe',render),/OWNERSHIP/);assert.equal(await readFile(join(outside,'keep'),'utf8'),'keep');
});
