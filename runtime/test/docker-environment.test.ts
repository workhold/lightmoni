import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {DB} from '../src/shared/sqlite.js';
import {machineDockerEnvironment} from '../src/server/docker-environment.js';
import {dockerInstallScript} from '../src/server/docker-install-script.js';
import {dockerInstallCommand,parseDockerInstallStatus} from '../src/server/machine-docker.js';
import {operationCommand} from '../src/agent/operations.js';
import {installCause} from '../src/operations/install-progress.js';

test('Docker projection accepts only fresh signed executor capability observations',()=>{
 const now=new Date('2026-11-01T00:00:00Z');
 const snapshot=(overrides:any={})=>({executor:{state:'active',online:true,last_seen:now.toISOString(),...overrides},capabilities:{'container.managed.v1':{effective:'ready'}}});
 assert.deepEqual(machineDockerEnvironment(undefined,now),{state:'unknown',code:'executor_observation_required',observed_at:'',source:'none'});
 assert.equal(machineDockerEnvironment({executor:null,capabilities:{}},now).state,'unknown');
 assert.equal(machineDockerEnvironment(snapshot({state:'revoked'}),now).state,'unknown');
 assert.equal(machineDockerEnvironment(snapshot({online:false}),now).state,'stale');
 assert.equal(machineDockerEnvironment(snapshot({last_seen:new Date(0).toISOString()}),now).state,'stale');
 assert.equal(machineDockerEnvironment(snapshot({last_seen:new Date(now.getTime()+61000).toISOString()}),now).state,'stale');
 const ready=machineDockerEnvironment(snapshot(),now);assert.equal(ready.state,'ready');assert.equal(ready.source,'executor');
 assert.equal('containers' in ready,false,'do not fabricate daemon inventory or Compose status');
 assert.deepEqual(machineDockerEnvironment({...snapshot(),capabilities:{}},now),{state:'unavailable',code:'executor_capability_unavailable',observed_at:now.toISOString(),source:'executor'});
});

test('fixed installer has valid shell syntax and bounded, sanitized receipts',()=>{
 execFileSync('/bin/sh',['-n'],{input:dockerInstallScript});assert.match(dockerInstallScript,/flock -n/);assert.match(dockerInstallScript,/docker-compose-plugin/);assert.doesNotMatch(dockerInstallScript,/SupplementaryGroups|configuring_agent|identity\.json|lightmoni-agent|usermod|daemon-reload/);assert.doesNotMatch(dockerInstallScript,/apt-get[^\n]*(?:remove|purge)|usermod|chmod 666|curl[^\n]*\|.*sh/);
 assert.throws(()=>dockerInstallCommand('id;touch /tmp/unsafe'));assert.throws(()=>parseDockerInstallStatus('{"state":"succeeded","phase":"verified","code":"private-secret"}'));
 assert.throws(()=>parseDockerInstallStatus('{"state":"succeeded","phase":"installing_packages","code":""}'));
 assert.deepEqual(parseDockerInstallStatus('{"state":"failed","phase":"installing_packages","code":"docker_install_package_failed","stderr":"secret"}'),{state:'failed',phase:'installing_packages',code:'docker_install_package_failed'});
});

test('Docker ENOENT records a specific safe installation cause',async()=>{
 const previous=process.env.PATH;process.env.PATH='/nonexistent-lightmoni-bin';
 try{await assert.rejects(operationCommand('docker',['info']),e=>{assert.equal(installCause(e),'docker_cli_missing');assert.equal((e as any).code,'operation_dependency_unavailable');return true;});}
 finally{process.env.PATH=previous;}
});

test('active and unresolved Docker installations fence readonly Agent jobs across restarts',async t=>{
 const {dockerFixture}=await import('./fixtures/docker-control-fixture.js');const f=await dockerFixture();t.after(()=>f.close());
 const input={agentID:'node-a',deploymentID:'readonly-health',operationID:'health',actions:[{kind:'health_check',check:{kind:'systemd-active',unit:'app.service'}}],capabilities:['health.systemd']};
 const created=f.jobs.enqueue(input);
 f.db.exec("CREATE TABLE machine_docker_installations(id TEXT,machine_id TEXT,agent_id TEXT,state TEXT);INSERT INTO machine_docker_installations VALUES('install','machine-a','node-a','running')");
 assert.equal(f.jobs.claim('node-a',['health.systemd']),null);
 assert.throws(()=>f.jobs.enqueue({...input,operationID:'other-health'}),/docker_installation_pending/);
 f.db.run("UPDATE machine_docker_installations SET state='unknown'");assert.equal(f.jobs.claim('node-a',['health.systemd']),null);
 f.db.run("UPDATE machine_docker_installations SET state='failed'");assert.equal(f.jobs.claim('node-a',['health.systemd'])?.id,created.id);
});

test('platform restart retains the durable Docker installation fence and status verification never reinstalls',async()=>{
 const {registerMachineDocker,dockerInstallStatusCommand}=await import('../src/server/machine-docker.js');
 const {pendingDockerInstallation}=await import('../src/server/machine-docker-guard.js');
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const root=mkdtempSync(join(tmpdir(),'lm069-restart-')),path=join(root,'db.sqlite');let db=new DB(path);
 const make=()=>registerMachineDocker({db,router:{get(){},post(){}},now:()=>new Date()} as any,{safe:(f:any)=>f} as any);
 try{
 db.exec('CREATE TABLE managed_machines(id TEXT PRIMARY KEY);INSERT INTO managed_machines VALUES(\'machine\')');let service=make();
 db.run('INSERT INTO machine_docker_installations VALUES(?,?,?,?,?,?,?,?,?,?,?)','a'.repeat(32),'machine','agent','request-0001','credential','running','installing_packages','','admin',new Date().toISOString(),new Date().toISOString());
 await service.close();db.close();db=new DB(path);service=make();
 const pending=pendingDockerInstallation(db,'machine');assert.equal(pending.state,'unknown');assert.equal(pending.code,'docker_install_result_unavailable');await service.close();
 const command=dockerInstallStatusCommand('a'.repeat(32));assert.doesNotMatch(command,/mkdir|systemd-run|install\.sh/);assert.match(command,/state.*unknown/);assert.doesNotMatch(command,/state.*failed/);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

/** Real Router + HTTP + SQLite admission, with a fake SSH runner that can never
 * execute host commands. The access shim intentionally has no root-job guard:
 * this verifies registerMachineDocker's own durable-fence check. */
async function dockerInstallationFenceFixture(t:import('node:test').TestContext,bodyGate?:{entered():void;wait:Promise<void>}){
 const {dockerFixture}=await import('./fixtures/docker-control-fixture.js');
 const {registerMachineDocker}=await import('../src/server/machine-docker.js');
 const {fail}=await import('../src/shared/http.js');
 const f=await dockerFixture(),busy=new Set<string>(),calls:any[]=[];let credentialReads=0,sessionActive=true;
 const originalUser=f.deps.auth.user;
 f.deps.auth.user=(request:any)=>sessionActive?originalUser(request):undefined;
 f.db.exec(`CREATE TABLE task_runs(id TEXT PRIMARY KEY,host_id TEXT,agent_id TEXT,execution_principal TEXT,state TEXT,resolved_at TEXT DEFAULT '',superseded_by TEXT DEFAULT '');
 CREATE TABLE machine_executor_bootstraps(id TEXT PRIMARY KEY,machine_id TEXT,agent_id TEXT,status TEXT);
 CREATE TABLE machine_executor_maintenance(id TEXT PRIMARY KEY,machine_id TEXT,status TEXT);`);
 const get=(id:string)=>{
  const row=f.db.get<any>('SELECT * FROM managed_machines WHERE id=?',id);if(!row)fail(404,'host_not_found');
  return {...row,port:22,username:'root',connection_method:'direct_ssh',capabilities:{update_agent:{available:true,reason:''}}};
 };
 const realRouter=f.deps.router;
 const router={
  get:(path:string,handler:any)=>realRouter.get(path,handler),
  post:(path:string,handler:any)=>realRouter.post(path,async(ctx:any)=>{
   if(bodyGate&&path.endsWith('/docker-installations')){
    const originalBody=ctx.body.bind(ctx);
    // A real HTTP request supplies and parses its JSON, then pauses at the same
    // asynchronous body boundary production must revalidate after.
    ctx.body=async()=>{const value=await originalBody();bodyGate.entered();await bodyGate.wait;return value;};
   }
   await handler(ctx);
  }),
 };
 const module=registerMachineDocker({...f.deps,router},{
  get,
  idle(id:string){if(busy.has(id))fail(409,'fixture_host_busy');},busy,
  credential(id:string,credentialID?:string){credentialReads++;assert.ok(!credentialID||credentialID==='fixture-credential');return {machine:get(id),credential:{id:'fixture-credential'}};},
  authentication(){return {privateKey:'fixture-only-never-used-for-ssh'};},
  markCredentialUsed(){},safe:(handler:any)=>handler,
  async runner(input:any){calls.push(input);return {stdout:JSON.stringify({state:'succeeded',phase:'verified',code:''}),stderr:'',stages:[]};},
 } as any);
 t.after(async()=>{await module.close();await f.close();});
 const start=(headers:Record<string,string>={cookie:'lm_session=fixture'})=>f.req('/machines/machine-a/docker-installations','POST',{confirmed:true,request_id:'docker-root-fence-request-001',credential_id:'fixture-credential'},headers);
 return {...f,start,busy,calls,credentialReads:()=>credentialReads,invalidateSession(){sessionActive=false;}};
}

const durableRootFences=[
 ...['queued','running','unknown'].map(state=>({kind:'privileged job',state,table:'task_runs'})),
 ...['running','verifying','unknown'].map(state=>({kind:'executor bootstrap',state,table:'machine_executor_bootstraps'})),
 ...['awaiting_approval','running','unknown'].map(state=>({kind:'executor maintenance',state,table:'machine_executor_maintenance'})),
];
for(const fence of durableRootFences)test(`Docker SSH installation is blocked by ${fence.kind} ${fence.state} before credentials or dispatch`,async t=>{
 const f=await dockerInstallationFenceFixture(t);
 if(fence.table==='task_runs')f.db.run("INSERT INTO task_runs(id,host_id,agent_id,execution_principal,state) VALUES('root-job','machine-a','node-a','privileged_executor',?)",fence.state);
 else if(fence.table==='machine_executor_bootstraps')f.db.run("INSERT INTO machine_executor_bootstraps VALUES('bootstrap','machine-a','node-a',?)",fence.state);
 else f.db.run("INSERT INTO machine_executor_maintenance VALUES('maintenance','machine-a',?)",fence.state);
 const result=await f.start();
 assert.equal(result.status,409,JSON.stringify(result.body));
 assert.match(result.body.error,/privileged_execution_pending/,'Docker admission must use the canonical root execution fence');
 assert.equal(f.credentialReads(),0,'do not read a login credential for blocked installation');
 assert.deepEqual(f.calls,[],'no SSH command may be dispatched');
 assert.equal(f.db.get<any>('SELECT count(*) n FROM machine_docker_installations')?.n,0,'a blocked request must not reserve another root writer');
 assert.equal(f.busy.size,0);
 const state=f.db.get<any>(`SELECT ${fence.table==='task_runs'?'state':'status'} AS state FROM ${fence.table}`)?.state;
 assert.equal(state,fence.state,'the existing fence must not be released by a competing installer');
});

test('a durable root fence on another host does not block Docker installation on the selected host',async t=>{
 const f=await dockerInstallationFenceFixture(t);
 f.db.run("INSERT INTO machine_executor_maintenance VALUES('other-maintenance','machine-b','unknown')");
 const result=await f.start();
 assert.equal(result.status,202,JSON.stringify(result.body));
 assert.equal(f.calls.length,1,'only the selected fake SSH runner is called');
 assert.equal(f.calls[0].machine.id,'machine-a');
 assert.equal(f.db.get<any>("SELECT state FROM machine_docker_installations WHERE id=?",result.body.id)?.state,'succeeded');
 assert.equal(f.db.get<any>("SELECT status FROM machine_executor_maintenance WHERE id='other-maintenance'")?.status,'unknown');
});

for(const [name,headers] of [
 ['missing human session',{}],
 ['bearer authorization with a session',{cookie:'lm_session=fixture',authorization:'Bearer fixture-cannot-authorize-root-install'}],
] as const)test(`Docker SSH installation refuses ${name}`,async t=>{
 const f=await dockerInstallationFenceFixture(t),result=await f.start(headers);
 assert.equal(result.status,403,JSON.stringify(result.body));assert.equal(result.body.error,'human_admin_session_required');
 assert.equal(f.credentialReads(),0);assert.deepEqual(f.calls,[]);
 assert.equal(f.db.get<any>('SELECT count(*) n FROM machine_docker_installations')?.n,0);
});

for(const change of ['disabled administrator','demoted administrator','expired session'] as const)test(`Docker SSH installation revalidates ${change} after asynchronous request body`,async t=>{
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
 t.after(()=>release());
 const f=await dockerInstallationFenceFixture(t,{entered:enter,wait});
 const pending=f.start();
 await entered;
 assert.deepEqual(f.calls,[],'the body gate must precede SSH dispatch');
 if(change==='disabled administrator')f.db.run("UPDATE users SET active=0 WHERE id='admin'");
 else if(change==='demoted administrator')f.db.run("UPDATE users SET role='member' WHERE id='admin'");
 else f.invalidateSession();
 release();
 const result=await pending;
 assert.equal(result.status,403,JSON.stringify(result.body));assert.equal(result.body.error,'human_admin_session_required');
 assert.equal(f.credentialReads(),0);assert.deepEqual(f.calls,[]);
 assert.equal(f.db.get<any>('SELECT count(*) n FROM machine_docker_installations')?.n,0,'stale authority must not create a durable installation record');
 assert.equal(f.busy.size,0);
});
