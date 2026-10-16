import assert from 'node:assert/strict';
import test from 'node:test';
import { initialProtocol, protocolChoices, protocolLabel, protocolSourceLabel, reasoningEffortChoices, resolveProtocol, modelConnectionError } from './model-protocol.ts';

const catalog = { base_url: 'https://gateway.example/v1', protocol: 'openai-chat-completions', protocol_options: ['openai-chat-completions', 'openai-responses'], protocol_source: 'catalog', requires_confirmation: true, capabilities_verified: false, models: [{ id: 'manual-name-remains-independent' }], truncated: false };
const concrete = ['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

test('selector covers automatic and four concrete protocols; legacy and fresh settings differ', () => {
  assert.deepEqual(protocolChoices.map(option => option.value), ['auto', ...concrete]);
  assert.equal(initialProtocol(), 'auto');
  assert.equal(initialProtocol({ base_url: '', protocol: 'openai-chat-completions' }), 'auto');
  assert.equal(initialProtocol({ base_url: 'https://legacy.example/v1' }), 'openai-chat-completions');
  for (const protocol of concrete) {
    assert.equal(initialProtocol({ base_url: 'https://configured.example/v1', protocol }), protocol);
    assert.equal(typeof protocolLabel(protocol), 'string');
  }
});

test('reasoning selector exposes the provider-default and supported neutral levels', () => {
  assert.deepEqual(reasoningEffortChoices.map(option => option.value), ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(reasoningEffortChoices[0].label, '跟随模型（自动）');
});

test('a shared OpenAI catalog requires a concrete selection, not its first recommendation', () => {
  const unresolved = resolveProtocol('auto', catalog);
  assert.equal(unresolved.protocol, undefined); assert.match(unresolved.error, /选择.*协议/);
  assert.deepEqual(resolveProtocol('openai-responses', catalog), { protocol: 'openai-responses' });
  assert.equal(catalog.models[0].id, 'manual-name-remains-independent');
  assert.equal(catalog.capabilities_verified, false);
});

test('unambiguous advice resolves to a concrete saved protocol while source stays explainable', () => {
  for (const protocol of concrete) {
    const result = { ...catalog, protocol, protocol_options: [protocol], requires_confirmation: false, protocol_source: 'endpoint-path' };
    assert.deepEqual(resolveProtocol('auto', result), { protocol });
  }
  assert.match(protocolSourceLabel('official-host'), /官方/);
  assert.match(protocolSourceLabel('endpoint-path'), /接口地址/);
  assert.match(protocolSourceLabel('catalog'), /模型目录/);
  assert.match(protocolSourceLabel('manual'), /手动/);
  assert.match(protocolSourceLabel('future-source'), /服务/);
});

test('no directory still allows all manual protocols and model names; automatic cannot save without current advice', () => {
  for (const protocol of concrete) assert.deepEqual(resolveProtocol(protocol), { protocol });
  assert.equal(resolveProtocol('auto').protocol, undefined);
  assert.match(resolveProtocol('auto').error, /获取模型|手动选择/);
  assert.equal(resolveProtocol('unsupported', catalog).protocol, undefined);
  assert.equal(resolveProtocol('auto', { protocol: 'openai-chat-completions', models: [] }).protocol, undefined);
});

test('safe Chinese failures distinguish credentials, session, address mismatch and directory fallback', () => {
  assert.match(modelConnectionError({ status: 401, message: 'provider unauthorized' }), /有效的 API Key/);
  assert.match(modelConnectionError({ status: 401, message: 'login required' }), /登录/);
  assert.match(modelConnectionError({ status: 400, message: 'saved credential is unavailable for this address' }), /重新填写|清除/);
  assert.match(modelConnectionError({ status: 400, message: 'a new API key or clear_key is required when changing the API base URL' }), /地址/);
  assert.match(modelConnectionError({ details: { code: 'directory_unsupported' } }), /手动/);
  assert.match(modelConnectionError({ details: { code: 'timeout' } }), /超时/);
  assert.doesNotMatch(modelConnectionError(new Error('private-api-key provider response content')), /private-api-key|provider response/);
});
