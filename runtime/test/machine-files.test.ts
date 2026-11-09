import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {writeFile,readFile,mkdir,symlink,chmod,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hostFilesFixture} from './helpers/host-files-fixture.js';
import {filePath,RemoteFiles} from '../src/server/machine-files.js';

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
