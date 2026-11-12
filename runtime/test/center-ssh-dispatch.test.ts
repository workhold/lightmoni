import test from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {registerCenterSSHDispatch} from '../src/server/center-ssh-dispatch.js';
import type {Dependencies} from '../src/shared/types.js';
import type {MachineTerminalAccess} from '../src/server/managed-machines.js';
import type {AgentJobStore} from '../src/server/agent-jobs.js';
import type {PrivilegedExecutorStore} from '../src/server/privileged-executors.js';
import type {SSHRunner} from '../src/server/machine-ssh.js';
import {SSHError} from '../src/server/machine-ssh.js';
import type {TaskRunStore} from '../src/server/task-center.js';

const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
function fixture(t:any,kind:'ordinary'|'privileged',runner:SSHRunner,supported=true){
  const db=new DB(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE managed_machines(id TEXT PRIMARY KEY,agent_id TEXT);
    CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,execution_principal TEXT,created_at TEXT);
    CREATE TABLE privileged_jobs(id TEXT PRIMARY KEY,machine_id TEXT,state TEXT,created_at TEXT);
    INSERT INTO managed_machines VALUES('host','agent');`);
  const jobID='a'.repeat(32);
  if(kind==='ordinary')db.run("INSERT INTO agent_jobs VALUES(?,'agent','queued','ordinary_agent','2026-11-11')",jobID);
  else db.run("INSERT INTO privileged_jobs VALUES(?,'host','queued','2026-11-11')",jobID);
  let released=false,used=false,sshOnly=false,failureCode='',invalidate=()=>{};
  const access={acquireTerminal(_machineID:string,_binding:unknown,onInvalidated:()=>void){invalidate=onInvalidated;return{machine:{id:'host',username:'root',port:22},credentialID:'binding',credentialMethod:'ssh_key',privateKey:'fixture-key',password:'',valid:()=>true,verifyHostKey:()=>true,markUsed(){used=true;},release(){released=true;}};}} as unknown as MachineTerminalAccess;
  const jobs={setSSHOnly(){sshOnly=true;},supportsSSHOnce(){return supported;},failQueuedSSH(id:string,code:string){failureCode=code;db.run("UPDATE agent_jobs SET state='failed' WHERE id=?",id);return{code};}} as unknown as AgentJobStore;
  const executors={setSSHOnly(){sshOnly=true;},supportsSSHOnce(){return supported;},prepareSSH(){},failQueuedSSH(id:string,code:string){failureCode=code;db.run("UPDATE privileged_jobs SET state='failed' WHERE id=?",id);return{code};}} as unknown as PrivilegedExecutorStore;
  const deps={db,logger:{warn(){},error(){}}} as unknown as Dependencies;
  const dispatcher=registerCenterSSHDispatch(deps,access,jobs,executors,runner);
  return{db,dispatcher,jobID,flags:()=>({released,used,sshOnly}),failureCode:()=>failureCode,invalidate:()=>invalidate()};
}

test('centre invokes a fixed SSH command for a queued ordinary job and preserves the signed job identity',async t=>{
  let command='';
  const f=fixture(t,'ordinary',async input=>{command=input.command;f.db.run("UPDATE agent_jobs SET state='succeeded' WHERE id=?",f.jobID);return{stdout:'',stderr:'',stages:[]};});
  f.dispatcher.tick();await pause();
  assert.match(command,/^sudo -n -u lightmoni-agent \/usr\/local\/bin\/lightmoni-agent jobs-once --config \/etc\/lightmoni-agent\/config.json --job-id a{32}$/);
  assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id=?",f.jobID)?.state,'succeeded');
  assert.deepEqual(f.flags(),{released:true,used:true,sshOnly:true});
});

test('SSH failure before a claim fails only the queued job; a claimed job remains for unknown reconciliation',async t=>{
  let claimed=false;
  const f=fixture(t,'privileged',async()=>{if(claimed)f.db.run("UPDATE privileged_jobs SET state='running' WHERE id=?",f.jobID);throw Error('ssh_failed');});
  f.dispatcher.tick();await pause();
  assert.equal(f.db.get<any>("SELECT state FROM privileged_jobs WHERE id=?",f.jobID)?.state,'failed');
  f.db.run("UPDATE privileged_jobs SET state='queued' WHERE id=?",f.jobID);claimed=true;
  f.dispatcher.tick();await pause();
  assert.equal(f.db.get<any>("SELECT state FROM privileged_jobs WHERE id=?",f.jobID)?.state,'running');
});

test('an unsupported old release fails a queued job before opening SSH',async t=>{
  for(const kind of ['ordinary','privileged'] as const){
    let invoked=false;
    const f=fixture(t,kind,async()=>{invoked=true;return{stdout:'',stderr:'',stages:[]};},false);
    f.dispatcher.tick();await pause();
    assert.equal(invoked,false,kind);
    assert.equal(f.failureCode(),'agent_upgrade_required',kind);
    assert.equal(f.db.get<any>(`SELECT state FROM ${kind==='ordinary'?'agent_jobs':'privileged_jobs'} WHERE id=?`,f.jobID)?.state,'failed');
  }
});

test('manual tasks use the root SSH entrypoint while scheduler runs stay with the helper',async t=>{
  const db=new DB(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE task_runs(id TEXT PRIMARY KEY,host_id TEXT,state TEXT,execution_principal TEXT,trigger TEXT,requested_by TEXT,created_at TEXT);
    CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,execution_principal TEXT,created_at TEXT);
    CREATE TABLE privileged_jobs(id TEXT PRIMARY KEY,machine_id TEXT,state TEXT,created_at TEXT);
    CREATE TABLE managed_machines(id TEXT PRIMARY KEY,agent_id TEXT);`);
  const manual='11111111-1111-4111-8111-111111111111',scheduled='22222222-2222-4222-8222-222222222222';
  db.run("INSERT INTO task_runs VALUES(?,'host','queued','agent','manual','admin','2026-11-11')",manual);
  db.run("INSERT INTO task_runs VALUES(?,'host','queued','agent','schedule','scheduler','2026-11-11')",scheduled);
  let command='',manualOnly=false,used=false;
  const access={acquireTerminal(){return{machine:{id:'host',username:'admin',port:22},credentialID:'binding',credentialMethod:'ssh_key',privateKey:'key',password:'',valid:()=>true,verifyHostKey:()=>true,markUsed(){used=true;},release(){}};}} as unknown as MachineTerminalAccess;
  const jobs={setSSHOnly(){},supportsSSHOnce(){return true;}} as unknown as AgentJobStore;
  const executors={setSSHOnly(){},supportsSSHOnce(){return true;}} as unknown as PrivilegedExecutorStore;
  const taskRuns={setSSHOnly(){manualOnly=true;},failQueuedSSH(){}} as unknown as TaskRunStore;
  const deps={db,logger:{warn(){},error(){}}} as unknown as Dependencies;
  const dispatcher=registerCenterSSHDispatch(deps,access,jobs,executors,async input=>{
    command=input.command;db.run("UPDATE task_runs SET state='succeeded' WHERE id=?",manual);return{stdout:'',stderr:'',stages:[]};
  },1000,taskRuns);
  dispatcher.tick();await pause();
  assert.equal(command,`sudo -n /usr/local/bin/lightmoni-agent task-once --job-id ${manual}`);
  assert.equal(db.get<any>("SELECT state FROM task_runs WHERE id=?",scheduled)?.state,'queued');
  assert.equal(manualOnly,true);assert.equal(used,true);
});

test('SSH host identity change has a distinct failure code before a claim',async t=>{
  const f=fixture(t,'ordinary',async()=>{throw new SSHError('host_key_mismatch');});
  f.dispatcher.tick();await pause();
  assert.equal(f.failureCode(),'host_key_mismatch');
  assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id=?",f.jobID)?.state,'failed');
});

test('credential invalidation aborts an in-flight SSH connection and fails only an unclaimed job',async t=>{
  let began=()=>{};const started=new Promise<void>(resolve=>{began=resolve;});
  const f=fixture(t,'ordinary',async input=>{began();await new Promise<void>((_,reject)=>input.signal.addEventListener('abort',()=>reject(new SSHError('cancelled')),{once:true}));throw Error('unreachable');});
  f.dispatcher.tick();await started;f.invalidate();await pause();
  assert.equal(f.failureCode(),'ssh_binding_changed');
  assert.equal(f.db.get<any>("SELECT state FROM agent_jobs WHERE id=?",f.jobID)?.state,'failed');
});
