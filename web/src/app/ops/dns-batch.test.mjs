import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from '../../features/dashboards/test-module.mjs';
const {batchItems, splitValues, dnsOutcome, executeDNSBatch, recordID} = loadSource(new URL('./dns-batch.ts', import.meta.url));
const {ApiError} = loadSource(new URL('../../shared/api.ts', import.meta.url));
const record = {id: '18446744073709551614', name: 'www', type: 'MX', value: 'mail.example.test', ttl: 900, line: '电信', line_id: '10=0', priority: 20, weight: 7, enabled: false};
const success = {run: {state: 'succeeded', result: {verified: true}}};

test('one line and many values creates distinct records, preserving meaningful value whitespace', () => {
  const values = '203.0.113.1\r\n\n203.0.113.2\n203.0.113.1\n  text  ';
  assert.deepEqual(splitValues(values), ['203.0.113.1', '203.0.113.2', '  text  ']);
  const items = batchItems('create_record', [], {name: '@', type: 'A', ttl: 600, line: 'telecom', enabled: true, values});
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].record, {name: '@', type: 'A', ttl: 600, line: 'telecom', enabled: true, value: '203.0.113.1'});
  assert.ok(!('id' in items[0].record));
  assert.ok(!('values' in items[0].record));
});

test('batch edits preserve record identity, routing, TTL, priority, weight and disabled state', () => {
  assert.equal(recordID(record), '18446744073709551614');
  assert.equal(recordID({provider_record_id: record.id}), record.id);
  const onlyValue = batchItems('update_record', [record], {changeValue: true, value: 'other.example.test', type: 'A'})[0];
  assert.deepEqual(onlyValue.record, {...record, value: 'other.example.test'});
  assert.deepEqual(onlyValue.original, record);
  assert.deepEqual(batchItems('update_record', [record], {changeType: true, type: 'TXT'})[0].record, {...record, type: 'TXT'});
  assert.deepEqual(batchItems('update_record', [record], {changeType: true, type: 'A', changeValue: true, value: '192.0.2.1'})[0].record, {...record, type: 'A', value: '192.0.2.1'});
  assert.equal(record.type, 'MX');
});

test('empty batches, oversized batches and edits with no chosen field cannot execute', () => {
  assert.throws(() => batchItems('create_record', [], {values: '\n  '}), /count/);
  assert.throws(() => batchItems('create_record', [], {values: Array.from({length: 51}, (_, i) => String(i)).join('\n')}), /count/);
  assert.throws(() => batchItems('update_record', [record], {}), /fields/);
  assert.equal(batchItems('create_record', [], {values: Array.from({length: 50}, (_, i) => String(i)).join('\n')}).length, 50);
});

test('HTTP success never hides failed, unknown, missing or unverified business receipts', () => {
  assert.equal(dnsOutcome(success).state, 'succeeded');
  for (const state of ['failed', 'unknown']) assert.equal(dnsOutcome({run: {state, result: {code: 'provider_error'}}}).state, state);
  assert.equal(dnsOutcome({run: {state: 'succeeded', result: {state: 'verifying'}}}).state, 'verifying');
  assert.equal(dnsOutcome({run: {state: 'succeeded', result: {verified: false}}}).state, 'verifying');
  assert.equal(dnsOutcome({}).state, 'unknown');
  assert.equal(dnsOutcome({run: {state: 'running', result: {}}}).state, 'unknown');
});

test('serial execution continues after per-record failure and never retries an uncertain write', async () => {
  const targets = batchItems('delete_record', [1, 2, 3, 4].map(id => ({...record, id: String(id)})), {});
  const called = []; let inFlight = 0;
  const results = await executeDNSBatch(targets, async item => {
    assert.equal(inFlight++, 0); called.push(item.key); await Promise.resolve(); inFlight--;
    if (item.key === '1') return {run: {state: 'failed', result: {code: 'provider_rejected'}}};
    if (item.key === '2') throw Error('connection lost');
    if (item.key === '3') return {run: {state: 'succeeded', result: {verified: false}}};
    return success;
  }, () => {}, () => false);
  assert.deepEqual(called, ['1', '2', '3', '4']);
  assert.deepEqual(results.map(item => item.state), ['failed', 'unknown', 'verifying', 'succeeded']);
  assert.deepEqual(targets.map(item => item.state), ['waiting', 'waiting', 'waiting', 'waiting']);
});

test('stop finishes the current request and skips remaining records', async () => {
  let stop = false, calls = 0;
  const results = await executeDNSBatch(batchItems('delete_record', [record, {...record, id: '2'}], {}), async () => {calls++; stop = true; return success;}, () => {}, () => stop);
  assert.equal(calls, 1); assert.deepEqual(results.map(item => item.state), ['succeeded', 'skipped']);
});

test('authorization/revision rejection stops subsequent writes, while validation failures remain per record', async () => {
  for (const status of [401, 403, 409, 422, 500]) {
    let calls = 0;
    const results = await executeDNSBatch(batchItems('delete_record', [record, {...record, id: '2'}], {}), async () => {calls++; if (calls === 1) throw new ApiError('rejected', status, {}); return success;}, () => {}, () => false);
    assert.equal(results[0].state, status === 500 ? 'unknown' : 'failed');
    assert.equal(calls, [401, 403, 409].includes(status) ? 1 : 2);
    assert.equal(results[1].state, [401, 403, 409].includes(status) ? 'skipped' : 'succeeded');
  }
});
