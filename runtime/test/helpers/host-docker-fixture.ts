import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeHostDocker,type HostDockerContext} from '../../src/privileged-executor/host-docker.js';
import type {ManagedDockerRequest} from '../../src/privileged-executor/docker.js';
import type {HostDockerAction} from '../../src/shared/host-docker.js';

export const hostContainerID='a'.repeat(64),stoppedContainerID='b'.repeat(64);
export const usedImageID='sha256:'+'1'.repeat(64),stoppedImageID='sha256:'+'2'.repeat(64),unusedImageID='sha256:'+'3'.repeat(64),danglingImageID='sha256:'+'4'.repeat(64);
export const defaultLimits={memory_bytes:0,nano_cpus:0,restart_policy:{name:'no' as const,max_retry_count:0}};
export function fakeHostDocker(){
 const root=mkdtempSync(join(tmpdir(),'lm109-')),calls:ManagedDockerRequest[]=[],containers=new Map<string,any>(),images=new Map<string,any>(),volumes=new Set(['qa-data']);
 let now=new Date(),daemon='qa-daemon',serial=1,interrupt=false;
 const container=(id:string,name:string,image:string,state:string)=>({Id:id,Name:'/'+name,Image:image,Created:'2026-11-01T00:00:00Z',Config:{Image:'qa:1',Cmd:['sleep','600'],Env:['PASSWORD=hidden'],Labels:{password:'hidden'}},HostConfig:{Memory:0,NanoCpus:0,RestartPolicy:{Name:'no',MaximumRetryCount:0},NetworkMode:'bridge'},State:{Status:state},NetworkSettings:{Ports:{}},Mounts:[]});
 containers.set(hostContainerID,container(hostContainerID,'qa-running',usedImageID,'running'));containers.set(stoppedContainerID,container(stoppedContainerID,'qa-stopped',stoppedImageID,'exited'));
 for(const [i,id]of [usedImageID,stoppedImageID,unusedImageID,danglingImageID].entries())images.set(id,{Id:id,RepoTags:i===3?[]:['qa:image-'+i],Created:1,Size:1024,SharedSize:256});
 const transport=async(request:ManagedDockerRequest)=>{
  calls.push(request);const url=new URL('http://local'+request.path),path=decodeURIComponent(url.pathname.replace(/^\/v1\.43/,'')),method=request.method,b=request.body as any;
  const ok=(body:any={},statusCode=200)=>({statusCode,body});
  if(method!=='GET'&&interrupt)throw Error('secret daemon failure');
  if(path==='/info')return ok({ID:daemon,OSType:'linux',Architecture:'amd64',SecurityOptions:['name=seccomp']});
  if(path==='/containers/json')return ok([...containers.values()].map(c=>({Id:c.Id,ImageID:c.Image})));
  if(path==='/images/json')return ok([...images.values()]);
  if(path.startsWith('/volumes/'))return volumes.has(path.slice(9))?ok({Name:path.slice(9)}):ok({},404);
  if(path==='/containers/create'){
   if([...containers.values()].some(c=>c.Name==='/'+url.searchParams.get('name')))return ok({},409);
   const id=(serial++).toString(16).padStart(64,'0'),c=container(id,url.searchParams.get('name')!,b.Image,'created');c.Config.Cmd=b.Cmd??[];Object.assign(c.HostConfig,b.HostConfig);c.NetworkSettings.Ports=b.HostConfig.PortBindings;c.Mounts=(b.HostConfig.Mounts??[]).map((m:any)=>({Type:'volume',Name:m.Source,Destination:m.Target,RW:!m.ReadOnly}));containers.set(id,c);return ok({Id:id},201);
  }
  const match=/^\/containers\/([^/]+)(?:\/(json|rename|update|start|stop|restart))?$/.exec(path);
  if(match){const [,id,op]=match,c=containers.get(id);if(!c)return ok({},404);
   if(op==='json')return ok(c);
   if(method==='DELETE'){if(c.State.Status==='running'&&url.searchParams.get('force')!=='true')return ok({},409);containers.delete(id);return ok({},204)}
   if(op==='rename')c.Name='/'+url.searchParams.get('name');
   else if(op==='update')Object.assign(c.HostConfig,b);
   else c.State.Status=op==='stop'?'exited':'running';return ok({},op==='update'?200:204);
  }
  const im=/^\/images\/(sha256:[a-f0-9]{64})(\/json)?$/.exec(path);
  if(im){const image=images.get(im[1]);if(!image)return ok({},404);if(method==='DELETE'){if([...containers.values()].some(c=>c.Image===im[1]))return ok({},409);images.delete(im[1]);return ok([{Deleted:im[1]}])}return ok(image)}
  throw Error('unexpected fixture request '+method+' '+path);
 };
 const context:HostDockerContext={dataDir:root,daemonID:'qa-daemon',now:()=>now,signal:new AbortController().signal,authorize:async()=>{},transport};
 const run=(action:HostDockerAction,emit:Parameters<typeof executeHostDocker>[3]=async()=>{})=>executeHostDocker(action,randomUUID().replaceAll('-',''),context,emit);
 return {root,context,calls,containers,images,volumes,container,run,advance(ms:number){now=new Date(now.getTime()+ms)},setDaemon(id:string){daemon=id},interrupt(){interrupt=true},close(){rmSync(root,{recursive:true,force:true})}};
}
