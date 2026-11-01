import { createReadStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fail, HTTPError } from "../shared/http.js";
import { canonicalJSON, sha256, strictRecord, PRIVILEGED_CAPABILITIES, type PrivilegedCapability } from "../shared/privileged-executor.js";
import type { Context, Dependencies, Module } from "../shared/types.js";
import type { MachineSummary, SSHCheckResult } from "./managed-machines.js";
import type { AgentUpdateAccess } from "./machine-agent-updates.js";
import { AgentReleaseCatalog } from "./machine-agent-updates-catalog.js";
import { hasActiveTaskRuns } from "./agent-hosts.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { assertNoPendingMachineInstallation } from "./machine-installations-guard.js";
import { assertNoPendingMachineUninstallation } from "./machine-uninstallations-guard.js";
import { assertNoDockerInstallation } from "./machine-docker-guard.js";
import type { PrivilegedExecutorStore } from "./privileged-executors.js";
import { executorHostLockShell, executorAbsenceProofShell } from "./executor-absence-shell.js";

type Row = Record<string, any>;
interface Access extends AgentUpdateAccess {
  check(machineID: string, input: {credential_id?:string}, actor: string, signal: AbortSignal): Promise<SSHCheckResult>;
}
const q = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const WORKING = "('running','verifying','unknown')";
// Must match the non-secret binding evidence recorded by checkSSH. Usage times
// are deliberately excluded: a check must not invalidate itself by using a key.
const credentialRevision = (value: Row) => sha256(JSON.stringify([value.id,value.connection_credential_id ?? "",value.method,value.secret_fingerprint,value.retention,value.expires_at,value.revoked_at ?? "",value.secret_cleared_at ?? ""]));
const fields = (value: unknown, keys: string[], required = keys) => {
  try { return strictRecord(value, keys, required); } catch { fail(400, "invalid_executor_bootstrap_request"); }
};
const human = (deps: Dependencies, ctx: Context) => {
  deps.auth.requireAdmin(ctx);
  if (ctx.req.headers.authorization || !ctx.req.headers.cookie?.split(";").some(p => p.trim().startsWith("lm_session=")) || (deps.auth.user(ctx.req)?.id !== ctx.user.id || deps.auth.user(ctx.req)?.role !== "admin" || !deps.db.get("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'",ctx.user.id)))
    fail(403, "human_admin_session_required");
};
// Held by the SSH parent throughout installation and by absence probes. It is
// separate from the installer's lifecycle lock, so those locks never nest.
const bootstrapLock = executorHostLockShell("bootstrap");

/** A fixed read-only recovery probe. Absence is useful only while holding the
 * same dispatch fence as installation; elapsed time or a missing PID is not proof. */
export function executorBootstrapAbsentCommand(): string {
  const script = `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
[ "$(id -u)" = 0 ] || exit 1
${bootstrapLock}
${executorAbsenceProofShell}
printf 'executor_bootstrap_absent=verified\\n'
`;
  return `if [ "$(id -u)" = 0 ]; then /bin/sh -c ${q(script)}; else sudo -n /bin/sh -c ${q(script)}; fi`;
}

/** Only this fixed bootstrap command uses SSH. The ordinary Agent never sees
 * the enrollment token, executor key, root config, or root task output. */
export function executorBootstrapCommand(origin: string, operationID: string, artifact: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || !/^[a-f0-9-]{36}$/.test(operationID) || !/^[a-f0-9]{64}$/.test(artifact)) throw Error("invalid_bootstrap_target");
  const script = `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
[ "$(id -u)" = 0 ] || exit 1
for p in /run /opt /etc /var /var/lib; do
  [ ! -L "$p" ] && [ -d "$p" ] || exit 1
  stat -c '%u:%a' "$p" | awk -F: '$1==0 && $2 ~ /^([0-7])?[0-7][0145][0145]$/ {ok=1} END {exit !ok}' || exit 1
done
${bootstrapLock}
work=$(mktemp -d /opt/lightmoni-executor-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
IFS= read -r enrollment
case "$enrollment" in lm_executor_enroll_*) ;; *) exit 1;; esac
printf 'header = "Authorization: Bearer %s"\\n' "$enrollment" > "$work/curl.conf"
unset enrollment
cat > "$work/bootstrap.json"
curl --config "$work/curl.conf" --proto '=https' --max-redirs 0 --connect-timeout 15 --max-time 180 --fail --silent --show-error --output "$work/bundle.tar.gz" ${q(origin + "/downloads/executor-bootstrap/" + operationID + "/bundle.tar.gz")}
printf '%s  %s\\n' ${q(artifact)} "$work/bundle.tar.gz" | sha256sum -c - >/dev/null
tar -tzf "$work/bundle.tar.gz" | awk 'BEGIN {n=0} /^\\// || /(^|\\/)\\.\\.(\\/|$)/ {exit 1} !/^(lightmoni-agent|lightmoni-agent.service|lightmoni-agent-runtime)(\\/|$)/ {exit 1} {n++} END {if(n<1)exit 1}'
mkdir "$work/unpacked"
tar -xzf "$work/bundle.tar.gz" --no-same-owner --no-same-permissions -C "$work/unpacked"
[ -f "$work/unpacked/lightmoni-agent-runtime/executor/install.sh" ] && [ ! -L "$work/unpacked/lightmoni-agent-runtime/executor/install.sh" ] || exit 1
/bin/sh "$work/unpacked/lightmoni-agent-runtime/executor/install.sh" --release-dir "$work/unpacked/lightmoni-agent-runtime" --artifact-sha256 ${q(artifact)} < "$work/bootstrap.json"
`;
  return `if [ "$(id -u)" = 0 ]; then /bin/sh -c ${q(script)}; else sudo -n /bin/sh -c ${q(script)}; fi`;
}

export function registerMachineExecutorBootstrap(deps: Dependencies, access: Access, executors: PrivilegedExecutorStore,
  options: {downloadsDir:string;dataDir:string}): Module {
  const {db, router} = deps, now = () => deps.now().toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS machine_executor_bootstraps(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,
    status TEXT NOT NULL,plan_json TEXT NOT NULL,revision TEXT NOT NULL,executor_id TEXT NOT NULL DEFAULT '',
    install_generation INTEGER NOT NULL DEFAULT 0,request_id TEXT NOT NULL DEFAULT '',token_hash TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,expires_at TEXT NOT NULL,started_at TEXT NOT NULL DEFAULT '',finished_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS executor_bootstrap_lane ON machine_executor_bootstraps(machine_id) WHERE status IN ${WORKING};`);
  if(!db.all<{name:string}>("PRAGMA table_info(machine_executor_bootstraps)").some(column=>column.name==="install_generation"))
    db.exec("ALTER TABLE machine_executor_bootstraps ADD COLUMN install_generation INTEGER NOT NULL DEFAULT 0");
  // Lost process ownership cannot be reconstructed by issuing another token.
  db.run("UPDATE machine_executor_bootstraps SET status='unknown',token_hash='',error='平台在安装期间重启，请只读核对；不会自动重试' WHERE status IN ('running','verifying')");
  const catalog = new AgentReleaseCatalog(options.downloadsDir, join(options.dataDir,"executor-bootstrap-cache"));
  const abort = new AbortController(), workers = new Set<Promise<void>>();
  const pending = (machineID: string) => db.get<Row>("SELECT id FROM machine_executor_bootstraps WHERE machine_id=? AND status IN " + WORKING, machineID);
  const row = (machineID: string, operationID: string) => {
    const r = db.get<Row>("SELECT * FROM machine_executor_bootstraps WHERE id=? AND machine_id=?", operationID,machineID);
    if (!r) fail(404,"executor_bootstrap_not_found"); return r;
  };
  const view = (r: Row) => ({id:r.id,status:r.status,revision:r.revision,expires_at:r.expires_at,executor_id:r.executor_id,install_generation:r.install_generation,
    plan:JSON.parse(r.plan_json),created_at:r.created_at,started_at:r.started_at,finished_at:r.finished_at,error:r.error});
  const target = (machine: MachineSummary) => {
    if (!machine.agent_id) fail(409,"请先安装普通 Agent，再开启提权执行能力");
    assertNoPendingAgentUpdate(db,machine.agent_id,machine.id);
    assertNoPendingMachineInstallation(db,machine.id,machine.agent_id,true);
    assertNoPendingMachineUninstallation(db,machine.id,machine.agent_id);
    assertNoDockerInstallation(db,machine.id,machine.agent_id);
    if (hasActiveTaskRuns(db,machine.agent_id,machine.id) || db.get("SELECT 1 FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",machine.agent_id))
      fail(409,"主机存在未结束或待核对的任务");
  };
  const prepare = async (machineID:string, value:unknown, actor:string, signal:AbortSignal) => {
    const input = fields(value,["credential_id","capabilities"],["capabilities"]);
    if (input.credential_id !== undefined && (typeof input.credential_id !== "string" || !input.credential_id)) fail(400,"invalid_credential_id");
    if (!Array.isArray(input.capabilities) || !input.capabilities.length || input.capabilities.length>PRIVILEGED_CAPABILITIES.length || input.capabilities.some(x=>!PRIVILEGED_CAPABILITIES.includes(x)) || new Set(input.capabilities).size!==input.capabilities.length) fail(400,"invalid_capabilities");
    let endpoint: URL; try { endpoint = new URL(deps.externalURL); } catch { fail(409,"https_center_origin_required"); }
    if (endpoint.protocol!=="https:" || endpoint.pathname!=="/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) fail(409,"https_center_origin_required");
    access.idle(machineID); const machine = access.get(machineID); target(machine);
    if (pending(machineID)) fail(409,"executor_bootstrap_pending");
    if (executors.getStatus(machineID).executor && executors.getStatus(machineID).executor?.state!=="revoked") fail(409,"执行器已有身份，请核对原安装或明确卸载后恢复");
    const check = await access.check(machineID,{credential_id:input.credential_id},actor,signal);
    if (!check.ready || !["root","sudo_noninteractive"].includes(check.privilege.state)) fail(409,"SSH 账户需要 root 或无交互 sudo 安装权限");
    const refreshed = access.get(machineID), selected = access.credential(machineID,check.credential_id);
    target(refreshed); if (pending(machineID)) fail(409,"executor_bootstrap_pending");
    signal.throwIfAborted();
    if (refreshed.agent_id!==machine.agent_id || refreshed.name!==machine.name || check.privilege.machine_revision!==access.revision(refreshed)
      || check.privilege.credential_binding_revision!==credentialRevision(selected.credential)) fail(409,"executor_bootstrap_target_changed");
    if (executors.getStatus(machineID).executor && executors.getStatus(machineID).executor?.state!=="revoked") fail(409,"执行器已有身份，请核对原安装或明确卸载后恢复");
    const release = catalog.list().find(r=>r.arch===check.arch);
    if (!release) fail(409,"没有与目标架构匹配的 Agent 发行包，请先构建并发布");
    const pinned = catalog.pinBundle(release.sha256), id = randomUUID(), expires = new Date(deps.now().getTime()+300_000).toISOString();
    const policy = executors.preparePolicyPlan(machineID,{capabilities:input.capabilities},actor);
    const plan = {machine:{id:refreshed.id,name:refreshed.name,address:refreshed.address,port:refreshed.port,username:refreshed.username,agent_id:refreshed.agent_id},
      capabilities:[...input.capabilities].sort(),release:pinned.release,file:pinned.file,
      target_revision:access.revision(refreshed),credential_id:selected.credential.id,check_id:check.id,privilege:check.privilege,
      policy_plan:{id:policy.id,revision:policy.revision},steps:["复核 SSH 安装权限及主机身份","校验审批固定的同一 Agent 发行包","安装独立 root 执行器与身份","验证独立签名心跳和程序构建身份"],expires_at:expires};
    const revision = sha256(canonicalJSON(plan));
    db.run("INSERT INTO machine_executor_bootstraps(id,machine_id,agent_id,credential_id,status,plan_json,revision,created_by,created_at,expires_at) VALUES(?,?,?,?,'awaiting_approval',?,?,?,?,?)",
      id,machineID,refreshed.agent_id,selected.credential.id,canonicalJSON(plan),revision,actor,now(),expires);
    return view(row(machineID,id));
  };
  const refresh = (r:Row) => {
    if (!["verifying","unknown"].includes(r.status) || !r.executor_id) return r;
    const status = executors.getStatus(r.machine_id), e = status.executor, p = JSON.parse(r.plan_json);
    const release = (e as any)?.release;
    if (e && e.id === r.executor_id && e.install_generation===r.install_generation && e.online && Date.parse(e.last_seen)>=Date.parse(r.started_at)
      && release?.build_id===p.release.build_id && release.source_revision===p.release.source_revision && release.artifact_sha256===p.release.sha256) {
      db.run("UPDATE machine_executor_bootstraps SET status='succeeded',finished_at=?,token_hash='',error='' WHERE id=? AND status IN ('verifying','unknown')",now(),r.id);
    }
    return row(r.machine_id,r.id);
  };
  const apply = async (machineID:string,operationID:string,value:unknown,actor:string,signal:AbortSignal) => {
    const input = fields(value,["confirm","expected_revision","request_id"]);
    if (input.confirm!==true || typeof input.request_id!=="string" || !/^[a-f0-9-]{36}$/.test(input.request_id)) fail(400,"explicit_confirmation_and_request_id_required");
    const saved = row(machineID,operationID);
    if (input.expected_revision!==saved.revision) fail(409,"executor_bootstrap_plan_changed");
    let plan:Row;
    try { plan=JSON.parse(saved.plan_json); if (sha256(canonicalJSON(plan))!==saved.revision) throw Error(); }
    catch { fail(409,"executor_bootstrap_plan_changed"); }
    if (saved.request_id) {
      if (saved.request_id!==input.request_id) fail(409,"executor_bootstrap_already_applied");
      return view(refresh(saved));
    }
    if (saved.status!=="awaiting_approval" || Date.parse(saved.expires_at)<=deps.now().getTime()) fail(409,"executor_bootstrap_expired");
    access.idle(machineID); const machine=access.get(machineID); target(machine);
    if (pending(machineID) || access.revision(machine)!==plan.target_revision || machine.agent_id!==saved.agent_id || machine.name!==plan.machine.name) fail(409,"executor_bootstrap_target_changed");
    const {credential}=access.credential(machineID,saved.credential_id);
    if (credentialRevision(credential)!==plan.privilege?.credential_binding_revision) fail(409,"executor_bootstrap_credential_changed");
    // Fresh preflight repeats actual identity/UID/sudo checks before approval is committed.
    const check=await access.check(machineID,{credential_id:credential.id},actor,signal);
    if (!check.ready || check.arch!==plan.release.arch || !["root","sudo_noninteractive"].includes(check.privilege.state)
      || check.privilege.state!==plan.privilege.state) fail(409,"executor_bootstrap_privilege_changed");
    const assertCurrent=()=>{
      const current=access.get(machineID),selected=access.credential(machineID,saved.credential_id).credential;
      if (Date.parse(saved.expires_at)<=deps.now().getTime()) fail(409,"executor_bootstrap_expired");
      if (access.revision(current)!==plan.target_revision || current.agent_id!==saved.agent_id || current.name!==plan.machine.name
        || check.privilege.machine_revision!==plan.target_revision) fail(409,"executor_bootstrap_target_changed");
      if (check.privilege.credential_binding_revision!==plan.privilege.credential_binding_revision
        || credentialRevision(selected)!==plan.privilege.credential_binding_revision) fail(409,"executor_bootstrap_credential_changed");
      return current;
    };
    assertCurrent();
    catalog.verify(plan.file);
    access.busy.add(machineID);
    let bootstrap:ReturnType<PrivilegedExecutorStore["issueBootstrap"]>;
    try {
      bootstrap=db.transaction(()=>{
        const current=row(machineID,operationID);
        if (current.request_id || current.status!=="awaiting_approval" || pending(machineID)) fail(409,"executor_bootstrap_already_applied");
        target(assertCurrent());
        executors.applyPolicy(machineID,plan.policy_plan.id,{confirm:true,expected_revision:plan.policy_plan.revision},actor,true);
        const enrollment=executors.issueBootstrap(machineID,plan.capabilities as PrivilegedCapability[],actor,true);
        db.run("UPDATE machine_executor_bootstraps SET status='running',request_id=?,executor_id=?,install_generation=?,token_hash=?,started_at=? WHERE id=?",
          input.request_id,enrollment.executor_id,enrollment.install_generation,sha256(enrollment.enrollment_token),now(),operationID);
        return enrollment;
      });
    } catch (e) {access.busy.delete(machineID);throw e;}
    const worker=(async()=>{
      try {
        await access.runner({machine,credentialID:credential.id,...access.authentication(machineID,credential),
          command:executorBootstrapCommand(new URL(deps.externalURL).origin,operationID,plan.release.sha256),
          stdin:bootstrap.enrollment_token+"\n"+canonicalJSON(bootstrap),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(240_000)]),port:machine.port,timeoutMs:240_000});
        access.markCredentialUsed(credential.id);
        db.run("UPDATE machine_executor_bootstraps SET status='verifying',token_hash='' WHERE id=? AND status='running'",operationID);
        refresh(row(machineID,operationID));
      } catch {
        // Never serialize an SSH exception: it may contain remote output or secret input.
        executors.markBootstrapUnknown(bootstrap.executor_id);
        db.run("UPDATE machine_executor_bootstraps SET status='unknown',token_hash='',error='安装结果未知，请只读核对；不会自动重试' WHERE id=? AND status IN ('running','verifying')",operationID);
      } finally {access.busy.delete(machineID);}
    })();
    workers.add(worker);void worker.finally(()=>workers.delete(worker));
    return view(row(machineID,operationID));
  };
  const reconcile = async (ctx: Context) => {
    human(deps,ctx);
    const input = fields(await ctx.body(),["confirm","credential_id"],["confirm"]);
    if (input.confirm!==true) fail(400,"explicit_confirmation_required");
    if (input.credential_id!==undefined && (typeof input.credential_id!=="string" || !input.credential_id)) fail(400,"invalid_credential_id");
    const saved=row(ctx.params.id,ctx.params.planId);
    if (saved.status!=="unknown") fail(409,"only_unknown_bootstrap_can_be_reconciled");
    let plan:Row;
    try { plan=JSON.parse(saved.plan_json);if(sha256(canonicalJSON(plan))!==saved.revision)throw Error(); }
    catch { fail(409,"executor_bootstrap_plan_changed"); }
    access.idle(saved.machine_id);
    const selected=access.credential(saved.machine_id,input.credential_id??saved.credential_id), binding=credentialRevision(selected.credential);
    const assertCurrent=()=>{
      const current=access.get(saved.machine_id), credential=access.credential(saved.machine_id,selected.credential.id).credential;
      const identity=db.get<Row>("SELECT * FROM privileged_executors WHERE id=?",saved.executor_id);
      if (access.revision(current)!==plan.target_revision || current.name!==plan.machine.name || current.agent_id!==saved.agent_id
        || !identity || identity.machine_id!==saved.machine_id || identity.agent_id!==saved.agent_id
        || !saved.install_generation || identity.install_generation!==saved.install_generation
        || executors.getStatus(saved.machine_id).executor?.id!==saved.executor_id) fail(409,"executor_bootstrap_target_changed");
      if (credentialRevision(credential)!==binding) fail(409,"executor_bootstrap_credential_changed");
      return {machine:current,credential};
    };
    const {machine,credential}=assertCurrent();
    access.busy.add(saved.machine_id);
    try {
      let output:string;
      try {
        const result=await access.runner({machine,credentialID:credential.id,...access.authentication(saved.machine_id,credential),
          command:executorBootstrapAbsentCommand(),signal:AbortSignal.any([ctx.signal,abort.signal,AbortSignal.timeout(60_000)]),port:machine.port,timeoutMs:60_000});
        output=result.stdout;
      } catch { fail(409,"executor_bootstrap_absence_unverified"); }
      if(output.trim()!=="executor_bootstrap_absent=verified")fail(409,"executor_bootstrap_absence_unverified");
      human(deps,ctx);assertCurrent();
      const result=db.transaction(()=>{
        human(deps,ctx);
        const current=row(saved.machine_id,saved.id);
        if(current.status!=="unknown" || current.revision!==saved.revision || current.executor_id!==saved.executor_id
          || current.install_generation!==saved.install_generation)fail(409,"executor_bootstrap_state_changed");
        assertCurrent();
        // Release only this operation's fence. revokeExecutor then checks every
        // other lifecycle/task fence in this same transaction before revocation.
        db.run("UPDATE machine_executor_bootstraps SET status='failed',finished_at=?,token_hash='',error=? WHERE id=?",now(),
          "已只读确认远端未安装，原安装结束；未执行安装或删除",saved.id);
        executors.revokeExecutor(saved.machine_id,saved.executor_id,ctx.user.id,true);
        return view(row(saved.machine_id,saved.id));
      });
      access.markCredentialUsed(credential.id);
      return result;
    } finally {access.busy.delete(saved.machine_id);}
  };
  router.post("/api/v1/machines/:id/executor-bootstrap/plan",access.safe(async c=>{human(deps,c);c.json(await prepare(c.params.id,await c.body(),c.user.id,c.signal));}));
  router.post("/api/v1/machines/:id/executor-bootstrap/plans/:planId/apply",access.safe(async c=>{human(deps,c);c.json(await apply(c.params.id,c.params.planId,await c.body(),c.user.id,c.signal));}));
  router.post("/api/v1/machines/:id/executor-bootstrap/plans/:planId/reconcile",access.safe(async c=>{c.json(await reconcile(c));}));
  router.get("/api/v1/machines/:id/executor-bootstrap/plans",access.safe(c=>{human(deps,c);access.get(c.params.id);c.json(db.all<Row>("SELECT * FROM machine_executor_bootstraps WHERE machine_id=? ORDER BY created_at DESC LIMIT 30",c.params.id).map(r=>view(refresh(r))));}));
  router.get("/api/v1/machines/:id/executor-bootstrap/plans/:planId",access.safe(c=>{human(deps,c);c.json(view(refresh(row(c.params.id,c.params.planId))));}));
  router.get("/downloads/executor-bootstrap/:operationId/bundle.tar.gz",access.safe(async c=>{
    const authorization=c.req.headers.authorization;
    if (typeof authorization!=="string" || !authorization.startsWith("Bearer ")) fail(401,"bootstrap_ticket_required");
    const r=db.get<Row>("SELECT * FROM machine_executor_bootstraps WHERE id=?",c.params.operationId);
    // Approval expiry gates starting the operation, not a download already
    // authorized by that start. The separate dispatch window remains bounded.
    if (!r || r.status!=="running" || !r.token_hash || !Number.isFinite(Date.parse(r.started_at))
      || Date.parse(r.started_at)>deps.now().getTime() || Date.parse(r.started_at)+240_000<=deps.now().getTime()
      || sha256(authorization.slice(7))!==r.token_hash) fail(403,"bootstrap_ticket_invalid");
    const p=JSON.parse(r.plan_json),path=catalog.verify(p.file);
    c.res.statusCode=200;c.res.setHeader("Content-Type","application/gzip");c.res.setHeader("Content-Length",p.file.size);c.res.setHeader("Cache-Control","no-store");
    await pipeline(createReadStream(path),c.res);
  }),{public:true});
  return {async close(){abort.abort();await Promise.allSettled([...workers]);}};
}
