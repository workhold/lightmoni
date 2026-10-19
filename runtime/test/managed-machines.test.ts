import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DB} from '../src/shared/sqlite.js';
import {Router,fail} from '../src/shared/http.js';
import {cipher} from '../src/shared/crypto.js';
import {parseJSON} from '../src/shared/json.js';
import {registerManagedMachines, type SSHRunner} from '../src/server/managed-machines.js';
import {monitoringTools} from '../src/assistant/tools.js';
import {SSHError} from '../src/server/machine-ssh.js';
import type {Dependencies} from '../src/shared/types.js';

const checkOutput='LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\ninstall_privilege=1\nplatform_https=1\n';
const master=Buffer.alloc(32,9), now=new Date('2026-10-19T00:00:00.000Z');
async function fixture(t:any,overrides:Partial<Dependencies>={},sshRunnerOverride?:SSHRunner){
 const db=new DB(':memory:'), router=new Router(), encryption=cipher(master), user={id:'admin',name:'Admin',role:'admin'};
 // managed-machines joins the node registry to derive the linked Agent status.
 // Keep this fixture self-contained instead of relying on the full app
 // bootstrap, which registers the nodes module before managed machines.
 db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
 let issued:any;
 const agentCredentials={
  has:()=>true,
  authenticate:()=>({credential_id:'c',agent_id:'a',audience:'control',scope:'agent.control',expires_at:'',last_used_at:''}),
  canDownloadWithEnrollmentToken:()=>true,
  issueEnrollment:(input:any)=>{issued={...input,enrollment_id:'enroll-1',token_display_once:'lm_enroll_secret',token_expires_at:new Date(now.getTime()+900000).toISOString(),install_command_hint:''};return issued;},
  enrollmentStatus:()=>({status:'active',agent_id:'agent-1',used_at:now.toISOString()}),
  cancelEnrollment:(enrollmentID:string)=>{issued.cancelled=enrollmentID},
 } as any;
 let sshInput:any;
 const sshRunner:SSHRunner=async(input)=>{sshInput=input;return {stdout:input.enrollmentToken?`ok ${input.enrollmentToken} ${input.privateKey}`:checkOutput,stderr:`warning ${input.privateKey}`,stages:['checking_host_key','remote_command_completed']}};
 const deps={db,router,...encryption,now:()=>now,auth:{master,user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user.role!=='admin')fail(403,'administrator required')},validateKey:()=>{throw Error('unused')}},externalURL:'https://monitor.example.com',logger:{info(){},warn(){},error(){}},cat:{list:async()=>[]},query:async()=>({request_id:'',results:[]}),referencedTables:async()=>[],ch:{exec:async()=>{},query:async()=>({meta:[],data:[],rows:0}),insert:async()=>{}},reader:{exec:async()=>{},query:async()=>({meta:[],data:[],rows:0}),insert:async()=>{}},...overrides} as unknown as Dependencies;
 router.auth=deps.auth;
 const machines=registerManagedMachines(deps,{agentCredentials,sshRunner:sshRunnerOverride??sshRunner});
 const server=createServer(async(req,res)=>{if(!(await router.handle(req,res))){res.writeHead(404);res.end()}});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(()=>{server.close();db.close()});
 const request=async(path:string,method='GET',body?:any)=>{const response=await fetch(url+'/api/v1'+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const raw=await response.text();return {status:response.status,raw,data:parseJSON(raw)};};
 return {db,request,machines,user,deps,get issued(){return issued},get sshInput(){return sshInput}};
}

test('managed machines validate host input and never return credential secrets',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/machines','POST',{name:'bad',address:'http://evil',username:'root'})).status,400);
 const created=await f.request('/machines','POST',{name:'prod-1',address:'10.0.0.12',port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 assert.equal(created.status,201,created.raw);const machine=created.data;
 const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';
 const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 assert.equal(credential.status,201,credential.raw);assert.ok(!credential.raw.includes('PRIVATE KEY'));assert.ok(credential.data.secret_fingerprint);assert.equal(credential.data.retention,'managed');
 const detail=await f.request(`/machines/${machine.id}`);assert.equal(detail.status,200);assert.ok(!detail.raw.includes('PRIVATE KEY'));assert.equal(detail.data.credentials.length,1);
 const assistant=f.machines.assistantGet(machine.id);assert.equal(assistant.host_key_fingerprint,'');
});

test('password credentials are short lived and cannot start automatic deployment',async t=>{
 const f=await fixture(t);const created=await f.request('/machines','POST',{name:'prod-2',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});const machine=created.data;
 const password=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'password',secret:'temporary-password'});assert.equal(password.status,201);assert.equal(password.data.retention,'one_time');assert.match(password.data.warning,/不要长期保存/);
 const plan=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:password.data.credential_id});assert.equal(plan.status,400);assert.match(plan.raw,/密码/);
});

test('manual script credentials cannot be mistaken for automatic SSH deployment',async t=>{
 const f=await fixture(t);const created=await f.request('/machines','POST',{name:'prod-script',address:'host.example.com',username:'deploy',connection_method:'manual_script'});assert.equal(created.status,201,created.raw);const machine=created.data;
 const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'manual_script'});assert.equal(credential.status,201,credential.raw);
 const plan=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:credential.data.credential_id});assert.equal(plan.status,400);assert.match(plan.raw,/手动脚本/);
});

test('credential decryption failure closes a deployment as failed',async t=>{
 let corrupt=false;const f=await fixture(t,{decrypt:value=>{if(corrupt)throw Error('corrupt credential envelope');return cipher(master).decrypt(value)}});const created=await f.request('/machines','POST',{name:'prod-broken',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});assert.equal(created.status,201,created.raw);const machine=created.data;const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 const checked=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:credential.data.credential_id});assert.equal(checked.data.ready,true,checked.raw);const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,201,plan.raw);
 corrupt=true;const applied=await f.request(`/machines/${machine.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,502,applied.raw);assert.equal(f.machines.assistantDeployment(plan.data.id).status,'failed');
});

test('failed SSH deployment cancels the one-time enrollment token',async t=>{
 const f=await fixture(t,{},async input=>{if(input.enrollmentToken)throw Error('ssh unavailable');return {stdout:checkOutput,stderr:'',stages:[]}});const created=await f.request('/machines','POST',{name:'prod-ssh-fail',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});assert.equal(created.status,201,created.raw);const machine=created.data;const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 const checked=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:credential.data.credential_id});assert.equal(checked.data.ready,true,checked.raw);const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,201,plan.raw);
 const applied=await f.request(`/machines/${machine.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,502,applied.raw);assert.equal(f.issued.cancelled,'enroll-1');
});

test('deployment plan requires host pinning and apply keeps tokens out of command/output',async t=>{
 const f=await fixture(t);const created=await f.request('/machines','POST',{name:'prod-3',address:'host.example.com',username:'deploy',connection_method:'direct_ssh'});const machine=created.data;const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 const unpinned=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:credential.data.credential_id});assert.equal(unpinned.status,400);assert.match(unpinned.raw,/指纹/);
 await f.request(`/machines/${machine.id}`,'PUT',{host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 const checked=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:credential.data.credential_id});assert.equal(checked.data.ready,true,checked.raw);const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,201,plan.raw);assert.equal(plan.data.status,'awaiting_approval');assert.match(plan.raw,/密码建议只使用一次/);
 const applied=await f.request(`/machines/${machine.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,200,applied.raw);assert.equal(applied.data.status,'succeeded');assert.equal(f.issued.token_display_once,'lm_enroll_secret');assert.ok(!f.sshInput.command.includes(f.issued.token_display_once));assert.equal(f.sshInput.enrollmentToken,f.issued.token_display_once);assert.ok(!applied.raw.includes(f.issued.token_display_once));assert.ok(!applied.raw.includes('PRIVATE KEY'));assert.equal(applied.data.receipt.agent_id,'agent-1');
 const assistantReceipt=f.machines.assistantDeployment(plan.data.id);assert.equal(assistantReceipt.status,'succeeded');assert.equal((assistantReceipt.receipt as any).stdout,undefined);assert.equal((assistantReceipt.receipt as any).stderr,undefined);
 const machineAfter=f.machines.get(machine.id);assert.equal(machineAfter.agent_id,'agent-1');assert.equal(machineAfter.agent_status,'online');
});

async function host(f:Awaited<ReturnType<typeof fixture>>,name='fixture'){
 const created=await f.request('/machines','POST',{name,address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 assert.equal(created.status,201,created.raw);
 const key='-----BEGIN OPENSSH PRIVATE KEY-----\nunique-fixture-secret\n-----END OPENSSH PRIVATE KEY-----';
 const credential=await f.request(`/machines/${created.data.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 assert.equal(credential.status,201,credential.raw);
 return {id:created.data.id,credential:credential.data.credential_id,key};
}

test('AI preflight really calls SSH, saves an auditable result and creates the exact reviewable plan',async t=>{
 const f=await fixture(t),h=await host(f),tools=monitoringTools(f.deps,{machines:f.machines});
 const execute=(name:string,input:any,user=f.user)=>tools.find(tool=>tool.name===name)!.execute(input,new AbortController().signal,user);
 const metadata:any=await execute('get_managed_machine',{machine_id:h.id});
 assert.deepEqual(metadata.ssh_credentials.map((c:any)=>c.id),[h.credential]);
 assert.equal(metadata.host_key_fingerprint,'');assert.ok(!JSON.stringify(metadata).includes(h.key));
 const checked:any=await execute('check_managed_machine_ssh',{machine_id:h.id});
 assert.equal(checked.ready,true);assert.equal(checked.connected,true);assert.equal(f.sshInput.privateKey,h.key);
 assert.equal(f.sshInput.enrollmentToken,undefined);assert.equal(f.issued,undefined);
 assert.equal(f.sshInput.timeoutMs,60_000);assert.match(f.sshInput.command,/systemctl/);
 const proposed:any=await execute('propose_agent_install',{machine_id:h.id,check_id:checked.id,version:'0.1.0',arch:checked.arch});
 assert.equal(proposed.status,'awaiting_approval');assert.equal(proposed.plan.preflight.id,checked.id);
 assert.equal(proposed.review_url,`/machines?machine=${h.id}&deployment=${proposed.id}`);
 assert.equal(f.db.get<any>('SELECT created_by FROM machine_deployments WHERE id=?',proposed.id)?.created_by,'admin');
 const review=await f.request(`/machines/${h.id}/deployments/${proposed.id}`);assert.equal(review.data.id,proposed.id);
 assert.equal(review.data.status,'awaiting_approval');assert.equal(f.issued,undefined);
 for(const value of [checked,proposed,f.db.all('SELECT * FROM machine_ssh_checks')]){
  const serialized=JSON.stringify(value);assert.ok(!serialized.includes(h.key));assert.ok(!serialized.includes('SHA256:abcdefghijklmnop'));assert.ok(!serialized.includes('"stderr"'));assert.ok(!serialized.includes('"stdout"'));
 }
});

test('SSH tools and HTTP reject members and arbitrary host/command/secret parameters',async t=>{
 const f=await fixture(t),h=await host(f),tools=monitoringTools(f.deps,{machines:f.machines});
 for(const name of ['check_managed_machine_ssh','propose_agent_install','get_managed_machine','list_managed_machines']){
  const tool=tools.find(tool=>tool.name===name)!;
  await assert.rejects(()=>tool.execute({machine_id:h.id},new AbortController().signal,{...f.user,role:'member'}),/administrator/);
 }
 const tool=tools.find(tool=>tool.name==='check_managed_machine_ssh')!;
 await assert.rejects(()=>tool.execute({machine_id:h.id,command:'rm -rf /'},new AbortController().signal,f.user),/unexpected|unknown|invalid/);
 for(const input of [{command:'id'},{address:'evil.example'},{private_key:h.key}])assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',input)).status,400);
 assert.equal(f.sshInput,undefined);
 f.user.role='member';assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{})).status,403);
});

test('SSH login success with missing prerequisites is not an installable host; raw output is never returned',async t=>{
 const f=await fixture(t,{},async()=>({stdout:checkOutput.replace('systemd=1','systemd=0'),stderr:'private raw stderr',stages:[]})),h=await host(f);
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});
 assert.equal(checked.status,200);assert.equal(checked.data.connected,true);assert.equal(checked.data.ready,false);assert.equal(checked.data.checks.systemd,false);assert.equal(checked.data.error_code,'prerequisites_missing');assert.ok(!checked.raw.includes('private raw stderr'));
 assert.equal((await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:checked.data.id,version:'0.1.0',arch:'amd64'})).status,409);
});

test('preflight errors and malformed host output return fixed codes without leaking secrets',async t=>{
 for(const scenario of ['host_key_mismatch','timed_out','raw-error','malformed']){
  const f=await fixture(t,{},async()=>{
   if(scenario==='raw-error')throw Error('-----BEGIN PRIVATE KEY----- raw-password');
   if(scenario==='malformed')return {stdout:checkOutput+'password=secret\n',stderr:'',stages:[]};
   throw new SSHError(scenario as 'host_key_mismatch'|'timed_out');
  }),h=await host(f,scenario);
  const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});
  assert.equal(checked.status,200);assert.equal(checked.data.ready,false);
  assert.equal(checked.data.error_code,scenario==='raw-error'?'ssh_failed':scenario==='malformed'?'invalid_response':scenario);
  assert.ok(!checked.raw.includes('PRIVATE KEY'));assert.ok(!checked.raw.includes('password'));assert.ok(!checked.raw.includes('stdout'));
 }
});

test('multiple, revoked, expired, cross-host and unsupported SSH credentials never connect',async t=>{
 const f=await fixture(t),h=await host(f),other=await host(f,'other');
 const second=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key});
 assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{})).status,409);
 assert.equal((await f.request(`/machines/${other.id}/ssh-check`,'POST',{credential_id:h.credential})).status,404);
 await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE');
 assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:h.credential})).status,409);
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?',now.toISOString(),second.data.credential_id);
 assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:second.data.credential_id})).status,409);
 await f.request(`/machines/${other.id}`,'PUT',{connection_method:'bastion'});
 assert.equal((await f.request(`/machines/${other.id}/ssh-check`,'POST',{})).status,400);
 assert.equal(f.sshInput,undefined);
});

test('checks and plans bind target, architecture, credential and expiry before enrollment issuance',async t=>{
 let clock=now;const f=await fixture(t,{now:()=>clock}),h=await host(f);
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});
 const input={check_id:checked.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'};
 assert.equal((await f.request(`/machines/${h.id}/deployments/plan`,'POST',{...input,arch:'arm64'})).status,409);
 const other=await host(f,'other');assert.equal((await f.request(`/machines/${other.id}/deployments/plan`,'POST',input)).status,404);
 const plan=await f.request(`/machines/${h.id}/deployments/plan`,'POST',input);assert.equal(plan.status,201,plan.raw);
 assert.equal((await f.request(`/machines/${h.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true,command:'arbitrary command'})).status,400);
 assert.equal((await f.request(`/machines/${h.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:false})).status,400);
 await f.request(`/machines/${h.id}`,'PUT',{username:'different-user'});
 assert.equal((await f.request(`/machines/${h.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true})).status,409);
 assert.equal((await f.request(`/machines/${h.id}/deployments/plan`,'POST',input)).status,409);
 await f.request(`/machines/${h.id}`,'PUT',{username:'deploy'});
 clock=new Date(now.getTime()+900_000);
 assert.equal((await f.request(`/machines/${h.id}/deployments/plan`,'POST',input)).status,409);
 assert.equal((await f.request(`/machines/${h.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true})).status,409);
 assert.equal(f.machines.assistantDeployment(plan.data.id).status,'cancelled');
 assert.equal(f.issued,undefined);
});

test('in-flight check is exclusive per host and cancellation releases its lock',async t=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
 const f=await fixture(t,{},async input=>{entered();await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(new SSHError('cancelled')),{once:true}));throw Error('unreachable')}),h=await host(f);
 const controller=new AbortController();const pending=f.machines.checkSSH(h.id,{},f.user.id,controller.signal);await started;
 assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{})).status,409);
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'different'})).status,409);
 assert.equal((await f.request(`/machines/${h.id}`,'DELETE')).status,409);
 assert.equal((await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE')).status,409);
 controller.abort();assert.equal((await pending).error_code,'cancelled');
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'deploy'})).status,200);
});
