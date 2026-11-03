#!/usr/bin/env node
/** Fixed SSH lifecycle operation. No caller-supplied paths or executable code. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildAgentService, buildHelperService, identifyAgentService, identifyHelperService } from "./service-unit.mjs";
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
  helperStatus() {
    return JSON.parse(this.cli(["helper-status"]));
  }
  helperUnit(mode) {
    const file=this.p('/etc/systemd/system/lightmoni-agent-helper.service');
    if(mode==='root') {
      const bytes=fs.readFileSync(this.safe(file));
      if(identifyHelperService(bytes)!=='root')fail('helper_service_override_not_allowed');
      if(this.command('systemctl',['show','lightmoni-agent-helper.service','--property=FragmentPath','--value'])!==file
        ||this.command('systemctl',['show','lightmoni-agent-helper.service','--property=ActiveState','--value'])!=='active')fail('helper_service_inactive');
      if(this.command('systemctl',['show','lightmoni-agent-helper.service','--property=DropInPaths','--value']))fail('helper_service_override_not_allowed');
      const status=this.helperStatus();
      const config=JSON.parse(fs.readFileSync(this.safe(this.p('/etc/lightmoni-agent/config.json')),'utf8'));
      if(!ID.test(status.executor_id)||!Number.isSafeInteger(status.install_generation)||status.install_generation<1
        ||status.permission_generation!==config.permission_generation||status.ordinary_task_identity?.account!=='lightmoni-task')fail('helper_health_unverified');
      return bytes;
    }
    if(fs.existsSync(file)||fs.existsSync(file+'.disabled')||fs.existsSync(this.p('/etc/lightmoni-agent-helper'))||fs.existsSync(this.p('/var/lib/lightmoni-agent-helper')))fail('unexpected_helper_service');
    const load=this.command('systemctl',['show','lightmoni-agent-helper.service','--property=LoadState','--value']);
    if(load!=='not-found')fail('unexpected_helper_service');
    return null;
  }
  managed() {
    const f = this.p("/etc/lightmoni-agent-helper/managed.json");
    if (!fs.existsSync(f)) {
      if (fs.existsSync(this.p("/var/lib/lightmoni-agent-helper/managed")))
        fail("managed_configuration_missing");
      return null;
    }
    this.safe(f);
    const s = this.helperStatus();
    if (
      !ID.test(s.executor_id) ||
      !Number.isSafeInteger(s.install_generation) ||
      s.install_generation < 1 ||
      s.fenced ||
      s.pending_results !== 0 ||
      s.ordinary_task_runner?.active !== false ||
      s.ordinary_task_runner?.state !== 'idle'
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
      r.uid !== a.uid ||
      r.gid !== a.gid ||
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
    if (identifyAgentService(fs.readFileSync(service)) !== 'user')
      fail("legacy_root_agent_reinstall_required");
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
      managed = c.runtime_mode==='root' ? this.helperStatus() : null;
    this.helperUnit(c.runtime_mode);
    if (c.runtime_mode === "root" ? !managed : !!managed)
      fail("runtime_execution_identity_mismatch");
    if(managed&&(managed.fenced||managed.pending_results!==0||managed.permission_generation!==c.permission_generation
      ||managed.ordinary_task_identity?.account!=='lightmoni-task'))fail('managed_execution_not_idle');
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
  removeTaskAccount(snapshot) {
    const marker=this.p('/var/lib/lightmoni-agent-task-account.json');
    const recorded=this.json(marker),uid=Number(this.command('/usr/bin/id',['-u','lightmoni-task'])),gid=Number(this.command('/usr/bin/id',['-g','lightmoni-task']));
    if(recorded.schema!==1||recorded.uid!==uid||recorded.gid!==gid||uid<=0||gid<=0)fail('ordinary_task_identity_changed');
    const passwd=this.command('/usr/bin/getent',['passwd','lightmoni-task']).split(':');
    const group=this.command('/usr/bin/getent',['group','lightmoni-task']).split(':');
    if(passwd.length<7||Number(passwd[2])!==uid||Number(passwd[3])!==gid||passwd[5]!=='/nonexistent'||passwd[6]!=='/usr/sbin/nologin'
      ||group.length<4||Number(group[2])!==gid||group[3])fail('ordinary_task_account_unmanaged');
    const processes=this.command('/usr/bin/ps',['-eo','uid=']).split(/\s+/).filter(Boolean);
    if(processes.includes(String(uid)))fail('ordinary_task_account_busy');
    this.atomic(snapshot,recorded);
    this.command('/usr/sbin/userdel',['lightmoni-task']);
    return recorded;
  }
  restoreTaskAccount(snapshot) {
    const recorded=this.json(snapshot);
    if(recorded.schema!==1||!Number.isSafeInteger(recorded.uid)||recorded.uid<=0||!Number.isSafeInteger(recorded.gid)||recorded.gid<=0)fail('ordinary_task_identity_changed');
    try{
      const group=this.command('/usr/bin/getent',['group','lightmoni-task']).split(':');
      if(Number(group[2])!==recorded.gid||group[3])fail('ordinary_task_identity_changed');
    }catch(error){if(error.safeCode)throw error;this.command('/usr/sbin/groupadd',['--system','--gid',String(recorded.gid),'lightmoni-task']);}
    try{
      const user=this.command('/usr/bin/getent',['passwd','lightmoni-task']).split(':');
      if(Number(user[2])!==recorded.uid||Number(user[3])!==recorded.gid||user[5]!=='/nonexistent'||user[6]!=='/usr/sbin/nologin')fail('ordinary_task_identity_changed');
    }catch(error){if(error.safeCode)throw error;this.command('/usr/sbin/useradd',['--system','--uid',String(recorded.uid),'--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','--gid','lightmoni-task','lightmoni-task']);}
    this.atomic(this.p('/var/lib/lightmoni-agent-task-account.json'),recorded);
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
      helperUnitBefore,
      account,
      backup,
      dataBackup,
      helperDataMoved = false,
      helperConfigDirectoryRemoved = false,
      taskAccountRemoved = false,
      taskAccountCreated = false,
      taskGroupCreated = false,
      stopped = false,
      mutated = false,
      restored = false,
      rollbackFailed = false,
      completed = false;
    const savedHelper = [];
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
      helperUnitBefore=this.helperUnit(before.runtime_mode);
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
      if(helperUnitBefore)this.atomic(path.join(backup,'helper-service'),helperUnitBefore.toString());
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
      if(input.from_mode==='root'){
        this.command('systemctl',['stop','lightmoni-agent-helper.service']);
        if(!['inactive','failed'].includes(this.command('systemctl',['show','lightmoni-agent-helper.service','--property=ActiveState','--value'])))fail('helper_service_stop_failed');
      }
      this.idle();
      const data=this.dataPath(), identity=this.json(path.join(data,"identity.json"));
      if(identity.agent_id!==input.agent_id||!ID.test(identity.host_id))fail("invalid_agent_identity");
      this.validateState(data);
      const operations=path.join(data,"operations");
      if(fs.existsSync(operations)){
        const info=fs.lstatSync(operations);
        if(!info.isDirectory()||info.isSymbolicLink()||fs.readdirSync(operations).length)fail("operations_directory_requires_reconciliation");
      }
      const helperConfigDir=this.p('/etc/lightmoni-agent-helper');
      const helperDataDir=this.p('/var/lib/lightmoni-agent-helper');
      if(input.from_mode==='root'){
        const status=this.helperStatus();
        if(status.fenced||status.pending_results!==0||status.ordinary_task_runner?.active!==false||status.ordinary_task_runner?.state!=='idle')fail('managed_execution_not_idle');
        const tasks=this.p('/var/lib/lightmoni-agent-helper/tasks');
        if(fs.existsSync(tasks)&&fs.readdirSync(tasks).length)fail('helper_tasks_not_empty');
        this.safe(helperDataDir,'directory');
        this.validateState(helperDataDir);
        mutated=true;
        fs.renameSync(helperDataDir,path.join(dataBackup,'helper-state'));
        helperDataMoved=true;
        for(const name of ['helper.json','managed.json','managed-activation.json']){
          const file=path.join(helperConfigDir,name);
          if(!fs.existsSync(file))continue;
          this.atomic(path.join(backup,'helper-'+name),fs.readFileSync(this.safe(file),'utf8'));
          savedHelper.push(name);
          fs.unlinkSync(file);
        }
        fs.rmdirSync(helperConfigDir);
        helperConfigDirectoryRemoved=true;
        this.removeTaskAccount(path.join(backup,'task-account.json'));
        taskAccountRemoved=true;
        this.command('/usr/sbin/groupdel',['lightmoni-task']);
        fs.unlinkSync(this.p('/var/lib/lightmoni-agent-task-account.json'));
      }else{
        mutated=true;
        let taskUid,taskGid;
        try{
          taskUid=Number(this.command('/usr/bin/id',['-u','lightmoni-task']));
          taskGid=Number(this.command('/usr/bin/id',['-g','lightmoni-task']));
          if(!Number.isSafeInteger(taskUid)||taskUid<=0||!Number.isSafeInteger(taskGid)||taskGid<=0)fail('ordinary_task_identity_invalid');
          const marker=this.p('/var/lib/lightmoni-agent-task-account.json');
          if(!fs.existsSync(marker))fail('unmanaged_task_account');
          const recorded=this.json(marker);
          if(recorded.schema!==1||recorded.uid!==taskUid||recorded.gid!==taskGid)fail('ordinary_task_identity_changed');
        }catch(error){
          if(error.safeCode)throw error;
          try{this.command('/usr/bin/getent',['group','lightmoni-task']);fail('unmanaged_task_group');}
          catch(error){if(error.safeCode)throw error;if(error.status!==2)fail('task_group_query_failed');}
          this.command('/usr/sbin/groupadd',['--system','lightmoni-task']);taskGroupCreated=true;
          this.command('/usr/sbin/useradd',['--system','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','--gid','lightmoni-task','lightmoni-task']);taskAccountCreated=true;
          taskUid=Number(this.command('/usr/bin/id',['-u','lightmoni-task']));
          taskGid=Number(this.command('/usr/bin/id',['-g','lightmoni-task']));
          this.atomic(this.p('/var/lib/lightmoni-agent-task-account.json'),{schema:1,uid:taskUid,gid:taskGid});
        }
        fs.mkdirSync(helperConfigDir,{mode:0o700,recursive:true});
        fs.chmodSync(helperConfigDir,0o700);
        fs.mkdirSync(helperDataDir,{mode:0o711});
        fs.chmodSync(helperDataDir,0o711);
        const tasks=this.p('/var/lib/lightmoni-agent-helper/tasks');
        fs.mkdirSync(tasks,{mode:0o711});fs.chmodSync(tasks,0o711);
      }
      const config={...before,endpoint:input.endpoint,runtime_mode:input.runtime_mode,permission_generation:input.permission_generation};
      const configPath=this.p('/etc/lightmoni-agent/config.json');
      this.atomic(configPath,config,0o640);
      this.chown(configPath,this.uid,account.gid);
      fs.chmodSync(configPath,0o640);
      if(input.runtime_mode==='root')this.cli(['managed-enroll'],JSON.stringify(input.managed_bootstrap));
      this.atomic(this.p('/etc/systemd/system/lightmoni-agent.service'),buildAgentService(input.runtime_mode),0o644);
      if(input.runtime_mode==='root'){
        this.atomic(this.p('/etc/systemd/system/lightmoni-agent-helper.service'),buildHelperService(),0o644);
        this.command('systemctl',['enable','lightmoni-agent-helper.service']);
      }else{
        this.command('systemctl',['disable','lightmoni-agent-helper.service']);
        fs.rmSync(this.p('/etc/systemd/system/lightmoni-agent-helper.service'),{force:true});
      }
      this.cli([
        "check",
        "--config",
        this.p("/etc/lightmoni-agent/config.json"),
      ]);
      this.command("systemctl", ["daemon-reload"]);
      if(input.runtime_mode==='root'){
        this.command('systemctl',['start','lightmoni-agent-helper.service']);
        if(this.command('systemctl',['show','lightmoni-agent-helper.service','--property=ActiveState','--value'])!=='active')fail('helper_service_inactive');
        const helperStatus=this.helperStatus();
        if(helperStatus.permission_generation!==input.permission_generation||helperStatus.fenced||helperStatus.pending_results!==0
          ||helperStatus.ordinary_task_runner?.active!==false||helperStatus.ordinary_task_runner?.state!=='idle')fail('helper_health_unverified');
      }
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
      // A successful monitor-only switch erases the old root helper credentials,
      // executor journal and task recovery state kept under this transaction.
      for(const obsolete of [dataBackup,backup]){
        try{fs.rmSync(obsolete,{recursive:true,force:true});}catch{/* retain root-only recovery evidence */}
      }
      return result;
    } catch (error) {
      if (stopped)
        try {
          this.command('systemctl',['stop','lightmoni-agent.service']);
          if(input.runtime_mode==='root'){
            try{this.command('systemctl',['stop','lightmoni-agent-helper.service']);}catch(error){if(error.code!=='ENOENT')throw error;}
          }
          if(mutated){
            const configPath=this.p('/etc/lightmoni-agent/config.json');
            if(before.runtime_mode==='root'){
              if(taskAccountRemoved)this.restoreTaskAccount(path.join(backup,'task-account.json'));
              if(helperDataMoved){
                fs.rmSync(this.p('/var/lib/lightmoni-agent-helper'),{recursive:true,force:true});
                fs.renameSync(path.join(dataBackup,'helper-state'),this.p('/var/lib/lightmoni-agent-helper'));
              }
              if(helperConfigDirectoryRemoved)fs.mkdirSync(this.p('/etc/lightmoni-agent-helper'),{mode:0o700});
              for(const name of savedHelper){
                const source=path.join(backup,'helper-'+name);
                this.atomic(this.p('/etc/lightmoni-agent-helper/'+name),fs.readFileSync(this.safe(source),'utf8'));
              }
              this.atomic(this.p('/etc/systemd/system/lightmoni-agent-helper.service'),fs.readFileSync(this.safe(path.join(backup,'helper-service')),'utf8'),0o644);
              this.command('systemctl',['enable','lightmoni-agent-helper.service']);
            }else{
              fs.rmSync(this.p('/etc/lightmoni-agent-helper'),{recursive:true,force:true});
              fs.rmSync(this.p('/var/lib/lightmoni-agent-helper'),{recursive:true,force:true});
              fs.rmSync(this.p('/etc/systemd/system/lightmoni-agent-helper.service'),{force:true});
              this.command('systemctl',['disable','lightmoni-agent-helper.service']);
              if(taskAccountCreated){
                this.command('userdel',['lightmoni-task']);taskAccountCreated=false;
                fs.rmSync(this.p('/var/lib/lightmoni-agent-task-account.json'),{force:true});
              }
              if(taskGroupCreated){this.command('groupdel',['lightmoni-task']);taskGroupCreated=false;}
            }
            helperConfigDirectoryRemoved=false;
            this.atomic(configPath,before,0o640);
            this.chown(configPath,this.uid,account.gid);
            fs.chmodSync(configPath,0o640);
            this.atomic(this.p('/etc/systemd/system/lightmoni-agent.service'),unit.toString(),0o644);
          }
          this.command('systemctl',['daemon-reload']);
          if(before.runtime_mode==='root'){
            this.command('systemctl',['start','lightmoni-agent-helper.service']);
            if(this.command('systemctl',['show','lightmoni-agent-helper.service','--property=ActiveState','--value'])!=='active')fail('runtime_restore_failed');
          }
          this.command('systemctl',['start','lightmoni-agent.service']);
          let verified=false;
          for(let n=0;n<10;n++){
            try{this.observe(before,input.agent_id,state.boot_id);if(before.runtime_mode==='root')this.helperUnit('root');verified=true;break;}
            catch{await this.sleep(1000);}
          }
          if(!verified)fail('runtime_restore_failed');
          restored=true;
        }catch{
          rollbackFailed=true;
        }
      save(
        rollbackFailed ? "unknown" : "failed",
        error.safeCode ?? "runtime_change_failed",
      );
      throw error;
    } finally {
      if (!rollbackFailed) fs.rmdirSync(lock);
      if(restored&&backup)fs.rmSync(backup,{recursive:true,force:true});
      if((restored||completed)&&dataBackup)fs.rmSync(dataBackup,{recursive:true,force:true});
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
