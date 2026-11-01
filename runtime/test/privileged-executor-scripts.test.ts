import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, sha256 } from '../src/shared/privileged-executor.js';
import { executeScript, validateScript, unitOutcome, type AccountProfile, type ElevatedScript, type ScriptHost, type ScriptOutcome, type UnitObservation } from '../src/privileged-executor/scripts.js';

const account: AccountProfile = { name: 'service_user', uid: 1001, gid: 1002, groups: [2001, 2002] };
const unit = 'lightmoni-exec-' + 'a'.repeat(32);
const completed: ScriptOutcome = { state: 'succeeded', code: 'script_succeeded', summary: 'Approved script completed', exit_code: 0, stdout: 'sample output', stderr: '' };
function script(changes: Record<string, unknown> = {}): ElevatedScript {
  const value: any = { kind: 'script', runtime: 'shell', code: 'printf sample', interpreter_sha256: 'd'.repeat(64), args: ['argument'], cwd_profile: 'private',
    environment: { APPROVED_SAMPLE: 'exact-value' }, account: structuredClone(account), timeout_ms: 10000, max_output_bytes: 4096, ...changes };
  return { ...value, code_sha256: sha256(value.code), environment_sha256: sha256(canonicalJSON(value.environment)), account_sha256: sha256(canonicalJSON(value.account)) };
}
function host(profile: AccountProfile = structuredClone(account)) {
  const calls: { unit: string; interpreter: string; payload: ElevatedScript; signal: AbortSignal }[] = [];
  const lookups: string[] = [];
  const instance: ScriptHost = {
    account: name => { lookups.push(name); return profile; },
    interpreter: runtime => '/trusted/bin/' + (runtime === 'shell' ? 'sh' : 'node'),
    run: async (unit, interpreter, payload, signal) => { calls.push({ unit, interpreter, payload, signal }); return completed; },
  };
  return { instance, calls, lookups };
}
const terminal: UnitObservation = { LoadState: 'loaded', ActiveState: 'active', SubState: 'exited', Result: 'success', ExecMainCode: '1', ExecMainStatus: '0', InvocationID: 'b'.repeat(32) };

test('executeScript preserves the approved identity, code, full digests and signal without invoking a production subprocess', async () => {
  const f = host({ ...account, groups: [...account.groups].reverse() }), input = script(), controller = new AbortController();
  const result = await executeScript(input, unit, [{ ...account, groups: [...account.groups].reverse() }], f.instance, controller.signal);
  assert.deepEqual(result, completed); assert.equal(f.calls.length, 1); assert.deepEqual(f.lookups, [account.name]);
  const request = f.calls[0]; assert.equal(request.unit, unit); assert.equal(request.interpreter, '/trusted/bin/sh');
  assert.deepEqual(request.payload, input); assert.equal(request.signal, controller.signal);
  assert.equal(request.payload.code_sha256, sha256(input.code));
  assert.equal(request.payload.environment_sha256, sha256(canonicalJSON(input.environment)));
  assert.equal(request.payload.account_sha256, sha256(canonicalJSON(input.account)));
  const node = host(); await executeScript(script({ runtime: 'node' }), unit, [account], node.instance, controller.signal);
  assert.equal(node.calls[0].interpreter, '/trusted/bin/node');
});

test('an absent or different root-local account allowlist rejects the task before host execution', async () => {
  for (const allowed of [[], [{ ...account, uid: account.uid + 1 }], [{ ...account, gid: account.gid + 1 }], [{ ...account, groups: [...account.groups, 9999] }], [{ name: 'root', uid: 0, gid: 0, groups: [] }]]) {
    const f = host();
    await assert.rejects(executeScript(script(), unit, allowed, f.instance, new AbortController().signal), /account_changed/);
    assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
  }
});

test('changes in the live account name, UID, GID or supplementary groups block execution with no fallback identity', async () => {
  for (const changed of [
    { ...account, name: 'other_user' }, { ...account, uid: 0 }, { ...account, gid: 0 },
    { ...account, groups: [2001] }, { ...account, groups: [...account.groups, 998] },
  ]) {
    const f = host(changed);
    await assert.rejects(executeScript(script(), unit, [account], f.instance, new AbortController().signal), /account_changed/);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.lookups, [account.name]);
  }
});

test('missing or tampered code/environment/account digests and invalid interpreter digests reject the exact payload', () => {
  for (const field of ['code_sha256', 'environment_sha256', 'account_sha256']) {
    const missing: any = script(); delete missing[field]; assert.throws(() => validateScript(missing), /missing_payload_digest/);
    assert.throws(() => validateScript({ ...script(), [field]: 'f'.repeat(64) }), /payload_digest_mismatch/);
  }
  const original = script();
  for (const change of [{ code: original.code + '; id' }, { environment: { APPROVED_SAMPLE: 'different' } }, { account: { ...account, groups: [2001] } }]) assert.throws(() => validateScript({ ...original, ...change }), /payload_digest_mismatch/);
  for (const digest of ['', 'latest', 'f'.repeat(63), 'F'.repeat(64)]) assert.throws(() => validateScript({ ...original, interpreter_sha256: digest }), /invalid_digest/);
});

test('runtime and inherited environment injection stays forbidden even with matching environment digests', () => {
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'ENV', 'BASH_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PERL5OPT', 'RUBYOPT', 'DOCKER_HOST', 'LIGHTMONI_TOKEN', 'IFS', 'SHELLOPTS', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'SUDO_ASKPASS', 'SYSTEMD_EXEC_PID', 'GCONV_PATH', 'LOCPATH', 'GLIBC_TUNABLES']) {
    assert.throws(() => validateScript(script({ environment: { [key]: 'attacker-controlled' } })), /unsafe_environment/);
  }
  assert.equal(validateScript(script({ environment: { API_TOKEN: 'approved-secret-value' } })).environment.API_TOKEN, 'approved-secret-value');
});

test('invalid payload kinds, unknown fields, account aliases and input limits cannot reach a ScriptHost', async () => {
  const good = script();
  const bad = [null, [], {}, { ...good, unexpected: true }, { ...good, runtime: '/bin/bash' }, { ...good, cwd_profile: '/tmp' },
    { ...good, code: '' }, { ...good, code: 'x\0y' }, { ...good, code: 'x'.repeat(262145) },
    { ...good, args: Array(65).fill('x') }, { ...good, args: ['x'.repeat(4097)] }, { ...good, args: ['x\0y'] }, { ...good, args: Array(5).fill('x'.repeat(4000)) },
    { ...good, timeout_ms: 999 }, { ...good, timeout_ms: 600001 }, { ...good, max_output_bytes: 1023 }, { ...good, max_output_bytes: 262145 },
    { ...good, environment: { 'bad-name': 'value' } }, { ...good, environment: { APPROVED_SAMPLE: 'x\0y' } }, { ...good, environment: Array(2).fill('x') },
    { ...good, account: { ...account, groups: [2001, 2001] } }, { ...good, account: { ...account, uid: -1 } }, { ...good, account: { name: 'root_alias', uid: 0, gid: 0, groups: [] } },
    { kind: 'container', operation: 'list', resource_id: 'resource_one', resource_revision: 1, timeout_ms: 1000, max_output_bytes: 1024 },
  ];
  const f = host();
  for (const input of bad) await assert.rejects(executeScript(input, unit, [account], f.instance, new AbortController().signal));
  assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
});

test('unit names are fixed identifiers and cancellation before start does not call the host', async () => {
  const f = host(), signal = new AbortController().signal;
  for (const name of ['', 'docker.service', unit + '.service', unit + ';id', 'lightmoni-exec-../../other', 'lightmoni-exec-' + 'A'.repeat(32), 'lightmoni-exec-' + 'a'.repeat(31)]) await assert.rejects(executeScript(script(), name, [account], f.instance, signal), /invalid_unit/);
  assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(executeScript(script(), unit, [account], f.instance, cancelled.signal), /execution_cancelled/);
  assert.equal(f.calls.length, 0);
});

test('host failures and uncertain observations remain failures or unknown without a second execution attempt', async () => {
  const f = host();
  f.instance.run = async () => { throw Error('dependency_unavailable'); };
  await assert.rejects(executeScript(script(), unit, [account], f.instance, new AbortController().signal), /dependency_unavailable/);
  let attempts = 0; f.instance.run = async () => { attempts++; return { ...completed, state: 'unknown', code: 'execution_unknown', exit_code: null }; };
  const result = await executeScript(script(), unit, [account], f.instance, new AbortController().signal);
  assert.equal(result.state, 'unknown'); assert.equal(attempts, 1);
});

test('systemctl absence, incomplete observations or a still-running service cannot prove completion', () => {
  for (const changed of [
    { LoadState: 'not-found' }, { LoadState: 'error' }, { ActiveState: 'activating', SubState: 'start' },
    { ActiveState: 'active', SubState: 'running' }, { ActiveState: 'deactivating', SubState: 'stop-sigterm' },
    { InvocationID: '' }, { InvocationID: 'other-job' }, { ExecMainCode: '0' },
    { ExecMainStatus: '-1' }, { ExecMainStatus: '256' }, { ExecMainStatus: 'NaN' }, { ExecMainStatus: '' },
    { Result: 'unknown-future-result' }, { Result: '' },
  ]) {
    const result = unitOutcome({ ...terminal, ...changed });
    assert.equal(result.state, 'unknown', JSON.stringify(changed)); assert.equal(result.code, 'execution_unknown'); assert.equal(result.exit_code, null);
  }
});

test('success requires a proven exited process with status zero and a consistent unit terminal state', () => {
  for (const observation of [terminal, { ...terminal, ActiveState: 'inactive', SubState: 'dead' }]) {
    const result = unitOutcome(observation); assert.equal(result.state, 'succeeded'); assert.equal(result.code, 'script_succeeded'); assert.equal(result.exit_code, 0);
  }
  for (const changed of [
    { ActiveState: 'failed', SubState: 'failed' }, { ActiveState: 'active', SubState: 'dead' }, { ActiveState: 'inactive', SubState: 'exited' },
    { ActiveState: 'active', SubState: 'failed' }, { ActiveState: 'failed', SubState: 'exited' },
  ]) assert.notEqual(unitOutcome({ ...terminal, ...changed }).state, 'succeeded', JSON.stringify(changed));
  const interrupted = unitOutcome(terminal, 'cancel_requested');
  assert.equal(interrupted.state, 'failed'); assert.equal(interrupted.code, 'cancel_requested');
});

test('nonzero exits and signal/core-dump terminations preserve their meaning without an invented exit code', () => {
  const failure = { ...terminal, ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', ExecMainStatus: '23' };
  assert.deepEqual(unitOutcome(failure), { state: 'failed', code: 'script_failed', summary: 'Approved script did not complete successfully', exit_code: 23 });
  assert.equal(unitOutcome({ ...failure, ExecMainStatus: '255' }).exit_code, 255);
  for (const changed of [{ Result: 'signal', ExecMainCode: '2', ExecMainStatus: '9' }, { Result: 'core-dump', ExecMainCode: '3', ExecMainStatus: '11' }]) {
    const result = unitOutcome({ ...failure, ...changed }); assert.equal(result.state, 'failed'); assert.equal(result.exit_code, null);
  }
  const timedOut = unitOutcome({ ...failure, Result: 'timeout', ExecMainCode: '2', ExecMainStatus: '9' }, 'timeout');
  assert.equal(timedOut.state, 'failed'); assert.equal(timedOut.code, 'timeout'); assert.equal(timedOut.exit_code, null);
});
