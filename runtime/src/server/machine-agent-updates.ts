import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { hash, id, token } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import type { Dependencies, Handler, Module } from "../shared/types.js";
import { hasActiveTaskRuns } from "./agent-hosts.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
import { assertAgentActive } from "./agent-lifecycle.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
import type { MachineSummary } from "./managed-machines.js";
import type { SSHRunner } from "./machine-ssh.js";
import { AgentReleaseCatalog, type AgentRelease, type PinnedAgentFile } from "./machine-agent-updates-catalog.js";
import { NodeStore } from "./nodes-model.js";
import { agentUpdateProbeCommand, parseAgentUpdateProbe, agentUpdateStartCommand, agentUpdateStatusCommand, agentUpdateCommitCommand,
  parseAgentUpdateStatus, type AgentUpdateProbe, type AgentUpdateRemoteStatus, type AgentUpdateStartRequest } from "./machine-agent-update-ssh.js";

export type AgentUpdateStatus = "awaiting_approval" | "running" | "verifying" | "succeeded" | "rolled_back" | "failed" | "unknown" | "cancelled";
export interface AgentUpdateInput { action: "upgrade" | "rollback"; target_sha256?: string; credential_id?: string }
export interface AgentUpdate {
  id: string; machine_id: string; agent_id: string; action: "upgrade" | "rollback"; status: AgentUpdateStatus;
  plan: any; receipt: any; error: string; created_at: string; created_by: string; approved_at: string; approved_by: string;
  started_at: string; finished_at: string; review_url: string;
  rollout_id: string; rollout_review_url: string;
}
interface RolloutView { id: string; status: string; target_sha256: string; acknowledged_json: string; items: { machine_id: string; machine_name: string; update_id: string; status: AgentUpdateStatus; update: AgentUpdate }[]; [key: string]: any }
export interface AgentUpdateStore extends Module {
  listReleases(): AgentRelease[];
  assistantPlan(machineID: string, input: AgentUpdateInput, actorID: string, signal: AbortSignal): Promise<AgentUpdate>;
  assistantGet(machineID: string, operationID: string): AgentUpdate;
  list(machineID: string): AgentUpdate[];
  pending(machineID: string): { id: string; status: AgentUpdateStatus } | undefined;
  assertFree(machineID: string): void;
  machineState(machineID: string, agentID: string): { agent_release: any; agent_update: any };
}
export interface AgentUpdateAccess {
  get(machineID: string): MachineSummary; idle(machineID: string): void; revision(machine: MachineSummary): string;
  credential(machineID: string, credentialID?: string): { machine: MachineSummary; credential: any };
  authentication(machineID: string, credential: any): { privateKey: string; password?: string };
  markCredentialUsed(credentialID: string): void;
  busy: Set<string>; runner: SSHRunner; safe(handler: Handler): Handler;
}
interface Options { downloadsDir: string; dataDir: string; credentials?: AgentCredentialStore; pollIntervalMs?: number; healthTimeoutMs?: number }
const ACTIVE = "('awaiting_approval','running','verifying','unknown')";
const WORKING = new Set(["running", "verifying"]);
const SHA = /^[a-f0-9]{64}$/;
const fields = (input: any, allowed: string[]) => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, "invalid Agent update request");
  return input;
};
const string = (input: any, name: string, max = 128) => {
  if (typeof input !== "string" || !input || Buffer.byteLength(input) > max || /[\u0000-\u001f\u007f]/.test(input)) fail(400, "invalid " + name);
  return input;
};

export function createAgentUpdatesSchema(deps: Dependencies) {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_agent_updates(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,
    plan_json TEXT NOT NULL,receipt_json TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,created_by TEXT NOT NULL,approved_at TEXT NOT NULL DEFAULT '',approved_by TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',
    ticket_hash TEXT NOT NULL DEFAULT '',ticket_expires_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS machine_agent_updates_host ON machine_agent_updates(machine_id,created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS machine_agent_updates_lane ON machine_agent_updates(machine_id) WHERE status IN ${ACTIVE};
  CREATE TABLE IF NOT EXISTS agent_update_rollouts(
    id TEXT PRIMARY KEY,status TEXT NOT NULL,target_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',acknowledged_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS agent_update_rollout_items(
    rollout_id TEXT NOT NULL REFERENCES agent_update_rollouts(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL,update_id TEXT NOT NULL,position INTEGER NOT NULL,
    PRIMARY KEY(rollout_id,machine_id),UNIQUE(update_id)
  );`);
  deps.db.run("UPDATE machine_agent_updates SET status='unknown',ticket_hash='',error=? WHERE status IN ('running','verifying')", "平台在 Agent 维护期间重启，远端会按确认期限回退；请只读核对");
  deps.db.run("UPDATE agent_update_rollouts SET status='paused',error=? WHERE status='running'", "平台重启，批次已暂停；核对已启动主机后明确继续");
}

export function registerMachineAgentUpdates(deps: Dependencies, access: AgentUpdateAccess, options: Options): AgentUpdateStore {
  const { db, router } = deps, at = () => deps.now().toISOString();
  const catalog = new AgentReleaseCatalog(options.downloadsDir, join(options.dataDir, "agent-update-cache"));
  const controller = new AbortController(), running = new Map<string, Promise<void>>(), rolloutWorkers = new Map<string, Promise<void>>();
  const pollInterval = options.pollIntervalMs ?? 3000, healthTimeout = options.healthTimeoutMs ?? 120_000;
  const table = (name: string) => Boolean(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  const pending = (machineID: string) => db.get<{id:string;status:AgentUpdateStatus}>("SELECT id,status FROM machine_agent_updates WHERE machine_id=? AND status IN " + ACTIVE + " LIMIT 1", machineID);
  const assertFree = (machineID: string) => { if (pending(machineID)) fail(409, "主机已有待审批、运行中或结果未知的 Agent 维护，请先取消、完成或核对"); };
  const row = (machineID: string, operationID: string) => {
    const value = db.get<any>("SELECT * FROM machine_agent_updates WHERE id=? AND machine_id=?", operationID, machineID);
    if (!value) fail(404, "Agent 维护记录不存在");
    return value;
  };
  const view = (value: any): AgentUpdate => {
    const membership = db.get<{rollout_id:string}>("SELECT rollout_id FROM agent_update_rollout_items WHERE update_id=?", value.id);
    return { id: value.id, machine_id: value.machine_id, agent_id: value.agent_id,
    action: value.action, status: value.status, plan: JSON.parse(value.plan_json), receipt: JSON.parse(value.receipt_json), error: value.error,
    created_at: value.created_at, created_by: value.created_by, approved_at: value.approved_at, approved_by: value.approved_by,
    started_at: value.started_at, finished_at: value.finished_at,
    review_url: `/machines?machine=${encodeURIComponent(value.machine_id)}&agent_update=${encodeURIComponent(value.id)}`,
    rollout_id: membership?.rollout_id ?? "", rollout_review_url: membership ? `/machines?agent_rollout=${encodeURIComponent(membership.rollout_id)}` : "" };
  };
  const list = (machineID: string) => db.all<any>("SELECT * FROM machine_agent_updates WHERE machine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100", machineID).map(view);
  const taskBusy = (machineID: string, agentID: string) => hasActiveTaskRuns(db, agentID, machineID)
    || table("agent_jobs") && Boolean(db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1", agentID));
  const assertTarget = (machine: MachineSummary) => {
    assertNoPendingMachineInstallation(db,machine.id,machine.agent_id,true);
    if (!machine.agent_id) fail(409, "主机尚未安装 Agent，请先部署");
    assertAgentActive(db, machine.agent_id);
    if (!options.credentials?.has(machine.agent_id, "control")) fail(409, "主机没有有效的 Agent 控制凭据");
    if (taskBusy(machine.id, machine.agent_id)) fail(409, "主机存在待执行、运行中或结果未知的任务，请先处理");
    if (db.get("SELECT id FROM machine_deployments WHERE machine_id=? AND status IN ('awaiting_approval','running') LIMIT 1", machine.id)
      || db.get("SELECT id FROM machine_uninstallations WHERE machine_id=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", machine.id))
      fail(409, "主机存在安装或卸载流程，请先结束");
  };
  const ssh = async (machine: MachineSummary, credential: any, command: string, signal: AbortSignal, stdin?: string, timeoutMs = 60_000) => {
    const output = await access.runner({ machine, credentialID: credential.id, ...access.authentication(machine.id, credential), command, signal: AbortSignal.any([signal, controller.signal]),
      port: machine.port, timeoutMs, ...(stdin == null ? {} : { stdin }) });
    access.markCredentialUsed(credential.id);
    return output;
  };
  const probe = async (machine: MachineSummary, credential: any, signal: AbortSignal) =>
    parseAgentUpdateProbe((await ssh(machine, credential, agentUpdateProbeCommand(), signal)).stdout);
  const validateProbe = (machine: MachineSummary, observation: AgentUpdateProbe, requireActive = true) => {
    if (observation.agent_id !== machine.agent_id) fail(409, "SSH 主机的 Agent 身份与平台不一致");
    if (!observation.ready || requireActive && !observation.service_active || observation.lifecycle_locked || observation.operation_lock) fail(409, "Agent 不是空闲且健康的受管 systemd 安装，不能自动维护");
    if (observation.current.state_schema !== 1) fail(409, "当前 Agent 状态格式未知，不能安全升级或回退");
  };
  const plan = async (machineID: string, input: AgentUpdateInput, actorID: string, signal: AbortSignal): Promise<AgentUpdate> => {
    fields(input, ["credential_id", "target_sha256", "action"]);
    if (!["upgrade", "rollback"].includes(input.action)) fail(400, "action must be upgrade or rollback");
    if (input.action === "upgrade" && !SHA.test(input.target_sha256 ?? "")) fail(400, "升级必须指定完整的目标 SHA256");
    if (input.action === "rollback" && input.target_sha256 != null) fail(400, "回退目标必须来自主机保留的上一发行");
    let endpoint: URL;
    try { endpoint = new URL(deps.externalURL); } catch { fail(409, "请先配置有效的平台 HTTPS 外部地址"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
      fail(409, "Agent 维护需要无凭据的平台 HTTPS 根地址，请先更新平台外部地址");
    access.idle(machineID); assertFree(machineID);
    const { machine, credential } = access.credential(machineID, input.credential_id);
    assertTarget(machine);
    access.busy.add(machine.id);
    try {
      const observed = await probe(machine, credential, signal); validateProbe(machine, observed, input.action !== "rollback");
      access.credential(machine.id, credential.id); assertFree(machine.id); assertTarget(access.get(machine.id));
      if (access.revision(access.get(machine.id)) !== access.revision(machine)) fail(409, "主机连接在检查期间变化，请重新生成计划");
      let target: any, files: Record<string, PinnedAgentFile>;
      if (input.action === "upgrade") {
        const pinned = catalog.pin(input.target_sha256!);
        if (pinned.release.arch !== observed.arch) fail(409, "发行架构与目标主机不一致");
        if (pinned.release.sha256 === observed.current.artifact_sha256) fail(409, "目标发行已安装，无需重复升级");
        target = { ...pinned.release, artifact_sha256: pinned.release.sha256 };
        files = pinned.files;
      } else {
        if (!observed.previous || observed.previous.state_schema !== 1 || !SHA.test(observed.previous.artifact_sha256)
          || !observed.previous.source_revision || !observed.previous.build_id) fail(409, "没有具备可验证构建身份的上一发行，不能自动回退");
        target = { ...observed.previous, sha256: observed.previous.artifact_sha256, arch: observed.arch, platform: "linux" };
        files = catalog.pinScripts();
      }
      const operationID = id(), expires = new Date(deps.now().getTime() + 15 * 60_000).toISOString();
      const planBody = { machine: { id: machine.id, name: machine.name, address: machine.address, port: machine.port, username: machine.username, agent_id: machine.agent_id },
        credential: { id: credential.id, method: credential.method, retention: credential.retention, expires_at: credential.expires_at },
        action: input.action, current: { ...observed.current, service_active: observed.service_active, release: { ...observed.current } }, target, files,
        target_revision: access.revision(machine), expires_at: expires,
        steps: ["核对主机、Agent 身份与当前程序指纹", "下载并校验审批固定的维护器和发行包", "移除本平台旧 Docker 权限；程序回退不恢复该权限", "通过独立 systemd 维护器切换程序", "确认目标构建的新进程已同步平台配置", "确认成功；失败时仅恢复已验证的普通 Agent 程序"],
        warnings: ["维护期间暂停该主机的新任务派发和领取。", "保留主机 ID、Agent 身份、配置、队列和游标；不会重新接入。", "旧高权限版本不能回退；无法安全恢复时停服并保留证据。", "结果未知时只读核对；确认超时仅回退到已验证的普通 Agent，不自动重试。"] };
      db.transaction(() => {
        assertFree(machine.id); assertTarget(access.get(machine.id));
        db.run("INSERT INTO machine_agent_updates(id,machine_id,agent_id,credential_id,action,status,plan_json,created_at,created_by) VALUES(?,?,?,?,?,'awaiting_approval',?,?,?)",
          operationID, machine.id, machine.agent_id, credential.id, input.action, JSON.stringify(planBody), at(), actorID);
      });
      return view(row(machine.id, operationID));
    } finally { access.busy.delete(machine.id); }
  };
  const assertPlan = (operation: any, beforeStart = false) => {
    const machine = access.get(operation.machine_id), body = JSON.parse(operation.plan_json);
    if (machine.agent_id !== operation.agent_id || access.revision(machine) !== body.target_revision) fail(409, "主机连接或 Agent 身份已变化，原维护计划不可执行");
    assertTarget(machine);
    if (beforeStart && Date.parse(body.expires_at) <= deps.now().getTime()) fail(409, "维护计划已过期，请取消并重新生成");
    return { machine, plan: body };
  };
  const heartbeat = (operation: any, remote: AgentUpdateRemoteStatus, target = true, observedBootID?: string) => {
    const machine = access.get(operation.machine_id);
    if (machine.agent_id !== operation.agent_id) return false;
    const node = db.get<any>("SELECT * FROM agents WHERE id=?", operation.agent_id);
    if (!node?.heartbeat || !Number.isFinite(Date.parse(node.last_seen)) || Date.parse(node.last_seen) < Date.parse(operation.started_at)
      || deps.now().getTime() - Date.parse(node.last_seen) > 90_000) return false;
    let value: any;
    try { value = JSON.parse(node.heartbeat); } catch { return false; }
    const planBody = JSON.parse(operation.plan_json), expected = target ? planBody.target : planBody.current;
    const boot = observedBootID ?? remote.local_health?.boot_id;
    if (!boot || value.boot_id !== boot || value.boot_id === planBody.current.boot_id || value.last_error !== "") return false;
    if (target) {
      if (value.release?.version !== expected.version || value.release?.source_revision !== expected.source_revision
        || value.release?.build_id !== expected.build_id || value.release?.state_schema !== 1
        || value.release?.artifact_sha256 !== (expected.artifact_sha256 ?? expected.sha256)) return false;
    } else if (value.version !== expected.version || expected.artifact_sha256 && value.release?.artifact_sha256 !== expected.artifact_sha256) return false;
    try { return Boolean(value.config_revision) && value.config_revision === new NodeStore(db, deps.now).effective(operation.agent_id).config.revision; }
    catch { return false; }
  };
  const validateRemote = (operation: any, remote: AgentUpdateRemoteStatus) => {
    const p = JSON.parse(operation.plan_json);
    if (remote.operation_id !== operation.id || remote.agent_id !== operation.agent_id
      || remote.from.fingerprint !== p.current.fingerprint
      || remote.target.version !== p.target.version || remote.target.build_id !== p.target.build_id
      || remote.target.artifact_sha256 !== (p.target.artifact_sha256 ?? p.target.sha256)
      || remote.target.source_revision !== p.target.source_revision) fail(409, "远端维护回执与已审批计划不一致");
  };
  const saveRemote = (operation: any, remote: AgentUpdateRemoteStatus, allowCommit = false, verification?: { boot_id: string; fingerprint: string; verified_at: string }) => {
    validateRemote(operation, remote);
    const healthy = Boolean(remote.local_health?.service_active && remote.local_health.identity_matches && remote.local_health.release_matches);
    const original = JSON.parse(operation.plan_json).current;
    const restored = remote.status === "rolled_back" && remote.restored_fingerprint === original.fingerprint
      && remote.local_health.identity_matches && remote.local_health.release_matches
      && (original.service_active === false ? remote.local_health.service_active === false : healthy);
    const terminal = remote.status === "succeeded" && healthy && heartbeat(operation, remote, true, verification?.boot_id)
      ? "succeeded" : restored ? "rolled_back" : "";
    if (terminal) {
      db.run("UPDATE machine_agent_updates SET status=?,receipt_json=?,error=?,finished_at=?,ticket_hash='' WHERE id=? AND status IN ('running','verifying','unknown')",
        terminal, JSON.stringify(verification ? { ...remote, current_verification: verification } : remote), terminal === "succeeded" ? "" : original.service_active === false ? "目标程序未通过健康确认，已恢复原程序；原服务此前停止，现仍停止" : "目标程序未通过健康确认，已恢复原程序", at(), operation.id);
      return terminal;
    }
    if (remote.status === "rollback_failed") {
      db.run("UPDATE machine_agent_updates SET status='unknown',receipt_json=?,error=?,ticket_hash='' WHERE id=?", JSON.stringify(remote), "远端自动回退未确认，需人工检查服务；禁止重复维护", operation.id);
      return "unknown";
    }
    db.run("UPDATE machine_agent_updates SET receipt_json=? WHERE id=?", JSON.stringify(remote), operation.id);
    if (allowCommit && remote.status === "waiting_confirmation" && healthy && heartbeat(operation, remote)) return "commit";
    return "";
  };
  const markUnknown = (operationID: string, message: string) => db.run("UPDATE machine_agent_updates SET status='unknown',ticket_hash='',error=? WHERE id=? AND status IN ('running','verifying')", message, operationID);
  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    if (controller.signal.aborted) return reject(Error("closed"));
    const done = () => { controller.signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms), abort = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); reject(Error("closed")); };
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const observe = async (machineID: string, operationID: string, credentialID: string) => {
    const deadline = Date.now() + healthTimeout;
    let commitRequested = false;
    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        const operation = row(machineID, operationID);
        if (!WORKING.has(operation.status)) return;
        const { machine } = assertPlan(operation), { credential } = access.credential(machineID, credentialID);
        const result = await ssh(machine, credential, agentUpdateStatusCommand(operation.id), controller.signal);
        const remote = parseAgentUpdateStatus(result.stdout);
        if (remote.status === "failed") {
          validateRemote(operation, remote);
          const observed = await probe(machine, credential, controller.signal);
          const body = JSON.parse(operation.plan_json);
          validateProbe(machine, observed, false);
          if (observed.current.fingerprint !== body.current.fingerprint) fail(409, "失败回执后的当前程序已变化");
          db.run("UPDATE machine_agent_updates SET status='failed',receipt_json=?,finished_at=?,ticket_hash='',error=? WHERE id=?", JSON.stringify(remote), at(), "核对确认维护未切换原程序", operation.id);
          return;
        }
        const outcome = saveRemote(operation, remote, !commitRequested);
        if (["succeeded", "rolled_back", "failed", "unknown"].includes(outcome)) return;
        if (remote.status === "waiting_confirmation") db.run("UPDATE machine_agent_updates SET status='verifying' WHERE id=? AND status='running'", operation.id);
        if (outcome === "commit") {
          const bootID = remote.local_health.boot_id;
          const committed = parseAgentUpdateStatus((await ssh(machine, credential, agentUpdateCommitCommand(operation.id, bootID, remote.target.artifact_sha256), controller.signal)).stdout);
          validateRemote(operation, committed); commitRequested = true;
          if (saveRemote(operation, committed) === "succeeded") return;
        }
        await wait(pollInterval);
      }
      markUnknown(operationID, "目标程序尚未通过平台健康确认；等待远端自动回退后只读核对");
    } catch {
      markUnknown(operationID, "维护结果暂不可确认；远端会按确认期限回退，请使用只读核对");
    } finally { access.busy.delete(machineID); }
  };
  const launchObserver = (machineID: string, operationID: string, credentialID: string) => {
    const promise = observe(machineID, operationID, credentialID).finally(() => running.delete(operationID));
    running.set(operationID, promise);
  };
  const apply = async (machineID: string, operationID: string, actorID: string, signal: AbortSignal, rolloutID?: string) => {
    access.idle(machineID);
    const membership = db.get<{rollout_id:string}>("SELECT rollout_id FROM agent_update_rollout_items WHERE update_id=?", operationID);
    if (membership && (membership.rollout_id !== rolloutID || rolloutRow(rolloutID!).status !== "running")) fail(409, "此维护属于更新批次，请从批次审阅并按顺序执行");
    const operation = row(machineID, operationID);
    if (operation.status !== "awaiting_approval") fail(409, "维护计划已执行或不可用，不能重复执行");
    const { machine, plan: body } = assertPlan(operation, true), { credential } = access.credential(machineID, operation.credential_id);
    for (const file of Object.values(body.files) as PinnedAgentFile[]) catalog.verify(file);
    access.busy.add(machineID);
    let dispatched = false, observing = false;
    try {
      const observed = await probe(machine, credential, signal); validateProbe(machine, observed, operation.action !== "rollback");
      if (observed.current.fingerprint !== body.current.fingerprint) fail(409, "当前 Agent 程序已变化，请取消旧计划并重新审阅");
      if (observed.service_active !== body.current.service_active) fail(409, "当前 Agent 服务运行状态已变化，请取消旧计划并重新审阅");
      if (operation.action === "rollback" && observed.previous?.fingerprint !== body.target.fingerprint) fail(409, "保留的回退发行已变化，请重新审阅");
      assertPlan(operation, true); access.credential(machineID, credential.id);
      const downloadToken = "lm_update_" + token();
      const startDeadline = new Date(deps.now().getTime() + 180_000).toISOString();
      const request: AgentUpdateStartRequest = { operation_id: operation.id, expected_agent_id: operation.agent_id,
        expected_fingerprint: body.current.fingerprint, expected_service_active: body.current.service_active, action: operation.action,
        target: { version: body.target.version, source_revision: body.target.source_revision, build_id: body.target.build_id,
          state_schema: 1, artifact_sha256: body.target.artifact_sha256 ?? body.target.sha256, arch: body.target.arch,
          ...(operation.action === "rollback" ? { fingerprint: body.target.fingerprint } : {}) }, confirm_timeout_seconds: 180, start_deadline: startDeadline };
      const command = agentUpdateStartCommand({ endpoint: deps.externalURL, machineID, operationID,
        scripts: { "update.sh": body.files["update.sh"].sha256, "update-runner.mjs": body.files["update-runner.mjs"].sha256 },
        ...(operation.action === "upgrade" ? { bundleSHA: body.target.sha256 } : {}), request });
      const changed = db.run("UPDATE machine_agent_updates SET status='running',approved_at=?,approved_by=?,started_at=?,plan_json=?,ticket_hash=?,ticket_expires_at=? WHERE id=? AND status='awaiting_approval'",
        at(), actorID, at(), JSON.stringify({ ...body, start_deadline: startDeadline }), hash(downloadToken), startDeadline, operationID);
      if (!changed.changes) fail(409, "维护计划已被其他请求执行");
      // Any failure after invoking start is unknown: the detached worker may already run.
      dispatched = true;
      const response = parseAgentUpdateStatus((await ssh(machine, credential, command, signal, JSON.stringify({ download_token: downloadToken }) + "\n", 180_000)).stdout);
      validateRemote(operation, response);
      db.run("UPDATE machine_agent_updates SET ticket_hash='',receipt_json=? WHERE id=?", JSON.stringify(response), operationID);
      launchObserver(machineID, operationID, credential.id); observing = true;
      return view(row(machineID, operationID));
    } catch (error) {
      if (dispatched) {
        markUnknown(operationID, "维护连接中断或回执无效；远端可能仍运行，请等待自动回退后只读核对");
        return view(row(machineID, operationID));
      }
      if (error instanceof HTTPError) throw error;
      fail(502, "升级前 SSH 检查失败，未执行维护");
    } finally { if (!observing) access.busy.delete(machineID); }
  };
  const cancel = (machineID: string, operationID: string, rolloutID?: string) => {
    const membership = db.get<{rollout_id:string}>("SELECT rollout_id FROM agent_update_rollout_items WHERE update_id=?", operationID);
    if (membership && membership.rollout_id !== rolloutID) fail(409, "此维护属于更新批次，请取消批次中的未启动项");
    const operation = row(machineID, operationID);
    if (!["awaiting_approval", "cancelled"].includes(operation.status)) fail(409, "只能取消未执行的维护计划");
    db.run("UPDATE machine_agent_updates SET status='cancelled',ticket_hash='',finished_at=? WHERE id=? AND status='awaiting_approval'", at(), operationID);
    return view(row(machineID, operationID));
  };
  const reconcile = async (machineID: string, operationID: string, credentialID: string | undefined, signal: AbortSignal) => {
    access.idle(machineID);
    const operation = row(machineID, operationID);
    if (operation.status !== "unknown") fail(409, "只有结果未知的维护需要核对");
    const { machine } = assertPlan(operation);
    let credential: any;
    try { credential = access.credential(machineID, credentialID ?? operation.credential_id).credential; }
    catch { if (credentialID) fail(409, "所选 SSH 凭据不可用"); credential = access.credential(machineID).credential; }
    access.busy.add(machineID);
    try {
      let remote: AgentUpdateRemoteStatus;
      try { remote = parseAgentUpdateStatus((await ssh(machine, credential, agentUpdateStatusCommand(operationID), signal)).stdout); }
      catch {
        // A lost start response may precede receipt creation. A fresh read-only
        // probe can prove the original program is still present and idle.
        const observed = await probe(machine, credential, signal); validateProbe(machine, observed, false);
        const body = JSON.parse(operation.plan_json);
        if (!Number.isFinite(Date.parse(body.start_deadline)) || deps.now().getTime() <= Date.parse(body.start_deadline)) fail(409, "启动确认窗口尚未结束，请稍后再次核对");
        if (observed.current.fingerprint !== body.current.fingerprint) fail(409, "维护回执缺失且程序已变化，仍需人工核对");
        assertPlan(operation); access.credential(machineID, credential.id);
        db.run("UPDATE machine_agent_updates SET status='failed',receipt_json=?,error=?,finished_at=?,ticket_hash='' WHERE id=? AND status='unknown'", JSON.stringify({ remote_unchanged: true, fingerprint: observed.current.fingerprint, verified_at: at() }), "只读核对确认原程序完整且无维护锁，本次维护未执行", at(), operationID);
        return view(row(machineID, operationID));
      }
      assertPlan(operation); access.credential(machineID, credential.id);
      if (remote.status === "failed") {
        validateRemote(operation, remote);
        const observed = await probe(machine, credential, signal); validateProbe(machine, observed, false);
        if (observed.current.fingerprint !== JSON.parse(operation.plan_json).current.fingerprint) fail(409, "失败回执后程序指纹不一致，仍需人工核对");
        db.run("UPDATE machine_agent_updates SET status='failed',receipt_json=?,error=?,finished_at=? WHERE id=? AND status='unknown'", JSON.stringify(remote), "核对确认维护未切换原程序", at(), operationID);
        return view(row(machineID, operationID));
      }
      if (remote.status === "succeeded") {
        validateRemote(operation, remote);
        const observed = await probe(machine, credential, signal); validateProbe(machine, observed);
        const target = JSON.parse(operation.plan_json).target;
        if (!observed.current.boot_id || ["version", "source_revision", "build_id", "state_schema", "arch"].some(key => observed.current[key as keyof typeof observed.current] !== target[key])
          || observed.current.artifact_sha256 !== (target.artifact_sha256 ?? target.sha256)) fail(409, "已提交维护的当前发行尚未核对，请检查主机真实状态");
        assertPlan(operation); access.credential(machineID, credential.id);
        // Commit evidence belongs to the historical process. A later restart
        // does not invalidate it: verify the current process independently and
        // preserve both boot IDs in the audit receipt.
        saveRemote(operation, remote, false, { boot_id: observed.current.boot_id, fingerprint: observed.current.fingerprint, verified_at: at() });
      } else saveRemote(operation, remote, false); // Reconciliation never commits a waiting update.
      return view(row(machineID, operationID));
    } finally { access.busy.delete(machineID); }
  };
  const rolloutRow = (rolloutID: string) => {
    const value = db.get<any>("SELECT * FROM agent_update_rollouts WHERE id=?", rolloutID);
    if (!value) fail(404, "Agent 更新批次不存在"); return value;
  };
  const rolloutView = (rolloutID: string): RolloutView => ({ ...rolloutRow(rolloutID), items: db.all<any>("SELECT i.*,m.name AS machine_name FROM agent_update_rollout_items i LEFT JOIN managed_machines m ON m.id=i.machine_id WHERE rollout_id=? ORDER BY position", rolloutID)
    .map(item => { const update = view(row(item.machine_id, item.update_id)); return { machine_id: item.machine_id, machine_name: item.machine_name, update_id: item.update_id, status: update.status, update }; }) });
  const runRollout = (rolloutID: string, actorID: string) => {
    if (rolloutWorkers.has(rolloutID)) return;
    const work = (async () => {
      try {
        while (!controller.signal.aborted && rolloutRow(rolloutID).status === "running") {
          const items = rolloutView(rolloutID).items;
          const acknowledged = new Set(JSON.parse(rolloutRow(rolloutID).acknowledged_json));
          if (items.some(item => ["failed", "rolled_back", "unknown"].includes(item.status) && !acknowledged.has(item.update_id))) {
            db.run("UPDATE agent_update_rollouts SET status='paused',updated_at=?,error=? WHERE id=? AND status='running'", at(), "有主机失败、回退或结果未知，批次已暂停，请核对后明确继续", rolloutID); return;
          }
          const next = items.find(item => item.status === "awaiting_approval");
          if (!next) {
            db.run("UPDATE agent_update_rollouts SET status=?,updated_at=?,error='' WHERE id=? AND status='running'", items.every(item => item.status === "succeeded") ? "succeeded" : "failed", at(), rolloutID); return;
          }
          await apply(next.machine_id, next.update_id, actorID, controller.signal, rolloutID);
          const operation = running.get(next.update_id);
          if (operation) await operation;
        }
      } catch {
        db.run("UPDATE agent_update_rollouts SET status='paused',updated_at=?,error=? WHERE id=? AND status='running'", at(), "批次执行条件已变化，已暂停；请检查凭据、审批期限和主机状态", rolloutID);
      }
    })().finally(() => rolloutWorkers.delete(rolloutID));
    rolloutWorkers.set(rolloutID, work);
  };
  const prefix = "/api/v1/machines/:id/agent-updates";
  router.get("/api/v1/agent-releases", access.safe(ctx => ctx.json({ releases: catalog.list() })));
  router.get(prefix, access.safe(ctx => { access.get(ctx.params.id); ctx.json(list(ctx.params.id)); }));
  router.get(prefix + "/:updateId", access.safe(ctx => { access.get(ctx.params.id); ctx.json(view(row(ctx.params.id, ctx.params.updateId))); }));
  router.post(prefix + "/plan", access.safe(async ctx => { deps.auth.requireAdmin(ctx); ctx.json(await plan(ctx.params.id, await ctx.body() as AgentUpdateInput, ctx.user.id, ctx.signal), 201); }));
  router.post(prefix + "/:updateId/apply", access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = fields(await ctx.body(), ["confirm"]);
    if (input.confirm !== true) fail(400, "必须明确确认维护计划");
    ctx.json(await apply(ctx.params.id, ctx.params.updateId, ctx.user.id, ctx.signal), 202);
  }));
  router.post(prefix + "/:updateId/cancel", access.safe(async ctx => { deps.auth.requireAdmin(ctx); fields(await ctx.body(), []); ctx.json(cancel(ctx.params.id, ctx.params.updateId)); }));
  router.post(prefix + "/:updateId/reconcile", access.safe(async ctx => { deps.auth.requireAdmin(ctx); const input = fields(await ctx.body(), ["credential_id"]);
    ctx.json(await reconcile(ctx.params.id, ctx.params.updateId, input.credential_id == null ? undefined : string(input.credential_id, "credential_id"), ctx.signal)); }));
  router.get(prefix + "/:updateId/downloads/:file", access.safe(async ctx => {
    const operation = row(ctx.params.id, ctx.params.updateId), bearer = String(ctx.req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!WORKING.has(operation.status) || !operation.ticket_hash || hash(bearer) !== operation.ticket_hash || Date.parse(operation.ticket_expires_at) <= deps.now().getTime()) fail(401, "无效或过期的 Agent 维护下载票据");
    const { plan: body } = assertPlan(operation), file = body.files[ctx.params.file] as PinnedAgentFile | undefined;
    if (!["bundle.tar.gz", "update.sh", "update-runner.mjs"].includes(ctx.params.file) || !file) fail(404, "file not found");
    const path = catalog.verify(file);
    ctx.res.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.size,
      "cache-control": "private, no-store", vary: "Authorization", "x-lightmoni-sha256": file.sha256 });
    await pipeline(createReadStream(path), ctx.res, { signal: ctx.signal });
  }), { public: true });
  router.get("/api/v1/agent-rollouts", access.safe(ctx => ctx.json(db.all<{id:string}>("SELECT id FROM agent_update_rollouts ORDER BY created_at DESC,rowid DESC LIMIT 50").map(value => rolloutView(value.id)))));
  router.get("/api/v1/agent-rollouts/:rolloutId", access.safe(ctx => ctx.json(rolloutView(ctx.params.rolloutId))));
  router.post("/api/v1/agent-rollouts/plan", access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = fields(await ctx.body(), ["machine_ids", "target_sha256", "credential_ids"]);
    if (!Array.isArray(input.machine_ids) || !input.machine_ids.length || input.machine_ids.length > 20
      || input.machine_ids.some((mid: any) => typeof mid !== "string") || new Set(input.machine_ids).size !== input.machine_ids.length) fail(400, "每批请选择 1–20 台不同主机");
    catalog.get(string(input.target_sha256, "target_sha256", 64));
    if (input.credential_ids != null) {
      fields(input.credential_ids, input.machine_ids);
      for (const value of Object.values(input.credential_ids)) string(value, "credential_id");
    }
    const planned: AgentUpdate[] = [];
    try {
      for (const mid of input.machine_ids) planned.push(await plan(mid, { action: "upgrade", target_sha256: input.target_sha256, credential_id: input.credential_ids?.[mid] }, ctx.user.id, ctx.signal));
      const rolloutID = id();
      db.transaction(() => {
        db.run("INSERT INTO agent_update_rollouts(id,status,target_sha256,created_at,created_by,updated_at) VALUES(?,'awaiting_approval',?,?,?,?)", rolloutID, input.target_sha256, at(), ctx.user.id, at());
        planned.forEach((operation, position) => db.run("INSERT INTO agent_update_rollout_items(rollout_id,machine_id,update_id,position) VALUES(?,?,?,?)", rolloutID, operation.machine_id, operation.id, position));
      });
      ctx.json(rolloutView(rolloutID), 201);
    } catch (error) { for (const operation of planned) cancel(operation.machine_id, operation.id); throw error; }
  }));
  for (const action of ["apply", "resume", "pause", "cancel"] as const) router.post("/api/v1/agent-rollouts/:rolloutId/" + action, access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = fields(await ctx.body(), ["apply", "resume"].includes(action) ? ["confirm"] : []);
    if (["apply", "resume"].includes(action) && input.confirm !== true) fail(400, "必须明确确认批次");
    const rollout = rolloutRow(ctx.params.rolloutId);
    if (action === "cancel") {
      if (["succeeded", "failed"].includes(rollout.status)) fail(409, "已结束的批次不能取消");
      db.transaction(() => {
        db.run("UPDATE agent_update_rollouts SET status='cancelled',updated_at=? WHERE id=?", at(), rollout.id);
        for (const item of rolloutView(rollout.id).items) if (item.status === "awaiting_approval") cancel(item.machine_id, item.update_id, rollout.id);
      });
    } else if (action === "pause") {
      if (rollout.status !== "running" && rollout.status !== "paused") fail(409, "只能暂停运行中的批次");
      db.run("UPDATE agent_update_rollouts SET status='paused',updated_at=? WHERE id=?", at(), rollout.id);
    } else {
      if (rollout.status !== (action === "apply" ? "awaiting_approval" : "paused")) fail(409, "批次状态不允许此操作");
      const items = rolloutView(rollout.id).items;
      if (items.some(item => ["unknown", "running", "verifying"].includes(item.status))) fail(409, "先核对正在运行或结果未知的主机");
      // Explicit resume acknowledges known failures, and continues only untouched plans.
      for (const item of items.filter(item => item.status === "awaiting_approval")) { assertPlan(row(item.machine_id, item.update_id), true); access.credential(item.machine_id, item.update.plan.credential.id); }
      db.run("UPDATE agent_update_rollouts SET status='running',updated_at=?,error='',acknowledged_json=? WHERE id=?", at(), JSON.stringify(items.filter(item => ["failed", "rolled_back"].includes(item.status)).map(item => item.update_id)), rollout.id);
      runRollout(rollout.id, ctx.user.id);
    }
    ctx.json(rolloutView(rollout.id), 202);
  }));
  const machineState = (machineID: string, agentID: string) => {
    let agent_release: any = null;
    const node = agentID ? db.get<any>("SELECT * FROM agents WHERE id=?", agentID) : undefined;
    if (node?.heartbeat) try {
      const heartbeat = JSON.parse(node.heartbeat);
      if (heartbeat.release && typeof heartbeat.release === "object") agent_release = { version: String(heartbeat.release.version ?? node.version ?? ""),
        source_revision: String(heartbeat.release.source_revision ?? ""), build_id: String(heartbeat.release.build_id ?? ""),
        state_schema: heartbeat.release.state_schema === 1 ? 1 : null, artifact_sha256: SHA.test(heartbeat.release.artifact_sha256 ?? "") ? heartbeat.release.artifact_sha256 : "", boot_id: String(heartbeat.boot_id ?? "") };
      else if (node.version) agent_release = { version: node.version, source_revision: "", build_id: "", state_schema: null, artifact_sha256: "", boot_id: "" };
    } catch { /* Unknown metadata remains unknown. */ }
    const pendingOperation = pending(machineID), last = db.get<any>("SELECT id,status FROM machine_agent_updates WHERE machine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", machineID);
    let target: AgentRelease | undefined;
    try { target = catalog.list().find(release => release.arch === node?.arch); } catch { /* Do not advertise an invalid release directory. */ }
    const state = !agentID ? "not_installed" : pendingOperation ? "in_progress" : !agent_release?.artifact_sha256 || !target ? "unknown"
      : target.sha256 === agent_release.artifact_sha256 ? "current" : "update_available";
    return { agent_release, agent_update: { state, target_sha256: target?.sha256 ?? "", target_version: target?.version ?? "", last_status: last?.status ?? "", last_operation_id: last?.id ?? "" } };
  };
  return { listReleases: () => catalog.list(), assistantPlan: plan, assistantGet: (machineID, operationID) => view(row(machineID, operationID)), list, pending, assertFree, machineState,
    async close() { controller.abort(); await Promise.allSettled([...running.values(), ...rolloutWorkers.values()]); } };
}
