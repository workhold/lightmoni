import { prepareManagedWeb } from "./managed-web-permissions.js";
import { assertLegacyMigration } from './migration.js';
import { startManagedGateway } from "./managed-gateway.js";
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync,existsSync,realpathSync } from 'node:fs';
import { canonicalJSON,normalizePrivilegedPayload,parseStrictJSON,planClaims,sha256,type PrivilegedPlan } from '../shared/privileged-executor.js';
import { managedExecutionPayload,type ManagedExecutionPayload } from '../shared/managed-execution.js';
import { executeOperation,operationCommand } from '../agent/operations.js';
import { executeDocker } from '../agent/docker.js';
import { CapabilityExecutor,type ExecutionReceipt } from '../agent/executor.js';
import { loadConfig,EXECUTOR_CONFIG,type ExecutorConfig } from './config.js';
import { requestExecutor } from './client.js';
import { inspectManagedDockerDaemon } from './docker.js';
import { assertRoot,boundedFile,durableWrite,rootPath,secureDirectory,refuse } from './security.js';
import { executeScript,interpreterDigest,interpreterPath,localAccount,productionScriptHost,type ExecutionStartGuard,type ScriptOutcome } from './scripts.js';

export const MANAGED_DATA_DIR='/var/lib/lightmoni-managed';
export interface ManagedRunContext {config:ExecutorConfig;plan:PrivilegedPlan;unit:string;signal:AbortSignal;guard:ExecutionStartGuard}
/** The same fixed systemd launcher/monotonic guard as reviewed scripts, with a
 * generated constant adapter entry. User input can never supply this code. */
export async function runManaged(payload:ManagedExecutionPayload,c:ManagedRunContext):Promise<ScriptOutcome> {
  assertRoot();managedExecutionPayload(payload);
  const directory=join(c.config.data_dir,'managed-jobs');secureDirectory(directory);
  const filename=join(directory,payload.job.id+'.json'),snapshot=canonicalJSON({plan:c.plan,payload});
  durableWrite(filename,snapshot);
  try{
    const moduleURL=new URL('./managed.js',import.meta.url).href;rootPath(fileURLToPath(moduleURL));
    const code='import('+JSON.stringify(moduleURL)+').then(m=>m.runManagedSnapshot(process.argv[2],process.argv[3])).catch(()=>{process.stderr.write("managed_worker_refused\\n");process.exitCode=125})';
    const script=normalizePrivilegedPayload({kind:'script',runtime:'node',code,interpreter_sha256:interpreterDigest(interpreterPath('node')),args:[filename,sha256(snapshot)],cwd_profile:'private',environment:{},account:localAccount('root'),timeout_ms:payload.timeout_ms,max_output_bytes:payload.max_output_bytes});
    const outcome=await executeScript(script,c.unit,[localAccount('root')],productionScriptHost(),c.signal,c.guard);
    if(outcome.state!=='succeeded')return{...outcome,state:'unknown',code:'managed_worker_unknown',stdout:'',stderr:''};
    const receipt=parseStrictJSON(outcome.stdout,128<<10) as ExecutionReceipt;
    if(!['succeeded','failed','unknown'].includes(receipt.state)||!receipt.snapshot)refuse('invalid_managed_receipt');
    return{state:receipt.state,code:receipt.code??'',summary:'Approved managed operation completed',exit_code:receipt.state==='succeeded'?0:null,stdout:canonicalJSON(receipt),stderr:''};
  }finally{try{unlinkSync(filename);}catch{}}
}
/** Only invoked by the fixed root-owned per-job program above. */
export async function runManagedSnapshot(filename:string,expectedDigest:string):Promise<void> {
  assertRoot();
  const config=loadConfig(EXECUTOR_CONFIG);
  if(!new RegExp('^'+config.data_dir+'/managed-jobs/[a-f0-9]{32}\\.json$').test(filename)||!/^[a-f0-9]{64}$/.test(expectedDigest))refuse('invalid_managed_snapshot');
  const raw=boundedFile(filename,1400000,true);if(sha256(raw)!==expectedDigest)refuse('managed_snapshot_changed');
  const input=parseStrictJSON(raw,1400000),payload=managedExecutionPayload(input.payload),plan=planClaims(input.plan);
  if(plan.job_id!==payload.job.id||plan.request_sha256!==sha256(canonicalJSON(payload))||plan.capability!=='operations.managed.v1'||plan.executor_id!==config.executor_id||plan.agent_id!==config.agent_id||plan.install_generation!==config.install_generation)refuse('principal_mismatch');
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let sequence=0;
  const request=(route:string,value:unknown)=>requestExecutor(config,'jobs/'+plan.job_id+'/'+route,value);
  const authority=async()=>{controller.signal.throwIfAborted();const reply=await request('renew',{lease_id:plan.lease_id});if(reply.cancel_requested||reply.state!=='running')refuse('execution_cancelled');controller.signal.throwIfAborted();};
  const emit=async(event:{phase:string;summary:string;code?:string;snapshot?:Record<string,unknown>})=>{
    if(['succeeded','failed','unknown','cancelled'].includes(event.phase))return;
    controller.signal.throwIfAborted();await request('events',{lease_id:plan.lease_id,sequence:++sequence,phase:event.phase,code:'',detail:event});
  };
  secureDirectory(MANAGED_DATA_DIR);
  const binary=(name:string)=>{
    if(!['docker','nginx','systemctl','tar','id','ps','certbot','useradd'].includes(name))refuse('managed_command_not_allowed');
    for(const base of ['/usr/local/bin','/usr/sbin','/usr/bin']){
      const path=join(base,name);
      if(existsSync(path))return rootPath(realpathSync(path));
    }
    throw Object.assign(Error('operation_dependency_unavailable'),{code:'operation_dependency_unavailable',...(name==='docker'?{diagnosticCode:'docker_cli_missing'}:{})});
  };
  const command:typeof operationCommand=async(file,args,options={})=>{
    await authority();
    if(file==='docker') {
      if(!config.daemon_id||(await inspectManagedDockerDaemon()).daemon_id!==config.daemon_id)refuse('docker_daemon_changed');
      if(options.env&&Object.keys(options.env).some(k=>k.startsWith('DOCKER_')&&k!=='DOCKER_CONFIG'))refuse('docker_environment_not_allowed');
      const fixedArgs=args[0]==='--context'&&args[1]==='default'?args.slice(2):args;
      return operationCommand(binary(file),['--host=unix:///var/run/docker.sock',...fixedArgs],{...options,env:{...options.env,DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONTEXT:''},signal:controller.signal});
    }
    if(file==='nginx'&&!args.includes('-t')&&!args.includes('-s'))return startManagedGateway(MANAGED_DATA_DIR,binary('nginx'),args,operationCommand,binary('systemctl'),controller.signal);
    return operationCommand(binary(file),args,{...options,signal:controller.signal});
  };
  try{
    await authority();rootPath(config.data_dir,'directory',true);
    let receipt:ExecutionReceipt;
    if(payload.operation_payload){
      const kind=payload.operation_payload.resource.kind;
      try{assertLegacyMigration(({website:'websites',certificate:'certificates',backup:'backups'} as Record<string,string>)[kind]??kind);}
      catch(error){if((error as Error).message!=='legacy_managed_state_requires_review')throw error;process.stdout.write(canonicalJSON({state:'failed',code:'legacy_managed_state_requires_review',summary:'Review the fixed offline migration plan before changing existing business state',snapshot:{},started_at:new Date().toISOString(),finished_at:new Date().toISOString()}));return;}
    }
    const webProfile=payload.operation_payload&&['website','certificate'].includes(payload.operation_payload.resource.kind)?await prepareManagedWeb(MANAGED_DATA_DIR,command):{};
    const context={dataDir:MANAGED_DATA_DIR,signal:controller.signal,now:()=>new Date(),command,...webProfile};
    if(payload.operation_payload)receipt=await executeOperation(payload.operation_payload,context,emit);
    else if(payload.job.actions[0]?.kind==='docker')receipt=await executeDocker(payload.job.actions[0],payload.job.id,context,emit);
    else {
      const executor=new CapabilityExecutor({now:()=>new Date(),command:(file,args,timeoutMs,signal)=>command(file,args,{timeoutMs,signal}),emit,
        downloadArtifact:async(action,signal)=>{
          const chunks:Buffer[]=[];let offset=0;
          while(offset<action.size){signal.throwIfAborted();const part=await request('artifacts',{lease_id:plan.lease_id,release_id:action.release_id,offset});if(part.offset!==offset||part.size!==action.size||part.sha256!==action.sha256||typeof part.data!=='string')refuse('artifact_digest_mismatch');const bytes=Buffer.from(part.data,'base64');if(!bytes.length||bytes.length>384<<10||offset+bytes.length>action.size)refuse('invalid_artifact_range');chunks.push(bytes);offset+=bytes.length;}
          const raw=Buffer.concat(chunks);if(raw.length!==action.size||sha256(raw)!==action.sha256)refuse('artifact_digest_mismatch');return raw;
        }});
      const target=payload.job.target.config??{};
      receipt=await executor.execute({id:payload.job.id,expires_at:payload.job.expires_at,capabilities:payload.job.capabilities,actions:payload.job.actions,target:{unit:String(target.unit??''),releaseDirectory:String(target.release_directory??'')}},controller.signal);
    }
    process.stdout.write(canonicalJSON(receipt));
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
