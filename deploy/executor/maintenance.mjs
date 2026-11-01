#!/usr/bin/env node
/** Root executor maintenance. Deliberately uses only Node builtins: application
 * code and the launcher may be the interrupted part of an installation. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/, BUILD = /^[A-Za-z0-9._-]{1,128}$/;
const OP = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RELEASE_KEYS = ["version", "build_id", "source_revision", "artifact_sha256", "state_schema", "arch", "fingerprint"];
const IDENTITY_KEYS = ["executor_id", "machine_id", "agent_id", "center_instance_id", "install_generation", "public_key_sha256"];
// Standalone copy of the v1 runtime contract; a test prevents schema drift.
export const JOURNAL_COLUMNS = {
  metadata: ["key", "value"],
  jobs: ["job_id", "digest", "grant_id", "lease_id", "state", "plan_json", "payload_json", "unit", "nonce", "permit_id", "result_json"],
  consumed_grants: ["grant_id", "job_id", "digest"], requests: ["slot", "id", "digest"], resources: ["resource_id", "value_json"],
};
const UNIT = "lightmoni-executor.service";
const COMMAND_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
const LAUNCHER = '#!/bin/sh\nset -eu\nexec /opt/lightmoni-executor/current/node /opt/lightmoni-executor/current/app/runtime/dist/privileged-executor/main.js "$@"\n';
const SERVICE = `[Unit]\nDescription=LightMoni Privileged Executor\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nExecStart=/usr/local/bin/lightmoni-executor run --config /etc/lightmoni-executor/config.json\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=25s\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/etc/lightmoni-executor /var/lib/lightmoni-executor\nPrivateTmp=true\nLimitCORE=0\nTasksMax=512\n\n[Install]\nWantedBy=multi-user.target\n`;
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const safeCode = error => typeof error?.safeCode === "string" ? error.safeCode : "executor_maintenance_failed";
const missing = error => error?.code === "ENOENT";
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const same = (a, b, keys) => keys.every(key => a?.[key] === b?.[key]);

/** Overrides exist only for isolated tests; CLI paths, uid and commands are fixed. */
export class ExecutorMaintenance {
  constructor(options = {}) {
    this.root = options.root ?? "/";
    this.uid = options.uid ?? 0;
    this.arch = options.arch ?? (process.arch === "x64" ? "amd64" : process.arch);
    this.now = options.now ?? (() => Date.now());
    this.command = options.command ?? ((file, args) => execFileSync(file, args, { env: COMMAND_ENV, encoding: "utf8", timeout: 30000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }).trim());
    this.writer = options.writer ?? (work => this.withWriter(work));
  }
  p(value) { return path.join(this.root, value); }
  get base() { return this.p("/opt/lightmoni-executor"); }
  get unit() { return this.p("/etc/systemd/system/" + UNIT); }
  get launcher() { return this.p("/usr/local/bin/lightmoni-executor"); }
  get uninstaller() { return this.p("/usr/local/sbin/lightmoni-executor-uninstall"); }
  get releaseState() { return path.join(this.base, "release-state.json"); }
  get installState() { return path.join(this.base, "install-state.json"); }
  timestamp() { return new Date(this.now()).toISOString(); }
  exists(filename) { try { fs.lstatSync(filename); return true; } catch (error) { if (missing(error)) return false; throw error; } }
  safe(filename, kind = "file", secret = false) {
    const stop = path.resolve(this.root), absolute = path.resolve(filename), relative = path.relative(stop, absolute);
    if (absolute !== filename || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) fail("executor_unsafe_path");
    for (let cursor = absolute;; cursor = path.dirname(cursor)) {
      const s = fs.lstatSync(cursor);
      if (s.isSymbolicLink() || s.uid !== this.uid || s.mode & 0o022) fail("executor_unsafe_root_path");
      if (cursor === absolute && (kind === "file" ? !s.isFile() : !s.isDirectory()) || cursor === absolute && secret && s.mode & 0o077) fail("executor_unsafe_root_path");
      if (cursor === stop) break;
    }
    return absolute;
  }
  json(filename, secret = false) {
    this.safe(filename, "file", secret);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const s = fs.fstatSync(fd); if (s.size > 65536 || s.uid !== this.uid || !s.isFile() || s.mode & 0o022 || secret && s.mode & 0o077) fail("executor_unsafe_file"); return JSON.parse(fs.readFileSync(fd, "utf8")); }
    finally { fs.closeSync(fd); }
  }
  syncDirectory(directory) { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  syncTree(filename) {
    const info = fs.lstatSync(filename);
    if (info.isDirectory()) { for (const name of fs.readdirSync(filename)) this.syncTree(path.join(filename, name)); this.syncDirectory(filename); }
    else if (info.isFile()) { const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
  atomic(filename, value, mode = 0o600) {
    this.safe(path.dirname(filename), "directory");
    if (this.exists(filename)) this.safe(filename);
    const temporary = filename + ".new-" + randomUUID();
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
      fs.fchmodSync(fd, mode); fs.writeFileSync(fd, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, filename); this.syncDirectory(path.dirname(filename));
    } finally { if (fd !== undefined) fs.closeSync(fd); if (this.exists(temporary)) fs.unlinkSync(temporary); }
  }
  identityStatus() {
    const config = this.json(this.p("/etc/lightmoni-executor/config.json"), true);
    if (config.version !== 1 || !IDENTITY_KEYS.slice(0, 4).every(key => ID.test(config[key] ?? "")) || !Number.isSafeInteger(config.install_generation) || config.install_generation < 1 || config.data_dir !== "/var/lib/lightmoni-executor" || !SHA.test(config.output_key ?? "")) fail("executor_invalid_identity");
    const key = createPrivateKey(config.private_key);
    if (key.asymmetricKeyType !== "ed25519") fail("executor_invalid_identity");
    const public_key_sha256 = digest(createPublicKey(key).export({ type: "spki", format: "pem" }));
    const data = this.safe(this.p(config.data_dir), "directory", true);
    for (const file of ["journal.sqlite", "journal.sqlite-wal", "journal.sqlite-shm", "writer.lock"]) if (this.exists(path.join(data, file))) this.safe(path.join(data, file), "file", true);
    const filename = this.safe(path.join(data, "journal.sqlite"), "file", true);
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      for (const [table, required] of Object.entries(JOURNAL_COLUMNS)) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail("executor_journal_corrupt");
        const present = new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map(row => row.name));
        if (required.some(column => !present.has(column))) fail("executor_journal_corrupt");
      }
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value !== "1" || db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()?.value !== "1") fail("executor_journal_corrupt");
      const policy_generation = Number(db.prepare("SELECT value FROM metadata WHERE key='policy_generation'").get()?.value);
      if (!Number.isSafeInteger(policy_generation) || policy_generation < 1 || !Number.isSafeInteger(config.local_policy?.generation) || config.local_policy.generation < 1 || config.local_policy.generation > policy_generation) fail("executor_journal_corrupt");
      const fenced = db.prepare("SELECT job_id,state FROM jobs WHERE state IN ('prepared','intent','running','unknown') AND NOT EXISTS (SELECT 1 FROM metadata WHERE key='released:'||jobs.job_id)").get() ?? null;
      const pending_results = Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE state IN ('succeeded','failed','unknown') AND NOT EXISTS (SELECT 1 FROM metadata WHERE key='reported:'||jobs.job_id)").get()?.n);
      if (!Number.isSafeInteger(pending_results) || pending_results < 0) fail("executor_journal_corrupt");
      return { ...pick(config, IDENTITY_KEYS.slice(0, 5)), public_key_sha256, policy_generation, fenced, pending_results };
    } finally { db.close(); }
  }
  tree(directory, artifact) {
    this.safe(directory, "directory");
    const hash = createHash("sha256"); let count = 0;
    const walk = filename => {
      const stat = fs.lstatSync(filename), relative = path.relative(directory, filename);
      if (++count > 100000 || stat.uid !== this.uid || !stat.isSymbolicLink() && stat.mode & 0o022) fail("executor_unsafe_release");
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(filename), real = fs.realpathSync(filename);
        if (path.isAbsolute(link) || !(real.startsWith(directory + path.sep))) fail("executor_unsafe_release_link");
        hash.update(JSON.stringify([relative, "link", link]) + "\n");
      } else if (stat.isDirectory()) {
        hash.update(JSON.stringify([relative, "directory", stat.mode & 0o777]) + "\n");
        for (const name of fs.readdirSync(filename).sort()) walk(path.join(filename, name));
      } else if (stat.isFile()) { hash.update(JSON.stringify([relative, "file", stat.mode & 0o777, stat.size]) + "\n"); hash.update(fs.readFileSync(filename)); hash.update("\n"); }
      else fail("executor_unsafe_release");
    };
    walk(directory);
    const manifest = this.json(path.join(directory, "release.json"));
    if (!BUILD.test(manifest.version ?? "") || !BUILD.test(manifest.build_id ?? "") || [".", ".."].includes(manifest.build_id) || !/^[a-f0-9]{40}$/.test(manifest.source_revision ?? "") || manifest.state_schema !== 1 || manifest.platform !== "linux" || manifest.arch !== this.arch || !["amd64", "arm64"].includes(manifest.arch)) fail("executor_unsupported_release");
    for (const name of ["node", "app/runtime/dist/privileged-executor/main.js", "executor/launcher.sh", "executor/lightmoni-executor.service", "executor/maintenance.mjs", "executor/uninstall.sh"]) this.safe(path.join(directory, name));
    if (fs.readFileSync(path.join(directory, "executor/launcher.sh"), "utf8") !== LAUNCHER || fs.readFileSync(path.join(directory, "executor/lightmoni-executor.service"), "utf8") !== SERVICE) fail("executor_unmanaged_service");
    if (!(fs.statSync(path.join(directory, "node")).mode & 0o111)) fail("executor_runtime_not_executable");
    if (manifest.node_binary_sha256 !== undefined && (!SHA.test(manifest.node_binary_sha256) || manifest.node_binary_sha256 !== digest(fs.readFileSync(path.join(directory, "node"))))) fail("executor_runtime_checksum_mismatch");
    const receipt = this.json(path.join(directory, "installation.json"));
    if (receipt.schema !== 1 || Object.keys(receipt).sort().join(",") !== "artifact_sha256,schema" || !SHA.test(receipt.artifact_sha256 ?? "") || artifact !== undefined && artifact !== receipt.artifact_sha256) fail("executor_invalid_release_receipt");
    return { version: manifest.version, build_id: manifest.build_id, source_revision: manifest.source_revision, artifact_sha256: receipt.artifact_sha256, state_schema: 1, arch: manifest.arch, fingerprint: hash.digest("hex") };
  }
  release(record) {
    if (!record || typeof record.release_dir !== "string" || path.dirname(record.release_dir) !== path.join(this.base, "releases") || path.basename(record.release_dir) !== record.build_id) fail("executor_invalid_release_receipt");
    const actual = this.tree(record.release_dir);
    if (!same(record, actual, RELEASE_KEYS)) fail("executor_release_changed");
    return actual;
  }
  retained() {
    const state = this.json(this.releaseState, true);
    if (state.schema !== 1 || state.maintenance_protocol !== 1) fail("executor_invalid_release_receipt");
    this.release(state.current); if (state.previous !== null) this.release(state.previous);
    return state;
  }
  currentMatches(record) {
    const filename = path.join(this.base, "current"), info = fs.lstatSync(filename);
    if (!info.isSymbolicLink() || info.uid !== this.uid || fs.realpathSync(filename) !== record.release_dir) fail("executor_program_changed");
    for (const [name, expected] of [[this.launcher, LAUNCHER], [this.unit, SERVICE]]) if (fs.readFileSync(this.safe(name), "utf8") !== expected) fail("executor_unmanaged_service");
    if (!fs.readFileSync(this.safe(this.uninstaller)).equals(fs.readFileSync(this.safe(path.join(record.release_dir, "executor/uninstall.sh")))) || !(fs.statSync(this.launcher).mode & 0o111) || !(fs.statSync(this.uninstaller).mode & 0o111)) fail("executor_program_changed");
  }
  system(property) { return this.command("/usr/bin/systemctl", ["show", UNIT, "--property=" + property, "--value"]); }
  managedUnit(repair = false) {
    for (const name of ["/etc/systemd/system/" + UNIT + ".d", "/run/systemd/system/" + UNIT, "/run/systemd/system/" + UNIT + ".d"]) if (this.exists(this.p(name))) fail("executor_unmanaged_service");
    if (this.exists(this.unit)) { if (fs.readFileSync(this.safe(this.unit), "utf8") !== SERVICE) fail("executor_unmanaged_service"); }
    else if (!repair) fail("executor_unmanaged_service");
    const fragment = this.system("FragmentPath"), dropins = this.system("DropInPaths");
    if (dropins !== "" || fragment !== this.unit && !(repair && fragment === "" && !this.exists(this.unit))) fail("executor_unmanaged_service");
    const active = this.system("ActiveState");
    if (!["active", "inactive", "failed"].includes(active)) fail("executor_unmanaged_service");
    return active === "active";
  }
  installation() {
    const state = this.json(this.installState, true);
    if (state.schema !== 1 || state.maintenance_protocol !== 1 || !OP.test(state.activation_id ?? "") || !BUILD.test(state.release_name ?? "") || [".", ".."].includes(state.release_name) || state.release_name !== state.release?.build_id || !["enrollment_pending", "program", "unit", "start", "ready"].includes(state.phase)) fail("executor_invalid_install_phase");
    return state;
  }
  interruptedEvidence(status, retained, installation) {
    return ["program", "unit", "start"].includes(installation.phase) && same(installation.identity, status, IDENTITY_KEYS) && [installation.release, installation.source].some(value => value && same(value, retained.current, RELEASE_KEYS) && value.release_dir === retained.current.release_dir);
  }
  repairEvidence(status, retained, installation) {
    return this.interruptedEvidence(status, retained, installation) && !status.fenced && status.pending_results === 0;
  }
  observedRelease(retained, installation) {
    // During a recorded switch both programs are durable root evidence. Inspect
    // the actual link; a missing link is repairable only from that same receipt.
    const candidates = [retained.current];
    if (["program", "unit", "start"].includes(installation.phase)) for (const value of [installation.release, installation.source]) if (value) { this.release(value); candidates.push(value); }
    const filename = path.join(this.base, "current");
    if (!this.exists(filename)) return candidates.find(value => value.release_dir === installation.release?.release_dir) ?? retained.current;
    const info = fs.lstatSync(filename); if (!info.isSymbolicLink() || info.uid !== this.uid) fail("executor_program_changed");
    const destination = fs.realpathSync(filename), found = candidates.find(value => value.release_dir === destination);
    if (!found) fail("executor_program_changed"); return found;
  }
  probe() {
    const status = this.identityStatus(), retained = this.retained(), installation = this.installation();
    const observed = this.observedRelease(retained, installation);
    retained.current = observed;
    const interrupted = this.interruptedEvidence(status, retained, installation), repairable = this.repairEvidence(status, retained, installation);
    const service_active = this.managedUnit(interrupted);
    if (!interrupted) this.currentMatches(retained.current);
    else { // Existing program links/files still must have root-only safe parents.
      this.safe(path.dirname(this.launcher), "directory"); this.safe(path.dirname(this.unit), "directory"); this.safe(path.dirname(this.uninstaller), "directory");
      if (this.exists(this.launcher)) this.safe(this.launcher);
      if (this.exists(this.uninstaller)) this.safe(this.uninstaller);
      if (this.exists(path.join(this.base, "current"))) { const link = fs.lstatSync(path.join(this.base, "current")); if (!link.isSymbolicLink() || link.uid !== this.uid) fail("executor_program_changed"); }
    }
    return { schema: 1, ...status, service_active, current: pick(retained.current, RELEASE_KEYS), previous: retained.previous ? pick(retained.previous, RELEASE_KEYS) : null, repairable, phase: installation.phase, activation_id: installation.activation_id };
  }
  opFile(id) { if (!OP.test(id ?? "")) fail("executor_invalid_operation"); return path.join(this.base, "maintenance", id + ".json"); }
  status(request) {
    const filename = this.opFile(request?.operation_id);
    if (!this.exists(filename)) return { receipt: null, observation: this.probe() };
    const receipt = this.json(filename, true);
    if (receipt.schema !== 1 || receipt.operation_id !== request.operation_id || receipt.activation_id !== request.operation_id || !["intent", "switching", "started", "unknown"].includes(receipt.status)) fail("executor_invalid_maintenance_receipt");
    return { receipt, observation: this.probe() };
  }
  validate(request) {
    if (!request || !OP.test(request.operation_id ?? "") || !["upgrade", "rollback", "repair"].includes(request.action) || !IDENTITY_KEYS.slice(0, 4).every(key => ID.test(request[key] ?? "")) || !SHA.test(request.public_key_sha256 ?? "") || !Number.isSafeInteger(request.install_generation) || request.install_generation < 1 || !SHA.test(request.expected_fingerprint ?? "") || !Number.isSafeInteger(request.expected_policy_generation) || request.expected_policy_generation < 1) fail("executor_invalid_request");
    const target = request.target;
    if (!target || !BUILD.test(target.version ?? "") || !BUILD.test(target.build_id ?? "") || [".", ".."].includes(target.build_id) || !/^[a-f0-9]{40}$/.test(target.source_revision ?? "") || !SHA.test(target.artifact_sha256 ?? "") || target.state_schema !== 1 || target.arch !== this.arch || ["rollback", "repair"].includes(request.action) && !SHA.test(target.fingerprint ?? "")) fail("executor_invalid_target");
    this.deadline(request);
  }
  deadline(request) { if (typeof request.start_deadline !== "string" || !Number.isFinite(Date.parse(request.start_deadline)) || Date.parse(request.start_deadline) <= this.now() || Date.parse(request.start_deadline) > this.now() + 300000) fail("executor_start_deadline_expired"); }
  expect(status, request) {
    if (!same(status, request, IDENTITY_KEYS) || status.policy_generation !== request.expected_policy_generation) fail("executor_identity_or_policy_changed");
    if (status.fenced || status.pending_results !== 0) fail("executor_journal_not_clean");
  }
  async withWriter(work) {
    const filename = this.p("/var/lib/lightmoni-executor/writer.lock"); this.safe(path.dirname(filename), "directory", true);
    if (this.exists(filename)) this.safe(filename, "file", true);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    let child, finished;
    try {
      const actual = fs.fstatSync(fd), named = fs.lstatSync(this.safe(filename, "file", true));
      if (actual.dev !== named.dev || actual.ino !== named.ino || actual.uid !== this.uid || actual.mode & 0o077) fail("executor_writer_lock_changed");
      child = spawn("/bin/sh", ["-c", '/usr/bin/flock -n 7 || exit 73; printf "locked\\n"; /usr/bin/cat >/dev/null'], { env: COMMAND_ENV, stdio: ["pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", fd] });
      finished = new Promise(resolve => child.once("close", resolve)); child.stdin.on("error", () => {});
      await new Promise((resolve, reject) => { let text = ""; child.once("error", reject); child.once("exit", () => reject(Object.assign(new Error(), { safeCode: "executor_writer_busy" }))); child.stdout.on("data", value => { text += value; if (text === "locked\n") resolve(); else if (text.length > 32) reject(new Error()); }); });
      return await work();
    } finally { if (child) { child.stdin.end(); await finished; } fs.closeSync(fd); }
  }
  extract(archive, destination) {
    let input; try { input = gunzipSync(archive, { maxOutputLength: 768 << 20 }); } catch { fail("executor_invalid_archive"); }
    const entries = [], names = new Map(); let offset = 0, extended = {}, global = {}, longName = "", longLink = "", ended = false;
    const string = bytes => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString("utf8");
    const octal = bytes => { const text = string(bytes).trim(); if (!/^[0-7]*$/.test(text)) fail("executor_invalid_archive"); return text ? parseInt(text, 8) : 0; };
    while (offset + 512 <= input.length) {
      const header = input.subarray(offset, offset + 512); offset += 512;
      if (header.every(byte => byte === 0)) { ended = true; if (input.subarray(offset).some(byte => byte !== 0)) fail("executor_invalid_archive"); break; }
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (octal(header.subarray(148, 156)) !== sum) fail("executor_invalid_archive");
      const size = octal(header.subarray(124, 136));
      if (!Number.isSafeInteger(size) || size < 0 || offset + Math.ceil(size / 512) * 512 > input.length) fail("executor_invalid_archive");
      const body = input.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156] || 48);
      if (["x", "g"].includes(type)) {
        const pax = {}; let cursor = 0;
        while (cursor < body.length) { const space = body.indexOf(32, cursor), length = Number(body.subarray(cursor, space).toString()); if (space < 0 || !Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > body.length || body[cursor + length - 1] !== 10) fail("executor_invalid_archive"); const item = body.subarray(space + 1, cursor + length - 1).toString(), equal = item.indexOf("="); if (equal < 1) fail("executor_invalid_archive"); pax[item.slice(0, equal)] = item.slice(equal + 1); cursor += length; }
        if (type === "g") global = { ...global, ...pax }; else extended = pax; continue;
      }
      if (["L", "K"].includes(type)) { if (size > 4096) fail("executor_invalid_archive"); if (type === "L") longName = string(body); else longLink = string(body); continue; }
      const attrs = { ...global, ...extended }; extended = {};
      const prefix = string(header.subarray(345, 500)), raw = attrs.path ?? (longName || (prefix ? prefix + "/" : "") + string(header.subarray(0, 100))), link = attrs.linkpath ?? (longLink || string(header.subarray(157, 257))); longName = ""; longLink = "";
      const name = raw.replace(/\/$/, "");
      if (!name || name.length > 4096 || name.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(name) || name.split("/").some(part => !part || part === "." || part === "..") || !["lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-runtime"].includes(name.split("/")[0])) fail("executor_unsafe_archive_path");
      if (!["0", "5", "2"].includes(type) || attrs.size !== undefined && Number(attrs.size) !== size) fail("executor_unsupported_archive_entry");
      if (names.has(name)) fail("executor_duplicate_archive_path"); names.set(name, type);
      if (type === "2") { const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link)); if (!link || path.posix.isAbsolute(link) || /[\\\x00-\x1f\x7f]/.test(link) || !target.startsWith("lightmoni-agent-runtime/")) fail("executor_unsafe_archive_link"); }
      entries.push({ name, link, type, body, mode: octal(header.subarray(100, 108)) }); if (entries.length > 100000) fail("executor_archive_too_large");
    }
    if (!ended || Object.keys(extended).length || longName || longLink) fail("executor_invalid_archive");
    for (const entry of entries) for (let parent = path.posix.dirname(entry.name); parent !== "."; parent = path.posix.dirname(parent)) if (names.has(parent) && names.get(parent) !== "5") fail("executor_unsafe_archive_path");
    // Nothing touches disk before all headers, parents and links are validated.
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const entry of entries.filter(value => value.type !== "2")) { const filename = path.join(destination, entry.name); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o755 }); if (entry.type === "5") fs.mkdirSync(filename, { recursive: true, mode: 0o755 }); else { const mode = entry.mode & 0o111 ? 0o755 : 0o644; fs.writeFileSync(filename, entry.body, { flag: "wx", mode }); fs.chmodSync(filename, mode); } }
    // The production shell uses umask 077. Canonical release modes must match
    // installation and retained releases regardless of the caller's umask.
    // Normalize directories before creating links, without following symlinks;
    // the private unpacked parent itself remains 0700.
    const normalizeDirectories = directory => { for (const name of fs.readdirSync(directory)) { const child = path.join(directory, name); if (fs.lstatSync(child).isDirectory()) { fs.chmodSync(child, 0o755); normalizeDirectories(child); } } };
    normalizeDirectories(destination);
    for (const entry of entries.filter(value => value.type === "2")) fs.symlinkSync(entry.link, path.join(destination, entry.name));
    return path.join(destination, "lightmoni-agent-runtime");
  }
  prepare(request) {
    const archivePath = request.archive_path, run = this.p("/run") + path.sep;
    if (typeof archivePath !== "string" || path.dirname(path.dirname(archivePath)) + path.sep !== run || !/^lightmoni-executor-maintenance\.[A-Za-z0-9_-]{4,128}$/.test(path.basename(path.dirname(archivePath))) || path.basename(archivePath) !== "bundle.tar.gz") fail("executor_unsafe_archive_path");
    const info = fs.statSync(this.safe(archivePath)); if (info.size < 1024 || info.size > 256 << 20) fail("executor_invalid_archive");
    const archive = fs.readFileSync(archivePath); if (digest(archive) !== request.target.artifact_sha256) fail("executor_archive_checksum_mismatch");
    const staging = this.extract(archive, path.join(path.dirname(archivePath), "unpacked"));
    if (this.exists(path.join(staging, "installation.json"))) fail("executor_archive_contains_installation_receipt");
    this.atomic(path.join(staging, "installation.json"), { schema: 1, artifact_sha256: request.target.artifact_sha256 }, 0o644);
    const release = this.tree(staging, request.target.artifact_sha256);
    if (!same(release, request.target, RELEASE_KEYS.filter(key => key !== "fingerprint"))) fail("executor_target_changed");
    return { ...release, release_dir: staging };
  }
  switchCurrent(release) {
    const filename = path.join(this.base, "current"), temporary = filename + ".new-" + randomUUID();
    if (this.exists(filename)) { const old = fs.lstatSync(filename); if (!old.isSymbolicLink() || old.uid !== this.uid) fail("executor_program_changed"); }
    fs.symlinkSync(release.release_dir, temporary); fs.renameSync(temporary, filename); this.syncDirectory(this.base);
    this.atomic(this.launcher, LAUNCHER, 0o755); this.atomic(this.unit, SERVICE, 0o644);
    this.atomic(this.uninstaller, fs.readFileSync(this.safe(path.join(release.release_dir, "executor/uninstall.sh"))), 0o755);
  }
  copyRelease(source, destination) {
    this.safe(source, "directory"); this.safe(path.dirname(destination), "directory");
    fs.cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    // Linux cpSync creates directories through the caller's umask. Restore
    // modes from the already checked source before fsync and fingerprinting;
    // never chmod through a link or normalize an unsafe writable destination.
    const restore = (from, to) => {
      const expected = fs.lstatSync(from), actual = fs.lstatSync(to);
      if (expected.uid !== this.uid || actual.uid !== this.uid) fail("executor_copy_changed");
      if (expected.isSymbolicLink()) {
        if (!actual.isSymbolicLink() || fs.readlinkSync(from) !== fs.readlinkSync(to)) fail("executor_copy_changed");
        return;
      }
      if (expected.mode & 0o022 || actual.mode & 0o022 || actual.isSymbolicLink()
        || expected.isDirectory() !== actual.isDirectory() || expected.isFile() !== actual.isFile()
        || !expected.isDirectory() && !expected.isFile()) fail("executor_copy_changed");
      const fd = fs.openSync(to, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (expected.isDirectory() ? fs.constants.O_DIRECTORY : 0));
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== actual.dev || opened.ino !== actual.ino || opened.uid !== this.uid || opened.mode & 0o022) fail("executor_copy_changed");
        fs.fchmodSync(fd, expected.mode & 0o777);
      } finally { fs.closeSync(fd); }
      if (expected.isDirectory()) {
        const names = fs.readdirSync(from).sort();
        if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(to).sort())) fail("executor_copy_changed");
        for (const name of names) restore(path.join(from, name), path.join(to, name));
      }
    };
    restore(source, destination);
  }
  async apply(request) {
    this.validate(request);
    const filename = this.opFile(request.operation_id); if (this.exists(filename)) fail("executor_operation_already_exists");
    const before = this.probe(); this.expect(before, request);
    if (before.current.fingerprint !== request.expected_fingerprint) fail("executor_source_changed");
    if (request.action === "repair" && !before.repairable) fail("executor_not_repairable");
    const retained = this.retained(), installation = this.installation(), recordedCurrent = retained.current; let target;
    if (request.action === "repair") retained.current = this.observedRelease(retained, installation);
    if (request.action === "upgrade") target = this.prepare(request);
    else { target = request.action === "rollback" ? retained.previous : retained.current; if (!target || !same(target, request.target, RELEASE_KEYS)) fail("executor_target_changed"); this.release(target); }
    const operations = path.dirname(filename); if (!this.exists(operations)) { fs.mkdirSync(operations, { mode: 0o700 }); this.syncDirectory(this.base); } this.safe(operations, "directory", true);
    let receipt = { schema: 1, operation_id: request.operation_id, activation_id: request.operation_id, action: request.action, ...pick(before, IDENTITY_KEYS), policy_generation: before.policy_generation, status: "intent", source: before.current, target: pick(target, RELEASE_KEYS), started_at: this.timestamp(), updated_at: this.timestamp() };
    const save = update => { receipt = { ...receipt, ...update, updated_at: this.timestamp() }; this.atomic(filename, receipt); };
    save({});
    try {
      this.deadline(request); this.managedUnit(request.action === "repair");
      // Record the owned source before stop: writer contention or a changed
      // policy must leave an explicit, separately reviewable repair path.
      this.atomic(this.installState, { schema: 1, maintenance_protocol: 1, phase: "start", release_name: retained.current.build_id, activation_id: installation.activation_id, identity: pick(before, IDENTITY_KEYS), release: retained.current, source: retained.current, updated_at: this.timestamp() });
      try { this.command("/usr/bin/systemctl", ["stop", UNIT]); }
      catch { if (request.action !== "repair" || this.exists(this.unit) || this.system("FragmentPath") !== "" || this.system("ActiveState") !== "inactive") fail("executor_service_not_stopped"); }
      if (this.system("ActiveState") !== "inactive") fail("executor_service_not_stopped");
      await this.writer(async () => {
        this.deadline(request); const locked = this.identityStatus(); this.expect(locked, request);
        if (!same(locked, before, IDENTITY_KEYS)) fail("executor_identity_or_policy_changed");
        const fresh = this.retained(); if (request.action === "repair") fresh.current = this.observedRelease(fresh, this.installation());
        if (!same(fresh.current, retained.current, RELEASE_KEYS) || fresh.current.release_dir !== retained.current.release_dir) fail("executor_source_changed");
        if (request.action === "repair") { if (!this.repairEvidence(locked, fresh, this.installation())) fail("executor_not_repairable"); } else this.currentMatches(fresh.current);
        if (request.action === "upgrade") { if (!same(this.tree(target.release_dir), target, RELEASE_KEYS)) fail("executor_target_changed"); } else this.release(target);
        // A failed copy still owns a complete source program which a separately
        // approved repair can restart. No staging directory becomes authority.
        this.atomic(this.installState, { schema: 1, maintenance_protocol: 1, phase: "start", release_name: retained.current.build_id, activation_id: request.operation_id, identity: pick(locked, IDENTITY_KEYS), release: retained.current, source: retained.current, updated_at: this.timestamp() });
        save({ status: "switching" });
        if (request.action === "upgrade") {
          const destination = path.join(this.base, "releases", target.build_id);
          if (this.exists(destination)) { if (!same(this.tree(destination), target, RELEASE_KEYS)) fail("executor_existing_release_changed"); }
          else {
            const staging = path.join(this.base, "releases", ".stage." + request.operation_id); if (this.exists(staging)) fail("executor_release_stage_exists");
            this.copyRelease(target.release_dir, staging); this.syncTree(staging);
            if (!same(this.tree(staging), target, RELEASE_KEYS)) fail("executor_target_changed");
            fs.renameSync(staging, destination); this.syncDirectory(path.dirname(destination));
          }
          const installed = this.tree(destination, target.artifact_sha256); if (!same(installed, target, RELEASE_KEYS)) fail("executor_target_changed"); target = { ...installed, release_dir: destination };
        }
        this.atomic(this.installState, { schema: 1, maintenance_protocol: 1, phase: "program", release_name: target.build_id, activation_id: request.operation_id, identity: pick(locked, IDENTITY_KEYS), release: target, source: retained.current, updated_at: this.timestamp() });
        this.switchCurrent(target);
        const previous = request.action === "repair" ? (installation.source && installation.source.fingerprint !== target.fingerprint ? installation.source : recordedCurrent.fingerprint !== target.fingerprint ? recordedCurrent : retained.previous) : retained.current;
        this.atomic(this.releaseState, { schema: 1, maintenance_protocol: 1, current: target, previous });
        this.atomic(this.installState, { schema: 1, maintenance_protocol: 1, phase: "start", release_name: target.build_id, activation_id: request.operation_id, identity: pick(locked, IDENTITY_KEYS), release: target, updated_at: this.timestamp() });
      });
      // The service's own writer must be able to acquire its lock during start.
      this.command("/usr/bin/systemctl", ["daemon-reload"]); this.command("/usr/bin/systemctl", ["enable", UNIT]); this.command("/usr/bin/systemctl", ["start", UNIT]);
      if (this.system("ActiveState") !== "active") fail("executor_service_not_active");
      const after = this.probe(); if (!same(after, before, IDENTITY_KEYS) || after.current.fingerprint !== target.fingerprint || after.activation_id !== request.operation_id || after.policy_generation !== before.policy_generation || after.fenced || after.pending_results) fail("executor_post_start_changed");
      this.atomic(this.installState, { schema: 1, maintenance_protocol: 1, phase: "ready", release_name: target.build_id, activation_id: request.operation_id, identity: pick(after, IDENTITY_KEYS), release: target, updated_at: this.timestamp() });
      save({ status: "started" }); return { receipt, observation: this.probe() };
    } catch (error) { save({ status: "unknown", code: safeCode(error) }); return { receipt, observation: this.probe() }; }
  }
  recordInstallPhase(phase, directory, artifact) {
    if (!["enrollment_pending", "program", "unit", "start", "ready"].includes(phase) || !SHA.test(artifact ?? "")) fail("executor_invalid_install_phase");
    const release = { ...this.tree(directory, artifact), release_dir: directory };
    if (path.dirname(directory) !== path.join(this.base, "releases") || path.basename(directory) !== release.build_id) fail("executor_unsafe_release");
    const previous = this.exists(this.installState) ? this.installation() : null;
    if (previous && (!same(previous.release, release, RELEASE_KEYS) || previous.phase === "ready" || phase === "enrollment_pending")) fail("executor_invalid_install_phase");
    let identity = null;
    if (phase !== "enrollment_pending") { const status = this.identityStatus(); if (status.fenced || status.pending_results) fail("executor_journal_not_clean"); identity = pick(status, IDENTITY_KEYS); if (previous?.identity && !same(previous.identity, identity, IDENTITY_KEYS)) fail("executor_identity_or_policy_changed"); }
    this.syncTree(directory); this.syncDirectory(path.dirname(directory));
    this.atomic(this.releaseState, { schema: 1, maintenance_protocol: 1, current: release, previous: null });
    this.atomic(this.installState, { schema: 1, maintenance_protocol: 1, phase, release_name: release.build_id, activation_id: previous?.activation_id ?? randomUUID(), identity, release, updated_at: this.timestamp() });
  }
  assertSupervisor(self, executable, installing = false) {
    const directory = path.dirname(path.dirname(self));
    if (path.dirname(directory) !== path.join(this.base, "releases") || self !== path.join(directory, "executor/maintenance.mjs") || fs.realpathSync(executable) !== path.join(directory, "node")) fail("executor_untrusted_supervisor");
    this.safe(self); this.safe(path.join(directory, "node"));
    const actual = this.tree(directory);
    if (!installing) {
      const retained = this.retained(), installation = this.installation();
      const candidates = [retained.current];
      if (["program", "unit", "start"].includes(installation.phase)) candidates.push(installation.release, installation.source);
      if (!candidates.some(value => value?.release_dir === directory && same(value, actual, RELEASE_KEYS))) fail("executor_untrusted_supervisor");
    }
  }
  assertHostLocks() {
    for (const [kind, fd] of [["bootstrap", 8], ["lifecycle", 9]]) {
      const filename = this.safe(this.p("/run/lightmoni-executor-" + kind + ".lock")), named = fs.lstatSync(filename), opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.uid !== this.uid || opened.mode & 0o022 || opened.dev !== named.dev || opened.ino !== named.ino) fail("executor_host_lock_changed");
    }
    // Acquiring the inherited open-file descriptions is idempotent when the
    // outer shell already holds them, and keeps them held for this process.
    execFileSync("/bin/sh", ["-c", "/usr/bin/flock -n 8 && /usr/bin/flock -n 9"], { env: COMMAND_ENV, timeout: 5000, stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 8, 9] });
  }
}

async function main() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail("executor_requires_linux_root");
  const runner = new ExecutorMaintenance(), command = process.argv[2];
  const self = fileURLToPath(import.meta.url);
  if (command === "install-phase" && process.argv.length === 6) { runner.assertSupervisor(self, process.execPath, true); if (path.dirname(path.dirname(self)) !== process.argv[4]) fail("executor_untrusted_supervisor"); runner.recordInstallPhase(process.argv[3], process.argv[4], process.argv[5]); return; }
  if (!["probe", "status", "apply"].includes(command) || process.argv.length !== 3) fail("executor_invalid_command");
  runner.assertHostLocks();
  runner.assertSupervisor(self, process.execPath);
  let request;
  if (command !== "probe") { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) fail("executor_request_too_large"); chunks.push(chunk); } request = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  const result = command === "probe" ? runner.probe() : command === "status" ? runner.status(request) : await runner.apply(request);
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(safeCode(error) + "\n"); process.exitCode = 1; });
