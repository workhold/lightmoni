import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import AgentOperationProgress from './AgentOperationProgress.tsx';

const record={id:'op-1',machine_id:'host-1',status:'running',execution_stage:'bootstrap_dispatched',started_at:'2026-11-15T00:00:00Z'};
test('active operation refresh failures retain progress and explicitly keep automatic retry',()=>{
 const html=renderToStaticMarkup(createElement(AgentOperationProgress,{kind:'install',machineID:'host-1',record,refreshError:'refresh failed'}));
 assert.match(html,/refresh failed/);assert.match(html,/正在自动重试读取原记录，请勿重复提交操作/);assert.match(html,/aria-valuenow="55"/);
});
test('terminal refresh failures do not claim automatic retry',()=>{
 const html=renderToStaticMarkup(createElement(AgentOperationProgress,{kind:'install',machineID:'host-1',record:{...record,status:'succeeded',execution_stage:'complete',finished_at:'2026-11-15T00:01:00Z'},refreshError:'refresh failed'}));
 assert.doesNotMatch(html,/正在自动重试读取原记录/);
});
