import {createHash} from 'node:crypto';

export const HOST_DOCKER_VERSION=1;
export const CONTAINER_ID=/^[a-f0-9]{64}$/;
export const IMAGE_ID=/^sha256:[a-f0-9]{64}$/;
export const DOCKER_NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const REVISION=/^[a-f0-9]{64}$/;
export type RestartPolicy={name:'no'|'always'|'unless-stopped'|'on-failure';max_retry_count:number};
export type ContainerLimits={memory_bytes:number;nano_cpus:number;restart_policy:RestartPolicy};
export type ContainerCreate=ContainerLimits&{name:string;image_id:string;command:string[];ports:{host_port:number;container_port:number;protocol:'tcp'|'udp'}[];named_volumes:{name:string;destination:string;read_only:boolean}[];start:boolean};
type Target={container_id:string;expected_revision:string};
export type HostContainerTarget=Target&{name:string};
export type HostDockerAction={kind:'host_docker'}&(
 |{operation:'inspect';container_id:string}
 |{operation:'inspect_many';container_ids:string[]}
 |{operation:'images';cursor?:string}
 |{operation:'create';config:ContainerCreate}
 |({operation:'rename';name:string}&Target)
 |({operation:'update';config:ContainerLimits}&Target)
 |({operation:'start'|'stop'|'restart'}&Target)
 |({operation:'remove';force:boolean;remove_anonymous_volumes:boolean}&Target)
 |{operation:'remove_many';targets:HostContainerTarget[];force:boolean;remove_anonymous_volumes:boolean;stopped_only:boolean}
 |{operation:'prune_images';preview_job_id:string;previewed_at:string;images:{image_id:string;expected_revision:string}[]}
);
export type ContainerDetail=ContainerLimits&{id:string;name:string;image_id:string;image:string;state:string;created_at:string;revision:string;ports:string[];mounts:{type:string;name:string;destination:string;read_only:boolean}[];compose_project:string;platform_owned:boolean};
export type HostImage={id:string;tags:string[];size:number;estimated_reclaimable_bytes:number;in_use:boolean;dangling:boolean;revision:string};
export type HostDockerResult={operation:HostDockerAction['operation'];request_sha256:string;observed_at:string;container?:ContainerDetail;targets?:Pick<ContainerDetail,'id'|'name'|'revision'|'state'|'compose_project'|'platform_owned'>[];removed_id?:string;containers?:{id:string;name:string;state:'deleted'|'failed'|'unknown'|'not_started';code:string}[];images?:HostImage[];next_cursor?:string;truncated?:boolean;deleted?:string[];skipped?:{id:string;reason:'in_use'|'conflict'|'missing'}[];estimated_reclaimed_bytes?:number};
export const hostDockerReadOnly=(a:HostDockerAction)=>['inspect','inspect_many','images'].includes(a.operation);
export const hostDockerJobAction=(actions:any[]):HostDockerAction|undefined=>actions.length===1&&actions[0]?.kind==='host_docker'?actions[0]:undefined;
export const hostDockerHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bad():never{throw Error('invalid_host_docker_action')}
function object(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))bad();return v}
function text(v:any,max:number,pattern?:RegExp){if(typeof v!=='string'||!v.length||Buffer.byteLength(v)>max||/[\x00-\x1f\x7f]/.test(v)||pattern&&!pattern.test(v))bad();return v as string}
function integer(v:any,min:number,max:number){if(!Number.isSafeInteger(v)||v<min||v>max)bad();return v as number}
function bool(v:any){if(typeof v!=='boolean')bad();return v as boolean}
function limits(value:any):ContainerLimits{
 const v=object(value,['memory_bytes','nano_cpus','restart_policy']),r=object(v.restart_policy,['name','max_retry_count']);
 if(!['no','always','unless-stopped','on-failure'].includes(r.name))bad();
 integer(r.max_retry_count,0,100);if(r.name!=='on-failure'&&r.max_retry_count!==0)bad();
 integer(v.memory_bytes,0,2**50);if(v.memory_bytes>0&&v.memory_bytes<6*1024*1024)bad();
 integer(v.nano_cpus,0,1024*1e9);
 return {memory_bytes:v.memory_bytes,nano_cpus:v.nano_cpus,restart_policy:{name:r.name,max_retry_count:r.max_retry_count}};
}
export function normalizeHostDockerAction(input:unknown):HostDockerAction{
 // Copy before any await and keep a deterministic field order for the signed digest.
 const v=input as any;if(v?.kind!=='host_docker')bad();const operation=v.operation;
 if(operation==='images'){object(v,['kind','operation',...(v.cursor!==undefined?['cursor']:[])]);return {kind:'host_docker',operation,...(v.cursor!==undefined?{cursor:text(v.cursor,71,IMAGE_ID)}:{})}}
 if(operation==='inspect'){object(v,['kind','operation','container_id']);return {kind:'host_docker',operation,container_id:text(v.container_id,64,CONTAINER_ID)}}
 if(operation==='inspect_many'){object(v,['kind','operation','container_ids']);if(!Array.isArray(v.container_ids)||v.container_ids.length<1||v.container_ids.length>50||new Set(v.container_ids).size!==v.container_ids.length)bad();return {kind:'host_docker',operation,container_ids:v.container_ids.map((id:any)=>text(id,64,CONTAINER_ID))}}
 if(operation==='create'){
  object(v,['kind','operation','config']);const c=object(v.config,['name','image_id','command','ports','named_volumes','start','memory_bytes','nano_cpus','restart_policy']);
  const base=limits({memory_bytes:c.memory_bytes,nano_cpus:c.nano_cpus,restart_policy:c.restart_policy});
  if(!Array.isArray(c.command)||c.command.length>32||c.command.some((s:any)=>typeof s!=='string'||Buffer.byteLength(s)>1024||/[\x00-\x1f\x7f]/.test(s)))bad();
  if(!Array.isArray(c.ports)||c.ports.length>32||!Array.isArray(c.named_volumes)||c.named_volumes.length>16)bad();
  const ports=c.ports.map((p:any)=>{object(p,['host_port','container_port','protocol']);if(!['tcp','udp'].includes(p.protocol))bad();return {host_port:integer(p.host_port,1,65535),container_port:integer(p.container_port,1,65535),protocol:p.protocol}});
  if(new Set(ports.map((p:any)=>p.host_port+'/'+p.protocol)).size!==ports.length)bad();
  const volumes=c.named_volumes.map((m:any)=>{object(m,['name','destination','read_only']);const destination=text(m.destination,256);if(!destination.startsWith('/')||destination==='/'||destination.split('/').some(p=>p==='..'||p==='.')||['/proc','/sys','/dev','/run','/var/run'].some(p=>destination===p||destination.startsWith(p+'/')))bad();return {name:text(m.name,63,DOCKER_NAME),destination,read_only:bool(m.read_only)}});
  if(new Set(volumes.map((m:any)=>m.destination)).size!==volumes.length)bad();
  return {kind:'host_docker',operation,config:{name:text(c.name,63,DOCKER_NAME),image_id:text(c.image_id,71,IMAGE_ID),command:[...c.command],ports,named_volumes:volumes,start:bool(c.start),...base}};
 }
 if(operation==='prune_images'){
  object(v,['kind','operation','preview_job_id','previewed_at','images']);text(v.preview_job_id,32,/^[a-f0-9]{32}$/);text(v.previewed_at,40);if(!Number.isFinite(Date.parse(v.previewed_at)))bad();
  if(!Array.isArray(v.images)||v.images.length<1||v.images.length>100)bad();
  const images=v.images.map((i:any)=>{object(i,['image_id','expected_revision']);return {image_id:text(i.image_id,71,IMAGE_ID),expected_revision:text(i.expected_revision,64,REVISION)}});
  if(new Set(images.map((i:any)=>i.image_id)).size!==images.length)bad();return {kind:'host_docker',operation,preview_job_id:v.preview_job_id,previewed_at:v.previewed_at,images};
 }
 if(operation==='remove_many'){
  object(v,['kind','operation','targets','force','remove_anonymous_volumes','stopped_only']);
  if(!Array.isArray(v.targets)||v.targets.length<1||v.targets.length>50)bad();
  const targets=v.targets.map((t:any)=>{object(t,['container_id','expected_revision','name']);return {container_id:text(t.container_id,64,CONTAINER_ID),expected_revision:text(t.expected_revision,64,REVISION),name:text(t.name,256)}});
  if(new Set(targets.map((t:HostContainerTarget)=>t.container_id)).size!==targets.length||v.stopped_only&&v.force)bad();
  return {kind:'host_docker',operation,targets,force:bool(v.force),remove_anonymous_volumes:bool(v.remove_anonymous_volumes),stopped_only:bool(v.stopped_only)};
 }
 if(!['rename','update','start','stop','restart','remove'].includes(operation))bad();
 object(v,['kind','operation','container_id','expected_revision',...(operation==='rename'?['name']:operation==='update'?['config']:operation==='remove'?['force','remove_anonymous_volumes']:[])]);
 const target={container_id:text(v.container_id,64,CONTAINER_ID),expected_revision:text(v.expected_revision,64,REVISION)};
 if(operation==='rename')return {kind:'host_docker',operation,...target,name:text(v.name,63,DOCKER_NAME)};
 if(operation==='update')return {kind:'host_docker',operation,...target,config:limits(v.config)};
 if(operation==='remove')return {kind:'host_docker',operation,...target,force:bool(v.force),remove_anonymous_volumes:bool(v.remove_anonymous_volumes)};
 return {kind:'host_docker',operation,...target} as HostDockerAction;
}
export const HOST_DOCKER_CODES=['invalid_host_docker_action','host_docker_upgrade_required','host_docker_unavailable','host_docker_revision_changed','host_docker_preview_expired','host_docker_in_use','host_docker_running','host_docker_conflict','host_docker_verification_failed','operations_node_locked','docker_daemon_changed','execution_cancelled','invalid_host_docker_receipt'];
export const hostDockerCode=(e:unknown)=>HOST_DOCKER_CODES.includes(String(e))?String(e):'host_docker_unavailable';

/** Interrupted batch progress is evidence only: it never produces a healthy receipt or releases a fence. */
export function hostDockerBatchProgress(action:HostDockerAction,value:any,issuedAt:string,now:Date):{host_docker:HostDockerResult}{
 if(action.operation!=='remove_many')bad();
 const r=value?.host_docker;if(!r||r.operation!==action.operation||r.request_sha256!==hostDockerHash(normalizeHostDockerAction(action))||!Number.isFinite(Date.parse(r.observed_at))||Date.parse(r.observed_at)<Date.parse(issuedAt)-5000||Date.parse(r.observed_at)>now.getTime()+60000||!Array.isArray(r.containers)||r.containers.length!==action.targets.length||new Set(r.containers.map((c:any)=>c.id)).size!==r.containers.length)bad();
 const containers=r.containers.map((c:any)=>{const target=action.targets.find(t=>t.container_id===c.id);if(!target||target.name!==c.name||!['deleted','failed','unknown','not_started'].includes(c.state)||c.state==='deleted'&&c.code!==''||c.state!=='deleted'&&!HOST_DOCKER_CODES.includes(c.code))bad();return {id:target.container_id,name:target.name,state:c.state,code:c.code}});
 return {host_docker:{operation:action.operation,request_sha256:r.request_sha256,observed_at:r.observed_at,containers}};
}

/** Reconstruct all public fields. Raw inspect, environment, labels and daemon errors never survive. */
export function hostDockerReceipt(action:HostDockerAction,value:any,issuedAt:string,now:Date):{health:{healthy:true};host_docker:HostDockerResult}{
 const r=value?.host_docker;if(!r||r.operation!==action.operation||r.request_sha256!==hostDockerHash(normalizeHostDockerAction(action))||!Number.isFinite(Date.parse(r.observed_at))||Date.parse(r.observed_at)<Date.parse(issuedAt)-5000||Date.parse(r.observed_at)>now.getTime()+60000)bad();
 const result:HostDockerResult={operation:action.operation,request_sha256:r.request_sha256,observed_at:r.observed_at};
 if(['inspect','create','rename','update','start','stop','restart'].includes(action.operation)){
  const c=r.container;if(!c||!CONTAINER_ID.test(c.id)||!IMAGE_ID.test(c.image_id)||!REVISION.test(c.revision)||!['created','running','paused','restarting','removing','exited','dead'].includes(c.state)||!Number.isFinite(Date.parse(c.created_at)))bad();
  if('container_id'in action&&c.id!==action.container_id)bad();
  const l=limits({memory_bytes:c.memory_bytes,nano_cpus:c.nano_cpus,restart_policy:c.restart_policy});
  if(!Array.isArray(c.ports)||c.ports.length>128||!Array.isArray(c.mounts)||c.mounts.length>128)bad();
  result.container={id:c.id,name:text(c.name,256),image_id:c.image_id,image:text(c.image,512),state:c.state,created_at:c.created_at,revision:c.revision,...l,ports:c.ports.map((p:any)=>text(p,256)),mounts:c.mounts.map((m:any)=>({type:text(m.type,32),name:typeof m.name==='string'?m.name.slice(0,256):'',destination:text(m.destination,512),read_only:bool(m.read_only)})),compose_project:typeof c.compose_project==='string'?c.compose_project.slice(0,128):'',platform_owned:bool(c.platform_owned)};
  if(action.operation==='rename'&&c.name!==action.name||action.operation==='update'&&JSON.stringify(l)!==JSON.stringify(action.config)||action.operation==='create'&&(c.name!==action.config.name||c.image_id!==action.config.image_id||JSON.stringify(l)!==JSON.stringify({memory_bytes:action.config.memory_bytes,nano_cpus:action.config.nano_cpus,restart_policy:action.config.restart_policy})||action.config.start&&c.state!=='running'||action.config.ports.some(p=>!result.container!.ports.includes(`0.0.0.0:${p.host_port}→${p.container_port}/${p.protocol}`))||action.config.named_volumes.some(m=>!result.container!.mounts.some(actual=>actual.type==='volume'&&actual.name===m.name&&actual.destination===m.destination&&actual.read_only===m.read_only)))||['start','restart'].includes(action.operation)&&c.state!=='running'||action.operation==='stop'&&!['created','exited'].includes(c.state))bad();
 }
 if(action.operation==='remove'){if(r.removed_id!==action.container_id)bad();result.removed_id=r.removed_id}
 if(action.operation==='inspect_many'){
  if(!Array.isArray(r.targets)||r.targets.length!==action.container_ids.length||new Set(r.targets.map((t:any)=>t.id)).size!==r.targets.length)bad();
  result.targets=r.targets.map((t:any)=>{if(!action.container_ids.includes(t.id)||!REVISION.test(t.revision)||!['created','running','paused','restarting','removing','exited','dead'].includes(t.state))bad();return {id:t.id,name:text(t.name,256),revision:t.revision,state:t.state,compose_project:typeof t.compose_project==='string'?t.compose_project.slice(0,128):'',platform_owned:bool(t.platform_owned)}});
 }
 if(action.operation==='remove_many'){
  if(!Array.isArray(r.containers)||r.containers.length!==action.targets.length||new Set(r.containers.map((c:any)=>c.id)).size!==r.containers.length)bad();
  result.containers=r.containers.map((c:any)=>{const target=action.targets.find(t=>t.container_id===c.id);if(!target||target.name!==c.name||!['deleted','failed'].includes(c.state)||c.state==='deleted'&&c.code!==''||c.state==='failed'&&!HOST_DOCKER_CODES.includes(c.code))bad();return {id:c.id,name:c.name,state:c.state,code:c.code}});
 }
 if(action.operation==='images'){
  if(!Array.isArray(r.images)||r.images.length>100||typeof r.truncated!=='boolean')bad();
  result.images=r.images.map((i:any)=>{if(!IMAGE_ID.test(i.id)||!REVISION.test(i.revision)||!Array.isArray(i.tags)||i.tags.length>64)bad();return {id:i.id,tags:i.tags.map((s:any)=>text(s,512)),size:integer(i.size,0,Number.MAX_SAFE_INTEGER),estimated_reclaimable_bytes:integer(i.estimated_reclaimable_bytes,0,i.size),in_use:bool(i.in_use),dangling:bool(i.dangling),revision:i.revision}});
  if(new Set(result.images!.map(i=>i.id)).size!==r.images.length)bad();result.truncated=r.truncated;
  if(typeof r.next_cursor!=='string'||r.next_cursor!==''&&(!IMAGE_ID.test(r.next_cursor)||result.images!.at(-1)?.id!==r.next_cursor))bad();result.next_cursor=r.next_cursor;
 }
 if(action.operation==='prune_images'){
  if(!Array.isArray(r.deleted)||!Array.isArray(r.skipped))bad();const all=[...r.deleted,...r.skipped.map((s:any)=>s.id)];
  if(all.length!==action.images.length||new Set(all).size!==all.length||all.some(id=>!action.images.some(i=>i.image_id===id))||r.skipped.some((s:any)=>!['in_use','conflict','missing'].includes(s.reason)))bad();
  result.deleted=[...r.deleted];result.skipped=r.skipped.map((s:any)=>({id:s.id,reason:s.reason}));result.estimated_reclaimed_bytes=integer(r.estimated_reclaimed_bytes,0,Number.MAX_SAFE_INTEGER);
 }
 return {health:{healthy:true},host_docker:result};
}
