import assert from 'node:assert/strict';
import test from 'node:test';
import { toolSummary, formatElapsed } from './tool-summary.ts';

const en = (zh, enText) => enText ?? zh;

test('run_query badges summarize rows, queries, elapsed and truncation', () => {
  const results = [
    { refId: 'A', status: 'success', elapsed_ms: 12, truncated: false, frames: [{ columns: [{ name: 'n' }], rows: [[1], [2]] }] },
    { refId: 'B', status: 'success', elapsed_ms: 8, truncated: true, frames: [{ columns: [{ name: 'n' }], rows: [[3]] }] },
  ];
  assert.deepEqual(toolSummary('run_query', { results }, en), [
    { text: '2 queries' },
    { text: '3 rows' },
    { text: '20 ms' },
    { kind: 'warn', text: 'Results truncated' },
  ]);
  // The real tool receipt wraps the response under `query` with range metadata.
  assert.deepEqual(toolSummary('run_query', { query: { results }, range: {}, sample_limit: 1000 }, en), [
    { text: '2 queries' },
    { text: '3 rows' },
    { text: '20 ms' },
    { kind: 'warn', text: 'Results truncated' },
  ]);
});

test('run_query failures surface the query error as an error badge', () => {
  const result = { results: [{ refId: 'A', status: 'error', error: 'unknown table', elapsed_ms: 0, truncated: false, frames: [] }] };
  assert.deepEqual(toolSummary('run_query', result, en), [{ kind: 'error', text: 'unknown table' }, { text: '0 rows' }]);
});

test('list and describe tools report item and column counts', () => {
  assert.deepEqual(toolSummary('list_tables', [{ name: 'a' }, { name: 'b' }], en), [{ text: '2 tables' }]);
  assert.deepEqual(toolSummary('describe_table', { columns: [{ name: 'id' }, { name: 'body' }] }, en), [{ text: '2 columns' }]);
  assert.deepEqual(toolSummary('list_alert_rules', { items: [1, 2, 3] }, en), [{ text: '3 items' }]);
});

test('tool errors become error badges and unknown shapes stay quiet', () => {
  assert.deepEqual(toolSummary('get_managed_machine', { error: 'host offline' }, en), [{ kind: 'error', text: 'host offline' }]);
  assert.deepEqual(toolSummary('get_managed_machine', { id: 'm-1' }, en), []);
  assert.deepEqual(toolSummary('run_query', undefined, en), []);
});

test('long error text is truncated instead of flooding the card', () => {
  const badges = toolSummary('run_query', { results: [{ refId: 'A', status: 'error', error: 'x'.repeat(400), elapsed_ms: 0, truncated: false, frames: [] }] }, en);
  assert.equal(badges[0].text.length, 181);
  assert.ok(badges[0].text.endsWith('…'));
});

test('formatElapsed renders mm:ss and hh:mm:ss, ticks running turns and rejects inverted ranges', () => {
  const start = '2026-11-23T00:00:00Z';
  assert.equal(formatElapsed(start, '2026-11-23T00:01:05Z', 0), '01:05');
  assert.equal(formatElapsed(start, '2026-11-23T01:02:03Z', 0), '1:02:03');
  assert.equal(formatElapsed(start, undefined, Date.parse('2026-11-23T00:00:59Z')), '00:59');
  assert.equal(formatElapsed(undefined, start, 0), '');
  assert.equal(formatElapsed('not-a-time', undefined, 0), '');
  assert.equal(formatElapsed(start, '2026-11-22T23:00:00Z', 0), '');
});
