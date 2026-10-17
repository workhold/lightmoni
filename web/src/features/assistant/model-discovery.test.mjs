import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelDiscovery, discoveryInput } from './model-discovery.ts';

const input = { base_url: 'https://example.com/v1', api_key: '', use_saved_key: true, protocol: 'auto' };
const result = { base_url: input.base_url, protocol: 'openai-chat-completions', protocol_options: ['openai-chat-completions', 'openai-responses'], protocol_source: 'catalog', requires_confirmation: true, capabilities_verified: false, models: [{ id: 'fixture' }], truncated: false };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('typing debounces to the latest credentials; invalid addresses do not query', async () => {
  const calls = [], states = [];
  const discovery = new ModelDiscovery(async value => { calls.push(value); return result; }, state => states.push(state), 10);
  try {
    discovery.setInput(input);
    discovery.setInput({ ...input, api_key: 'new-key' });
    await delay(25);
    assert.equal(calls.length, 1); assert.equal(calls[0].api_key, 'new-key');
    assert.equal(states.at(-1).status, 'success');
    assert.equal(discoveryInput({ base_url: 'file:///tmp/model' }, true), undefined);
    assert.equal(discoveryInput({ base_url: 'https://example.com/v1?key=secret' }, true), undefined);
    assert.equal(discoveryInput({ base_url: 'https://user:pass@example.com' }, true), undefined);
    assert.deepEqual(discoveryInput({ base_url: ' https://example.com/v1 ', clear_key: true }, true), { ...input, use_saved_key: false });
  } finally { discovery.dispose(); }
});

test('new input aborts an in-flight request and rejects stale results even when transport ignores abort', async () => {
  const pending = [], states = [];
  const discovery = new ModelDiscovery((value, signal) => { const item = { ...deferred(), value, signal }; pending.push(item); return item.promise; }, state => states.push(state));
  try {
    discovery.setInput(input); discovery.refresh();
    discovery.setInput({ ...input, base_url: 'https://other.example/v1' }); discovery.refresh();
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({ ...result, base_url: 'https://other.example/v1', models: [{ id: 'new' }] });
    await delay(0);
    pending[0].resolve(result); await delay(0);
    assert.deepEqual(states.at(-1).result.models, [{ id: 'new' }]);
    assert.equal(states.filter(state => state.status === 'success').length, 1);
  } finally { discovery.dispose(); }
});

test('closing cancels scheduled and running queries without publishing late failures', async () => {
  const states = [], pending = deferred(); let calls = 0, signal;
  const discovery = new ModelDiscovery((_, abort) => { calls++; signal = abort; return pending.promise; }, state => states.push(state), 10);
  discovery.setInput(input); discovery.dispose(); await delay(20); assert.equal(calls, 0);
  discovery.setInput(input); discovery.refresh(); discovery.dispose();
  const count = states.length; assert.equal(signal.aborted, true);
  pending.reject(new Error('late failure')); await delay(0);
  assert.equal(states.length, count);
});

test('a discovered canonical address does not start a second request or select a model', async () => {
  let calls = 0; const states = [];
  const discovery = new ModelDiscovery(async () => { calls++; return result; }, state => states.push(state), 5);
  try {
    discovery.setInput({ ...input, base_url: 'https://example.com' }); discovery.refresh(); await delay(0);
    discovery.setInput(input); await delay(15);
    assert.equal(calls, 1); assert.equal(states.at(-1).status, 'success');
    assert.equal('model' in states.at(-1).result, false);
  } finally { discovery.dispose(); }
});

test('errors allow explicit retry and empty directories are valid successes', async () => {
  let calls = 0; const states = [];
  const discovery = new ModelDiscovery(async () => { if (++calls === 1) throw new Error('模型服务拒绝了密钥'); return { ...result, models: [] }; }, state => states.push(state));
  try {
    discovery.setInput(input); discovery.refresh(); await delay(0);
    assert.equal(states.at(-1).status, 'error'); assert.match(states.at(-1).error, /密钥|API Key/);
    discovery.refresh(); await delay(0);
    assert.equal(states.at(-1).status, 'success'); assert.deepEqual(states.at(-1).result.models, []);
  } finally { discovery.dispose(); }
});

test('protocol and clear-key changes cancel stale advice even when transport ignores abort', async () => {
  const pending = [], states = [];
  const discovery = new ModelDiscovery((value, signal) => { const item = { ...deferred(), value, signal }; pending.push(item); return item.promise; }, state => states.push(state));
  try {
    discovery.setInput(input); discovery.refresh();
    const changed = discoveryInput({ base_url: input.base_url, protocol: 'anthropic-messages', clear_key: true }, true);
    discovery.setInput(changed); discovery.refresh();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].value.protocol, 'anthropic-messages');
    assert.equal(pending[1].value.use_saved_key, false);
    const native = { ...result, protocol: 'anthropic-messages', protocol_options: ['anthropic-messages'], protocol_source: 'manual', requires_confirmation: false };
    pending[1].resolve(native); await delay(0);
    pending[0].resolve(result); await delay(0);
    assert.equal(states.at(-1).result.protocol, 'anthropic-messages');
    assert.deepEqual(discovery.currentResult(changed), native);
    assert.equal(discovery.currentResult(input), undefined);
  } finally { discovery.dispose(); }
});

test('only advice for the latest complete input can resolve an automatic save', async () => {
  const discovery = new ModelDiscovery(async () => result, () => {}, 5);
  try {
    discovery.setInput(input); discovery.refresh(); await delay(0);
    assert.deepEqual(discovery.currentResult(input), result);
    assert.equal(discovery.currentResult({ ...input, api_key: 'changed-key' }), undefined);
    assert.equal(discovery.currentResult({ ...input, protocol: 'google-generative-ai' }), undefined);
    discovery.setInput({ ...input, api_key: 'changed-key' });
    assert.equal(discovery.currentResult(input), undefined);
    discovery.dispose(); assert.equal(discovery.currentResult(input), undefined);
  } finally { discovery.dispose(); }
});

test('canonical base adoption preserves automatic selection and avoids a feedback query', async () => {
  let calls = 0;
  const discovery = new ModelDiscovery(async () => { calls++; return result; }, () => {}, 5);
  try {
    discovery.setInput({ ...input, base_url: 'https://example.com' }); discovery.refresh(); await delay(0);
    discovery.setInput(input); await delay(15);
    assert.equal(calls, 1); assert.deepEqual(discovery.currentResult(input), result);
    assert.equal(discoveryInput({ base_url: input.base_url, protocol: 'unsupported' }, false), undefined);
  } finally { discovery.dispose(); }
});

test('refresh retains automatic endpoint evidence after correcting the field; a connection edit clears it', async () => {
  const calls = [], states = [];
  const endpoint = 'https://example.com/v1/messages';
  const native = { ...result, protocol: 'anthropic-messages', protocol_options: ['anthropic-messages'], protocol_source: 'endpoint-path', requires_confirmation: false };
  const discovery = new ModelDiscovery(async value => {
    calls.push(value);
    return value.base_url === endpoint ? native : result;
  }, state => states.push(state));
  try {
    discovery.setInput({ ...input, base_url: endpoint }); discovery.refresh(); await delay(0);
    discovery.setInput(input); discovery.refresh(); await delay(0);
    assert.deepEqual(calls.map(value => value.base_url), [endpoint, endpoint]);
    assert.deepEqual(discovery.currentResult(input), native);
    assert.equal(states.at(-1).result.protocol, 'anthropic-messages');
    discovery.setInput({ ...input, api_key: 'changed-key' }); discovery.refresh(); await delay(0);
    assert.equal(calls.at(-1).base_url, input.base_url);
    assert.equal(calls.at(-1).api_key, 'changed-key');
    assert.deepEqual(states.at(-1).result, result);
  } finally { discovery.dispose(); }
});

test('directory credential and saved-key failures are actionable Chinese without provider text', async () => {
  const cases = [
    { status: 502, details: { code: 'credentials_rejected' }, expected: /有效的 API Key/ },
    { status: 400, details: { code: 'saved_key_mismatch' }, expected: /地址|已保存密钥/ },
  ];
  for (const failure of cases) {
    const states = [];
    const discovery = new ModelDiscovery(async () => { throw { ...failure, message: 'private-secret https://internal.invalid provider body' }; }, state => states.push(state));
    try {
      discovery.setInput(input); discovery.refresh(); await delay(0);
      assert.match(states.at(-1).error, failure.expected);
      assert.doesNotMatch(states.at(-1).error, /private-secret|internal.invalid|provider body/);
    } finally { discovery.dispose(); }
  }
});
