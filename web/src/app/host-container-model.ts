export type Limits={memory_bytes:number;nano_cpus:number;restart_policy:{name:'no'|'always'|'unless-stopped'|'on-failure';max_retry_count:number}};
export type ContainerDetail=Limits&{id:string;name:string;image_id:string;image:string;state:string;created_at:string;revision:string;ports:string[];mounts:{type:string;name:string;destination:string;read_only:boolean}[];compose_project:string;platform_owned:boolean};
export type HostImage={id:string;tags:string[];size:number;estimated_reclaimable_bytes:number;in_use:boolean;dangling:boolean;revision:string};
export type HostAction={kind:'host_docker';operation:string;cursor?:string;container_id?:string;container_ids?:string[];expected_revision?:string;name?:string;config?:Record<string,unknown>;force?:boolean;remove_anonymous_volumes?:boolean;stopped_only?:boolean;targets?:{container_id:string;name:string;expected_revision:string}[];preview_job_id?:string;previewed_at?:string;images?:{image_id:string;expected_revision:string}[]};
export type HostResult={operation:string;request_sha256:string;observed_at:string;container?:ContainerDetail;targets?:Pick<ContainerDetail,'id'|'name'|'revision'|'state'|'compose_project'|'platform_owned'>[];removed_id?:string;containers?:{id:string;name:string;state:'deleted'|'failed'|'unknown'|'not_started';code:string}[];images?:HostImage[];next_cursor?:string;truncated?:boolean;deleted?:string[];skipped?:{id:string;reason:string}[];estimated_reclaimed_bytes?:number};
export type HostContainerJob={id:string;request_id:string;state:string;blocking:boolean;action:HostAction;issued_at:string;expires_at:string;code:string;result:HostResult|null};
export const hostContainerTerminal=(s:string)=>['succeeded','failed','cancelled','unknown'].includes(s);
export const canonicalHostAction=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonicalHostAction).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalHostAction((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export const containerBytes=(bytes:number)=>bytes>=1073741824?(bytes/1073741824).toFixed(2)+' GiB':bytes>=1048576?(bytes/1048576).toFixed(1)+' MiB':bytes>=1024?(bytes/1024).toFixed(1)+' KiB':bytes+' B';
export function containerLimits(values:Record<string,unknown>):Limits{
 const memory=Number(values.memory_mib),cpus=Number(values.cpus),retry=values.restart==='on-failure'?Number(values.retry??0):0;
 if(!Number.isFinite(memory)||memory<0||memory>1048576||memory>0&&memory<6||!Number.isFinite(cpus)||cpus<0||cpus>1024||!Number.isSafeInteger(retry)||retry<0||retry>100)throw Error('invalid_host_docker_action');
 return {memory_bytes:Math.round(memory*1048576),nano_cpus:Math.round(cpus*1e9),restart_policy:{name:String(values.restart) as Limits['restart_policy']['name'],max_retry_count:retry}};
}
export function containerCreate(values:Record<string,unknown>):Record<string,unknown>{
 const lines=(v:unknown)=>String(v??'').split('\n').map(v=>v.trim()).filter(Boolean);
 const ports=lines(values.ports).map(line=>{const m=/^(\d+):(\d+)\/(tcp|udp)$/.exec(line);if(!m||Number(m[1])<1||Number(m[1])>65535||Number(m[2])<1||Number(m[2])>65535)throw Error('invalid_container_ports');return {host_port:Number(m[1]),container_port:Number(m[2]),protocol:m[3]}});
 const named_volumes=lines(values.volumes).map(line=>{const m=/^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}):(\/[^:]*):(ro|rw)$/.exec(line);if(!m)throw Error('invalid_container_volumes');return {name:m[1],destination:m[2],read_only:m[3]==='ro'}});
 return {name:String(values.name??'').trim(),image_id:String(values.image_id??''),command:lines(values.command),ports,named_volumes,start:values.start===true,...containerLimits(values)};
}
