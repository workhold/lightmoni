import type { DockerInventory } from '../shared/application-observation.js';
import { dockerInventory } from '../shared/application-observation.js';
import type { OperationExecutionContext } from '../operations/types.js';
import type { ExecutionReceipt } from './executor.js';
import { acquireOperationLock } from './operation-lock.js';

export const DOCKER_CAPABILITIES = ['docker.inventory', 'docker.control'];
export type DockerAction = {kind:'docker';operation:'inventory'|'start'|'stop'|'restart';container_id?:string};
export const dockerError = (error: any): string => {
  const code = error?.code;
  return ['docker_cli_missing','docker_permission_denied','docker_daemon_unavailable','docker_command_timeout','operations_node_locked'].includes(code) ? code
    : code === 'operation_dependency_unavailable' ? 'docker_cli_missing'
    : code === 'operation_command_timeout' ? 'docker_command_timeout' : 'docker_collection_unavailable';
};

/** Only public inventory fields leave the node; labels and inspect secrets never do. */
export async function readDockerInventory(command: OperationExecutionContext['command'], signal?: AbortSignal): Promise<DockerInventory> {
  const result = await command('docker',['--context','default','ps','--all','--no-trunc','--format','{{json .}}'],{timeoutMs:15000,signal});
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  let composeAvailable:boolean|undefined;
  try {await command('docker',['--context','default','compose','version','--short'],{timeoutMs:15000,signal});composeAvailable=true;}
  catch(error:any){if(error?.diagnosticCode==='compose_unavailable')composeAvailable=false;}
  const at = new Date().toISOString();
  const snapshot = dockerInventory({observed_at:at,attempted_at:at,compose_available:composeAvailable,state:'ready',truncated:rows.length>500,containers:rows.slice(0,500).map(c=>{
    if(!/^[a-f0-9]{64}$/.test(c.ID))throw Error('invalid_docker_inventory');
    const label = String(c.Labels??'').split(',').find(v=>v.startsWith('io.lightmoni.platform.instance='));
    return {id:c.ID,name:c.Names,image:c.Image,state:c.State,ports:c.Ports,deployment_id:label?.slice('io.lightmoni.platform.instance='.length)??''};
  })})!;
  while(Buffer.byteLength(JSON.stringify(snapshot))>80*1024){snapshot.containers.pop();snapshot.truncated=true;}
  return snapshot;
}

export async function executeDocker(action: DockerAction, jobID: string, context: OperationExecutionContext,
  emit: (event:{phase:string;summary:string})=>Promise<void>): Promise<ExecutionReceipt> {
  const started = context.now().toISOString();
  let changing=false,unknown=false,containerState='',lock: Awaited<ReturnType<typeof acquireOperationLock>>|undefined;
  let snapshot: DockerInventory|undefined;
  try {
    if(action.kind!=='docker'||!['inventory','start','stop','restart'].includes(action.operation)
      || (action.operation==='inventory' ? action.container_id!==undefined : !/^[a-f0-9]{64}$/.test(action.container_id??'')))throw Error('invalid_docker_action');
    await emit({phase:'accepted',summary:'Agent accepted the Docker task'});
    context.signal.throwIfAborted();
    if(action.operation!=='inventory')lock=await acquireOperationLock(context.dataDir,jobID,context.now());
    await emit({phase:'staging',summary:'Checking Docker prerequisites'});
    const inspect = async()=>{
      const result=await context.command('docker',['--context','default','inspect','--format','{{.Id}} {{.State.Status}}',action.container_id!],{timeoutMs:15000,signal:context.signal});
      const [id,state]=result.stdout.trim().split(/\s+/);
      if(id!==action.container_id||!state)throw Error('docker_container_mismatch');
      return state;
    };
    if(action.operation!=='inventory')await inspect();
    await emit({phase:'activating',summary:action.operation==='inventory'?'Collecting Docker inventory':'Executing the confirmed container action'});
    if(action.operation!=='inventory'){
      context.signal.throwIfAborted();
      changing=true;
      await context.command('docker',['--context','default',action.operation,...(action.operation==='start'?[]:['--time','10']),action.container_id!],{timeoutMs:30000,signal:context.signal});
      const state=await inspect();
      containerState=state;
      if(action.operation==='stop'? !['exited','created'].includes(state):state!=='running')throw Error('docker_state_not_verified');
    }
    snapshot=await readDockerInventory(context.command,context.signal);
    context.signal.throwIfAborted();
    await emit({phase:'verifying',summary:'Docker state and inventory verified'});
    return {state:'succeeded',code:'',summary:'Docker task completed and verified',snapshot:{health:{healthy:true},docker:{operation:action.operation,container_id:action.container_id??'',container_state:containerState,inventory:snapshot}},started_at:started,finished_at:context.now().toISOString()};
  }catch(error){
    unknown=changing;
    return {state:unknown?'unknown':'failed',code:dockerError(error),summary:unknown?'Docker action result is unknown; refresh and inspect before retrying':'Docker task failed; inspect the collection diagnostic',snapshot:{docker:{operation:action.operation,container_id:action.container_id??'',error:dockerError(error),attempted_at:context.now().toISOString()}},started_at:started,finished_at:context.now().toISOString()};
  }finally{await lock?.finish(unknown);}
}
