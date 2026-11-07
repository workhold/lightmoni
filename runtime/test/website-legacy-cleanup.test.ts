import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,lstat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,privateRoot} from '../src/operations/website-files.js';
import {cleanLegacyIndex,type LegacyGatewayScope} from '../src/operations/website-legacy-cleanup.js';
import {removeWebsite,inspectWebsiteRemoval,ownedWebsite} from '../src/operations/website-storage.js';

async function fixture(t:any){
 const dataDir=await mkdtemp(join(tmpdir(),'lm-legacy-clean-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let running=false,owner='lightmoni',mountSource='',rw=false;
 const context:any={dataDir,now:()=>new Date(),command:async(_file:string,args:string[])=>({stderr:'',stdout:args[0]==='ps'?'a'.repeat(64):JSON.stringify([{State:{Running:running},Config:{Labels:{'io.lightmoni.platform.instance':'old','io.lightmoni.platform.owner':owner}},Mounts:[{Type:'bind',Source:mountSource,Destination:'/etc/lightmoni',RW:rw}]}])})};
 const platform=await privateRoot(context,'platform'),root=join(platform,'gateways/old');mountSource=root;
 const target={id:hash('target:0').slice(0,32),domains:['old.target.test'],mode:'static'},other={id:'other-fragment',domains:['keep.test'],mode:'static'};
 const scope:LegacyGatewayScope={instance_id:'old',application_id:'entry-app',site_proofs:[{digest:hash(JSON.stringify(target)),fragment_id:target.id,target:true},{digest:hash(JSON.stringify(other)),fragment_id:other.id,target:false}]};
 const digest=hash('version'),version=join(root,'versions',digest),config=join(version,'nginx.conf');
 const keep=`server { server_name keep.test; location = /.well-known/lightmoni-health { return 200 "${hash(JSON.stringify(other))}"; } location / { return 200 "quoted { brace } ; # preserved"; } }`;
 const source=`events {}\nhttp { include /usr/local/openresty/nginx/conf/mime.types;\nserver { location = /.well-known/lightmoni-gateway { return 200 "${digest}"; } }\nupstream backend_${target.id}_0 { server 127.0.0.1:1234; }\nlimit_req_zone $binary_remote_addr zone=req_${target.id}_0:1m rate=2r/s;\nserver { server_name old.target.test; location = /.well-known/lightmoni-health { return 200 "${hash(JSON.stringify(target))}"; } location / { proxy_pass http://backend_${target.id}_0; } }\n${keep}\n}\n`;
 await mkdir(join(version,'sites',target.id),{recursive:true});await writeFile(join(version,'sites',target.id,'privkey.pem'),'target-private');await mkdir(join(version,'sites',other.id));await writeFile(join(version,'sites',other.id,'keep'),'other-data');
 await writeFile(config,source);await writeFile(join(root,'state.json'),JSON.stringify({version:1,digest,config:{instance_id:'old',openresty_application_id:'entry-app',sites:[target,other],website_revisions:{target:4,other:2},website_enabled:{target:true,other:true}}}));await symlink('versions/'+digest,join(root,'current'));
 await ownedWebsite(platform,'target',true);
 return {context,platform,root,version,config,source,scope,target,other,keep,setRunning:(v:boolean)=>running=v,setOwner:(v:string)=>owner=v,setMount:(v:string)=>mountSource=v,setRW:(v:boolean)=>rw=v};
}
test('historical cleanup uses stopped owned mounts and signed health proofs to remove only the target',async t=>{
 const f=await fixture(t);await assert.rejects(removeWebsite(f.context,'target',()=>''),/OWNERSHIP/);
 assert.equal((await inspectWebsiteRemoval(f.context,'target',[f.scope])).absent,false);
 const result=await removeWebsite(f.context,'target',()=>'', [f.scope]);assert.deepEqual(result.legacy_gateways_cleaned,['old']);
 const body=await readFile(f.config,'utf8');assert(body.includes(f.keep));assert(!body.includes('old.target.test'));assert(!body.includes(f.target.id));
 assert.equal(await readFile(join(f.version,'sites',f.other.id,'keep'),'utf8'),'other-data');await assert.rejects(lstat(join(f.version,'sites',f.target.id)),{code:'ENOENT'});
 const state=JSON.parse(await readFile(join(f.root,'state.json'),'utf8'));assert.deepEqual(state.config.sites,[f.other]);assert.deepEqual(state.config.website_revisions,{other:2});await assert.rejects(lstat(join(f.root,'owner.json')),{code:'ENOENT'});
 assert.equal((await inspectWebsiteRemoval(f.context,'target',[f.scope])).absent,true);assert.equal((await removeWebsite(f.context,'target',()=>'', [f.scope])).absent,true);
});
test('unknown proofs, active or foreign containers and mount changes cannot authorize historical deletion',async t=>{
 const f=await fixture(t);
 for(const change of [()=>f.setRunning(true),()=>{f.setRunning(false);f.setOwner('external');},()=>{f.setOwner('lightmoni');f.setMount('/outside');},()=>{f.setMount(f.root);f.setRW(true);}]){
  change();await assert.rejects(removeWebsite(f.context,'target',()=>'', [f.scope]),/EVIDENCE/);assert.equal(await readFile(f.config,'utf8'),f.source);assert(await lstat(join(f.platform,'websites/target')));
 }
 f.setRW(false);await assert.rejects(removeWebsite(f.context,'target',()=>'', [{...f.scope,site_proofs:[]}]),/EVIDENCE/);
 await assert.rejects(removeWebsite(f.context,'target',()=>'', [{...f.scope,application_id:'different'}]),/EVIDENCE/);
 const outside=join(f.platform,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'untouched');await rm(join(f.version,'sites',f.target.id),{recursive:true});await symlink(outside,join(f.version,'sites',f.target.id));
 await assert.rejects(removeWebsite(f.context,'target',()=>'', [f.scope]),/EVIDENCE/);assert.equal(await readFile(join(outside,'keep'),'utf8'),'untouched');assert.equal(await readFile(f.config,'utf8'),f.source);
});
test('an owned current gateway cleans only inactive legacy versions without touching its running index',async t=>{
 const f=await fixture(t),digest=hash('active-v2'),active=join(f.root,'versions',digest);await mkdir(active);await writeFile(join(active,'nginx.conf'),'active index stays byte identical');await writeFile(join(active,'websites.json'),'{}');
 await writeFile(join(f.root,'owner.json'),JSON.stringify({layout_version:2,instance_id:'old'}));await writeFile(join(f.root,'state.json'),JSON.stringify({version:2,digest,website_versions:{},config:{instance_id:'old'}}));
 await rm(join(f.root,'current'));await symlink('versions/'+digest,join(f.root,'current'));f.setRunning(true);
 const scope={...f.scope,historical_only:true};assert.equal((await inspectWebsiteRemoval(f.context,'target',[scope])).absent,false);
 await removeWebsite(f.context,'target',()=>'', [scope]);assert.equal(await readFile(join(active,'nginx.conf'),'utf8'),'active index stays byte identical');assert((await readFile(f.config,'utf8')).includes(f.keep));assert.equal((await inspectWebsiteRemoval(f.context,'target',[scope])).absent,true);
});
test('historical nginx parsing preserves quoted syntax and rejects unknown servers, external includes and shared references',async t=>{
 const f=await fixture(t);assert(cleanLegacyIndex(f.source,f.scope.site_proofs).body.includes(f.keep));
 for(const source of [f.source+'}',f.source.replace(f.keep,'server { location / { return 200 "unknown"; } }'),f.source.replace('events {}','include /outside; events {}'),f.source.replace(f.keep,f.keep.replace('return 200 "quoted { brace } ; # preserved"','proxy_pass http://backend_'+f.target.id+'_0')),f.source+' "unterminated'])assert.throws(()=>cleanLegacyIndex(source,f.scope.site_proofs),/EVIDENCE/);
 const quoted=f.source.replace('quoted { brace } ; # preserved','}');assert(cleanLegacyIndex(quoted,f.scope.site_proofs).body.includes('return 200 "}"'));
});
