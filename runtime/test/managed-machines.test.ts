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

const checkOutput='LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n';
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
 t.after(()=>{machines.close?.();server.close();db.close()});
 const request=async(path:string,method='GET',body?:any)=>{const response=await fetch(url+'/api/v1'+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const raw=await response.text();return {status:response.status,raw,data:parseJSON(raw)};};
 return {db,request,machines,user,deps,agentCredentials,get issued(){return issued},get sshInput(){return sshInput}};
}

test('managed machines validate host input and never return credential secrets',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/machines','POST',{name:'bad',address:'http://evil',username:'root'})).status,400);
 const created=await f.request('/machines','POST',{name:'prod-1',address:'10.0.0.12',port:22,username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 assert.equal(created.status,201,created.raw);const machine=created.data;
 const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';
 const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 assert.equal(credential.status,201,credential.raw);assert.ok(!credential.raw.includes('PRIVATE KEY'));assert.ok(credential.data.secret_fingerprint);assert.equal(credential.data.retention,'temporary');
 const detail=await f.request(`/machines/${machine.id}`);assert.equal(detail.status,200);assert.ok(!detail.raw.includes('PRIVATE KEY'));assert.equal(detail.data.credentials.length,1);
 const assistant=f.machines.assistantGet(machine.id);assert.equal(assistant.host_key_fingerprint,'');
});

test('password credentials can run one fixed SSH check once, then are revoked and cannot deploy',async t=>{
 let sshInput:any;
 const f=await fixture(t,{},async input=>{sshInput=input;return {stdout:checkOutput,stderr:'',stages:['checking_host_key','remote_command_completed']}});
 const created=await f.request('/machines','POST',{name:'prod-2',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});const machine=created.data;
 const password=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'password',secret:'temporary-password'});assert.equal(password.status,201);assert.equal(password.data.retention,'one_time');assert.match(password.data.warning,/不要长期保存/);
 const checked=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:password.data.credential_id});assert.equal(checked.status,200,checked.raw);assert.equal(checked.data.connected,true);assert.equal(checked.data.ready,true);assert.equal(sshInput.password,'temporary-password');assert.equal(sshInput.privateKey,'');
 const detail=await f.request(`/machines/${machine.id}`);assert.equal(detail.data.credentials[0].revoked_at!==null,true);assert.equal(detail.data.credentials[0].last_used_at!==null,true);
 const reused=await f.request(`/machines/${machine.id}/ssh-check`,'POST',{credential_id:password.data.credential_id});assert.equal(reused.status,409);assert.match(reused.raw,/撤销/);
 const deployment=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:password.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(deployment.status,409);assert.match(deployment.raw,/撤销|凭据/);
});

test('password credential preserves intentional leading/trailing whitespace during SSH check',async t=>{
 let received='';const f=await fixture(t,{},async input=>{received=input.password??'';return {stdout:checkOutput,stderr:'',stages:[]}});
 const created=await f.request('/machines','POST',{name:'password-space',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 const original='  password with spaces \t';const password=await f.request(`/machines/${created.data.id}/credentials`,'POST',{method:'password',secret:original});assert.equal(password.status,201);
 const checked=await f.request(`/machines/${created.data.id}/ssh-check`,'POST',{credential_id:password.data.credential_id});assert.equal(checked.status,200,checked.raw);assert.equal(received,original);
});

test('host deletion requires credentials and pending deployments to be cleared first',async t=>{
 const f=await fixture(t),h=await host(f,'delete-guard');
 const blockedByCredential=await f.request(`/machines/${h.id}`,'DELETE');
 assert.equal(blockedByCredential.status,409,blockedByCredential.raw);assert.match(blockedByCredential.raw,/撤销|有效连接凭据/);
 await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE');
 const deleted=await f.request(`/machines/${h.id}`,'DELETE');
 assert.equal(deleted.status,200,deleted.raw);assert.deepEqual(deleted.data,{ok:true});
 assert.equal((await f.request(`/machines/${h.id}`)).status,404);
 assert.equal(f.db.get(`SELECT id FROM machine_credentials WHERE machine_id=?`,h.id),undefined);
});

test('revoking a credential cancels its pending plan and permits host deletion',async t=>{
 const f=await fixture(t),h=await host(f,'delete-plan');
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});assert.equal(checked.status,200,checked.raw);
 const plan=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'});
 assert.equal(plan.status,201,plan.raw);assert.equal(plan.data.status,'awaiting_approval');
 await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE');
 assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',plan.data.id)?.status,'cancelled');
 const deleted=await f.request(`/machines/${h.id}`,'DELETE');
 assert.equal(deleted.status,200,deleted.raw);
});

test('cancelled plans are idempotent, block members and permit complete host cleanup',async t=>{
 let clock=now;const f=await fixture(t,{now:()=>clock}),h=await host(f,'delete-cleanup');
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});
 const plan=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'});
 assert.equal(plan.status,201,plan.raw);
 f.user.role='member';
 assert.equal((await f.request(`/machines/${h.id}`,'DELETE')).status,403);
 assert.equal((await f.request(`/machines/${h.id}/deployments/${plan.data.id}/cancel`,'POST',{})).status,403);
 f.user.role='admin';
 clock=new Date(now.getTime()+900_001);
 const cancelled=await f.request(`/machines/${h.id}/deployments/${plan.data.id}/cancel`,'POST',{});
 assert.equal(cancelled.status,200,cancelled.raw);assert.equal(cancelled.data.status,'cancelled');
 const repeated=await f.request(`/machines/${h.id}/deployments/${plan.data.id}/cancel`,'POST',{});
 assert.equal(repeated.status,200,repeated.raw);assert.equal(repeated.data.status,'cancelled');
 await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE');
 const deleted=await f.request(`/machines/${h.id}`,'DELETE');
 assert.equal(deleted.status,200,deleted.raw);
 for(const table of ['managed_machines','machine_credentials','machine_ssh_checks','machine_deployments']){
  const key=table==='managed_machines'?'id':'machine_id';
  assert.equal(f.db.get(`SELECT id FROM ${table} WHERE ${key}=?`,h.id),undefined,table+' should be cleared');
 }
});

test('completed deployment plans cannot be cancelled and an active terminal blocks cancellation',async t=>{
 const f=await fixture(t),h=await host(f,'cancel-guard');
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});
 const plan=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'});
 const lease=f.machines.acquireTerminal(h.id,h.credential,()=>{});
 const busy=await f.request(`/machines/${h.id}/deployments/${plan.data.id}/cancel`,'POST',{});
 assert.equal(busy.status,409,busy.raw);assert.match(busy.raw,/终端|检查|部署正在进行/);
 lease.release();
 const applied=await f.request(`/machines/${h.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,200,applied.raw);
 const completed=await f.request(`/machines/${h.id}/deployments/${plan.data.id}/cancel`,'POST',{});
 assert.equal(completed.status,409,completed.raw);assert.match(completed.raw,/尚未执行/);
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
 assert.equal((await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE')).status,200);
 controller.abort();assert.equal((await pending).error_code,'cancelled');
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{username:'deploy'})).status,200);
});


const credentialRow = (f: Awaited<ReturnType<typeof fixture>>, credentialID: string) => f.db.get<any>('SELECT * FROM machine_credentials WHERE id=?', credentialID)!;
const credentialEvents = (f: Awaited<ReturnType<typeof fixture>>, credentialID: string) => f.db.all<any>('SELECT * FROM machine_credential_events WHERE credential_id=? ORDER BY created_at,id', credentialID);

test('credential policies require explicit managed consent and enforce per-policy TTL limits', async t => {
 const f=await fixture(t), h=await host(f,'retention-policy');
 const original=credentialRow(f,h.credential);
 assert.equal(original.retention,'temporary');assert.equal(original.policy_source,'default');
 assert.equal(Date.parse(original.expires_at)-Date.parse(original.created_at),3_600_000);
 const add=(body:any)=>f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key,...body});
 const temporary=await add({retention:'temporary',expires_in_seconds:60});assert.equal(temporary.status,201,temporary.raw);assert.equal(temporary.data.policy_source,'explicit');
 for(const body of [
  {expires_in_seconds:59},{expires_in_seconds:3601},{expires_in_seconds:7_776_000},
  {retention:'managed'},{retention:'managed',confirm_managed:false},{retention:'managed',confirm_managed:'true'},
  {retention:'managed',confirm_managed:true,expires_in_seconds:31_536_001},
  {retention:'one_time'},{retention:'none'},{retention:'unknown'},{retention:null},{confirm_managed:true},
 ]) assert.equal((await add(body)).status,400,JSON.stringify(body));
 const managed=await add({retention:'managed',confirm_managed:true});assert.equal(managed.status,201,managed.raw);
 const saved=credentialRow(f,managed.data.credential_id);assert.equal(saved.retention,'managed');assert.equal(saved.policy_source,'explicit');assert.equal(Date.parse(saved.expires_at)-Date.parse(saved.created_at),7_776_000_000);
 assert.equal((await add({retention:'managed',confirm_managed:true,expires_in_seconds:31_536_000})).status,201);
 const password=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:'one-time'});assert.equal(password.status,201);assert.equal(password.data.retention,'one_time');assert.equal(password.data.secret_fingerprint,'');assert.equal(credentialRow(f,password.data.credential_id).secret_fingerprint,'');assert.equal(Date.parse(password.data.expires_at)-now.getTime(),900_000);
 for(const body of [{retention:'temporary'},{retention:'managed',confirm_managed:true},{expires_in_seconds:3601}]) assert.equal((await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:'one-time',...body})).status,400);
 const script=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'manual_script'});assert.equal(script.status,201);assert.equal(script.data.retention,'none');assert.equal(credentialRow(f,script.data.credential_id).secret_encrypted,'');
 assert.equal((await f.request(`/machines/${h.id}/credentials`,'POST',{method:'manual_script',secret:'must-not-be-saved'})).status,400);
 assert.equal((await f.request(`/machines/${h.id}/credentials`,'POST',{method:'manual_script',retention:'managed',confirm_managed:true})).status,400);
});

test('revocation clears the envelope idempotently, closes a lease and keeps secret-free metadata', async t => {
 let clock=now;const f=await fixture(t,{now:()=>clock}), h=await host(f,'revoke-clear');
 const other=await host(f,'revoke-other');let invalidated=0;
 const lease=f.machines.acquireTerminal(h.id,h.credential,()=>{invalidated++;lease.release()});
 assert.equal(lease.valid(),true);assert.equal(f.machines.get(h.id).capabilities.terminal.reason,'host_busy');
 f.user.role='member';assert.equal((await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE')).status,403);assert.notEqual(credentialRow(f,h.credential).secret_encrypted,'');
 for(const path of [`/machines/${h.id}`,`/machines/${h.id}/credentials`]) assert.equal((await f.request(path)).status,403);
 f.user.role='admin';assert.equal((await f.request(`/machines/${other.id}/credentials/${h.credential}`,'DELETE')).status,404);
 assert.equal((await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE')).status,200);
 assert.equal(lease.valid(),false);assert.equal(lease.privateKey,'');assert.equal(invalidated,1);
 const cleared=credentialRow(f,h.credential);assert.equal(cleared.secret_encrypted,'');assert.equal(cleared.clear_reason,'revoked');assert.equal(cleared.secret_cleared_at,now.toISOString());
 clock=new Date(now.getTime()+2000);assert.equal((await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE')).status,200);
 assert.equal(credentialRow(f,h.credential).secret_cleared_at,cleared.secret_cleared_at);assert.equal(credentialEvents(f,h.credential).filter(e=>e.event==='revoked').length,1);
 const exposed=(await f.request(`/machines/${h.id}`)).raw+JSON.stringify(credentialEvents(f,h.credential))+JSON.stringify(f.machines.assistantGet(h.id));
 assert.ok(!exposed.includes(h.key));assert.ok(!exposed.includes('secret_encrypted'));assert.ok(!JSON.stringify(credentialEvents(f,h.credential)).includes('secret_fingerprint'));
 assert.equal(credentialEvents(f,h.credential).find(e=>e.event==='revoked')?.actor_id,'admin');
});

test('timer clears expired secrets and pending plans without reads, invalidates leases, and stops on close', async t => {
 t.mock.timers.enable({apis:['setInterval']});let clock=now;
 const f=await fixture(t,{now:()=>clock}), h=await host(f,'timer-expiry');
 const check=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});
 const planned=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:check.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'});
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?',new Date(now.getTime()+60_000).toISOString(),h.credential);
 let invalidated=0;const lease=f.machines.acquireTerminal(h.id,h.credential,()=>{invalidated++;lease.release()});
 clock=new Date(now.getTime()+59_999);t.mock.timers.tick(30_000);assert.notEqual(credentialRow(f,h.credential).secret_encrypted,'');assert.equal(lease.valid(),true);
 clock=new Date(now.getTime()+60_000);t.mock.timers.tick(30_000);
 assert.equal(credentialRow(f,h.credential).secret_encrypted,'');assert.equal(credentialRow(f,h.credential).clear_reason,'expired');assert.equal(invalidated,1);assert.equal(lease.valid(),false);
 assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',planned.data.id)?.status,'cancelled');
 assert.equal(credentialEvents(f,h.credential).filter(e=>e.event==='expired').length,1);
 const later=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key,expires_in_seconds:60});assert.equal(later.status,201);
 f.machines.close?.();clock=new Date(clock.getTime()+60_000);t.mock.timers.tick(60_000);
 assert.notEqual(credentialRow(f,later.data.credential_id).secret_encrypted,'','closed module no longer runs cleanup');
});

test('using an expired credential clears it immediately before any SSH attempt', async t => {
 let clock=now;const f=await fixture(t,{now:()=>clock}), h=await host(f,'expiry-use');
 clock=new Date(now.getTime()+3_600_000);
 const attempt=await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:h.credential});assert.equal(attempt.status,409);assert.match(attempt.raw,/过期/);assert.equal(f.sshInput,undefined);
 assert.equal(credentialRow(f,h.credential).secret_encrypted,'');assert.equal(credentialRow(f,h.credential).clear_reason,'expired');
 assert.equal(f.machines.get(h.id).active_ssh_key_count,0);assert.equal(f.machines.get(h.id).capabilities.deploy_agent.reason,'ssh_key_required');
});

test('password failures, cancellation and unused terminal closure consume and erase the password', async t => {
 for(const outcome of ['failed','cancelled','terminal']){
  const f=await fixture(t,{},async()=>{throw new SSHError('authentication_failed')}),h=await host(f,'password-'+outcome);
  const added=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:'one-use-'+outcome});const cid=added.data.credential_id;
  if(outcome==='terminal') { const lease=f.machines.acquireTerminal(h.id,cid,()=>{});assert.equal(lease.valid(),true);lease.release();assert.equal(lease.password,'');assert.equal(lease.valid(),false); }
  else { const abort=new AbortController();if(outcome==='cancelled')abort.abort();const result=await f.machines.checkSSH(h.id,{credential_id:cid},f.user.id,abort.signal);assert.equal(result.error_code,outcome==='cancelled'?'cancelled':'authentication_failed'); }
  const saved=credentialRow(f,cid);assert.equal(saved.secret_encrypted,'');assert.equal(saved.clear_reason,'consumed');assert.ok(saved.revoked_at);assert.equal(credentialEvents(f,cid).filter(e=>e.event==='consumed').length,1);
 }
});

test('capabilities distinguish connection, fingerprint, usable password, private key and busy state', async t => {
 const f=await fixture(t);const made=await f.request('/machines','POST',{name:'capabilities',address:'host.example.com',username:'deploy'}),mid=made.data.id;
 let machine=f.machines.get(mid);assert.equal(machine.capabilities.terminal.reason,'direct_ssh_required');assert.equal(machine.ssh_recovery_available,false);
 await f.request(`/machines/${mid}`,'PUT',{connection_method:'direct_ssh'});assert.equal(f.machines.get(mid).capabilities.ssh_check.reason,'host_fingerprint_required');
 await f.request(`/machines/${mid}`,'PUT',{host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 const script=await f.request(`/machines/${mid}/credentials`,'POST',{method:'manual_script'});assert.equal(script.status,201);
 machine=f.machines.get(mid);assert.equal(machine.active_credential_count,1);assert.equal(machine.active_ssh_credential_count,0);assert.equal(machine.capabilities.terminal.reason,'ssh_credential_required');assert.equal(machine.capabilities.deploy_agent.reason,'ssh_key_required');
 const password=await f.request(`/machines/${mid}/credentials`,'POST',{method:'password',secret:'temporary'});const pid=password.data.credential_id;
 machine=f.machines.get(mid);assert.equal(machine.active_ssh_credential_count,1);assert.equal(machine.active_ssh_key_count,0);assert.equal(machine.ssh_recovery_available,true);assert.equal(machine.capabilities.terminal.available,true);assert.equal(machine.capabilities.ssh_check.available,true);assert.equal(machine.capabilities.deploy_agent.reason,'ssh_key_required');
 const lease=f.machines.acquireTerminal(mid,pid,()=>{});for(const value of Object.values(f.machines.get(mid).capabilities)) assert.equal(value.reason,'host_busy');lease.release();
 const key=await f.request(`/machines/${mid}/credentials`,'POST',{method:'ssh_key',secret:'-----BEGIN PRIVATE KEY----- fixture -----END PRIVATE KEY-----'});
 machine=f.machines.get(mid);assert.equal(machine.active_ssh_key_count,1);assert.equal(machine.capabilities.deploy_agent.available,true);
 await f.request(`/machines/${mid}/credentials/${key.data.credential_id}`,'DELETE');assert.equal(f.machines.get(mid).ssh_recovery_available,false);
});

test('startup migrates legacy keys without shortening them, clears invalid history, and never relabels new credentials', async t => {
 const f=await fixture(t),h=await host(f,'legacy-policy');
 const expired=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key});
 const revoked=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:'historical-password'});
 const longExpiry=new Date(now.getTime()+90*86_400_000).toISOString();
 f.db.run("UPDATE machine_credentials SET retention='managed',expires_at=? WHERE id=?",longExpiry,h.credential);
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?',now.toISOString(),expired.data.credential_id);
 f.db.run('UPDATE machine_credentials SET revoked_at=?,secret_fingerprint=? WHERE id=?',now.toISOString(),'historical-password-hash',revoked.data.credential_id);
 f.machines.close?.();
 // Reconstruct the schema present before SDD031, including nonempty expired
 // and revoked envelopes, then run the real module registration migration.
 f.db.exec(`CREATE TABLE old_machine_credentials AS SELECT id,machine_id,method,secret_encrypted,secret_fingerprint,retention,created_at,expires_at,revoked_at,last_used_at,created_by FROM machine_credentials;
   DROP TABLE machine_credentials; ALTER TABLE old_machine_credentials RENAME TO machine_credentials;`);
 const restarted=registerManagedMachines({...f.deps,router:new Router()});t.after(()=>restarted.close?.());
 assert.equal(credentialRow(f,revoked.data.credential_id).secret_fingerprint,'');
 const old=credentialRow(f,h.credential);assert.equal(old.policy_source,'legacy');assert.equal(old.retention,'managed');assert.equal(old.expires_at,longExpiry);assert.notEqual(old.secret_encrypted,'');
 for(const [cid,reason] of [[expired.data.credential_id,'expired'],[revoked.data.credential_id,'revoked']]){assert.equal(credentialRow(f,cid).secret_encrypted,'');assert.equal(credentialRow(f,cid).clear_reason,reason);assert.equal(credentialRow(f,cid).policy_source,'legacy');}
 const added=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key});assert.equal(added.status,201,added.raw);assert.equal(credentialRow(f,added.data.credential_id).policy_source,'default');
 restarted.close?.();const secondRestart=registerManagedMachines({...f.deps,router:new Router()});t.after(()=>secondRestart.close?.());
 assert.equal(credentialRow(f,added.data.credential_id).policy_source,'default');assert.equal(credentialRow(f,added.data.credential_id).retention,'temporary');assert.equal(credentialRow(f,h.credential).policy_source,'legacy');
 assert.equal(credentialEvents(f,expired.data.credential_id).filter(e=>e.event==='expired').length,1);
});

test('Agent activation clears only its own temporary secrets, preserves explicit and legacy managed keys, and cancels spare plans', async t => {
 const f=await fixture(t),h=await host(f,'activated-policy'),other=await host(f,'activation-other');
 const managed=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key,retention:'managed',confirm_managed:true});
 const legacy=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key,retention:'managed',confirm_managed:true});f.db.run("UPDATE machine_credentials SET policy_source='legacy' WHERE id=?",legacy.data.credential_id);
 const temporary=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'ssh_key',secret:h.key});
 const password=await f.request(`/machines/${h.id}/credentials`,'POST',{method:'password',secret:'activation-password'});
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:h.credential});
 const input={check_id:checked.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'};
 const first=await f.request(`/machines/${h.id}/deployments/plan`,'POST',input),second=await f.request(`/machines/${h.id}/deployments/plan`,'POST',input);
 const applied=await f.request(`/machines/${h.id}/deployments/${first.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,200,applied.raw);
 for(const cid of [h.credential,temporary.data.credential_id,password.data.credential_id]){assert.equal(credentialRow(f,cid).secret_encrypted,'');assert.equal(credentialRow(f,cid).clear_reason,'agent_activated');assert.equal(credentialEvents(f,cid).filter(e=>e.event==='agent_activated').length,1);}
 for(const cid of [managed.data.credential_id,legacy.data.credential_id,other.credential]){assert.notEqual(credentialRow(f,cid).secret_encrypted,'');assert.equal(credentialRow(f,cid).clear_reason,'');}
 assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',first.data.id)?.status,'succeeded');assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',second.data.id)?.status,'cancelled');
 assert.equal(f.machines.get(h.id).agent_id,'agent-1');assert.equal(f.machines.get(h.id).active_ssh_key_count,2);
});

test('without active enrollment proof, failed installation retains an unexpired temporary key for retry', async t => {
 const f=await fixture(t),h=await host(f,'activation-proof');f.agentCredentials.enrollmentStatus=()=>({status:'pending',agent_id:''});
 const checked=await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:h.credential});
 const planned=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:checked.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'});
 const applied=await f.request(`/machines/${h.id}/deployments/${planned.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,502);assert.equal(f.machines.get(h.id).agent_id,'');assert.notEqual(credentialRow(f,h.credential).secret_encrypted,'');assert.equal(credentialRow(f,h.credential).clear_reason,'');
 assert.equal((await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:h.credential})).status,200);
});

test('expiry clears database secrets but leaves a bounded running install intact while cancelling only pending plans', async t => {
 t.mock.timers.enable({apis:['setInterval']});let clock=now;let entered!:()=>void,finish!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{finish=resolve});
 const f=await fixture(t,{now:()=>clock},async input=>{if(input.enrollmentToken){entered();await gate;}return {stdout:input.enrollmentToken?'installed':checkOutput,stderr:'',stages:[]}}),h=await host(f,'running-expiry');
 f.db.run('UPDATE machine_credentials SET expires_at=? WHERE id=?',new Date(now.getTime()+60_000).toISOString(),h.credential);
 const check=await f.request(`/machines/${h.id}/ssh-check`,'POST',{}),input={check_id:check.data.id,credential_id:h.credential,version:'0.1.0',arch:'amd64'};
 const running=await f.request(`/machines/${h.id}/deployments/plan`,'POST',input),pending=await f.request(`/machines/${h.id}/deployments/plan`,'POST',input);
 const application=f.request(`/machines/${h.id}/deployments/${running.data.id}/apply`,'POST',{confirm:true});await started;
 clock=new Date(now.getTime()+60_000);t.mock.timers.tick(30_000);
 assert.equal(credentialRow(f,h.credential).secret_encrypted,'');assert.equal(credentialRow(f,h.credential).clear_reason,'expired');assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',running.data.id)?.status,'running');assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',pending.data.id)?.status,'cancelled');assert.equal(f.machines.get(h.id).capabilities.deploy_agent.reason,'host_busy');
 finish();const completed=await application;assert.equal(completed.status,200,completed.raw);assert.equal(f.db.get<any>('SELECT status FROM machine_deployments WHERE id=?',running.data.id)?.status,'succeeded');assert.equal(credentialRow(f,h.credential).clear_reason,'expired');
});

const probeOutput=(agentID='node-known',removed=false,options:{running?:boolean;lock?:boolean;complete?:boolean;managed?:boolean}={})=>`LMAGENT=1\nagent_id=${agentID}\ninstallation=${removed?'absent':'present'}\nprogram_complete=${options.complete??!removed?1:0}\nunit_managed=${options.managed===false?0:1}\nservice_running=${options.running??!removed?1:0}\nlifecycle_locked=${options.lock?1:0}\noperation_lock=0\ndata_retained=1\n`;
async function uninstallHost(f:Awaited<ReturnType<typeof fixture>>,linked=true){
 const h=await host(f,'uninstall-'+Math.random().toString(36).slice(2));
 f.db.exec("CREATE TABLE IF NOT EXISTS agent_credentials(id TEXT PRIMARY KEY,agent_id TEXT,audience TEXT,revoked_at TEXT,revoke_reason TEXT DEFAULT '')");
 f.db.run("INSERT INTO agent_credentials(id,agent_id,audience) VALUES(?,?,?)",'node-control','node-known','control');
 f.db.run("INSERT INTO agent_credentials(id,agent_id,audience) VALUES(?,?,?)",'node-data','node-known','data');
 if(linked)f.db.run("UPDATE managed_machines SET agent_id='node-known' WHERE id=?",h.id);
 const check=await f.request(`/machines/${h.id}/ssh-check`,'POST',{credential_id:h.credential});assert.equal(check.status,200,check.raw);
 return {...h,check:check.data.id};
}
const uninstallPlan=(f:Awaited<ReturnType<typeof fixture>>,h:{id:string;credential:string;check:string})=>f.request(`/machines/${h.id}/uninstallations/plan`,'POST',{check_id:h.check,credential_id:h.credential});

test('fixed uninstall plan is reviewed, preserves data, revokes both node credentials and retains history',async t=>{
 let removed=false, destructive=0;const f=await fixture(t,{},async input=>{
  if(input.command.includes('systemctl stop')){destructive++;removed=true;return {stdout:probeOutput('node-known',removed),stderr:'',stages:[]};}
  return {stdout:input.command.includes('LMAGENT')?probeOutput('node-known',removed):checkOutput,stderr:'',stages:[]};
 });
 const h=await uninstallHost(f),planned=await uninstallPlan(f,h);assert.equal(planned.status,201,planned.raw);assert.equal(destructive,0);assert.equal(planned.data.plan.agent_id,'node-known');
 assert.equal((await f.request(`/machines/${h.id}`,'PUT',{name:'blocked'})).status,409);
 assert.equal((await f.request(`/machines/${h.id}`,'DELETE')).status,409);
 assert.equal((await f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/apply`,'POST',{})).status,400);
 const result=await f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/apply`,'POST',{confirm:true});assert.equal(result.status,200,result.raw);assert.equal(result.data.status,'succeeded');assert.equal(result.data.receipt.revoked_credentials,2);assert.equal(result.data.receipt.data_retained,true);assert.equal(destructive,1);
 assert.equal(f.db.all<any>("SELECT * FROM agent_credentials WHERE revoked_at IS NOT NULL").length,2);
 const detail=await f.request(`/machines/${h.id}`);assert.equal(detail.data.machine.agent_status,'uninstalled');assert.equal(detail.data.uninstallations.length,1);
 assert.equal((await f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/apply`,'POST',{confirm:true})).status,409);assert.equal(destructive,1);
});

test('unbound host must prove registered remote node and cannot uninstall a different or busy node',async t=>{
 let observed='node-known';const f=await fixture(t,{},async input=>({stdout:input.command.includes('LMAGENT')?probeOutput(observed):checkOutput,stderr:'',stages:[]}));
 const h=await uninstallHost(f,false);observed='unregistered';assert.equal((await uninstallPlan(f,h)).status,409);
 observed='node-known';const good=await uninstallPlan(f,h);assert.equal(good.status,201,good.raw);assert.equal(f.machines.get(h.id).agent_id,'');
 await f.request(`/machines/${h.id}/uninstallations/${good.data.id}/cancel`,'POST',{});
 f.db.exec("CREATE TABLE agent_jobs(id TEXT,agent_id TEXT,state TEXT)");
 for(const state of ['queued','leased','accepted','preflighting','staging','activating','verifying','unknown']){
  f.db.run('INSERT INTO agent_jobs VALUES(?,?,?)','job','node-known',state);assert.equal((await uninstallPlan(f,h)).status,409,state);f.db.run('DELETE FROM agent_jobs');
 }
 f.db.run("UPDATE managed_machines SET agent_id='different-agent' WHERE id=?",h.id);assert.equal((await uninstallPlan(f,h)).status,409);
});

test('unknown uninstall never blindly retries and read-only reconcile can complete actual removal',async t=>{
 let removed=false,destructive=0;const f=await fixture(t,{},async input=>{
  if(input.command.includes('systemctl stop')){destructive++;removed=true;throw new SSHError('timed_out');}
  return {stdout:input.command.includes('LMAGENT')?probeOutput('node-known',removed):checkOutput,stderr:'',stages:[]};
 });
 const h=await uninstallHost(f),planned=await uninstallPlan(f,h);
 const apply=()=>f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/apply`,'POST',{confirm:true});
 assert.equal((await apply()).status,502);assert.equal(f.db.get<any>('SELECT status FROM machine_uninstallations WHERE id=?',planned.data.id)?.status,'unknown');
 assert.equal(f.db.all('SELECT id FROM agent_credentials WHERE revoked_at IS NOT NULL').length,0);
 assert.equal((await apply()).status,409);assert.equal((await uninstallPlan(f,h)).status,409);assert.equal(destructive,1);
 const reconciled=await f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/reconcile`,'POST',{});assert.equal(reconciled.status,200,reconciled.raw);assert.equal(reconciled.data.status,'succeeded');assert.equal(destructive,1);
});

test('reconcile fails closed on lock or partial state and can release a verified unchanged running node',async t=>{
 let state:{removed:boolean;running:boolean;lock:boolean;complete:boolean}={removed:false,running:true,lock:false,complete:true};
 const f=await fixture(t,{},async input=>{
  if(input.command.includes('systemctl stop'))throw new SSHError('timed_out');
  return {stdout:input.command.includes('LMAGENT')?probeOutput('node-known',state.removed,state):checkOutput,stderr:'',stages:[]};
 });
 const h=await uninstallHost(f),planned=await uninstallPlan(f,h);
 await f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/apply`,'POST',{confirm:true});
 const reconcile=()=>f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/reconcile`,'POST',{});
 state.lock=true;assert.equal((await reconcile()).status,409);state.lock=false;state.complete=false;state.running=false;assert.equal((await reconcile()).status,409);
 state.complete=true;state.running=true;const restored=await reconcile();assert.equal(restored.status,200,restored.raw);assert.equal(restored.data.status,'failed');assert.equal(restored.data.receipt.credentials_revoked,false);
 assert.equal(f.db.all('SELECT id FROM agent_credentials WHERE revoked_at IS NOT NULL').length,0);
 assert.equal((await uninstallPlan(f,h)).status,201);
});

test('uninstall rejects members, changed identities, expired plans and revoked keys without destructive calls',async t=>{
 let clock=now,observed='node-known',destructive=0;const f=await fixture(t,{now:()=>clock},async input=>{if(input.command.includes('systemctl stop'))destructive++;return {stdout:input.command.includes('LMAGENT')?probeOutput(observed):checkOutput,stderr:'',stages:[]};});
 const h=await uninstallHost(f);f.user.role='member';assert.equal((await uninstallPlan(f,h)).status,403);f.user.role='admin';
 const planned=await uninstallPlan(f,h);observed='other-node';assert.equal((await f.request(`/machines/${h.id}/uninstallations/${planned.data.id}/apply`,'POST',{confirm:true})).status,409);assert.equal(destructive,0);observed='node-known';
 const planned2=await uninstallPlan(f,h);clock=new Date(now.getTime()+900001);assert.equal((await f.request(`/machines/${h.id}/uninstallations/${planned2.data.id}/apply`,'POST',{confirm:true})).status,409);assert.equal(destructive,0);
 clock=now;await f.request(`/machines/${h.id}/uninstallations/${planned2.data.id}/cancel`,'POST',{});const planned3=await uninstallPlan(f,h);await f.request(`/machines/${h.id}/credentials/${h.credential}`,'DELETE');
 assert.equal(f.db.get<any>('SELECT status FROM machine_uninstallations WHERE id=?',planned3.data.id)?.status,'cancelled');assert.equal(destructive,0);
});

test('fresh installation cannot replace discovered or newly appeared Agent before signing enrollment',async t=>{
 let present=true;const f=await fixture(t,{},async()=>({stdout:present?checkOutput.replace('agent_installation=absent','agent_installation=present'):checkOutput,stderr:'',stages:[]}));
 const h=await host(f,'fresh-guard');let check=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});assert.equal(check.data.agent_installation.state,'present');
 assert.equal((await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:check.data.id,version:'0.1.0',arch:'amd64'})).status,409);
 present=false;check=await f.request(`/machines/${h.id}/ssh-check`,'POST',{});const planned=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:check.data.id,version:'0.1.0',arch:'amd64'});assert.equal(planned.status,201,planned.raw);
 present=true;assert.equal((await f.request(`/machines/${h.id}/deployments/${planned.data.id}/apply`,'POST',{confirm:true})).status,502);assert.equal(f.issued,undefined);
});

test('failed post-activation installation revokes only the new enrollment identity',async t=>{
 const f=await fixture(t,{},async input=>{if(input.enrollmentToken)throw new SSHError('timed_out');return {stdout:checkOutput,stderr:'',stages:[]};}),h=await host(f,'failed-activated');
 f.db.exec("CREATE TABLE agent_enrollments(id TEXT PRIMARY KEY,agent_id TEXT); CREATE TABLE agent_credentials(id TEXT PRIMARY KEY,agent_id TEXT,revoked_at TEXT,revoke_reason TEXT)");
 f.db.run("INSERT INTO agent_enrollments VALUES('enroll-1','agent-1')");f.db.run("INSERT INTO agent_credentials VALUES('new','agent-1',NULL,'')");f.db.run("INSERT INTO agent_credentials VALUES('old','old-agent',NULL,'')");
 const check=await f.request(`/machines/${h.id}/ssh-check`,'POST',{}),plan=await f.request(`/machines/${h.id}/deployments/plan`,'POST',{check_id:check.data.id,version:'0.1.0',arch:'amd64'});
 const result=await f.request(`/machines/${h.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(result.status,502,result.raw);assert.match(result.raw,/核对远端/);
 assert.ok(f.db.get<any>("SELECT revoked_at FROM agent_credentials WHERE id='new'")?.revoked_at);assert.equal(f.db.get<any>("SELECT revoked_at FROM agent_credentials WHERE id='old'")?.revoked_at,null);
});
