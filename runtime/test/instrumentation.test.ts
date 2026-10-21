import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
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
