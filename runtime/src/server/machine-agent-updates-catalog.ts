import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail } from "../shared/http.js";

export interface AgentRelease {
  version: string;
  source_revision: string;
  build_id: string;
  state_schema: 1;
  platform: "linux";
  arch: "amd64" | "arm64";
  file: string;
  sha256: string;
  size: number;
  build_time: string;
}
export interface PinnedAgentFile { sha256: string; size: number }
export interface PinnedAgentRelease { release: AgentRelease; files: Record<"bundle.tar.gz" | "update.sh" | "update-runner.mjs", PinnedAgentFile> }
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeFile = (path: string) => {
  if (!existsSync(path)) fail(409, "Agent 发行文件不存在，请重新发布完整发行包");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) fail(409, "Agent 发行文件无效");
  return stat;
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Approvals address immutable bytes in persistent storage, never a mutable download filename. */
export class AgentReleaseCatalog {
  private verified = new Map<string, { stamp: string; hash: string }>();
  constructor(readonly downloads: string, readonly cache: string) {}
  private fileHash(path: string, fresh = false) {
    const stat = safeFile(path), stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const previous = this.verified.get(path);
    if (!fresh && previous?.stamp === stamp) return previous.hash;
    const hash = digest(readFileSync(path));
    this.verified.set(path, { stamp, hash });
    return hash;
  }
  list(): AgentRelease[] {
    const manifest = join(this.downloads, "agent-releases.json");
    if (!existsSync(manifest)) return [];
    const stat = safeFile(manifest);
    if (stat.size > 1 << 20) fail(409, "Agent 发行目录过大");
    let parsed: any;
    try { parsed = JSON.parse(readFileSync(manifest, "utf8")); } catch { fail(409, "Agent 发行目录无法读取"); }
    if (parsed?.schema !== 1 || !Array.isArray(parsed.releases) || parsed.releases.length > 200) fail(409, "Agent 发行目录格式无效");
    const releases: AgentRelease[] = [];
    const seen = new Set<string>();
    for (const value of parsed.releases) {
      if (!value || !VERSION.test(value.version) || !/^[a-f0-9]{40}$/.test(value.source_revision)
        || typeof value.build_id !== "string" || !VERSION.test(value.build_id)
        || value.state_schema !== 1 || value.platform !== "linux" || !["amd64", "arm64"].includes(value.arch)
        || value.file !== `lightmoni-agent_${value.version}_linux_${value.arch}.tar.gz`
        || !SHA.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 512 * 1024 * 1024
        || typeof value.build_time !== "string" || !Number.isFinite(Date.parse(value.build_time)) || seen.has(value.sha256))
        fail(409, "Agent 发行元数据无效或重复");
      const path = join(this.downloads, value.file);
      // Missing or replaced bundles are not advertised as deployable updates.
      if (!existsSync(path)) continue;
      if (safeFile(path).size !== value.size || this.fileHash(path) !== value.sha256) continue;
      seen.add(value.sha256);
      releases.push({ version: value.version, source_revision: value.source_revision, build_id: value.build_id, state_schema: 1,
        platform: "linux", arch: value.arch, file: value.file, sha256: value.sha256, size: value.size, build_time: value.build_time });
    }
    return releases.sort((a, b) => Date.parse(b.build_time) - Date.parse(a.build_time) || b.sha256.localeCompare(a.sha256));
  }
  get(sha: string) {
    if (!SHA.test(sha)) fail(400, "目标发行必须使用完整 SHA256");
    const release = this.list().find(value => value.sha256 === sha);
    if (!release) fail(409, "目标发行不可用或摘要已变化，请刷新发行目录");
    return release;
  }
  private pinFile(source: string): PinnedAgentFile {
    const stat = safeFile(source), sha256 = this.fileHash(source, true);
    mkdirSync(this.cache, { recursive: true, mode: 0o700 });
    const destination = this.path({ sha256, size: stat.size });
    if (!existsSync(destination)) {
      const staging = join(this.cache, "." + randomUUID());
      try {
        copyFileSync(source, staging); chmodSync(staging, 0o600);
        if (safeFile(staging).size !== stat.size || this.fileHash(staging, true) !== sha256) fail(409, "发行文件在生成计划时变化，请重试");
        renameSync(staging, destination);
      } finally { rmSync(staging, { force: true }); }
    }
    this.verify({ sha256, size: stat.size });
    return { sha256, size: stat.size };
  }
  pinBundle(sha: string): {release:AgentRelease;file:PinnedAgentFile} {
    const release = this.get(sha);
    const bundle = this.pinFile(join(this.downloads, release.file));
    if (bundle.sha256 !== release.sha256 || bundle.size !== release.size) fail(409, "发行包在生成计划时变化，请重试");
    return {release,file:bundle};
  }
  pin(sha: string): PinnedAgentRelease {
    const {release,file:bundle}=this.pinBundle(sha);
    return { release, files: { "bundle.tar.gz": bundle, "update.sh": this.pinFile(join(this.downloads, "update.sh")), "update-runner.mjs": this.pinFile(join(this.downloads, "update-runner.mjs")) } };
  }
  /** Rollback uses the retained host release, but its maintenance scripts still need immutable approval. */
  pinScripts() {
    return { "update.sh": this.pinFile(join(this.downloads, "update.sh")), "update-runner.mjs": this.pinFile(join(this.downloads, "update-runner.mjs")) };
  }
  path(file: PinnedAgentFile) {
    if (!SHA.test(file.sha256)) fail(409, "无效的发行缓存引用");
    return join(resolve(this.cache), file.sha256);
  }
  verify(file: PinnedAgentFile) {
    const path = this.path(file);
    if (safeFile(path).size !== file.size || this.fileHash(path, true) !== file.sha256) fail(409, "已审批发行缓存不完整或被修改，停止执行");
    return path;
  }
}
