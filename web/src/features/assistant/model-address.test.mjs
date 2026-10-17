import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAddressCorrection } from './model-address.ts';

test('version correction explains the selected protocol and preserves the displayed addresses', () => {
  const original = 'https://gateway.example/tenant%2Fprivate/v1beta/messages/';
  const corrected = 'https://gateway.example/tenant%2Fprivate/v1';
  const notice = describeAddressCorrection(original, corrected);
  assert.equal(notice.original, original);
  assert.equal(notice.corrected, corrected);
  assert.match(notice.reason, /完整接口地址/);
  assert.match(notice.reason, /按所选协议.*\/v1beta.*\/v1/);
  assert.doesNotMatch(notice.reason, /规范化 API 基址格式/);
});

test('literal version replacement differs from an escaped tenant segment or a custom version', () => {
  for (const path of ['/tenant%2Fv1beta', '/tenant/v2', '/v1beta/tenant', '/v1beta']) {
    const base = `https://gateway.example${path}`;
    assert.equal(describeAddressCorrection(base, base), undefined);
  }
  const notice = describeAddressCorrection('https://gateway.example/tenant%2Fv1beta', 'https://gateway.example/tenant%2Fv1');
  assert.doesNotMatch(notice.reason, /所选协议|版本路径/);
});

test('root version completion and endpoint cleanup have distinct explanations', () => {
  for (const version of ['/v1', '/v1beta']) {
    const notice = describeAddressCorrection('https://gateway.example', `https://gateway.example${version}`);
    assert.match(notice.reason, /补全模型目录可用的版本路径/);
    assert.ok(notice.reason.includes(version));
    assert.doesNotMatch(notice.reason, /修正为/);
  }
  const notice = describeAddressCorrection(' https://GATEWAY.example:443/v1/responses/ ', 'https://gateway.example/v1');
  assert.match(notice.reason, /首尾空白/);
  assert.match(notice.reason, /完整接口地址/);
  assert.match(notice.reason, /末尾多余的/);
});
