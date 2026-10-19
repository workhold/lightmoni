import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DB} from '../src/shared/sqlite.js';
import {Router} from '../src/shared/http.js';
import {cipher} from '../src/shared/crypto.js';
import {parseJSON} from '../src/shared/json.js';
import {registerManagedMachines, type SSHRunner} from '../src/server/managed-machines.js';
import type {Dependencies} from '../src/shared/types.js';

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
 const sshRunner:SSHRunner=async(input)=>{sshInput=input;return {stdout:`ok ${input.enrollmentToken} ${input.privateKey}`,stderr:`warning ${input.privateKey}`,stages:['checking_host_key','remote_command_completed']}};
 const deps={db,router,...encryption,now:()=>now,auth:{master,user:()=>user,requireAdmin:()=>{},validateKey:()=>{throw Error('unused')}},externalURL:'https://monitor.example.com',logger:{info(){},warn(){},error(){}},cat:{list:async()=>[]},query:async()=>({request_id:'',results:[]}),referencedTables:async()=>[],ch:{exec:async()=>{},query:async()=>({meta:[],data:[],rows:0}),insert:async()=>{}},reader:{exec:async()=>{},query:async()=>({meta:[],data:[],rows:0}),insert:async()=>{}},...overrides} as unknown as Dependencies;
 router.auth=deps.auth;
 const machines=registerManagedMachines(deps,{agentCredentials,sshRunner:sshRunnerOverride??sshRunner});
 const server=createServer(async(req,res)=>{if(!(await router.handle(req,res))){res.writeHead(404);res.end()}});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(()=>{server.close();db.close()});
 const request=async(path:string,method='GET',body?:any)=>{const response=await fetch(url+'/api/v1'+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const raw=await response.text();return {status:response.status,raw,data:parseJSON(raw)};};
 return {db,request,machines,user,get issued(){return issued},get sshInput(){return sshInput}};
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
 const f=await fixture(t);const created=await f.request('/machines','POST',{name:'prod-2',address:'host.example.com',username:'deploy',connection_method:'direct_ssh'});const machine=created.data;
 const password=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'password',secret:'temporary-password'});assert.equal(password.status,201);assert.equal(password.data.retention,'one_time');assert.match(password.data.warning,/不要长期保存/);
 const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{credential_id:password.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,400);assert.match(plan.raw,/密码/);
});

test('manual script credentials cannot be mistaken for automatic SSH deployment',async t=>{
 const f=await fixture(t);const created=await f.request('/machines','POST',{name:'prod-script',address:'host.example.com',username:'deploy',connection_method:'manual_script'});assert.equal(created.status,201,created.raw);const machine=created.data;
 const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'manual_script'});assert.equal(credential.status,201,credential.raw);
 const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,400);assert.match(plan.raw,/手动脚本/);
});

test('credential decryption failure closes a deployment as failed',async t=>{
 const f=await fixture(t,{decrypt:()=>{throw Error('corrupt credential envelope')}});const created=await f.request('/machines','POST',{name:'prod-broken',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});assert.equal(created.status,201,created.raw);const machine=created.data;const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,201,plan.raw);
 const applied=await f.request(`/machines/${machine.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,502,applied.raw);assert.equal(f.machines.assistantDeployment(plan.data.id).status,'failed');
});

test('failed SSH deployment cancels the one-time enrollment token',async t=>{
 const f=await fixture(t,{},async()=>{throw Error('ssh unavailable')});const created=await f.request('/machines','POST',{name:'prod-ssh-fail',address:'host.example.com',username:'deploy',connection_method:'direct_ssh',host_key_fingerprint:'SHA256:abcdefghijklmnop'});assert.equal(created.status,201,created.raw);const machine=created.data;const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,201,plan.raw);
 const applied=await f.request(`/machines/${machine.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,502,applied.raw);assert.equal(f.issued.cancelled,'enroll-1');
});

test('deployment plan requires host pinning and apply keeps tokens out of command/output',async t=>{
 const f=await fixture(t);const created=await f.request('/machines','POST',{name:'prod-3',address:'host.example.com',username:'deploy',connection_method:'direct_ssh'});const machine=created.data;const key='-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';const credential=await f.request(`/machines/${machine.id}/credentials`,'POST',{method:'ssh_key',secret:key});
 const unpinned=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(unpinned.status,400);assert.match(unpinned.raw,/指纹/);
 await f.request(`/machines/${machine.id}`,'PUT',{host_key_fingerprint:'SHA256:abcdefghijklmnop'});
 const plan=await f.request(`/machines/${machine.id}/deployments/plan`,'POST',{credential_id:credential.data.credential_id,version:'0.1.0',arch:'amd64'});assert.equal(plan.status,201,plan.raw);assert.equal(plan.data.status,'awaiting_approval');assert.match(plan.raw,/密码建议只使用一次/);
 const applied=await f.request(`/machines/${machine.id}/deployments/${plan.data.id}/apply`,'POST',{confirm:true});assert.equal(applied.status,200,applied.raw);assert.equal(applied.data.status,'succeeded');assert.equal(f.issued.token_display_once,'lm_enroll_secret');assert.ok(!f.sshInput.command.includes(f.issued.token_display_once));assert.equal(f.sshInput.enrollmentToken,f.issued.token_display_once);assert.ok(!applied.raw.includes(f.issued.token_display_once));assert.ok(!applied.raw.includes('PRIVATE KEY'));assert.equal(applied.data.receipt.agent_id,'agent-1');
 const assistantReceipt=f.machines.assistantDeployment(plan.data.id);assert.equal(assistantReceipt.status,'succeeded');assert.equal((assistantReceipt.receipt as any).stdout,undefined);assert.equal((assistantReceipt.receipt as any).stderr,undefined);
 const machineAfter=f.machines.get(machine.id);assert.equal(machineAfter.agent_id,'agent-1');assert.equal(machineAfter.agent_status,'online');
});
