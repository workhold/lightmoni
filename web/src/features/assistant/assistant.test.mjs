import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantTimeline, queryRangeFromTurn } from './timeline.ts';
import { streamTurn, TurnStreamError } from './client.ts';

function event(sequence, type, data = {}, turn_id = 'turn-1') { return { sequence, type, data, turn_id, session_id: 'session-1', timestamp: '2026-10-10T00:00:00Z' }; }

test('timeline uses durable turn ids, deduplicates replay, and replaces streamed text with committed text', () => {
  const events = [event(0, 'user.message', { text: '相同问题' }), event(1, 'assistant.delta', { text: '部分', step: 1 }), event(2, 'assistant.message', { text: '完整回答', step: 1 }), event(3, 'turn.completed'), event(4, 'user.message', { text: '相同问题' }, 'turn-2'), event(5, 'tool.call', { call_id: 'call-1', tool: 'run_query', input: {} }, 'turn-2'), event(6, 'turn.cancelled', { error: 'request cancelled' }, 'turn-2')];
  const turns = assistantTimeline([...events, events[1]]);
  assert.equal(turns.length, 2); assert.equal(turns[0].answer, '完整回答'); assert.equal(turns[0].status, 'completed');
  assert.equal(turns[1].status, 'cancelled'); assert.equal(turns[1].tools[0].status, 'cancelled');
});

test('timeline distinguishes explicit cancelled receipts from real tool failures', () => {
  const cancelled = assistantTimeline([
    event(0, 'user.message', { text: 'cancel' }),
    event(1, 'tool.call', { call_id: 'call-cancel', tool: 'check_managed_machine_ssh' }),
    event(2, 'tool.result', { call_id: 'call-cancel', status: 'cancelled', value: { error: 'request cancelled' } }),
    event(3, 'turn.cancelled', { error: 'request cancelled' }),
  ]);
  assert.equal(cancelled[0].tools[0].status, 'cancelled');
  const failed = assistantTimeline([
    event(0, 'user.message', { text: 'fail' }),
    event(1, 'tool.call', { call_id: 'call-fail', tool: 'check_managed_machine_ssh' }),
    event(2, 'tool.result', { call_id: 'call-fail', status: 'error', value: { error: 'ssh_failed' } }),
    event(3, 'turn.failed', { error: 'ssh_failed' }),
  ]);
  assert.equal(failed[0].tools[0].status, 'error');
});

test('SSE reader preserves split UTF-8 and CRLF chunks with credentials', async () => {
  const originalFetch = globalThis.fetch;
  const events = [event(0, 'user.message', { text: '中文问题' }), event(1, 'assistant.delta', { text: '中文答复' }), event(2, 'turn.completed')];
  const bytes = new TextEncoder().encode(': connected\r\n\r\n' + events.map(item => `event: session-event\r\ndata: ${JSON.stringify(item)}\r\n\r\n`).join(''));
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/v1/assistant/sessions/session-1/turns'); assert.equal(options.credentials, 'include');
    assert.equal(JSON.parse(options.body).text, '中文问题');
    return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try { const received = []; await streamTurn('session-1', '中文问题', undefined, item => received.push(item), new AbortController().signal); assert.deepEqual(received, events); }
  finally { globalThis.fetch = originalFetch; }
});

test('SSE reader reports incomplete turns instead of fabricating completion', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify(event(0, 'assistant.delta', { text: 'partial' }))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  try { await assert.rejects(streamTurn('session-1', 'test', undefined, () => {}, new AbortController().signal), /连接已中断/); }
  finally { globalThis.fetch = originalFetch; }
});

test('provider unavailable response stays an explicit UI error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'AI provider is not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  try { await assert.rejects(streamTurn('session-1', 'test', undefined, () => {}, new AbortController().signal), /not configured/); }
  finally { globalThis.fetch = originalFetch; }
});

test('stored dashboard draft preview uses its successful analysis range', () => {
  const range = { from: '2026-10-10T00:00:00Z', to: '2026-10-10T02:00:00Z' };
  const turn = { tools: [{ name: 'run_query', status: 'success', result: { range } }, { name: 'run_query', status: 'error', result: { range: { from: 'wrong', to: 'wrong' } } }] };
  assert.deepEqual(queryRangeFromTurn(turn), range);
});

test('multiple drafts in one turn keep their own preceding query ranges', () => {
  const first = { from: '2026-10-10T00:00:00Z', to: '2026-10-10T01:00:00Z' }, second = { from: '2026-10-10T02:00:00Z', to: '2026-10-10T03:00:00Z' };
  const turn = { tools: [{ name: 'run_query', callId: 'query-1', status: 'success', result: { range: first } }, { name: 'draft_dashboard', callId: 'draft-1', status: 'success' }, { name: 'run_query', callId: 'query-2', status: 'success', result: { range: second } }, { name: 'draft_dashboard', callId: 'draft-2', status: 'success' }] };
  assert.deepEqual(queryRangeFromTurn(turn, 'draft-1'), first); assert.deepEqual(queryRangeFromTurn(turn, 'draft-2'), second);
});


test('reported usage accumulates by phase and replay does not double count', () => {
 const events = [event(0,'user.message',{text:'继续'}), event(1,'context.compacting'), event(2,'turn.usage',{phase:'compact',input_tokens:100,total_tokens:120}), event(3,'context.compacted'), event(4,'turn.usage',{phase:'execute',input_tokens:40,output_tokens:8,total_tokens:48}), event(5,'turn.usage',{phase:'execute',input_tokens:20,output_tokens:4,total_tokens:24}), event(6,'turn.completed')];
 const [turn] = assistantTimeline([...events,events[4]]);
 assert.deepEqual(turn.usage,{input_tokens:60,output_tokens:12,total_tokens:72});
 assert.deepEqual(turn.compactionUsage,{input_tokens:100,total_tokens:120});
 assert.equal(turn.compacted,true);assert.equal(turn.compacting,false);
 const [cancelled] = assistantTimeline([event(0,'context.compacting'),event(1,'turn.cancelled',{error:'cancelled'})]);
 assert.equal(cancelled.compacting,false);
});

test('missing token counts remain unavailable', () => {
 const [turn] = assistantTimeline([event(0,'turn.usage',{phase:'execute',output_tokens:8,total_tokens:'unknown'}),event(1,'turn.completed')]);
 assert.deepEqual(turn.usage,{output_tokens:8});
});

test('degraded history compaction remains explicit in the timeline', () => {
 const [turn] = assistantTimeline([event(0,'context.compacting'),event(1,'context.compacted',{degraded:true}),event(2,'turn.completed')]);
 assert.equal(turn.compacted,true);
 assert.equal(turn.degraded,true);
 assert.equal(turn.compacting,false);
});

test('timeline records turn and tool start/end timestamps for elapsed display', () => {
  const stamps = ['2026-10-10T00:00:00Z', '2026-10-10T00:00:10Z', '2026-10-10T00:00:30Z', '2026-10-10T00:01:00Z'];
  const stampEvent = (sequence, type, data = {}) => ({ sequence, type, data, turn_id: 'turn-t', session_id: 'session-1', timestamp: stamps[sequence] ?? stamps.at(-1) });
  const [turn] = assistantTimeline([
    stampEvent(0, 'user.message', { text: '长任务' }),
    stampEvent(1, 'tool.call', { call_id: 'call-1', tool: 'slow_tool' }),
    stampEvent(2, 'tool.result', { call_id: 'call-1', status: 'success', value: { ok: true } }),
    stampEvent(3, 'turn.completed'),
  ]);
  assert.equal(turn.startedAt, stamps[0]);
  assert.equal(turn.endedAt, stamps[3]);
  assert.equal(turn.tools[0].startedAt, stamps[1]);
  assert.equal(turn.tools[0].endedAt, stamps[2]);
  const [running] = assistantTimeline([stampEvent(0, 'user.message', { text: 'x' }), { ...stampEvent(1, 'tool.call', { call_id: 'c', tool: 'run_query' }) }]);
  assert.equal(running.endedAt, undefined);
  assert.equal(running.tools[0].endedAt, undefined);
});

test('stream failures are recognizable disconnects the UI can recover from', async () => {
  const originalFetch = globalThis.fetch;
  const events = [event(0, 'assistant.delta', { text: 'partial' })];
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify(events[0])}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    let failure;
    try { await streamTurn('session-1', 'test', undefined, () => {}, new AbortController().signal); }
    catch (problem) { failure = problem; }
    assert.ok(failure instanceof TurnStreamError);
    assert.equal(failure.code, 'disconnected');
    assert.match(failure.message, /连接已中断/);
  } finally { globalThis.fetch = originalFetch; }
});
