import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { digest } from "../src/agent/config.js";
import { AgentJobRunner } from "../src/agent/jobs.js";

function releaseBundle(serviceID: string, version: string, architecture: "any" | "linux-amd64" | "linux-arm64") {
  const entries = [
    { name: "manifest.json", content: Buffer.from(JSON.stringify({ schema_version: 1, service_id: serviceID, version, architecture, source_revision: "test", entrypoint: "run" })), mode: 0o644 },
    { name: "run", content: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
  ];
  const blocks = entries.map(({ name, content, mode }) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(mode.toString(8).padStart(7, "0") + "\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    Buffer.from("ustar\0", "binary").copy(header, 257);
    header.write("00", 263, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return [header, content, Buffer.alloc((512 - content.length % 512) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks.flat(), Buffer.alloc(1024)]));
}

test("Agent job runner reports an in-flight marker as unknown after restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-restart-"));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "agent-job-state.json"), JSON.stringify({ id: "job-1", lease_id: "lease-1", started_at: "2026-10-22T00:00:00.000Z" }));
  const calls: any[] = [];
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir }, {
    fetch: (async (url: any, init: any) => {
      calls.push({ url, init: JSON.parse(init.body) });
      return new Response(JSON.stringify({ state: "unknown" }), { status: 200 });
    }) as typeof fetch,
  });
  await runner.recoverUnknown();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.state, "unknown");
  assert.equal(calls[0].init.code, "unknown_execution_result");
  assert.equal(JSON.parse(readFileSync(join(dataDir, "agent-job-state.json"), "utf8")).id, undefined);
  assert.equal(existsSync(join(dataDir, "agent-job-state.json")), true);
});

test("Agent job runner downloads release only with control credential and current job lease", { skip: process.platform !== "linux" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-artifact-"));
  const releaseDirectory = join(dataDir, "service");
  mkdirSync(releaseDirectory);
  const serviceID = "a".repeat(32), version = "v1";
  const architecture = process.arch === "arm64" ? "linux-arm64" as const : "linux-amd64" as const;
  const bytes = releaseBundle(serviceID, version, architecture), sha256 = digest(bytes);
  const action = { kind: "stage_artifact", release_id: "release_1", service_id: serviceID, version, architecture, destination: "releases/v1", sha256, size: bytes.length };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const runner = new AgentJobRunner({ endpoint: "https://center", agentID: "agent-1", controlCredential: "control-secret", dataDir, now: () => new Date("2026-10-22T00:00:00Z") }, {
    fetch: (async (url: any, init: RequestInit) => {
      const value = { url: String(url), init };
      calls.push(value);
      if (value.url.endsWith("/jobs/claim")) return new Response(JSON.stringify({ job: {
        id: "job-1", lease_id: "lease-1", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], actions: [action],
        target: { config: { release_directory: releaseDirectory, unit: "checkout.service" } }, next_sequence: 0,
      } }), { status: 200 });
      if (value.url.endsWith("/artifacts/release_1")) return new Response(bytes, { status: 200, headers: {
        "content-length": String(bytes.length), "x-artifact-sha256": sha256, "x-artifact-format": "lightmoni-release-v1.tar.gz",
      } });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const result = await runner.pollOnce();
  assert.equal(result?.state, "succeeded");
  const download = calls.find((call) => call.url.endsWith("/artifacts/release_1"));
  assert.ok(download);
  assert.equal(download.url, "https://center/api/v1/agents/agent-1/jobs/job-1/artifacts/release_1");
  assert.equal(new Headers(download.init.headers).get("authorization"), "Bearer control-secret");
  assert.equal(new Headers(download.init.headers).get("x-lightmoni-job-lease"), "lease-1");
  assert.equal(existsSync(join(releaseDirectory, "releases", version, "run")), true);
});

test("Agent job runner rejects artifact response metadata mismatch without staging", { skip: process.platform !== "linux" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-artifact-invalid-"));
  const releaseDirectory = join(dataDir, "service");
  mkdirSync(releaseDirectory);
  const serviceID = "a".repeat(32), bytes = releaseBundle(serviceID, "v1", process.arch === "arm64" ? "linux-arm64" : "linux-amd64"), sha256 = digest(bytes);
  const action = { kind: "stage_artifact", release_id: "release_1", service_id: serviceID, version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" as const : "linux-amd64" as const, destination: "releases/v1", sha256, size: bytes.length };
  const runner = new AgentJobRunner({ endpoint: "https://center", agentID: "agent-1", controlCredential: "secret", dataDir, now: () => new Date("2026-10-22T00:00:00Z") }, {
    fetch: (async (url: any) => {
      const target = String(url);
      if (target.endsWith("/jobs/claim")) return new Response(JSON.stringify({ job: {
        id: "job-1", lease_id: "lease-1", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], actions: [action],
        target: { config: { release_directory: releaseDirectory, unit: "checkout.service" } }, next_sequence: 0,
      } }), { status: 200 });
      if (target.endsWith("/artifacts/release_1")) return new Response(bytes, { status: 200, headers: {
        "content-length": String(bytes.length), "x-artifact-sha256": "0".repeat(64), "x-artifact-format": "lightmoni-release-v1.tar.gz",
      } });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const result = await runner.pollOnce();
  assert.equal(result?.state, "failed");
  assert.equal(result?.code, "invalid_artifact");
  assert.equal(existsSync(join(releaseDirectory, "releases", "v1")), false);
});

test("Agent lease artifact download streams only the declared digest, size, and archive format", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-artifact-stream-"));
  const serviceID = "a".repeat(32), bytes = releaseBundle(serviceID, "v1", "any"), sha256 = digest(bytes);
  const action = { kind: "stage_artifact" as const, release_id: "release_1", service_id: serviceID, version: "v1", architecture: "any" as const, destination: "releases/v1", sha256, size: bytes.length };
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const runner = new AgentJobRunner({ endpoint: "https://center/", agentID: "agent-1", controlCredential: "credential", dataDir }, {
    fetch: (async (url: any, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(bytes, { status: 200, headers: {
        "content-length": String(bytes.length), "x-artifact-sha256": sha256, "x-artifact-format": "lightmoni-release-v1.tar.gz",
      } });
    }) as typeof fetch,
  });
  const downloaded = await (runner as any).downloadArtifact({ id: "job-1", lease_id: "lease-1" }, action, new AbortController().signal) as Buffer;
  assert.deepEqual(downloaded, bytes);
  assert.equal(seen[0]?.url, "https://center/api/v1/agents/agent-1/jobs/job-1/artifacts/release_1");
  assert.equal(new Headers(seen[0]?.init.headers).get("authorization"), "Bearer credential");
  assert.equal(new Headers(seen[0]?.init.headers).get("x-lightmoni-job-lease"), "lease-1");
  assert.equal(seen[0]?.init.redirect, "error");

  const badRunner = new AgentJobRunner({ endpoint: "https://center", agentID: "agent-1", controlCredential: "credential", dataDir }, {
    fetch: (async () => new Response(bytes, { status: 200, headers: {
      "content-length": String(bytes.length), "x-artifact-sha256": "0".repeat(64), "x-artifact-format": "lightmoni-release-v1.tar.gz",
    } })) as typeof fetch,
  });
  await assert.rejects(
    () => (badRunner as any).downloadArtifact({ id: "job-1", lease_id: "lease-1" }, action, new AbortController().signal),
    /metadata does not match/,
  );
});

test("Agent renews the active job lease while a long health check runs", async (t) => {
  let healthRequests = 0;
  const healthServer = createServer((_request, response) => {
    healthRequests++;
    setTimeout(() => { response.writeHead(200); response.end("ok"); }, 160);
  });
  healthServer.listen(0, "127.0.0.1");
  await once(healthServer, "listening");
  t.after(() => healthServer.close());
  const address = healthServer.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-heartbeat-"));
  const events: Array<{ sequence: number; phase: string }> = [];
  let leaseExpiresAt = Date.now() + 45;
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir, leaseHeartbeatIntervalMs: 10 }, {
    fetch: (async (url: any, init: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/jobs/claim")) return new Response(JSON.stringify({ job: {
        id: "job-heartbeat", lease_id: "lease-heartbeat", expires_at: new Date(Date.now() + 60_000).toISOString(),
        capabilities: ["health.http"], actions: [{ kind: "health_check", check: { kind: "http", url: `http://127.0.0.1:${address.port}/health`, timeoutMs: 5000 } }],
        target: { config: { release_directory: "/opt/service", unit: "service.service" } }, next_sequence: 0,
      } }), { status: 200 });
      if (target.endsWith("/events")) {
        const event = JSON.parse(String(init.body));
        assert.ok(Date.now() < leaseExpiresAt, "event arrived before the previous lease expired");
        assert.equal(event.sequence, events.length + 1);
        events.push({ sequence: event.sequence, phase: event.phase });
        leaseExpiresAt = Date.now() + 45;
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/result")) {
        assert.ok(Date.now() < leaseExpiresAt, "final receipt arrived within the renewed lease");
        return new Response("{}", { status: 200 });
      }
      throw Error(`unexpected request ${target}`);
    }) as typeof fetch,
  });
  const receipt = await runner.pollOnce();
  assert.equal(receipt?.state, "succeeded");
  assert.equal(healthRequests, 1);
  assert.ok(events.filter((event) => event.phase === "verifying").length >= 3);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
});

test("Agent stops a running host action when lease renewal fails", async (t) => {
  let healthClosed = false;
  let healthStarted = false;
  const healthServer = createServer((request, response) => {
    healthStarted = true;
    request.on("aborted", () => { healthClosed = true; });
    response.on("close", () => { if (!response.writableEnded) healthClosed = true; });
    // Keep the request active until the Agent aborts it after a failed renewal.
  });
  healthServer.listen(0, "127.0.0.1");
  await once(healthServer, "listening");
  t.after(() => healthServer.close());
  const address = healthServer.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-heartbeat-fail-"));
  let eventCount = 0;
  let resultPosted = false;
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir, leaseHeartbeatIntervalMs: 10 }, {
    fetch: (async (url: any, init: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/jobs/claim")) return new Response(JSON.stringify({ job: {
        id: "job-heartbeat-fail", lease_id: "lease-heartbeat-fail", expires_at: new Date(Date.now() + 60_000).toISOString(),
        capabilities: ["health.http"], actions: [{ kind: "health_check", check: { kind: "http", url: `http://127.0.0.1:${address.port}/health`, timeoutMs: 5000 } }],
        target: { config: { release_directory: "/opt/service", unit: "service.service" } }, next_sequence: 0,
      } }), { status: 200 });
      if (target.endsWith("/events")) {
        eventCount++;
        const event = JSON.parse(String(init.body));
        if (event.phase === "verifying" && eventCount > 2 && healthStarted) return new Response(JSON.stringify({ error: "agent job lease expired" }), { status: 409 });
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/result")) { resultPosted = true; return new Response("{}", { status: 200 }); }
      throw Error(`unexpected request ${target}`);
    }) as typeof fetch,
  });
  await assert.rejects(() => runner.pollOnce());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(healthClosed, true, "the in-flight host health request was aborted");
  assert.equal(resultPosted, false, "a stale lease must not submit a final receipt");
});
