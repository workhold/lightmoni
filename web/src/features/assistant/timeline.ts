// Ported from Doca's persistent-event/timeline presentation skeleton.
// Doca: MIT License, Copyright (c) 2026 smartdoca. See NOTICE.md.
import type { AssistantEvent, Attachment, TurnView } from './types';
import type { TimeRange } from '../../shared/types';
import type {Language} from '../../shared/i18n';
import {translator} from '../alerts/translation.ts';

/** Reproduce the successful analysis scope when previewing a stored draft. */
export function queryRangeFromTurn(turn: TurnView, draftCallId?: string): TimeRange | undefined {
  const draftIndex = draftCallId ? turn.tools.findIndex(tool => tool.callId === draftCallId) : -1;
  const tools = draftCallId ? turn.tools.slice(0, Math.max(0, draftIndex)) : turn.tools;
  for (const tool of [...tools].reverse()) {
    if (tool.name !== 'run_query' || tool.status !== 'success') continue;
    const range = (tool.result as { range?: Partial<TimeRange> } | undefined)?.range;
    if (typeof range?.from === 'string' && typeof range.to === 'string') return { from: range.from, to: range.to };
  }
}

/** Pair by durable turn IDs, never by prompt text or response order. */
export function assistantTimeline(events: AssistantEvent[],language:Language='zh-CN', interrupted = false): TurnView[] {
  const t=translator(language);
  const ordered = [...new Map(events.map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  const turns = new Map<string, TurnView>();
  const stepAnswers = new Map<string, Map<number, string>>();
  for (const event of ordered) {
    let turn = turns.get(event.turn_id);
    if (!turn) {
      turn = { id: event.turn_id, text: '', attachments: [], answer: '', tools: [], timestamp: event.timestamp, status: 'running' };
      turns.set(event.turn_id, turn);
      stepAnswers.set(event.turn_id, new Map());
    }
    const data = event.data;
    turn.startedAt ??= event.timestamp;
    if (event.type === 'user.message') {
      turn.text = String(data.text ?? '');
      turn.attachments = Array.isArray(data.attachments) ? data.attachments.filter((item): item is Attachment => !!item && typeof item === 'object' && typeof item.name === 'string' && (item.kind === 'image' || item.kind === 'pdf')).map(({kind,name,mime_type,pages}) => ({kind,name,mime_type,pages})) : [];
    }
    if (event.type === 'assistant.delta' || event.type === 'assistant.message') {
      const step = Number(data.step ?? 1);
      const answers = stepAnswers.get(event.turn_id)!;
      answers.set(step, event.type === 'assistant.message' ? String(data.text ?? '') : (answers.get(step) ?? '') + String(data.text ?? ''));
      turn.answer = [...answers.values()].filter(Boolean).join('\n\n');
    }
    if (event.type === 'tool.call') turn.tools.push({ callId: String(data.call_id), name: String(data.tool), input: data.input, status: 'running', startedAt: event.timestamp });
    if (event.type === 'tool.result') {
      const trace = turn.tools.find(tool => tool.callId === data.call_id);
      if (trace) { trace.result = data.value; trace.status = data.status === 'success' ? 'success' : data.status === 'cancelled' ? 'cancelled' : 'error'; trace.endedAt = event.timestamp; }
    }
    if (event.type === 'context.compacting') turn.compacting = true;
    if (event.type === 'context.compacted') { turn.compacting = false; turn.compacted = true; turn.degraded = data.degraded === true; }
    if (event.type === 'turn.usage') {
      const key = data.phase === 'compact' ? 'compactionUsage' : 'usage';
      const usage = turn[key] ?? {};
      for (const field of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
        const value = data[field];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[field] = (usage[field] ?? 0) + value;
      }
      turn[key] = usage;
    }
    if (event.type === 'turn.completed') { turn.status = 'completed'; turn.endedAt = event.timestamp; }
    if (event.type === 'turn.cancelled' || event.type === 'turn.failed') {
      turn.status = event.type === 'turn.cancelled' ? 'cancelled' : 'failed';
      turn.compacting = false;
      turn.endedAt = event.timestamp;
      turn.error = String(data.error ?? t('请求失败','Request failed'));
      for (const tool of turn.tools) {
        if (event.type === 'turn.cancelled') {
          if (tool.status === 'running') { tool.status = 'cancelled'; tool.result = { error: turn.error }; }
          else if (tool.status === 'error' && (tool.result as { error?: unknown } | undefined)?.error === turn.error) tool.status = 'cancelled';
        } else if (tool.status === 'running') { tool.status = 'error'; tool.result = { error: turn.error }; }
      }
    }
  }
  const result = [...turns.values()];
  for (const [index, turn] of result.entries()) {
    if (turn.status !== 'running' || index === result.length - 1 && !interrupted) continue;
    turn.status = 'failed';
    turn.compacting = false;
    turn.error = t('响应中断，未收到最终结果。', 'The response was interrupted before a final result was recorded.');
    for (const tool of turn.tools) {
      if (tool.status === 'running') {
        tool.status = 'error';
        tool.result = { error: turn.error };
      }
    }
  }
  return result;
}
