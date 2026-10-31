#!/usr/bin/env node
/** Fixed, root-only Agent maintenance protocol. This file has no application
 * imports: the existing bundled Node can supervise replacement of its app. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OP = /^[a-f0-9]{32}$/;
const VERSION = /^[A-Za-z0-9._-]{1,128}$/;
const REVISION = /^[a-f0-9]{40}$/;
const TERMINAL = new Set(["succeeded", "rolled_back", "failed", "rollback_failed"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(Error(code), { safeCode: code }); };
const safeCode = error => typeof error?.safeCode === "string" ? error.safeCode : "maintenance_failed";
const absent = error => error?.code === "ENOENT";
const boundedJSON = (filename, maximum = 65536) => {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail("unsafe_file");
  return JSON.parse(fs.readFileSync(filename, "utf8"));
};

/** Exposed for isolated filesystem/command tests. CLI never accepts overrides. */
export class AgentMaintenance {
  constructor(options = {}) {
    this.root = options.root ?? "/";
    this.uid = options.uid ?? 0;
    this.arch = options.arch ?? (process.arch === "x64" ? "amd64" : process.arch);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.command = options.command ?? ((file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 15000, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "pipe"] }).trim());
    this.self = options.self ?? fileURLToPath(import.meta.url);
    this.launch = options.launch;
  }
  p(value) { return path.join(this.root, value); }
  get base() { return this.p("/opt/lightmoni-agent"); }
  get lock() { return this.p("/run/lightmoni-agent-lifecycle.lock"); }
  opDir(id) { if (!OP.test(id ?? "")) fail("invalid_operation"); return path.join(this.base, "updates", id); }
  timestamp() { return new Date(this.now()).toISOString(); }
  checkManaged(filename, kind = "file") {
    const absolute = path.resolve(filename), stop = path.resolve(this.root);
    const relative = path.relative(stop, absolute);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("unsafe_path");
    let cursor = absolute;
    for (;;) {
      const info = fs.lstatSync(cursor);
      if (info.isSymbolicLink() || info.uid !== this.uid || (info.mode & 0o022) !== 0) fail("unsafe_managed_path");
      if (cursor === absolute && (kind === "file" ? !info.isFile() : !info.isDirectory())) fail("unsafe_managed_path");
      if (cursor === stop) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return absolute;
  }
  atomic(filename, value, mode = 0o600) {
    const temporary = filename + ".new-" + randomUUID();
    const fd = fs.openSync(temporary, "wx", mode);
    try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    try { const directory = fs.openSync(path.dirname(filename), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch { /* Some test filesystems cannot fsync a directory. */ }
  }
  state(id) {
    const directory = this.checkManaged(this.opDir(id), "directory");
    const status = boundedJSON(this.checkManaged(path.join(directory, "status.json")));
    if (status.schema !== 1 || status.operation_id !== id || !ID.test(status.agent_id ?? "") || !["accepted", "preparing", "switching", "waiting_confirmation", ...TERMINAL].includes(status.status)) fail("invalid_receipt");
    return status;
  }
  save(id, update) {
    const previous = this.state(id);
    const value = { ...previous, ...update, updated_at: this.timestamp() };
    this.atomic(path.join(this.opDir(id), "status.json"), value);
    return value;
  }
  identity() {
    const value = boundedJSON(this.p("/var/lib/lightmoni-agent/identity.json"), 4096);
    if (!ID.test(value.agent_id ?? "") || !ID.test(value.host_id ?? "")) fail("invalid_identity");
    return value.agent_id;
  }
  metadata(releasePath) {
    this.checkManaged(releasePath, "directory");
    const manifest = boundedJSON(this.checkManaged(path.join(releasePath, "release.json")), 16384);
    if (!VERSION.test(manifest.version ?? "") || manifest.platform !== "linux" || !["amd64", "arm64"].includes(manifest.arch)) fail("unsupported_release");
    const current = manifest.state_schema === 1 && REVISION.test(manifest.source_revision ?? "") && VERSION.test(manifest.build_id ?? "");
    // Explicitly recognize the only legacy standalone Node bundle emitted by
    // the old builder; unknown runtimes/schema are never guessed compatible.
    const legacy = manifest.state_schema === undefined && manifest.version === "0.1.0" && manifest.node_version === "24.15.0"
      && manifest.requires === "glibc >= 2.28" && SHA.test(manifest.node_sha256 ?? "");
    if (!current && !legacy) fail("unsupported_state_schema");
    if (manifest.node_binary_sha256 !== undefined && (!SHA.test(manifest.node_binary_sha256) || digest(fs.readFileSync(this.checkManaged(path.join(releasePath, "node")))) !== manifest.node_binary_sha256)) fail("runtime_checksum_mismatch");
    let artifact = "";
    try {
      const receipt = boundedJSON(this.checkManaged(path.join(releasePath, "installation.json")), 4096);
      if (receipt.schema !== 1 || !SHA.test(receipt.artifact_sha256 ?? "")) fail("invalid_installation_receipt");
      artifact = receipt.artifact_sha256;
    } catch (error) { if (!absent(error)) throw error; }
    return { version: manifest.version, source_revision: current ? manifest.source_revision : "", build_id: current ? manifest.build_id : "", state_schema: 1, artifact_sha256: artifact, arch: manifest.arch };
  }
  fingerprint(releasePath, launcherPath = this.p("/usr/local/bin/lightmoni-agent"), servicePath = this.p("/etc/systemd/system/lightmoni-agent.service")) {
    const release = this.metadata(releasePath);
    const launcher = fs.readFileSync(this.checkManaged(launcherPath));
    const service = fs.readFileSync(this.checkManaged(servicePath));
    const manifest = fs.readFileSync(this.checkManaged(path.join(releasePath, "release.json")));
    const node = digest(fs.readFileSync(this.checkManaged(path.join(releasePath, "node"))));
    const entrypoint = digest(fs.readFileSync(this.checkManaged(path.join(releasePath, "app/runtime/dist/agent/main.js"))));
    return { ...release, fingerprint: digest(JSON.stringify({ release_path: releasePath, release, manifest: digest(manifest), launcher: digest(launcher), service: digest(service), node, entrypoint })) };
  }
  currentPath() {
    this.checkManaged(this.base, "directory");
    const current = path.join(this.base, "current"), info = fs.lstatSync(current);
    if (!info.isSymbolicLink() || info.uid !== this.uid) fail("unmanaged_installation");
    const destination = fs.realpathSync(current);
    const releases = path.join(this.base, "releases") + path.sep;
    if (!destination.startsWith(releases) || path.dirname(destination) + path.sep !== releases) fail("unmanaged_installation");
    this.checkManaged(destination, "directory");
    return destination;
  }
  system(property) { return this.command("systemctl", ["show", "lightmoni-agent.service", "--property=" + property, "--value"]); }
  hasOperation() {
    if (fs.existsSync(this.p("/var/lib/lightmoni-agent/operations/execution.lock"))) return true;
    for (const filename of ["agent-job-state.json", "task-run-state.json"]) {
      try { const state = boundedJSON(this.p("/var/lib/lightmoni-agent/" + filename)); if (typeof state.id === "string" && state.id) return true; }
      catch (error) { if (!absent(error)) return true; }
    }
    return false;
  }
  localStatus() {
    try { return JSON.parse(this.command(this.p("/usr/local/bin/lightmoni-agent"), ["status", "--config", this.p("/etc/lightmoni-agent/config.json")])); }
    catch { return {}; }
  }
  previous() {
    try {
      const retained = boundedJSON(this.checkManaged(path.join(this.base, "previous.json")));
      if (retained.schema !== 1 || !OP.test(retained.operation_id ?? "")) fail("invalid_previous_release");
      const source = this.checkManaged(this.opDir(retained.operation_id), "directory");
      const value = this.fingerprint(retained.release_path, path.join(source, "previous-launcher"), path.join(source, "previous-service"));
      if (value.fingerprint !== retained.fingerprint) fail("previous_release_changed");
      return { ...value, release_path: retained.release_path, operation_id: retained.operation_id };
    } catch (error) { if (absent(error)) return null; throw error; }
  }
  probe() {
    const agent = this.identity();
    const currentPath = this.currentPath();
    const current = this.fingerprint(currentPath);
    const fragment = this.system("FragmentPath"), load = this.system("LoadState"), active = this.system("ActiveState");
    if (fragment !== this.p("/etc/systemd/system/lightmoni-agent.service") || load !== "loaded" || !["active", "inactive", "failed"].includes(active)) fail("unmanaged_installation");
    const local = this.localStatus(), previous = this.previous();
    const boot = typeof local.boot_id === "string" && /^[a-f0-9-]{36}$/.test(local.boot_id) && local.agent_id === agent ? local.boot_id : "";
    return { schema: 1, ready: current.arch === this.arch, agent_id: agent, arch: this.arch, service_active: active === "active", lifecycle_locked: fs.existsSync(this.lock), operation_lock: this.hasOperation(), current: { ...current, boot_id: boot }, previous: previous ? this.publicRelease(previous) : null };
  }
  publicRelease(value) {
    return Object.fromEntries(["version", "source_revision", "build_id", "state_schema", "artifact_sha256", "arch", "fingerprint"].map(key => [key, value[key]]));
  }
  request(id) { return boundedJSON(this.checkManaged(path.join(this.opDir(id), "request.json"))); }
  ownsLock(id) {
    try { return boundedJSON(this.checkManaged(path.join(this.lock, "owner.json"))).operation_id === id; }
    catch { return false; }
  }
  unlock(id) {
    if (!this.ownsLock(id)) fail("lifecycle_lock_changed");
    fs.unlinkSync(path.join(this.lock, "owner.json")); fs.rmdirSync(this.lock);
  }
  validateRequest(request) {
    if (!request || !OP.test(request.operation_id ?? "") || !ID.test(request.expected_agent_id ?? "") || !SHA.test(request.expected_fingerprint ?? "") || typeof request.expected_service_active !== "boolean" || !["upgrade", "rollback"].includes(request.action)) fail("invalid_request");
    const target = request.target;
    if (!target || !VERSION.test(target.version ?? "") || target.state_schema !== 1 || !["amd64", "arm64"].includes(target.arch) || target.arch !== this.arch
      || !SHA.test(target.artifact_sha256 ?? "") || !REVISION.test(target.source_revision ?? "") || !VERSION.test(target.build_id ?? "")
      || (request.action === "rollback" && !SHA.test(target.fingerprint ?? ""))) fail("invalid_target");
    if (request.confirm_timeout_seconds !== undefined && (!Number.isInteger(request.confirm_timeout_seconds) || request.confirm_timeout_seconds < 10 || request.confirm_timeout_seconds > 180)) fail("invalid_timeout");
    if (typeof request.start_deadline !== "string" || !Number.isFinite(Date.parse(request.start_deadline)) || this.now() >= Date.parse(request.start_deadline) || Date.parse(request.start_deadline) > this.now() + 300000) fail("start_deadline_expired");
  }
  async start(request) {
    this.validateRequest(request);
    const id = request.operation_id, directory = this.opDir(id);
    if (fs.existsSync(directory)) fail("operation_already_exists");
    const before = this.probe();
    if (!before.ready || before.agent_id !== request.expected_agent_id || before.current.fingerprint !== request.expected_fingerprint) fail("installation_changed");
    if (before.service_active !== request.expected_service_active) fail("service_state_changed");
    if (before.lifecycle_locked || before.operation_lock) fail("operation_conflict");
    if (request.action === "rollback" && (!before.previous || before.previous.fingerprint !== request.target.fingerprint)) fail("previous_release_changed");
    let archive;
    if (request.action === "upgrade") {
      if (typeof request.archive_path !== "string") fail("archive_missing");
      this.checkManaged(request.archive_path);
      const info = fs.statSync(request.archive_path);
      if (info.size < 1024 || info.size > 256 << 20) fail("invalid_archive");
      archive = fs.readFileSync(request.archive_path);
      if (digest(archive) !== request.target.artifact_sha256) fail("checksum_mismatch");
      const space = fs.statfsSync(this.base);
      if (space.bavail * space.bsize < archive.length * 5 + (64 << 20)) fail("insufficient_disk_space");
    }
    fs.mkdirSync(path.join(this.base, "updates"), { mode: 0o700, recursive: true });
    this.checkManaged(path.join(this.base, "updates"), "directory");
    fs.mkdirSync(this.lock, { mode: 0o700 });
    let dispatchAttempted = false;
    try {
      this.atomic(path.join(this.lock, "owner.json"), { operation_id: id });
      if (this.now() >= Date.parse(request.start_deadline)) fail("start_deadline_expired");
      fs.mkdirSync(directory, { mode: 0o700 });
      const state = { schema: 1, operation_id: id, agent_id: before.agent_id, status: "accepted", from: before.current, target: { ...request.target }, local_health: { service_active: false, identity_matches: false, release_matches: false, boot_id: "" }, started_at: this.timestamp(), updated_at: this.timestamp() };
      this.atomic(path.join(directory, "status.json"), state);
      this.atomic(path.join(directory, "request.json"), { ...request, archive_path: undefined, previous_path: this.currentPath(), previous_active: before.service_active, rollback_source: request.action === "rollback" ? this.previous() : null });
      if (archive) this.atomic(path.join(directory, "bundle.tar.gz"), archive);
      this.atomic(path.join(directory, "worker.mjs"), fs.readFileSync(this.self));
      this.atomic(path.join(this.base, "update-runner.mjs"), fs.readFileSync(this.self), 0o644);
      const node = this.checkManaged(path.join(this.currentPath(), "node"));
      dispatchAttempted = true;
      if (this.launch) await this.launch(id, node, path.join(directory, "worker.mjs"));
      else this.command("systemd-run", ["--quiet", "--no-block", "--collect", "--unit=lightmoni-agent-update-" + id, "--property=Type=exec", "--property=UMask=0077", "--property=StandardOutput=null", "--property=StandardError=null", "--property=RuntimeMaxSec=600", node, path.join(directory, "worker.mjs"), "worker", id]);
      return state;
    } catch (error) {
      // Failure before worker dispatch is deterministic and may safely release
      // the lock. A successfully dispatched worker owns its own durable state.
      if (!dispatchAttempted) {
        if (fs.existsSync(path.join(directory, "status.json"))) this.save(id, { status: "failed", error_code: safeCode(error) });
        if (this.ownsLock(id)) this.unlock(id);
      }
      throw error;
    }
  }
  /** Parse TAR ourselves before writing. No path, hardlink or symlink can
   * redirect root writes; npm's relative internal links are created last. */
  extract(archive, destination) {
    let input;
    try { input = gunzipSync(archive, { maxOutputLength: 768 << 20 }); }
    catch { fail("invalid_archive"); }
    const entries = [], names = new Map();
    let offset = 0, extended = {}, global = {}, longName = "", longLink = "";
    const string = value => value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)).toString("utf8");
    const octal = value => { const text = string(value).trim(); if (!/^[0-7]*$/.test(text)) fail("invalid_archive"); return text ? parseInt(text, 8) : 0; };
    while (offset + 512 <= input.length) {
      const header = input.subarray(offset, offset + 512); offset += 512;
      if (header.every(byte => byte === 0)) break;
      const checksum = octal(header.subarray(148, 156));
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== sum) fail("invalid_archive");
      const size = octal(header.subarray(124, 136));
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > input.length) fail("invalid_archive");
      const body = input.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156] || 48);
      if (["x", "g"].includes(type)) {
        const pax = {}; let cursor = 0;
        while (cursor < body.length) {
          const space = body.indexOf(32, cursor); if (space < 0) fail("invalid_archive");
          const length = Number(body.subarray(cursor, space).toString());
          if (!Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > body.length) fail("invalid_archive");
          const item = body.subarray(space + 1, cursor + length - 1).toString(), equal = item.indexOf("=");
          if (equal < 1) fail("invalid_archive"); pax[item.slice(0, equal)] = item.slice(equal + 1); cursor += length;
        }
        if (type === "g") global = { ...global, ...pax }; else extended = pax;
        continue;
      }
      if (type === "L" || type === "K") { if (size > 4096) fail("invalid_archive"); if (type === "L") longName = string(body); else longLink = string(body); continue; }
      const attrs = { ...global, ...extended }; extended = {};
      const prefix = string(header.subarray(345, 500));
      const raw = attrs.path ?? (longName || (prefix ? prefix + "/" : "") + string(header.subarray(0, 100)));
      const link = attrs.linkpath ?? (longLink || string(header.subarray(157, 257))); longName = ""; longLink = "";
      const name = raw.replace(/\/$/, "");
      if (typeof name !== "string" || !name || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || name.length > 4096 || /[\x00-\x1f\x7f]/.test(name)) fail("unsafe_archive_path");
      if (!["lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-runtime"].includes(name.split("/")[0])) fail("unsafe_archive_path");
      if (!["0", "5", "2"].includes(type) || (attrs.size !== undefined && Number(attrs.size) !== size)) fail("unsupported_archive_entry");
      if (names.has(name) && !(type === "5" && names.get(name) === "5")) fail("duplicate_archive_path");
      names.set(name, type);
      if (type === "2") {
        if (!link || path.posix.isAbsolute(link) || /[\\\x00-\x1f\x7f]/.test(link)) fail("unsafe_archive_link");
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
        if (!target.startsWith("lightmoni-agent-runtime/") || target.includes("../")) fail("unsafe_archive_link");
      }
      entries.push({ name, link, type, body, mode: octal(header.subarray(100, 108)) });
      if (entries.length > 100000) fail("archive_too_large");
    }
    for (const entry of entries) {
      let parent = path.posix.dirname(entry.name);
      while (parent !== ".") { if (names.has(parent) && names.get(parent) !== "5") fail("unsafe_archive_path"); parent = path.posix.dirname(parent); }
    }
    for (const entry of entries.filter(value => value.type !== "2")) {
      const filename = path.join(destination, entry.name);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o755 });
      if (entry.type === "5") fs.mkdirSync(filename, { recursive: true, mode: 0o755 });
      else { fs.writeFileSync(filename, entry.body, { flag: "wx", mode: entry.mode & 0o111 ? 0o755 : 0o644 }); fs.chmodSync(filename, entry.mode & 0o111 ? 0o755 : 0o644); }
    }
    for (const entry of entries.filter(value => value.type === "2")) fs.symlinkSync(entry.link, path.join(destination, entry.name));
    const readableDirectories = root => { fs.chmodSync(root, 0o755); for (const name of fs.readdirSync(root)) { const child = path.join(root, name); if (fs.lstatSync(child).isDirectory()) readableDirectories(child); } };
    readableDirectories(destination);
    for (const filename of ["lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-runtime/node", "lightmoni-agent-runtime/release.json"]) {
      const info = fs.lstatSync(path.join(destination, filename)); if (!info.isFile() || info.isSymbolicLink()) fail("invalid_archive");
    }
  }
  health(request) {
    const active = this.system("ActiveState") === "active", local = this.localStatus();
    const release = local.release ?? {};
    const target = request.target;
    const releaseMatches = release.version === target.version && release.source_revision === target.source_revision && release.build_id === target.build_id && release.state_schema === 1 && release.artifact_sha256 === target.artifact_sha256;
    return { service_active: active, identity_matches: local.agent_id === request.expected_agent_id && this.identity() === request.expected_agent_id, release_matches: releaseMatches, boot_id: typeof local.boot_id === "string" && /^[a-f0-9-]{36}$/.test(local.boot_id) ? local.boot_id : "" };
  }
  switchCurrent(directory) {
    const temporary = path.join(this.base, ".current-update-" + randomUUID());
    fs.symlinkSync(directory, temporary); fs.renameSync(temporary, path.join(this.base, "current"));
  }
  async restore(id, reason) {
    const request = this.request(id), directory = this.opDir(id);
    this.command("systemctl", ["stop", "lightmoni-agent.service"]);
    if (!["inactive", "failed"].includes(this.system("ActiveState"))) fail("service_stop_failed");
    this.switchCurrent(request.previous_path);
    this.atomic(this.p("/usr/local/bin/lightmoni-agent"), fs.readFileSync(this.checkManaged(path.join(directory, "previous-launcher"))), 0o755);
    this.atomic(this.p("/etc/systemd/system/lightmoni-agent.service"), fs.readFileSync(this.checkManaged(path.join(directory, "previous-service"))), 0o644);
    this.command("systemctl", ["daemon-reload"]);
    if (request.previous_active) {
      this.command("systemctl", ["restart", "lightmoni-agent.service"]);
      if (this.system("ActiveState") !== "active") fail("rollback_start_failed");
    }
    const current = this.fingerprint(this.currentPath());
    if (current.fingerprint !== request.expected_fingerprint || this.identity() !== request.expected_agent_id) fail("rollback_verification_failed");
    const local = this.localStatus();
    const result = this.save(id, { status: "rolled_back", error_code: reason, restored_fingerprint: request.expected_fingerprint, finished_at: this.timestamp(), local_health: { service_active: request.previous_active ? this.system("ActiveState") === "active" : false, identity_matches: true, release_matches: true, boot_id: typeof local.boot_id === "string" && /^[a-f0-9-]{36}$/.test(local.boot_id) ? local.boot_id : "" } });
    this.cleanup(id); this.unlock(id); return result;
  }
  cleanup(id) {
    // Keep the small audit receipt and rollback files; archive and unpacked
    // copies are unnecessary once the immutable release has been published.
    for (const filename of ["bundle.tar.gz", "unpacked"]) fs.rmSync(path.join(this.opDir(id), filename), { recursive: true, force: true });
  }
  async worker(id) {
    const request = this.request(id), directory = this.opDir(id);
    let changed = false;
    try {
      if (!this.ownsLock(id) || this.state(id).status !== "accepted") fail("operation_conflict");
      this.save(id, { status: "preparing" });
      let candidate, launcher, service;
      if (request.action === "upgrade") {
        const archive = fs.readFileSync(this.checkManaged(path.join(directory, "bundle.tar.gz")));
        if (digest(archive) !== request.target.artifact_sha256) fail("checksum_mismatch");
        const unpacked = path.join(directory, "unpacked"); fs.mkdirSync(unpacked, { mode: 0o755 });
        this.extract(archive, unpacked);
        const runtime = path.join(unpacked, "lightmoni-agent-runtime");
        const target = this.metadata(runtime);
        if (["version", "source_revision", "build_id", "state_schema", "arch"].some(key => target[key] !== request.target[key])) fail("release_manifest_mismatch");
        candidate = path.join(this.base, "releases", request.target.version + "-" + request.target.artifact_sha256.slice(0, 16) + "-" + id);
        this.atomic(path.join(runtime, "installation.json"), { schema: 1, artifact_sha256: request.target.artifact_sha256 }, 0o644);
        launcher = path.join(unpacked, "lightmoni-agent"); service = path.join(unpacked, "lightmoni-agent.service");
        this.command(launcher, ["check", "--config", this.p("/etc/lightmoni-agent/config.json"), "--require-data-dir", this.p("/var/lib/lightmoni-agent")]);
        fs.renameSync(runtime, candidate);
      } else {
        const retained = this.previous();
        if (!retained || retained.fingerprint !== request.target.fingerprint || ["version", "source_revision", "build_id", "state_schema", "arch", "artifact_sha256"].some(key => retained[key] !== request.target[key])) fail("previous_release_changed");
        candidate = retained.release_path;
        launcher = path.join(this.opDir(retained.operation_id), "previous-launcher"); service = path.join(this.opDir(retained.operation_id), "previous-service");
        this.command(path.join(candidate, "node"), [path.join(candidate, "app/runtime/dist/agent/main.js"), "check", "--config", this.p("/etc/lightmoni-agent/config.json"), "--require-data-dir", this.p("/var/lib/lightmoni-agent")]);
      }
      if (this.fingerprint(this.currentPath()).fingerprint !== request.expected_fingerprint || this.identity() !== request.expected_agent_id) fail("installation_changed");
      const activeState = this.system("ActiveState");
      if (!["active", "inactive", "failed"].includes(activeState) || (activeState === "active") !== request.expected_service_active) fail("service_state_changed");
      if (this.hasOperation()) fail("operation_conflict");
      this.atomic(path.join(directory, "previous-launcher"), fs.readFileSync(this.checkManaged(this.p("/usr/local/bin/lightmoni-agent"))), 0o755);
      this.atomic(path.join(directory, "previous-service"), fs.readFileSync(this.checkManaged(this.p("/etc/systemd/system/lightmoni-agent.service"))), 0o644);
      this.save(id, { status: "switching" });
      changed = true;
      this.command("systemctl", ["stop", "lightmoni-agent.service"]);
      if (!["inactive", "failed"].includes(this.system("ActiveState"))) fail("service_stop_failed");
      if (this.hasOperation()) fail("operation_conflict");
      this.switchCurrent(candidate);
      this.atomic(this.p("/usr/local/bin/lightmoni-agent"), fs.readFileSync(launcher), 0o755);
      this.atomic(this.p("/etc/systemd/system/lightmoni-agent.service"), fs.readFileSync(service), 0o644);
      this.command("systemctl", ["daemon-reload"]);
      this.command("systemctl", ["restart", "lightmoni-agent.service"]);
      const deadline = this.now() + (request.confirm_timeout_seconds ?? 180) * 1000;
      let healthy = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        const health = this.health(request);
        if (health.service_active && health.identity_matches && health.release_matches && health.boot_id && health.boot_id !== this.state(id).from.boot_id) {
          this.save(id, { status: "waiting_confirmation", local_health: health, confirmation_deadline: new Date(deadline).toISOString() }); healthy = true; break;
        }
        await this.sleep(1000);
      }
      if (!healthy) fail("local_health_failed");
      while (this.now() < deadline) {
        if (fs.existsSync(path.join(directory, "rollback-request.json"))) fail("rollback_requested");
        if (fs.existsSync(path.join(directory, "commit-request.json"))) {
          const commit = boundedJSON(this.checkManaged(path.join(directory, "commit-request.json")));
          const health = this.health(request);
          if (commit.expected_boot_id !== health.boot_id || commit.expected_target_sha256 !== request.target.artifact_sha256 || !health.service_active || !health.identity_matches || !health.release_matches || !health.boot_id || health.boot_id === this.state(id).from.boot_id) fail("commit_health_changed");
          // Preserve one known previous program for an explicitly reviewed
          // rollback. Both files are root owned, outside Agent's write paths.
          this.atomic(path.join(this.base, "previous.json"), { schema: 1, operation_id: id, release_path: request.previous_path, fingerprint: request.expected_fingerprint }, 0o644);
          const result = this.save(id, { status: "succeeded", local_health: health, finished_at: this.timestamp() });
          this.cleanup(id); this.unlock(id); return result;
        }
        const health = this.health(request);
        if (!health.service_active || !health.identity_matches || !health.release_matches) fail("local_health_lost");
        await this.sleep(1000);
      }
      fail("confirmation_timeout");
    } catch (error) {
      if (changed) {
        try { return await this.restore(id, safeCode(error)); }
        catch { return this.save(id, { status: "rollback_failed", error_code: "rollback_failed" }); }
      }
      const result = this.save(id, { status: "failed", error_code: safeCode(error), finished_at: this.timestamp() });
      this.cleanup(id); if (this.ownsLock(id)) this.unlock(id); return result;
    }
  }
  commit(request) {
    const state = this.state(request.operation_id);
    if (state.status === "succeeded") return state;
    if (state.status !== "waiting_confirmation" || !this.ownsLock(request.operation_id) || !/^[a-f0-9-]{36}$/.test(request.expected_boot_id ?? "") || !SHA.test(request.expected_target_sha256 ?? "")) fail("invalid_commit");
    const plan = this.request(request.operation_id), health = this.health(plan);
    if (request.expected_boot_id !== health.boot_id || health.boot_id === state.from.boot_id || request.expected_target_sha256 !== state.target.artifact_sha256 || !health.service_active || !health.identity_matches || !health.release_matches || this.now() >= Date.parse(state.confirmation_deadline)) fail("commit_health_changed");
    this.atomic(path.join(this.opDir(request.operation_id), "commit-request.json"), request);
    return state;
  }
  rollback(request) {
    const state = this.state(request.operation_id);
    if (TERMINAL.has(state.status)) return state;
    if (!this.ownsLock(request.operation_id)) fail("lifecycle_lock_changed");
    this.atomic(path.join(this.opDir(request.operation_id), "rollback-request.json"), { operation_id: request.operation_id });
    return state;
  }
}

export async function maintenanceCLI(args, input, output) {
  try {
    if (process.getuid?.() !== 0 || process.platform !== "linux") fail("root_linux_required");
    const command = args[0], maintenance = new AgentMaintenance();
    if (command === "worker" && args.length === 2 && OP.test(args[1])) { await maintenance.worker(args[1]); return; }
    let bytes = ""; for await (const chunk of input) { bytes += chunk; if (Buffer.byteLength(bytes) > 32768) fail("invalid_request"); }
    const request = bytes.trim() ? JSON.parse(bytes) : {};
    let result;
    if (command === "probe") result = maintenance.probe();
    else if (command === "start") result = await maintenance.start(request);
    else if (command === "status") result = maintenance.state(request.operation_id);
    else if (command === "commit") result = maintenance.commit(request);
    else if (command === "rollback") result = maintenance.rollback(request);
    else fail("invalid_command");
    output(JSON.stringify(result) + "\n");
  } catch (error) { output(JSON.stringify({ error_code: safeCode(error) }) + "\n"); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  await maintenanceCLI(process.argv.slice(2), process.stdin, value => process.stdout.write(value));
