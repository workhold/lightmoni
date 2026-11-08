import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {writeFile,readFile,mkdir,symlink,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {hostFilesFixture} from './helpers/host-files-fixture.js';
import {filePath} from '../src/server/machine-files.js';

test('file paths require bounded absolute paths and reject traversal/control characters',()=>{
 for(const path of ['relative','/a/../b','/a\0b','/a\nb','/'+ 'a'.repeat(4096)])assert.throws(()=>filePath(path));
 assert.equal(filePath('/中文 文件//配置.txt'),'/中文 文件/配置.txt');
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
