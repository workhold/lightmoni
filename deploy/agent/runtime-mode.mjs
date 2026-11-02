#!/usr/bin/env node
/** Fixed SSH lifecycle operation. No caller-supplied paths or executable code. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildAgentService, identifyAgentService } from "./service-unit.mjs";
const fail = (code) => {
  throw Object.assign(Error(code), { safeCode: code });
};
const mode = (value) => value === "root" || value === "user";
const ID = /^[A-Za-z0-9._:-]{1,128}$/,
  OP = /^[a-f0-9-]{36}$/,
  SHA = /^[a-f0-9]{64}$/;
export class AgentRuntimeMaintenance {
  constructor(options = {}) {
    this.root = options.root ?? "/";
    this.uid = options.uid ?? 0;
    this.command =
      options.command ??
      ((file, args, input) =>
        execFileSync(file, args, {
          input,
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 1 << 20,
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
        }).trim());
    this.chown = options.chown ?? fs.chownSync;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  p(value) {
    return path.join(this.root, value);
  }
  safe(file, kind = "file") {
    let at = path.resolve(file),
      stop = path.resolve(this.root);
    if (
      !at.startsWith(stop === path.sep ? stop : stop + path.sep) &&
      at !== stop
    )
      fail("unsafe_runtime_path");
    for (;;) {
      const s = fs.lstatSync(at);
      if (
        s.isSymbolicLink() ||
        s.uid !== this.uid ||
        s.mode & 0o022 ||
        (at === file &&
          (kind === "file" ? !s.isFile() || s.nlink !== 1 : !s.isDirectory()))
      )
        fail("unsafe_runtime_path");
      if (at === stop) break;
      at = path.dirname(at);
    }
    return file;
  }
  json(file) {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1 || s.size > 65536)
      fail("invalid_runtime_file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  atomic(file, value, permissions = 0o600) {
    const tmp = file + ".new-" + randomUUID(),
      fd = fs.openSync(tmp, "wx", permissions);
    try {
      fs.writeFileSync(
        fd,
        typeof value === "string" ? value : JSON.stringify(value) + "\n",
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }
  config() {
    const c = this.json(this.safe(this.p("/etc/lightmoni-agent/config.json"))),
      m = c.runtime_mode ?? "user",
      g = c.permission_generation ?? 1;
    if (
      !mode(m) ||
      !Number.isSafeInteger(g) ||
      g < 1 ||
      c.data_dir !== "/var/lib/lightmoni-agent"
    )
      fail("invalid_runtime_config");
    return { ...c, runtime_mode: m, permission_generation: g };
  }
  installation() {
    const base = this.safe(this.p("/opt/lightmoni-agent"), "directory"),
      link = path.join(base, "current"),
      s = fs.lstatSync(link);
    if (!s.isSymbolicLink() || s.uid !== this.uid)
      fail("unmanaged_installation");
    const release = fs.realpathSync(link);
    if (path.dirname(release) !== path.join(base, "releases"))
      fail("unmanaged_installation");
    this.safe(release, "directory");
    const meta = this.json(this.safe(path.join(release, "installation.json")));
    if (meta.schema !== 1 || !SHA.test(meta.artifact_sha256))
      fail("unmanaged_installation");
    return { release, artifact_sha256: meta.artifact_sha256 };
  }
  cli(args, input) {
    return this.command(this.p("/usr/local/bin/lightmoni-agent"), args, input);
  }
  managed() {
    const f = this.p("/etc/lightmoni-agent/managed.json");
    if (!fs.existsSync(f)) {
      if (fs.existsSync(this.p("/var/lib/lightmoni-agent/managed")))
        fail("managed_configuration_missing");
      return null;
    }
    this.safe(f);
    const s = JSON.parse(this.cli(["managed-status"]));
    if (
      !ID.test(s.executor_id) ||
      !Number.isSafeInteger(s.install_generation) ||
      s.install_generation < 1 ||
      s.fenced ||
      s.pending_results !== 0
    )
      fail("managed_execution_not_idle");
    return {
      executor_id: s.executor_id,
      install_generation: s.install_generation,
      fenced: null,
      pending_results: 0,
    };
  }
  idle() {
    if (
      fs.existsSync(
        this.p("/var/lib/lightmoni-agent/operations/execution.lock"),
      )
    )
      fail("agent_execution_not_idle");
    for (const name of ["task-run-state.json", "agent-job-state.json"]) {
      const f = this.p("/var/lib/lightmoni-agent/" + name);
      if (!fs.existsSync(f)) continue;
      const v = this.json(f);
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).some((k) => k !== "id") ||
        (v.id !== undefined && v.id !== "")
      )
        fail("agent_execution_not_idle");
    }
    return this.managed();
  }
  local() {
    return JSON.parse(
      this.cli([
        "status",
        "--config",
        this.p("/etc/lightmoni-agent/config.json"),
      ]),
    );
  }
  account() {
    const uid = Number(this.command("/usr/bin/id", ["-u", "lightmoni-agent"])),
      gid = Number(this.command("/usr/bin/id", ["-g", "lightmoni-agent"]));
    if (
      !Number.isSafeInteger(uid) ||
      uid <= 0 ||
      !Number.isSafeInteger(gid) ||
      gid <= 0
    )
      fail("invalid_agent_account");
    return { uid, gid };
  }
  observe(c, agentID, previousBoot = "") {
    const s = this.local(),
      r = s.runtime,
      a = this.account();
    if (
      s.agent_id !== agentID ||
      r?.mode !== c.runtime_mode ||
      r.permission_generation !== c.permission_generation ||
      r.uid !== (c.runtime_mode === "root" ? 0 : a.uid) ||
      r.gid !== (c.runtime_mode === "root" ? 0 : a.gid) ||
      !OP.test(s.boot_id ?? "") ||
      s.boot_id === previousBoot
    )
      fail("runtime_health_unverified");
    return s;
  }
  probe() {
    const c = this.config(),
      i = this.installation(),
      identity = this.json(this.p("/var/lib/lightmoni-agent/identity.json"));
    if (!ID.test(identity.agent_id) || !ID.test(identity.host_id))
      fail("invalid_agent_identity");
    const service = this.safe(
      this.p("/etc/systemd/system/lightmoni-agent.service"),
    );
    if (identifyAgentService(fs.readFileSync(service)) !== c.runtime_mode)
      fail("runtime_service_mismatch");
    if (
      this.command("systemctl", [
        "show",
        "lightmoni-agent.service",
        "--property=DropInPaths",
        "--value",
      ])
    )
      fail("agent_service_override_not_allowed");
    if (
      this.command("systemctl", [
        "show",
        "lightmoni-agent.service",
        "--property=ActiveState",
        "--value",
      ]) !== "active"
    )
      fail("agent_service_inactive");
    const local = this.observe(c, identity.agent_id),
      managed = this.idle();
    if (c.runtime_mode === "root" ? !managed : !!managed)
      fail("runtime_execution_identity_mismatch");
    if (local.queue_batches !== 0) fail("agent_queue_not_drained");
    return {
      schema: 1,
      agent_id: identity.agent_id,
      runtime_mode: c.runtime_mode,
      permission_generation: c.permission_generation,
      artifact_sha256: i.artifact_sha256,
      managed,
      uid: local.runtime.uid,
      gid: local.runtime.gid,
      boot_id: local.boot_id,
      status: "ready",
    };
  }
  dataPath() {
    const p = this.p("/var/lib/lightmoni-agent"),
      s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail("unsafe_agent_state");
    return p;
  }
  validateState(file) {
    const s = fs.lstatSync(file);
    if (
      s.isSymbolicLink() ||
      (!s.isFile() && !s.isDirectory()) ||
      (s.isFile() && s.nlink !== 1)
    )
      fail("unsafe_agent_state");
    if (s.isDirectory())
      for (const name of fs.readdirSync(file))
        this.validateState(path.join(file, name));
  }
  async apply(input) {
    const keys = [
      "schema",
      "operation_id",
      "agent_id",
      "from_mode",
      "runtime_mode",
      "previous_generation",
      "permission_generation",
      "artifact_sha256",
      "managed_bootstrap",
      "endpoint",
    ];
    if (
      !input ||
      Object.keys(input).some((k) => !keys.includes(k)) ||
      input.schema !== 1 ||
      !OP.test(input.operation_id) ||
      !ID.test(input.agent_id) ||
      !mode(input.from_mode) ||
      !mode(input.runtime_mode) ||
      input.from_mode === input.runtime_mode ||
      !Number.isSafeInteger(input.previous_generation) ||
      input.previous_generation < 1 ||
      input.permission_generation !== input.previous_generation + 1 ||
      !SHA.test(input.artifact_sha256)
    )
      fail("invalid_runtime_request");
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.origin !== input.endpoint)
      fail("invalid_center_origin");
    if (
      input.runtime_mode === "root"
        ? !input.managed_bootstrap
        : !!input.managed_bootstrap
    )
      fail("invalid_managed_bootstrap");
    const state = this.probe();
    if (
      state.agent_id !== input.agent_id ||
      state.runtime_mode !== input.from_mode ||
      state.permission_generation !== input.previous_generation ||
      state.artifact_sha256 !== input.artifact_sha256
    )
      fail("runtime_plan_stale");
    const dir = this.p("/opt/lightmoni-agent/runtime-plans");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.safe(dir, "directory");
    const receipt = path.join(dir, input.operation_id + ".json");
    if (fs.existsSync(receipt)) fail("runtime_plan_already_applied");
    const lock = this.p("/run/lightmoni-agent-lifecycle.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    let before,
      unit,
      account,
      backup,
      dataBackup,
      operationsBefore,
      operationsChanged = false,
      stopped = false,
      mutated = false,
      restored = false,
      rollbackFailed = false,
      completed = false;
    const moved = [],
      savedManaged = [];
    let originalNames = [];
    const save = (status, error = "", details = {}) => {
      const value = {
        schema: 1,
        operation_id: input.operation_id,
        agent_id: input.agent_id,
        runtime_mode: input.runtime_mode,
        permission_generation: input.permission_generation,
        status,
        restored,
        error,
        ...details,
      };
      this.atomic(receipt, value);
      return value;
    };
    try {
      const locked = this.probe();
      if (
        locked.agent_id !== input.agent_id ||
        locked.runtime_mode !== input.from_mode ||
        locked.permission_generation !== input.previous_generation ||
        locked.artifact_sha256 !== input.artifact_sha256 ||
        locked.boot_id !== state.boot_id
      )
        fail("runtime_plan_stale");
      before = this.config();
      unit = fs.readFileSync(
        this.p("/etc/systemd/system/lightmoni-agent.service"),
      );
      account = this.account();
      backup = path.join(dir, input.operation_id);
      fs.mkdirSync(backup, { mode: 0o700 });
      const stateBase = this.p("/var/lib/lightmoni-agent-maintenance");
      try {
        fs.mkdirSync(stateBase, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      this.safe(stateBase, "directory");
      if ((fs.lstatSync(stateBase).mode & 0o777) !== 0o700)
        fail("unsafe_runtime_path");
      dataBackup = path.join(stateBase, input.operation_id);
      fs.mkdirSync(dataBackup, { mode: 0o700 });
      this.atomic(path.join(backup, "config.json"), before);
      this.atomic(path.join(backup, "service"), unit.toString());
      save("running");
      // Mark stopped before the command: a transport failure after stop must still restore service.
      stopped = true;
      this.command("systemctl", ["stop", "lightmoni-agent.service"]);
      if (
        !["inactive", "failed"].includes(
          this.command("systemctl", [
            "show",
            "lightmoni-agent.service",
            "--property=ActiveState",
            "--value",
          ]),
        )
      )
        fail("agent_stop_failed");
      this.idle();
      const data = this.dataPath(),
        identity = this.json(path.join(data, "identity.json"));
      if (identity.agent_id !== input.agent_id || !ID.test(identity.host_id))
        fail("invalid_agent_identity");
      const operations = path.join(data, "operations");
      if (fs.existsSync(operations)) {
        operationsBefore = fs.lstatSync(operations);
        if (
          !operationsBefore.isDirectory() ||
          operationsBefore.isSymbolicLink() ||
          fs.readdirSync(operations).length
        )
          fail("operations_directory_requires_reconciliation");
      }
      // Never root-open user-controlled SQLite, cached scripts/config, symlinks or hardlinks.
      const names = fs.readdirSync(data).filter((n) => n !== "operations");
      originalNames = names;
      for (const name of names) this.validateState(path.join(data, name));
      for (const name of ["managed.json", "managed-activation.json"]) {
        const f = this.p("/etc/lightmoni-agent/" + name);
        if (!fs.existsSync(f)) continue;
        this.atomic(
          path.join(backup, name),
          fs.readFileSync(this.safe(f), "utf8"),
        );
        savedManaged.push(name);
      }
      mutated = true;
      this.chown(data, this.uid, this.uid);
      fs.chmodSync(data, 0o700);
      for (const name of names) {
        fs.renameSync(path.join(data, name), path.join(dataBackup, name));
        moved.push(name);
      }
      for (const name of savedManaged)
        fs.unlinkSync(this.p("/etc/lightmoni-agent/" + name));
      const config = {
        ...before,
        endpoint: input.endpoint,
        runtime_mode: input.runtime_mode,
        permission_generation: input.permission_generation,
      };
      this.chown(
        this.p("/etc/lightmoni-agent"),
        this.uid,
        input.runtime_mode === "root" ? this.uid : account.gid,
      );
      fs.chmodSync(
        this.p("/etc/lightmoni-agent"),
        input.runtime_mode === "root" ? 0o700 : 0o750,
      );
      this.atomic(
        this.p("/etc/lightmoni-agent/config.json"),
        config,
        input.runtime_mode === "root" ? 0o600 : 0o640,
      );
      this.chown(
        this.p("/etc/lightmoni-agent/config.json"),
        this.uid,
        account.gid,
      );
      this.atomic(path.join(data, "identity.json"), {
        agent_id: input.agent_id,
        host_id: identity.host_id,
      });
      const owner =
        input.runtime_mode === "root"
          ? { uid: this.uid, gid: this.uid }
          : account;
      if (!operationsBefore) fs.mkdirSync(operations, { mode: 0o700 });
      operationsChanged = true;
      this.chown(operations, owner.uid, owner.gid);
      fs.chmodSync(operations, 0o700);
      this.chown(path.join(data, "identity.json"), owner.uid, owner.gid);
      this.chown(data, owner.uid, owner.gid);
      if (input.runtime_mode === "root")
        this.cli(["managed-enroll"], JSON.stringify(input.managed_bootstrap));
      this.atomic(
        this.p("/etc/systemd/system/lightmoni-agent.service"),
        buildAgentService(input.runtime_mode),
        0o644,
      );
      this.cli([
        "check",
        "--config",
        this.p("/etc/lightmoni-agent/config.json"),
      ]);
      this.command("systemctl", ["daemon-reload"]);
      this.command("systemctl", ["start", "lightmoni-agent.service"]);
      let observed;
      for (let n = 0; n < 15; n++) {
        try {
          observed = this.observe(config, input.agent_id, state.boot_id);
          break;
        } catch {
          await this.sleep(1000);
        }
      }
      if (!observed) fail("runtime_health_unverified");
      const result = save("succeeded", "", {
        uid: observed.runtime.uid,
        gid: observed.runtime.gid,
        boot_id: observed.boot_id,
        artifact_sha256: input.artifact_sha256,
      });
      completed = true;
      // Old signing material is never retained with diagnostic telemetry caches.
      // A committed success must never roll back because diagnostic cleanup failed.
      for (const obsolete of [path.join(dataBackup, "managed"), backup]) {
        try {
          fs.rmSync(obsolete, { recursive: true, force: true });
        } catch {
          /* Root-only maintenance evidence remains for local cleanup. */
        }
      }
      return result;
    } catch (error) {
      if (stopped)
        try {
          this.command("systemctl", ["stop", "lightmoni-agent.service"]);
          if (mutated) {
            const data = this.dataPath();
            this.chown(data, this.uid, this.uid);
            fs.chmodSync(data, 0o700);
            // Remove only newly initialized Agent state; business operations stay untouched.
            for (const name of fs.readdirSync(data))
              if (
                name !== "operations" &&
                (!originalNames.includes(name) || moved.includes(name))
              )
                fs.rmSync(path.join(data, name), {
                  recursive: true,
                  force: true,
                });
            for (const name of moved)
              if (fs.existsSync(path.join(dataBackup, name)))
                fs.renameSync(
                  path.join(dataBackup, name),
                  path.join(data, name),
                );
            for (const name of ["managed.json", "managed-activation.json"]) {
              const f = this.p("/etc/lightmoni-agent/" + name);
              fs.rmSync(f, { force: true });
              if (savedManaged.includes(name))
                this.atomic(
                  f,
                  fs.readFileSync(path.join(backup, name), "utf8"),
                );
            }
            this.chown(
              this.p("/etc/lightmoni-agent"),
              this.uid,
              before.runtime_mode === "root" ? this.uid : account.gid,
            );
            fs.chmodSync(
              this.p("/etc/lightmoni-agent"),
              before.runtime_mode === "root" ? 0o700 : 0o750,
            );
            this.atomic(
              this.p("/etc/lightmoni-agent/config.json"),
              before,
              before.runtime_mode === "root" ? 0o600 : 0o640,
            );
            this.chown(
              this.p("/etc/lightmoni-agent/config.json"),
              this.uid,
              account.gid,
            );
            this.atomic(
              this.p("/etc/systemd/system/lightmoni-agent.service"),
              unit.toString(),
              0o644,
            );
            this.chown(
              data,
              before.runtime_mode === "root" ? this.uid : account.uid,
              before.runtime_mode === "root" ? this.uid : account.gid,
            );
            if (operationsChanged) {
              const operations = path.join(data, "operations");
              if (fs.readdirSync(operations).length)
                fail("operations_directory_requires_reconciliation");
              if (operationsBefore) {
                this.chown(
                  operations,
                  operationsBefore.uid,
                  operationsBefore.gid,
                );
                fs.chmodSync(operations, operationsBefore.mode & 0o777);
              } else fs.rmdirSync(operations);
            }
          }
          this.command("systemctl", ["daemon-reload"]);
          this.command("systemctl", ["start", "lightmoni-agent.service"]);
          let verified = false;
          for (let n = 0; n < 10; n++) {
            try {
              this.observe(before, input.agent_id, state.boot_id);
              verified = true;
              break;
            } catch {
              await this.sleep(1000);
            }
          }
          if (!verified) fail("runtime_restore_failed");
          restored = true;
        } catch {
          rollbackFailed = true;
        }
      save(
        rollbackFailed ? "unknown" : "failed",
        error.safeCode ?? "runtime_change_failed",
      );
      throw error;
    } finally {
      if (!rollbackFailed) fs.rmdirSync(lock);
      if (restored && backup)
        fs.rmSync(backup, { recursive: true, force: true });
      if (
        (restored || completed) &&
        dataBackup &&
        fs.existsSync(dataBackup) &&
        fs.readdirSync(dataBackup).length === 0
      )
        fs.rmdirSync(dataBackup);
    }
  }
  status(id) {
    if (!OP.test(id)) fail("invalid_operation");
    return this.json(
      this.safe(this.p("/opt/lightmoni-agent/runtime-plans/" + id + ".json")),
    );
  }
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      process.geteuid?.() !== 0
    )
      fail("root_maintenance_required");
    const m = new AgentRuntimeMaintenance();
    m.safe(fileURLToPath(import.meta.url));
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 65536) fail("request_too_large");
    }
    const value = input ? JSON.parse(input) : {},
      command = process.argv[2];
    const result =
      command === "probe"
        ? m.probe()
        : command === "status"
          ? m.status(value.operation_id)
          : command === "apply"
            ? await m.apply(value)
            : fail("invalid_runtime_command");
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(
      (error.safeCode ?? "runtime_maintenance_failed") + "\n",
    );
    process.exitCode = 1;
  }
}
