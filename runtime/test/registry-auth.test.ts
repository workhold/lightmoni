import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registryAddress,imageRegistry,credentialMatches,pullAuthenticatedImage} from '../src/operations/registry-auth.js';

test('registry identity and repository boundaries are exact',()=>{
 assert.equal(registryAddress('https://index.docker.io:443/'),'docker.io');
 assert.deepEqual(imageRegistry('alpine:3.23'),{registry:'docker.io',repository:'library/alpine'});
 assert.deepEqual(imageRegistry('registry.test:5443/team/app:v1'),{registry:'registry.test:5443',repository:'team/app'});
 const c={registry:'registry.test:5443',repository_prefix:'team'};
 assert(credentialMatches(c,'registry.test:5443/team/app:1'));
 for(const i of ['evilregistry.test:5443/team/app:1','registry.test/team/app:1','registry.test:5443/teammate/app:1'])assert(!credentialMatches(c,i));
 for(const a of ['http://registry.test','https://u:p@registry.test','registry.test/path','registry.test?x=1','https://registry.test/#x'])assert.throws(()=>registryAddress(a));
});
for(const outcome of ['success','failure','cancel'])test('temporary auth is scoped and cleaned after '+outcome,async t=>{
 const root=await mkdtemp(join(tmpdir(),'lm-registry-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let directory='',fetched=0;
 const controller=new AbortController();
 const context:any={registryAuthDirectory:root,signal:controller.signal,registryCredential:async(image:string)=>{fetched++;assert.equal(image,'registry.test/team/app:1');return {registry:'registry.test',repository_prefix:'team',username:'robot',password:'test-only-secret'};},command:async(file:string,args:string[],options:any)=>{
  assert.equal(file,'docker');assert.deepEqual(args,['image','pull','registry.test/team/app:1']);
  directory=options.env.DOCKER_CONFIG;assert.equal((await stat(directory)).mode&0o777,0o700);
  assert.equal((await stat(join(directory,'config.json'))).mode&0o777,0o600);
  const config=JSON.parse(await readFile(join(directory,'config.json'),'utf8'));assert.deepEqual(Object.keys(config.auths),['registry.test']);assert.equal(Buffer.from(config.auths['registry.test'].auth,'base64').toString(),'robot:test-only-secret');
  assert(!JSON.stringify(args).includes('secret'));
  if(outcome==='cancel'){controller.abort();throw Error('cancelled test-only-secret');}
  if(outcome==='failure')throw Object.assign(Error('test-only-secret'),{stderr:'unauthorized test-only-secret'});
  return {stdout:'',stderr:''};
 }};
 if(outcome==='success')await pullAuthenticatedImage('registry.test/team/app:1',context);
 else await assert.rejects(pullAuthenticatedImage('registry.test/team/app:1',context),e=>!String(e).includes('test-only-secret'));
 assert.equal(fetched,1);await assert.rejects(access(directory));
});

test('private Compose images outside the configured cache bypass anonymous proxies, use separate secrets and pin verified IDs',async t=>{
 const {preparePlatformImages}=await import('../src/operations/image-sources.js');
 const root=await mkdtemp(join(tmpdir(),'lm-registry-compose-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const images=['one.test/team/app:1','two.test/team/db:1'],pulled=new Set<string>(),calls:any[]=[],fetched:string[]=[];
 const context:any={registryAuthDirectory:root,signal:new AbortController().signal,registryCredential:async(image:string)=>{fetched.push(image);return {registry:image.split('/')[0],repository_prefix:'team',username:'robot',password:'fixture-private-token'};},command:async(file:string,args:string[],options:any={})=>{
  calls.push({file,args,env:options.env});
  if(args[0]==='info')return {stdout:'linux/amd64',stderr:''};
  if(args[1]==='pull'){assert(images.includes(args[2]));assert(options.env.DOCKER_CONFIG);pulled.add(args[2]);return {stdout:'',stderr:''};}
  if(args[1]==='inspect'&&pulled.has(args.at(-1)!))return {stdout:JSON.stringify({Id:'sha256:'+(args.at(-1)===images[0]?'a':'b').repeat(64),Os:'linux',Architecture:'amd64'}),stderr:''};
  throw Error('not present');
 }};
 const manifest:any={services:{web:{image:images[0]},db:{image:images[1]},public:{image:'alpine:3.23'}}};
 const config={registry_authorizations:images.map(image=>({registry:image.split('/')[0],repository_prefix:'team',images:[image]})),image_sources:{version:1,revision:1,rules:[{source:'one.test',target:'https://proxy.test',allow_upstream:true}]},image_cache:{version:1,allow_upstream:true,origin_host:'other.test',origin_endpoint:'http://127.0.0.1:5000',origin_mode:'direct'}};
 const result=await preparePlatformImages(manifest,config,root,context);
 assert.deepEqual(fetched,images);assert.equal(manifest.services.web.image,'sha256:'+'a'.repeat(64));assert.equal(manifest.services.db.image,'sha256:'+'b'.repeat(64));assert.equal(manifest.services.web.pull_policy,'never');assert.equal(manifest.services.public.image,'alpine:3.23');
 assert.equal(result.filter((r:any)=>r.source==='authenticated-registry').length,2);assert(!JSON.stringify(calls).includes('fixture-private-token'));assert(!JSON.stringify(calls).includes('proxy.test'));
 for(const call of calls.filter(c=>c.env?.DOCKER_CONFIG))await assert.rejects(access(call.env.DOCKER_CONFIG));
});

test('Docker auth lookup preserves explicit default ports and physical Hub hostnames',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lm-registry-lookup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [image,registry,key] of [['registry.test:443/team/app:1','registry.test','registry.test:443'],['registry-1.docker.io/team/app:1','docker.io','registry-1.docker.io'],['index.docker.io/team/app:1','docker.io','https://index.docker.io/v1/'],['alpine:3.23','docker.io','https://index.docker.io/v1/']]){
  await pullAuthenticatedImage(image,{registryAuthDirectory:root,signal:new AbortController().signal,registryCredential:async()=>({registry,repository_prefix:'',username:'robot',password:'fixture-auth-key'}),command:async(_file:any,_args:any,options:any)=>{assert.deepEqual(Object.keys(JSON.parse(await readFile(join(options.env.DOCKER_CONFIG,'config.json'),'utf8')).auths),[key]);return {stdout:'',stderr:''};}} as any);
 }
});
