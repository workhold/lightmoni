import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, readdir, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePlatformImages} from '../src/operations/image-sources.js';

const hash=(value:Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
async function fixture(t:TestContext, mode='import', refresh=false, allowUpstream=false) {
 const root=await mkdtemp(join(tmpdir(),'lm-auth-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const image='registry.test/team/app:latest', config=Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',rootfs:{type:'layers',diff_ids:[]}})), id=hash(config);
 const manifestBytes=Buffer.from(JSON.stringify({schemaVersion:2,config:{digest:id},layers:[]})), manifestDigest=hash(manifestBytes);
 const paths:string[]=[], commands:{args:string[],env?:any}[]=[], credentials:string[]=[];
 let loaded=false,pulled=false;
 const server=createServer((req,res)=>{
  paths.push(req.url!);assert.equal(req.headers.authorization,undefined);
  if(mode==='miss'){res.writeHead(404);res.end();return;}
  res.end(req.url?.includes('/manifests/')?manifestBytes:mode==='corrupt'?Buffer.from('corrupt'):config);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 const context:any={registryAuthDirectory:root,signal:new AbortController().signal,
  registryCredential:async(requested:string)=>{credentials.push(requested);return {registry:'registry.test',repository_prefix:'team',username:'robot',password:'fixture-cache-secret'};},
  command:async(_file:string,args:string[],options:any={})=>{
   commands.push({args,env:options.env});
   if(args[0]==='info')return{stdout:'linux/amd64',stderr:''};
   if(args[1]==='ls')return{stdout:mode==='alias'?JSON.stringify({Repository:'other.test/team/app',Digest:manifestDigest}):'',stderr:''};
   if(args[1]==='load'){loaded=true;return{stdout:'',stderr:''};}
   if(args[1]==='pull'){assert.equal(mode,'miss');assert.deepEqual(args,['image','pull',image]);assert(options.env?.DOCKER_CONFIG);pulled=true;return{stdout:'',stderr:''};}
   if(args[1]==='inspect'){
    const ref=args.at(-1)!;
    if((mode==='local'&&ref===image)||(mode==='alias'&&ref==='other.test/team/app@'+manifestDigest)||(mode==='config'&&ref===id)||(loaded&&ref.startsWith('lightmoni-cache/verified:'))||(pulled&&ref===image))return{stdout:JSON.stringify({Id:id,Os:'linux',Architecture:'amd64',RootFS:{Layers:[]},RepoDigests:['other.test/team/app@'+manifestDigest]}),stderr:''};
    // A mutable tag points at the old release before refresh. Never mistake it for the new manifest.
    if(mode==='refresh'&&ref===image)return{stdout:JSON.stringify({Id:'sha256:'+'e'.repeat(64),Os:'linux',Architecture:'amd64'}),stderr:''};
   }
   throw Error('No such image');
  }};
 const manifest:any={services:{web:{image},worker:{image}}};
 const policy={refresh_images:refresh,registry_authorizations:[{registry:'registry.test',repository_prefix:'team',images:[image]}],image_cache:{version:1,allow_upstream:allowUpstream,origin_host:'registry.test',origin_endpoint:'http://127.0.0.1:'+(server.address() as any).port,origin_mode:'direct'},image_sources:{version:1,revision:1,rules:[{source:'registry.test',target:'https://proxy.test',allow_upstream:true}]}};
 return {root,image,id,paths,commands,credentials,manifest,policy,context,run:()=>preparePlatformImages(manifest,policy,root,context)};
}

for(const mode of ['local','alias','config','import','refresh'])test('authenticated images prefer verified '+mode+' before fetching secrets or pulling upstream',async t=>{
 const f=await fixture(t,mode,mode==='refresh'),result=await f.run();
 assert.equal(result.length,1);assert.equal(result[0].source,['import','refresh'].includes(mode)?'cluster-registry':'local');
 assert.equal(result[0].image_id,f.id);assert.deepEqual(f.credentials,[]);
 assert.equal(f.commands.filter(c=>c.args[1]==='load').length,['import','refresh'].includes(mode)?1:0);
 assert(!f.commands.some(c=>c.args[1]==='pull'||c.env?.DOCKER_CONFIG));
 assert.equal(f.paths.length,mode==='local'?0:mode==='alias'?1:2);
 for(const service of Object.values<any>(f.manifest.services)){assert.equal(service.image,f.id);assert.equal(service.pull_policy,'never');}
 assert.deepEqual(await readdir(f.root),[]);
});

test('an allowed cache miss falls back to authenticated origin once and cleans its temporary credentials',async t=>{
 const f=await fixture(t,'miss',false,true),result=await f.run();
 assert.equal(f.paths.length,1);assert.deepEqual(f.credentials,[f.image]);
 assert.equal(result[0].source,'upstream-fallback');assert.equal(result[1].source,'authenticated-registry');
 assert.equal(f.commands.filter(c=>c.args[1]==='pull').length,1);
 assert(!JSON.stringify(f.commands).includes('fixture-cache-secret'));assert(!JSON.stringify(f.commands).includes('proxy.test'));
 for(const c of f.commands.filter(c=>c.env?.DOCKER_CONFIG))await assert.rejects(access(c.env.DOCKER_CONFIG));
 assert.deepEqual(await readdir(f.root),[]);
});

for(const mode of ['miss','corrupt'])test('strict cache '+mode+' never retrieves an upstream credential or bypasses policy',async t=>{
 const f=await fixture(t,mode);await assert.rejects(f.run(),new RegExp(mode==='corrupt'?'CACHE_DIGEST_MISMATCH':'CACHE_FETCH_FAILED'));
 assert.deepEqual(f.credentials,[]);assert(!f.commands.some(c=>['load','pull'].includes(c.args[1])));
 assert.deepEqual(await readdir(f.root),[]);
});

test('an authenticated immutable digest remains locally reusable on explicit refresh without a cache',async t=>{
 const f=await fixture(t,'local',true);
 const image='other.test/team/app@'+hash(Buffer.from('manifest'));
 const manifest:any={services:{web:{image}}};
 const result=await preparePlatformImages(manifest,{refresh_images:true,registry_authorizations:[{registry:'other.test',repository_prefix:'team',images:[image]}]},f.root,{...f.context,command:async(_file:any,args:string[])=>{
  assert(['info','inspect'].includes(args[args[0]==='info'?0:1]));
  return{stdout:args[0]==='info'?'linux/amd64':JSON.stringify({Id:f.id,Os:'linux',Architecture:'amd64',RepoDigests:[image]}),stderr:''};
 }});
 assert.equal(result[0].source,'local');assert.equal(manifest.services.web.image,f.id);assert.deepEqual(f.credentials,[]);assert.deepEqual(f.paths,[]);
});
