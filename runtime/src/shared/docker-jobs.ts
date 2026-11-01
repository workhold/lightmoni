import { dockerInventory } from './application-observation.js';

export const DOCKER_ERROR_CODES=['docker_cli_missing','docker_permission_denied','docker_daemon_unavailable','docker_command_timeout','docker_collection_unavailable','operations_node_locked','invalid_docker_receipt','job_expired','unknown_execution_result'];
export const safeDockerCode=(code:unknown)=>DOCKER_ERROR_CODES.includes(String(code))?String(code):'docker_collection_unavailable';
export const dockerJobAction=(actions:any[])=>actions.length===1&&actions[0]?.kind==='docker'?actions[0]:undefined;

/** Bind an authenticated receipt to the immutable action, with no raw CLI output. */
export function dockerReceipt(action:any,value:any,issuedAt:string,now:Date){
  const data=value?.docker;
  if(!data||data.operation!==action.operation||data.container_id!==(action.container_id??''))throw Error('invalid_docker_receipt');
  const snapshot=dockerInventory(data.inventory);
  if(!snapshot||snapshot.state!=='ready'||Date.parse(snapshot.observed_at)<Date.parse(issuedAt)-5000||Date.parse(snapshot.observed_at)>now.getTime()+60000)throw Error('invalid_docker_receipt');
  if(action.operation!=='inventory'&&(action.operation==='stop'?!['exited','created'].includes(data.container_state):data.container_state!=='running'))throw Error('invalid_docker_receipt');
  return {health:{healthy:value.health?.healthy===true},docker:{operation:action.operation,container_id:action.container_id??'',container_state:action.operation==='inventory'?'':String(data.container_state),inventory:snapshot}};
}
