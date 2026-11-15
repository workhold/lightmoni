import type { AgentUpdate } from '../../app/agent-update-model';
import { updatePath } from '../../app/agent-update-model';

const statuses = new Set(['awaiting_approval', 'running', 'verifying', 'succeeded', 'rolled_back', 'failed', 'unknown', 'cancelled']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value;

export function agentUpdateRecord(value: unknown): AgentUpdate | undefined {
  if (!object(value) || !text(value.id) || !text(value.machine_id) || !text(value.created_at)
    || !['upgrade', 'rollback'].includes(String(value.action)) || !statuses.has(String(value.status))
    || !object(value.plan) || !object(value.plan.machine) || !text(value.plan.machine.id)
    || !text(value.plan.machine.name) || !text(value.plan.machine.address)
    || !object(value.plan.ssh_account) || !text(value.plan.ssh_account.username)
    || !object(value.plan.current) || !object(value.plan.target) || !text(value.plan.expires_at)
    || !Array.isArray(value.plan.steps) || value.plan.steps.some(step => typeof step !== 'string')) return undefined;
  return value as unknown as AgentUpdate;
}

export function agentUpdateReviewable(record: AgentUpdate): boolean {
  return record.status === 'awaiting_approval' && !record.rollout_id;
}

export function agentUpdateAPIPath(record: AgentUpdate): string {
  return updatePath(record.machine_id, record.id);
}
