import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstrumentationService } from "../src/assistant/instrumentation.js";

test("instrumentation scan is read-only and identifies SDK and request/error boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-instrumentation-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@lightmoni/sdk": "^0.3.0", express: "^5" } }));
  await writeFile(join(root, "src", "server.ts"), [
    "import express from 'express';",
    "import { createLightMoni } from '@lightmoni/sdk';",
    "const app = express();",
    "app.get('/health', (req, res) => res.send('ok'));",
    "try { throw new Error('x'); } catch (error) { console.error(error); }",
  ].join("\n"));
  const result = await new InstrumentationService(root).scan(".");
  assert.equal(result.state, "scanned");
  assert.equal(result.sdk.found, true);
  assert.equal(result.sdk.mode, "direct");
  assert.deepEqual(result.languages, ["typescript"]);
  assert.ok(result.frameworks.includes("express"));
  assert.ok(result.candidates.some((item) => item.kind === "request_boundary"));
  assert.ok(result.candidates.some((item) => item.kind === "error_boundary"));
  const before = result.base_revision;
  assert.notEqual(before, "");
  await assert.rejects(() => new InstrumentationService(root).scan("../"), /outside/);
});

test("instrumentation scan keeps revisions stable and rejects workspace symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-instrumentation-root-"));
  const outside = await mkdtemp(join(tmpdir(), "lightmoni-instrumentation-outside-"));
  await writeFile(join(root, "service.ts"), [
    "// an agent comment must not select the Agent transport",
    "import { createLightMoni } from '@lightmoni/sdk';",
  ].join("\n"));
  await writeFile(join(outside, "secret.ts"), "const secret = true;\n");
  await symlink(outside, join(root, "escape"), "dir");

  const service = new InstrumentationService(root);
  const first = await service.scan(".");
  const second = await service.scan(".");
  assert.equal(first.base_revision, second.base_revision);
  assert.equal(first.sdk.mode, "direct");
  await assert.rejects(() => service.scan("escape"), /outside/);
});

test("instrumentation proposal returns a structured TypeScript diff without writing the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-instrumentation-plan-"));
  const source = [
    "import express from 'express';",
    "import { createLightMoni } from '@lightmoni/sdk';",
    "const app = express();",
    "const mon = createLightMoni({ service: 'checkout', env: 'prod' });",
    "app.get('/health', async (req, res) => {",
    "  res.send('ok');",
    "});",
    "",
  ].join("\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@lightmoni/sdk": "^0.3.0", express: "^5" } }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "server.ts"), source);
  const service = new InstrumentationService(root);
  const plan = await service.propose({ workspace: ".", intent: "为请求边界增加计数", service: "checkout", env: "prod" });
  assert.equal(plan.state, "awaiting_approval");
  assert.ok(plan.plan_id.startsWith("ip_"));
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]?.path, "src/server.ts");
  assert.match(plan.files[0]?.patch ?? "", /mon\.record\("service", "requests_total"/);
  assert.equal(plan.files[0]?.operations[0]?.op, "insert");
  assert.equal(await readFile(join(root, "src", "server.ts"), "utf8"), source);
  assert.ok(plan.validation_steps.length > 0);
});

test("instrumentation proposal uses agent-local credentials only and reports unsupported files as manual work", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-instrumentation-agent-plan-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@lightmoni/sdk": "^0.3.0" } }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "server.js"), [
    "import { createLightMoni } from '@lightmoni/sdk';",
    "const app = createApp();",
    "app.post('/jobs', (req, res) => {",
    "  res.sendStatus(202);",
    "});",
  ].join("\n"));
  await writeFile(join(root, "worker.py"), "from lightmoni import Client\ndef get_jobs(request):\n    return 'ok'\n");
  const plan = await new InstrumentationService(root).propose({ workspace: ".", intent: "记录请求", mode: "agent" });
  assert.equal(plan.files.length, 1);
  assert.match(plan.files[0]?.patch ?? "", /LIGHTMONI_LOCAL_TOKEN/);
  assert.doesNotMatch(plan.files[0]?.patch ?? "", /control_credential|data_credential|api_key/i);
  assert.ok(plan.manual_steps.some((step) => step.includes("worker.py")));
});

test("instrumentation proposal refuses stale revisions and gives manual steps when SDK is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-instrumentation-manual-"));
  await writeFile(join(root, "server.py"), "def get_health(request):\n    return 'ok'\n");
  const service = new InstrumentationService(root);
  const plan = await service.propose({ workspace: ".", intent: "增加请求指标" });
  assert.equal(plan.files.length, 0);
  assert.ok(plan.manual_steps.some((step) => /SDK/.test(step)));
  await assert.rejects(
    () => service.propose({ workspace: ".", intent: "增加请求指标", base_revision: "stale" }),
    /revision conflict/,
  );
});
