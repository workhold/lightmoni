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
