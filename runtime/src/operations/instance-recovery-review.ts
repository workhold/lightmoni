import {lstat,readFile,realpath} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {hash,safeID} from './website-files.js';
import {OperationRejectedError} from './errors.js';
import type {OperationExecutionContext} from './types.js';

const reject=():never=>{throw new OperationRejectedError('INSTANCE_RECOVERY_OWNERSHIP_UNVERIFIED')};
function json(value:string){try{return JSON.parse(value)}catch{return reject()}}
/** A fixed, read-only inventory. No private state contents leave the machine. */
export async function inspectRecoveryReview(input:any,context:OperationExecutionContext){
 const plan=safeID(input?.plan_id),stage=input?.stage;
 if(!['plan','apply'].includes(stage)||!Array.isArray(input.instances)||!input.instances.length||input.instances.length>50)reject();
 const requested=resolve(context.dataDir),root=join(await realpath(dirname(requested)),basename(requested)),platform=join(root,'operations','platform');
 async function path(at:string,kind:'file'|'directory'){
  try{const s=await lstat(at);if(s.isSymbolicLink()||(kind==='file'?!s.isFile():!s.isDirectory())||s.uid!==process.geteuid?.()||(s.mode&0o022))reject();return s;}
  catch(e:any){if(e.code==='ENOENT')return;throw e;}
 }
 for(const at of [root,join(root,'operations'),platform])await path(at,'directory');
 try{await lstat(join(root,'operations','execution.lock'));reject();}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const marker=join(platform,'.lightmoni-owner.json'),markerStat=await path(marker,'file');
 if(markerStat){if(markerStat.size>16384)reject();const value=json(await readFile(marker,'utf8'));if(JSON.stringify(value)!==JSON.stringify({version:1,domain:'platform',root}))reject();}
 const seen=new Set<string>(),instances=[];
 for(const item of input.instances){
  if(!item||typeof item!=='object')reject();
  const id=safeID(item.instance_id),owner=safeID(item.owner_id);if(seen.has(id)||!['gateway','workload'].includes(item.kind))reject();seen.add(id);
  const ids=new Set<string>();
  for(const filter of ['label=io.lightmoni.platform.instance='+id,'label=com.docker.compose.project=lm-'+id,'name=^lm-gateway-'+id+'$']){
   const r=await context.command('docker',['ps','-aq','--no-trunc','--filter',filter],{signal:context.signal,timeoutMs:15000});
   const found=r.stdout.trim().split(/\s+/).filter(Boolean);if(found.length>100||found.some(x=>!/^[a-f0-9]{12,64}$/.test(x)))reject();found.forEach(x=>ids.add(x));
  }
  const containers=[...ids].sort(),details:any[]=[],mounts:any[]=[];
  if(containers.length){
   const r=await context.command('docker',['inspect',...containers],{signal:context.signal,timeoutMs:15000});
   if(Buffer.byteLength(r.stdout)>8<<20)reject();const values=json(r.stdout);
   if(!Array.isArray(values)||values.length!==containers.length)reject();
   for(const value of values){
    if(!containers.includes(value.Id)||value.Config?.Labels?.['io.lightmoni.platform.instance']!==id||value.Config?.Labels?.['io.lightmoni.platform.owner']!=='lightmoni')reject();
    if(!Array.isArray(value.Mounts)||value.Mounts.length>100)reject();
    for(const mount of value.Mounts.filter((m:any)=>['bind','volume'].includes(m.Type))){
     if(![mount.Source,mount.Destination].every(v=>typeof v==='string'&&v.startsWith('/')&&v.length<=1024&&!/[\u0000-\u001f\u007f]/.test(v)))reject();
     mounts.push({container_id:value.Id,type:mount.Type,source:mount.Source,target:mount.Destination,read_only:mount.RW===false});
    }
    details.push({id:value.Id,running:value.State?.Running===true,mounts:value.Mounts,ports:value.HostConfig?.PortBindings,labels:value.Config.Labels});
   }
   details.sort((a,b)=>a.id.localeCompare(b.id));
  }
  const family=join(platform,item.kind==='gateway'?'gateways':'workloads'),data=join(family,id);
  await path(family,'directory');const directory=await path(data,'directory'),state=join(data,'state.json'),stateStat=await path(state,'file');
  if(directory&&!markerStat)reject();
  let stateHash='';
  if(stateStat){
   if(stateStat.size>1<<20)reject();const bytes=await readFile(state),value=json(bytes.toString());
   if(value?.version!==1||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))reject();
   if(item.kind==='workload'){
    if(value.instance_id!==id||value.resource_id!==owner||!Number.isSafeInteger(value.revision)||value.revision<1||value.manifest!==join(data,'versions',value.digest,'compose.json'))reject();
    await path(join(data,'versions'),'directory');await path(join(data,'versions',value.digest),'directory');
    const manifest=await path(value.manifest,'file');if(!manifest||manifest.size>2<<20)reject();
    if(hash(await readFile(value.manifest))!==value.digest)reject();
   }else if(value.config?.instance_id!==id||value.config?.openresty_application_id!==undefined&&value.config.openresty_application_id!==owner||typeof value.image!=='string'||value.image.length>2048)reject();
   stateHash=hash(bytes);
  }
  mounts.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const value={instance_id:id,containers,mounts,owned:true,managed_state:!!stateStat,data_present:!!directory,data_path:data,state_sha256:stateHash};
  instances.push({...value,inventory_sha256:hash(JSON.stringify({value,details}))});
 }
 return {recovery_plan_id:plan,stage,observed_at:context.now().toISOString(),instances};
}
