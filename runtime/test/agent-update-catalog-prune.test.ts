import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentReleaseCatalog } from "../src/server/machine-agent-updates-catalog.js";

const sha = (suffix: number) => "e".repeat(63) + suffix.toString(16);

function catalogWithCache() {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-agent-catalog-"));
  const downloads = join(directory, "downloads"), cache = join(directory, "cache");
  mkdirSync(downloads); mkdirSync(cache);
  return { catalog: new AgentReleaseCatalog(downloads, cache), cache, directory };
}

test("catalog prune keeps newest pins and every retained reference", () => {
  const { catalog, cache, directory } = catalogWithCache();
  try {
    const old = new Date("2020-01-01T00:00:00Z");
    for (let index = 0; index < 12; index++) {
      const path = join(cache, sha(index));
      writeFileSync(path, `pin-${index}`);
      utimesSync(path, old, new Date(old.getTime() + index * 1000));
    }
    writeFileSync(join(cache, ".staging-tmp"), "in flight");
    mkdirSync(join(cache, sha(12))); // sha-named directory is not a pin
    const removed = catalog.prune(new Set([sha(0)]), 8);
    assert.equal(removed, 3); // 12 pins - 8 newest, one of them retained
    assert.ok(existsSync(join(cache, sha(0)))); // retained reference survives
    for (let index = 1; index <= 3; index++) assert.ok(!existsSync(join(cache, sha(index))), `pin ${index} pruned`);
    for (let index = 4; index < 12; index++) assert.ok(existsSync(join(cache, sha(index))), `pin ${index} kept as newest`);
    assert.ok(existsSync(join(cache, ".staging-tmp"))); // staging files are never touched
    assert.ok(existsSync(join(cache, sha(12)))); // non-file entries are never touched
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("catalog prune tolerates a missing cache directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-agent-catalog-"));
  try {
    const catalog = new AgentReleaseCatalog(join(directory, "downloads"), join(directory, "missing"));
    assert.equal(catalog.prune(new Set()), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
