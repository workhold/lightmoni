import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import AgentUpdateProgress from './AgentUpdateProgress.tsx';

const record = {
  id: 'update-1', machine_id: 'machine-1', agent_id: 'agent-1', action: 'upgrade', status: 'awaiting_approval', created_at: '2026-11-15T00:00:00Z', review_url: '/machines?machine=machine-1&update=update-1',
  plan: {
    machine: { id: 'machine-1', name: 'host-one', address: '192.0.2.1', port: 22 },
    ssh_account: { id: 'account-1', username: 'root', revision: 1 },
    current: { version: '0.1.0', source_revision: 'old', fingerprint: 'abc' },
    target: { version: '0.1.0', source_revision: 'new', arch: 'amd64', sha256: 'a'.repeat(64), build_id: 'build-new' },
    expires_at: '2099-11-15T00:00:00Z', steps: ['核对主机、Agent 身份与当前程序指纹'], warnings: ['维护期间暂停该主机的新任务派发和领取。'],
  },
};

test('awaiting native plan renders its summary and administrator approval actions', () => {
  const html = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: record, canApprove: true }));
  assert.match(html, /host-one/); assert.match(html, /确认升级/); assert.match(html, /取消计划/); assert.match(html, /原更新记录/); assert.match(html, /目标包 SHA256/);
});

test('running plan only reports accepted execution, not approval or success', () => {
  const html = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: { ...record, status: 'running' }, canApprove: true }));
  assert.match(html, /执行请求已接受/); assert.doesNotMatch(html, /确认升级/); assert.doesNotMatch(html, /更新成功/);
});

test('members and malformed results get no approval action', () => {
  const member = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: record, canApprove: false }));
  assert.doesNotMatch(member, /确认升级/);
  const invalid = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: { error: 'target changed' }, canApprove: true }));
  assert.equal(invalid, '');
});
