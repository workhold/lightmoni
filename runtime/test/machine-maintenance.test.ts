import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {cipher} from '../src/shared/crypto.js';
import {Router} from '../src/shared/http.js';
import {NodeStore} from '../src/server/nodes-model.js';
import {registerAgentJobs} from '../src/server/agent-jobs.js';
import {OperationsPlatformStore} from '../src/ops/store.js';
import {maintenanceWorkBusy,prepareMachineMaintenance,pendingMaintenancePreparation} from '../src/server/machine-maintenance.js';
import {hasPendingAgentUpdate} from '../src/server/machine-agent-updates-guard.js';

function fixture(t:any) {
  const db=new DB(':memory:'),deps:any={db,router:new Router(),...cipher(Buffer.alloc(32,9)),now:()=>new Date(),logger:{info(){},warn(){},error(){}}};
  new NodeStore(db,deps.now);
  const jobs=registerAgentJobs(deps,{agentCredentials:{has:()=>true} as any});jobs.setPrivilegedReadiness?.(()=>{});
  const store=new OperationsPlatformStore(deps,jobs),at=deps.now().toISOString();
  db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES('host','zz-bj-1','host',22,'direct_ssh','agent',?,?)",at,at);
  db.run("INSERT INTO agents VALUES('agent','host-id','os-name','1','linux','amd64',?,'{}')",at);
  const payload={version:1,operation_id:'operation',operation:'inspect',resource:{id:'app',agent_id:'agent',config:{task:'workload.inspect'}},input:{}};
  const job=jobs.enqueue({agentID:'agent',deploymentID:'platform-app',operationID:'operation',actions:[{kind:'operations',domain:'platform',operation_id:'operation'}],capabilities:['operations.platform'],target:{operations_resource_id:'app'}});
  db.run("INSERT INTO ops_platform_runs VALUES('operation','app',1,'agent','inspect','queued',?,'{}',?,'admin',NULL,?,?)",deps.encrypt(JSON.stringify(payload)),job.id,at,at);
  t.after(async()=>{await store.close();jobs.close?.();db.close();});
  return {db,deps,jobs,job,payload};
}

test('persistent planning gate defers unclaimed private inspections without rewriting them and blocks new work',t=>{
  const f=fixture(t);assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),false);
  const preparation=prepareMachineMaintenance(f.deps,'host','agent');
  assert.equal(hasPendingAgentUpdate(f.db,'agent','host'),true);
  assert.equal(hasPendingAgentUpdate(f.db,'agent','host',preparation.token),false);
  assert.throws(()=>prepareMachineMaintenance(f.deps,'host','agent'),/preparation_pending/);
  assert.throws(()=>f.jobs.enqueue({agentID:'agent',deploymentID:'platform-other',operationID:'other',actions:[{kind:'operations',domain:'platform',operation_id:'other'}],capabilities:['operations.platform']}),/升级|维护/);
  assert.equal(f.jobs.get(f.job.id).state,'queued');
  preparation.release();assert.equal(pendingMaintenancePreparation(f.db,'agent','host'),false);
  assert.equal(f.jobs.get(f.job.id).state,'queued');
  f.db.run("INSERT INTO machine_maintenance_preparations VALUES('host','agent','expired',?)",Date.now()-1);
  const next=prepareMachineMaintenance(f.deps,'host','agent');next.release();
  assert.throws(()=>prepareMachineMaintenance(f.deps,'host','foreign-agent'),/binding_changed/);
});

test('leased, previously attempted and unknown work remain maintenance barriers',t=>{
  const f=fixture(t);
  for(const change of [
    {column:'state',value:'leased'},
    {column:'state',value:'unknown'},
    {column:'attempts',value:1},
    {column:'lease_id',value:'already-issued'},
  ]) {
    const original=f.db.get<any>('SELECT * FROM agent_jobs WHERE id=?',f.job.id)![change.column];
    f.db.run('UPDATE agent_jobs SET '+change.column+'=? WHERE id=?',change.value,f.job.id);
    assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),true,change.column+':'+change.value);
    assert.throws(()=>prepareMachineMaintenance(f.deps,'host','agent'),/execution_pending/);
    f.db.run('UPDATE agent_jobs SET '+change.column+'=? WHERE id=?',original,f.job.id);
  }
  f.db.run("UPDATE agent_jobs SET state='queued',attempts=0,lease_id='',lease_expires_at='' WHERE id=?",f.job.id);
  f.db.run("UPDATE ops_platform_runs SET payload_cipher='corrupt' WHERE job_id=?",f.job.id);
  assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),false,'an unclaimed job can wait even when its payload cannot be read');
});

test('unclaimed queued work waits while started or unknown work blocks maintenance',t=>{
 const f=fixture(t);
 f.db.exec("CREATE TABLE privileged_jobs(id TEXT,task_run_id TEXT,agent_id TEXT,machine_id TEXT,state TEXT,started_at TEXT,lease_id TEXT,capability TEXT,resolved_at TEXT,resolved_by TEXT,resolution_reason TEXT);CREATE TABLE task_runs(id TEXT,agent_id TEXT,host_id TEXT,state TEXT,resolved_at TEXT,superseded_by TEXT)");
 f.db.run("INSERT INTO privileged_jobs VALUES(?,?,'agent','host','queued','','','operations.managed.v1','','','')",f.job.id,f.job.id);
 f.db.run("INSERT INTO task_runs VALUES(?,'agent','host','queued','','')",f.job.id);
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),false);
 assert.equal(maintenanceWorkBusy(f.deps,'','host'),false);
 f.db.run("UPDATE privileged_jobs SET state='running',started_at='started',lease_id='leased'");
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),true);
 f.db.run("UPDATE privileged_jobs SET state='queued',started_at='',lease_id=''");
 f.db.run("INSERT INTO task_runs VALUES('user-script','agent','host','queued','','')");
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),false);
 f.db.run("DELETE FROM task_runs WHERE id='user-script'");
 f.db.run("UPDATE privileged_jobs SET state='unknown'");assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),true);
});
