import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDefinition, executeBackup } from '../src/operations/backups.js';
import type { OperationExecutionContext, OperationPayload } from '../src/operations/types.js';
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'lm-backup-')));
 const source = join(root,'source'), storage = join(root,'store');
 await mkdir(source, {mode:0o700}); await mkdir(storage, {mode:0o700});
 await writeFile(join(source,'hello.txt'), 'before', {mode:0o600});
 const config = backupDefinition.validate({source_path:source,storage:{type:'local',path:storage},retain_count:1,max_bytes:1024*1024});
 const context: OperationExecutionContext = { dataDir:root,signal:new AbortController().signal,now:()=>new Date('2026-10-27T00:00:00Z'),command:async()=>{throw Error('no shell expected');} };
 const run = async(operation:string,input:any={}) => executeBackup({version:1,operation_id:crypto.randomUUID(),operation,resource:{id:'resource1',kind:'backup',name:'files',agent_id:'agent1',revision:1,config,created_at:'',updated_at:''},input:backupDefinition.validateInput(operation,input,config)} as OperationPayload,context);
 return {root,source,storage,config,run,close:()=>rm(root,{recursive:true,force:true})};
}
test('backup creates verified manifest, refuses changed restore target, and preserves pre-restore copy',async()=>{
 const f=await fixture(); try {
  const first=await f.run('create'); assert.equal(first.verified,true); assert.match(first.data.backup_id,/^[a-f0-9-]+$/);
  await writeFile(join(f.source,'hello.txt'),'after');
  await assert.rejects(f.run('restore',{backup_id:first.data.backup_id,expected_target_sha256:first.data.source_sha256}),/target changed/);
  const state=await f.run('list');
  const restored=await f.run('restore',{backup_id:first.data.backup_id,expected_target_sha256:state.data.source_sha256});
  assert.equal(await readFile(join(f.source,'hello.txt'),'utf8'),'before');
  assert.ok(restored.data.pre_restore_backup_id);
  assert.equal((await f.run('verify',{backup_id:restored.data.pre_restore_backup_id})).verified,true);
 }finally{await f.close();}
});
test('backup rejects symbolic links and local storage within source',async()=>{
 const f=await fixture();try{
  await symlink('/etc/passwd',join(f.source,'external'));
  await assert.rejects(f.run('create'),/symbolic|unsupported/);
  assert.throws(()=>backupDefinition.validate({source_path:f.source,storage:{type:'local',path:join(f.source,'backups')}}),/overlap/);
 }finally{await f.close();}
});
test('backup validates limits and checksum corruption',async()=>{
 const f=await fixture();try{
  assert.throws(()=>backupDefinition.validate({...f.config,max_bytes:Infinity}),/max_bytes/);
  assert.throws(()=>backupDefinition.validateInput('restore',{backup_id:'../x',expected_target_sha256:'a'.repeat(64)},f.config),/backup_id/);
  const first=await f.run('create'); await writeFile(join(f.storage,'resource1',first.data.backup_id+'.lmb.gz'),'corrupt');
  await assert.rejects(f.run('verify',{backup_id:first.data.backup_id}),/invalid backup/);
  await writeFile(join(f.source,'too-big'),Buffer.alloc(1024*1024+1));
  await assert.rejects(f.run('create'),/size limit/);
 }finally{await f.close();}
});
test('S3 credentials are hidden and invalid endpoints rejected',()=>{
 const value=backupDefinition.validate({source_path:'/srv/lightmoni/site',storage:{type:'s3',endpoint:'https://storage.example',bucket:'backups',region:'us-east-1',access_key_id:'AKID',secret_access_key:'SECRET'}});
 const publicValue=backupDefinition.publicConfig(value);
 assert.equal(publicValue.storage.secret_access_key,undefined);assert.equal(publicValue.storage.access_key_id,undefined);assert.equal(publicValue.storage.has_credentials,true);
 assert.throws(()=>backupDefinition.validate({...value,storage:{...value.storage,endpoint:'https://name:password@example.com'}}),/endpoint/);
});
test('S3 uses signed path-style HTTP operations, verifies readback and lists only resource prefix',async()=>{
 const {createServer}=await import('node:http');const {createHash,createHmac}=await import('node:crypto');
 const objects=new Map<string,Buffer>();const requests:string[]=[];
 const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');const sign=(k:Buffer|string,v:string)=>createHmac('sha256',k).update(v).digest();
 const server=createServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(Buffer.from(b));const body=Buffer.concat(chunks);const url=new URL(req.url!,'http://'+req.headers.host),auth=String(req.headers.authorization);const match=/Credential=AKID\/(\d{8})\/us-east-1\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]+)/.exec(auth);assert.ok(match);const names=match![2].split(';');const headers=names.map(n=>n+':'+String(req.headers[n]).trim()+'\n').join('');const query=[...url.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');const canonical=[req.method,url.pathname,query,headers,names.join(';'),digest(body)].join('\n');const scope=match![1]+'/us-east-1/s3/aws4_request';const k=sign(sign(sign(sign('AWS4SECRET',match![1]),'us-east-1'),'s3'),'aws4_request');assert.equal(sign(k,['AWS4-HMAC-SHA256',String(req.headers['x-amz-date']),scope,digest(canonical)].join('\n')).toString('hex'),match![3]);requests.push(req.method+' '+url.pathname);if(url.searchParams.has('list-type')){const prefix='/backups/'+url.searchParams.get('prefix');res.end('<ListBucketResult><IsTruncated>false</IsTruncated>'+[...objects.keys()].filter(k=>k.startsWith(prefix)).map(k=>'<Contents><Key>'+k.slice('/backups/'.length)+'</Key></Contents>').join('')+'</ListBucketResult>');return;}if(req.method==='PUT'){objects.set(url.pathname,body);res.setHeader('x-amz-version-id','version-1');res.end();return;}if(req.method==='DELETE'){objects.delete(url.pathname);res.statusCode=204;res.end();return;}const b=objects.get(url.pathname);if(!b){res.statusCode=404;res.end();return;}res.setHeader('x-amz-version-id','version-1');res.end(b);}catch(e){res.statusCode=500;res.end('fixture signature mismatch');}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const f=await fixture();try{const port=(server.address()as any).port;f.config.storage={type:'s3',endpoint:'http://127.0.0.1:'+port,bucket:'backups',prefix:'lightmoni',region:'us-east-1',access_key_id:'AKID',secret_access_key:'SECRET'};
 const first=await f.run('create');assert.equal(first.data.object_version,'version-1');const listed=await f.run('list');assert.equal(listed.data.backups.length,1);await f.run('verify',{backup_id:first.data.backup_id});await f.run('create');await f.run('prune');assert.equal(objects.size,1);assert.ok(requests.some(r=>r.startsWith('DELETE ')));assert.ok(requests.every(r=>/ \/backups(?:\/|$)/.test(r)));
 }finally{await f.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
test('restore rejects a malicious archive path before changing source or creating recovery backup',async()=>{
 const {gzipSync,gunzipSync}=await import('node:zlib');const f=await fixture();try{const made=await f.run('create');const file=join(f.storage,'resource1',made.data.backup_id+'.lmb.gz');const archive=JSON.parse(gunzipSync(await readFile(file)).toString());archive.entries[0].path='../outside';await writeFile(file,gzipSync(JSON.stringify(archive)));await assert.rejects(f.run('restore',{backup_id:made.data.backup_id,expected_target_sha256:made.data.source_sha256}),/invalid backup/);assert.equal(await readFile(join(f.source,'hello.txt'),'utf8'),'before');}finally{await f.close();}
});
test('retention never prunes the recovery copy produced before restore',async()=>{
 const f=await fixture();try{const a=await f.run('create');await writeFile(join(f.source,'hello.txt'),'changed');const state=await f.run('list');const restored=await f.run('restore',{backup_id:a.data.backup_id,expected_target_sha256:state.data.current_target_sha256});await f.run('create');const pruned=await f.run('prune');assert.equal(pruned.data.pre_restore_retained,true);assert.equal((await f.run('verify',{backup_id:restored.data.pre_restore_backup_id})).verified,true);}finally{await f.close();}
});
test('backup listing and retention receipts stay bounded without limiting actual cleanup',async()=>{
 const {gzipSync,gunzipSync}=await import('node:zlib');const f=await fixture();try{const first=await f.run('create');const initial=JSON.parse(gunzipSync(await readFile(join(f.storage,'resource1',first.data.backup_id+'.lmb.gz'))).toString());for(let i=0;i<105;i++){const a={...initial,id:crypto.randomUUID(),created_at:new Date(Date.parse(initial.created_at)+i*1000).toISOString()};await writeFile(join(f.storage,'resource1',a.id+'.lmb.gz'),gzipSync(JSON.stringify(a)));}const listed=await f.run('list');assert.equal(listed.data.total,106);assert.equal(listed.data.backups.length,100);assert.equal(listed.data.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(listed.data))<60*1024);const pruned=await f.run('prune');assert.equal(pruned.data.removed_total,105);assert.equal(pruned.data.removed.length,100);assert.equal(pruned.data.truncated,true);assert.equal((await f.run('list')).data.total,1);}finally{await f.close();}
});
test('uncertain S3 upload reports unknown when the server accepted bytes but dropped its response',async()=>{
 const {createServer}=await import('node:http');let accepted=false;const server=createServer(async(req,res)=>{for await(const _ of req){}accepted=true;res.destroy();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const f=await fixture();try{f.config.storage={type:'s3',endpoint:'http://127.0.0.1:'+(server.address()as any).port,bucket:'backups',region:'us-east-1',access_key_id:'AKID',secret_access_key:'SECRET'};const result=await f.run('create');assert.equal(accepted,true);assert.equal(result.verified,false);assert.equal(result.data.status,'unknown');assert.equal(JSON.stringify(result).includes('SECRET'),false);}finally{await f.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
