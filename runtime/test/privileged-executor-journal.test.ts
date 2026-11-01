import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutorJournal } from '../src/privileged-executor/journal.js';
import { canonicalJSON } from '../src/shared/privileged-executor.js';
import { sha256 } from '../src/privileged-executor/security.js';

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lightmoni-executor-journal-'));
  const key = randomBytes(32), handles: ExecutorJournal[] = [];
  const open = (initialize = false, outputKey = key) => {
    const journal = new ExecutorJournal(directory, outputKey, initialize); handles.push(journal); return journal;
  };
  t.after(() => {
    for (const journal of handles) try { journal.close(); } catch { /* Already explicitly closed for a restart. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, filename: join(directory, 'journal.sqlite'), key, open };
}
const payload = (value = 'one') => ({ kind: 'container', operation: 'stop', resource_id: value, revision: 1 });
const digestOf = (value: unknown) => sha256(canonicalJSON(value));
const unit = () => 'lightmoni-exec-' + randomBytes(16).toString('hex');
function prepared(journal: ExecutorJournal, id = 'job-1', grant = 'grant-1') {
  const body = payload(id), digest = digestOf(body), nonce = randomBytes(32).toString('hex');
  journal.prepare(id, digest, grant, 'lease-1', { action: 'stop', request_sha256: digest }, body);
  journal.nonce(id, nonce);
  return { id, body, digest, nonce, unit: unit() };
}
const succeeded = { state: 'succeeded', code: 'script_succeeded', summary: 'Approved work completed', exit_code: 0, stdout: '', stderr: '' };

test('prepared work survives restart without a previous boot nonce or a writer fence', t => {
  const f = fixture(t), journal = f.open(true), job = prepared(journal);
  assert.equal(journal.get(job.id)!.state, 'prepared'); assert.equal(journal.fenced(), undefined);
  journal.close();
  const restarted = f.open();
  assert.equal(restarted.get(job.id)!.state, 'prepared');
  assert.equal(restarted.get(job.id)!.nonce, ''); assert.equal(restarted.get(job.id)!.permit_id, '');
  assert.equal(restarted.fenced(), undefined);
  assert.throws(() => restarted.intent(job.id, 'permit-old-boot', job.nonce, job.unit), /journal_state_conflict/);
  const nextNonce = randomBytes(32).toString('hex'); restarted.nonce(job.id, nextNonce);
  restarted.intent(job.id, 'permit-new-boot', nextNonce, job.unit);
  assert.equal(restarted.get(job.id)!.state, 'intent');
});

test('intent and running interruptions become durable unknown fences across repeated restarts', async t => {
  for (const phase of ['intent', 'running'] as const) await t.test(phase, child => {
    const f = fixture(child), journal = f.open(true), job = prepared(journal);
    journal.intent(job.id, 'permit-1', job.nonce, job.unit);
    if (phase === 'running') journal.running(job.id);
    assert.equal(journal.fenced()!.job_id, job.id); journal.close();
    const restarted = f.open(), unknown = restarted.get(job.id)!;
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.result.code, 'executor_restarted');
    assert.equal(unknown.unit, job.unit); assert.equal(unknown.permit_id, 'permit-1');
    assert.equal(restarted.fenced()!.job_id, job.id);
    const other = payload('other');
    assert.throws(() => restarted.prepare('job-2', digestOf(other), 'grant-2', 'lease-2', {}, other), /execution_unknown/);
    assert.throws(() => restarted.finish(job.id, 'succeeded', succeeded), /journal_state_conflict/);
    restarted.acknowledge(job.id); assert.equal(restarted.reported(job.id), true);
    assert.equal(restarted.fenced()!.state, 'unknown'); restarted.close();
    const twice = f.open();
    assert.equal(twice.fenced()!.job_id, job.id); assert.equal(twice.get(job.id)!.state, 'unknown');
    assert.equal(twice.reported(job.id), true);
  });
});

test('job replay is idempotent only for the same canonical payload digest and grant', t => {
  const f = fixture(t), journal = f.open(true), job = prepared(journal);
  const reordered = { revision: 1, resource_id: job.id, operation: 'stop', kind: 'container' };
  assert.equal(digestOf(reordered), job.digest);
  const replay = journal.prepare(job.id, job.digest, 'grant-1', 'different-lease', {}, reordered);
  assert.equal(replay.nonce, job.nonce); assert.equal(replay.lease_id, 'lease-1');
  const changed = payload('changed');
  assert.throws(() => journal.prepare(job.id, digestOf(changed), 'grant-1', 'lease-1', {}, changed), /replay_conflict/);
  assert.throws(() => journal.prepare(job.id, job.digest, 'grant-other', 'lease-1', {}, job.body), /replay_conflict/);
  assert.throws(() => journal.prepare('invalid-digest-job', 'f'.repeat(64), 'grant-new', 'lease-1', {}, job.body), /invalid_job/);
  assert.equal(journal.all().length, 1);
});

test('consumed grants stay consumed after a terminal result and database reopen', t => {
  const f = fixture(t), journal = f.open(true), job = prepared(journal);
  assert.throws(() => journal.intent(job.id, 'permit-wrong', '0'.repeat(64), job.unit), /journal_state_conflict/);
  journal.intent(job.id, 'permit-1', job.nonce, job.unit); journal.running(job.id);
  journal.finish(job.id, 'succeeded', succeeded);
  assert.equal(journal.fenced(), undefined); journal.close();
  const restarted = f.open(), next = payload('next');
  assert.throws(() => restarted.prepare('job-2', digestOf(next), 'grant-1', 'lease-2', {}, next), /grant_consumed/);
  assert.equal(restarted.prepare(job.id, job.digest, 'grant-1', 'lease-replay', {}, job.body).state, 'succeeded');
  assert.equal(restarted.get('job-2'), undefined);
});

test('stdout and stderr are authenticated ciphertext in every SQLite file and decrypt after reopen', t => {
  const f = fixture(t), journal = f.open(true), job = prepared(journal);
  const stdout = 'stdout-secret-060-' + randomBytes(24).toString('hex');
  const stderr = 'stderr-secret-060-' + randomBytes(24).toString('hex');
  journal.intent(job.id, 'permit-1', job.nonce, job.unit); journal.running(job.id);
  journal.finish(job.id, 'succeeded', { ...succeeded, stdout, stderr });
  assert.equal(journal.get(job.id)!.result.stdout, stdout); assert.equal(journal.get(job.id)!.result.stderr, stderr);
  for (const filename of fs.readdirSync(f.directory)) {
    const bytes = fs.readFileSync(join(f.directory, filename));
    assert.equal(bytes.includes(Buffer.from(stdout)), false, filename + ' contains plaintext stdout');
    assert.equal(bytes.includes(Buffer.from(stderr)), false, filename + ' contains plaintext stderr');
  }
  journal.close();
  const restarted = f.open();
  assert.equal(restarted.get(job.id)!.result.stdout, stdout); assert.equal(restarted.get(job.id)!.result.stderr, stderr); restarted.close();
  assert.throws(() => { const wrongKey = f.open(false, randomBytes(32)); wrongKey.get(job.id); }, /authenticate|authentication|decrypt|cipher|corrupt/i);
});

test('output overflow refuses persistence and retains the in-progress fence', t => {
  const f = fixture(t), journal = f.open(true), job = prepared(journal);
  journal.intent(job.id, 'permit-1', job.nonce, job.unit); journal.running(job.id);
  assert.throws(() => journal.finish(job.id, 'succeeded', { ...succeeded, stdout: 'x'.repeat(256 * 1024), stderr: 'x' }), /output_limit/);
  assert.equal(journal.get(job.id)!.state, 'running'); assert.equal(journal.fenced()!.job_id, job.id);
});

test('an absent or uninitialized journal is never implicitly initialized during recovery', t => {
  const f = fixture(t);
  assert.throws(() => f.open(), /journal_missing_requires_recovery/); assert.equal(fs.existsSync(f.filename), false);
  fs.writeFileSync(f.filename, '', { mode: 0o600 });
  assert.throws(() => f.open(), /journal_missing_requires_recovery/);
  const database = new DatabaseSync(f.filename);
  try { assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get(), undefined); }
  finally { database.close(); }
});

test('physically corrupt and symlinked journals fail closed instead of becoming fresh state', async t => {
  await t.test('corrupt SQLite header', child => {
    const f = fixture(child), journal = f.open(true); journal.close();
    fs.writeFileSync(f.filename, 'corrupt-journal-060-do-not-initialize');
    assert.throws(() => f.open(), /corrupt|database|sqlite|file is not/i);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'corrupt-journal-060-do-not-initialize');
  });
  await t.test('symlink', child => {
    const f = fixture(child), journal = f.open(true); journal.close();
    const alternate = join(f.directory, 'alternate.sqlite'); fs.renameSync(f.filename, alternate); fs.symlinkSync(alternate, f.filename);
    assert.throws(() => f.open(), /unsafe_journal/);
  });
});

test('request IDs survive restart and a digest conflict cannot replace the original ID', t => {
  const f = fixture(t), journal = f.open(true), digest = digestOf({ lease: 1 });
  const id = journal.request('claim:executor-1', digest);
  assert.match(id, /^[a-f0-9]{32}$/); assert.equal(journal.request('claim:executor-1', digest), id);
  assert.throws(() => journal.request('claim:executor-1', digestOf({ lease: 2 })), /request_replay_conflict/);
  assert.equal(journal.request('claim:executor-1', digest), id); journal.close();
  const restarted = f.open(); assert.equal(restarted.request('claim:executor-1', digest), id);
  assert.notEqual(restarted.request('heartbeat:executor-1', digest), id);
});

test('highest policy generation persists and never accepts an older or invalid value', t => {
  const f = fixture(t), journal = f.open(true);
  assert.equal(journal.policyGeneration(), 0); assert.equal(journal.policyGeneration(4), 4); assert.equal(journal.policyGeneration(4), 4);
  for (const value of [3, -1, NaN, Infinity, 4.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => journal.policyGeneration(value), /stale_policy/);
  journal.close(); const restarted = f.open();
  assert.equal(restarted.policyGeneration(), 4); assert.throws(() => restarted.policyGeneration(3), /stale_policy/);
  assert.equal(restarted.policyGeneration(9), 9);
});

test('logically corrupt policy generation cannot erase the persisted monotonic watermark', async t => {
  for (const invalid of ['not-a-number', '-1', '1.5', '9007199254740992']) await t.test(invalid, child => {
    const f = fixture(child), journal = f.open(true); journal.policyGeneration(20); journal.close();
    const database = new DatabaseSync(f.filename);
    try { database.prepare("UPDATE metadata SET value=? WHERE key='policy_generation'").run(invalid); }
    finally { database.close(); }
    assert.throws(() => { const restarted = f.open(); restarted.policyGeneration(1); }, /journal_corrupt/);
  });
});

test('resource manifest replacement is transactional when a duplicate resource ID fails', t => {
  const f = fixture(t), journal = f.open(true);
  const original = [{ daemon_id: 'daemon-1', resource_id: 'resource-1', docker_id: 'a'.repeat(64), revision: 1 }];
  journal.setResources(original);
  assert.throws(() => journal.setResources([original[0], { ...original[0], docker_id: 'b'.repeat(64) }]));
  assert.deepEqual(journal.resources(), original); journal.close();
  assert.deepEqual(f.open().resources(), original);
});

test('missing durable v1 columns are rejected without repairing tables or resetting stored state',async t=>{
 for(const [table,column] of [['jobs','result_json'],['consumed_grants','digest'],['requests','digest'],['resources','value_json']])await t.test(table,sub=>{
  const f=fixture(sub),journal=f.open(true);journal.policyGeneration(9);journal.close();const database=new DatabaseSync(f.filename);database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);database.close();assert.throws(()=>f.open(),/journal_corrupt/);const observed=new DatabaseSync(f.filename,{readOnly:true});try{assert.equal((observed.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(c=>c.name===column),false);assert.equal((observed.prepare("SELECT value FROM metadata WHERE key='policy_generation'").get() as any).value,'9')}finally{observed.close()}
 });
});
