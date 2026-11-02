export type AgentOperationKind='install'|'uninstall';
export type AgentOperationRecord={id:string;machine_id:string;kind?:AgentOperationKind;status:string;execution_stage?:string;created_at?:string;started_at?:string;finished_at?:string;error?:string;resolved_at?:string};
export const agentOperationRunning=(record:AgentOperationRecord|undefined|null)=>!!record&&!record.resolved_at&&record.status==='running';
export const agentOperationMatches=(record:AgentOperationRecord|undefined|null,machineID:string,operationID?:string)=>!!record&&!!record.id&&record.machine_id===machineID&&(!operationID||record.id===operationID);
export const AGENT_OPERATION_READ_TIMEOUT_MS=10_000;
/** Bound one progress GET while allowing its owning effect to cancel it early. */
export function agentOperationReadSignal(parent:AbortSignal,timeoutMs=AGENT_OPERATION_READ_TIMEOUT_MS){
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new RangeError('timeoutMs must be a positive finite number');
 const controller=new AbortController();let disposed=false;
 const abortFromParent=()=>controller.abort(parent.reason);
 if(parent.aborted)abortFromParent();else parent.addEventListener('abort',abortFromParent,{once:true});
 const timer=setTimeout(()=>controller.abort(new DOMException('Agent operation progress request timed out','TimeoutError')),timeoutMs);
 return {signal:controller.signal,dispose(){if(disposed)return;disposed=true;clearTimeout(timer);parent.removeEventListener('abort',abortFromParent)}};
}
/** Stale reads and late POST responses cannot reopen a completed operation. */
export const agentOperationCanAdvance=(previous:AgentOperationRecord|undefined|null,next:AgentOperationRecord)=>{
 if(!previous||previous.id!==next.id||previous.machine_id!==next.machine_id)return true;
 if(previous.resolved_at&&!next.resolved_at)return false;
 if(['succeeded','failed','cancelled'].includes(previous.status)&&next.status!==previous.status)return false;
 if(previous.status==='unknown'&&['awaiting_approval','running'].includes(next.status))return false;
 return previous.status!=='running'||next.status!=='awaiting_approval';
};
export function agentOperationProgress(kind:AgentOperationKind,record:AgentOperationRecord,submitting=false){
 const active=!record.resolved_at&&(record.status==='running'||submitting&&record.status==='awaiting_approval');
 let percent=0,stage=record.status==='awaiting_approval'?(submitting?'submitting':'review'):'planned';
 if(kind==='install'){
  const stages:Record<string,number>={planned:0,preflight:15,enrollment_issuing:30,enrollment_issued:30,bootstrap_dispatched:55};
  if(record.status==='awaiting_approval')percent=0;
  else if(record.execution_stage&&Object.hasOwn(stages,record.execution_stage)){stage=record.execution_stage;percent=stages[stage]}
  else if(record.status==='running'){stage='installing';percent=50}
 }else if(record.status==='running'||['unknown','failed'].includes(record.status)&&!!record.started_at){stage='removing';percent=50}
 if(record.status==='succeeded'){stage='complete';percent=100}
 return {active,percent,stage,status:record.resolved_at?'resolved':submitting&&record.status==='awaiting_approval'?'submitting':record.status};
}
