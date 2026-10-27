import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir, mkdir, open, rename, rm, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { OperationConfig, OperationDefinition, OperationExecutionContext, OperationExecutionResult, OperationPayload } from "./types.js";
import { OperationRejectedError } from "./errors.js";

const ID = /^[a-f0-9-]{16,64}$/, SHA = /^[a-f0-9]{64}$/, MAX_ARCHIVE = 400 << 20;
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const object = (v: unknown): OperationConfig => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new OperationRejectedError("invalid backup configuration"); return v as OperationConfig; };
function integer(v: any, name: string, fallback: number, min: number, max: number) { const n = v ?? fallback; if (!Number.isSafeInteger(n) || n < min || n > max) throw new OperationRejectedError("invalid " + name); return n; }
function path(v: any, name: string) { if (typeof v !== "string" || !isAbsolute(v) || normalize(v) !== v || v.includes("\0") || v.length > 4096 || v === "/" || /^\/(?:etc|dev|proc|sys|boot|bin|sbin|usr)(?:\/|$)/.test(v)) throw new OperationRejectedError("invalid " + name); return v; }
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
function s3Config(v: OperationConfig) {
  let url: URL; try { url = new URL(v.endpoint); } catch { throw new OperationRejectedError("invalid S3 endpoint"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new OperationRejectedError("invalid S3 endpoint");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v.bucket ?? "") || !/^[-a-z0-9]{1,63}$/.test(v.region ?? "us-east-1")) throw new OperationRejectedError("invalid S3 bucket or region");
  if (typeof v.access_key_id !== "string" || !v.access_key_id || v.access_key_id.length > 256 || typeof v.secret_access_key !== "string" || !v.secret_access_key || v.secret_access_key.length > 1024) throw new OperationRejectedError("S3 credentials required");
  const prefix = v.prefix ?? "lightmoni"; if (typeof prefix !== "string" || !/^[-A-Za-z0-9_./]{0,512}$/.test(prefix) || prefix.split("/").some(p => p === "." || p === "..") || prefix.startsWith("/")) throw new OperationRejectedError("invalid S3 prefix");
  if (v.session_token != null && (typeof v.session_token !== "string" || v.session_token.length > 8192)) throw new OperationRejectedError("invalid S3 session token");
  return { type: "s3", endpoint: url.origin, bucket: v.bucket, region: v.region ?? "us-east-1", prefix: prefix.replace(/\/+$/, ""), access_key_id: v.access_key_id, secret_access_key: v.secret_access_key, session_token: v.session_token ?? "" };
}
export const backupDefinition: OperationDefinition = {
  kind: "backup", operations: ["create", "list", "verify", "prune", "restore"], readOnly: ["list", "verify"],
  validate(value) {
    const v = object(value), source = path(v.source_path, "source_path"), s = object(v.storage); let storage: OperationConfig;
    if (s.type === "local") { const destination = path(s.path, "storage.path"); if (within(source, destination) || within(destination, source)) throw new OperationRejectedError("backup source and storage overlap"); storage = { type: "local", path: destination }; }
    else if (s.type === "s3") storage = s3Config(s); else throw new OperationRejectedError("invalid backup storage type");
    return { source_path: source, storage, max_bytes: integer(v.max_bytes, "max_bytes", 64 << 20, 1, 256 << 20), max_files: integer(v.max_files, "max_files", 10000, 1, 20000), retain_count: integer(v.retain_count, "retain_count", 7, 1, 1000) };
  },
  publicConfig(config) { const s = config.storage; return { ...config, storage: s.type === "s3" ? { type: s.type, endpoint: s.endpoint, bucket: s.bucket, region: s.region, prefix: s.prefix, has_credentials: !!s.secret_access_key } : s }; },
  validateInput(operation, value) {
    if (!this.operations.includes(operation)) throw new OperationRejectedError("unsupported backup operation");
    const v = object(value ?? {}), allowed = ["verify", "restore"].includes(operation) ? ["backup_id", ...(operation === "restore" ? ["expected_target_sha256"] : [])] : [];
    if (Object.keys(v).some(k => !allowed.includes(k))) throw new OperationRejectedError("unexpected backup input");
    if (operation === "verify" || operation === "restore") {
      if (typeof v.backup_id !== "string" || !ID.test(v.backup_id)) throw new OperationRejectedError("invalid backup_id");
      if (operation === "restore" && !SHA.test(v.expected_target_sha256 ?? "")) throw new OperationRejectedError("expected_target_sha256 required");
      return { backup_id: v.backup_id, ...(operation === "restore" ? { expected_target_sha256: v.expected_target_sha256 } : {}) };
    } return {};
  },
};
type Entry = { path: string; type: "directory" | "file"; mode: number; size: number; sha256?: string; content?: string };
type Archive = { version: 1; id: string; resource_id: string; created_at: string; purpose: "backup" | "pre_restore"; source_sha256: string; source_mode: number; entries: Entry[] };
function stopped(ctx: OperationExecutionContext) { ctx.signal.throwIfAborted(); }
async function safeAncestors(target: string) {
  let current: string = sep; for (const part of resolve(target).split(sep).filter(Boolean)) {
    current = join(current, part); const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new OperationRejectedError("symbolic or non-directory backup path");
    if (process.platform === "linux" && s.uid !== 0) throw new OperationRejectedError("backup paths must be root managed");
    if ((s.mode & 0o022) !== 0 && !(s.mode & 0o1000)) throw new OperationRejectedError("backup path must not be writable by other users");
  }
}
function manifestDigest(entries: Entry[]) { return hash(JSON.stringify(entries.map(({ content, ...entry }) => entry))); }
async function snapshot(config: OperationConfig, ctx: OperationExecutionContext): Promise<{ entries: Entry[]; digest: string; bytes: number; source_mode: number }> {
  await safeAncestors(config.source_path); const entries: Entry[] = []; let bytes = 0;
  const walk = async (base: string) => {
    stopped(ctx); for (const name of (await readdir(base)).sort()) {
      const full = join(base, name), p = relative(config.source_path, full).split(sep).join("/");
      if (p.includes("\\") || p.length > 2048 || p.split("/").length > 32) throw new OperationRejectedError("backup path limit exceeded");
      const s = await lstat(full);
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1)) throw new OperationRejectedError("unsupported backup file or symbolic link");
      if (process.platform === "linux" && s.uid !== 0) throw new OperationRejectedError("backup contents must be root managed");
      if (entries.length >= config.max_files) throw new OperationRejectedError("backup file limit exceeded");
      if ((s.mode & 0o022) !== 0) throw new OperationRejectedError("backup files must not be writable by other users");
      if (s.isDirectory()) { entries.push({ path: p, type: "directory", mode: s.mode & 0o777, size: 0 }); await walk(full); }
      else {
        bytes += s.size; if (bytes > config.max_bytes) throw new OperationRejectedError("backup size limit exceeded");
        const h = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); let content: Buffer;
        try { const actual = await h.stat(); if (actual.ino !== s.ino || actual.dev !== s.dev || actual.size !== s.size) throw new OperationRejectedError("backup source changed"); content = await h.readFile(); const after = await h.stat(); if (content.length !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) throw new OperationRejectedError("backup source changed"); } finally { await h.close(); }
        entries.push({ path: p, type: "file", mode: s.mode & 0o777, size: s.size, sha256: hash(content), content: content.toString("base64") });
      }
    }
  };
  await walk(config.source_path); return { entries, digest: manifestDigest(entries), bytes, source_mode: (await lstat(config.source_path)).mode & 0o777 };
}
function parseArchive(bytes: Buffer, config: OperationConfig, resourceID: string): Archive {
  try {
    const a = JSON.parse(gunzipSync(bytes, { maxOutputLength: Math.min(MAX_ARCHIVE, Math.ceil(config.max_bytes * 1.4) + config.max_files * 4096 + (1 << 20)) }).toString()) as Archive;
    if (!Number.isInteger(a.source_mode) || a.source_mode < 0 || a.source_mode > 0o777 || (a.source_mode & 0o022) !== 0 || a.version !== 1 || !ID.test(a.id) || a.resource_id !== resourceID || !["backup", "pre_restore"].includes(a.purpose) || !Number.isFinite(Date.parse(a.created_at)) || !Array.isArray(a.entries) || a.entries.length > config.max_files) throw Error();
    const seen = new Map<string, string>(); let total = 0;
    for (const e of a.entries) {
      if (typeof e.path !== "string" || e.path.length > 2048 || e.path.includes("\\") || e.path.includes("\0") || e.path.startsWith("/") || e.path.split("/").some(v => !v || v === "." || v === "..") || e.path.split("/").length > 32 || seen.has(e.path) || !["file", "directory"].includes(e.type) || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777 || (e.mode & 0o022) !== 0) throw Error();
      const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ""; if (parent && seen.get(parent) !== "directory") throw Error(); seen.set(e.path, e.type);
      if (e.type === "file") { if (!Number.isSafeInteger(e.size) || e.size < 0 || typeof e.content !== "string" || !SHA.test(e.sha256 ?? "")) throw Error(); total += e.size; if (total > config.max_bytes) throw Error(); const file = Buffer.from(e.content, "base64"); if (file.toString("base64") !== e.content || file.length !== e.size || hash(file) !== e.sha256) throw Error(); }
      else if (e.size !== 0 || e.content !== undefined) throw Error();
    }
    if (manifestDigest(a.entries) !== a.source_sha256) throw Error(); return a;
  } catch { throw new OperationRejectedError("invalid backup archive or checksum"); }
}
const escapeXML = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, e => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[e]!));
const encoded = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function signer(key: Buffer | string, value: string) { return createHmac("sha256", key).update(value).digest(); }
async function s3Request(storage: OperationConfig, method: string, key: string, ctx: OperationExecutionContext, body?: Buffer, query: Record<string, string> = {}) {
  const url = new URL(storage.endpoint); url.pathname = "/" + [storage.bucket, ...key.split("/").filter(Boolean)].map(encoded).join("/"); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const date = ctx.now().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8), digest = hash(body ?? Buffer.alloc(0));
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": digest, "x-amz-date": date }; if (storage.session_token) headers["x-amz-security-token"] = storage.session_token;
  const names = Object.keys(headers).sort(), canonicalHeaders = names.map(n => n + ":" + headers[n].trim() + "\n").join(""), canonicalQuery = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([k, v]) => encoded(k) + "=" + encoded(v)).join("&");
  const canonical = [method, url.pathname, canonicalQuery, canonicalHeaders, names.join(";"), digest].join("\n"), scope = day + "/" + storage.region + "/s3/aws4_request";
  const signing = signer(signer(signer(signer("AWS4" + storage.secret_access_key, day), storage.region), "s3"), "aws4_request");
  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + storage.access_key_id + "/" + scope + ", SignedHeaders=" + names.join(";") + ", Signature=" + signer(signing, ["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n")).toString("hex");
  let response: Response; try { response = await fetch(url, { method, headers, body: body as any, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120000)]), redirect: "error" }); } catch { throw new OperationRejectedError("S3 request failed"); }
  if (!response.ok) { await response.body?.cancel(); throw new OperationRejectedError("S3 request rejected (" + response.status + ")"); }
  const limit = method === "GET" && !query["list-type"] ? MAX_ARCHIVE : 8 << 20, chunks: Buffer[] = []; let length = 0;
  if (response.body) for await (const b of response.body as any) { length += b.length; if (length > limit) throw new OperationRejectedError("S3 response size limit exceeded"); chunks.push(Buffer.from(b)); }
  return { bytes: Buffer.concat(chunks), version: response.headers.get("x-amz-version-id") ?? "", etag: response.headers.get("etag") ?? "" };
}
async function storageFor(config: OperationConfig, resourceID: string, ctx: OperationExecutionContext) {
  const s = config.storage, key = (id: string) => [s.prefix, resourceID, id + ".lmb.gz"].filter(Boolean).join("/");
  if (s.type === "s3") return {
    write: async (id: string, b: Buffer) => { const r = await s3Request(s, "PUT", key(id), ctx, b); return { object_version: r.version, etag: r.etag }; },
    read: async (id: string) => s3Request(s, "GET", key(id), ctx),
    remove: async (id: string) => { await s3Request(s, "DELETE", key(id), ctx); },
    ids: async () => { const prefix = [s.prefix, resourceID].filter(Boolean).join("/") + "/", r = await s3Request(s, "GET", "", ctx, undefined, { "list-type": "2", prefix, "max-keys": "1000" }), xml = r.bytes.toString(); if (/<!DOCTYPE|<!ENTITY|<IsTruncated>true<\/IsTruncated>/.test(xml)) throw new OperationRejectedError("S3 listing exceeds supported limit"); return [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(m => escapeXML(m[1])).filter(k => k.startsWith(prefix) && ID.test(k.slice(prefix.length, -7)) && k.endsWith(".lmb.gz")).map(k => k.slice(prefix.length, -7)); },
  };
  await safeAncestors(s.path); const directory = join(s.path, resourceID); try { await mkdir(directory, { mode: 0o700 }); } catch (e: any) { if (e.code !== "EEXIST") throw e; } await safeAncestors(directory); await chmod(directory, 0o700);
  return {
    write: async (id: string, b: Buffer) => { const target = join(directory, id + ".lmb.gz"), temp = join(directory, "." + id + ".tmp"), h = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await h.writeFile(b); await h.sync(); } finally { await h.close(); } await rename(temp, target); return { object_version: hash(b), etag: hash(b) }; },
    read: async (id: string) => { const p = join(directory, id + ".lmb.gz"), stat = await lstat(p); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE) throw new OperationRejectedError("invalid backup archive"); const h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW); try { return { bytes: await h.readFile(), version: hash(String(stat.mtimeMs) + ":" + stat.size), etag: "" }; } finally { await h.close(); } },
    remove: async (id: string) => { const p = join(directory, id + ".lmb.gz"), st = await lstat(p); if (!st.isFile() || st.isSymbolicLink()) throw new OperationRejectedError("invalid backup archive"); await rm(p); },
    ids: async () => { const names = await readdir(directory); if (names.length > 2000) throw new OperationRejectedError("backup listing limit exceeded"); return names.filter(n => n.endsWith(".lmb.gz") && ID.test(n.slice(0, -7))).map(n => n.slice(0, -7)); },
  };
}
function summary(a: Archive, bytes: Buffer, version: string) { return { backup_id: a.id, created_at: a.created_at, purpose: a.purpose, source_sha256: a.source_sha256, sha256: hash(bytes), size: bytes.length, file_count: a.entries.length, object_version: version.slice(0,128) }; }
export async function executeBackup(payload: OperationPayload, ctx: OperationExecutionContext): Promise<OperationExecutionResult> {
  const config = backupDefinition.validate(payload.resource.config), input = backupDefinition.validateInput(payload.operation, payload.input, config); if (!/^[A-Za-z0-9_-]{1,128}$/.test(payload.resource.id)) throw new OperationRejectedError("invalid backup resource ID"); stopped(ctx); const store = await storageFor(config, payload.resource.id, ctx);
  let mutationStarted = false;
  try {
  const create = async (purpose: "backup" | "pre_restore", value?: Awaited<ReturnType<typeof snapshot>>) => { const snap = value ?? await snapshot(config, ctx), a: Archive = { version: 1, id: randomUUID(), resource_id: payload.resource.id, created_at: ctx.now().toISOString(), purpose, source_sha256: snap.digest, source_mode: snap.source_mode, entries: snap.entries }, bytes = gzipSync(JSON.stringify(a), { level: 6 }); if (bytes.length > MAX_ARCHIVE) throw new OperationRejectedError("backup size limit exceeded"); mutationStarted = true; const result = await store.write(a.id, bytes), read = await store.read(a.id), verified = parseArchive(read.bytes, config, payload.resource.id); if (hash(read.bytes) !== hash(bytes)) throw new OperationRejectedError("backup upload verification failed"); return summary(verified, read.bytes, result.object_version); };
  const load = async (id: string) => { const r = await store.read(id), a = parseArchive(r.bytes, config, payload.resource.id); if (a.id !== id) throw new OperationRejectedError("invalid backup identity"); return { a, bytes: r.bytes, version: r.version }; };
  if (payload.operation === "create") return { verified: true, data: await create("backup") };
  if (payload.operation === "list" || payload.operation === "prune") {
    const backups = []; for (const id of await store.ids()) { stopped(ctx); const r = await load(id); backups.push(summary(r.a, r.bytes, r.version)); } backups.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.backup_id.localeCompare(a.backup_id));
    if (payload.operation === "prune") { const remove = backups.filter(b => b.purpose === "backup").slice(config.retain_count); for (const b of remove) { mutationStarted = true; await store.remove(b.backup_id); } return { verified: true, data: { removed: remove.slice(0,100).map(b => b.backup_id), removed_total: remove.length, truncated: remove.length > 100, retained: backups.length - remove.length, pre_restore_retained: true } }; }
    const current = await snapshot(config, ctx); return { verified: true, data: { backups: backups.slice(0,100), total: backups.length, truncated: backups.length > 100, source_sha256: current.digest, current_target_sha256: current.digest } };
  }
  const stored = await load(input.backup_id);
  if (payload.operation === "verify") { const current = await snapshot(config, ctx); return { verified: true, data: { ...summary(stored.a, stored.bytes, stored.version), current_target_sha256: current.digest } }; }
  const current = await snapshot(config, ctx); if (current.digest !== input.expected_target_sha256) throw new OperationRejectedError("restore target changed; inspect and approve again");
  const pre = await create("pre_restore", current), parent = dirname(config.source_path); await safeAncestors(parent);
  const stage = join(parent, ".lightmoni-restore-" + randomUUID()), previous = join(parent, ".lightmoni-previous-" + randomUUID()); await mkdir(stage, { mode: stored.a.source_mode }); await chmod(stage, stored.a.source_mode); let moved = false, applied = false;
  try {
    for (const entry of stored.a.entries) { stopped(ctx); const target = join(stage, entry.path); if (entry.type === "directory") await mkdir(target, { mode: entry.mode }); else { const h = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, entry.mode); try { await h.writeFile(Buffer.from(entry.content!, "base64")); await h.sync(); } finally { await h.close(); } } }
    const staged = await snapshot({ ...config, source_path: stage }, ctx); if (staged.digest !== stored.a.source_sha256) throw new OperationRejectedError("restore staging verification failed");
    const latest = await snapshot(config, ctx); if (latest.digest !== current.digest) throw new OperationRejectedError("restore target changed during preparation"); stopped(ctx);
    await rename(config.source_path, previous); moved = true; await rename(stage, config.source_path); applied = true;
    const final = await snapshot(config, ctx); if (final.digest !== stored.a.source_sha256) throw new OperationRejectedError("restore verification failed"); let cleanupPending = false; try { await rm(previous, { recursive: true }); } catch { cleanupPending = true; }
    return { verified: true, data: { backup_id: stored.a.id, source_sha256: final.digest, pre_restore_backup_id: pre.backup_id, cleanup_pending: cleanupPending } };
  } catch (error) { if (moved) { try { if (applied) await rm(config.source_path, { recursive: true }); await rename(previous, config.source_path); } catch { return { verified: false, data: {status: "unknown", recovery_required: true, pre_restore_backup_id: pre.backup_id} }; } } throw error; }
  finally { await rm(stage, { recursive: true, force: true }).catch(()=>{}); }
  // Once storage/target mutation starts, even a typed validation/readback error
  // cannot prove that the write was rejected. Preserve the unknown outcome.
  } catch (error) { if (mutationStarted) return { verified: false, data: {status: "unknown", inspect_storage_and_target: true} }; throw error; }
}
