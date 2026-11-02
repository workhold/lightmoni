import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitoringTools } from '../src/assistant/tools.js';
import type { Dependencies } from '../src/shared/types.js';

test('AI installation preflight defaults to audited auto selection and manual mode pins the credential', async()=>{
 const calls:any[]=[];
 const machines={installationPreflight:async(...args:any[])=>{calls.push(args);return {id:'check-1',account_id:'account-root',username:'root',ready:true,installation_selection:{mode:args[1].selection}};},assistantPlan:(...args:any[])=>{calls.push(args);return {status:'awaiting_approval',review_url:'/machines?machine=host'};}};
 const tools=monitoringTools({} as Dependencies,{machines:machines as any}),check=tools.find(t=>t.name==='check_managed_machine_ssh')!,plan=tools.find(t=>t.name==='propose_agent_install')!,signal=new AbortController().signal,admin={id:'admin',role:'admin'};
 assert.equal((await check.execute({machine_id:'host'},signal,admin)).installation_selection.mode,'auto');
 assert.deepEqual(calls[0],['host',{selection:'auto'},'admin',signal]);
 await check.execute({machine_id:'host',selection:'manual',credential_id:'binding-deploy'},signal,admin);
 assert.deepEqual(calls[1],['host',{selection:'manual',credential_id:'binding-deploy'},'admin',signal]);
 const proposed=await plan.execute({machine_id:'host',check_id:'check-1',version:'1.0.0',arch:'amd64'},signal,admin);
 assert.equal(proposed.status,'awaiting_approval');
 assert.equal(calls[2][1].check_id,'check-1');
 assert.equal(calls[2][1].runtime_mode,'root');
 const unprivileged=await plan.execute({machine_id:'host',check_id:'check-1',version:'1.0.0',arch:'amd64',runtime_mode:'user'},signal,admin);
 assert.equal(unprivileged.status,'awaiting_approval');
 assert.equal(calls[3][1].runtime_mode,'user');
 await plan.execute({machine_id:'host',check_id:'check-1',version:'1.0.0',arch:'amd64',runtime_mode:'root'},signal,admin);
 assert.equal(calls[4][1].runtime_mode,'root');
 assert.equal(tools.some(t=>/apply.*install|install.*apply/.test(t.name)),false);
});

test('AI installation plans reject invalid runtime modes before creating a proposal',async()=>{
 let invoked=0;const machines={assistantPlan:()=>{invoked++;return {};}};
 const plan=monitoringTools({} as Dependencies,{machines:machines as any}).find(t=>t.name==='propose_agent_install')!,signal=new AbortController().signal,admin={id:'admin',role:'admin'},input={machine_id:'host',check_id:'check-1',version:'1.0.0',arch:'amd64'};
 for(const runtime_mode of [null,'sudo','',true,0,{},['user']])await assert.rejects(plan.execute({...input,runtime_mode},signal,admin),/invalid_agent_runtime_mode/);
 await assert.rejects(plan.execute({...input,runtime_mode:'user'},signal,{id:'member',role:'member'}),/administrator required/);
 assert.equal(invoked,0);
});

test('AI preflight rejects mixed selection, unknown fields and non-administrators before checking SSH',async()=>{
 let invoked=0;const machines={installationPreflight:async()=>{invoked++;return {};}};
 const check=monitoringTools({} as Dependencies,{machines:machines as any}).find(t=>t.name==='check_managed_machine_ssh')!,signal=new AbortController().signal,admin={id:'admin',role:'admin'};
 for(const input of [{machine_id:'host',credential_id:'c'},{machine_id:'host',selection:'auto',credential_id:'c'},{machine_id:'host',selection:'manual'},{machine_id:'host',selection:'fallback'},{machine_id:'host',command:'id'}])await assert.rejects(check.execute(input,signal,admin));
 await assert.rejects(check.execute({machine_id:'host'},signal,{id:'member',role:'member'}),/administrator required/);
 assert.equal(invoked,0);
});
