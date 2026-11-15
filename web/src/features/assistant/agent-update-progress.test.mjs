import assert from 'node:assert/strict';
import test from 'node:test';
import { agentUpdateAPIPath, agentUpdateRecord, agentUpdateReviewable } from './agent-update-progress.ts';
import { updatePlanExpired } from '../../app/agent-update-model.ts';

const record = {
  id: 'update-1', machine_id: 'machine-1', agent_id: 'agent-1', action: 'upgrade', status: 'awaiting_approval', created_at: '2026-11-15T00:00:00Z',
  plan: {
    machine: { id: 'machine-1', name: 'host-one', address: '192.0.2.1', port: 22 },
    ssh_account: { id: 'account-1', username: 'root', revision: 1 },
    current: { version: '0.1.0', source_revision: 'old' },
    target: { version: '0.1.0', source_revision: 'new', arch: 'amd64', sha256: 'a'.repeat(64) },
    expires_at: '2099-11-15T00:00:00Z', steps: ['核对主机'],
  },
};

test('only complete native records expose an approval surface', () => {
  assert.equal(agentUpdateRecord(record)?.id, 'update-1');
  assert.equal(agentUpdateReviewable(record), true);
  for (const invalid of [
    null, {}, { ...record, id: '' }, { ...record, action: 'shell' }, { ...record, status: 'deleted' },
    { ...record, plan: undefined }, { ...record, plan: { ...record.plan, machine: undefined } },
    { ...record, plan: { ...record.plan, steps: ['ok', 1] } },
  ]) assert.equal(agentUpdateRecord(invalid), undefined);
});

test('only standalone awaiting plans can be reviewed and API paths stay ID-bound', () => {
  assert.equal(agentUpdateReviewable({ ...record, status: 'running' }), false);
  assert.equal(agentUpdateReviewable({ ...record, status: 'succeeded' }), false);
  assert.equal(agentUpdateReviewable({ ...record, rollout_id: 'rollout-1' }), false);
  assert.equal(agentUpdateReviewable({ ...record, status: 'cancelled' }), false);
  assert.equal(agentUpdateAPIPath({ ...record, machine_id: 'machine/with space', id: 'update/?' }), '/machines/machine%2Fwith%20space/agent-updates/update%2F%3F');
});

test('expiry is evaluated from the saved plan and never treated as success', () => {
  assert.equal(updatePlanExpired(record), false);
  assert.equal(updatePlanExpired({ ...record, plan: { ...record.plan, expires_at: '2000-01-01T00:00:00Z' } }), true);
});

test('existing native reads and new plans share the same assistant card', async () => {
  const { agentUpdateToolValue } = await import('./agent-update-progress.ts');
  assert.equal(agentUpdateToolValue('get_agent_update', record)?.id, 'update-1');
  assert.equal(agentUpdateToolValue('propose_agent_update', record)?.id, 'update-1');
  assert.equal(agentUpdateToolValue('list_tasks', record), undefined);
  assert.equal(agentUpdateToolValue('get_agent_update', {}), undefined);
});

test('assistant update progress uses real recorded stages and never advances with time', async () => {
  const { agentUpdateStageProgress } = await import('./agent-update-progress.ts');
  assert.deepEqual(agentUpdateStageProgress({ ...record, status: 'running', started_at: '2026-11-15T00:00:00Z', events: [{ at: '2026-11-15T00:00:01Z', stage: 'accepted' }, { at: '2026-11-15T00:00:02Z', stage: 'preparing' }] }), { percent: 40, stage: 'preparing', at: '2026-11-15T00:00:02Z' });
  assert.equal(agentUpdateStageProgress({ ...record, status: 'running', events: [] }).percent, 0);
  assert.equal(agentUpdateStageProgress({ ...record, status: 'succeeded', events: [] }).percent, 100);
  assert.equal(agentUpdateStageProgress({ ...record, status: 'unknown', events: [{ at: '2026-11-15T00:00:02Z', stage: 'switching' }, { at: '2026-11-15T00:00:03Z', stage: 'unknown' }] }).percent, 60);
});

test('unverified remote terminal events never claim success or restoration', async () => {
  const { agentUpdateStageProgress } = await import('./agent-update-progress.ts');
  const events = [{ at: '2026-11-15T00:00:02Z', stage: 'waiting_confirmation' }, { at: '2026-11-15T00:00:03Z', stage: 'succeeded' }];
  assert.deepEqual(agentUpdateStageProgress({ ...record, status: 'running', events }), { percent: 80, stage: 'waiting_confirmation', at: '2026-11-15T00:00:02Z' });
  assert.equal(agentUpdateStageProgress({ ...record, status: 'running', events: [{ at: '2026-11-15T00:00:03Z', stage: 'rolled_back' }] }).stage, 'starting');
  assert.equal(agentUpdateStageProgress({ ...record, status: 'rolled_back', events: [{ at: '2026-11-15T00:00:03Z', stage: 'rolled_back' }] }).stage, 'rolled_back');
  assert.equal(agentUpdateStageProgress({ ...record, status: 'running', events: [{ at: '2026-11-15T00:00:03Z', stage: 'unrecognized' }] }).stage, 'starting');
});
