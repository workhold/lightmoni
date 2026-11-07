// Disposable Linux/Docker validation. Use only with LIGHTMONI_STORAGE_LIVE=1.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,lstat,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {hashSync} from 'bcryptjs';
import {executeOperation,operationCommand} from '../dist/agent/operations.js';
import {selfSignedCertificate} from '../dist/ops/certificates.js';
import {probeHTTP} from '../dist/operations/website-files.js';
if(process.env.LIGHTMONI_STORAGE_LIVE!=='1'||process.platform!=='linux')throw Error('opted_in_linux_docker_required');
const root=await mkdtemp(join(tmpdir(),'lightmoni-storage-v2-')),dataDir=join(root,'managed'),instance=randomUUID().replaceAll('-',''),application=randomUUID().replaceAll('-',''),appInstance=randomUUID().replaceAll('-',''),websiteA=randomUUID().replaceAll('-',''),websiteB=randomUUID().replaceAll('-','');await mkdir(dataDir);
const context={dataDir,signal:new AbortController().signal,now:()=>new Date(),command:operationCommand};let revision=0;const checks=[];
const run=(config,resource=application)=>executeOperation({version:1,operation_id:randomUUID().replaceAll('-',''),operation:config.task.split('.').at(-1)==='apply'?'apply':config.task.split('.').at(-1),resource:{id:resource,kind:'platform',name:'Storage v2 disposable validation',agent_id:'qa',revision:++revision,config,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},input:{}},context,async()=>{});
const okay=(receipt)=>assert.equal(receipt.state,'succeeded',JSON.stringify(receipt));
const platform=join(dataDir,'operations/platform'),name='lm-gateway-'+instance,volume='lm-'+application+'-'+appInstance+'-database';
try {
 const app={mode:'container',image:'alpine:3.23',command:['sh','-c','while :; do sleep 30; done'],mounts:[{type:'init',target:'/initial',files:{value:'initial'}},{type:'data',target:'/data'},{type:'volume',target:'/volume',source:'database'}]};
 let receipt=await run({task:'workload.apply',application_id:application,instance_id:appInstance,application:app});okay(receipt);const container=receipt.snapshot.operations.data.containers[0].id;
 assert.equal(receipt.snapshot.operations.data.storage.instance_root,join(platform,'applications',application,'instances',appInstance));
 assert.equal(receipt.snapshot.operations.data.storage.mounts.find(m=>m.target==='/volume').volume,volume);
 await operationCommand('docker',['exec',container,'sh','-c','echo durable >/data/value; echo changed >/initial/value; echo volume >/volume/value']);
 receipt=await run({task:'workload.apply',application_id:application,instance_id:appInstance,application:app});okay(receipt);
 assert.equal((await operationCommand('docker',['exec',receipt.snapshot.operations.data.containers[0].id,'cat','/initial/value'])).stdout.trim(),'changed');
 okay(await run({task:'workload.remove',application_id:application,instance_id:appInstance}));assert.equal((await readFile(join(platform,'applications',application,'instances',appInstance,'data/1/value'),'utf8')).trim(),'durable');await operationCommand('docker',['volume','inspect',volume]);checks.push('real application ID / instance ID directories, scoped volume, initialization and data retention');
 const material=await selfSignedCertificate(['one.example.test'],7,new Date()),password='qa-password-'+randomUUID();
 const c={task:'gateway.apply',instance_id:instance,openresty_application_id:application,image:'openresty/openresty:1.27.1.2-0-alpine',http_port:24881,https_port:24882,sites:[{id:'one',website_id:websiteA,domains:['one.example.test'],mode:'static',static_files:{'index.html':'site one'},certificate:material,auth:{mode:'basic',realm:'secure',users:[{username:'qa',password_hash:hashSync(password,10)}]}},{id:'two',website_id:websiteB,domains:['two.example.test'],mode:'static',static_files:{'index.html':'site two'}}]};
 receipt=await run(c);okay(receipt);let state=JSON.parse(await readFile(join(platform,'gateways',instance,'state.json'),'utf8'));
 const firstVersion=state.website_versions[websiteA],otherVersion=state.website_versions[websiteB],otherConfig=join(platform,'websites',websiteB,'versions',otherVersion,'nginx.conf'),otherInode=(await lstat(otherConfig)).ino;
 assert.equal((await probeHTTP(24881,'two.example.test')).text,'site two');assert.equal((await probeHTTP(24882,'one.example.test','/',true)).status,401);
 assert.equal((await probeHTTP(24882,'one.example.test','/',true,undefined,{Authorization:'Basic '+Buffer.from('qa:'+password).toString('base64')})).text,'site one');
 assert.equal((await lstat(join(platform,'websites',websiteA,'versions',firstVersion,'ssl/one/privkey.pem'))).mode&0o777,0o600);assert(!JSON.stringify(state).includes('PRIVATE KEY'));assert(!JSON.stringify(state).includes(password));checks.push('real OpenResty includes isolated website versions and serves TLS / Basic / static files');
 c.sites[0].static_files['index.html']='site one updated';receipt=await run(c);okay(receipt);state=JSON.parse(await readFile(join(platform,'gateways',instance,'state.json'),'utf8'));assert.notEqual(state.website_versions[websiteA],firstVersion);assert.equal(state.website_versions[websiteB],otherVersion);assert.equal((await lstat(otherConfig)).ino,otherInode);
 const breakReload=structuredClone(c);breakReload.sites[1].nginx={server_snippet:'return 503;'};const rolledBack=await run(breakReload);assert.equal(rolledBack.state,'failed',JSON.stringify(rolledBack));assert.equal(rolledBack.code,'gateway_apply_failed_restored');assert.equal((await probeHTTP(24881,'two.example.test')).text,'site two');assert.equal(JSON.parse(await readFile(join(platform,'gateways',instance,'state.json'),'utf8')).website_versions[websiteB],otherVersion);checks.push('a successful nginx -t followed by failed live proof restores the previous gateway index and website pointers');
 const current=state.website_versions[websiteA];const bad=structuredClone(c);bad.sites[0].nginx={server_snippet:'definitely_invalid_directive on;'};const failed=await run(bad);assert.equal(failed.state,'failed');assert.equal(JSON.parse(await readFile(join(platform,'gateways',instance,'state.json'),'utf8')).website_versions[websiteA],current);assert.equal((await probeHTTP(24881,'two.example.test')).text,'site two');checks.push('updating one site leaves the other version untouched; nginx -t rejection preserves active versions');
 const active=await run({task:'website.remove',website_id:websiteA},websiteA);assert.equal(active.state,'failed');assert.equal(active.code,'website_still_active');
 c.sites=c.sites.filter(s=>s.website_id!==websiteA);okay(await run(c));assert.equal((await probeHTTP(24881,'one.example.test')).status,404);
 okay(await run({task:'website.remove',website_id:websiteA},websiteA));await assert.rejects(lstat(join(platform,'websites',websiteA)),{code:'ENOENT'});assert.equal((await probeHTTP(24881,'two.example.test')).text,'site two');assert.equal((await lstat(otherConfig)).ino,otherInode);
 for(const digest of await readdir(join(platform,'gateways',instance,'versions'))){const refs=JSON.parse(await readFile(join(platform,'gateways',instance,'versions',digest,'websites.json'),'utf8'));assert(!refs[websiteA]);}
 okay(await run({task:'website.remove',website_id:websiteA},websiteA));assert.equal((await readFile(join(platform,'applications',application,'instances',appInstance,'data/1/value'),'utf8')).trim(),'durable');checks.push('active deletion rejected; withdrawal then cleanup removes SSL/auth/static/history references, retains other website and app data, and is idempotent');
 const report={fixture:'disposable Linux container sharing local Docker daemon; no production operations',checks,passed:true};await writeFile(resolve('specs/099-app-registration-storage/evidence/storage-v2-live.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally {
 await operationCommand('docker',['rm','--force',name]).catch(()=>{});
 const ids=(await operationCommand('docker',['ps','-aq','--filter','label=io.lightmoni.platform.instance='+appInstance])).stdout.trim();if(ids)await operationCommand('docker',['rm','--force',...ids.split(/\s+/)]).catch(()=>{});
 await operationCommand('docker',['volume','rm',volume]).catch(()=>{});await rm(root,{recursive:true,force:true});
}
