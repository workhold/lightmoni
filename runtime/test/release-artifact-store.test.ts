import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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

test("artifact collection previews and removes only old unreferenced regular digest files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-gc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "release-artifacts"), store = new ReleaseArtifactStore(storeRoot);
  const oldBytes = Buffer.from("old failed upload"), oldDigest = createHash("sha256").update(oldBytes).digest("hex");
  const old = await store.put(chunks(oldBytes), { contentLength: oldBytes.length, expectedSha256: oldDigest });
  const referencedBytes = Buffer.from("still referenced"), referencedDigest = createHash("sha256").update(referencedBytes).digest("hex");
  const referenced = await store.put(chunks(referencedBytes), { contentLength: referencedBytes.length, expectedSha256: referencedDigest });
  const now = Date.now(), oldTime = new Date(now - 25 * 60 * 60 * 1000), recentTime = new Date(now - 60 * 60 * 1000);
  await utimes(old.path, oldTime, oldTime);
  await utimes(referenced.path, oldTime, oldTime);

  const symlinkDigest = "f".repeat(64), symlinkDirectory = join(storeRoot, "sha256", "ff");
  const outside = join(root, "outside");
  await mkdir(symlinkDirectory, { recursive: true });
  await writeFile(outside, "must remain");
  await symlink(outside, join(symlinkDirectory, symlinkDigest));
  const recentBytes = Buffer.from("recent orphan"), recentDigest = createHash("sha256").update(recentBytes).digest("hex");
  const recent = await store.put(chunks(recentBytes), { contentLength: recentBytes.length, expectedSha256: recentDigest });
  await utimes(recent.path, recentTime, recentTime);

  const references = new Set([referencedDigest]);
  const preview = await store.collectUnreferenced(references, { olderThanMs: now - 24 * 60 * 60 * 1000, dryRun: true });
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.eligibleBytes, oldBytes.length);
  assert.equal(preview.deletedCount, 0);
  assert.ok(await store.inspect(oldDigest), "dry-run leaves the orphan untouched");
  assert.ok(await store.inspect(referencedDigest), "old objects referenced by any release remain untouched");
  assert.ok(await store.inspect(recentDigest), "recent orphans remain inside the retention window");

  const deletion = await store.collectUnreferenced(references, { olderThanMs: now - 24 * 60 * 60 * 1000, dryRun: false });
  assert.equal(deletion.deletedCount, 1);
  assert.equal(deletion.deletedBytes, oldBytes.length);
  assert.equal(await store.inspect(oldDigest), undefined);
  assert.ok(await store.inspect(referencedDigest));
  assert.ok(await store.inspect(recentDigest));
  assert.deepEqual(await readFile(outside), Buffer.from("must remain"), "symlink targets are never followed or removed");
});

test("artifact collection caps each confirmed pass at 500 deletions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-gc-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "release-artifacts"), directory = join(storeRoot, "sha256", "aa");
  await mkdir(directory, { recursive: true });
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const digests = Array.from({ length: 501 }, (_, index) => `aa${index.toString(16).padStart(62, "0")}`);
  await Promise.all(digests.map(async (digest) => {
    const path = join(directory, digest);
    await writeFile(path, "orphan");
    await utimes(path, oldTime, oldTime);
  }));

  const store = new ReleaseArtifactStore(storeRoot);
  const first = await store.collectUnreferenced(new Set(), { olderThanMs: Date.now() - 24 * 60 * 60 * 1000, dryRun: false });
  assert.equal(first.deletedCount, 500);
  assert.equal(first.truncated, true);
  assert.ok(first.cursor);
  const second = await store.collectUnreferenced(new Set(), { olderThanMs: Date.now(), dryRun: false, cursor: first.cursor });
  assert.equal(second.deletedCount, 1);
  assert.equal(second.truncated, false);
  assert.equal(second.cursor, undefined);
  await assert.rejects(() => store.collectUnreferenced(new Set(), { olderThanMs: Date.now(), dryRun: false, cursor: first.cursor }),
    (error: unknown) => error instanceof ReleaseArtifactError && error.code === "invalid_artifact");
});

test("artifact collection continues beyond the scan limit with a bound cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-gc-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "store"), directory = join(storeRoot, "sha256", "aa");
  await mkdir(directory, { recursive: true });
  // Unknown names still consume the scan budget, but cannot starve later entries.
  for (let batch = 0; batch < 101; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(directory, `unknown-${batch * 100 + index}`), "x")));
  }
  const digest = "a".repeat(64), path = join(directory, digest);
  await writeFile(path, "old orphan");
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(path, stale, stale);
  const store = new ReleaseArtifactStore(storeRoot), cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const first = await store.collectUnreferenced(new Set(), { olderThanMs: cutoff, dryRun: true });
  assert.equal(first.scannedEntries, 10_000);
  assert.equal(first.truncated, true);
  assert.ok(first.cursor);
  const second = await store.collectUnreferenced(new Set(), { olderThanMs: cutoff + 1, dryRun: true, cursor: first.cursor });
  assert.equal(second.truncated, false);
  assert.equal(first.scannedEntries + second.scannedEntries, 10_102);
  assert.equal(first.eligibleCount + second.eligibleCount, 1);
  assert.deepEqual(await readFile(path), Buffer.from("old orphan"));
});

test("collection continuations preserve the cutoff and use current references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-gc-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "store"), directory = join(storeRoot, "sha256", "aa");
  await mkdir(directory, { recursive: true });
  const initialNow = Date.now(), cutoff = initialNow - 24 * 60 * 60 * 1000;
  const digests = Array.from({ length: 502 }, (_, index) => `aa${index.toString(16).padStart(62, "0")}`);
  await Promise.all(digests.map(async (digest) => {
    const path = join(directory, digest);
    await writeFile(path, "orphan");
    const modified = new Date(digest === digests[501] ? cutoff + 1000 : cutoff - 1000);
    await utimes(path, modified, modified);
  }));
  const store = new ReleaseArtifactStore(storeRoot);
  const first = await store.collectUnreferenced(new Set(), { olderThanMs: cutoff, dryRun: false });
  assert.ok(first.cursor);
  const remaining = new Set<string>();
  for (const digest of digests) {
    if (digest !== digests[501] && await stat(join(directory, digest)).catch(() => undefined)) remaining.add(digest);
  }
  const second = await store.collectUnreferenced(remaining, { olderThanMs: initialNow, dryRun: false, cursor: first.cursor });
  assert.equal(second.deletedCount, 0, "continuation uses newly supplied references");
  assert.equal(second.truncated, false);
  assert.ok(await stat(join(directory, digests[501])), "the initial cutoff still protects recent objects");

  const next = await store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: true });
  assert.equal(next.truncated, false);
  await assert.rejects(() => store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: true, cursor: "unknown" }),
    (error: unknown) => error instanceof ReleaseArtifactError && error.code === "invalid_artifact");
});

test("collection cursors reject a different mode and expire", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-gc-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "store"), directory = join(storeRoot, "sha256", "aa");
  await mkdir(directory, { recursive: true });
  const initialNow = Date.now(), stale = new Date(initialNow - 25 * 60 * 60 * 1000);
  await Promise.all(Array.from({ length: 1001 }, async (_, index) => {
    const path = join(directory, `aa${index.toString(16).padStart(62, "0")}`);
    await writeFile(path, "old orphan");
    await utimes(path, stale, stale);
  }));
  const store = new ReleaseArtifactStore(storeRoot);
  const first = await store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: false });
  assert.ok(first.cursor);
  await assert.rejects(() => store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: true, cursor: first.cursor }),
    (error: unknown) => error instanceof ReleaseArtifactError && error.code === "invalid_artifact");
  const second = await store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: false, cursor: first.cursor });
  assert.equal(second.deletedCount, 500, "invalid mode does not destroy the valid continuation");
  assert.ok(second.cursor);
  t.mock.method(Date, "now", () => initialNow + 6 * 60 * 1000);
  await assert.rejects(() => store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: false, cursor: second.cursor }),
    (error: unknown) => error instanceof ReleaseArtifactError && error.code === "invalid_artifact");
  const fresh = await store.collectUnreferenced(new Set(), { olderThanMs: initialNow, dryRun: true });
  assert.equal(fresh.eligibleCount, 1);
  assert.equal(fresh.truncated, false);
});

test("artifact collection skips hard links and prefix symlinks and rejects unsafe ancestors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lightmoni-release-gc-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "store"), directory = join(storeRoot, "sha256", "aa");
  await mkdir(directory, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  const hardDigest = "a".repeat(64), symlinkDigest = "b".repeat(64);
  await writeFile(join(outside, hardDigest), "hard-linked object");
  await writeFile(join(outside, symlinkDigest), "outside object");
  await link(join(outside, hardDigest), join(directory, hardDigest));
  await symlink(outside, join(storeRoot, "sha256", "bb"));
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(join(outside, hardDigest), stale, stale);
  await utimes(join(outside, symlinkDigest), stale, stale);
  const store = new ReleaseArtifactStore(storeRoot);
  const result = await store.collectUnreferenced(new Set(), { olderThanMs: Date.now() - 24 * 60 * 60 * 1000, dryRun: false });
  assert.equal(result.deletedCount, 0);
  assert.deepEqual(await readFile(join(outside, hardDigest)), Buffer.from("hard-linked object"));
  assert.deepEqual(await readFile(join(outside, symlinkDigest)), Buffer.from("outside object"));

  await chmod(root, 0o777);
  await assert.rejects(() => store.collectUnreferenced(new Set(), { olderThanMs: Date.now(), dryRun: false }),
    (error: unknown) => error instanceof ReleaseArtifactError && error.code === "artifact_io");
  await chmod(root, 0o700);
  const linkedStore = new ReleaseArtifactStore(join(root, "linked-store"));
  await symlink(storeRoot, linkedStore.directory);
  await assert.rejects(() => linkedStore.collectUnreferenced(new Set(), { olderThanMs: Date.now(), dryRun: false }),
    (error: unknown) => error instanceof ReleaseArtifactError && error.code === "artifact_io");
});
