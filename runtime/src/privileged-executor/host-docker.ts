import {acquireOperationLock} from '../agent/operation-lock.js';
import type {ExecutionReceipt} from '../agent/executor.js';
import {hostDockerCode,hostDockerHash,hostDockerReadOnly,hostDockerReceipt,normalizeHostDockerAction,IMAGE_ID,CONTAINER_ID,type ContainerDetail,type HostDockerAction,type HostDockerResult,type HostImage} from '../shared/host-docker.js';
import {validateManagedDockerDaemonInfo,type ManagedDockerTransport} from './docker.js';

export interface HostDockerContext{dataDir:string;daemonID:string;signal:AbortSignal;now:()=>Date;authorize:()=>Promise<void>;transport:ManagedDockerTransport}
const API='/v1.43';
const fail=(code:string):never=>{throw Error(code)};
const body=(v:unknown):any=>{try{return typeof v==='string'?JSON.parse(v):v}catch{return fail('host_docker_unavailable')}};
const clean=(v:any,max=256)=>String(v??'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,max);
const array=(v:any,max=2000):any[]=>{if(!Array.isArray(v)||v.length>max)fail('host_docker_unavailable');return v};

/** A fixed Engine adapter under the existing signed host-management grant.
 * No endpoint, shell fragment, registry credential or raw inspect leaves this module. */
export async function executeHostDocker(input:HostDockerAction,jobID:string,c:HostDockerContext,emit:(event:{phase:string;summary:string})=>Promise<void>):Promise<ExecutionReceipt>{
 const started=c.now().toISOString();let changing=false,unknown=false,lock:Awaited<ReturnType<typeof acquireOperationLock>>|undefined,batchAction:Extract<HostDockerAction,{operation:'remove_many'}>|undefined,batchResult:HostDockerResult|undefined,currentTarget='';
 try{
  const action=normalizeHostDockerAction(input),readOnly=hostDockerReadOnly(action);
  if(action.operation==='remove_many')batchAction=action;
  const raw=async(method:'GET'|'POST'|'DELETE',path:string,data?:Record<string,unknown>)=>{
   c.signal.throwIfAborted();return c.transport({method,path:API+path,body:data,signal:c.signal,assertStart:()=>c.signal.throwIfAborted()});
  };
  const request=async(method:'GET'|'POST'|'DELETE',path:string,data?:Record<string,unknown>,allowed=[200,201,204])=>{
   await c.authorize();c.signal.throwIfAborted();
   const info=await raw('GET','/info');if(info.statusCode!==200||validateManagedDockerDaemonInfo(body(info.body)).daemon_id!==c.daemonID)fail('docker_daemon_changed');
   c.signal.throwIfAborted();const before=changing;if(method!=='GET')changing=true;
   const response=await raw(method,path,data);
   // A definite Engine rejection has no effect. Preserve any earlier writes in this job.
   if(method!=='GET'&&response.statusCode>=400&&response.statusCode<500)changing=before;
   if(!allowed.includes(response.statusCode))fail(response.statusCode===409?'host_docker_conflict':'host_docker_unavailable');return response;
  };
  const containers=async()=>{const rows=array(body((await request('GET','/containers/json?all=1')).body));if(rows.some(c=>!CONTAINER_ID.test(c?.Id)||!IMAGE_ID.test(c?.ImageID)))fail('host_docker_unavailable');return rows};
  const images=async(sharedSize=true):Promise<HostImage[]>=>{
   const refs=new Set((await containers()).map(i=>i.ImageID));
   return array(body((await request('GET','/images/json?all=1'+(sharedSize?'&shared-size=1':''))).body)).map(i=>{
    if(!IMAGE_ID.test(i.Id)||!Number.isSafeInteger(i.Size)||i.Size<0)fail('host_docker_unavailable');
    const tags=array(i.RepoTags??[],64).map(t=>clean(t,512)).filter(t=>t&&t!=='<none>:<none>').sort();
    const data={id:i.Id,tags,size:i.Size,created:i.Created};
    return {id:i.Id,tags,size:i.Size,estimated_reclaimable_bytes:typeof i.SharedSize==='number'&&i.SharedSize>=0?Math.max(0,i.Size-i.SharedSize):i.Size,in_use:refs.has(i.Id),dangling:!tags.length,revision:hostDockerHash(data)};
   });
  };
  const inspect=async(id:string):Promise<ContainerDetail>=>{
   const v=body((await request('GET','/containers/'+id+'/json')).body);
   if(v?.Id!==id||!CONTAINER_ID.test(v.Id)||!IMAGE_ID.test(v.Image))fail('host_docker_unavailable');
   const h=v.HostConfig??{},cfg=v.Config??{},r=h.RestartPolicy??{},policy={name:r.Name||'no',max_retry_count:r.MaximumRetryCount??0};
   const exposed=Object.fromEntries(Object.keys(cfg.ExposedPorts??{}).map(port=>[port,null]));
   const ports=Object.entries({...exposed,...v.NetworkSettings?.Ports,...h.PortBindings}).flatMap(([port,bindings])=>bindings?array(bindings,128).map(b=>(clean(b.HostIp,64)||'0.0.0.0')+':'+clean(b.HostPort,8)+'→'+clean(port,32)):[clean(port,32)]);
   const mounts=array(v.Mounts??[],128).map(m=>({type:clean(m.Type,32),name:clean(m.Name),destination:clean(m.Destination,512),read_only:m.RW===false}));
   const name=clean(v.Name).replace(/^\//,''),state=clean(v.State?.Status,32),memory=h.Memory??0;
   const nano=h.NanoCpus??0;
   return {id:v.Id,name,image_id:v.Image,image:clean(cfg.Image,512),state,created_at:v.Created,revision:hostDockerHash({id:v.Id,name,image:v.Image,created:v.Created,state,host:h,command:cfg.Cmd,entrypoint:cfg.Entrypoint,mounts:v.Mounts,labels:cfg.Labels}),memory_bytes:memory,nano_cpus:nano,restart_policy:policy,ports,mounts,compose_project:clean(cfg.Labels?.['com.docker.compose.project'],128),platform_owned:!!cfg.Labels?.['io.lightmoni.platform.instance']} as ContainerDetail;
  };
  const mutate=async(operation:'start'|'stop'|'restart',id:string)=>request('POST',`/containers/${id}/${operation}${operation==='start'?'':'?t=10'}`,undefined,[204,304]);
  const result:HostDockerResult={operation:action.operation,request_sha256:hostDockerHash(action),observed_at:started};
  if(batchAction){result.containers=[];batchResult=result;}
  await emit({phase:'accepted',summary:'Host container task accepted'});
  if(!readOnly)lock=await acquireOperationLock(c.dataDir,jobID,c.now());
  await emit({phase:'staging',summary:'Checking the pinned Docker daemon and exact target'});
  await emit({phase:'activating',summary:readOnly?'Reading public container or image metadata':'Applying the precisely reviewed host container action'});
  if(action.operation==='inspect_many'){
   result.targets=[];for(const id of action.container_ids){const d=await inspect(id);result.targets.push({id:d.id,name:d.name,revision:d.revision,state:d.state,compose_project:d.compose_project,platform_owned:d.platform_owned})}
  }else if(action.operation==='images'){
   const all=(await images()).filter(i=>!action.cursor||i.id>action.cursor).sort((a,b)=>a.id.localeCompare(b.id));result.images=all.slice(0,100);result.truncated=false;
   while(Buffer.byteLength(JSON.stringify(result))>80000)result.images.pop();
   result.next_cursor=all.length>result.images.length?result.images.at(-1)!.id:'';
  }else if(action.operation==='prune_images'){
   const age=c.now().getTime()-Date.parse(action.previewed_at);if(age< -5000||age>300000)fail('host_docker_preview_expired');
   const all=await images();
   // Validate every candidate before the first write, including those that became used.
   for(const target of action.images){const i=all.find(i=>i.id===target.image_id);if(i&&i.revision!==target.expected_revision)fail('host_docker_revision_changed')}
   result.deleted=[];result.skipped=[];result.estimated_reclaimed_bytes=0;
   for(const target of action.images){
    const i=(await images(false)).find(i=>i.id===target.image_id);
    if(!i){result.skipped.push({id:target.image_id,reason:'missing'});continue}
    if(i.revision!==target.expected_revision)fail('host_docker_revision_changed');
    if(i.in_use){result.skipped.push({id:target.image_id,reason:'in_use'});continue}
    const response=await request('DELETE','/images/'+encodeURIComponent(i.id)+'?force=false&noprune=true',undefined,[200,404,409]);
    if(response.statusCode===409){result.skipped.push({id:i.id,reason:'conflict'});continue}
    const after=array(body((await request('GET','/images/json?all=1')).body));
    if(after.some(row=>row.Id===i.id))fail('host_docker_verification_failed');
    if(response.statusCode===404)result.skipped.push({id:i.id,reason:'missing'});
    else{result.deleted.push(i.id);result.estimated_reclaimed_bytes+=all.find(original=>original.id===i.id)!.estimated_reclaimable_bytes}
   }
  }else if(action.operation==='remove_many'){
   const validate=(detail:ContainerDetail,target:typeof action.targets[number])=>{if(detail.name!==target.name||detail.revision!==target.expected_revision)fail('host_docker_revision_changed');if((action.stopped_only||!action.force)&&!['exited','created','dead'].includes(detail.state))fail('host_docker_running')};
   // Inspect the entire reviewed batch before the first write. Unselected IDs cannot enter this task.
   for(const target of action.targets)validate(await inspect(target.container_id),target);
   result.containers=[];
   for(const target of action.targets){
    currentTarget=target.container_id;
    try{validate(await inspect(target.container_id),target)}catch(error){const code=hostDockerCode(error instanceof Error?error.message:'');if(!['host_docker_revision_changed','host_docker_running'].includes(code))throw error;result.containers.push({id:target.container_id,name:target.name,state:'failed',code});continue}
    const response=await request('DELETE',`/containers/${target.container_id}?force=${action.force}&v=${action.remove_anonymous_volumes}`,undefined,[204,400,403,404,409]);
    if(response.statusCode!==204){result.containers.push({id:target.container_id,name:target.name,state:'failed',code:'host_docker_conflict'});continue}
    const check=await request('GET','/containers/'+target.container_id+'/json',undefined,[404]);
    if(check.statusCode!==404)fail('host_docker_verification_failed');
    result.containers.push({id:target.container_id,name:target.name,state:'deleted',code:''});
   }
  }else if(action.operation==='create'){
   const cfg=action.config;
   const image=body((await request('GET','/images/'+encodeURIComponent(cfg.image_id)+'/json')).body);if(image?.Id!==cfg.image_id)fail('host_docker_revision_changed');
   for(const volume of cfg.named_volumes){const v=body((await request('GET','/volumes/'+encodeURIComponent(volume.name))).body);if(v?.Name!==volume.name)fail('host_docker_revision_changed')}
   const exposed:Record<string,object>={},bindings:Record<string,object[]>={};
   for(const p of cfg.ports){const key=p.container_port+'/'+p.protocol;exposed[key]={};(bindings[key]??=[]).push({HostIp:'0.0.0.0',HostPort:String(p.host_port)})}
   const requestBody={Image:cfg.image_id,...(cfg.command.length?{Cmd:cfg.command}:{}),ExposedPorts:exposed,HostConfig:{NetworkMode:'bridge',Memory:cfg.memory_bytes,NanoCpus:cfg.nano_cpus,RestartPolicy:{Name:cfg.restart_policy.name,MaximumRetryCount:cfg.restart_policy.max_retry_count},PortBindings:bindings,Mounts:cfg.named_volumes.map(m=>({Type:'volume',Source:m.name,Target:m.destination,ReadOnly:m.read_only,VolumeOptions:{NoCopy:true}}))}};
   const created=body((await request('POST','/containers/create?name='+encodeURIComponent(cfg.name),requestBody)).body);
   if(!CONTAINER_ID.test(created?.Id))fail('host_docker_verification_failed');
   if(cfg.start)await mutate('start',created.Id);
   result.container=await inspect(created.Id);
   if(result.container.name!==cfg.name||result.container.image_id!==cfg.image_id||result.container.memory_bytes!==cfg.memory_bytes||result.container.nano_cpus!==cfg.nano_cpus||JSON.stringify(result.container.restart_policy)!==JSON.stringify(cfg.restart_policy)||cfg.start&&result.container.state!=='running'||cfg.ports.some(p=>!result.container!.ports.includes(`0.0.0.0:${p.host_port}→${p.container_port}/${p.protocol}`))||cfg.named_volumes.some(m=>!result.container!.mounts.some(actual=>actual.type==='volume'&&actual.name===m.name&&actual.destination===m.destination&&actual.read_only===m.read_only)))fail('host_docker_verification_failed');
  }else{
   const before=await inspect(action.container_id);
   if(action.operation==='inspect')result.container=before;
   else{
    if(before.revision!==action.expected_revision)fail('host_docker_revision_changed');
    if(action.operation==='remove'&&!action.force&&!['exited','created','dead'].includes(before.state))fail('host_docker_running');
    if(action.operation==='remove'){
     await request('DELETE',`/containers/${action.container_id}?force=${action.force}&v=${action.remove_anonymous_volumes}`);
     const check=await request('GET','/containers/'+action.container_id+'/json',undefined,[404]);
     if(check.statusCode!==404)fail('host_docker_verification_failed');result.removed_id=action.container_id;
    }else{
     if(action.operation==='rename')await request('POST','/containers/'+action.container_id+'/rename?name='+encodeURIComponent(action.name));
     else if(action.operation==='update'){
      const cfg=action.config;
      await request('POST','/containers/'+action.container_id+'/update',{Memory:cfg.memory_bytes,...(cfg.memory_bytes===0?{MemorySwap:-1}:{}),NanoCpus:cfg.nano_cpus,...(cfg.nano_cpus>0?{CpuPeriod:0,CpuQuota:0}:{}),RestartPolicy:{Name:cfg.restart_policy.name,MaximumRetryCount:cfg.restart_policy.max_retry_count}});
     }else await mutate(action.operation,action.container_id);
     result.container=await inspect(action.container_id);
    }
   }
  }
  result.observed_at=c.now().toISOString();
  const snapshot=hostDockerReceipt(action,{host_docker:result},started,c.now());
  await emit({phase:'verifying',summary:'Container or image state read back and verified'});
  c.signal.throwIfAborted();
  return {state:'succeeded',code:'',summary:'Host container task completed and verified',snapshot,started_at:started,finished_at:c.now().toISOString()};
 }catch(error){unknown=changing;const code=hostDockerCode(error instanceof Error?error.message:'');let snapshot:Record<string,unknown>={};if(batchAction&&batchResult){const completed=batchResult.containers??[];batchResult.containers=batchAction.targets.map(target=>completed.find(r=>r.id===target.container_id)??{id:target.container_id,name:target.name,state:unknown&&target.container_id===currentTarget?'unknown':'not_started',code});batchResult.observed_at=c.now().toISOString();snapshot={host_docker:batchResult}}return {state:unknown?'unknown':'failed',code,summary:unknown?'Host container result is unknown; inspect before any new action':'Host container task was not applied',snapshot,started_at:started,finished_at:c.now().toISOString()}}
 finally{await lock?.finish(unknown)}
}
