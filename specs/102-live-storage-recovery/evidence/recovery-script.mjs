import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run=promisify(execFile), platform='/var/lib/lightmoni-managed/operations/platform', backup='/root/lightmoni-sdd102-20261107';
const appLabel='io.lightmoni.platform.application', instanceLabel='io.lightmoni.platform.instance', ownerLabel='io.lightmoni.platform.owner';
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const cmd=async(file,args,timeout=180000)=>{try{return (await run(file,args,{timeout,maxBuffer:4*1024*1024})).stdout;}catch(e){throw Object.assign(Error('COMMAND_FAILED'),{code:e.code,operation:file+':'+args[0]});}};
const docker=async args=>cmd('docker',args,600000);
const exists=async p=>!!(await fs.lstat(p).catch(()=>null));
const realDirectory=async p=>{const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('UNSAFE_DIRECTORY');};
const id=v=>{if(typeof v!=='string'||!/^\w{28,32}$/.test(v))throw Error('INVALID_ID');return v;};
const write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});await fs.writeFile(p,JSON.stringify(v),{mode:0o600});await fs.chmod(p,0o600);};
const phase=(name,extra={})=>console.log(JSON.stringify({phase:name,...extra}));
async function discover(){
 await realDirectory(platform);
 const ids=(await docker(['ps','-q','--filter','label='+ownerLabel+'=lightmoni'])).trim().split(/\s+/).filter(Boolean);
 const containers=JSON.parse(await docker(['inspect',...ids]));
 const groups=[];
 for(const c of containers){
  const instance=id(c.Config.Labels[instanceLabel]);if(c.Config.Labels[appLabel])throw Error('ALREADY_LABELLED_OR_PARTIAL');
  const gateway=c.Name==='/lm-gateway-'+instance, root=path.join(platform,gateway?'gateways':'workloads',instance);
  await realDirectory(root);const state=await read(path.join(root,'state.json'));
  if(state.version!==1||!gateway&&state.instance_id!==instance)throw Error('OLD_STATE_MISMATCH');
  if(!gateway&&c.Config.Labels['com.docker.compose.project']!=='lm-'+instance)throw Error('PROJECT_MISMATCH');
  if(gateway&&!(c.Mounts??[]).some(m=>m.Source===root&&m.Destination==='/etc/lightmoni'&&!m.RW))throw Error('GATEWAY_MOUNT_MISMATCH');
  if(groups.some(g=>g.instance===instance))throw Error('MULTI_CONTAINER_REQUIRES_REVIEW');
  if(gateway){if(!state.config?.sites?.length||state.config.instance_id!==instance)throw Error('GATEWAY_CONFIG_MISMATCH');groups.push({gateway,instance,root,state,container:c});continue;}
  const application=id(state.resource_id),target=path.join(platform,'applications',application,'instances',instance);
  if(await exists(path.join(target,'state.json')))throw Error('TARGET_STATE_EXISTS');
  if(await exists(target)&&(await fs.readdir(target)).length)throw Error('TARGET_NOT_EMPTY');
  if(!state.manifest?.startsWith(root+'/versions/'))throw Error('MANIFEST_PATH_MISMATCH');
  const manifest=await read(state.manifest), service=c.Config.Labels['com.docker.compose.service'];
  if(Object.keys(manifest.services).length!==1||!manifest.services[service])throw Error('SERVICE_COUNT_MISMATCH');
  const s=manifest.services[service];if(s.labels[instanceLabel]!==instance||s.labels[ownerLabel]!=='lightmoni'||sha(manifest)!==state.digest)throw Error('MANIFEST_IDENTITY_MISMATCH');
  const volumes=[];
  for(const mount of s.volumes??[]){
   if(typeof mount!=='object')throw Error('SHORT_MOUNT_REQUIRES_REVIEW');
   const live=c.Mounts.find(v=>v.Destination===mount.target&&v.Type===mount.type);
   if(!live||live.RW===!!mount.read_only)throw Error('MOUNT_MISMATCH');
   if(mount.type==='bind'){if(live.Source!==mount.source)throw Error('BIND_MISMATCH');if(mount.source.startsWith(root+'/'))await realDirectory(mount.source);}
   else if(mount.type==='volume'){
    const def=manifest.volumes?.[mount.source]??{},oldName=def.name??(def.external?mount.source:'lm-'+instance+'_'+mount.source);
    if(live.Name!==oldName)throw Error('VOLUME_MISMATCH');
    if(!def.name&&!def.external){const name='lm-'+application+'-'+instance+'-'+mount.source;const existing=JSON.parse(await docker(['volume','ls','--format','{{json .}}']).then(t=>'['+t.trim().split('\n').filter(Boolean).join(',')+']'));if(existing.some(v=>v.Name===name))throw Error('NEW_VOLUME_EXISTS');volumes.push({key:mount.source,oldName,source:live.Source,name});}
   }else throw Error('UNSUPPORTED_MOUNT');
  }
  groups.push({gateway,instance,application,root,target,state,manifest,container:c,volumes});
 }
 if(groups.filter(g=>!g.gateway).length!==3||groups.filter(g=>g.gateway).length!==1)throw Error('UNEXPECTED_RUNNING_SCOPE');
 return groups;
}
async function treeDigest(root){
 const digest=createHash('sha256');let files=0;
 async function walk(p,rel=''){for(const n of (await fs.readdir(p)).sort()){const q=path.join(p,n),r=path.join(rel,n),s=await fs.lstat(q);digest.update(JSON.stringify([r,s.mode,s.uid,s.gid]));if(s.isSymbolicLink())digest.update(await fs.readlink(q));else if(s.isDirectory())await walk(q,r);else if(s.isFile()){digest.update(await fs.readFile(q));files++;}else throw Error('UNSUPPORTED_DATA_FILE');}}
 await walk(root);return {sha256:digest.digest('hex'),files};
}
const context={dataDir:'/var/lib/lightmoni-managed',signal:new AbortController().signal,now:()=>new Date(),command:async(f,args,options={})=>({stdout:await cmd(f,args,options.timeoutMs??180000),stderr:''}),progress:async phaseName=>phase('gateway_'+phaseName)};
let groups=[],started=false,backedUp=false,gatewayRenamed=false,applied=[];
async function recover(){
 groups=await discover();phase('preflight_passed',{instances:groups.map(g=>({instance:g.instance,application:g.application,gateway:g.gateway,volumes:g.volumes?.map(v=>({old:v.oldName,next:v.name}))})),free_space:await cmd('df',['-Pk',platform])});
 if(process.argv[2]!=='apply')return;
 if(await exists(backup))throw Error('BACKUP_ALREADY_EXISTS');
 await fs.mkdir(backup,{mode:0o700});await write(backup+'/inventory.json',groups);
 await cmd('systemctl',['stop','lightmoni-agent']);started=true;
 for(let n=0;;n++){const units=await cmd('systemctl',['list-units','--all','--no-legend','--plain','--state=running','lightmoni-exec-*']);if(!units.trim()&&!await exists('/var/lib/lightmoni-managed/operations/execution.lock'))break;if(n>=45)throw Error('EXECUTION_NOT_QUIESCENT');await new Promise(r=>setTimeout(r,1000));}
 await cmd('systemctl',['stop','lightmoni-agent-helper']);
 await docker(['stop','--time','30',...groups.map(g=>g.container.Id)]);phase('original_containers_stopped');
 await cmd('cp',['-a',platform,backup+'/platform'],600000);backedUp=true;phase('platform_backup_complete');
 for(const g of groups.filter(g=>!g.gateway)){
  await fs.mkdir(path.dirname(g.target),{recursive:true,mode:0o700});if(await exists(g.target))await fs.rmdir(g.target);
  await cmd('cp',['-a',g.root,g.target],600000);
  const manifest=structuredClone(g.manifest);
  for(const v of g.volumes){
   await docker(['volume','create','--label','io.lightmoni.recovery=sdd102','--label',appLabel+'='+g.application,'--label',instanceLabel+'='+g.instance,v.name]);
   const target=JSON.parse(await docker(['volume','inspect',v.name]))[0].Mountpoint;await realDirectory(v.source);await realDirectory(target);
   await cmd('cp',['-a',v.source+'/.',target+'/'],600000);const from=await treeDigest(v.source),to=await treeDigest(target);if(from.sha256!==to.sha256)throw Error('VOLUME_COPY_MISMATCH');
   manifest.volumes[v.key]={...manifest.volumes[v.key],name:v.name};phase('volume_copy_verified',{instance:g.instance,files:to.files,sha256:to.sha256});
  }
  for(const s of Object.values(manifest.services)){s.labels[appLabel]=g.application;for(const m of s.volumes??[])if(m.type==='bind'&&m.source.startsWith(g.root+'/'))m.source=g.target+m.source.slice(g.root.length);}
  const digest=sha(manifest),filename=path.join(g.target,'versions',digest,'compose.json');await write(filename,manifest);
  const state={...g.state,version:2,application_id:g.application,manifest:filename,digest,updated_at:new Date().toISOString()};
  await docker(['compose','--project-name','lm-'+g.instance,'--file',filename,'config','--quiet']);
  applied.push({...g,filename});await docker(['compose','--project-name','lm-'+g.instance,'--file',filename,'up','--detach','--pull','never','--force-recreate','--wait','--wait-timeout','180']);
  await write(path.join(g.target,'state.json'),state);phase('workload_recreated',{instance:g.instance,application:g.application});
 }
 const g=groups.find(g=>g.gateway),name='lm-gateway-'+g.instance;
 const {stageWebsites,gatewayIdentity}=await import('/opt/lightmoni-agent/current/app/runtime/dist/operations/website-storage.js');
 const {renderWebsiteConfig,renderGateway,files,executePlatform}=await import('/opt/lightmoni-agent/current/app/runtime/dist/operations/platform.js');
 const {atomicFile}=await import('/opt/lightmoni-agent/current/app/runtime/dist/operations/website-files.js');
 const c={...g.state.config,task:'gateway.apply',storage_layout:2,force_recreate:true};
 const versions=await stageWebsites(context,c,renderWebsiteConfig,files),identity=gatewayIdentity(c,versions),version=path.join(g.root,'versions',identity.digest);
 await fs.mkdir(version,{recursive:true,mode:0o755});await atomicFile(path.join(version,'nginx.conf'),renderGateway({...c,website_versions:versions},identity.digest,false,true));await atomicFile(path.join(version,'websites.json'),JSON.stringify(versions));
 await atomicFile(path.join(g.root,'owner.json'),JSON.stringify({layout_version:2,instance_id:g.instance}));
 await atomicFile(path.join(g.root,'state.json'),JSON.stringify({version:2,...identity,website_versions:versions,retained_website_versions:versions,image:g.state.image,updated_at:new Date().toISOString()}));
 await docker(['rename',name,name+'-sdd102-original']);gatewayRenamed=true;
 const result=await executePlatform({version:1,operation_id:'sdd102-recovery',operation:'apply',resource:{id:'sdd102-gateway',kind:'platform',name:'reviewed gateway recovery',agent_id:'',revision:4,config:c},input:{}},context);
 if(!result.verified||!result.data.healthy)throw Error('GATEWAY_NOT_VERIFIED');phase('gateway_native_proof_passed',{instance:g.instance,sites:result.data.websites?.length});
 const live=JSON.parse(await docker(['inspect',...groups.map(g=>g.gateway?'lm-gateway-'+g.instance:'lm-'+g.instance+'-'+g.container.Config.Labels['com.docker.compose.service']+'-1')]));
 if(live.some(c=>!c.State.Running))throw Error('FINAL_CONTAINER_NOT_RUNNING');
 await write(backup+'/completed.json',{date:new Date().toISOString(),instances:groups.map(g=>({instance:g.instance,application:g.application,gateway:g.gateway})),old_data_retained:true});
 await cmd('systemctl',['start','lightmoni-agent-helper']);await cmd('systemctl',['start','lightmoni-agent']);started=false;phase('completed',{backup,old_data_retained:true});
}
try{await recover();}catch(e){
 phase('failed',{code:e.message,operation:e.operation});
 if(started){
  try{
   if(gatewayRenamed){const g=groups.find(g=>g.gateway),name='lm-gateway-'+g.instance;await docker(['rm','-f',name]).catch(()=>{});await cmd('cp',['-a',backup+'/platform/gateways/'+g.instance+'/.',g.root+'/']);const previous=await fs.readlink(backup+'/platform/gateways/'+g.instance+'/current');await fs.unlink(g.root+'/current').catch(()=>{});await fs.symlink(previous,g.root+'/current');await docker(['rename',name+'-sdd102-original',name]);}
   for(const g of applied){await docker(['compose','--project-name','lm-'+g.instance,'--file',g.filename,'down','--timeout','20']);await docker(['compose','--project-name','lm-'+g.instance,'--file',g.state.manifest,'up','--detach','--pull','never','--wait','--wait-timeout','180']);}
   await docker(['start',...groups.filter(g=>!applied.some(a=>a.instance===g.instance)).map(g=>g.container.Id)]);
   phase('old_runtime_restored',{backup_complete:backedUp});
  }catch(rollback){phase('rollback_needs_attention',{code:rollback.message,operation:rollback.operation});}
  await cmd('systemctl',['start','lightmoni-agent-helper']).catch(()=>{});await cmd('systemctl',['start','lightmoni-agent']).catch(()=>{});
 }
 process.exitCode=1;
}
