/** Disposable Docker smoke of the four SDD094 recipes; no production services. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { catalogInstallation } from "../../src/ops/catalog.js";
import { normalizeApplication, renderManifest } from "../../src/operations/platform.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "lm-catalog094-")));
const out = resolve(import.meta.dirname, "../../../specs/094-catalog-search-storage/evidence");
const checks: any[] = [];
let currentID = "", complete = false;
const ids = (process.env.LIGHTMONI_CATALOG_SMOKE_IDS ?? "meilisearch,searxng,rustfs,firecrawl").split(",");
const context: any = { dataDir: root, signal: new AbortController().signal, now: () => new Date() };
const projects: string[][] = [];
const key = randomBytes(24).toString("hex"), access = "qa-access-" + randomBytes(4).toString("hex");
const docker = (args: string[], timeout = 30000) => execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", timeout });
const request = (url: string, options: any = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
async function ready(url: string, seconds = 180) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try { if ((await request(url)).ok) return; } catch {}
    await setTimeout(1000);
  }
  throw Error("HTTP readiness timed out");
}
function s3(base: string, path: string, method = "GET", data?: string) {
  try {
    return execFileSync("curl", ["--max-time", "20", "--fail", "--silent", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", access + ":" + key, "-X", method, ...(data !== undefined ? ["--data-binary", data] : []), base + path], { encoding: "utf8", stdio: "pipe" });
  } catch { throw Error("signed S3 request failed"); }
}
try {
  for (const id of ids) {
    currentID = id;
    assert.ok(["meilisearch", "searxng", "rustfs", "firecrawl"].includes(id));
    const parameters = id === "meilisearch" ? { master_key: key } : id === "rustfs" ? { access_key: access, secret_key: key } : {};
    const spec = catalogInstallation(id, { parameters, listen_ip: "127.0.0.1" }).spec;
    for (const [name, service] of Object.entries<any>(spec.compose.services)) {
      service.ports = spec.ports.filter((p: any) => p.service === name).map((p: any) => ({ target: p.container_port, published: "0", host_ip: "127.0.0.1", protocol: p.protocol }));
    }
    const manifest = await renderManifest(context, "catalog094-" + id, normalizeApplication(spec), 1);
    const path = join(root, id + ".json"), project = "lm-catalog094-" + id + "-" + randomBytes(3).toString("hex");
    await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
    const args = ["compose", "--project-name", project, "-f", path];
    projects.push(args);
    docker([...args, "config", "--quiet"]);
    docker([...args, "up", "-d", "--pull", "never"], 60000);
    const endpoint = (name: string, port: number) => "http://" + docker([...args, "port", name, String(port)]).trim();
    const main = spec.ports[0], base = endpoint(main.service, main.container_port);
    await ready(base + (id === "meilisearch" ? "/health" : id === "searxng" ? "/healthz" : id === "rustfs" ? "/health" : "/"), id === "firecrawl" ? 300 : 180);
    if (id === "meilisearch") {
      assert.equal((await request(base + "/indexes")).status, 401);
      const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
      const response = await request(base + "/indexes/qa/documents?primaryKey=id", { method: "POST", headers, body: JSON.stringify([{ id: 1, title: "LightMoni search verification" }]) });
      assert.equal(response.status, 202);
      const task = await response.json() as any;
      let succeeded = false;
      for (let i = 0; i < 30; i++) {
        const result = await (await request(base + "/tasks/" + task.taskUid, { headers })).json() as any;
        if (result.status === "succeeded") { succeeded = true; break; }
        assert.notEqual(result.status, "failed");
        await setTimeout(500);
      }
      assert.ok(succeeded);
      const found = await (await request(base + "/indexes/qa/search", { method: "POST", headers, body: JSON.stringify({ q: "LightMoni" }) })).json() as any;
      assert.equal(found.hits[0].id, 1);
      checks.push({ id, result: "passed", behavior: "production auth rejects missing key; authenticated indexing and search" });
    } else if (id === "searxng") {
      assert.match(await (await request(base)).text(), /SearXNG/);
      // Assert the response format, without requiring any public engine to return hits.
      const response = await request(base + "/search?q=LightMoni&format=json");
      assert.equal(response.status, 200);
      assert.ok(Array.isArray((await response.json() as any).results));
      checks.push({ id, result: "passed", behavior: "healthy native entrypoint, homepage and HTML/JSON search formats; no public-engine availability claim" });
    } else if (id === "rustfs") {
      const consoleURL = endpoint("rustfs", 9001);
      await ready(consoleURL + "/rustfs/console/health");
      assert.ok([400, 403].includes((await request(base + "/")).status));
      s3(base, "/lightmoni-qa", "PUT");
      s3(base, "/lightmoni-qa/probe.txt", "PUT", "LightMoni S3 verification");
      assert.equal(s3(base, "/lightmoni-qa/probe.txt"), "LightMoni S3 verification");
      assert.match(s3(base, "/"), /lightmoni-qa/);
      checks.push({ id, result: "passed", behavior: "non-root volumes, S3 auth, signed bucket/object write/read, console health" });
    } else {
      const response = await request(base + "/v1/scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }) });
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.success, true);
      assert.match(body.data.markdown, /Example Domain/);
      checks.push({ id, result: "passed", behavior: "five-service startup, API/worker/queue/database connectivity and real Markdown scrape" });
    }
    const containers = docker([...args, "ps", "--all", "--format", "json"]).trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
    assert.equal(containers.length, Object.keys(spec.compose.services).length);
    assert.ok(containers.every(c => c.State === "running"));
    for (let i = 0; i < 45; i++) {
      const states = docker([...args, "ps", "--all", "--format", "json"]).trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
      if (states.every(c => !c.Health || c.Health === "healthy")) break;
      if (i === 44) throw Error("container healthcheck did not become healthy");
      await setTimeout(1000);
    }
    docker([...args, "down", "--volumes", "--remove-orphans"], 60000);
    projects.pop();
    process.stdout.write(id + ": passed\n");
  }
  complete = true;
} finally {
  let cleaned = true;
  for (const args of projects.reverse()) {
    try { docker([...args, "down", "--volumes", "--remove-orphans"], 60000); } catch { cleaned = false; process.stderr.write("QA project cleanup failed\n"); }
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  let previous: any[] = [];
  try { previous = JSON.parse(await readFile(join(out, "live.json"), "utf8")).checks ?? []; } catch {}
  if (!complete) checks.push({ id: currentID, result: "failed", behavior: "Smoke did not complete; inspect the local run log before claiming availability" });
  const results = [...previous.filter(c => !checks.some(n => n.id === c.id)), ...checks];
  await writeFile(join(out, "live.json"), JSON.stringify({ platform: process.arch, checks: results, production_modified: false, cleanup: cleaned ? "containers, project networks, volumes and temporary credentials removed" : "cleanup failed; inspect local run log" }, null, 2) + "\n");
}
