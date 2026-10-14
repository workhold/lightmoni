import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantTimeline, queryRangeFromTurn } from './timeline.ts';
import { streamTurn } from './client.ts';

function event(sequence, type, data = {}, turn_id = 'turn-1') { return { sequence, type, data, turn_id, session_id: 'session-1', timestamp: '2026-10-10T00:00:00Z' }; }

test('timeline uses durable turn ids, deduplicates replay, and replaces streamed text with committed text', () => {
  const events = [event(0, 'user.message', { text: '相同问题' }), event(1, 'assistant.delta', { text: '部分', step: 1 }), event(2, 'assistant.message', { text: '完整回答', step: 1 }), event(3, 'turn.completed'), event(4, 'user.message', { text: '相同问题' }, 'turn-2'), event(5, 'tool.call', { call_id: 'call-1', tool: 'run_query', input: {} }, 'turn-2'), event(6, 'turn.cancelled', { error: 'request cancelled' }, 'turn-2')];
  const turns = assistantTimeline([...events, events[1]]);
  assert.equal(turns.length, 2); assert.equal(turns[0].answer, '完整回答'); assert.equal(turns[0].status, 'completed');
  assert.equal(turns[1].status, 'cancelled'); assert.equal(turns[1].tools[0].status, 'error');
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
