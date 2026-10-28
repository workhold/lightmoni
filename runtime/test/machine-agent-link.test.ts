import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DB} from '../src/shared/sqlite.js';
import {Router,fail} from '../src/shared/http.js';
import {cipher} from '../src/shared/crypto.js';
import {registerManagedMachines,type SSHRunner} from '../src/server/managed-machines.js';
import {agentProbeCommand} from '../src/server/machine-agent-lifecycle.js';
import {SSHError} from '../src/server/machine-ssh.js';
import type {Dependencies} from '../src/shared/types.js';

const at=new Date('2026-10-28T00:00:00Z');
const probe='LMAGENT=1\nagent_id=node-one\ninstallation=present\nprogram_complete=1\nservice_running=1\noperation_lock=0\nlifecycle_locked=0\nunit_managed=1\ndata_retained=1\n';
const secret='-----BEGIN OPENSSH PRIVATE KEY-----\nlink-test-secret\n-----END OPENSSH PRIVATE KEY-----';
async function fixture(t:any,runner:SSHRunner=async()=>({stdout:probe,stderr:'',stages:[]})){
 const db=new DB(':memory:'),router=new Router(),user={id:'admin',name:'Admin',role:'admin'};
 db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '');
 CREATE TABLE agent_credentials(id TEXT PRIMARY KEY,agent_id TEXT,audience TEXT,revoked_at TEXT,expires_at TEXT);
 CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT);`);
 db.run('INSERT INTO agents(id,last_seen) VALUES(?,?)','node-one',at.toISOString());
 for(const audience of ['control','data'])db.run('INSERT INTO agent_credentials VALUES(?,?,?,?,?)',audience,'node-one',audience,null,'2027-01-01T00:00:00.000Z');
 const errors:unknown[]=[];let calls=0,sshInput:any,clock=at;
 const deps={db,router,...cipher(Buffer.alloc(32,7)),now:()=>clock,auth:{user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user.role!=='admin')fail(403,'administrator required')}},externalURL:'https://monitor.example.test',logger:{error:(e:unknown)=>errors.push(e),info(){},warn(){}}} as unknown as Dependencies;
 router.auth=deps.auth;
 const machines=registerManagedMachines(deps,{sshRunner:async input=>{calls++;sshInput=input;return runner(input)}});
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end()}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{machines.close?.();server.close();db.close()});
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/v1`;
 const request=async(path:string,method='GET',body?:any)=>{const res=await fetch(url+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const raw=await res.text();return {status:res.status,raw,data:JSON.parse(raw)}};
 const host=async(name='host-one')=>{
  const made=await request('/machines','POST',{name,address:name+'.example.test',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});
  assert.equal(made.status,201,made.raw);
  const key=await request(`/machines/${made.data.id}/credentials`,'POST',{method:'ssh_key',secret});assert.equal(key.status,201,key.raw);
  return {id:made.data.id,credential:key.data.credential_id};
 };
 const link=(h:{id:string;credential:string},extra={})=>request(`/machines/${h.id}/agent-link`,'POST',{agent_id:'node-one',credential_id:h.credential,...extra});
 return {db,user,request,host,link,errors,advance:(milliseconds:number)=>clock=new Date(at.getTime()+milliseconds),get calls(){return calls},get sshInput(){return sshInput}};
}

test('SSH identity verification links the exact independent node and records a secret-free audit',async t=>{
 const f=await fixture(t),h=await f.host(),result=await f.link(h);
 assert.equal(result.status,200,result.raw);assert.equal(result.data.agent_id,'node-one');assert.equal(result.data.agent_status,'online');
 assert.equal(f.sshInput.command,agentProbeCommand());assert.equal(f.sshInput.privateKey,secret);assert.equal(f.sshInput.enrollmentToken,undefined);
 assert.ok(!result.raw.includes('PRIVATE KEY'));
 assert.deepEqual(f.db.all<any>('SELECT machine_id,agent_id,credential_id,actor_id FROM machine_agent_link_events'),[{machine_id:h.id,agent_id:'node-one',credential_id:h.credential,actor_id:'admin'}]);
 assert.equal(f.db.get<any>('SELECT last_used_at FROM machine_credentials WHERE id=?',h.credential)?.last_used_at,at.toISOString());
 f.db.run("INSERT INTO agent_lifecycle(agent_id,state,removed_at) VALUES('node-one','removed',?)",at.toISOString());
 assert.equal((await f.request(`/machines/${h.id}`)).data.machine.agent_status,'removed');
});

test('identity link rejects members, injected commands, passwords, unpinned or legacy nodes without SSH',async t=>{
 const f=await fixture(t),h=await f.host();f.user.role='member';assert.equal((await f.link(h)).status,403);f.user.role='admin';
 assert.equal((await f.link(h,{command:'id'})).status,400);
 await f.request(`/machines/${h.id}`,'PUT',{host_key_fingerprint:''});assert.equal((await f.link(h)).status,400);
 await f.request(`/machines/${h.id}`,'PUT',{host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 const password=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:'one-time-test'});
 assert.equal((await f.link(h,{credential_id:password.data.credential_id})).status,400);
 f.db.run("DELETE FROM agent_credentials WHERE audience='data'");assert.equal((await f.link(h)).status,409);assert.equal(f.calls,0);
});

test('remote identity or incomplete/locked installation cannot create a link',async t=>{
 for(const output of [probe.replace('node-one','other-node'),probe.replace('program_complete=1','program_complete=0'),probe.replace('unit_managed=1','unit_managed=0'),probe.replace('operation_lock=0','operation_lock=1'),probe.replace('lifecycle_locked=0','lifecycle_locked=1'),probe.replace('data_retained=1','data_retained=0')]){
  const f=await fixture(t,async()=>({stdout:output,stderr:'',stages:[]})),h=await f.host(),result=await f.link(h);
  assert.equal(result.status,409,result.raw);assert.equal(f.db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',h.id)?.agent_id,'');assert.equal(f.db.all('SELECT * FROM machine_agent_link_events').length,0);
 }
});

test('pending jobs, installation/uninstallation and duplicate associations block verification',async t=>{
 const f=await fixture(t),h=await f.host(),other=await f.host('other-host');
 for(const state of ['queued','leased','accepted','preflighting','staging','activating','verifying','unknown']){
  f.db.run('INSERT INTO agent_jobs VALUES(?,?,?)','job','node-one',state);assert.equal((await f.link(h)).status,409);f.db.run('DELETE FROM agent_jobs');
 }
 f.db.run("INSERT INTO machine_deployments(id,machine_id,credential_id,status,version,arch,initial_label_id,plan_json,created_at,created_by) VALUES('plan',?,?,'awaiting_approval','0.1.0','amd64','','{}',?,'admin')",h.id,h.credential,at.toISOString());
 assert.equal((await f.link(h)).status,409);f.db.run('DELETE FROM machine_deployments');
 f.db.run("INSERT INTO machine_uninstallations(id,machine_id,agent_id,credential_id,status,plan_json,created_at,created_by) VALUES('uninstall',?,'node-one',?,'unknown','{}',?,'admin')",h.id,h.credential,at.toISOString());
 assert.equal((await f.link(h)).status,409);f.db.run('DELETE FROM machine_uninstallations');
 f.db.run("UPDATE managed_machines SET agent_id='node-one' WHERE id=?",other.id);assert.equal((await f.link(h)).status,409);assert.equal(f.calls,0);
});

test('verification holds the machine lane and rechecks revoked credentials, changed target and removed node',async t=>{
 for(const mutate of ['credential','target','node','job']){
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
  const f=await fixture(t,async()=>{started();await gate;return {stdout:probe,stderr:'',stages:[]}}),h=await f.host();
  const pending=f.link(h);await entered;
  assert.equal((await f.request(`/machines/${h.id}`,'PUT',{address:'changed.example.test'})).status,409);
  assert.equal((await f.request(`/machines/${h.id}`,'DELETE')).status,409);assert.equal((await f.link(h)).status,409);
  if(mutate==='credential')await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE');
  if(mutate==='target')f.db.run("UPDATE managed_machines SET address='external-change.example.test' WHERE id=?",h.id);
  if(mutate==='node')f.db.run("INSERT INTO agent_lifecycle(agent_id,state,removed_at) VALUES('node-one','removed',?)",at.toISOString());
  if(mutate==='job')f.db.run("INSERT INTO agent_jobs VALUES('new-job','node-one','queued')");
  release();const result=await pending;assert.equal(result.status,409,result.raw);assert.equal(f.db.all('SELECT * FROM machine_agent_link_events').length,0);
 }
});

test('concurrent two-host probes cannot bind the same node twice',async t=>{
 let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r),both=new Promise<void>(r=>entered=r);
 const f=await fixture(t,async()=>{if(++calls===2)entered();await gate;return {stdout:probe,stderr:'',stages:[]}}),a=await f.host('one'),b=await f.host('two');
 const first=f.link(a),second=f.link(b);await both;release();const results=await Promise.all([first,second]);assert.deepEqual(results.map(v=>v.status).sort(),[200,409]);assert.equal(f.db.all("SELECT id FROM managed_machines WHERE agent_id='node-one'").length,1);
});

test('credential expiry while probing returns a conflict after cleanup without a nested transaction',async t=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
 const f=await fixture(t,async()=>{started();await gate;return {stdout:probe,stderr:'',stages:[]}}),h=await f.host();
 const pending=f.link(h);await entered;f.advance(25*60*60*1000);release();const result=await pending;
 assert.equal(result.status,409,result.raw);assert.deepEqual(f.errors,[]);assert.equal(f.db.all('SELECT * FROM machine_agent_link_events').length,0);
 assert.equal(f.db.get<any>('SELECT secret_encrypted FROM machine_credentials WHERE id=?',h.credential)?.secret_encrypted,'');
});

test('SSH errors return fixed safe responses and never log or return raw secrets',async t=>{
 for(const error of [new Error(secret),new SSHError('timed_out'),new SSHError('host_key_mismatch')]){
  const f=await fixture(t,async()=>{throw error}),h=await f.host(),result=await f.link(h);
  assert.equal(result.status,502,result.raw);assert.ok(!result.raw.includes(secret));assert.deepEqual(f.errors,[]);assert.equal(f.db.all('SELECT * FROM machine_agent_link_events').length,0);
 }
});
