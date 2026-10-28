export type BatchAction='ssh_check'|'install'|'uninstall'|'remove_node'|'delete_host';
export type BatchMachine={id:string;name:string;address:string;port:number;agent_id:string;agent_status:string;connection_method:string;host_key_status:string;username?:string;capabilities?:Record<string,{available:boolean;reason:string}>};
export type BatchTarget={id:string;name:string;address?:string;port?:number;machine?:BatchMachine;agent?:{id:string;hostname:string;lifecycle_state?:'active'|'removed'}};
export type BatchCredential={id:string;method:string;expires_at:string;secret_fingerprint?:string;revoked_at?:string;secret_cleared_at?:string;retention?:string};
export type BatchPlan={id:string;status:string;error?:string;plan?:{machine?:BatchMachine;agent_id?:string;credential?:{id:string;method:string;expires_at:string};check_id?:string;expires_at:string;version?:string;arch?:string;steps?:string[];warnings?:string[];retained_paths?:string[];removed_paths?:string[]};receipt?:Record<string,unknown>};
export type BatchDetail={machine:BatchMachine;credentials:BatchCredential[];deployments?:BatchPlan[];uninstallations?:BatchPlan[]};
export type BatchStatus='pending'|'processing'|'success'|'failed'|'not_applicable'|'unknown';

export const MAX_BATCH_TARGETS=50;
export const needsBatchPlan=(action:BatchAction)=>action==='install'||action==='uninstall';
export const batchPlanKind=(action:BatchAction)=>action==='uninstall'?'uninstallations':'deployments';
export const machineBatchPath=(id:string)=>`/machines/${encodeURIComponent(id)}`;
export const batchPlanPath=(action:BatchAction,machineID:string,planID?:string)=>`${machineBatchPath(machineID)}/${batchPlanKind(action)}${planID?`/${encodeURIComponent(planID)}`:''}`;
export const batchHistoryURL=(action:BatchAction,machineID:string,planID?:string)=>`/machines?machine=${encodeURIComponent(machineID)}${planID?`&${action==='uninstall'?'uninstallation':'deployment'}=${encodeURIComponent(planID)}`:''}`;
export const activeBatchCredential=(credential:BatchCredential,now=Date.now())=>!credential.revoked_at&&!credential.secret_cleared_at&&Date.parse(credential.expires_at)>now;
export const batchCredentials=(action:BatchAction,credentials:BatchCredential[],now=Date.now())=>credentials.filter(credential=>activeBatchCredential(credential,now)&&(credential.method==='ssh_key'||(action==='ssh_check'&&credential.method==='password')));
export const batchPlanExpired=(record:BatchPlan,now=Date.now())=>!Number.isFinite(Date.parse(record.plan?.expires_at||''))||Date.parse(record.plan?.expires_at||'')<=now;
export const batchPlanStatus=(record:BatchPlan):BatchStatus=>record.status==='succeeded'?'success':['running','unknown'].includes(record.status)?'unknown':['failed','cancelled'].includes(record.status)?'failed':'pending';

// These checks explain unavailable rows. The server independently revalidates
// authorization, credentials, identities and operation locks on every request.
export function batchUnavailableReason(action:BatchAction,target:BatchTarget,detail?:BatchDetail):string{
 if(action==='remove_node')return !target.agent?'node_required':target.agent.lifecycle_state==='removed'?'node_removed':'';
 const machine=detail?.machine||target.machine;
 if(!machine)return 'host_required';
 if(action==='delete_host'){
  if(!detail)return '';
  if(detail.credentials.some(credential=>activeBatchCredential(credential)))return 'active_credentials';
  if(detail.deployments?.some(plan=>['awaiting_approval','running'].includes(plan.status)))return 'deployment_pending';
  if(detail.uninstallations?.some(plan=>['awaiting_approval','running','unknown'].includes(plan.status)))return 'uninstallation_pending';
  return '';
 }
 if(machine.connection_method!=='direct_ssh')return 'direct_ssh_required';
 if(machine.host_key_status!=='confirmed')return 'host_fingerprint_required';
 if(action==='install'&&machine.agent_id)return 'agent_already_installed';
 if(action==='uninstall'&&!machine.agent_id)return 'agent_not_linked';
 const capability=machine.capabilities?.[action==='install'?'deploy_agent':action==='uninstall'?'uninstall_agent':'ssh_check'];
 if(capability&&!capability.available)return capability.reason||'unavailable';
 if(detail){
  if(action!=='ssh_check'&&detail.deployments?.some(plan=>['awaiting_approval','running'].includes(plan.status)))return 'deployment_pending';
  if(action!=='ssh_check'&&detail.uninstallations?.some(plan=>['awaiting_approval','running','unknown'].includes(plan.status)))return 'uninstallation_pending';
  if(!batchCredentials(action,detail.credentials).length)return action==='ssh_check'?'ssh_credential_required':'ssh_key_required';
 }
 return '';
}
