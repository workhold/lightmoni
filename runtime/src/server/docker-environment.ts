export interface DockerEnvironment { state:string; code:string; observed_at:string; source:'executor'|'none' }
export interface ExecutorDockerObservation {
 executor:{state:string;online:boolean;last_seen:string}|null;
 capabilities:Record<string,{effective:string}>;
 docker_inventory?:{state:string;compose_available?:boolean;error?:string};
}
/** A control heartbeat is never evidence of access to the privileged daemon. */
export function machineDockerEnvironment(status:ExecutorDockerObservation|undefined,now:Date):DockerEnvironment {
 const unknown:DockerEnvironment={state:'unknown',code:'executor_observation_required',observed_at:'',source:'none'};
 const executor=status?.executor;
 if(!executor||executor.state!=='active')return unknown;
 const at=Date.parse(executor.last_seen),recent=Number.isFinite(at)&&at>now.getTime()-60000&&at<=now.getTime()+60000;
 if(!executor.online||!recent)return {state:'stale',code:'executor_observation_required',observed_at:executor.last_seen,source:'executor'};
 const inventory=status!.capabilities['operations.managed.v1']?.effective==='ready'?status!.docker_inventory:undefined;
 if(inventory){
  const state=inventory.state==='ready'?(inventory.compose_available===false?'compose_missing':'ready'):({docker_cli_missing:'missing',docker_daemon_unavailable:'daemon_unavailable',docker_permission_denied:'permission_denied'} as Record<string,string>)[inventory.error??'']??'unavailable';
  return {state,code:state==='compose_missing'?'compose_unavailable':inventory.error??'',observed_at:executor.last_seen,source:'executor'};
 }
 return status!.capabilities['container.managed.v1']?.effective==='ready'
  ?{state:'ready',code:'',observed_at:executor.last_seen,source:'executor'}
  :{state:'unavailable',code:'executor_capability_unavailable',observed_at:executor.last_seen,source:'executor'};
}
