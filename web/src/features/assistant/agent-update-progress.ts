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

export function agentUpdateToolValue(name: string, value: unknown): AgentUpdate | undefined {
  return ['propose_agent_update', 'get_agent_update'].includes(name) ? agentUpdateRecord(value) : undefined;
}

const updateStagePercent: Record<string, number> = { ready: 10, starting: 15, accepted: 25, preparing: 40, switching: 60, verifying: 80, waiting_confirmation: 80 };

export function agentUpdateStageProgress(record: AgentUpdate): { percent: number; stage: string; at: string } {
  const events = Array.isArray(record.events) ? record.events.filter(event => event && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) && typeof event.stage === 'string') : [];
  const known = [...events].reverse().find(event => updateStagePercent[event.stage] !== undefined);
  const terminal = ['succeeded', 'rolled_back', 'failed', 'unknown', 'cancelled'].includes(record.status) ? record.status : '';
  const terminalEvent = terminal ? [...events].reverse().find(event => event.stage === terminal) : undefined;
  return {
    percent: record.status === 'awaiting_approval' ? 0 : record.status === 'succeeded' ? 100 : known ? updateStagePercent[known.stage] : 0,
    // A remote terminal-looking event is not success/restoration until the
    // platform's own health and identity gates accept the terminal record.
    stage: record.status === 'awaiting_approval' ? record.status : terminal || known?.stage || (record.status === 'running' ? 'starting' : record.status),
    at: record.status === 'awaiting_approval' ? '' : (terminalEvent ?? known)?.at ?? ([record.finished_at, record.started_at].find(value => value && Number.isFinite(Date.parse(value))) ?? ''),
  };
}

export function agentUpdateAPIPath(record: AgentUpdate): string {
  return updatePath(record.machine_id, record.id);
}
