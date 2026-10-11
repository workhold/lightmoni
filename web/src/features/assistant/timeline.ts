// Ported from Doca's persistent-event/timeline presentation skeleton.
// Doca: MIT License, Copyright (c) 2026 smartdoca. See NOTICE.md.
import type { AssistantEvent, TurnView } from './types';
import type { TimeRange } from '../../shared/types';

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
export function assistantTimeline(events: AssistantEvent[]): TurnView[] {
  const ordered = [...new Map(events.map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  const turns = new Map<string, TurnView>();
  const stepAnswers = new Map<string, Map<number, string>>();
  for (const event of ordered) {
    let turn = turns.get(event.turn_id);
    if (!turn) {
      turn = { id: event.turn_id, text: '', answer: '', tools: [], timestamp: event.timestamp, status: 'running' };
      turns.set(event.turn_id, turn);
      stepAnswers.set(event.turn_id, new Map());
    }
    const data = event.data;
    if (event.type === 'user.message') turn.text = String(data.text ?? '');
    if (event.type === 'assistant.delta' || event.type === 'assistant.message') {
      const step = Number(data.step ?? 1);
      const answers = stepAnswers.get(event.turn_id)!;
      answers.set(step, event.type === 'assistant.message' ? String(data.text ?? '') : (answers.get(step) ?? '') + String(data.text ?? ''));
      turn.answer = [...answers.values()].filter(Boolean).join('\n\n');
    }
    if (event.type === 'tool.call') turn.tools.push({ callId: String(data.call_id), name: String(data.tool), input: data.input, status: 'running' });
    if (event.type === 'tool.result') {
      const trace = turn.tools.find(tool => tool.callId === data.call_id);
      if (trace) { trace.result = data.value; trace.status = data.status === 'success' ? 'success' : 'error'; }
    }
    if (event.type === 'turn.completed') turn.status = 'completed';
    if (event.type === 'turn.cancelled' || event.type === 'turn.failed') {
      turn.status = event.type === 'turn.cancelled' ? 'cancelled' : 'failed';
      turn.error = String(data.error ?? '请求失败');
      for (const tool of turn.tools) if (tool.status === 'running') { tool.status = 'error'; tool.result = { error: turn.error }; }
    }
  }
  return [...turns.values()];
}
