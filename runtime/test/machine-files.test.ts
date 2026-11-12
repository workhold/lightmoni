import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {writeFile,readFile,mkdir,symlink,chmod,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hostFilesFixture} from './helpers/host-files-fixture.js';
import {filePath,RemoteFiles} from '../src/server/machine-files.js';
import {hash} from '../src/shared/crypto.js';

test('file paths require bounded absolute paths and reject traversal/control characters',()=>{
 for(const path of ['relative','/a/../b','/a\0b','/a\nb','/'+ 'a'.repeat(4096)])assert.throws(()=>filePath(path));
 assert.equal(filePath('/中文 文件//配置.txt'),'/中文 文件/配置.txt');
});

test('typed maintenance preserves uncertainty when a successful mutation cannot be read back',async()=>{
 let removed=false;
 const sftp={realpath:(_:string,done:Function)=>done(null,'/safe'),unlink:(_:string,done:Function)=>{removed=true;done(null)}};
 const files=new RemoteFiles(sftp as any,()=>{});
 files.metadata=async(path:string)=>({path,type:'file',version:'a'.repeat(64),stat_version:'b'.repeat(64),size:1,mode:'0600'});
 files.stat=async()=>{throw Error('connection lost during readback')};
 await assert.rejects(files.action('/safe/file',{operation:'remove',confirmed:true,expected_version:'a'.repeat(64)}),/connection lost/);
 assert.equal(removed,true);assert.equal(files.mutationStarted,true);
});

test('SFTP reads use bounded parallel requests, complete short reads and settle before close',async()=>{
 const source=Buffer.alloc(320<<10);for(let i=0;i<source.length;i++)source[i]=i%251;
 const attributes={size:source.length,mtime:1,mode:0o100644,uid:1,gid:1,isFile:()=>true};
 let pending=0,maximum=0,statCalls=0;
 const sftp={
  lstat:(_:string,done:Function)=>done(null,attributes),
  open:(_:string,_flags:string,done:Function)=>done(null,Buffer.from('handle')),
  fstat:(_:Buffer,done:Function)=>{assert.equal(pending,0);statCalls++;done(null,attributes)},
  read:(_:Buffer,buffer:Buffer,offset:number,length:number,position:number,done:Function)=>{
   pending++;maximum=Math.max(maximum,pending);
   setImmediate(()=>{const count=Math.min(length,4096,source.length-position);source.copy(buffer,offset,position,position+count);pending--;done(null,count)});
  },
  close:(_:Buffer,done:Function)=>{assert.equal(pending,0);done(null)}
 };
 const found=await new RemoteFiles(sftp as any,()=>{}).read('/large');
 assert.deepEqual(found?.bytes,source);assert.equal(statCalls,2);assert.ok(maximum>1&&maximum<=8,`in-flight reads: ${maximum}`);
});

test('SFTP early EOF reports file_changed after all pending reads settle',async()=>{
 const source=Buffer.alloc(64<<10,65),attributes={size:256<<10,mtime:1,mode:0o100644,uid:1,gid:1,isFile:()=>true};
 let pending=0,closed=false;
 const sftp={
  lstat:(_:string,done:Function)=>done(null,attributes),
  open:(_:string,_flags:string,done:Function)=>done(null,Buffer.from('handle')),
  fstat:(_:Buffer,done:Function)=>done(null,attributes),
  read:(_:Buffer,buffer:Buffer,offset:number,length:number,position:number,done:Function)=>{
   pending++;
   setTimeout(()=>{const count=Math.max(0,Math.min(length,source.length-position));if(count)source.copy(buffer,offset,position,position+count);pending--;done(null,count)},position>=source.length?0:5);
  },
  close:(_:Buffer,done:Function)=>{assert.equal(pending,0);closed=true;done(null)}
 };
 await assert.rejects(new RemoteFiles(sftp as any,()=>{}).read('/shrunk'),/file_changed/);
 assert.equal(closed,true);
});

test('combined file-session open returns the first directory over one SSH connection',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`;
 const opened=await f.request(endpoint,'POST',{credential_id:f.credential.id,initial_path:f.directory});
 assert.equal(opened.status,200,JSON.stringify(opened.data));
 assert.equal(opened.data.initial_directory.path,f.directory);
 assert.ok(opened.data.initial_directory.entries.some((item:any)=>item.name==='配置 文件.txt'));
 assert.equal(f.sshConnections(),1);
 assert.deepEqual(f.db.all<any>("SELECT operation,path,result FROM machine_file_events"),[{operation:'list',path:f.directory,result:'succeeded'}]);
 const headers={'X-LightMoni-File-Session':opened.data.session_id};
 const listed=await f.request(f.path('files'),'GET',undefined,'admin',headers);
 assert.equal(listed.status,200);
 assert.deepEqual(opened.data.initial_directory,listed.data);
 assert.equal(f.sshConnections(),1);
 const large=join(f.directory,'large.txt');await writeFile(large,'a'.repeat(320<<10));
 const content=await f.request(f.path('file',large),'GET',undefined,'admin',headers);
 assert.equal(content.status,200);assert.equal(content.data.content.length,320<<10);
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',headers)).status,204);
});

test('combined open rejects invalid paths before SSH and releases a failed initial session',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`;
 const invalid=await f.request(endpoint,'POST',{credential_id:f.credential.id,initial_path:'relative'});
 assert.equal(invalid.status,400);assert.equal(invalid.data.error,'invalid_file_path');assert.equal(f.sshConnections(),0);
 const missing=await f.request(endpoint,'POST',{credential_id:f.credential.id,initial_path:join(f.directory,'missing')});
 assert.equal(missing.status,404);assert.equal(missing.data.error,'file_not_found');
 const opened=await f.request(endpoint,'POST',{credential_id:f.credential.id,initial_path:f.directory});
 assert.equal(opened.status,200,JSON.stringify(opened.data));assert.equal(f.sshConnections(),2);
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',{'X-LightMoni-File-Session':opened.data.session_id})).status,204);
});

test('failed initial list releases only its opener on a shared file session',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`;
 const first=await f.request(endpoint,'POST',{credential_id:f.credential.id});assert.equal(first.status,200);
 const headers={'X-LightMoni-File-Session':first.data.session_id};
 const failed=await f.request(endpoint,'POST',{credential_id:f.credential.id,initial_path:join(f.directory,'missing')});
 assert.equal(failed.status,404);assert.equal(failed.data.error,'file_not_found');
 assert.equal((await f.request(f.path('files'),'GET',undefined,'admin',headers)).status,200);
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',headers)).status,204);
 const stale=await f.request(f.path('files'),'GET',undefined,'admin',headers);
 assert.equal(stale.status,409);assert.equal(stale.data.error,'file_session_expired');assert.equal(f.sshConnections(),1);
});

test('a failed first directory does not close a second opener created while it was loading',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`,missing=join(f.directory,'missing');
 let entered!:()=>void,unblock!:()=>void;
 const reached=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{unblock=resolve});
 const original=RemoteFiles.prototype.list;
 RemoteFiles.prototype.list=async function(path:string){if(path===missing){entered();await gate;}return original.call(this,path)};
 try{
  const opening=f.request(endpoint,'POST',{credential_id:f.credential.id,initial_path:missing});
  await reached;
  const second=await f.request(endpoint,'POST',{credential_id:f.credential.id});assert.equal(second.status,200,JSON.stringify(second.data));
  unblock();const failed=await opening;assert.equal(failed.status,404);
  const headers={'X-LightMoni-File-Session':second.data.session_id};
  assert.equal((await f.request(f.path('files'),'GET',undefined,'admin',headers)).status,200);
  assert.equal(f.sshConnections(),1);
  assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',headers)).status,204);
 }finally{unblock();RemoteFiles.prototype.list=original}
});

test('file session reuses one real SSH/SFTP connection and legacy requests remain independent',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`;
 const opened=await f.request(endpoint,'POST',{credential_id:f.credential.id});
 assert.equal(opened.status,200,JSON.stringify(opened.data));
 assert.equal(opened.data.machine_id,f.machine.id);assert.equal(opened.data.credential_id,f.credential.id);
 assert.match(opened.data.session_id,/^[A-Za-z0-9_-]{20,128}$/);assert.equal(opened.data.idle_timeout_ms,20000);
 assert.equal(opened.data.expires_at.length>0,true);
 const headers={'X-LightMoni-File-Session':opened.data.session_id};
 const first=await f.request(f.path('files')+'&credential_id='+f.credential.id,'GET',undefined,'admin',headers);
 assert.equal(first.status,200,JSON.stringify(first.data));
 const document=await f.request(f.path('file',join(f.directory,'配置 文件.txt'))+'&credential_id='+f.credential.id,'GET',undefined,'admin',headers);
 assert.equal(document.status,200);assert.equal(document.data.content,'原始内容\n');
 const saved=await f.request(f.path('file',document.data.path)+'&credential_id='+f.credential.id,'PUT',{content:'会话保存\n',expected_version:document.data.version,confirmed:true},'admin',headers);
 assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(await readFile(document.data.path,'utf8'),'会话保存\n');
 const conflict=await f.request(f.path('file',document.data.path)+'&credential_id='+f.credential.id,'PUT',{content:'must not replace',expected_version:document.data.version,confirmed:true},'admin',headers);
 assert.equal(conflict.status,409);assert.equal(conflict.data.error,'file_changed');assert.equal(await readFile(document.data.path,'utf8'),'会话保存\n');
 assert.equal((await f.request(f.path('files')+'&credential_id='+f.credential.id,'GET',undefined,'admin',headers)).status,200);
 assert.equal(f.sshConnections(),1,'all session operations must share the same SSH client');
 assert.equal(await f.request(endpoint,'DELETE',undefined,'admin',headers).then(r=>r.status),204);
 assert.equal((await f.request(f.path('files'))).status,200);assert.equal(f.sshConnections(),2,'legacy request opens its own SSH client after the session closes');
 assert.equal((await f.request(f.path('files')+'&credential_id='+f.credential.id,'GET',undefined,'admin',headers)).data.error,'file_session_expired');
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',headers)).status,204);
 const audit=f.db.all<any>('SELECT operation,result FROM machine_file_events');
 assert.ok(audit.some(row=>row.operation==='write'&&row.result==='succeeded'));
 assert.ok(!JSON.stringify(audit).includes(opened.data.session_id));
});

test('file session is bound to the exact login and closes on credential or target change',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`;
 f.db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hash('admin-other'),'admin',Math.floor(Date.now()/1000)+3600);
 const opened=await f.request(endpoint,'POST',{credential_id:f.credential.id});assert.equal(opened.status,200);
 const headers={'X-LightMoni-File-Session':opened.data.session_id},path=f.path('files')+'&credential_id='+f.credential.id;
 assert.equal((await f.request(path,'GET',undefined,'admin-other',headers)).status,403);
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin-other',headers)).status,403);
 assert.equal((await f.request(path,'GET',undefined,'admin',headers)).status,200);
 const revoke=await f.request(`/machines/${f.machine.id}/accounts/${f.account.id}/credentials/${f.credential.id}`,'DELETE');
 assert.equal(revoke.status,200,JSON.stringify(revoke.data));
 const changed=await f.request(path,'GET',undefined,'admin',headers);assert.equal(changed.status,409);assert.equal(changed.data.error,'file_credential_changed');
 assert.equal(f.sshConnections(),1);
});

test('two panels from one login share a session until the final close; a different credential cannot evict it',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`,file=join(f.directory,'配置 文件.txt');
 const first=await f.request(endpoint,'POST',{credential_id:f.credential.id});assert.equal(first.status,200);
 const firstHeaders={'X-LightMoni-File-Session':first.data.session_id};
 const original=await f.request(f.path('file',file),'GET',undefined,'admin',firstHeaders);assert.equal(original.status,200);
 const second=await f.request(endpoint,'POST',{credential_id:f.credential.id});assert.equal(second.status,200,JSON.stringify(second.data));
 assert.equal(second.data.session_id,first.data.session_id);assert.equal(f.sshConnections(),1);
 const alternate=await f.addCredential();assert.equal(alternate.status,201,JSON.stringify(alternate.data));
 const busy=await f.request(endpoint,'POST',{credential_id:alternate.data.id});assert.equal(busy.status,409);assert.equal(busy.data.error,'file_session_busy');
 const mismatched=await f.request(f.path('file',file)+'&credential_id='+alternate.data.id,'GET',undefined,'admin',firstHeaders);assert.equal(mismatched.status,409);assert.equal(mismatched.data.error,'file_credential_changed');
 assert.equal((await f.request(f.path('file',file),'GET',undefined,'admin',firstHeaders)).status,200);
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',firstHeaders)).status,204);
 assert.equal((await f.request(f.path('file',file),'GET',undefined,'admin',firstHeaders)).status,200,'the other opener remains usable');
 assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',firstHeaders)).status,204);
 const stale=await f.request(f.path('file',file),'PUT',{content:'must not write',expected_version:original.data.version,confirmed:true},'admin',firstHeaders);
 assert.equal(stale.status,409);assert.equal(stale.data.error,'file_session_expired');assert.equal(await readFile(file,'utf8'),'原始内容\n');
 assert.equal(f.sshConnections(),1);
});

test('final panel close waits for a write already published',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),endpoint=`/machines/${f.machine.id}/file-session`,file=join(f.directory,'配置 文件.txt');
 const opened=await f.request(endpoint,'POST',{credential_id:f.credential.id});assert.equal(opened.status,200);
 const headers={'X-LightMoni-File-Session':opened.data.session_id};
 const original=await f.request(f.path('file',file),'GET',undefined,'admin',headers);assert.equal(original.status,200);
 let published!:()=>void,unblock!:()=>void;
 const reached=new Promise<void>(resolve=>{published=resolve}),gate=new Promise<void>(resolve=>{unblock=resolve});
 const write=RemoteFiles.prototype.write;
 RemoteFiles.prototype.write=async function(path,bytes,expected){const saved=await write.call(this,path,bytes,expected);published();await gate;return saved};
 try{
  const saving=f.request(f.path('file',file),'PUT',{content:'published before close\n',expected_version:original.data.version,confirmed:true},'admin',headers);
  await reached;
  assert.equal((await f.request(endpoint,'DELETE',undefined,'admin',headers)).status,204);
  const closed=await f.request(f.path('file',file),'GET',undefined,'admin',headers);assert.equal(closed.status,409);assert.equal(closed.data.error,'file_session_expired');
  unblock();const saved=await saving;assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(await readFile(file,'utf8'),'published before close\n');
  assert.equal(f.db.get<any>("SELECT result FROM machine_file_events WHERE operation='write' ORDER BY rowid DESC LIMIT 1")?.result,'succeeded');
 }finally{unblock();RemoteFiles.prototype.write=write}
});

test('revocation after publication reports a write as unverified and audits unknown',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),file=join(f.directory,'配置 文件.txt');
 const opened=await f.request(`/machines/${f.machine.id}/file-session`,'POST',{credential_id:f.credential.id});assert.equal(opened.status,200);
 const headers={'X-LightMoni-File-Session':opened.data.session_id};
 const original=await f.request(f.path('file',file),'GET',undefined,'admin',headers);assert.equal(original.status,200);
 const write=RemoteFiles.prototype.write;
 RemoteFiles.prototype.write=async function(path,bytes,expected){const saved=await write.call(this,path,bytes,expected);const revoke=await f.request(`/machines/${f.machine.id}/accounts/${f.account.id}/credentials/${f.credential.id}`,'DELETE');assert.equal(revoke.status,200);return saved};
 try{
  const result=await f.request(f.path('file',file),'PUT',{content:'committed before revocation\n',expected_version:original.data.version,confirmed:true},'admin',headers);
  assert.equal(result.status,409);assert.equal(result.data.error,'file_write_unverified');
  assert.equal(await readFile(file,'utf8'),'committed before revocation\n');
  assert.equal(f.db.get<any>("SELECT result FROM machine_file_events WHERE operation='write' ORDER BY rowid DESC LIMIT 1")?.result,'unknown');
 }finally{RemoteFiles.prototype.write=write}
});

test('file service shutdown waits for an in-flight session request',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),opened=await f.request(`/machines/${f.machine.id}/file-session`,'POST',{credential_id:f.credential.id});assert.equal(opened.status,200);
 let enter!:()=>void,unblock!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{unblock=resolve});
 const original=RemoteFiles.prototype.list;
 RemoteFiles.prototype.list=async function(path:string){enter();await gate;return original.call(this,path)};
 try{
  const reading=f.request(f.path('files'),'GET',undefined,'admin',{'X-LightMoni-File-Session':opened.data.session_id});
  await entered;
  let finished=false;const closing=Promise.resolve(f.closeFiles()).then(()=>{finished=true});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(finished,false);
  unblock();await reading;await closing;assert.equal(finished,true);
 }finally{unblock();RemoteFiles.prototype.list=original}
});

test('file session target revision and idle/absolute deadlines invalidate before another SFTP operation',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t,{idleMs:120,maxMs:600}),endpoint=`/machines/${f.machine.id}/file-session`;
 const open=()=>f.request(endpoint,'POST',{credential_id:f.credential.id});
 let opened=await open();assert.equal(opened.status,200);
 let headers={'X-LightMoni-File-Session':opened.data.session_id};
 f.db.run('UPDATE managed_machines SET ssh_target_generation=ssh_target_generation+1 WHERE id=?',f.machine.id);
 let response=await f.request(f.path('files')+'&credential_id='+f.credential.id,'GET',undefined,'admin',headers);
 assert.equal(response.status,409);assert.equal(response.data.error,'file_credential_changed');
 opened=await open();assert.equal(opened.status,200,JSON.stringify(opened.data));headers={'X-LightMoni-File-Session':opened.data.session_id};
 await new Promise(resolve=>setTimeout(resolve,220));
 response=await f.request(f.path('files')+'&credential_id='+f.credential.id,'GET',undefined,'admin',headers);
 assert.equal(response.status,409);assert.equal(response.data.error,'file_session_expired');
 const long=await hostFilesFixture(t,{idleMs:1000,maxMs:120});
 const other=await long.request(`/machines/${long.machine.id}/file-session`,'POST',{credential_id:long.credential.id});assert.equal(other.status,200);
 await new Promise(resolve=>setTimeout(resolve,220));
 response=await long.request(long.path('files')+'&credential_id='+long.credential.id,'GET',undefined,'admin',{'X-LightMoni-File-Session':other.data.session_id});
 assert.equal(response.status,409);assert.equal(response.data.error,'file_session_expired');
});

test('real SSH/SFTP: list, UTF-8 edit, atomic overwrite, exclusive binary upload, conflict and audit',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),target=join(f.directory,'配置 文件.txt');
 await mkdir(join(f.directory,'子目录'));await writeFile(join(f.directory,'.hidden'),'hidden');await chmod(target,0o640);
 let response=await f.request(f.path('files'));assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.machine_id,f.machine.id);assert.equal(response.data.path,f.directory);assert.ok(response.data.entries.some((v:any)=>v.name==='.hidden'));assert.equal(response.data.entries[0].type,'directory');assert.equal(response.data.entries.find((v:any)=>v.name==='配置 文件.txt').mode,'0640');
 const initial=await f.request(f.path('file',target));assert.equal(initial.status,200);assert.equal(initial.data.content,'原始内容\n');
 const saved=await f.request(f.path('file',target),'PUT',{content:'修改内容\n',expected_version:initial.data.version,confirmed:true});assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(await readFile(target,'utf8'),'修改内容\n');assert.equal((await stat(target)).mode&0o777,0o640);assert.notEqual(saved.data.version,initial.data.version);
 assert.equal((await f.request(f.path('file',target))).data.version,saved.data.version);
 assert.equal((await f.request(f.path('file',target),'PUT',{content:'过时编辑',expected_version:initial.data.version,confirmed:true})).status,409);assert.equal(await readFile(target,'utf8'),'修改内容\n');
 const binary=Buffer.from([0,255,1,200,0,42]),destination=join(f.directory,'upload.bin'),upload=f.path('file-upload',destination);
 assert.equal((await f.request(f.path('file-version',destination))).data.version,null);
 response=await f.request(upload+'&expected_version=new&confirmed=true','POST',binary);assert.equal(response.status,200,JSON.stringify(response.data));assert.deepEqual(await readFile(destination),binary);
 assert.equal((await f.request(upload+'&expected_version=new&confirmed=true','POST',Buffer.from('clobber'))).status,409);assert.deepEqual(await readFile(destination),binary);
 const old=response.data.version;response=await f.request(upload+'&expected_version='+old+'&confirmed=true','POST',Buffer.from('replacement'));assert.equal(response.status,200);assert.equal(await readFile(destination,'utf8'),'replacement');
 const audit=f.db.all<any>('SELECT * FROM machine_file_events');assert.ok(audit.some(r=>r.operation==='upload'&&r.result==='succeeded'));assert.ok(audit.some(r=>r.operation==='write'&&r.result==='failed'));assert.ok(audit.every(r=>r.actor_id==='admin'&&r.account_id===f.account.id));assert.ok(!JSON.stringify(audit).includes('修改内容'));
 assert.equal((await f.request(f.path('files'))).data.entries.some((e:any)=>e.name.startsWith('.lightmoni-upload-')),false);
});

test('real SFTP: auth, pinning, unsupported types, bounds and explicit confirmation',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),file=join(f.directory,'配置 文件.txt'),link=join(f.directory,'link');
 assert.equal((await f.request(f.path('files'),'GET',undefined,'member')).status,403);
 assert.equal((await f.request(f.path('files'),'GET',undefined,'missing')).status,401);
 assert.equal((await f.request(f.path('files'),'GET',undefined,'admin',{authorization:'Bearer invalid'})).status,403);
 assert.equal((await f.request(f.path('file',file),'PUT',{content:'unsafe',expected_version:'a'.repeat(64)})).status,400);
 assert.equal((await f.request(f.path('file-upload',join(f.directory,'new'))+'&expected_version=new','POST',Buffer.from('unsafe'))).status,400);
 await chmod(file,0o000);assert.equal((await f.request(f.path('file',file))).status,403);await chmod(file,0o644);
 await symlink(file,link);assert.equal((await f.request(f.path('file',link))).status,409);assert.equal((await f.request(f.path('file',f.directory))).status,409);
 await writeFile(join(f.directory,'binary'),Buffer.from([0,255]));assert.equal((await f.request(f.path('file',join(f.directory,'binary')))).data.error,'file_not_utf8_text');
 await writeFile(join(f.directory,'large'),Buffer.alloc((1<<20)+1,65));assert.equal((await f.request(f.path('file',join(f.directory,'large')))).status,413);
 const version=(await f.request(f.path('file',file))).data.version;
 assert.equal((await f.request(f.path('file-upload',file)+'&expected_version='+version+'&confirmed=true','POST',Buffer.alloc((8<<20)+1))).status,413);assert.equal(await readFile(file,'utf8'),'原始内容\n');
 f.db.run('UPDATE managed_machines SET host_key_fingerprint=? WHERE id=?','SHA256:wrong',f.machine.id);
 {const response=await f.request(f.path('files'));assert.equal(response.status,502);assert.equal(response.data.error,'host_key_mismatch');}
 assert.equal((await f.request(`/machines/${f.machine.id}`,'PUT',{name:'released'})).status,200);
});

test('real SFTP: typed file and directory maintenance checks metadata and verifies results',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t);
 const metadata=async(path:string)=>(await f.request(f.path('file-metadata',path))).data;
 const action=(path:string,body:unknown)=>f.request(f.path('file-actions',path),'POST',body);
 const create=async(path:string,operation='create')=>action(path,{operation,confirmed:true,expected_version:'new',parent_version:(await metadata(f.directory)).version});
 const file=join(f.directory,'新 文件.yaml'),directory=join(f.directory,'新目录');
 let response=await create(file);assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(await readFile(file,'utf8'),'');assert.equal(response.data.type,'file');
 assert.equal((await create(file)).status,409);
 response=await create(directory,'mkdir');assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.type,'directory');
 const oldDirectory=await metadata(directory);await writeFile(join(directory,'child'),'x');
 assert.equal((await action(directory,{operation:'remove',confirmed:true,expected_version:oldDirectory.version})).status,409);
 assert.equal((await action(directory,{operation:'remove',confirmed:true,expected_version:(await metadata(directory)).version})).data.error,'file_directory_not_empty');
 let snapshot=await metadata(file);
 response=await action(file,{operation:'chmod',mode:'0640',confirmed:true,expected_version:snapshot.version});assert.equal(response.status,200,JSON.stringify(response.data));assert.equal((await stat(file)).mode&0o777,0o640);assert.notEqual(response.data.version,snapshot.version);
 assert.equal((await action(file,{operation:'remove',confirmed:true,expected_version:snapshot.version})).status,409);
 snapshot=await metadata(file);
 response=await action(file,{operation:'rename',name:'renamed.yaml',confirmed:true,expected_version:snapshot.version});assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.path,join(f.directory,'renamed.yaml'));assert.equal((await f.request(f.path('file-metadata',file))).status,404);
 assert.equal((await action(response.data.path,{operation:'rename',name:'配置 文件.txt',confirmed:true,expected_version:response.data.version})).status,409);
 response=await action(response.data.path,{operation:'remove',confirmed:true,expected_version:response.data.version});assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.removed,true);
 await writeFile(join(f.directory,'large.bin'),Buffer.alloc((8<<20)+1));
 snapshot=await metadata(join(f.directory,'large.bin'));assert.match(snapshot.version,/^[a-f0-9]{64}$/);
 assert.equal((await action(snapshot.path,{operation:'chmod',mode:'0600',confirmed:true,expected_version:snapshot.version})).status,200);
 const entries=(await f.request(f.path('files'))).data;assert.match(entries.version,/^[a-f0-9]{64}$/);assert.ok(entries.entries.every((entry:any)=>/^[a-f0-9]{64}$/.test(entry.version)));
 const audit=f.db.all<any>('SELECT * FROM machine_file_events');assert.ok(['create','mkdir','rename','remove','chmod'].every(operation=>audit.some(row=>row.operation===operation&&row.result==='succeeded')));assert.equal((await readdir(f.directory)).some(name=>name.startsWith('.lightmoni-upload-')),false);
});

test('real SFTP: maintenance rejects unsafe targets, missing consent and stale parent snapshots',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const f=await hostFilesFixture(t),file=join(f.directory,'配置 文件.txt'),action=(path:string,body:unknown)=>f.request(f.path('file-actions',path),'POST',body);
 const metadata=async(path:string)=>(await f.request(f.path('file-metadata',path))).data;
 let snapshot=await metadata(file);
 assert.equal((await action(file,{operation:'remove',expected_version:snapshot.version})).status,400);
 for(const mode of ['4777','1000','888','-1',777])assert.equal((await action(file,{operation:'chmod',mode,confirmed:true,expected_version:snapshot.version})).status,400);
 for(const name of ['..','/elsewhere','a/b','a\nb'])assert.equal((await action(file,{operation:'rename',name,confirmed:true,expected_version:snapshot.version})).status,400);
 assert.equal((await action('/',{operation:'chmod',mode:'0700',confirmed:true,expected_version:'a'.repeat(64)})).status,400);
 const link=join(f.directory,'link');await symlink(file,link);
 assert.equal((await metadata(link)).error,'file_type_unsupported');assert.equal((await action(link,{operation:'remove',confirmed:true,expected_version:'a'.repeat(64)})).status,409);
 snapshot=await metadata(f.directory);await writeFile(join(f.directory,'remote-new'),'x');
 assert.equal((await action(join(f.directory,'new'),{operation:'create',confirmed:true,expected_version:'new',parent_version:snapshot.version})).status,409);
 assert.equal((await action(file,{operation:'remove',confirmed:true,expected_version:(await metadata(file)).version,recursive:true})).status,400);
 assert.equal((await f.request(f.path('file-metadata',file),'GET',undefined,'member')).status,403);
 assert.equal(await readFile(file,'utf8'),'原始内容\n');
});
