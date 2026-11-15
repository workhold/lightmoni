import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultAgentRuntimeMode} from './agent-runtime-model.ts';

test('runtime mode defaults preserve historical monitoring mode and keep the existing fresh-host default',()=>{
 assert.equal(defaultAgentRuntimeMode({agent_runtime_mode:'user'}),'user');
 assert.equal(defaultAgentRuntimeMode({agent_runtime_mode:'root'}),'root');
 assert.equal(defaultAgentRuntimeMode({}),'root');
 assert.equal(defaultAgentRuntimeMode({agent_runtime_mode:null}),'root');
});
