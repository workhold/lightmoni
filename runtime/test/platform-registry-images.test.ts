import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {executeRegistry,validateRegistryConfig} from '../src/operations/registry-images.js';
const manifest=(value:string)=>JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{digest:'sha256:'+createHash('sha256').update(value).digest('hex')},layers:[]});
const digest=(s:string)=>'sha256:'+createHash('sha256').update(s).digest('hex');
async function fixture(t:any){
 const bodies=new Map<string,string>(),tags=new Map<string,Map<string,string>>(),calls:{method:string;path:string}[]=[];
 let fail='',mode='';
 const put=(repo:string,tag:string,body:string)=>{const d=digest(body);bodies.set(repo+'@'+d,body);const items=tags.get(repo)??new Map();items.set(tag,d);tags.set(repo,items);return d;};
 const server=createServer((req,res)=>{
  const url=new URL(req.url!,'http://registry'),path=url.pathname;calls.push({method:req.method!,path});
  const json=(v:any)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(path==='/v2/_catalog'){const values=[...tags.keys()].sort().filter(v=>v>(url.searchParams.get('last')??'')),page=values.slice(0,1);if(values.length>1)res.setHeader('link','</v2/_catalog?n=1&last='+page[0]+'>; rel="next"');return json({repositories:page});}
  const match=/^\/v2\/(.+)\/(tags\/list|manifests\/(.+))$/.exec(path);if(!match){res.statusCode=404;return res.end();}
  const repo=match[1],items=tags.get(repo)??new Map();
  if(match[2]==='tags/list'){
   if(mode==='broken'){res.statusCode=503;return res.end();}
   const values=[...items.keys()].sort().filter(v=>v>(url.searchParams.get('last')??'')),page=values.slice(0,2);
   if(values.length>2)res.setHeader('link','<'+(mode==='external'?'https://outside.invalid':'')+'/v2/'+repo+'/tags/list?n=2&last='+page[1]+'>; rel="next"');return json({name:repo,tags:page});
  }
  const d=items.get(match[3])??match[3],body=bodies.get(repo+'@'+d);
  if(req.method==='DELETE'){
   if(mode==='disabled'){res.statusCode=405;return res.end();}if(d===fail){res.statusCode=403;return res.end();}
   bodies.delete(repo+'@'+d);for(const [tag,value] of items)if(value===d)items.delete(tag);res.statusCode=202;return res.end();
  }
  if(!body){res.statusCode=404;return res.end();}res.setHeader('Docker-Content-Digest',digest(body));res.end(body);
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.close();server.closeAllConnections();});
 const endpoint='http://127.0.0.1:'+(server.address() as any).port;
 return {bodies,tags,calls,put,context:{signal:new AbortController().signal,now:()=>new Date()},config:(extra:any={})=>({task:'registry.cleanup',endpoint,references:[],...extra}),setFail:(v:string)=>{fail=v;},setMode:(v:string)=>{mode=v;}};
}
test('catalog and tag pagination include every version and digest aliases share application usage',async t=>{
 const f=await fixture(t),used=f.put('team/api','v2',manifest('used'));f.put('team/api','stable',manifest('used'));f.put('team/api','v1',manifest('old'));f.put('worker','v1',manifest('worker'));
 const references=[{repository:'team/api',reference:'v2',id:'app',name:'API'}];
 assert.deepEqual((await executeRegistry(f.config({task:'registry.inspect'}),f.context)).data.repositories,['team/api','worker']);
 const first=await executeRegistry(f.config({task:'registry.inspect',repository:'team/api',references}),f.context);
 assert.deepEqual(first.data.versions.map((v:any)=>v.tag),['stable','v1']);assert.equal(first.data.versions[0].digest,used);assert.equal(first.data.versions[0].used_by[0].name,'API');assert.equal(first.data.next,'v1');
 const last=await executeRegistry(f.config({task:'registry.inspect',repository:'team/api',after:first.data.next,references}),f.context);assert.equal(last.data.versions[0].tag,'v2');assert.equal(last.data.next,null);
});
test('cleanup retains used multi-platform index children and shared tags while clearing all repositories',async t=>{
 const f=await fixture(t),child=f.put('team/api','platform',manifest('child'));
 const index=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{digest:child}]});
 const root=f.put('team/api','v2',index);f.put('team/api','stable',index);const old=f.put('team/api','v1',manifest('old'));f.put('worker','old',manifest('unused'));
 const config=f.config({references:[{repository:'team/api',reference:root,id:'app',name:'Digest app'}]});const r=await executeRegistry(config,f.context);
 assert.equal(r.verified,true);assert.equal(r.data.deleted,2);assert.equal(r.data.deleted_tags,2);assert.equal(r.data.retained,2);assert.ok(f.bodies.has('team/api@'+child));assert.ok(f.bodies.has('team/api@'+root));assert.ok(!f.bodies.has('team/api@'+old));assert.equal((await executeRegistry(config,f.context)).data.deleted,0);
});
test('incomplete catalog, unresolved usage and hostile pagination never perform DELETE',async t=>{
 for(const mode of ['broken','missing','external']){
  const f=await fixture(t);for(let i=0;i<3;i++)f.put('api','v'+i,manifest('v'+i));f.setMode(mode);
  await assert.rejects(executeRegistry(f.config(mode==='missing'?{references:[{repository:'api',reference:'missing',id:'a',name:'A'}]}:{}),f.context));assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);
 }
});
test('partial errors and disabled deletion return truthful cleanup counts',async t=>{
 const f=await fixture(t),bad=f.put('api','v1',manifest('fail'));f.put('api','v2',manifest('delete'));f.setFail(bad);
 const r=await executeRegistry(f.config(),f.context);assert.equal(r.verified,false);assert.equal(r.data.deleted,1);assert.equal(r.data.failed,1);assert.equal(r.data.partial,true);
 const d=await fixture(t);d.put('api','v1',manifest('keep'));d.setMode('disabled');const r2=await executeRegistry(d.config(),d.context);assert.equal(r2.verified,false);assert.equal(r2.data.deleted,0);assert.equal(r2.data.failures[0].code,'registry_delete_disabled');
});
test('lost DELETE response propagates uncertainty instead of confirmed failure',async t=>{
 const f=await fixture(t);f.put('api','v1',manifest('v1'));
 await assert.rejects(executeRegistry(f.config(),f.context,((url:any,opts:any)=>opts.method==='DELETE'?Promise.reject(Error('connection lost')):fetch(url,opts)) as typeof fetch),/connection lost/);
});
test('endpoint and query validation reject public hosts and malformed repositories',()=>{
 for(const endpoint of ['https://127.0.0.1:5000','http://example.com:5000','http://127.0.0.1:5000/a','http://user:password@127.0.0.1:5000'])assert.throws(()=>validateRegistryConfig({endpoint,references:[]}));assert.throws(()=>validateRegistryConfig({endpoint:'http://127.0.0.1:5000',references:[],repository:'../api'}));
});

test('transport failure during scan is a confirmed read failure with no mutations',async t=>{
 const f=await fixture(t);
 await assert.rejects(executeRegistry(f.config(),f.context,async()=>{throw Error('offline');}),/REGISTRY_REQUEST_FAILED/);assert.equal(f.calls.length,0);
});

test('100 tags retain page order with at most four requests and shared index children fetched once',async()=>{
 const tags=Array.from({length:100},(_,i)=>'v'+String(i).padStart(3,'0')),child=manifest('shared'),childDigest=digest(child);
 const index=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{digest:childDigest}]});
 let active=0,peak=0;const requests=new Map<string,number>();
 const fetcher:typeof fetch=async(input:any)=>{
  const path=new URL(String(input)).pathname;requests.set(path,(requests.get(path)??0)+1);active++;peak=Math.max(peak,active);
  try{await new Promise(r=>setTimeout(r,path.endsWith('v000')?15:1));if(path.endsWith('/tags/list'))return new Response(JSON.stringify({name:'api',tags}));const value=path.endsWith(childDigest)?child:index;return new Response(value,{headers:{'Docker-Content-Digest':digest(value)}})}finally{active--}
 };
 const result=await executeRegistry({task:'registry.inspect',endpoint:'http://127.0.0.1:5000',repository:'api',references:[]},{signal:new AbortController().signal,now:()=>new Date()},fetcher);
 assert.deepEqual(result.data.versions.map((v:any)=>v.tag),tags);assert.equal(peak,4);assert.equal(requests.get('/v2/api/manifests/'+childDigest),1);assert.equal(active,0);assert.equal(result.data.versions.length,100);
});
