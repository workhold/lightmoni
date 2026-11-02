import {test} from "node:test";
import assert from "node:assert/strict";
import {agentOperationMatches,agentOperationProgress,agentOperationReadSignal,agentOperationRunning,type AgentOperationRecord} from "../../web/src/app/agent-operation-progress.js";

const operation=(patch:Partial<AgentOperationRecord>={}):AgentOperationRecord=>({id:"operation-1",machine_id:"host-1",status:"awaiting_approval",...patch});

test("progress stays below completion for every unresolved and unsuccessful outcome",()=>{
 for(const kind of ["install","uninstall"] as const){
  for(const status of ["awaiting_approval","running","failed","unknown","cancelled"]){
   const record=operation({status,execution_stage:"bootstrap_dispatched",started_at:"2026-11-02T00:00:00Z"});
   const result=agentOperationProgress(kind,record);
   assert.ok(result.percent>=0&&result.percent<100,kind+" "+status);
   assert.equal(result.active,status==="running");
  }
  const succeeded=agentOperationProgress(kind,operation({status:"succeeded"}));
  assert.equal(succeeded.percent,100);assert.equal(succeeded.active,false);assert.equal(succeeded.stage,"complete");
  const unknown=agentOperationProgress(kind,operation({status:"unknown",resolved_at:"2026-11-02T01:00:00Z"}),true);
  assert.equal(unknown.status,"resolved");assert.equal(unknown.active,false);assert.ok(unknown.percent<100);
 }
});

test("approval remains at zero despite stale remote stages while dispatched unknown removal retains its last stage",()=>{
 const waiting=operation({status:"awaiting_approval",execution_stage:"bootstrap_dispatched",started_at:"2026-11-02T00:00:00Z"});
 for(const kind of ["install","uninstall"] as const){
  const pending=agentOperationProgress(kind,waiting);
  assert.equal(pending.percent,0);assert.equal(pending.stage,"review");assert.equal(pending.active,false);
  const submitting=agentOperationProgress(kind,waiting,true);
  assert.equal(submitting.percent,0);assert.equal(submitting.stage,"submitting");assert.equal(submitting.active,true);
 }
 for(const status of ["unknown","failed"]){
  const removal=agentOperationProgress("uninstall",operation({status,started_at:"2026-11-02T00:00:00Z"}));
  assert.equal(removal.percent,50);assert.equal(removal.stage,"removing");assert.equal(removal.active,false);
 }
 const cancelled=agentOperationProgress("uninstall",operation({status:"cancelled",started_at:"2026-11-02T00:00:00Z"}));
 assert.equal(cancelled.percent,0);assert.equal(cancelled.stage,"planned");assert.equal(cancelled.active,false);
});

test("progress uses durable installation evidence and never advances merely from elapsed time",()=>{
 const checks:[[string,number],...Array<[string,number]>]=[["planned",0],["preflight",15],["enrollment_issuing",30],["enrollment_issued",30],["bootstrap_dispatched",55]];
 for(const [stage,percent] of checks){
  const record=operation({status:"running",execution_stage:stage,started_at:"2000-01-01T00:00:00Z"});
  assert.equal(agentOperationProgress("install",record).percent,percent);
  assert.deepEqual(agentOperationProgress("install",record),agentOperationProgress("install",{...record,started_at:"2099-01-01T00:00:00Z"}));
 }
 const missing=agentOperationProgress("install",operation({status:"running",execution_stage:"unrecognized"}));
 assert.notEqual(missing.stage,"complete");assert.notEqual(missing.stage,"bootstrap_dispatched");assert.ok(missing.percent<100);
});

test("submission shows activity without claiming a dispatched or completed remote operation",()=>{
 const record=operation();
 for(const kind of ["install","uninstall"] as const){
  assert.equal(agentOperationProgress(kind,record).active,false);
  const submitting=agentOperationProgress(kind,record,true);
  assert.equal(submitting.status,"submitting");assert.equal(submitting.active,true);assert.equal(submitting.percent,0);
  assert.equal(agentOperationProgress(kind,operation({status:"failed"}),true).active,false);
  assert.equal(agentOperationProgress(kind,operation({status:"unknown"}),true).active,false);
 }
});

test("host and operation IDs isolate progress and only running records request fast reads",()=>{
 const record=operation({status:"running"});
 assert.equal(agentOperationMatches(record,"host-1","operation-1"),true);
 assert.equal(agentOperationMatches(record,"host-2","operation-1"),false);
 assert.equal(agentOperationMatches(record,"host-1","operation-2"),false);
 assert.equal(agentOperationMatches({...record,id:""},"host-1"),false);
 assert.equal(agentOperationMatches(null,"host-1"),false);
 assert.equal(agentOperationRunning(record),true);
 assert.equal(agentOperationRunning({...record,resolved_at:"2026-11-02T00:00:00Z"}),false);
 for(const status of ["awaiting_approval","unknown","failed","cancelled","succeeded"])assert.equal(agentOperationRunning({...record,status}),false);
});

test("progress GET signal aborts at its deadline and remains disposable",async()=>{
 const parent=new AbortController(),request=agentOperationReadSignal(parent.signal,5),aborted=new Promise<void>(resolve=>request.signal.addEventListener("abort",()=>resolve(),{once:true}));
 await aborted;assert.equal(request.signal.aborted,true);assert.equal((request.signal.reason as Error).name,"TimeoutError");request.dispose();request.dispose();
});

test("progress GET signal aborts when its dialog closes before the deadline",async()=>{
 const parent=new AbortController(),request=agentOperationReadSignal(parent.signal,1000),aborted=new Promise<void>(resolve=>request.signal.addEventListener("abort",()=>resolve(),{once:true}));
 parent.abort();await aborted;assert.equal(request.signal.aborted,true);request.dispose();
});

test("disposing a progress GET signal clears its deadline without cancelling the parent",async()=>{
 const parent=new AbortController(),request=agentOperationReadSignal(parent.signal,10);request.dispose();
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(request.signal.aborted,false);assert.equal(parent.signal.aborted,false);
});
