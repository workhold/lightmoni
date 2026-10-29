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
async function setup(t: any) {
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
    has() {
      return true;
    },
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
    platform = registerOperationsPlatform(deps, { jobs, dataDir: root });
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
  assert.equal(issued.body.run.state, "succeeded", JSON.stringify(issued));
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

test("first HTTPS website deployment automatically issues its selected certificate before queuing gateways", async (t) => {
  const f = await setup(t),
    cert = await f.create("certificate", "First HTTPS certificate", {
      source: "self_signed",
      domains: ["first.example.test"],
      validity_days: 3,
      auto_renew: false,
    }),
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
