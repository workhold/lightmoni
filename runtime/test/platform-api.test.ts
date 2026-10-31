import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerOperations } from "../src/server/operations.js";
import { registerOperationsPlatform } from "../src/ops/index.js";
import { AgentJobRunner } from "../src/agent/jobs.js";
import type { Dependencies } from "../src/shared/types.js";
async function setup(t: any, certificate?: Parameters<typeof registerOperationsPlatform>[1]["certificate"]) {
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
    has: (agentID: string, audience: string) => agentID === "node-a" && audience === "control",
    authenticate(req: any, agentID: string) {
      if (
        agentID !== "node-a" ||
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
  server.listen(0, "127.0.0.1");
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
