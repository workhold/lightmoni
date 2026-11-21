import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import AgentUpdateRecoveryCard from './AgentUpdateRecoveryCard.tsx';

const base = {
  id:'update-1', machine_id:'machine-1', agent_id:'agent-1', action:'upgrade', status:'unknown',
  created_at:'2026-11-21T00:00:00Z', recovery_revision:'c'.repeat(64),
  plan:{
    machine:{id:'machine-1',name:'vchive',address:'192.0.2.1',port:22},
    ssh_account:{id:'account-1',username:'root',revision:1},
    current:{version:'0.1.8',source_revision:'old'},
    target:{version:'0.1.9',source_revision:'new',arch:'amd64',sha256:'a'.repeat(64),build_id:'new'},
    expires_at:'2099-11-21T00:00:00Z',steps:[],warnings:[],
  },
};
const props={
  latest:{at:'2026-11-21T08:00:00Z',stage:'unknown'}, stageText:()=> '结果待核对',
  credentialSelect:createElement('select'), accountHelp:null,
  recoveryReviewed:false, refreshNeeded:false, changing:false, busy:'', recoveryRevisionReady:true,
  onReconcile:()=>{}, onRecover:()=>{}, onConfirmRecovery:()=>{},
};

test('unknown outcome shows ordered verification before reviewed recovery', () => {
  const html=renderToStaticMarkup(createElement(AgentUpdateRecoveryCard,{...props,record:base,recoveryNeedsVerification:false}));
  assert.match(html,/先核对，再恢复/);
  assert.match(html,/1 · 只读核对/);
  assert.match(html,/2 · 审阅后恢复/);
  assert.match(html,/恢复影响/);
  assert.doesNotMatch(html,/维护结果待核对；进程已停止时可审阅恢复/);
});

test('an unconfirmed prior recovery stays locked with concise guidance', () => {
  const html=renderToStaticMarkup(createElement(AgentUpdateRecoveryCard,{...props,record:{...base,recovery_requires_verification:true},recoveryLocked:true}));
  assert.match(html,/上次恢复结果未知/);
  assert.match(html,/恢复已锁定/);
});
