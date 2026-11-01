import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {DB} from '../src/shared/sqlite.js';
import {machineDockerEnvironment} from '../src/server/docker-environment.js';
import {dockerInstallScript} from '../src/server/docker-install-script.js';
import {dockerInstallCommand,parseDockerInstallStatus} from '../src/server/machine-docker.js';
import {operationCommand} from '../src/agent/operations.js';
import {installCause} from '../src/operations/install-progress.js';

test('Docker host projection distinguishes missing, daemon, permissions, unknown and stale observations',()=>{
 const db=new DB(':memory:');try{
 db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT,heartbeat TEXT)');const now=new Date();
 const put=(v:any,last=now.toISOString())=>db.run('INSERT OR REPLACE INTO agents VALUES(?,?,?)','a',last,JSON.stringify(v));
 const inventory={observed_at:now.toISOString(),attempted_at:now.toISOString(),state:'unavailable',containers:[],truncated:false};
 assert.equal(machineDockerEnvironment(db,'',now).state,'unknown');put({});assert.equal(machineDockerEnvironment(db,'a',now).state,'unknown');
 for(const [code,state] of [['docker_cli_missing','missing'],['docker_permission_denied','permission_denied'],['docker_daemon_unavailable','daemon_unavailable'],['docker_collection_unavailable','unavailable']]){put({docker_inventory:{...inventory,error:code}});assert.equal(machineDockerEnvironment(db,'a',now).state,state);}
 put({docker_inventory:{...inventory,state:'ready'}});assert.equal(machineDockerEnvironment(db,'a',now).state,'ready');
 put({docker_inventory:{...inventory,state:'ready',compose_available:false}});assert.equal(machineDockerEnvironment(db,'a',now).state,'compose_missing');
 put({docker_inventory:{...inventory,error:'docker_cli_missing'}},new Date(0).toISOString());assert.equal(machineDockerEnvironment(db,'a',now).state,'stale');
 put({docker_inventory:{...inventory,observed_at:new Date(0).toISOString(),attempted_at:new Date(0).toISOString(),error:'docker_cli_missing'}});assert.equal(machineDockerEnvironment(db,'a',now).state,'stale');
 }finally{db.close();}
});

test('fixed installer has valid shell syntax and bounded, sanitized receipts',()=>{
 execFileSync('/bin/sh',['-n'],{input:dockerInstallScript});assert.match(dockerInstallScript,/flock -n/);assert.match(dockerInstallScript,/docker-compose-plugin/);assert.match(dockerInstallScript,/SupplementaryGroups=docker/);assert.match(dockerInstallScript,/v.agent_id!==process.argv/);assert.doesNotMatch(dockerInstallScript,/apt-get[^\n]*(?:remove|purge)|usermod|chmod 666|curl[^\n]*\|.*sh/);
 assert.throws(()=>dockerInstallCommand('id;touch /tmp/unsafe'));assert.throws(()=>parseDockerInstallStatus('{"state":"succeeded","phase":"verified","code":"private-secret"}'));
 assert.throws(()=>parseDockerInstallStatus('{"state":"succeeded","phase":"installing_packages","code":""}'));
 assert.deepEqual(parseDockerInstallStatus('{"state":"failed","phase":"installing_packages","code":"docker_install_package_failed","stderr":"secret"}'),{state:'failed',phase:'installing_packages',code:'docker_install_package_failed'});
});

test('Docker ENOENT records a specific safe installation cause',async()=>{
 const previous=process.env.PATH;process.env.PATH='/nonexistent-lightmoni-bin';
 try{await assert.rejects(operationCommand('docker',['info']),e=>{assert.equal(installCause(e),'docker_cli_missing');assert.equal((e as any).code,'operation_dependency_unavailable');return true;});}
 finally{process.env.PATH=previous;}
});

test('active and unresolved Docker installations fence Agent job enqueue and claim across restarts',async t=>{
 const {dockerFixture}=await import('./fixtures/docker-control-fixture.js');const f=await dockerFixture();t.after(()=>f.close());
 const created=await f.req('/ops/machines/machine-a/docker-jobs','POST',{operation:'inventory',request_id:'docker-fence-inventory-001'});assert.equal(created.status,202);
 f.db.exec("CREATE TABLE machine_docker_installations(id TEXT,machine_id TEXT,agent_id TEXT,state TEXT);INSERT INTO machine_docker_installations VALUES('install','machine-a','node-a','running')");
 assert.equal(f.jobs.claim('node-a',['docker.inventory']),null);
 assert.throws(()=>f.jobs.enqueue({agentID:'node-a',deploymentID:'docker-machine-a',operationID:'other-inventory',actions:[{kind:'docker',operation:'inventory'}],capabilities:['docker.inventory'],target:{docker_machine_id:'machine-a'}}),/docker_installation_pending/);
 f.db.run("UPDATE machine_docker_installations SET state='unknown'");assert.equal(f.jobs.claim('node-a',['docker.inventory']),null);
 f.db.run("UPDATE machine_docker_installations SET state='failed'");assert.equal(f.jobs.claim('node-a',['docker.inventory'])?.id,created.body.id);
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
