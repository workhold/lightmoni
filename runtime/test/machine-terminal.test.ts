import {fixturePrivateKey} from "./helpers/ssh-key.js";
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createTCPServer} from 'node:net';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {DB} from '../src/shared/sqlite.js';
import {Router} from '../src/shared/http.js';
import {hash} from '../src/shared/crypto.js';
import {Auth} from '../src/server/auth.js';
import {registerManagedMachines} from '../src/server/managed-machines.js';
import {registerMachineTerminal} from '../src/server/machine-terminal.js';
import type {Dependencies} from '../src/shared/types.js';
import {isolatedSSHD} from './helpers/isolated-sshd.js';
import {passwordSSHServer} from './helpers/password-ssh-server.js';

const fakeKey=fixturePrivateKey();
async function fixture(t:TestContext,limits:Record<string,number>={}){
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-terminal-test-')),db=new DB(':memory:'),router=new Router(),auth=new Auth(db,dir,'',router),logs:unknown[]=[];
 auth.register();router.auth=auth;
 for(const [token,id,role] of [['admin','admin','admin'],['other','other','admin'],['member','member','member'],['new-login','admin','admin']]){
  db.run('INSERT OR IGNORE INTO users(id,name,role,created_at) VALUES(?,?,?,?)',id,id,role,new Date().toISOString());
  db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hash(token),id,Math.floor(Date.now()/1000)+1000);
 }
 db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
 const deps={db,router,auth,encrypt:auth.encrypt,decrypt:auth.decrypt,now:()=>new Date(),externalURL:'',logger:{info:(...v:any[])=>logs.push(v),warn:(...v:any[])=>logs.push(v),error:(...v:any[])=>logs.push(v)}} as Dependencies;
 const machines=registerManagedMachines(deps),server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end()}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;deps.externalURL=router.externalURL=origin;
 const terminal=registerMachineTerminal(deps,machines,server,limits);
 t.after(async()=>{await terminal.close?.();await machines.close?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();await rm(dir,{recursive:true,force:true})});
 const request=async(path:string,method='GET',body?:unknown,login='admin',headers:Record<string,string>={})=>{
  const res=await fetch(origin+'/api/v1'+path,{method,headers:{cookie:`lm_session=${login}`,origin,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json() as any};
 };
 const host=async(overrides:Record<string,unknown>={},key=fakeKey,method='ssh_key')=>{
  const {host_key_fingerprint:pin='SHA256:abcdefghijklmnop',...target}=overrides;
  const m=await request('/machines','POST',{name:'Fixture',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',...target});assert.equal(m.status,201);
  if(pin)db.run('UPDATE managed_machines SET host_key_fingerprint=? WHERE id=?',pin,m.data.id);
  const c=await request(`/machines/${m.data.id}/credentials`,'POST',{method,secret:key,retention:method==='password'?'one_time':'temporary'});assert.equal(c.status,201);
  return {id:m.data.id,credentialID:c.data.credential_id,path:`/machines/${m.data.id}/terminal-sessions`};
 };
 const create=async(h:Awaited<ReturnType<typeof host>>,body:unknown={},login='admin')=>request(h.path,'POST',body,login);
 const rejected=(entry:any,login='admin',originValue:string|null=origin)=>new Promise<number>((resolve,reject)=>{
  const ws=new WebSocket(origin.replace('http:','ws:')+entry.websocket_path,{headers:{cookie:`lm_session=${login}`,...originValue===null?{}:{origin:originValue}}});
  ws.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode!)});ws.on('open',()=>{ws.close();reject(Error('unexpected upgrade'))});ws.on('error',reject);
 });
 const attach=async(entry:any,{ack=true}={})=>{
  const ws=new WebSocket(origin.replace('http:','ws:')+entry.websocket_path,{headers:{cookie:'lm_session=admin',origin}}),messages:any[]=[],chunks:Buffer[]=[];
  ws.on('message',(data,binary)=>{if(binary){const buffer=Buffer.from(data as Buffer);chunks.push(buffer);if(ack&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ack',bytes:buffer.length}));}else messages.push(JSON.parse(data.toString()))});
  ws.on('error',()=>{});await once(ws,'open');
  const wait=async(predicate:()=>boolean)=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20))}assert.fail('terminal event timed out: '+JSON.stringify(messages))};
  return {ws,messages,chunks,wait,text:()=>Buffer.concat(chunks).toString(),send:(value:any)=>ws.send(JSON.stringify(value)),connected:()=>wait(()=>messages.some(m=>m.status==='connected')),closed:(reason?:string)=>wait(()=>messages.some(m=>m.status==='closed'&&(!reason||m.reason===reason)))};
 };
 return {db,request,host,create,rejected,attach,origin,terminal,machines,logs,decrypt:auth.decrypt};
}

test('terminal REST and upgrades enforce administrator, exact login, origin, owner, machine and single use',async t=>{
 const f=await fixture(t),h=await f.host(),other=await f.host();
 assert.equal((await f.create(h,{},'member')).status,403);
 assert.equal((await f.create(h,{command:'id'})).status,400);
 assert.equal((await f.create(h,{cols:501})).status,400);
 assert.equal((await f.create(h,{credential_id:other.credentialID})).status,404);
 const created=await f.create(h);assert.equal(created.status,201);const entry=created.data;
 assert.ok(!JSON.stringify(entry).includes('PRIVATE KEY'));
 assert.equal(await f.rejected(entry,'member'),403);
 assert.equal(await f.rejected(entry,'other'),403);
 assert.equal(await f.rejected(entry,'new-login'),403);
 assert.equal(await f.rejected(entry,'admin',null),403);
 assert.equal(await f.rejected(entry,'admin','https://evil.example'),403);
 assert.equal(await f.rejected({...entry,websocket_path:entry.websocket_path.replace(h.id,other.id)}),404);
 assert.equal((await f.request(`${h.path}/${entry.id}`,'DELETE',undefined,'other')).status,403);
 assert.equal((await f.request(`${h.path}/${entry.id}`,'DELETE',undefined,'new-login')).status,403);
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'changed'})).status,409);
 assert.equal((await f.request(`/machines/${h.id}`,'DELETE')).status,409);
 assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{})).status,409);
 assert.equal((await f.create(h)).status,409);
 assert.equal((await f.request(`${h.path}/${entry.id}`,'DELETE')).status,200);
 assert.equal((await f.request(`${h.path}/${entry.id}`,'DELETE')).status,200);
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'deploy'})).status,200);
 assert.equal(await f.rejected(entry),404);
 assert.deepEqual(f.logs,[]);
});

test('pending expiry, caps, ambiguous/expired/revoked keys and revocation release leases',async t=>{
 const f=await fixture(t,{pendingMs:200,globalLimit:2,userLimit:1}),h=await f.host(),other=await f.host();
 const first=await f.create(h);assert.equal(first.status,201);assert.equal((await f.create(other)).status,429);
 await f.request(`/machines/${h.id}/credentials/${h.credentialID}`,'DELETE');
 assert.equal(await f.rejected(first.data),404);
 assert.equal(f.db.get<any>('SELECT reason FROM machine_terminal_events WHERE id=?',first.data.id)?.reason,'credential_invalid');
 assert.equal((await f.create(h,{credential_id:h.credentialID})).status,409);
 const pending=await f.create(other);assert.equal(pending.status,201);
 await new Promise(r=>setTimeout(r,250));assert.equal(await f.rejected(pending.data),404);
 assert.equal(f.db.get<any>('SELECT reason FROM machine_terminal_events WHERE id=?',pending.data.id)?.reason,'connect_expired');
 const duplicate=await f.request(`/machines/${other.id}/credentials`,'POST',{method:'ssh_key',secret:fixturePrivateKey(),retention:'temporary'});
 const selected=await f.create(other);assert.equal(selected.status,201);await f.request(`${other.path}/${selected.data.id}`,'DELETE');
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?','2000-01-01T00:00:00Z',duplicate.data.credential_id);
 assert.equal((await f.create(other,{credential_id:duplicate.data.credential_id})).status,409);
 assert.equal((await f.create(other)).status,409);
 const original=f.db.get<any>('SELECT id FROM machine_credentials WHERE machine_id=? AND id!=?',other.id,duplicate.data.credential_id);await f.request(`/machines/${other.id}/default-credential`,'PUT',{credential_id:original.id});assert.equal((await f.create(other)).status,201);
});

test('real PTY: UTF-8, commands, Ctrl+C, resize, flow control, single attach, disconnect and revocation',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const ssh=await isolatedSSHD(t),f=await fixture(t),h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},ssh.privateKey);
 const entry=(await f.create(h,{cols:90,rows:25})).data,c=await f.attach(entry);await c.connected();
 assert.equal(await f.rejected(entry),409);
 c.send({type:'input',data:"printf '\\nTERM_%s\\n' '你好'; stty size\r"});
 await c.wait(()=>c.text().includes('TERM_你好')&&c.text().includes('25 90'));
 c.send({type:'resize',cols:110,rows:32});c.send({type:'input',data:"stty size; sleep 10\r"});
 await c.wait(()=>c.text().includes('32 110'));c.send({type:'input',data:'\x03'});
 c.send({type:'input',data:"printf '\\nCTRL_%s\\n' 'OK'\r"});await c.wait(()=>c.text().includes('CTRL_OK'));
 c.send({type:'input',data:"head -c 400000 /dev/zero | tr '\\0' x; printf '\\nFLOW_%s\\n' 'OK'\r"});await c.wait(()=>c.text().includes('FLOW_OK'));
 assert.ok(c.chunks.reduce((n,b)=>n+b.length,0)>400000);
 await f.request(`/machines/${h.id}/credentials/${h.credentialID}`,'DELETE');await c.closed('credential_invalid');await c.wait(()=>c.ws.readyState===WebSocket.CLOSED);
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:ssh.username})).status,200);
 const event=f.db.get<any>('SELECT * FROM machine_terminal_events WHERE id=?',entry.id);assert.ok(event.connected_at&&event.closed_at);
 assert.ok(!JSON.stringify(event).includes('TERM_'));assert.ok(!JSON.stringify(event).includes(ssh.privateKey));assert.deepEqual(f.logs,[]);
});

test('real SSH validates host pin and auth, and cleans up on invalid protocol, logout, expiry, exit and shutdown',{skip:!existsSync('/usr/sbin/sshd'),timeout:30000},async t=>{
 const ssh=await isolatedSSHD(t),f=await fixture(t,{checkMs:50,idleMs:10_000}),h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:'SHA256:wrongconfirmedfingerprint'},ssh.privateKey);
 let c=await f.attach((await f.create(h)).data);await c.closed('host_key_mismatch');
 f.db.run("UPDATE managed_machines SET host_key_fingerprint=?,host_key_public_key='',host_key_observed_at='' WHERE id=?",ssh.pin,h.id);

 // Authentication failures return a fixed code; raw ssh2 errors never cross WS.
 const wrong=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},ssh.wrongKey);
 c=await f.attach((await f.create(wrong)).data);await c.closed('authentication_failed');
 c=await f.attach((await f.create(h)).data);await c.connected();c.send({type:'ack',bytes:1_000_000});await c.closed('invalid_message');
 c=await f.attach((await f.create(h)).data);await c.connected();c.ws.send(Buffer.from('binary-input'));await c.closed('invalid_message');
 c=await f.attach((await f.create(h)).data);await c.connected();c.send({type:'input',data:'x'.repeat(16385)});await c.closed('invalid_message');
 c=await f.attach((await f.create(h)).data);await c.connected();
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?','2000-01-01T00:00:00Z',h.credentialID);await c.closed('credential_invalid');
 assert.equal(f.db.get<any>('SELECT secret_encrypted FROM effective_machine_credentials WHERE id=?',h.credentialID)?.secret_encrypted,'');
 const replacement=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:ssh.privateKey,retention:'temporary'});assert.equal(replacement.status,201);h.credentialID=replacement.data.credential_id;
 c=await f.attach((await f.create(h)).data);await c.connected();f.db.run("UPDATE users SET role='member' WHERE id='admin'");await c.closed('login_expired');
 f.db.run("UPDATE users SET role='admin' WHERE id='admin'");
 c=await f.attach((await f.create(h)).data);await c.connected();await f.request('/auth/logout','POST',{});await c.closed('login_expired');
 f.db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hash('admin'),'admin',Math.floor(Date.now()/1000)+1000);
 c=await f.attach((await f.create(h)).data);await c.connected();c.send({type:'input',data:'exit\r'});await c.closed('remote_closed');
 c=await f.attach((await f.create(h)).data);await c.connected();await f.terminal.close?.();await c.wait(()=>c.ws.readyState===WebSocket.CLOSED);
 assert.equal(f.db.get<any>("SELECT count(*) n FROM machine_terminal_events WHERE closed_at='' ")?.n,0);
 assert.deepEqual(f.logs,[]);
});

test('real terminal pauses output without ACK and closes idle sessions',{skip:!existsSync('/usr/sbin/sshd'),timeout:15000},async t=>{
 const ssh=await isolatedSSHD(t),f=await fixture(t,{checkMs:50,idleMs:1500}),h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},ssh.privateKey);
 const c=await f.attach((await f.create(h)).data,{ack:false});await c.connected();
 c.send({type:'input',data:"head -c 2000000 /dev/zero | tr '\\0' y\r"});
 await c.wait(()=>c.chunks.reduce((n,b)=>n+b.length,0)>=256*1024);
 await new Promise(r=>setTimeout(r,100));assert.ok(c.chunks.reduce((n,b)=>n+b.length,0)<1024*1024);
 await c.closed('idle_timeout');assert.deepEqual(f.logs,[]);
});


test('global cap and cancelled pending entry release the exclusive host lease',async t=>{
 const f=await fixture(t,{globalLimit:1,userLimit:3}),h=await f.host(),other=await f.host();
 const pending=await f.create(h);assert.equal(pending.status,201);
 assert.equal((await f.create(other,{},'other')).status,429);
 await f.request(`${h.path}/${pending.data.id}`,'DELETE');
 const lease=f.machines.acquireTerminal(h.id,h.credentialID,()=>{});lease.release();
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'deploy'})).status,200);
});

test('real terminal total time limit closes an active connection and allows reconnect',{skip:!existsSync('/usr/sbin/sshd'),timeout:15000},async t=>{
 const ssh=await isolatedSSHD(t),f=await fixture(t,{checkMs:50,maxMs:800,idleMs:10000}),h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},ssh.privateKey);
 const c=await f.attach((await f.create(h)).data);await c.connected();c.send({type:'input',data:'echo active\r'});await c.closed('session_limit');
 assert.equal((await f.create(h)).status,201);
});


test('SSH connection deadline closes a nonresponsive peer without retaining a lock',{skip:!existsSync('/usr/sbin/sshd'),timeout:15000},async t=>{
 const sockets=new Set<any>(),tcp=createTCPServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});
 tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(r=>tcp.close(()=>r()))});
 const ssh=await isolatedSSHD(t),f=await fixture(t,{connectMs:500}),h=await f.host({address:'127.0.0.1',port:(tcp.address() as any).port},ssh.privateKey);
 const c=await f.attach((await f.create(h)).data);await c.closed('connect_timeout');
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'deploy'})).status,200);
 assert.deepEqual(f.logs,[]);
});

test('password terminal uses real SSH password and PTY, then revokes the one-time credential on disconnect',async t=>{
 const ssh=await passwordSSHServer(t),f=await fixture(t,{checkMs:50,idleMs:10_000}),h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},ssh.password,'password');
 const created=await f.create(h,{credential_id:h.credentialID,cols:91,rows:27});assert.equal(created.status,201);
 const c=await f.attach(created.data);await c.connected();await c.wait(()=>c.text().includes('FIXTURE_READY'));
 assert.ok(ssh.authMethods.includes('password'));assert.deepEqual(ssh.ptys,[{cols:91,rows:27,term:'xterm-256color'}]);
 c.send({type:'input',data:'fixture-identify\r'});await c.wait(()=>c.text().includes('FIXTURE_USER=fixture'));
 assert.deepEqual(ssh.commands,['fixture-identify']);
 assert.equal(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',h.credentialID)?.revoked_at,null);
 await f.request(`${h.path}/${created.data.id}`,'DELETE');await c.closed('disconnected');
 const credential=f.db.get<any>('SELECT revoked_at,last_used_at FROM machine_credentials WHERE id=?',h.credentialID);assert.ok(credential.revoked_at&&credential.last_used_at);
 assert.equal((await f.create(h,{credential_id:h.credentialID})).status,409);
 assert.ok(!c.text().includes(ssh.password));assert.ok(!JSON.stringify(f.db.all('SELECT * FROM machine_terminal_events')).includes(ssh.password));assert.deepEqual(f.logs,[]);
});

test('permanent password opens real SSH terminals repeatedly and revocation disconnects the active session',async t=>{
 const ssh=await passwordSSHServer(t),f=await fixture(t,{checkMs:50,idleMs:10_000}),h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},ssh.password,'password');
 await f.request(`/machines/${h.id}/credentials/${h.credentialID}`,'DELETE');
 const saved=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:ssh.password,retention:'permanent',confirm_permanent:true});assert.equal(saved.status,201);h.credentialID=saved.data.credential_id;
 const created=await f.create(h);assert.equal(created.status,201);let c=await f.attach(created.data);await c.connected();
 c.send({type:'input',data:'fixture-identify\r'});await c.wait(()=>c.text().includes('FIXTURE_USER=fixture'));
 await f.request(`${h.path}/${created.data.id}`,'DELETE');await c.closed('disconnected');await c.wait(()=>c.ws.readyState===WebSocket.CLOSED);
 const retained=f.db.get<any>('SELECT * FROM effective_machine_credentials WHERE id=?',h.credentialID);assert.equal(retained.expires_at,'');assert.equal(retained.revoked_at,null);assert.notEqual(retained.secret_encrypted,'');assert.equal(retained.secret_cleared_at,'');
 const reopened=await f.create(h);assert.equal(reopened.status,201);c=await f.attach(reopened.data);await c.connected();
 await f.request(`/machines/${h.id}/credentials/${h.credentialID}`,'DELETE');await c.closed('credential_invalid');await c.wait(()=>c.ws.readyState===WebSocket.CLOSED);
 assert.equal(f.db.get<any>('SELECT secret_encrypted FROM effective_machine_credentials WHERE id=?',h.credentialID)?.secret_encrypted,'');assert.equal((await f.create(h)).status,409);
 assert.ok(!c.text().includes(ssh.password));assert.ok(!JSON.stringify(f.db.all('SELECT * FROM machine_terminal_events')).includes(ssh.password));assert.deepEqual(f.logs,[]);
});

test('password terminal rejects wrong password and pin, and expires or revokes an active session',async t=>{
 const ssh=await passwordSSHServer(t),f=await fixture(t,{checkMs:50,idleMs:10_000});
 const target={address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin};
 const wrong=await f.host(target,'incorrect-fixture-password','password');
 let c=await f.attach((await f.create(wrong)).data);await c.closed('authentication_failed');
 assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',wrong.credentialID)?.revoked_at);
 const unpinned=await f.host({...target,host_key_fingerprint:'SHA256:wrongconfirmedfingerprint'},ssh.password,'password');
 c=await f.attach((await f.create(unpinned)).data);await c.closed('host_key_mismatch');
 assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',unpinned.credentialID)?.revoked_at);
 const expired=await f.host(target,ssh.password,'password');c=await f.attach((await f.create(expired)).data);await c.connected();
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?','2000-01-01T00:00:00Z',expired.credentialID);await c.closed('credential_invalid');
 assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',expired.credentialID)?.revoked_at);
 const revoked=await f.host(target,ssh.password,'password');c=await f.attach((await f.create(revoked)).data);await c.connected();
 await f.request(`/machines/${revoked.id}/credentials/${revoked.credentialID}`,'DELETE');await c.closed('credential_invalid');
 assert.equal((await f.create(revoked)).status,409);assert.deepEqual(ssh.commands,[]);assert.deepEqual(f.logs,[]);
});

test('pending password terminal cancellation and entry timeout revoke credentials and clear plaintext leases',async t=>{
 const f=await fixture(t,{pendingMs:100,checkMs:50});
 const cancelled=await f.host({},'temporary-fixture-password','password');
 const entry=await f.create(cancelled);assert.equal(entry.status,201);
 await f.request(`${cancelled.path}/${entry.data.id}`,'DELETE');
 assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',cancelled.credentialID)?.revoked_at);
 const expired=await f.host({},'temporary-fixture-password','password');const pending=await f.create(expired);assert.equal(pending.status,201);
 await new Promise(resolve=>setTimeout(resolve,150));assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',expired.credentialID)?.revoked_at);
 assert.equal(await f.rejected(pending.data),404);
 const direct=await f.host({},'temporary-fixture-password','password');const lease=f.machines.acquireTerminal(direct.id,direct.credentialID,()=>{});
 assert.equal(lease.privateKey,'');assert.equal(lease.password,'temporary-fixture-password');assert.equal(lease.valid(),true);lease.release();
 assert.equal(lease.privateKey,'');assert.equal(lease.password,'');assert.equal(lease.valid(),false);
 assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',direct.credentialID)?.revoked_at);assert.deepEqual(f.logs,[]);
});

test('SSH password whitespace survives encrypted storage and authenticates without rewriting',async t=>{
 const original='  fixture-password-with-spaces \t',ssh=await passwordSSHServer(t,{password:original}),f=await fixture(t,{checkMs:50});
 const h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:ssh.pin},original,'password');
 const saved=f.db.get<any>('SELECT secret_encrypted FROM effective_machine_credentials WHERE id=?',h.credentialID);
 assert.ok(saved.secret_encrypted);assert.ok(!saved.secret_encrypted.includes(original));
 assert.equal(JSON.parse(f.decrypt(saved.secret_encrypted)).secret,original);
 const c=await f.attach((await f.create(h,{credential_id:h.credentialID})).data);await c.connected();
 c.send({type:'input',data:'fixture-identify\r'});await c.wait(()=>c.text().includes('FIXTURE_USER=fixture'));
 c.send({type:'input',data:'fixture-exit\r'});await c.closed('remote_closed');
 assert.ok(f.db.get<any>('SELECT revoked_at FROM machine_credentials WHERE id=?',h.credentialID)?.revoked_at);
 assert.ok(!c.text().includes(original));assert.deepEqual(f.logs,[]);
});

test('terminal first connection records the server key automatically and remains valid across reconnects',async t=>{
 const ssh=await passwordSSHServer(t),f=await fixture(t,{checkMs:30,idleMs:10_000});
 const h=await f.host({address:ssh.address,port:ssh.port,username:ssh.username,host_key_fingerprint:''},ssh.password,'password');
 const reusable=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:ssh.password,retention:'managed',confirm_managed:true});assert.equal(reusable.status,201);
 assert.equal(f.machines.get(h.id).host_key_fingerprint,'');assert.equal(f.machines.get(h.id).capabilities.terminal.available,true);
 for(let index=0;index<2;index++){
  const entry=await f.create(h,{credential_id:reusable.data.credential_id});assert.equal(entry.status,201);
  const c=await f.attach(entry.data);await c.connected();c.send({type:'input',data:'fixture-identify\n'});await c.wait(()=>c.text().includes('FIXTURE_HOST=loopback'));
  const current=f.machines.get(h.id);assert.equal(current.host_key_fingerprint,ssh.pin);assert.match(current.host_key_public_key,/^ssh-rsa [A-Za-z0-9+/]+=*$/);assert.equal(current.host_key_status,'observed');
  await f.request(`${h.path}/${entry.data.id}`,'DELETE');await c.closed();await c.wait(()=>c.ws.readyState===WebSocket.CLOSED);
 }
 assert.equal(f.db.all('SELECT id FROM machine_terminal_events WHERE connected_at!=\'\'').length,2);
});
