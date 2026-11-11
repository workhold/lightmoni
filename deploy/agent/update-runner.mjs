#!/usr/bin/env node
/** Fixed, root-only Agent maintenance protocol. This file has no application
 * imports: the existing bundled Node can supervise replacement of its app. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as nextTurn } from "node:timers/promises";

export const ORDINARY_AGENT_SERVICE_SHA256 = "e40409fb295ff646cf016a05c2571d2004202454bdeb742dc88d4aff29391a12";
export const HELPER_SERVICE_SHA256 = "e1616a6c930450c27af71d23bab66fd64b4ae573344238c6ef501a8f969b162a";
const SERVICE_MODES=new Map([[ORDINARY_AGENT_SERVICE_SHA256,'user']]);
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OP = /^[a-f0-9]{32}$/;
const VERSION = /^[A-Za-z0-9._-]{1,128}$/;
const REVISION = /^[a-f0-9]{40}$/;
const TERMINAL = new Set(["succeeded", "rolled_back", "failed", "rollback_failed"]);
const MAX_ARCHIVE = 256 << 20;
const MAX_EXPANDED_ARCHIVE = 768 << 20;
const COPY_CHUNK = 64 << 10;
const MAX_ARCHIVE_METADATA = 64 << 10;
const MAX_ARCHIVE_INDEX = 16 << 20;
const DISK_RESERVE = 64 << 20;
const INODE_RESERVE = 1024;
const PREPARE_MS = 300000, HARD_MS = 1200000;
const HEALTH_MS = 120000, RESTORE_MS = 300000, WATCHDOG_MARGIN_MS = 60000;
const EXIT_RESULTS = new Set(['success','resources','timeout','exit-code','signal','core-dump','watchdog','start-limit-hit','oom-kill','protocol','unknown']);
const cancelled = signal => { if (signal?.aborted) fail("maintenance_cancelled"); };
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
    this.elapsed = options.monotonic ?? options.now ?? (() => performance.now());
    this.phaseDeadline = null;
    this.statfs = options.statfs ?? fs.statfsSync;
    const run = options.command ?? ((file, args, timeout) => execFileSync(file, args, { encoding: "utf8", timeout, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "pipe"] }).trim());
    this.command = (file, args) => { this.checkBudget(); const result = run(file, args, this.phaseDeadline === null ? 15000 : Math.max(1, Math.min(15000, Math.ceil(this.phaseDeadline - this.elapsed())))); this.checkBudget(); return result; };
    this.self = options.self ?? fileURLToPath(import.meta.url);
    this.launch = options.launch;
  }
  p(value) { return path.join(this.root, value); }
  get base() { return this.p("/opt/lightmoni-agent"); }
  get lock() { return this.p("/run/lightmoni-agent-lifecycle.lock"); }
  opDir(id) { if (!OP.test(id ?? "")) fail("invalid_operation"); return path.join(this.base, "updates", id); }
  timestamp() { return new Date(this.now()).toISOString(); }
  checkBudget() { if (this.phaseDeadline !== null && this.elapsed() >= this.phaseDeadline) fail(this.phaseError ?? 'maintenance_timeout'); }
  phase(deadline, code) { this.phaseDeadline = deadline; this.phaseError = code; this.checkBudget(); }
  writeOnce(filename, value) {
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)+'\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const parent = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  boundedText(filename, maximum = 32768) {
    const fd = fs.openSync(filename, 'r');
    try { const bytes=Buffer.allocUnsafe(maximum+1), count=fs.readSync(fd,bytes,0,bytes.length,0); if(count>maximum)fail('unsafe_file'); return bytes.subarray(0,count).toString('utf8'); }
    finally { fs.closeSync(fd); }
  }
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
  async archiveDigest(filename, signal) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of fs.createReadStream(filename, { highWaterMark: COPY_CHUNK })) {
      cancelled(signal); this.checkBudget();
      size += chunk.length;
      if (size > MAX_ARCHIVE) fail("invalid_archive");
      hash.update(chunk);
    }
    cancelled(signal);
    return hash.digest("hex");
  }
  async copyArchive(source, destination, expectedSHA) {
    const temporary = destination + ".new-" + randomUUID();
    const fd = fs.openSync(temporary, "wx", 0o600), hash = createHash("sha256");
    let size = 0;
    try {
      fs.fchmodSync(fd, 0o600);
      for await (const chunk of fs.createReadStream(source, { highWaterMark: COPY_CHUNK })) {
        this.checkBudget(); size += chunk.length;
        if (size > MAX_ARCHIVE) fail("invalid_archive");
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
      }
      if (hash.digest("hex") !== expectedSHA) fail("checksum_mismatch");
      fs.fsyncSync(fd);
      fs.renameSync(temporary, destination);
      const directory = fs.openSync(path.dirname(destination), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  }
  state(id) {
    const directory = this.checkManaged(this.opDir(id), "directory");
    const status = boundedJSON(this.checkManaged(path.join(directory, "status.json")));
    if (status.schema !== 1 || status.operation_id !== id || !ID.test(status.agent_id ?? "") || !["accepted", "preparing", "switching", "waiting_confirmation", ...TERMINAL].includes(status.status)
      || status.rollback_error_code !== undefined && !/^[a-z_]{1,80}$/.test(status.rollback_error_code)) fail("invalid_receipt");
    try {
      const exit=boundedJSON(this.checkManaged(path.join(directory,'unit-exit.json')),4096);
      if(exit.schema!==1||!EXIT_RESULTS.has(exit.result)||!['exited','killed','dumped','unknown'].includes(exit.exit_code)||!Number.isInteger(exit.exit_status)||exit.exit_status<0||exit.exit_status>255||exit.memory_peak_bytes!==undefined&&(!Number.isSafeInteger(exit.memory_peak_bytes)||exit.memory_peak_bytes<0))fail('invalid_exit_evidence');
      status.worker_exit=exit;
    } catch(error) { if(!absent(error))throw error; }
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
  fileDigest(filename) {
    const fd = fs.openSync(this.checkManaged(filename), "r"), hash = createHash("sha256");
    // Metadata and fingerprints are synchronous contracts. Hash large program
    // files with one fixed buffer instead of retaining whole Node binaries.
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK);
      for (;;) {
        this.checkBudget();
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
      }
      return hash.digest("hex");
    } finally { fs.closeSync(fd); }
  }
  metadata(releasePath) {
    this.checkManaged(releasePath, "directory");
    const manifest = boundedJSON(this.checkManaged(path.join(releasePath, "release.json")), 16384);
    if (!VERSION.test(manifest.version ?? "") || manifest.platform !== "linux" || !["amd64", "arm64"].includes(manifest.arch)) fail("unsupported_release");
    const current = manifest.state_schema === 1 && REVISION.test(manifest.source_revision ?? "") && VERSION.test(manifest.build_id ?? "");
    if (!current) fail("unsupported_state_schema");
    if (manifest.node_binary_sha256 !== undefined && (!SHA.test(manifest.node_binary_sha256) || this.fileDigest(path.join(releasePath, "node")) !== manifest.node_binary_sha256)) fail("runtime_checksum_mismatch");
    let artifact = "";
    try {
      const receipt = boundedJSON(this.checkManaged(path.join(releasePath, "installation.json")), 4096);
      if (receipt.schema !== 1 || !SHA.test(receipt.artifact_sha256 ?? "")) fail("invalid_installation_receipt");
      artifact = receipt.artifact_sha256;
    } catch (error) { if (!absent(error)) throw error; }
    return { version: manifest.version, source_revision: manifest.source_revision, build_id: manifest.build_id, state_schema: 1, artifact_sha256: artifact, arch: manifest.arch };
  }
  ordinaryService(filename) {
    const file=this.checkManaged(filename),info=fs.statSync(file);
    if(info.size>8192||!SERVICE_MODES.has(digest(fs.readFileSync(file))))fail("agent_service_override_not_allowed");
    return fs.readFileSync(file);
  }
  fingerprint(releasePath, launcherPath = this.p("/usr/local/bin/lightmoni-agent"), servicePath = this.p("/etc/systemd/system/lightmoni-agent.service"), helperPath = this.p('/etc/systemd/system/lightmoni-agent-helper.service')) {
    const release = this.metadata(releasePath);
    const launcher = fs.readFileSync(this.checkManaged(launcherPath));
    const service = fs.readFileSync(this.checkManaged(servicePath));
    const manifest = fs.readFileSync(this.checkManaged(path.join(releasePath, "release.json")));
    const node = this.fileDigest(path.join(releasePath, "node"));
    const entrypoint = this.fileDigest(path.join(releasePath, "app/runtime/dist/agent/main.js"));
    const uninstaller = this.fileDigest(path.join(releasePath, "uninstall.sh"));
    let helperService='';
    try { helperService=digest(fs.readFileSync(this.checkManaged(helperPath))); }
    catch(error) { if(!absent(error))throw error; }
    if(helperService&&helperService!==HELPER_SERVICE_SHA256)fail('helper_service_override_not_allowed');
    return { ...release, fingerprint: digest(JSON.stringify({ release_path: releasePath, release, manifest: digest(manifest), launcher: digest(launcher), service: digest(service), helper_service:helperService, node, entrypoint, uninstaller })) };
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
  helperSystem(property) { return this.command("systemctl", ["show", "lightmoni-agent-helper.service", "--property=" + property, "--value"]); }
  runtimeMode() {
    const config=boundedJSON(this.checkManaged(this.p('/etc/lightmoni-agent/config.json')));
    const mode=config.runtime_mode??'user';
    if(!['root','user'].includes(mode))fail('invalid_runtime_mode');
    return mode;
  }
  runtimeGeneration() {
    const config=boundedJSON(this.checkManaged(this.p('/etc/lightmoni-agent/config.json')));
    const generation=config.permission_generation??1;
    if(!Number.isSafeInteger(generation)||generation<1)fail('invalid_runtime_config');
    return generation;
  }
  helperService() {
    const filename=this.p('/etc/systemd/system/lightmoni-agent-helper.service');
    try {
      const file=this.checkManaged(filename), bytes=fs.readFileSync(file);
      if(digest(bytes)!==HELPER_SERVICE_SHA256)fail('helper_service_override_not_allowed');
      return bytes;
    } catch(error) { if(absent(error))return null; throw error; }
  }
  assertPackagedHelper(filename) {
    const file=this.checkManaged(filename);
    const bytes=fs.readFileSync(file);
    if(digest(bytes)!==HELPER_SERVICE_SHA256)fail('helper_service_package_invalid');
    return bytes;
  }
  assertRetainedHelper(filename) {
    try { return this.assertPackagedHelper(filename); }
    catch(error) { if(absent(error))fail('previous_helper_snapshot_missing'); throw error; }
  }
  assertHelperMode(mode) {
    const service=this.helperService(), load=this.helperSystem('LoadState'), fragment=this.helperSystem('FragmentPath');
    if(mode==='root') {
      if(!service||load!=='loaded'||fragment!==this.p('/etc/systemd/system/lightmoni-agent-helper.service'))fail('helper_service_missing');
      const config=this.checkManaged(this.p('/etc/lightmoni-agent-helper/helper.json'));
      if((fs.statSync(config).mode&0o777)!==0o600)fail('helper_private_config_invalid');
      if(this.helperSystem('ActiveState')!=='active')fail('helper_service_inactive');
      if(this.helperSystem('DropInPaths').trim())fail('helper_service_override_not_allowed');
      const rootStatus=JSON.parse(this.command(this.p('/usr/local/bin/lightmoni-agent'),['helper-status']));
      const helperConfig=boundedJSON(config);
      if(rootStatus.permission_generation!==helperConfig.permission_generation||rootStatus.fenced||rootStatus.pending_results!==0
        ||rootStatus.ordinary_task_runner?.active!==false||rootStatus.ordinary_task_runner?.state!=='idle')fail('managed_execution_not_idle');
      return true;
    }
    if(service||load!=='not-found'||fragment)fail('unexpected_helper_service');
    return false;
  }
  assertOrdinaryService() {
    this.ordinaryService(this.p('/etc/systemd/system/lightmoni-agent.service'));
    if (this.system('DropInPaths').trim()) fail('agent_service_override_not_allowed');
    const directory = this.p('/etc/systemd/system/lightmoni-agent.service.d');
    try { this.checkManaged(directory,'directory'); if (fs.readdirSync(directory).length) fail('agent_service_override_not_allowed'); }
    catch (error) { if (!absent(error)) throw error; }
  }
  hasOperation() {
    try { if(fs.existsSync(this.p('/etc/lightmoni-agent-helper/managed.json'))){const s=JSON.parse(this.command(this.p('/usr/local/bin/lightmoni-agent'),['helper-status']));if(s.fenced||s.pending_results!==0||s.ordinary_task_runner?.active!==false||s.ordinary_task_runner?.state!=='idle')return true;} }
    catch { return true; }
    try { fs.lstatSync(this.p("/var/lib/lightmoni-agent/operations/execution.lock")); return true; }
    catch (error) { if (!absent(error)) return true; }
    for (const filename of ["agent-job-state.json", "task-run-state.json"]) {
      try {
        const state = boundedJSON(this.p("/var/lib/lightmoni-agent/" + filename));
        if (!state || typeof state !== "object" || Array.isArray(state)) return true;
        const keys = Object.keys(state);
        if (keys.length !== 0 && !(keys.length === 1 && keys[0] === "id" && state.id === "")) return true;
      }
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
      const helperSnapshot=path.join(source,'previous-helper-service');
      const value = this.fingerprint(retained.release_path, path.join(source, "previous-launcher"), path.join(source, "previous-service"), helperSnapshot);
      if (value.fingerprint !== retained.fingerprint) fail("previous_release_changed");
      // Preserve the immutable old unit as evidence, but never offer its
      // former host powers as a retained program rollback target.
      const mode=SERVICE_MODES.get(digest(fs.readFileSync(this.checkManaged(path.join(source,"previous-service")))));
      const currentMode=SERVICE_MODES.get(digest(fs.readFileSync(this.checkManaged(this.p('/etc/systemd/system/lightmoni-agent.service')))));
      if(!mode||mode!==currentMode)return null;
      // A retained monitor-only program has no helper unit snapshot. Do not
      // advertise it for a complete-management rollback or borrow a unit from
      // another release; changing mode is a separately reviewed operation.
      if(this.runtimeMode()==='root')this.assertRetainedHelper(helperSnapshot);
      return { ...value, release_path: retained.release_path, operation_id: retained.operation_id };
    } catch (error) { if(absent(error))return null;throw error; }
  }
  probe() {
    const agent = this.identity();
    const currentPath = this.currentPath();
    const current = this.fingerprint(currentPath);
    const fragment = this.system("FragmentPath"), load = this.system("LoadState"), active = this.system("ActiveState");
    if (fragment !== this.p("/etc/systemd/system/lightmoni-agent.service") || load !== "loaded" || !["active", "inactive", "failed"].includes(active)) fail("unmanaged_installation");
    const runtimeMode=this.runtimeMode(),permissionGeneration=this.runtimeGeneration(),helperActive=this.assertHelperMode(runtimeMode);
    const local = this.localStatus();
    let previous=null,previousUnavailable='';
    try { previous=this.previous(); }
    catch(error) {
      if(error?.safeCode!=='previous_helper_snapshot_missing')throw error;
      previousUnavailable=error.safeCode;
    }
    const boot = typeof local.boot_id === "string" && /^[a-f0-9-]{36}$/.test(local.boot_id) && local.agent_id === agent ? local.boot_id : "";
    if(!Number.isSafeInteger(local.runtime?.uid)||local.runtime.uid<=0||!Number.isSafeInteger(local.runtime?.gid)||local.runtime.gid<=0||local.runtime.mode!==runtimeMode||local.runtime.permission_generation!==permissionGeneration)fail('ordinary_agent_identity_required');
    return { schema: 1, ready: current.arch === this.arch, agent_id: agent, arch: this.arch, runtime_mode:runtimeMode, permission_generation:permissionGeneration, service_active: active === "active", helper_active:helperActive, lifecycle_locked: fs.existsSync(this.lock), operation_lock: this.hasOperation(), current: { ...current, boot_id: boot }, previous: previous ? this.publicRelease(previous) : null, ...(previousUnavailable ? {previous_unavailable_reason:previousUnavailable} : {}) };
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
    this.assertOrdinaryService();
    if (!before.ready || before.agent_id !== request.expected_agent_id || before.current.fingerprint !== request.expected_fingerprint) fail("installation_changed");
    if (before.service_active !== request.expected_service_active) fail("service_state_changed");
    if (before.lifecycle_locked || before.operation_lock) fail("operation_conflict");
    if (request.action === "rollback" && before.previous_unavailable_reason) fail(before.previous_unavailable_reason);
    if (request.action === "rollback" && (!before.previous || before.previous.fingerprint !== request.target.fingerprint)) fail("previous_release_changed");
    let archivePath;
    if (request.action === "upgrade") {
      if (typeof request.archive_path !== "string") fail("archive_missing");
      this.checkManaged(request.archive_path);
      const info = fs.statSync(request.archive_path);
      if (info.size < 1024 || info.size > MAX_ARCHIVE) fail("invalid_archive");
      archivePath = request.archive_path;
      if (await this.archiveDigest(archivePath) !== request.target.artifact_sha256) fail("checksum_mismatch");
      const space = this.statfs(this.base);
      if (space.bavail * space.bsize < info.size * 5 + DISK_RESERVE) fail("insufficient_disk_space");
    }
    fs.mkdirSync(path.join(this.base, "updates"), { mode: 0o700, recursive: true });
    this.checkManaged(path.join(this.base, "updates"), "directory");
    fs.mkdirSync(this.lock, { mode: 0o700 });
    let dispatchAttempted = false;
    try {
      this.atomic(path.join(this.lock, "owner.json"), { operation_id: id });
      if (this.now() >= Date.parse(request.start_deadline)) fail("start_deadline_expired");
      fs.mkdirSync(directory, { mode: 0o700 });
      const state = { schema: 1, operation_id: id, agent_id: before.agent_id, status: "accepted", from: before.current, target: { ...request.target }, local_health: { service_active: false, helper_active: false, identity_matches: false, release_matches: false, boot_id: "" }, started_at: this.timestamp(), updated_at: this.timestamp() };
      this.atomic(path.join(directory, "status.json"), state);
      this.atomic(path.join(directory, "request.json"), { ...request, archive_path: undefined, previous_path: this.currentPath(), previous_active: before.service_active, rollback_source: request.action === "rollback" ? this.previous() : null });
      if (archivePath) await this.copyArchive(archivePath, path.join(directory, "bundle.tar.gz"), request.target.artifact_sha256);
      this.atomic(path.join(directory, "worker.mjs"), fs.readFileSync(this.self));
      this.atomic(path.join(directory, 'exit-evidence.sh'), this.exitEvidenceScript(id), 0o700);
      this.atomic(path.join(this.base, "update-runner.mjs"), fs.readFileSync(this.self), 0o644);
      const node = this.checkManaged(path.join(this.currentPath(), "node"));
      dispatchAttempted = true;
      if (this.launch) await this.launch(id, node, path.join(directory, "worker.mjs"));
      else this.command("systemd-run", ["--quiet", "--no-block", "--collect", "--unit=lightmoni-agent-update-" + id, "--property=Type=exec", "--property=UMask=0077", "--property=StandardOutput=null", "--property=StandardError=null", "--property=RuntimeMaxSec=1200", "--property=ExecStopPost=/bin/sh " + path.join(directory,'exit-evidence.sh'), "--property=MemoryHigh=384M", "--property=MemoryMax=512M", "--property=MemorySwapMax=0", "--property=CPUQuota=50%", "--property=TasksMax=64", "--property=Nice=10", "--property=IOSchedulingClass=idle", node, path.join(directory, "worker.mjs"), "worker", id]);
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
  /** Inflate to a private, bounded on-disk TAR. Validate every path and link
   * before materializing any member; retain offsets instead of body Buffers. */
  async extract(archivePath, destination, { signal } = {}) {
    cancelled(signal); this.checkBudget();
    this.checkManaged(archivePath);
    if (fs.statSync(archivePath).size > MAX_ARCHIVE) fail("invalid_archive");
    this.checkManaged(destination, "directory");
    const temporary = path.join(destination, ".maintenance-" + randomUUID() + ".tar");
    const fd = fs.openSync(temporary, "wx+", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      if (fs.fstatSync(fd).uid !== this.uid) fail("unsafe_managed_path");
      let expanded = 0, sinceSpaceCheck = 0;
      const maintenance=this;
      const limit = new Transform({
        highWaterMark: COPY_CHUNK,
        transform(chunk, _encoding, callback) {
          try {
            cancelled(signal); maintenance.checkBudget();
            expanded += chunk.length;
            sinceSpaceCheck += chunk.length;
            if (expanded > MAX_EXPANDED_ARCHIVE) fail("archive_too_large");
            if (sinceSpaceCheck >= 8 << 20) {
              const space = maintenance.statfs(destination);
              if (space.bavail * space.bsize < DISK_RESERVE) fail("insufficient_disk_space");
              sinceSpaceCheck = 0;
            }
            callback(null, chunk);
          } catch (error) { callback(error); }
        },
      });
      try {
        await pipeline(
          fs.createReadStream(archivePath, { highWaterMark: COPY_CHUNK }),
          createGunzip({ chunkSize: COPY_CHUNK }), limit,
          new Writable({ highWaterMark: COPY_CHUNK, write(chunk, _encoding, callback) {
            try {
              for (let offset = 0; offset < chunk.length;) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
              callback();
            } catch (error) { callback(error); }
          } }),
          ...(signal ? [{ signal }] : []),
        );
      } catch (error) {
        cancelled(signal);
        if (error?.safeCode) throw error;
        if (error?.code === "ENOSPC") fail("insufficient_disk_space");
        fail("invalid_archive");
      }
      cancelled(signal);
      const entries = [], names = new Map();
      let offset = 0, indexSize = 0, headers = 0;
      let extended = {}, global = {}, longName = "", longLink = "";
      const read = (position, length) => {
        const value = Buffer.allocUnsafe(length);
        let received = 0;
        while (received < length) {
          const count = fs.readSync(fd, value, received, length - received, position + received);
          if (count === 0) fail("invalid_archive");
          received += count;
        }
        return value;
      };
      const string = value => value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)).toString("utf8");
      const octal = value => { const text = string(value).trim(); if (!/^[0-7]*$/.test(text)) fail("invalid_archive"); return text ? parseInt(text, 8) : 0; };
      while (offset + 512 <= expanded) {
        cancelled(signal); this.checkBudget();
        if (++headers % 128 === 0) await nextTurn();
        const header = read(offset, 512); offset += 512;
        if (header.every(byte => byte === 0)) {
          // Never hide unvalidated entries behind an early end marker.
          while (offset < expanded) {
            cancelled(signal); this.checkBudget();
            const tail = read(offset, Math.min(COPY_CHUNK, expanded - offset));
            if (tail.some(byte => byte !== 0)) fail("invalid_archive");
            offset += tail.length;
            await nextTurn();
          }
          break;
        }
        const checksum = octal(header.subarray(148, 156));
        let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== sum) fail("invalid_archive");
        const size = octal(header.subarray(124, 136)), bodyOffset = offset;
        if (!Number.isSafeInteger(size) || size < 0 || offset + Math.ceil(size / 512) * 512 > expanded) fail("invalid_archive");
        offset += Math.ceil(size / 512) * 512;
        const type = String.fromCharCode(header[156] || 48);
        if (["x", "g"].includes(type)) {
          if (size > MAX_ARCHIVE_METADATA) fail("archive_too_large");
          const body = read(bodyOffset, size), pax = {}; let cursor = 0, records = 0;
          while (cursor < body.length) {
            const space = body.indexOf(32, cursor); if (space < 0) fail("invalid_archive");
            const length = Number(body.subarray(cursor, space).toString());
            if (!Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > body.length || body[cursor + length - 1] !== 10 || ++records > 1024) fail("invalid_archive");
            const item = body.subarray(space + 1, cursor + length - 1).toString(), equal = item.indexOf("=");
            if (equal < 1) fail("invalid_archive");
            // All other PAX attributes are ignored by this protocol. Retaining
            // only these three also bounds repeated global metadata headers.
            const key = item.slice(0, equal);
            if (["path", "linkpath", "size"].includes(key)) pax[key] = item.slice(equal + 1);
            cursor += length;
          }
          if (type === "g") global = { ...global, ...pax }; else extended = pax;
          continue;
        }
        if (type === "L" || type === "K") {
          if (size > 4096) fail("invalid_archive");
          if (type === "L") longName = string(read(bodyOffset, size)); else longLink = string(read(bodyOffset, size));
          continue;
        }
        const attrs = { ...global, ...extended }; extended = {};
        const prefix = string(header.subarray(345, 500));
        const raw = attrs.path ?? (longName || (prefix ? prefix + "/" : "") + string(header.subarray(0, 100)));
        const link = attrs.linkpath ?? (longLink || string(header.subarray(157, 257))); longName = ""; longLink = "";
        const name = raw.replace(/\/$/, "");
        if (typeof name !== "string" || !name || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || name.length > 4096 || /[\x00-\x1f\x7f]/.test(name)) fail("unsafe_archive_path");
        if (!["lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-helper.service", "lightmoni-agent-runtime"].includes(name.split("/")[0])) fail("unsafe_archive_path");
        if (!["0", "5", "2"].includes(type) || (attrs.size !== undefined && Number(attrs.size) !== size)) fail("unsupported_archive_entry");
        if (names.has(name) && !(type === "5" && names.get(name) === "5")) fail("duplicate_archive_path");
        names.set(name, type);
        if (type === "2") {
          if (!link || link.length > 4096 || path.posix.isAbsolute(link) || /[\\\x00-\x1f\x7f]/.test(link)) fail("unsafe_archive_link");
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
          if (!target.startsWith("lightmoni-agent-runtime/") || target.includes("../")) fail("unsafe_archive_link");
        }
        entries.push({ name, link, type, offset: bodyOffset, size, mode: octal(header.subarray(100, 108)) });
        indexSize += Buffer.byteLength(name) + Buffer.byteLength(link) + 192;
        if (entries.length > 100000 || indexSize > MAX_ARCHIVE_INDEX) fail("archive_too_large");
      }
      if (offset !== expanded || Object.keys(extended).length || longName || longLink) fail("invalid_archive");
      for (const entry of entries) {
        let parent = path.posix.dirname(entry.name);
        while (parent !== ".") { if (names.has(parent) && names.get(parent) !== "5") fail("unsafe_archive_path"); parent = path.posix.dirname(parent); }
      }
      // Account for actual allocated file blocks and all implicit parents,
      // after validation and while the private TAR already occupies disk.
      const space=this.statfs(destination), block=Number(space.bsize), objects=new Set(), directories=new Set();
      let requiredBytes=0;
      for(const entry of entries){
        objects.add(entry.name);
        if(entry.type==='5')directories.add(entry.name);
        else requiredBytes+=entry.type==='2'?block:Math.ceil(entry.size/block)*block;
        for(let parent=path.posix.dirname(entry.name);parent!=='.';parent=path.posix.dirname(parent)){objects.add(parent);directories.add(parent);}
      }
      requiredBytes+=directories.size*block;
      if(space.bavail*block<requiredBytes+DISK_RESERVE)fail('insufficient_disk_space');
      if(!Number.isSafeInteger(Number(space.ffree))||Number(space.ffree)<objects.size+INODE_RESERVE)fail('insufficient_inodes');
      // The private TAR is the sole body store. Copy at most 64 KiB at once,
      // yielding between chunks so preparing can be cooperatively cancelled.
      const buffer = Buffer.allocUnsafe(COPY_CHUNK);
      sinceSpaceCheck = 8 << 20;
      for (const entry of entries) {
        cancelled(signal); this.checkBudget();
        if (entry.type === "2") continue;
        const filename = path.join(destination, entry.name);
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o755 });
        if (entry.type === "5") fs.mkdirSync(filename, { recursive: true, mode: 0o755 });
        else {
          const mode = entry.mode & 0o111 ? 0o755 : 0o644, target = fs.openSync(filename, "wx", mode);
          try {
            for (let copied = 0; copied < entry.size;) {
              cancelled(signal); this.checkBudget();
              if (sinceSpaceCheck >= 8 << 20) {
                const space = this.statfs(destination);
                if (space.bavail * space.bsize < DISK_RESERVE) fail("insufficient_disk_space");
                sinceSpaceCheck = 0;
              }
              const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, entry.size - copied), entry.offset + copied);
              if (count === 0) fail("invalid_archive");
              for (let written = 0; written < count;) written += fs.writeSync(target, buffer, written, count - written);
              copied += count; sinceSpaceCheck += count;
              await nextTurn();
            }
            fs.fchmodSync(target, mode);
          } finally { fs.closeSync(target); }
        }
      }
      for (const entry of entries) if (entry.type === "2") { cancelled(signal); fs.symlinkSync(entry.link, path.join(destination, entry.name)); }
      const readableDirectories = async root => {
        cancelled(signal); this.checkBudget(); fs.chmodSync(root, 0o755);
        for (const name of fs.readdirSync(root)) { const child = path.join(root, name); if (fs.lstatSync(child).isDirectory()) await readableDirectories(child); }
        await nextTurn();
      };
      await readableDirectories(destination);
      for (const filename of ["lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-helper.service", "lightmoni-agent-runtime/node", "lightmoni-agent-runtime/release.json"]) {
        const info = fs.lstatSync(path.join(destination, filename)); if (!info.isFile() || info.isSymbolicLink()) fail("invalid_archive");
      }
    } finally { try { fs.closeSync(fd); } finally { fs.rmSync(temporary, { force: true }); } }
  }
  health(request) {
    const active = this.system("ActiveState") === "active", local = this.localStatus();
    const release = local.release ?? {};
    const target = request.target;
    const releaseMatches = release.version === target.version && release.source_revision === target.source_revision && release.build_id === target.build_id && release.state_schema === 1 && release.artifact_sha256 === target.artifact_sha256;
    let helperActive=false;
    try { helperActive=this.assertHelperMode(this.runtimeMode()); } catch { helperActive=false; }
    return { service_active: active, helper_active:helperActive, identity_matches: local.agent_id === request.expected_agent_id && this.identity() === request.expected_agent_id && Number.isSafeInteger(local.runtime?.uid) && local.runtime.uid>0 && Number.isSafeInteger(local.runtime?.gid) && local.runtime.gid>0 && local.runtime.mode===this.runtimeMode() && local.runtime.permission_generation===this.runtimeGeneration(), release_matches: releaseMatches, boot_id: typeof local.boot_id === "string" && /^[a-f0-9-]{36}$/.test(local.boot_id) ? local.boot_id : "" };
  }
  healthy(health) {
    return health.service_active && health.identity_matches && health.release_matches
      && (this.runtimeMode() !== 'root' || health.helper_active === true);
  }
  switchCurrent(directory) {
    const temporary = path.join(this.base, ".current-update-" + randomUUID());
    fs.symlinkSync(directory, temporary); fs.renameSync(temporary, path.join(this.base, "current"));
  }
  prepareUninstaller(candidate, directory) {
    const source = path.join(candidate, "uninstall.sh");
    let script;
    try {
      this.checkManaged(source);
      if (fs.statSync(source).size > 262144) fail("invalid_uninstaller");
      script = fs.readFileSync(source);
    } catch (error) { throw error; }
    const destination = this.p("/usr/local/sbin/lightmoni-agent-uninstall"), parent = path.dirname(destination);
    let directoryPresent = true;
    try { this.checkManaged(parent, "directory"); }
    catch (error) { if (!absent(error)) throw error; directoryPresent = false; this.checkManaged(path.dirname(parent), "directory"); }
    let previous = null;
    try { this.checkManaged(destination); previous = fs.readFileSync(destination); }
    catch (error) { if (!absent(error)) throw error; }
    if (previous) this.atomic(path.join(directory, "previous-uninstaller"), previous);
    this.atomic(path.join(directory, "previous-uninstaller.json"), { present: previous !== null, mode: previous !== null ? fs.statSync(destination).mode & 0o777 : 0, sha256: previous !== null ? digest(previous) : "", directory_present: directoryPresent });
    return script;
  }
  restoreUninstaller(directory) {
    let previous;
    try { previous = boundedJSON(this.checkManaged(path.join(directory, "previous-uninstaller.json"))); }
    catch (error) { if (absent(error)) return; throw error; }
    const destination = this.p("/usr/local/sbin/lightmoni-agent-uninstall"), parent = path.dirname(destination);
    try { this.checkManaged(parent, "directory"); }
    catch (error) { if (absent(error) && previous.present === false) return; throw error; }
    try { this.checkManaged(destination); } catch (error) { if (!absent(error)) throw error; }
    if (previous.present === true) {
      const bytes = fs.readFileSync(this.checkManaged(path.join(directory, "previous-uninstaller")));
      if (!SHA.test(previous.sha256 ?? "") || digest(bytes) !== previous.sha256 || !Number.isInteger(previous.mode) || previous.mode < 0 || previous.mode > 0o777 || (previous.mode & 0o022)) fail("invalid_uninstaller_snapshot");
      this.atomic(destination, bytes, previous.mode);
    } else if (previous.present === false) {
      fs.rmSync(destination, { force: true });
      if (previous.directory_present === false && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } else fail("invalid_uninstaller_snapshot");
  }
  async restore(id, reason, { preserveArtifacts = false } = {}) {
    const request = this.request(id), directory = this.opDir(id);
    this.phase(Math.min(this.hardDeadline ?? Infinity,this.elapsed()+RESTORE_MS), 'rollback_timeout');
    this.command("systemctl", ["stop", "lightmoni-agent.service"]);
    if(this.runtimeMode()==='root')this.command('systemctl',['stop','lightmoni-agent-helper.service']);
    if (!["inactive", "failed"].includes(this.system("ActiveState"))) fail("service_stop_failed");
    this.ordinaryService(path.join(directory,"previous-service"));
    this.assertOrdinaryService();
    this.switchCurrent(request.previous_path);
    this.atomic(this.p("/usr/local/bin/lightmoni-agent"), fs.readFileSync(this.checkManaged(path.join(directory, "previous-launcher"))), 0o755);
    this.atomic(this.p("/etc/systemd/system/lightmoni-agent.service"), fs.readFileSync(this.checkManaged(path.join(directory, "previous-service"))), 0o644);
    if(this.runtimeMode()==='root')this.atomic(this.p('/etc/systemd/system/lightmoni-agent-helper.service'),fs.readFileSync(this.checkManaged(path.join(directory,'previous-helper-service'))),0o644);
    this.restoreUninstaller(directory);
    this.command("systemctl", ["daemon-reload"]);
    if(this.runtimeMode()==='root'){
      this.command(this.p('/usr/local/bin/lightmoni-agent'),['managed-activate']);
      this.command('systemctl',['restart','lightmoni-agent-helper.service']);
    }
    if (request.previous_active) {
      this.command("systemctl", ["restart", "lightmoni-agent.service"]);
      if (this.system("ActiveState") !== "active") fail("rollback_start_failed");
    }
    // A freshly restarted service can be systemd-active before its local
    // status endpoint is ready. Retry only that transient health failure;
    // fingerprint/identity changes remain immediate hard failures.
    let original;
    const healthDeadline=this.elapsed()+Math.min(HEALTH_MS,RESTORE_MS);
    for (;;) {
      try { original=this.verifyOriginalHealth(request); break; }
      catch (error) {
        if (error?.safeCode !== 'recovery_original_unhealthy' || this.elapsed() >= healthDeadline) throw error;
        await this.sleep(1000);
      }
    }
    const {local,helperActive}=original;
    const result = this.save(id, { status: "rolled_back", error_code: reason, restored_fingerprint: request.expected_fingerprint, finished_at: this.timestamp(), local_health: { service_active: request.previous_active ? this.system("ActiveState") === "active" : false, helper_active: helperActive, identity_matches: true, release_matches: true, boot_id: typeof local.boot_id === "string" && /^[a-f0-9-]{36}$/.test(local.boot_id) ? local.boot_id : "" } });
    if(!preserveArtifacts){this.cleanupCandidate(id);this.cleanup(id);} this.unlock(id); return result;
  }
  cleanupCandidate(id) {
    try {
      const request=this.request(id);if(request.action!=='upgrade')return;
      const candidate=path.join(this.base,'releases',request.target.version+'-'+request.target.artifact_sha256.slice(0,16)+'-'+id);
      if(!fs.existsSync(candidate))return;
      this.checkManaged(candidate,'directory');
      if(this.currentPath()===candidate)return;
      try{if(boundedJSON(this.checkManaged(path.join(this.base,'previous.json'))).release_path===candidate)return;}catch(error){if(!absent(error))return;}
      for(const other of fs.readdirSync(path.join(this.base,'updates'))){
        if(other===id||!OP.test(other))continue;
        const state=this.state(other);if(['succeeded','rolled_back','failed'].includes(state.status))continue;
        const value=this.request(other);
        if(value.previous_path===candidate||value.rollback_source?.release_path===candidate)return;
        try{if(boundedJSON(this.checkManaged(path.join(this.opDir(other),'approved-target.json'))).release_path===candidate)return;}catch(error){if(!absent(error))return;}
      }
      fs.rmSync(candidate,{recursive:true,force:true});
    } catch { /* An uncertain reference preserves the candidate. */ }
  }
  cleanup(id) {
    // Keep the small audit receipt and rollback files; archive and unpacked
    // copies are unnecessary once the immutable release has been published.
    for (const filename of ["bundle.tar.gz", "unpacked"]) fs.rmSync(path.join(this.opDir(id), filename), { recursive: true, force: true });
  }
  async worker(id, { signal, handleSignals = false } = {}) {
    const request = this.request(id), directory = this.opDir(id);
    // A duplicate or stale worker never owns failure cleanup for the real
    // worker. Reject before entering the transaction's catch/unlock path.
    if (!this.ownsLock(id) || this.state(id).status !== "accepted") fail("operation_conflict");
    let claim;
    try { claim = fs.openSync(path.join(directory, "worker-claim.json"), "wx", 0o600); }
    catch (error) { if (error?.code === "EEXIST") fail("operation_conflict"); throw error; }
    // The claim is deliberately retained in every terminal state. Even if a
    // worker dies before its first receipt update, this operation may never be
    // replayed by a second process. A failed/partial claim also stays fenced.
    try {
      fs.fchmodSync(claim, 0o600);
      if (fs.fstatSync(claim).uid !== this.uid) fail("unsafe_managed_path");
      fs.writeFileSync(claim, JSON.stringify({ schema: 1, operation_id: id, pid: process.pid, claimed_at: this.timestamp() }) + "\n");
      fs.fsyncSync(claim);
    } finally { fs.closeSync(claim); }
    const claimDirectory = fs.openSync(directory, "r");
    try { fs.fsyncSync(claimDirectory); } finally { fs.closeSync(claimDirectory); }
    if (!this.ownsLock(id) || this.state(id).status !== "accepted") fail("operation_conflict");
    const cancellation = handleSignals ? new AbortController() : null;
    const preparingSignal = signal && cancellation ? AbortSignal.any([signal, cancellation.signal]) : signal ?? cancellation?.signal;
    const onTerminate = () => cancellation?.abort();
    const stopWatching = () => { if (handleSignals) { process.removeListener("SIGTERM", onTerminate); process.removeListener("SIGINT", onTerminate); } };
    if (handleSignals) { process.on("SIGTERM", onTerminate); process.on("SIGINT", onTerminate); }
    let changed = false;
    this.hardDeadline=this.elapsed()+HARD_MS-WATCHDOG_MARGIN_MS;
    this.phase(this.elapsed()+PREPARE_MS,'preparing_timeout');
    try {
      cancelled(preparingSignal);
      this.save(id, { status: "preparing" });
      let candidate, launcher, service, packagedHelper;
      if (request.action === "upgrade") {
        const archive = this.checkManaged(path.join(directory, "bundle.tar.gz"));
        if (await this.archiveDigest(archive, preparingSignal) !== request.target.artifact_sha256) fail("checksum_mismatch");
        const unpacked = path.join(directory, "unpacked"); fs.mkdirSync(unpacked, { mode: 0o755 });
        await this.extract(archive, unpacked, { signal: preparingSignal });
        const runtime = path.join(unpacked, "lightmoni-agent-runtime");
        const target = this.metadata(runtime);
        if (["version", "source_revision", "build_id", "state_schema", "arch"].some(key => target[key] !== request.target[key])) fail("release_manifest_mismatch");
        candidate = path.join(this.base, "releases", request.target.version + "-" + request.target.artifact_sha256.slice(0, 16) + "-" + id);
        this.atomic(path.join(runtime, "installation.json"), { schema: 1, artifact_sha256: request.target.artifact_sha256 }, 0o644);
        launcher = path.join(unpacked, "lightmoni-agent"); service = path.join(unpacked, "lightmoni-agent.service");
        packagedHelper=path.join(unpacked,'lightmoni-agent-helper.service');
        this.assertPackagedHelper(packagedHelper);
        this.command(launcher, ["check", "--config", this.p("/etc/lightmoni-agent/config.json"), "--require-data-dir", this.p("/var/lib/lightmoni-agent")]);
        fs.renameSync(runtime, candidate);
      } else {
        const retained = this.previous();
        if (!retained || retained.fingerprint !== request.target.fingerprint || ["version", "source_revision", "build_id", "state_schema", "arch", "artifact_sha256"].some(key => retained[key] !== request.target[key])) fail("previous_release_changed");
        candidate = retained.release_path;
        launcher = path.join(this.opDir(retained.operation_id), "previous-launcher"); service = path.join(this.opDir(retained.operation_id), "previous-service");
        packagedHelper=path.join(this.opDir(retained.operation_id),'previous-helper-service');
        if(this.runtimeMode()==='root')this.assertRetainedHelper(packagedHelper);
        this.command(path.join(candidate, "node"), [path.join(candidate, "app/runtime/dist/agent/main.js"), "check", "--config", this.p("/etc/lightmoni-agent/config.json"), "--require-data-dir", this.p("/var/lib/lightmoni-agent")]);
      }
      const currentService=this.ordinaryService(this.p('/etc/systemd/system/lightmoni-agent.service'));
      const currentMode=SERVICE_MODES.get(digest(currentService));
      // A package contains a user template; upgrading never changes authority.
      // Root and user share immutable code and keep the installed mode.
      const approvedService=this.ordinaryService(service);
      if(SERVICE_MODES.get(digest(approvedService))!==currentMode)fail('runtime_mode_changed');
      if (this.fingerprint(this.currentPath()).fingerprint !== request.expected_fingerprint || this.identity() !== request.expected_agent_id) fail("installation_changed");
      const activeState = this.system("ActiveState");
      if (!["active", "inactive", "failed"].includes(activeState) || (activeState === "active") !== request.expected_service_active) fail("service_state_changed");
      if (this.hasOperation()) fail("operation_conflict");
      this.assertOrdinaryService();
      const uninstaller = this.prepareUninstaller(candidate, directory);
      const permissions = path.join(candidate, "deployment-permissions.mjs");
      this.checkManaged(permissions);
      this.command(path.join(candidate, "node"), [permissions, "prepare"]);
      this.atomic(path.join(directory, "previous-launcher"), fs.readFileSync(this.checkManaged(this.p("/usr/local/bin/lightmoni-agent"))), 0o755);
      this.atomic(path.join(directory, "previous-service"), fs.readFileSync(this.checkManaged(this.p("/etc/systemd/system/lightmoni-agent.service"))), 0o644);
      const helperService=this.assertHelperMode(this.runtimeMode())?this.checkManaged(this.p('/etc/systemd/system/lightmoni-agent-helper.service')):null;
      if(helperService)this.atomic(path.join(directory,'previous-helper-service'),fs.readFileSync(helperService),0o644);
      if(this.runtimeMode()==='root'){
        this.assertPackagedHelper(packagedHelper);
        this.atomic(path.join(directory,'approved-helper-service'),fs.readFileSync(packagedHelper),0o644);
      }
      this.atomic(path.join(directory,"approved-service"),approvedService,0o644);
      this.atomic(path.join(directory,'approved-launcher'),fs.readFileSync(this.checkManaged(launcher)),0o755);
      this.atomic(path.join(directory,'approved-target.json'),{schema:1,release_path:candidate,fingerprint:this.fingerprint(candidate,path.join(directory,'approved-launcher'),path.join(directory,'approved-service'),path.join(directory,'approved-helper-service')).fingerprint});
      await nextTurn();
      cancelled(preparingSignal); this.checkBudget();
      if(this.hardDeadline-this.elapsed()<HEALTH_MS+(request.confirm_timeout_seconds??180)*1000+RESTORE_MS)fail('maintenance_budget_exhausted');
      // Only preparing supports cooperative termination. After this boundary
      // the original durable switch/restore protocol remains authoritative;
      // an uncatchable exit must still be reconciled as unknown by the server.
      this.save(id, { status: "switching" });
      stopWatching();
      changed = true;
      this.phase(Math.min(this.hardDeadline-RESTORE_MS,this.elapsed()+HEALTH_MS),'local_health_timeout');
      this.command("systemctl", ["stop", "lightmoni-agent.service"]);
      if(this.runtimeMode()==='root'){
        this.command('systemctl',['stop','lightmoni-agent-helper.service']);
        if(!['inactive','failed'].includes(this.helperSystem('ActiveState')))fail('helper_service_stop_failed');
      }
      if (!["inactive", "failed"].includes(this.system("ActiveState"))) fail("service_stop_failed");
      if (this.hasOperation()) fail("operation_conflict");
      this.switchCurrent(candidate);
      this.atomic(this.p("/usr/local/bin/lightmoni-agent"), fs.readFileSync(launcher), 0o755);
      this.atomic(this.p("/etc/systemd/system/lightmoni-agent.service"), approvedService, 0o644);
      if(this.runtimeMode()==='root')this.atomic(this.p('/etc/systemd/system/lightmoni-agent-helper.service'),fs.readFileSync(this.checkManaged(path.join(directory,'approved-helper-service'))),0o644);
      if (uninstaller) {
        const parent = this.p("/usr/local/sbin");
        try { this.checkManaged(parent, "directory"); }
        catch (error) { if (!absent(error)) throw error; fs.mkdirSync(parent, { mode: 0o755 }); this.checkManaged(parent, "directory"); }
        this.atomic(path.join(parent, "lightmoni-agent-uninstall"), uninstaller, 0o755);
      }
      this.save(id, { uninstaller_updated: uninstaller !== null });
      this.command("systemctl", ["daemon-reload"]);
      if(this.runtimeMode()==='root'){
        this.command(this.p('/usr/local/bin/lightmoni-agent'),['managed-activate']);
        this.command('systemctl',['restart','lightmoni-agent-helper.service']);
      }
      this.command("systemctl", ["restart", "lightmoni-agent.service"]);
      const deadline = this.now() + (request.confirm_timeout_seconds ?? 180) * 1000;
      let healthy = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        const health = this.health(request);
        if (this.healthy(health) && health.boot_id && health.boot_id !== this.state(id).from.boot_id) {
          this.save(id, { status: "waiting_confirmation", local_health: health, confirmation_deadline: new Date(deadline).toISOString() }); healthy = true; break;
        }
        await this.sleep(1000);
      }
      if (!healthy) fail("local_health_failed");
      this.phase(Math.min(this.hardDeadline-RESTORE_MS,this.elapsed()+Math.max(0,deadline-this.now())),'confirmation_timeout');
      while (this.now() < deadline) {
        if (fs.existsSync(path.join(directory, "rollback-request.json"))) fail("rollback_requested");
        if (fs.existsSync(path.join(directory, "commit-request.json"))) {
          const commit = boundedJSON(this.checkManaged(path.join(directory, "commit-request.json")));
          const health = this.health(request);
          if (commit.expected_boot_id !== health.boot_id || commit.expected_target_sha256 !== request.target.artifact_sha256 || !this.healthy(health) || !health.boot_id || health.boot_id === this.state(id).from.boot_id) fail("commit_health_changed");
          // Preserve one known previous program for an explicitly reviewed
          // rollback. Both files are root owned, outside Agent's write paths.
          this.atomic(path.join(this.base, "previous.json"), { schema: 1, operation_id: id, release_path: request.previous_path, fingerprint: request.expected_fingerprint }, 0o644);
          const result = this.save(id, { status: "succeeded", local_health: health, finished_at: this.timestamp() });
          this.cleanup(id); this.unlock(id); return result;
        }
        const health = this.health(request);
        if (!this.healthy(health)) fail("local_health_lost");
        await this.sleep(1000);
      }
      fail("confirmation_timeout");
    } catch (error) {
      if (changed) {
        try { return await this.restore(id, safeCode(error)); }
        catch (rollbackError) {
          // Keep the lifecycle fence when restoration cannot be proven, but
          // retain the bounded failure code so recovery can target the actual
          // failed step instead of hiding it behind a generic status.
          return this.save(id, { status: "rollback_failed", error_code: "rollback_failed", rollback_error_code: safeCode(rollbackError), finished_at: this.timestamp() });
        }
      }
      this.phaseDeadline=null;
      const result = this.save(id, { status: "failed", error_code: safeCode(error), finished_at: this.timestamp() });
      this.cleanupCandidate(id); this.cleanup(id); if (this.ownsLock(id)) this.unlock(id); return result;
    } finally { stopWatching(); this.phaseDeadline=null; this.hardDeadline=null; }
  }
  exitEvidenceScript(id) {
    const directory=this.opDir(id), quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
    return [
      '#!/bin/sh','set -eu','PATH=/usr/bin:/bin; export PATH','umask 077',
      'case "${SERVICE_RESULT:-unknown}" in success|resources|timeout|exit-code|signal|core-dump|watchdog|start-limit-hit|oom-kill|protocol) result=$SERVICE_RESULT;; *) result=unknown;; esac',
      'case "${EXIT_CODE:-unknown}" in exited|killed|dumped) code=$EXIT_CODE;; *) code=unknown;; esac',
      'status=${EXIT_STATUS:-0}',
      'case "$status" in TERM|SIGTERM) status=15;; KILL|SIGKILL) status=9;; INT|SIGINT) status=2;; ABRT|SIGABRT) status=6;; SEGV|SIGSEGV) status=11;; *[!0-9]*|"") status=0;; esac',
      '[ "${#status}" -le 3 ] && [ "$status" -le 255 ] || status=0',
      // printf %d normalizes leading zeroes without evaluating input as shell.
      'status=$(printf "%d" "$status" 2>/dev/null) || status=0',
      'resource=""',
      'while IFS=: read -r hierarchy controllers group; do',
      '  if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then',
      '    memory=""; IFS= read -r memory < "/sys/fs/cgroup$group/memory.peak" 2>/dev/null || memory=""',
      '    case "$memory" in *[!0-9]*|"") ;; *) [ "${#memory}" -le 15 ] && resource=",\\"memory_peak_bytes\\":$memory";; esac',
      '  fi','done < /proc/self/cgroup',
      'directory='+quote(directory), 'temporary="$directory/.unit-exit.$$.json"',
      'trap \'rm -f "$temporary"\' EXIT HUP INT TERM',
      '(set -C; printf \'{"schema":1,"result":"%s","exit_code":"%s","exit_status":%s%s}\\n\' "$result" "$code" "$status" "$resource" > "$temporary") || exit 0',
      'mv -f "$temporary" "$directory/unit-exit.json"','',
    ].join('\n');
  }
  assertWorkerStopped(id) {
    const unit='lightmoni-agent-update-'+id+'.service';
    const output=this.command('systemctl',['show',unit,'--property=LoadState,ActiveState,MainPID,ControlPID,ControlGroup,Job']);
    if(typeof output!=='string'||output.length>8192)fail('recovery_unit_unverifiable');
    const values={};
    for(const line of output.trim().split('\n')){const equal=line.indexOf('=');if(equal<1)fail('recovery_unit_unverifiable');const key=line.slice(0,equal);if(key in values)fail('recovery_unit_unverifiable');values[key]=line.slice(equal+1);}
    if(!['loaded','not-found'].includes(values.LoadState)||!['inactive','failed'].includes(values.ActiveState)
      ||!['','0'].includes(values.MainPID)||!['','0'].includes(values.ControlPID)||!['','0'].includes(values.Job))fail('recovery_worker_running');
    const expected='/system.slice/'+unit, group=values.ControlGroup;
    if(typeof group!=='string'||group&&group!==expected)fail('recovery_cgroup_unverifiable');
    const cgroup=this.p('/sys/fs/cgroup'+(group||expected));
    try {
      this.checkManaged(cgroup,'directory');
      const events=this.boundedText(path.join(cgroup,'cgroup.events'),4096),procs=this.boundedText(path.join(cgroup,'cgroup.procs'),4096);
      if(!/^populated 0$/m.test(events)||procs.trim())fail('recovery_worker_running');
    } catch(error) { if(!absent(error))throw error; }
    const processes=fs.readdirSync(this.p('/proc')).filter(value=>/^\d+$/.test(value));
    if(processes.length>100000)fail('recovery_processes_unverifiable');
    const worker=path.join(this.opDir(id),'worker.mjs');
    for(const pid of processes){
      this.checkBudget();
      let args;
      try{args=this.boundedText(this.p('/proc/'+pid+'/cmdline')).split('\0');}
      catch(error){if(absent(error)||error?.code==='ESRCH')continue;throw error;}
      if(args.includes(worker)||args.some((value,index)=>value==='worker'&&args[index+1]===id))fail('recovery_worker_running');
    }
  }
  validateRecovery(input) {
    const keys=['operation_id','expected_agent_id','expected_fingerprint','expected_runtime_mode','expected_permission_generation','expected_target'];
    if(!input||Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key))||!OP.test(input.operation_id??'')||!ID.test(input.expected_agent_id??'')||!SHA.test(input.expected_fingerprint??'')
      ||!['user','root'].includes(input.expected_runtime_mode)||!Number.isSafeInteger(input.expected_permission_generation)||input.expected_permission_generation<1)fail('invalid_recovery_request');
    const target=input.expected_target,targetKeys=['version','source_revision','build_id','state_schema','artifact_sha256','arch'];
    if(!target||Object.keys(target).length!==targetKeys.length||Object.keys(target).some(key=>!targetKeys.includes(key))||!VERSION.test(target.version??'')||!REVISION.test(target.source_revision??'')||!VERSION.test(target.build_id??'')
      ||target.state_schema!==1||!SHA.test(target.artifact_sha256??'')||!['amd64','arm64'].includes(target.arch))fail('invalid_recovery_request');
    const request=this.request(input.operation_id),state=this.state(input.operation_id);
    if(request.operation_id!==input.operation_id||request.expected_agent_id!==input.expected_agent_id||request.expected_fingerprint!==input.expected_fingerprint||state.agent_id!==input.expected_agent_id||state.from.fingerprint!==input.expected_fingerprint
      ||targetKeys.some(key=>request.target?.[key]!==target[key]||state.target?.[key]!==target[key]))fail('recovery_approval_changed');
    if(this.identity()!==input.expected_agent_id||this.runtimeMode()!==input.expected_runtime_mode||this.runtimeGeneration()!==input.expected_permission_generation)fail('recovery_identity_changed');
    return {request,state};
  }
  verifyOriginalHealth(request) {
    if(this.currentPath()!==request.previous_path||this.fingerprint(request.previous_path).fingerprint!==request.expected_fingerprint||this.identity()!==request.expected_agent_id)fail('recovery_original_changed');
    this.assertOrdinaryService();const helperActive=this.assertHelperMode(this.runtimeMode());
    const active=this.system('ActiveState');
    if(request.previous_active?active!=='active':!['inactive','failed'].includes(active))fail('recovery_original_unhealthy');
    const local=this.localStatus(),meta=this.metadata(request.previous_path);
    if(local.agent_id!==request.expected_agent_id||!Number.isSafeInteger(local.runtime?.uid)||local.runtime.uid<=0||!Number.isSafeInteger(local.runtime?.gid)||local.runtime.gid<=0
      ||local.runtime.mode!==this.runtimeMode()||local.runtime.permission_generation!==this.runtimeGeneration()
      ||['version','source_revision','build_id','state_schema','artifact_sha256','arch'].some(key=>local.release?.[key]!==meta[key]))fail('recovery_original_unhealthy');
    return {local,helperActive};
  }
  validateRecoverySnapshots(id,request) {
    const directory=this.opDir(id),mode=this.runtimeMode();
    this.ordinaryService(path.join(directory,'previous-service'));
    if(mode==='root')this.assertRetainedHelper(path.join(directory,'previous-helper-service'));
    const original=this.fingerprint(request.previous_path,path.join(directory,'previous-launcher'),path.join(directory,'previous-service'),path.join(directory,'previous-helper-service'));
    if(original.fingerprint!==request.expected_fingerprint)fail('recovery_original_snapshot_changed');
    const uninstaller=boundedJSON(this.checkManaged(path.join(directory,'previous-uninstaller.json')),4096);
    if(typeof uninstaller.present!=='boolean'||typeof uninstaller.directory_present!=='boolean')fail('invalid_uninstaller_snapshot');
    if(uninstaller.present&&(!SHA.test(uninstaller.sha256??'')||this.fileDigest(path.join(directory,'previous-uninstaller'))!==uninstaller.sha256||!Number.isInteger(uninstaller.mode)||uninstaller.mode<0||uninstaller.mode>0o777||(uninstaller.mode&0o022)))fail('invalid_uninstaller_snapshot');
    const approved=boundedJSON(this.checkManaged(path.join(directory,'approved-target.json')),4096);
    const targetPath=request.action==='upgrade'?path.join(this.base,'releases',request.target.version+'-'+request.target.artifact_sha256.slice(0,16)+'-'+id):request.rollback_source?.release_path;
    if(approved.schema!==1||!SHA.test(approved.fingerprint??'')||approved.release_path!==targetPath)fail('recovery_target_snapshot_changed');
    this.ordinaryService(path.join(directory,'approved-service'));
    if(mode==='root')this.assertPackagedHelper(path.join(directory,'approved-helper-service'));
    const target=this.fingerprint(targetPath,path.join(directory,'approved-launcher'),path.join(directory,'approved-service'),path.join(directory,'approved-helper-service'));
    if(target.fingerprint!==approved.fingerprint||['version','source_revision','build_id','state_schema','artifact_sha256','arch'].some(key=>target[key]!==request.target[key]))fail('recovery_target_snapshot_changed');
    const current=this.currentPath();
    if(current!==request.previous_path&&current!==targetPath)fail('recovery_unknown_current');
    this.assertOrdinaryService();
  }
  async recover(input) {
    if(this.recovering)fail('recovery_guard_busy');
    this.recovering=true;
    try{return await this.recoverTransaction(input);}finally{this.recovering=false;}
  }
  async recoverTransaction(input) {
    const {request,state}=this.validateRecovery(input),id=input.operation_id,directory=this.opDir(id);
    const approval=digest(JSON.stringify({operation_id:id,expected_agent_id:input.expected_agent_id,expected_fingerprint:input.expected_fingerprint,expected_runtime_mode:input.expected_runtime_mode,expected_permission_generation:input.expected_permission_generation,expected_target:input.expected_target}));
    this.hardDeadline=this.elapsed()+540000;
    this.phase(this.elapsed()+120000,'recovery_verification_timeout');
    let acquired=false,started=false;
    try {
      this.assertWorkerStopped(id);
      let journal;
      try{journal=boundedJSON(this.checkManaged(path.join(directory,'recovery.json')),8192);}catch(error){if(!absent(error))throw error;}
      if(journal){
        if(journal.schema!==1||journal.approval!==approval||!['archive_preparing','restore_previous'].includes(journal.action))fail('recovery_approval_changed');
        if(journal.status==='succeeded'){
          if(!['failed','rolled_back'].includes(state.status))fail('recovery_receipt_changed');
          const recovery={schema:1,status:'succeeded',action:journal.action,source_status:journal.source_status,recovered_at:journal.recovered_at};
          return state.recovery?state:this.save(id,{recovery});
        }
        if((journal.action==='archive_preparing'&&state.status==='failed'&&state.error_code==='worker_interrupted_before_switch')||(journal.action==='restore_previous'&&state.status==='rolled_back'&&state.restored_fingerprint===request.expected_fingerprint)){
          this.verifyOriginalHealth(request);
          if(fs.existsSync(this.lock)&&!this.ownsLock(id))fail('recovery_other_lifecycle_owner');
          if(this.ownsLock(id))this.unlock(id);
          const recovery={schema:1,status:'succeeded',action:journal.action,source_status:journal.source_status,recovered_at:journal.recovered_at};
          this.atomic(path.join(directory,'recovery.json'),{...journal,status:'succeeded'});
          return this.save(id,{recovery});
        }
        fail('recovery_interrupted');
      }
      if(!['accepted','preparing','switching','waiting_confirmation','rollback_failed'].includes(state.status))fail('recovery_not_required');
      if(fs.existsSync(this.lock)&&!this.ownsLock(id))fail('recovery_other_lifecycle_owner');
      if(!fs.existsSync(this.lock)){fs.mkdirSync(this.lock,{mode:0o700});acquired=true;this.atomic(path.join(this.lock,'owner.json'),{operation_id:id});}
      if(!this.ownsLock(id))fail('recovery_other_lifecycle_owner');
      const fresh=this.validateRecovery(input);if(fresh.state.status!==state.status)fail('recovery_receipt_changed');
      this.assertWorkerStopped(id);
      const preparing=['accepted','preparing'].includes(state.status);
      if(preparing)this.verifyOriginalHealth(request);else this.validateRecoverySnapshots(id,request);
      if(this.hasOperation())fail('recovery_operation_conflict');
      // Fence any delayed worker before the second liveness check. Never erase
      // an existing (even partial) worker claim or replay that worker.
      try{this.writeOnce(path.join(directory,'worker-claim.json'),{schema:1,operation_id:id,recovery_fence:true,claimed_at:this.timestamp()});}catch(error){if(error?.code!=='EEXIST')throw error;this.checkManaged(path.join(directory,'worker-claim.json'));}
      this.assertWorkerStopped(id);
      this.validateRecovery(input);
      if(this.hasOperation())fail('recovery_operation_conflict');
      const recovery={schema:1,status:'succeeded',action:preparing?'archive_preparing':'restore_previous',source_status:state.status,recovered_at:this.timestamp()};
      const original=path.join(directory,'status-before-recovery.json');
      try{this.writeOnce(original,fs.readFileSync(this.checkManaged(path.join(directory,'status.json'))));}catch(error){if(error?.code!=='EEXIST')throw error;this.checkManaged(original);}
      try{this.writeOnce(path.join(directory,'recovery.json'),{...recovery,status:'started',approval});started=true;}catch(error){if(error?.code==='EEXIST')fail('recovery_guard_busy');throw error;}
      if(!this.ownsLock(id))fail('recovery_other_lifecycle_owner');
      let result;
      if(preparing){result=this.save(id,{status:'failed',error_code:'worker_interrupted_before_switch',finished_at:this.timestamp(),recovery});this.unlock(id);}
      else{result=await this.restore(id,'worker_interrupted_after_switch',{preserveArtifacts:true});result=this.save(id,{recovery});}
      this.atomic(path.join(directory,'recovery.json'),{...recovery,approval});
      return result;
    } finally {if(acquired&&!started&&this.ownsLock(id))this.unlock(id);this.phaseDeadline=null;this.hardDeadline=null;}
  }
  commit(request) {
    const state = this.state(request.operation_id);
    if (state.status === "succeeded") return state;
    if (state.status !== "waiting_confirmation" || !this.ownsLock(request.operation_id) || !/^[a-f0-9-]{36}$/.test(request.expected_boot_id ?? "") || !SHA.test(request.expected_target_sha256 ?? "")) fail("invalid_commit");
    const plan = this.request(request.operation_id), health = this.health(plan);
    if (request.expected_boot_id !== health.boot_id || health.boot_id === state.from.boot_id || request.expected_target_sha256 !== state.target.artifact_sha256 || !this.healthy(health) || this.now() >= Date.parse(state.confirmation_deadline)) fail("commit_health_changed");
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
    if (command === "worker" && args.length === 2 && OP.test(args[1])) { await maintenance.worker(args[1], { handleSignals: true }); return; }
    let bytes = ""; for await (const chunk of input) { bytes += chunk; if (Buffer.byteLength(bytes) > 32768) fail("invalid_request"); }
    const request = bytes.trim() ? JSON.parse(bytes) : {};
    if(command==='recover'&&(args.length!==3||args[1]!=='--operation'||args[2]!==request.operation_id||!OP.test(args[2]??'')))fail('invalid_recovery_request');
    let result;
    if (command === "probe") result = maintenance.probe();
    else if (command === "start") result = await maintenance.start(request);
    else if (command === "status") result = maintenance.state(request.operation_id);
    else if (command === "commit") result = maintenance.commit(request);
    else if (command === "rollback") result = maintenance.rollback(request);
    else if (command === "recover") result = await maintenance.recover(request);
    else fail("invalid_command");
    output(JSON.stringify(result) + "\n");
  } catch (error) { output(JSON.stringify({ error_code: safeCode(error) }) + "\n"); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  await maintenanceCLI(process.argv.slice(2), process.stdin, value => process.stdout.write(value));
