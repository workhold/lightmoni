/** Uses only the caller's disposable Registry; never production. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {executeRegistry} from '../runtime/src/operations/registry-images.js';
const endpoint='http://'+execFileSync('docker',['port','lightmoni-registry-100-qa','5000/tcp'],{encoding:'utf8'}).trim();
const digest=(v:string)=>'sha256:'+createHash('sha256').update(v).digest('hex');
async function put(repo:string,tag:string,value:string){
 const config=JSON.stringify({architecture:'amd64',os:'linux',rootfs:{type:'layers',diff_ids:[]},config:{Labels:{qa:value}}});
 const upload=await fetch(endpoint+'/v2/'+repo+'/blobs/uploads/',{method:'POST'});assert.equal(upload.status,202);
 const location=new URL(upload.headers.get('location')!,endpoint);location.searchParams.set('digest',digest(config));
 assert.equal((await fetch(location,{method:'PUT',body:config,headers:{'content-type':'application/octet-stream'}})).status,201);
 const body=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:digest(config),size:Buffer.byteLength(config)},layers:[]});
 assert.equal((await fetch(endpoint+'/v2/'+repo+'/manifests/'+tag,{method:'PUT',body,headers:{'content-type':'application/vnd.oci.image.manifest.v1+json'}})).status,201);return digest(body);
}
const used=await put('lightmoni/api','v2','used');await put('lightmoni/api','stable','used');const old=await put('lightmoni/api','v1','unused');await put('lightmoni/worker','v1','worker');
const context={signal:AbortSignal.timeout(30000),now:()=>new Date()};
const references=[{repository:'lightmoni/api',reference:'v2',id:'qa-app',name:'QA app'}];
const config={task:'registry.inspect',endpoint,references};
const catalog=await executeRegistry(config,context);assert.deepEqual(catalog.data.repositories,['lightmoni/api','lightmoni/worker']);
const before=await executeRegistry({...config,repository:'lightmoni/api'},context);assert.equal(before.data.versions.length,3);assert.equal(before.data.versions.filter((v:any)=>v.used_by.length).length,2);
const cleaned=await executeRegistry({...config,task:'registry.cleanup'},context);assert.equal(cleaned.verified,true);assert.equal(cleaned.data.deleted,2);assert.equal(cleaned.data.retained,1);
const after=await executeRegistry({...config,repository:'lightmoni/api'},context);assert.deepEqual(after.data.versions.map((v:any)=>v.tag),['stable','v2']);
assert.equal((await fetch(endpoint+'/v2/lightmoni/api/manifests/'+old)).status,404);assert.equal((await fetch(endpoint+'/v2/lightmoni/api/manifests/'+used,{headers:{accept:'application/vnd.oci.image.manifest.v1+json'}})).status,200);
const again=await executeRegistry({...config,task:'registry.cleanup'},context);assert.equal(again.data.deleted,0);
await writeFile(new URL('../specs/100-registry-image-versions/evidence/registry-real.json',import.meta.url),JSON.stringify({registry:'registry:3.0.0',isolated:true,images:catalog.data.repositories,beforeTags:before.data.versions.map((v:any)=>v.tag),cleanup:cleaned.data,afterTags:after.data.versions.map((v:any)=>v.tag),retryDeleted:again.data.deleted},null,2));console.log('Real Registry 3.0.0 verification passed');
