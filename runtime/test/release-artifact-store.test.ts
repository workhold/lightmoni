import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseArtifactError, ReleaseArtifactStore } from "../src/deployment/artifact-store.js";

async function* chunks(...values: Buffer[]) {
  for (const value of values) yield value;
}

test("release artifacts are digest addressed, private, and immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = Buffer.from("private bundle bytes"), sha256 = createHash("sha256").update(content).digest("hex");
  const store = new ReleaseArtifactStore(join(root, "release-artifacts"));
  const result = await store.put(chunks(content.subarray(0, 7), content.subarray(7)), { contentLength: content.length, expectedSha256: sha256 });
  assert.equal(result.sha256, sha256);
  assert.equal(result.size, content.length);
  assert.deepEqual(await readFile(result.path), content);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "release-artifacts"))).mode & 0o777, 0o700);
  assert.equal((await store.inspect(sha256))?.sha256, sha256);
  await assert.rejects(() => store.put(chunks(Buffer.from("different")), {
    contentLength: Buffer.byteLength("different"), expectedSha256: sha256,
  }), (error: unknown) => error instanceof ReleaseArtifactError && error.code === "digest_mismatch");
  assert.deepEqual(await readFile(result.path), content);
});

test("release artifact storage rejects symlinked digest directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-store-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  await mkdir(outside);
  const sha256 = "a".repeat(64);
  const storage = join(root, "release-artifacts");
  await mkdir(join(storage, "sha256"), { recursive: true });
  await symlink(outside, join(storage, "sha256", "aa"));
  const store = new ReleaseArtifactStore(storage);
  await assert.rejects(() => store.put(chunks(Buffer.from("x")), {
    contentLength: 1, expectedSha256: sha256,
  }), (error: unknown) => error instanceof ReleaseArtifactError && error.code === "artifact_io");
  assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
});

test("artifact inspection rejects symlinked parents and content that no longer matches its digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "store"), outside = join(root, "outside");
  const content = Buffer.from("expected release bytes"), digest = createHash("sha256").update(content).digest("hex");
  const store = new ReleaseArtifactStore(storeRoot);
  const stored = await store.put(chunks(content), { contentLength: content.length, expectedSha256: digest });
  assert.ok(await store.inspect(digest));

  await writeFile(stored.path, "tampered release bytes");
  assert.equal(await store.inspect(digest), undefined, "content is re-hashed before private downloads");
  await writeFile(stored.path, content);
  const digestDirectory = join(storeRoot, "sha256");
  await mkdir(outside);
  await rm(digestDirectory, { recursive: true });
  await symlink(outside, digestDirectory);
  assert.equal(await store.inspect(digest), undefined, "parent symlinks must never redirect private artifact reads");
});
