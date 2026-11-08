import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeHostDocker,type HostDockerContext} from '../src/privileged-executor/host-docker.js';
import {validateManagedDockerDaemonInfo,type ManagedDockerTransport} from '../src/privileged-executor/docker.js';
import type {HostDockerAction} from '../src/shared/host-docker.js';

test('real Engine creates, reads, renames, updates, deletes and cleans exact disposable images while preserving referenced images',{skip:process.env.LIGHTMONI_DOCKER_LIVE!=='1'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'lm109-live-')),suffix=randomUUID().slice(0,8),containerIDs:string[]=[],imageIDs:string[]=[],volume='lm109-live-'+suffix;
 const docker=(args:string[],input?:string)=>execFileSync('docker',['--context','default',...args],{input,encoding:'utf8',timeout:60000,stdio:['pipe','pipe','pipe']}).trim();
 const endpoint=JSON.parse(docker(['context','inspect','default','--format','{{json .Endpoints.docker.Host}}']));assert(endpoint.startsWith('unix://'));
 const transport:ManagedDockerTransport=async r=>new Promise((resolve,reject)=>{
  const encoded=r.body?JSON.stringify(r.body):undefined;r.assertStart?.();
  const req=request({socketPath:endpoint.slice(7),path:r.path,method:r.method,signal:r.signal,headers:encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{}},res=>{const chunks:Buffer[]=[];let bytes=0;res.on('data',c=>{bytes+=c.length;if(bytes>1048576)req.destroy(Error('response too large'));else chunks.push(c)});res.on('end',()=>resolve({statusCode:res.statusCode??0,body:Buffer.concat(chunks).toString()}));res.on('error',reject)});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(Error('timeout')));req.end(encoded);
 });
 t.after(()=>{for(const id of containerIDs){try{docker(['rm','-f','-v',id])}catch{}}for(const id of imageIDs){try{docker(['image','rm',id])}catch{}}try{docker(['volume','rm',volume])}catch{}rmSync(root,{recursive:true,force:true})});
 const info=JSON.parse(String((await transport({method:'GET',path:'/v1.43/info'})).body));
 const context:HostDockerContext={dataDir:root,daemonID:validateManagedDockerDaemonInfo(info).daemon_id,signal:new AbortController().signal,now:()=>new Date(),authorize:async()=>{},transport};
 const run=async(action:HostDockerAction)=>{const receipt=await executeHostDocker(action,randomUUID().replaceAll('-',''),context,async()=>{});assert.equal(receipt.state,'succeeded',JSON.stringify(receipt));return receipt.snapshot.host_docker as any};
 docker(['image','inspect','alpine:3.23','--format','{{.Id}}']);
 // Each config has a unique label, so the cleanup candidate cannot be another test's image.
 const build=(label:string)=>{const output=docker(['build','--quiet','--pull=false','--network','none','-'],`FROM alpine:3.23\nLABEL io.lightmoni.qa109=${suffix+'-'+label}\n`);const id=output.split('\n').at(-1)!;assert.match(id,/^sha256:[a-f0-9]{64}$/);imageIDs.push(id);return id};
 const used=build('used'),unused=build('unused');docker(['volume','create',volume]);
 const created=await run({kind:'host_docker',operation:'create',config:{name:'lm109-live-'+suffix,image_id:used,command:['sleep','600'],ports:[],named_volumes:[{name:volume,destination:'/qa-data',read_only:false}],start:true,memory_bytes:32*1048576,nano_cpus:500000000,restart_policy:{name:'no',max_retry_count:0}}});
 let c=created.container;containerIDs.push(c.id);assert.equal(c.state,'running');assert(c.mounts.some((m:any)=>m.name===volume));
 for(const extra of [{operation:'rename',name:'lm109-renamed-'+suffix},{operation:'update',config:{memory_bytes:48*1048576,nano_cpus:250000000,restart_policy:{name:'on-failure',max_retry_count:2}}},{operation:'stop'}])c=(await run({kind:'host_docker',container_id:c.id,expected_revision:c.revision,...extra} as HostDockerAction)).container;
 assert.equal(c.state,'exited');assert.equal(c.memory_bytes,48*1048576);assert.equal(c.restart_policy.max_retry_count,2);
 const observed=new Map<string,any>();let preview:any,candidate:any,cursor='',candidateAt='';do{preview=await run({kind:'host_docker',operation:'images',...(cursor?{cursor}:{})});for(const i of preview.images)observed.set(i.id,i);const found=preview.images.find((i:any)=>i.id===unused);if(found){candidate=found;candidateAt=preview.observed_at}cursor=preview.next_cursor;}while(cursor);assert.equal(observed.get(used)?.in_use,true);assert(candidate);assert.equal(candidate.in_use,false);
 const cleaned=await run({kind:'host_docker',operation:'prune_images',preview_job_id:'a'.repeat(32),previewed_at:candidateAt,images:[{image_id:unused,expected_revision:candidate.revision}]});assert.deepEqual(cleaned.deleted,[unused]);assert.equal(docker(['image','inspect',used,'--format','{{.Id}}']),used);
 for(const operation of ['start','restart','stop'] as const)c=(await run({kind:'host_docker',operation,container_id:c.id,expected_revision:c.revision})).container;
 await run({kind:'host_docker',operation:'remove',container_id:c.id,expected_revision:c.revision,force:false,remove_anonymous_volumes:false});assert.equal(docker(['volume','inspect',volume,'--format','{{.Name}}']),volume);
});
