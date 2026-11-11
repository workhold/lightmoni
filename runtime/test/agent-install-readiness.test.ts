import test from 'node:test';
import assert from 'node:assert/strict';
import { InstallationReadinessError, waitForInstallationReadiness } from '../src/server/agent-install-readiness.js';

const signal = () => new AbortController().signal;
test('installation waits for activation, heartbeat and signed channel without replaying bootstrap', async () => {
  let elapsed = 0, observations = 0;
  const stages = ['activation_pending', 'runtime_heartbeat_pending', 'privileged_executor_pending'] as const;
  const result = await waitForInstallationReadiness(() => observations < stages.length
    ? { pending: stages[observations++]! } : { ready: 'same-agent' }, signal(), {
    timeoutMs: 50, pollIntervalMs: 10, monotonic: () => elapsed,
    sleep: async ms => { elapsed += ms; },
  });
  assert.equal(result, 'same-agent'); assert.equal(observations, 3); assert.equal(elapsed, 30);
});
test('deadline uses monotonic time and preserves the last safe pending reason', async () => {
  let elapsed = 0, observations = 0;
  await assert.rejects(waitForInstallationReadiness(() => { observations++; return { pending: 'privileged_executor_pending' }; }, signal(), {
    timeoutMs: 25, pollIntervalMs: 10, monotonic: () => elapsed, sleep: async ms => { elapsed += ms; },
  }), (e: any) => e instanceof InstallationReadinessError && e.code === 'privileged_executor_pending');
  assert.equal(elapsed, 25); assert.equal(observations, 4);
});
test('cancellation prevents another observation and releases a pending timer', async () => {
  const controller = new AbortController(); let observations = 0;
  const pending = waitForInstallationReadiness(() => { observations++; return { pending: 'runtime_heartbeat_pending' }; }, controller.signal, { pollIntervalMs: 10000 });
  controller.abort();
  await assert.rejects(pending, (e: any) => e.code === 'installation_confirmation_cancelled');
  assert.equal(observations, 1);
});
test('an already cancelled request cannot confirm even an immediately healthy identity', async () => {
  const controller = new AbortController(); controller.abort(); let observations = 0;
  await assert.rejects(waitForInstallationReadiness(() => { observations++; return { ready: 'agent' }; }, controller.signal), (e: any) => e.code === 'installation_confirmation_cancelled');
  assert.equal(observations, 0);
});
test('record recovery during waiting exits without observing or confirming a replacement', async () => {
  let recovered = false;
  await assert.rejects(waitForInstallationReadiness(() => {
    if (recovered) throw new InstallationReadinessError('installation_record_changed');
    return { pending: 'runtime_heartbeat_pending' };
  }, signal(), { sleep: async () => { recovered = true; } }), (e: any) => e.code === 'installation_record_changed');
});
