import type { OperationPayload } from '../operations/types.js';
import { canonicalJSON, strictRecord } from './privileged-executor.js';
export const MANAGED_OPERATIONS_CAPABILITY = 'operations.managed.v1' as const;
export interface ManagedExecutionPayload {
  kind:'managed'; operation:'execute'; resource_id:string; resource_revision:number;
  job:{id:string;agent_id:string;expires_at:string;capabilities:string[];actions:any[];target:Record<string,any>};
  operation_payload?:OperationPayload; timeout_ms:number; max_output_bytes:number;
}
/** Fixed adapters only. This is a separate high-trust host-management grant,
 * never an extension of the restricted, mount-free container capability. */
export function managedExecutionPayload(value:unknown):ManagedExecutionPayload {
  const v=strictRecord(value,['kind','operation','resource_id','resource_revision','job','operation_payload','timeout_ms','max_output_bytes'],['kind','operation','resource_id','resource_revision','job','timeout_ms','max_output_bytes']);
  const j=strictRecord(v.job,['id','agent_id','expires_at','capabilities','actions','target']);
  if(v.kind!=='managed'||v.operation!=='execute'||!/^[a-f0-9]{32}$/.test(v.resource_id)||j.id!==v.resource_id||v.resource_revision!==1
    ||typeof j.agent_id!=='string'||!Number.isFinite(Date.parse(j.expires_at))||!Array.isArray(j.capabilities)||!j.capabilities.length||j.capabilities.length>30
    ||j.capabilities.some((c:unknown)=>typeof c!=='string'||!/^[a-z][a-z0-9_.-]{0,63}$/.test(c))
    ||!Array.isArray(j.actions)||!j.actions.length||j.actions.length>50||!j.target||typeof j.target!=='object'||Array.isArray(j.target)
    ||!Number.isSafeInteger(v.timeout_ms)||v.timeout_ms<1000||v.timeout_ms>600000||v.max_output_bytes!==262144)throw Error('invalid_managed_execution');
  if(Buffer.byteLength(canonicalJSON(v))>1200000)throw Error('invalid_managed_execution');
  const operations=j.actions.filter((a:any)=>a?.kind==='operations'),docker=j.actions.filter((a:any)=>a?.kind==='docker');
  if(operations.length) {
    const a=operations[0],p=v.operation_payload;
    strictRecord(a,['kind','operation_id','domain']);
    if(j.actions.length!==1||!p||p.operation_id!==a.operation_id||p.resource?.agent_id!==j.agent_id||p.resource.id!==j.target.operations_resource_id
      ||p.resource.kind!==(a.domain==='platform'?'platform':a.domain)||!j.capabilities.includes('operations.'+a.domain))throw Error('managed_operation_mismatch');
  }else if(v.operation_payload!==undefined)throw Error('unexpected_operation_payload');
  if(docker.length) {
    const a=docker[0];strictRecord(a,['kind','operation','container_id'],['kind','operation']);
    if(j.actions.length!==1||!['inventory','start','stop','restart'].includes(a.operation)||a.operation!=='inventory'&&!/^[a-f0-9]{64}$/.test(a.container_id??''))throw Error('unsafe_managed_docker_action');
  }
  if(j.actions.some((a:any)=>!['operations','docker','stage_artifact','activate_release','systemd','health_check','systemd_probe'].includes(a?.kind)))throw Error('unsafe_managed_action');
  return v as ManagedExecutionPayload;
}
