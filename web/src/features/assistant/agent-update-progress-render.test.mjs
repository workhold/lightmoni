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
  assert.match(html, /type="checkbox"/); assert.match(html, /我已审阅主机/);
  assert.match(html, /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*确认升级/s);
  assert.match(html, /等待管理员审批/); assert.match(html, /确认后开始执行/); assert.match(html, /aria-valuenow="0"/);
});

test('expired native plan stays at zero and asks for a fresh plan', () => {
  const expired = { ...record, plan: { ...record.plan, expires_at: '2000-01-01T00:00:00Z' } };
  const html = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: expired, canApprove: true }));
  assert.match(html, /计划已过期/); assert.match(html, /请让助手重新准备/); assert.match(html, /aria-valuenow="0"/);
  assert.doesNotMatch(html, /确认后开始执行/);
});

test('running plan only reports accepted execution, not approval or success', () => {
  const html = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: { ...record, status: 'running', events: [{ at: '2026-11-15T00:00:01Z', stage: 'accepted' }] }, canApprove: true }));
  assert.match(html, /维护器已接收/); assert.doesNotMatch(html, /确认升级/); assert.doesNotMatch(html, /更新成功/);
  assert.match(html, /维护器已接收/); assert.match(html, /aria-valuenow="25"/);
});

test('a remote success event awaiting platform health verification is not shown as success', () => {
  const html = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: { ...record, status: 'running', events: [{ at: '2026-11-15T00:00:01Z', stage: 'waiting_confirmation' }, { at: '2026-11-15T00:00:02Z', stage: 'succeeded' }] }, canApprove: true }));
  assert.match(html, /等待新进程健康确认/); assert.doesNotMatch(html, /更新成功/); assert.match(html, /aria-valuenow="80"/);
});

test('members and malformed results get no approval action', () => {
  const member = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: record, canApprove: false }));
  assert.doesNotMatch(member, /确认升级/);
  const invalid = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: { error: 'target changed' }, canApprove: true }));
  assert.equal(invalid, '');
});

test('unknown native record renders read-only reconciliation and reviewed recovery only for administrators', () => {
  const unknown = { ...record, status: 'unknown', recovery_revision: 'c'.repeat(64), recovery_requires_verification: false };
  const admin = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: unknown, canApprove: true }));
  assert.match(admin, /只读核对结果/); assert.match(admin, /恢复中断维护/); assert.match(admin, /我已核对目标主机/);
  const member = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: unknown, canApprove: false }));
  assert.doesNotMatch(member, /只读核对结果/); assert.doesNotMatch(member, /恢复中断维护/);
  assert.doesNotMatch(member, /type="checkbox"/);
});

test('failed updates show recovery guidance without presenting its steps as completed', () => {
  const html = renderToStaticMarkup(createElement(AgentUpdateProgress, { value: { ...record, status: 'failed' }, canApprove: true }));
  assert.match(html, /请打开原更新记录核对最后阶段和主机状态/);
  assert.doesNotMatch(html, /已完成状态修正/);
});
