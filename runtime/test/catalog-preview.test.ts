import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {catalogPreview} from '../src/ops/catalog-preview.js';
import {applicationCatalog} from '../src/ops/catalog.js';
import {readDockerInventory} from '../src/agent/docker.js';
import {dockerInventory} from '../src/shared/application-observation.js';
import type {OperationExecutionContext} from '../src/operations/types.js';

test('catalog has distinct upstream website, source and documentation for all 35 recipes',()=>{
 assert.equal(applicationCatalog.length,35);for(const template of applicationCatalog)for(const field of ['homepage','repository','documentation'] as const){assert(template[field],template.id+' '+field);const url=new URL(template[field]!);assert.equal(url.protocol,'https:');assert(!url.username&&!url.password);assert(!url.hostname.includes('simple-icons'));}
});
test('installation preview reflects parameters and mount targets without persisting or exposing secrets',()=>{
 const input={parameters:{password:'private-root-value',database:'preview_db',user:'appuser',user_password:'private-user-value'},host_ports:{mysql:13306},listen_ip:'127.0.0.1'};
 const first=catalogPreview('mysql',input),doc=parse(first.yaml);assert.equal(doc.services.mysql.environment.MYSQL_DATABASE,'preview_db');assert.equal(doc.services.mysql.ports[0].published,'13306');assert.equal(doc.services.mysql.ports[0].host_ip,'127.0.0.1');assert.equal(doc.services.mysql.volumes[0].target,'/var/lib/mysql');assert.doesNotMatch(first.yaml,/private-root-value|private-user-value/);assert.equal(doc.services.mysql.environment.MYSQL_ROOT_PASSWORD,'[redacted]');assert.deepEqual(input.parameters,{password:'private-root-value',database:'preview_db',user:'appuser',user_password:'private-user-value'});
 const changed=catalogPreview('mysql',{...input,parameters:{...input.parameters,database:'updated_db'}});assert.match(changed.yaml,/updated_db/);assert.notEqual(changed.yaml,first.yaml);
 assert.equal(parse(catalogPreview('redis',{parameters:{password:'redis-private'}}).yaml).services.app.volumes[0].target,'/data');assert.doesNotMatch(catalogPreview('redis',{parameters:{password:'redis-private'}}).yaml,/redis-private/);
 const webui=catalogPreview('openwebui',{parameters:{}});assert.equal(webui.yaml,catalogPreview('openwebui',{parameters:{}}).yaml);assert.equal(parse(webui.yaml).services.openwebui.environment.WEBUI_SECRET_KEY,'[redacted]');
 const rustfs=catalogPreview('rustfs',{parameters:{}});assert.doesNotMatch(rustfs.yaml,/x{32}/);assert.match(rustfs.yaml,/\[redacted\]/);
});
test('inventory caches only a known Compose capability and continues to read live containers',async()=>{
 let ps=0,compose=0;const command:OperationExecutionContext['command']=async(_file,args)=>{if(args.includes('ps')){ps++;return {stdout:JSON.stringify({ID:'a'.repeat(64),Names:'external',Image:'nginx:1.27',State:'running',Ports:'',Labels:'com.docker.compose.project=original-project'})+'\n',stderr:''}}compose++;return {stdout:'2.30.0',stderr:''}};
 const a=await readDockerInventory(command),b=await readDockerInventory(command);assert.equal(ps,2);assert.equal(compose,1);assert.equal(a.compose_available,true);assert.equal(b.containers[0].compose_project,'original-project');assert.equal(b.batch_management_version,1);assert.equal(dockerInventory({...b,batch_management_version:2})?.batch_management_version,undefined);
});
