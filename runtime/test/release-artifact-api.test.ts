import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { HTTPError } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { registerServiceDeployments } from "../src/server/service-deployments.js";
import { ReleaseArtifactStore } from "../src/deployment/artifact-store.js";
import type { Dependencies } from "../src/shared/types.js";

type TarEntry = { name: string; content: Buffer; mode: number };
function octal(value: number, length: number) {
  return Buffer.from(value.toString(8).padStart(length - 1, "0") + "\0", "ascii");
}
function tarEntry(entry: TarEntry) {
  const header = Buffer.alloc(512);
  Buffer.from(entry.name).copy(header, 0);
  octal(entry.mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(entry.content.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0", "binary").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  const padding = Buffer.alloc((512 - entry.content.length % 512) % 512);
  return [header, entry.content, padding];
}
function releaseBundle(serviceID: string, version: string, architecture = "linux-amd64") {
  const manifest = Buffer.from(JSON.stringify({ schema_version: 1, service_id: serviceID, version, architecture, source_revision: "git:0123456789abcdef", entrypoint: "run" }));
  return gzipSync(Buffer.concat([
    ...tarEntry({ name: "manifest.json", content: manifest, mode: 0o644 }),
    ...tarEntry({ name: "run", content: Buffer.from("#!/bin/sh\necho ok\n"), mode: 0o755 }),
    Buffer.alloc(1024),
  ]));
}

test("admin uploads a validated private release and an active job lease gates Agent downloads", async (t) => {
  const db = new DB(":memory:"), router = new Router();
  const user = { id: "admin", name: "Admin", role: "admin" };
  db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '')");
  db.run("INSERT INTO managed_machines(id,name,address,port,username,agent_id) VALUES(?,?,?,?,?,?)", "machine-1", "app-1", "10.0.0.1", 22, "deploy", "agent-1");
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL)");
  db.run("INSERT INTO agents(id,last_seen) VALUES(?,?)", "agent-1", new Date().toISOString());
  const auth = {
    requireAdmin() {},
    user: () => user,
    validateKey() { throw Error("unused"); },
    master: Buffer.alloc(32),
  };
  const deps = {
    db, router, auth, now: () => new Date(), externalURL: "http://127.0.0.1:8080",
    encrypt: (value: string) => value, decrypt: (value: string) => value,
    logger: { info() {}, warn() {}, error() {} },
    cat: { list: async () => [] }, query: async () => ({ request_id: "", results: [] }), referencedTables: async () => [],
    ch: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
    reader: { exec: async () => {}, query: async () => ({ meta: [], data: [], rows: 0 }), insert: async () => {} },
  } as unknown as Dependencies;
  router.auth = auth as any;
  const credentials = {
    authenticate(req: any, agentID: string, audience: string) {
      if (agentID !== "agent-1" || audience !== "control" || req.headers.authorization !== "Bearer control-secret") throw new HTTPError(401, "invalid Agent credential");
      return { credential_id: "credential-1", agent_id: agentID, audience, scope: "agent.control", expires_at: "", last_used_at: "" };
    },
  } as any;
  const jobs = registerAgentJobs(deps, { agentCredentials: credentials });
  const temporary = await mkdtemp(join(tmpdir(), "lightmoni-release-api-"));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); await rm(temporary, { recursive: true, force: true }); });
  const artifacts = new ReleaseArtifactStore(join(temporary, "release-artifacts"));
  registerServiceDeployments(deps, { jobs, artifacts });
  const server = createServer((req, res) => void router.handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const requestJSON = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };

  const created = await requestJSON("/api/v1/services", "POST", { name: "checkout" });
  assert.equal(created.status, 201);
  const serviceID = created.data.id as string;
  const target = await requestJSON(`/api/v1/services/${serviceID}/targets`, "POST", { machine_id: "machine-1", adapter: "systemd", config: { unit: "checkout.service", release_directory: "/opt/lightmoni/checkout" } });
  assert.equal(target.status, 201);
  const release = await requestJSON(`/api/v1/services/${serviceID}/releases`, "POST", { version: "v1", source_type: "artifact", source_ref: "git:0123456789abcdef" });
  assert.equal(release.status, 201);
  assert.equal(release.data.status, "pending_artifact");
  const rejected = await requestJSON(`/api/v1/services/${serviceID}/releases`, "POST", { version: "v-rejected", source_type: "artifact", source_ref: "git:0123456789abcdef" });
  const rejectedBytes = releaseBundle(serviceID, "different-version"), rejectedDigest = createHash("sha256").update(rejectedBytes).digest("hex");
  const rejectedUpload = await fetch(`${base}/api/v1/services/${serviceID}/releases/${rejected.data.id}/artifact`, {
    method: "PUT", headers: { "content-type": "application/vnd.lightmoni.release+gzip", "x-artifact-sha256": rejectedDigest }, body: rejectedBytes,
  });
  assert.equal(rejectedUpload.status, 422);
  assert.equal(await artifacts.inspect(rejectedDigest), undefined, "a manifest mismatch must remove the unreferenced blob");
  const bytes = releaseBundle(serviceID, "v1"), digest = createHash("sha256").update(bytes).digest("hex");
  const upload = await fetch(`${base}/api/v1/services/${serviceID}/releases/${release.data.id}/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/vnd.lightmoni.release+gzip", "x-artifact-sha256": digest },
    body: bytes,
  });
  const uploaded = await upload.json() as any;
  assert.equal(upload.status, 201);
  assert.equal(uploaded.status, "ready");
  assert.equal(uploaded.sha256, digest);
  assert.equal(uploaded.size, bytes.length);
  assert.equal(JSON.stringify(uploaded).includes(temporary), false);
  const listed = await requestJSON(`/api/v1/services/${serviceID}/releases`);
  const listedRelease = listed.data.find((item: any) => item.id === release.data.id);
  assert.equal(listedRelease.artifact_size, bytes.length);
  assert.equal(listedRelease.artifact_format, "lightmoni-release-v1.tar.gz");
  const replacement = await fetch(`${base}/api/v1/services/${serviceID}/releases/${release.data.id}/artifact`, {
    method: "PUT", headers: { "content-type": "application/vnd.lightmoni.release+gzip", "x-artifact-sha256": digest }, body: bytes,
  });
  assert.equal(replacement.status, 409);

  const plan = await requestJSON(`/api/v1/services/${serviceID}/deployments/plan`, "POST", { target_id: target.data.id, release_id: release.data.id });
  assert.equal(plan.status, 201);
  const actions = [
    { kind: "stage_artifact", release_id: release.data.id, service_id: serviceID, version: "v1", architecture: "linux-amd64", destination: "releases/v1", sha256: digest, size: bytes.length },
    { kind: "activate_release", releaseDirectory: "/opt/lightmoni/checkout", version: "v1", expectedCurrentVersion: "" },
    { kind: "health_check", check: { kind: "systemd-active", unit: "checkout.service" } },
  ];
  const job = jobs.enqueue({ agentID: "agent-1", deploymentID: plan.data.id, operationID: "operation-1", actions, capabilities: ["artifact.stage", "artifact.activate_release", "health.systemd"], target: { config: { unit: "checkout.service", release_directory: "/opt/lightmoni/checkout" } } });
  const leased = jobs.claim("agent-1", ["artifact.stage", "artifact.activate_release", "health.systemd"]);
  assert.equal(leased?.id, job.id);
  jobs.event("agent-1", job.id, { lease_id: leased!.lease_id, sequence: 1, phase: "accepted", summary: "accepted" });
  jobs.event("agent-1", job.id, { lease_id: leased!.lease_id, sequence: 2, phase: "staging", summary: "staging" });
  const endpoint = `${base}/api/v1/agents/agent-1/jobs/${job.id}/artifacts/${release.data.id}`;
  const download = await fetch(endpoint, { headers: { authorization: "Bearer control-secret", "X-LightMoni-Job-Lease": leased!.lease_id } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("x-artifact-sha256"), digest);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const wrongLease = await fetch(endpoint, { headers: { authorization: "Bearer control-secret", "X-LightMoni-Job-Lease": "wrong" } });
  assert.equal(wrongLease.status, 409);
  const wrongAgent = await fetch(endpoint.replace("agent-1", "agent-2"), { headers: { authorization: "Bearer control-secret", "X-LightMoni-Job-Lease": leased!.lease_id } });
  assert.equal(wrongAgent.status, 401);
  const wrongRelease = await fetch(`${base}/api/v1/agents/agent-1/jobs/${job.id}/artifacts/${"b".repeat(32)}`, { headers: { authorization: "Bearer control-secret", "X-LightMoni-Job-Lease": leased!.lease_id } });
  assert.equal(wrongRelease.status, 403);
});

