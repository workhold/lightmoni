import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DB } from '../src/shared/sqlite.js';
import { Router, fail } from '../src/shared/http.js';
import { cipher } from '../src/shared/crypto.js';
import type { Dependencies } from '../src/shared/types.js';
import { NodeStore } from '../src/server/nodes-model.js';
import { registerManagedMachines, type SSHRunner } from '../src/server/managed-machines.js';
import { registerAgentCredentials } from '../src/server/agent-credentials.js';
import { registerAgentJobs } from '../src/server/agent-jobs.js';
import { TaskRunStore } from '../src/server/task-center.js';
import { PrivilegedExecutorStore } from '../src/server/privileged-executors.js';
import { OperationsPlatformStore } from '../src/ops/store.js';
import { blockingAgentJobSQL } from '../src/server/agent-job-fence.js';
import { maintenanceWorkBusy, pendingMaintenancePreparation } from '../src/server/machine-maintenance.js';
import { replaceableAgentBinding } from '../src/server/agent-hosts.js';
import { parseAgentStateRecoveryProbe, agentStateRecoveryProbeCommand } from '../src/server/machine-state-recovery.js';
import { fixturePrivateKey } from './helpers/ssh-key.js';

const observation = (extra: Record<string, string> = {}) => Object.entries({ LMREMOVE: '1', agent_id: 'old-agent', identity_state: 'valid', identity_sha256: 'a'.repeat(64), program_sha256: 'b'.repeat(64), helper_present: '0', installation: 'absent', program_complete: '0', unit_managed: '1', service_running: '0', lifecycle_locked: '0', operation_lock: '0', paths_safe: '1', config_present: '1', data_present: '1', agent_state_present: '1', business_data_retained: '1', ...extra }).map(([key, value]) => `${key}=${value}`).join('\n') + '\nLMRECOVERY=1\n';

async function fixture(t: any) {
  const db = new DB(':memory:'), router = new Router(), user = { id: 'admin', name: 'Admin', role: 'admin' };
  let clock = new Date(), output = observation(), beforeReturn: (() => void) | undefined, probes = 0;
  const deps = { db, router, ...cipher(Buffer.alloc(32, 9)), now: () => clock, externalURL: 'https://platform.example.test', auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== 'admin') fail(403, 'administrator required'); } }, logger: { info() {}, warn() {}, error() {} } } as unknown as Dependencies;
  router.auth = deps.auth;
  new NodeStore(db, deps.now);
  const credentials = registerAgentCredentials(deps), executors = new PrivilegedExecutorStore(deps, { dataDir: '/not-used' });
  const jobs = registerAgentJobs(deps, { agentCredentials: credentials });
  new TaskRunStore(deps, credentials); new OperationsPlatformStore(deps, jobs);
  const commands: string[] = [];
  const runner: SSHRunner = async input => { commands.push(input.command); probes++; beforeReturn?.(); return { stdout: output, stderr: '', stages: [] }; };
  const machines = registerManagedMachines(deps, { agentCredentials: credentials, sshRunner: runner });
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  t.after(async () => { await machines.close?.(); executors.close(); await jobs.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const request = async (path: string, method = 'GET', value?: any) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    const text = await r.text(); return { status: r.status, text, data: JSON.parse(text) };
  };
  const made = await request('/machines', 'POST', { name: 'zz-bj-1', address: 'host.example.test' }); assert.equal(made.status, 201, made.text);
  const machine = made.data.id, agent = 'old-agent', now = clock.toISOString();
  const issue = credentials.issueEnrollment({ endpoint_origin: deps.externalURL, version: '0.1.0', created_by: 'admin', machine_id: machine });
  db.run("UPDATE managed_machines SET agent_id=?,host_key_fingerprint='SHA256:fixture' WHERE id=?", agent, machine);
  db.run("INSERT INTO agents VALUES(?,?,'os-name','0.1.0','linux','amd64',?,'{}')", agent, machine, now);
  const account = await request(`/machines/${machine}/accounts`, 'POST', { username: 'root', make_default: true }); assert.equal(account.status, 201, account.text);
  const credential = await request(`/machines/${machine}/accounts/${account.data.id}/credentials`, 'POST', { method: 'ssh_key', secret: fixturePrivateKey(), confirm_managed: true }); assert.equal(credential.status, 201, credential.text);
  db.run("INSERT INTO agent_credentials(id,agent_id,audience,scope,token_hash,created_at,expires_at) VALUES('control',?,'control','agent.control','not-a-secret',?,?)", agent, now, new Date(clock.getTime() + 3600000).toISOString());
  db.run("UPDATE agent_enrollments SET agent_id=?,status='active' WHERE id=?", agent, issue.enrollment_id);
  db.run("INSERT INTO privileged_executors(id,machine_id,agent_id,install_generation,state,created_at) VALUES('executor',?,?,1,'active',?)", machine, agent, now);
  db.run("INSERT INTO privileged_machine_policies VALUES(?,?,1,'[\"operations.managed.v1\"]','admin',?)", machine, agent, now);
  const prefix = `/machines/${machine}/state-recoveries`;
  const plan = () => request(prefix + '/plan', 'POST', { credential_id: credential.data.id, reason: '已确认原程序移除，恢复卡住的维护' });
  const apply = (value: any) => request(prefix + '/' + value.id + '/apply', 'POST', { confirm: true, confirm_name: 'zz-bj-1' });
  const job = (id: string, state = 'queued') => db.run("INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,issued_at,expires_at,created_at,updated_at) VALUES(?,?,?, ?,?,?,?,?,?)", id, agent, 'deployment-' + id, 'operation-' + id, state, now, new Date(clock.getTime() + 3600000).toISOString(), now, now);
  return { db, deps, user, machine, agent, credential: credential.data, prefix, request, plan, apply, job, commands,
    get probes() { return probes; }, advance(ms: number) { clock = new Date(clock.getTime() + ms); }, observe(extra: Record<string, string>) { output = observation(extra); }, race(fn?: () => void) { beforeReturn = fn; } };
}

test('an independent recovery retires a verified absent Agent and releases ordinary and managed unknown fences atomically', async t => {
  const f = await fixture(t); f.job('queued'); f.job('unknown', 'unknown'); f.job('started', 'activating');
  const now = f.deps.now().toISOString();
  f.db.run("INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,request_id,requested_by,created_at,expires_at) VALUES('ordinary','task',?,?,'{}','running','manual','request','admin',?,?)", f.machine, f.agent, now, now);
  f.db.run("INSERT INTO privileged_jobs(id,task_run_id,machine_id,agent_id,executor_id,install_generation,policy_generation,capability,payload_enc,payload_sha256,authorization_id,state,created_at,expires_at,code) VALUES('managed','managed',?,?,'executor',1,1,'operations.managed.v1','encrypted','digest','grant','unknown',?,?,'lease_lost')", f.machine, f.agent, now, now);
  f.db.run("INSERT INTO machine_agent_updates(id,machine_id,agent_id,credential_id,action,status,plan_json,created_at,created_by) VALUES('upgrade',?,?,?,'upgrade','unknown','{}',?,'admin')", f.machine, f.agent, f.credential.id, now);
  assert.equal(maintenanceWorkBusy(f.deps, f.agent, f.machine), true);
  const planned = await f.plan(); assert.equal(planned.status, 201, planned.text);
  assert.equal(pendingMaintenancePreparation(f.db, f.agent, f.machine), true);
  assert.equal((await f.plan()).status, 409);
  assert.equal(planned.data.plan.effects.entries.length, 6);
  assert.ok(!planned.text.includes(fixturePrivateKey())); assert.ok(!planned.text.includes('secret_hash')); assert.ok(!planned.text.includes('encrypted'));
  const done = await f.apply(planned.data); assert.equal(done.status, 200, done.text); assert.equal(done.data.status, 'succeeded');
  assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id='queued'")!.state, 'cancelled');
  for (const id of ['unknown', 'started']) assert.equal(f.db.get<any>('SELECT state FROM agent_jobs WHERE id=?', id)!.state, 'unknown');
  assert.equal(f.db.get<any>("SELECT code,state,resolved_by FROM privileged_jobs WHERE id='managed'")!.code, 'lease_lost');
  assert.equal(f.db.get<any>("SELECT state,resolved_by FROM task_runs WHERE id='ordinary'")!.state, 'unknown');
  assert.equal(f.db.get<any>("SELECT resolved_by FROM task_runs WHERE id='ordinary'")!.resolved_by, 'admin');
  assert.equal(f.db.get<any>("SELECT status FROM machine_agent_updates WHERE id='upgrade'")!.status, 'failed');
  assert.equal(f.db.get<any>("SELECT state FROM privileged_executors WHERE id='executor'")!.state, 'revoked');
  assert.equal(f.db.get<any>("SELECT capabilities_json FROM privileged_machine_policies")!.capabilities_json, '[]');
  assert.ok(f.db.get<any>("SELECT revoked_at FROM agent_credentials WHERE id='control'")!.revoked_at);
  assert.equal(maintenanceWorkBusy(f.deps, f.agent, f.machine), false);
  assert.equal(replaceableAgentBinding(f.db, f.agent, now), true);
  assert.equal(pendingMaintenancePreparation(f.db, f.agent, f.machine), false);
  const count = f.probes, repeated = await f.apply(planned.data); assert.equal(repeated.status, 200); assert.equal(f.probes, count);
  assert.equal(f.db.all('SELECT * FROM agent_lifecycle_events').length, 1);
  assert.ok(f.commands.every(command => !/\nsystemctl (?:stop|disable)|\nlm_(?:remove_managed_state|purge_agent_state)\s*\n/.test(command)));
  // The new fence exemption requires the committed recovery, job and exact identity.
  f.db.run("UPDATE machine_state_recovery_jobs SET agent_id='foreign'");
  assert.ok(f.db.get(`SELECT id FROM agent_jobs WHERE ${blockingAgentJobSQL(f.db)}`));
});

test('active programs, helpers, unsafe paths, locks, invalid and foreign identities cannot be corrected', async t => {
  for (const extra of [{ installation: 'present' }, { service_running: '1' }, { helper_present: '1' }, { paths_safe: '0' }, { lifecycle_locked: '1' }, { operation_lock: '1' }, { identity_state: 'invalid', agent_id: '-' }, { agent_id: 'foreign' }]) {
    const f = await fixture(t); f.observe(extra);
    const response = await f.plan(); assert.equal(response.status, 409, JSON.stringify(extra) + response.text);
    assert.equal(f.db.all('SELECT * FROM machine_state_recoveries').length, 0);
    assert.equal(f.db.get<any>("SELECT state FROM privileged_executors")!.state, 'active');
  }
  assert.throws(() => parseAgentStateRecoveryProbe(observation().replace('LMRECOVERY=1', 'workers_active=1')));
  assert.match(agentStateRecoveryProbeCommand(), /lightmoni-exec-\*/);
  assert.match(agentStateRecoveryProbeCommand(), /lightmoni-agent-update-\*/);
});

test('recovery requires administrator authority, a reason and exact confirmation; cancel and expiry release the gate', async t => {
  const f = await fixture(t); f.user.role = 'member'; assert.equal((await f.plan()).status, 403); assert.equal((await f.request(f.prefix)).status, 403); assert.equal(f.probes, 0);
  f.user.role = 'admin';
  assert.equal((await f.request(f.prefix + '/plan', 'POST', { reason: '' })).status, 400);
  const planned = await f.plan(); assert.equal(planned.status, 201, planned.text);
  assert.equal((await f.request(f.prefix + '/' + planned.data.id + '/apply', 'POST', { confirm: true, confirm_name: 'wrong' })).status, 400);
  assert.equal((await f.request(f.prefix + '/' + planned.data.id + '/cancel', 'POST', {})).status, 200);
  assert.equal(pendingMaintenancePreparation(f.db, f.agent, f.machine), false); assert.equal((await f.apply(planned.data)).status, 409);
  const second = await f.plan(); f.advance(300001); assert.equal((await f.apply(second.data)).status, 409);
  assert.equal(f.db.all('SELECT * FROM agent_lifecycle_events').length, 0);
});

test('target, task, credential and remote races invalidate review without partial writes', async t => {
  for (const scenario of ['target', 'task', 'credential', 'remote', 'during-probe', 'rollback', 'cancel-during-probe']) {
    const f = await fixture(t); f.job('original', 'unknown');
    const planned = await f.plan(); assert.equal(planned.status, 201, planned.text);
    if (scenario === 'target') f.db.run("UPDATE managed_machines SET name='different' WHERE id=?", f.machine);
    if (scenario === 'task') f.job('new-job');
    if (scenario === 'credential') f.db.run("UPDATE machine_credentials SET revoked_at=? WHERE id=?", f.deps.now().toISOString(), f.credential.id);
    if (scenario === 'remote') f.observe({ service_running: '1' });
    if (scenario === 'during-probe') f.race(() => f.job('racing-job'));
    if (scenario === 'cancel-during-probe') f.race(() => f.db.run("UPDATE machine_state_recoveries SET status='cancelled' WHERE id=?", planned.data.id));
    if (scenario === 'rollback') f.db.exec("CREATE TRIGGER fail_retirement BEFORE INSERT ON agent_lifecycle BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
    const result = await f.apply(planned.data); assert.ok(result.status >= 400, scenario + ': ' + result.text);
    assert.equal(f.db.get<any>("SELECT state FROM privileged_executors")!.state, 'active', scenario);
    assert.equal(f.db.get<any>("SELECT revoked_at FROM agent_credentials WHERE id='control'")!.revoked_at, null, scenario);
    assert.equal(f.db.all('SELECT * FROM machine_state_recovery_jobs').length, 0, scenario);
    assert.equal(f.db.all('SELECT * FROM agent_lifecycle_events').length, 0, scenario);
  }
});

test('recovery never changes another host or accepts another host identity in its pending work', async t => {
  const f = await fixture(t); f.job('ours', 'unknown');
  const other = await f.request('/machines', 'POST', { name: 'untouched', address: 'another.example.test' }); assert.equal(other.status, 201);
  const now = f.deps.now().toISOString();
  f.db.run("INSERT INTO privileged_executors(id,machine_id,agent_id,install_generation,state,created_at) VALUES('other-executor',?,'other-agent',1,'active',?)", other.data.id, now);
  const planned = await f.plan(), result = await f.apply(planned.data); assert.equal(result.status, 200, result.text);
  assert.equal(f.db.get<any>("SELECT state FROM privileged_executors WHERE id='other-executor'")!.state, 'active');
  assert.equal(f.db.get<any>("SELECT agent_id FROM managed_machines WHERE id=?", other.data.id)!.agent_id, '');
});

test('foreign pending work and another active identity cannot enter a recovery plan', async t => {
  for (const scenario of ['task', 'executor', 'maintenance']) {
    const f = await fixture(t), now = f.deps.now().toISOString();
    if (scenario === 'task') f.db.run("INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,request_id,requested_by,created_at,expires_at) VALUES('foreign','task',?,'foreign-agent','{}','unknown','manual','request','admin',?,?)", f.machine, now, now);
    if (scenario === 'executor') f.db.run("UPDATE privileged_executors SET agent_id='foreign-agent'");
    if (scenario === 'maintenance') f.db.run("INSERT INTO machine_agent_updates(id,machine_id,agent_id,credential_id,action,status,plan_json,created_at,created_by) VALUES('live',?,?,?,'upgrade','running','{}',?,'admin')", f.machine, f.agent, f.credential.id, now);
    assert.equal((await f.plan()).status, 409, scenario);
    assert.equal(f.db.all('SELECT * FROM machine_state_recoveries').length, 0);
  }
});
