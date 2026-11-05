import { id, hash } from '../shared/crypto.js';
import { fail } from '../shared/http.js';
import type { Dependencies, Handler } from '../shared/types.js';
import { agentRemovalProbeCommand, parseAgentRemovalProbe, type AgentRemovalObservation } from './machine-agent-lifecycle.js';
import { assertSSHAccount, sshAccountSnapshot, sshCredentialRevision, type SSHRunner } from './machine-ssh.js';
import type { MachineSummary, SSHMachineTarget } from './managed-machines.js';

type Row = Record<string, any>;
interface Access {
  get(id: string): MachineSummary; idle(id: string): void; revision(machine: MachineSummary): string;
  credential(machine: string, credential?: string): { machine: SSHMachineTarget; credential: any };
  authentication(machine: string, credential: any): { privateKey: string; password?: string };
  markCredentialUsed(id: string): void; busy: Set<string>; runner: SSHRunner; safe(handler: Handler): Handler;
}
export function createMachineStateRecoverySchema(deps: Dependencies) {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_state_recoveries(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,credential_id TEXT NOT NULL,
    status TEXT NOT NULL,plan_json TEXT NOT NULL,receipt_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,created_by TEXT NOT NULL,expires_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT ''
  ); CREATE INDEX IF NOT EXISTS machine_state_recovery_host ON machine_state_recoveries(machine_id,created_at);
  CREATE TABLE IF NOT EXISTS machine_state_recovery_jobs(
    recovery_id TEXT NOT NULL,job_id TEXT NOT NULL,agent_id TEXT NOT NULL,machine_id TEXT NOT NULL,
    previous_state TEXT NOT NULL,PRIMARY KEY(recovery_id,job_id)
  );`);
}

// The command emits no configuration, journal contents or process arguments.
export function agentStateRecoveryProbeCommand() {
  return `set -eu\n${agentRemovalProbeCommand()}\n` +
    `workers=$(systemctl list-units 'lightmoni-exec-*' 'lightmoni-agent-update-*' --state=active,activating,deactivating,reloading --plain --no-legend --no-pager)\n` +
    `test -z "$workers" || { echo 'Agent workers are still active' >&2; exit 42; }\nprintf 'LMRECOVERY=1\\n'`;
}
export function parseAgentStateRecoveryProbe(output: string): AgentRemovalObservation {
  const lines = output.trim().split(/\r?\n/);
  if (lines.pop() !== 'LMRECOVERY=1') fail(409, '无法确认 Agent 工作进程已停止，请先核对主机现场');
  const observed = parseAgentRemovalProbe(lines.join('\n'));
  if (observed.installation !== 'absent' || observed.service_running || observed.helper_present)
    fail(409, 'Agent 程序或服务仍存在，请先卸载；状态修正不会代替停止正在执行的程序');
  if (!observed.paths_safe || !observed.unit_managed || observed.lifecycle_locked || observed.operation_lock || observed.identity_state === 'unsafe' || observed.identity_state === 'invalid')
    fail(409, 'Agent 路径、身份或操作锁尚未核实，不能修正状态');
  return observed;
}

export function registerMachineStateRecovery(deps: Dependencies, access: Access) {
  createMachineStateRecoverySchema(deps);
  const { db, router } = deps, at = () => deps.now().toISOString();
  const has = (table: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
  const parse = (value: string) => JSON.parse(value);
  const body = async (ctx: any, fields: string[]) => {
    const input = await ctx.body();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail(400, 'invalid recovery request');
    return input;
  };
  const row = (machine: string, recovery: string) => {
    const value = db.get<Row>('SELECT * FROM machine_state_recoveries WHERE id=? AND machine_id=?', recovery, machine);
    if (!value) fail(404, '状态修正计划不存在');
    return value;
  };
  const view = (value: Row) => ({ id: value.id, machine_id: value.machine_id, agent_id: value.agent_id, credential_id: value.credential_id,
    status: value.status, plan: parse(value.plan_json), receipt: parse(value.receipt_json), created_at: value.created_at,
    created_by: value.created_by, expires_at: value.expires_at, finished_at: value.finished_at });
  const definitions = (machine: string, agent: string) => [
    { table: 'agent_jobs', where: "agent_id=? AND state NOT IN ('succeeded','failed','cancelled')", args: [agent], state: 'state' },
    { table: 'privileged_jobs', where: "(machine_id=? OR agent_id=?) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))", args: [machine, agent], state: 'state' },
    { table: 'task_runs', where: "(host_id=? OR agent_id=?) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))", args: [machine, agent], state: 'state' },
    { table: 'ops_platform_runs', where: "agent_id=? AND state IN ('queued','running','unknown')", args: [agent], state: 'state' },
    { table: 'machine_deployments', where: "machine_id=? AND status IN ('awaiting_approval','running','unknown') AND resolved_at=''", args: [machine], state: 'status' },
    ...['machine_uninstallations', 'machine_agent_updates', 'machine_agent_runtime_plans', 'machine_executor_bootstraps'].map(table =>
      ({ table, where: "machine_id=? AND status IN ('awaiting_approval','running','verifying','unknown')", args: [machine], state: 'status' })),
  ];
  const snapshot = (machine: string, agent: string) => {
    const entries: Row[] = [];
    for (const definition of definitions(machine, agent)) {
      if (!has(definition.table)) continue;
      const rows = db.all<Row>(`SELECT * FROM ${definition.table} WHERE ${definition.where} ORDER BY id LIMIT 1001`, ...definition.args);
      if (rows.length > 1000) fail(409, '待修正记录过多，请先分批核对任务');
      for (const value of rows) {
        if (value.agent_id && value.agent_id !== agent || value.machine_id && value.machine_id !== machine || value.host_id && value.host_id !== machine)
          fail(409, '待修正记录关联了不同主机或 Agent，请先核对归属');
        if (definition.state === 'status' && ['running', 'verifying'].includes(value.status))
          fail(409, '仍有执行中的主机维护，请等待维护停止后再核对');
        // Hash complete records to detect edits while exposing only safe metadata.
        entries.push({ table: definition.table, id: value.id, state: value[definition.state], code: value.code || '', revision: hash(JSON.stringify(value)) });
      }
    }
    const identities: Row[] = [];
    for (const table of ['privileged_executors', 'agent_enrollments', 'agent_credentials']) {
      if (!has(table)) continue;
      const values = table === 'privileged_executors'
        ? db.all<Row>("SELECT id,agent_id,install_generation,state FROM privileged_executors WHERE machine_id=? AND state!='revoked' ORDER BY id", machine)
        : table === 'agent_enrollments'
          ? db.all<Row>("SELECT id,agent_id,status FROM agent_enrollments WHERE machine_id=? AND status IN ('issued','pending_activation','active') ORDER BY id", machine)
          : db.all<Row>("SELECT id,agent_id,audience,revoked_at FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL ORDER BY id", agent);
      for (const value of values) {
        if (value.agent_id && value.agent_id !== agent) fail(409, '当前主机还有另一 Agent 的有效身份，不能结束其状态');
        identities.push({ table, ...value });
      }
    }
    return { entries, identities };
  };
  const verifyBinding = (machine: MachineSummary, observed: AgentRemovalObservation) => {
    if (!machine.agent_id || observed.agent_id && observed.agent_id !== machine.agent_id
      || db.get('SELECT id FROM managed_machines WHERE agent_id=? AND id<>? LIMIT 1', machine.agent_id, machine.id))
      fail(409, '远端身份与当前主机关联不一致，不能修正另一身份');
  };
  const probe = async (machine: SSHMachineTarget, credential: any, signal: AbortSignal) => {
    const output = await access.runner({ machine, credentialID: credential.id, ...access.authentication(machine.id, credential),
      command: agentStateRecoveryProbeCommand(), signal, port: machine.port, timeoutMs: 60_000 });
    access.markCredentialUsed(credential.id);
    const observed = parseAgentStateRecoveryProbe(output.stdout), live = access.credential(machine.id, credential.id);
    assertSSHAccount(live.machine, sshAccountSnapshot(machine));
    if (sshCredentialRevision(live.credential) !== sshCredentialRevision(credential)) fail(409, 'recovery_credential_changed');
    verifyBinding(access.get(machine.id), observed);
    return observed;
  };
  const annotate = (table: string, entry: Row, detail: Row) => {
    const previous = db.get<Row>(`SELECT * FROM ${table} WHERE id=?`, entry.id)!;
    db.run(`UPDATE ${table} SET receipt_json=? WHERE id=?`, JSON.stringify({ ...parse(previous.receipt_json), state_recovery: { ...detail, ...(previous.error ? { previous_error: previous.error } : {}) } }), entry.id);
  };
  const correct = (machine: MachineSummary, plan: Row, recovery: string, actor: string) => {
    const detail = { recovery_id: recovery, at: at(), actor_id: actor, reason: plan.reason, remote_absent: true };
    for (const entry of plan.effects.entries) {
      const queued = ['queued', 'awaiting_approval'].includes(entry.state), next = queued ? 'cancelled' : 'unknown';
      if (entry.table === 'agent_jobs') {
        annotate(entry.table, entry, { ...detail, previous_state: entry.state });
        db.run('UPDATE agent_jobs SET state=?,updated_at=? WHERE id=?', next, at(), entry.id);
        db.run('INSERT INTO machine_state_recovery_jobs VALUES(?,?,?,?,?)', recovery, entry.id, machine.agent_id, machine.id, entry.state);
      } else if (entry.table === 'privileged_jobs') {
        db.run("UPDATE privileged_jobs SET state=?,resolved_at=?,resolved_by=?,resolution_reason=?,cancel_requested=1,finished_at=CASE WHEN finished_at='' THEN ? ELSE finished_at END WHERE id=?",
          next, at(), actor, plan.reason, at(), entry.id);
      } else if (entry.table === 'task_runs') {
        db.run("UPDATE task_runs SET state=?,resolved_at=?,resolved_by=?,resolution_reason=?,cancel_requested=1,auto_retry_closed=1,lease_hash='',finished_at=CASE WHEN finished_at='' THEN ? ELSE finished_at END WHERE id=?",
          next, at(), actor, plan.reason, at(), entry.id);
      } else if (entry.table === 'ops_platform_runs') {
        const previous = db.get<Row>('SELECT result_json FROM ops_platform_runs WHERE id=?', entry.id)!;
        db.run('UPDATE ops_platform_runs SET state=?,result_json=?,updated_at=? WHERE id=?', next,
          JSON.stringify({ ...parse(previous.result_json), state_recovery: { ...detail, previous_state: entry.state } }), at(), entry.id);
      } else {
        annotate(entry.table, entry, { ...detail, previous_state: entry.state });
        if (entry.table === 'machine_deployments')
          db.run('UPDATE machine_deployments SET status=?,resolved_at=?,resolved_by=?,resolution_reason=?,finished_at=? WHERE id=?', queued ? 'cancelled' : 'unknown', at(), actor, plan.reason, at(), entry.id);
        else {
          db.run(`UPDATE ${entry.table} SET status=?,finished_at=?,error=?${entry.table === 'machine_agent_updates' ? ",ticket_hash=''" : ''} WHERE id=?`,
            queued ? 'cancelled' : 'failed', at(), '管理员已核实 Agent 移除并修正状态；原结果见恢复审计', entry.id);
        }
      }
    }
    const revoked = has('agent_credentials') ? db.run("UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=? AND revoked_at IS NULL", at(), 'Verified absent Agent; state recovery ' + recovery, machine.agent_id).changes : 0;
    if (has('agent_enrollments')) db.run("UPDATE agent_enrollments SET status='cancelled' WHERE machine_id=? AND status IN ('issued','pending_activation','active') AND (agent_id='' OR agent_id=?)", machine.id, machine.agent_id);
    if (has('privileged_executors')) {
      db.run("UPDATE privileged_executors SET state='revoked' WHERE machine_id=? AND agent_id=?", machine.id, machine.agent_id);
      if (has('privileged_enrollments')) db.run("UPDATE privileged_enrollments SET state='revoked' WHERE state='issued' AND executor_id IN (SELECT id FROM privileged_executors WHERE machine_id=? AND agent_id=?)", machine.id, machine.agent_id);
      if (has('privileged_machine_policies')) db.run("UPDATE privileged_machine_policies SET generation=generation+1,capabilities_json='[]',approved_by=?,updated_at=? WHERE machine_id=? AND agent_id=?", actor, at(), machine.id, machine.agent_id);
      if (has('privileged_audit')) db.run("INSERT INTO privileged_audit VALUES(?,?,?,?,'agent_state_recovered',?,?)", id(), machine.id, '', actor, at(), JSON.stringify(detail));
    }
    db.run("INSERT INTO agent_lifecycle VALUES(?,'removed',?,?,?) ON CONFLICT(agent_id) DO UPDATE SET state='removed',removed_at=excluded.removed_at,removed_by=excluded.removed_by,removal_reason=excluded.removal_reason", machine.agent_id, at(), actor, plan.reason);
    db.run("INSERT INTO agent_lifecycle_events VALUES(?,?,'removed',?,?,?,?)", id(), machine.agent_id, actor, at(), plan.reason, revoked);
    db.run("UPDATE managed_machines SET agent_last_seen='',last_error='',updated_at=? WHERE id=?", at(), machine.id);
    return { ...detail, credentials_revoked: revoked, corrected_records: plan.effects.entries.length, data_retained: true, business_data_retained: true };
  };
  const base = '/api/v1/machines/:id/state-recoveries';
  router.get(base, access.safe(ctx => { deps.auth.requireAdmin(ctx); access.get(ctx.params.id);
    ctx.json(db.all<Row>('SELECT * FROM machine_state_recoveries WHERE machine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50', ctx.params.id).map(view)); }));
  router.post(base + '/plan', access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = await body(ctx, ['credential_id', 'reason']);
    if (typeof input.reason !== 'string' || !input.reason.trim() || Buffer.byteLength(input.reason) > 1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) fail(400, '请填写人工核查及状态修正原因');
    access.idle(ctx.params.id);
    if (db.get("SELECT id FROM machine_state_recoveries WHERE machine_id=? AND status='awaiting_approval' AND expires_at>?", ctx.params.id, at())) fail(409, '已有待审阅状态修正计划，请继续审阅或取消');
    const { machine, credential } = access.credential(ctx.params.id, input.credential_id), revision = access.revision(machine);
    access.busy.add(machine.id);
    try {
      const observed = await probe(machine, credential, ctx.signal), current = access.get(machine.id);
      if (access.revision(current) !== revision || current.agent_id !== machine.agent_id || current.name !== machine.name) fail(409, 'recovery_target_changed');
      const expires = new Date(deps.now().getTime() + 300_000).toISOString(), recovery = id();
      db.transaction(() => {
        db.run("UPDATE machine_state_recoveries SET status='expired',finished_at=? WHERE machine_id=? AND status='awaiting_approval' AND expires_at<=?", at(), machine.id, at());
        if (db.get("SELECT id FROM machine_state_recoveries WHERE machine_id=? AND status='awaiting_approval' AND expires_at>?", machine.id, at())) fail(409, '已有待审阅状态修正计划，请继续审阅或取消');
        const plan = { machine: { id: machine.id, name: machine.name, agent_id: machine.agent_id, address: machine.address, port: machine.port }, reason: input.reason.trim(), target_revision: revision,
          ssh_account: sshAccountSnapshot(machine), credential_revision: sshCredentialRevision(credential), observation: observed, effects: snapshot(machine.id, machine.agent_id), expires_at: expires };
        db.run("INSERT INTO machine_state_recoveries(id,machine_id,agent_id,credential_id,status,plan_json,created_at,created_by,expires_at) VALUES(?,?,?,?,'awaiting_approval',?,?,?,?)", recovery, machine.id, machine.agent_id, credential.id, JSON.stringify(plan), at(), ctx.user.id, expires);
      });
      ctx.json(view(row(machine.id, recovery)), 201);
    } finally { access.busy.delete(machine.id); }
  }));
  router.post(base + '/:recoveryId/cancel', access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); await body(ctx, []); const saved = row(ctx.params.id, ctx.params.recoveryId);
    if (!['awaiting_approval', 'cancelled'].includes(saved.status)) fail(409, '该状态修正已完成，不能取消');
    db.run("UPDATE machine_state_recoveries SET status='cancelled',finished_at=? WHERE id=? AND status='awaiting_approval'", at(), saved.id); ctx.json(view(row(saved.machine_id, saved.id)));
  }));
  router.post(base + '/:recoveryId/apply', access.safe(async ctx => {
    deps.auth.requireAdmin(ctx); const input = await body(ctx, ['confirm', 'confirm_name']), saved = row(ctx.params.id, ctx.params.recoveryId), plan = parse(saved.plan_json);
    if (input.confirm !== true || input.confirm_name !== plan.machine.name) fail(400, '请明确确认并输入计划中的主机名称');
    if (saved.status === 'succeeded') { ctx.json(view(saved)); return; }
    if (saved.status !== 'awaiting_approval' || saved.expires_at <= at()) fail(409, '状态修正计划已取消或过期，请重新核对');
    access.idle(saved.machine_id);
    const { machine, credential } = access.credential(saved.machine_id, saved.credential_id);
    const unchanged = () => {
      const current = access.get(machine.id), live = access.credential(machine.id, credential.id);
      assertSSHAccount(live.machine, plan.ssh_account);
      if (access.revision(current) !== plan.target_revision || current.name !== plan.machine.name || current.agent_id !== saved.agent_id
        || sshCredentialRevision(live.credential) !== plan.credential_revision) fail(409, 'recovery_target_changed');
      if (JSON.stringify(snapshot(machine.id, saved.agent_id)) !== JSON.stringify(plan.effects)) fail(409, '修正影响清单已变化，请取消原计划后重新核对');
    };
    unchanged(); access.busy.add(machine.id);
    try {
      const observed = await probe(machine, credential, ctx.signal);
      if (JSON.stringify(observed) !== JSON.stringify(plan.observation)) fail(409, '远端 Agent 证据已变化，请重新核对');
      db.transaction(() => {
        const current = row(machine.id, saved.id);
        if (current.status !== 'awaiting_approval' || current.expires_at <= at()) fail(409, '状态修正计划已变化或过期');
        unchanged();
        const receipt = correct(machine, plan, saved.id, ctx.user.id);
        db.run("UPDATE machine_state_recoveries SET status='succeeded',receipt_json=?,finished_at=? WHERE id=?", JSON.stringify(receipt), at(), saved.id);
      });
      ctx.json(view(row(machine.id, saved.id)));
    } finally { access.busy.delete(machine.id); }
  }));
}
