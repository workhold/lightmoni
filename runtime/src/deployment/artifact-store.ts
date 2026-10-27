import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants, type Dirent } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const MAX_RELEASE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const SHA256_PREFIX = /^[a-f0-9]{2}$/i;
const MAX_GC_ENTRIES = 10_000;
const MAX_GC_DELETIONS = 500;
const GC_CURSOR_TTL_MS = 5 * 60_000;

export class ReleaseArtifactError extends Error {
  constructor(readonly code: "invalid_artifact" | "digest_mismatch" | "artifact_too_large" | "artifact_io") {
    super(code);
  }
}

export interface StoredReleaseArtifact {
  /** Internal storage path. Never return this value in an API response. */
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseArtifactCollectionResult {
  scannedEntries: number;
  eligibleCount: number;
  eligibleBytes: number;
  deletedCount: number;
  deletedBytes: number;
  failedCount: number;
  truncated: boolean;
  /** Opaque, short-lived continuation; only valid for this store and mode. */
  cursor?: string;
}

type CollectionEntry = { kind: "prefix" } | { kind: "failure" } | { kind: "file"; prefix: string; entry: Dirent };
interface CollectionSession {
  cursor: string;
  dryRun: boolean;
  olderThanMs: number;
  expiresAt: number;
  iterator: AsyncGenerator<CollectionEntry>;
  timer: ReturnType<typeof setTimeout>;
  active: boolean;
}

/** Private immutable content-addressed storage for uploaded service releases. */
export class ReleaseArtifactStore {
  private collection?: CollectionSession;
  private collectionActive = false;
  constructor(readonly directory: string) {}

  /** Resolve only through trusted ancestors, then check every storage component. */
  private async trustedStorageDirectory(...parts: string[]) {
    const trustedUIDs = new Set([0, process.geteuid?.() ?? -1]);
    const checkAncestors = async (path: string, allowSystemSymlinks: boolean) => {
      const root = parse(path).root;
      let current = root;
      for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        const info = await lstat(current);
        // macOS /var and /tmp are root-owned system symlinks. Their parents
        // and resolved targets are checked too; user-owned links are rejected.
        if (allowSystemSymlinks && info.isSymbolicLink() && info.uid === 0) continue;
        const stickyRootDirectory = info.uid === 0 && (info.mode & 0o1000) !== 0;
        if (!info.isDirectory() || info.isSymbolicLink() || !trustedUIDs.has(info.uid)
          || (!stickyRootDirectory && (info.mode & 0o022) !== 0)) throw new ReleaseArtifactError("artifact_io");
      }
    };
    const configured = resolve(this.directory);
    await checkAncestors(dirname(configured), true);
    const rootInfo = await lstat(configured);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ReleaseArtifactError("artifact_io");
    const absoluteDirectory = await realpath(configured);
    const path = join(absoluteDirectory, ...parts);
    await checkAncestors(path, false);
    return path;
  }

  private contentPath(sha256: string) {
    if (!SHA256.test(sha256)) throw new ReleaseArtifactError("invalid_artifact");
    const digest = sha256.toLowerCase();
    return join(this.directory, "sha256", digest.slice(0, 2), digest);
  }

  private async ensureDirectory(path: string) {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReleaseArtifactError("artifact_io");
    await chmod(path, 0o700);
  }

  private async ensureContentDirectory(path: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new ReleaseArtifactError("artifact_io");
    await chmod(this.directory, 0o700);
    await this.ensureDirectory(join(this.directory, "sha256"));
    await this.ensureDirectory(path);
  }

  async put(
    source: AsyncIterable<Uint8Array>,
    options: { contentLength: number; expectedSha256: string; signal?: AbortSignal },
  ): Promise<StoredReleaseArtifact> {
    const { contentLength, expectedSha256, signal } = options;
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_RELEASE_ARTIFACT_BYTES)
      throw new ReleaseArtifactError("artifact_too_large");
    if (!SHA256.test(expectedSha256)) throw new ReleaseArtifactError("invalid_artifact");

    const destination = this.contentPath(expectedSha256);
    const directory = dirname(destination);
    await this.ensureContentDirectory(directory);
    const temporary = join(directory, `.upload-${randomUUID()}.partial`);
    let file;
    let created = false;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      file = await open(temporary, "wx", 0o600);
      created = true;
      for await (const input of source) {
        if (signal?.aborted) throw signal.reason ?? new Error("upload aborted");
        const chunk = Buffer.from(input);
        bytes += chunk.length;
        if (bytes > contentLength || bytes > MAX_RELEASE_ARTIFACT_BYTES)
          throw new ReleaseArtifactError("artifact_too_large");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset, null);
          if (!result.bytesWritten) throw new ReleaseArtifactError("artifact_io");
          offset += result.bytesWritten;
        }
      }
      if (bytes !== contentLength) throw new ReleaseArtifactError("invalid_artifact");
      const actual = hash.digest("hex");
      if (actual !== expectedSha256.toLowerCase()) throw new ReleaseArtifactError("digest_mismatch");
      await file.sync();
      await file.close();
      file = undefined;

      // link() is create-if-absent on the same filesystem. Unlike rename(), it
      // cannot replace an existing immutable object during a concurrent upload.
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.inspect(actual);
        if (!existing || existing.size !== bytes) throw new ReleaseArtifactError("artifact_io");
      }
      await unlink(temporary);
      created = false;
      return { path: destination, sha256: actual, size: bytes };
    } catch (error) {
      if (file) await file.close().catch(() => {});
      if (created) await unlink(temporary).catch(() => {});
      if (error instanceof ReleaseArtifactError) throw error;
      throw new ReleaseArtifactError("artifact_io");
    }
  }

  async inspect(sha256: string): Promise<StoredReleaseArtifact | undefined> {
    if (!SHA256.test(sha256)) return undefined;
    const digest = sha256.toLowerCase();
    let path = this.contentPath(digest);
    let file;
    try {
      // Walk each ancestor before opening the digest file. Storage roots and
      // their parents must not be replaceable by an untrusted local user.
      path = join(await this.trustedStorageDirectory("sha256", digest.slice(0, 2)), digest);
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_RELEASE_ARTIFACT_BYTES)
        return undefined;
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
      if (hash.digest("hex") !== digest) return undefined;
      return { path, sha256: digest, size: info.size };
    } catch {
      return undefined;
    } finally {
      await file?.close().catch(() => {});
    }
  }

  private async closeCollection(session: CollectionSession) {
    clearTimeout(session.timer);
    if (this.collection === session) this.collection = undefined;
    await session.iterator.return(undefined).catch(() => {});
  }

  /** The iterator keeps directory positions; no filenames or paths enter the cursor. */
  private async *collectionEntries(): AsyncGenerator<CollectionEntry> {
    const shaRootPath = await this.trustedStorageDirectory("sha256");
    for await (const prefix of await opendir(shaRootPath)) {
      yield { kind: "prefix" };
      if (!prefix.isDirectory() || !SHA256_PREFIX.test(prefix.name)) continue;
      let directory;
      try {
        directory = await this.trustedStorageDirectory("sha256", prefix.name);
      } catch {
        yield { kind: "failure" };
        continue;
      }
      let entries;
      try {
        entries = await opendir(directory);
      } catch {
        yield { kind: "failure" };
        continue;
      }
      for await (const entry of entries) yield { kind: "file", prefix: prefix.name, entry };
    }
  }

  /**
   * Preview or remove old digest objects that no release row references.
   * Callers must serialize this operation with puts in the same process and
   * include digests from every release state in `referencedDigests` on every
   * pass. A continuation retains its original cutoff and expires after five
   * minutes; a request without a cursor starts a new scan and closes the old one.
   */
  async collectUnreferenced(
    referencedDigests: ReadonlySet<string>,
    options: { olderThanMs: number; dryRun: boolean; cursor?: string },
  ): Promise<ReleaseArtifactCollectionResult> {
    const result: ReleaseArtifactCollectionResult = {
      scannedEntries: 0,
      eligibleCount: 0,
      eligibleBytes: 0,
      deletedCount: 0,
      deletedBytes: 0,
      failedCount: 0,
      truncated: false,
    };
    if (!Number.isFinite(options.olderThanMs)) throw new ReleaseArtifactError("invalid_artifact");
    if (this.collectionActive) throw new ReleaseArtifactError("invalid_artifact");
    this.collectionActive = true;
    let session: CollectionSession | undefined;
    try {
      if (options.cursor !== undefined) {
        const current = this.collection;
        if (!current || current.cursor !== options.cursor || current.dryRun !== options.dryRun
          || current.expiresAt <= Date.now()) {
          if (current && current.expiresAt <= Date.now()) await this.closeCollection(current);
          throw new ReleaseArtifactError("invalid_artifact");
        }
        session = current;
      } else {
        if (this.collection) await this.closeCollection(this.collection);
        // An absent store is an empty scan; unsafe paths must fail closed.
        try {
          await this.trustedStorageDirectory("sha256");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
          throw error;
        }
        const created = {
          cursor: randomUUID(), dryRun: options.dryRun, olderThanMs: options.olderThanMs,
          expiresAt: Date.now() + GC_CURSOR_TTL_MS, iterator: this.collectionEntries(), active: false,
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
        };
        created.timer = setTimeout(() => {
          if (!created.active) void this.closeCollection(created);
        }, GC_CURSOR_TTL_MS);
        created.timer.unref();
        this.collection = session = created;
      }
      session.active = true;
      const references = new Set([...referencedDigests].filter((digest) => SHA256.test(digest)).map((digest) => digest.toLowerCase()));
      while (result.scannedEntries < MAX_GC_ENTRIES && (session.dryRun || result.deletedCount < MAX_GC_DELETIONS)) {
        const next = await session.iterator.next();
        if (next.done) {
          await this.closeCollection(session);
          return result;
        }
        if (next.value.kind === "failure") { result.failedCount++; continue; }
        result.scannedEntries++;
        if (next.value.kind !== "file") continue;
        const { entry, prefix } = next.value;
        if (!entry.isFile() || !SHA256.test(entry.name)) continue;
        const digest = entry.name.toLowerCase();
        if (!digest.startsWith(prefix.toLowerCase()) || references.has(digest)) continue;
        let path: string, info;
        try {
          path = join(await this.trustedStorageDirectory("sha256", prefix), entry.name);
          info = await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          // A changed/untrusted ancestor invalidates the whole continuation.
          throw new ReleaseArtifactError("artifact_io");
        }
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mtimeMs >= session.olderThanMs) continue;
        result.eligibleCount++;
        result.eligibleBytes += info.size;
        if (session.dryRun) continue;
        try {
          await unlink(path);
          result.deletedCount++;
          result.deletedBytes += info.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failedCount++;
        }
      }
      result.truncated = true;
      result.cursor = session.cursor;
      return result;
    } catch (error) {
      if (session) await this.closeCollection(session);
      if (error instanceof ReleaseArtifactError) throw error;
      throw new ReleaseArtifactError("artifact_io");
    } finally {
      if (session) {
        session.active = false;
        if (session.expiresAt <= Date.now()) await this.closeCollection(session);
      }
      this.collectionActive = false;
    }
  }

}
