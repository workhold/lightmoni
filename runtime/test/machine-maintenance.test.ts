import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {cipher} from '../src/shared/crypto.js';
import {Router} from '../src/shared/http.js';
import {NodeStore} from '../src/server/nodes-model.js';
import {registerAgentJobs} from '../src/server/agent-jobs.js';
import {OperationsPlatformStore} from '../src/ops/store.js';
import {assertMaintenanceOverride,captureMaintenanceOverride,maintenanceBlockers,maintenanceWorkBusy,maintenanceFenceMessage,prepareMachineMaintenance,pendingMaintenancePreparation,resolveLegacyExecutorBootstrap} from '../src/server/machine-maintenance.js';
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

test('maintenance blockers expose actionable detail without changing the fence',t=>{
  const f=fixture(t);
  assert.deepEqual(maintenanceBlockers(f.deps,'agent','host'),[]);
  f.db.run("UPDATE agent_jobs SET state='leased',lease_id='issued' WHERE id=?",f.job.id);
  const blockers=maintenanceBlockers(f.deps,'agent','host');
  assert.equal(blockers.length,1);
  assert.deepEqual(blockers[0],{kind:'agent_job',id:f.job.id,state:'leased'});
  assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),true);
  f.db.run("UPDATE agent_jobs SET state='queued',attempts=0,lease_id='',lease_expires_at='' WHERE id=?",f.job.id);
  assert.equal(maintenanceBlockers(f.deps,'agent','host').length,0,'unclaimed queued work is not a blocker');
  assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),false);
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

test('reviewed override skips only the pinned historical unknown records',t=>{
 const f=fixture(t);
 f.db.exec("CREATE TABLE privileged_jobs(id TEXT,task_run_id TEXT,agent_id TEXT,machine_id TEXT,state TEXT,started_at TEXT,lease_id TEXT,capability TEXT,resolved_at TEXT,resolved_by TEXT,resolution_reason TEXT);CREATE TABLE task_runs(id TEXT,agent_id TEXT,host_id TEXT,state TEXT,resolved_at TEXT,superseded_by TEXT)");
 f.db.run("INSERT INTO privileged_jobs VALUES(?,?,'agent','host','unknown','started','lease','operations.managed.v1','','','')",f.job.id,f.job.id);
 f.db.run("INSERT INTO task_runs VALUES(?,'agent','host','unknown','','')",f.job.id);
 f.db.run("UPDATE agent_jobs SET state='unknown' WHERE id=?",f.job.id);
 const override=captureMaintenanceOverride(f.deps,'agent','host','inspected host: no active operation');
 assert.deepEqual(new Set(override.blockers.map(item=>item.kind)),new Set(['task_run','agent_job','privileged_job']));
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),true);
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host',override),false);
 assert.doesNotThrow(()=>assertMaintenanceOverride(f.deps,'agent','host',override));
 const preparation=prepareMachineMaintenance(f.deps,'host','agent',false,override);preparation.release();
 f.db.run("INSERT INTO task_runs VALUES('new-unknown','agent','host','unknown','','')");
 assert.throws(()=>assertMaintenanceOverride(f.deps,'agent','host',override),/force_override_changed/);
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host',override),true);
 f.db.run("DELETE FROM task_runs WHERE id='new-unknown'");
 f.db.run("UPDATE privileged_jobs SET state='running' WHERE id=?",f.job.id);
 assert.throws(()=>assertMaintenanceOverride(f.deps,'agent','host',override),/force_override_changed/);
 assert.equal(maintenanceWorkBusy(f.deps,'agent','host',override),true);
});

test('force override rejects active tasks, empty reasons and other hosts',t=>{
 const f=fixture(t);
 f.db.run("UPDATE agent_jobs SET state='unknown' WHERE id=?",f.job.id);
 assert.throws(()=>captureMaintenanceOverride(f.deps,'agent','host',''),/force_reason_required/);
 assert.throws(()=>captureMaintenanceOverride(f.deps,'foreign','other','reviewed'),/force_unknown_only/);
 f.db.run("UPDATE agent_jobs SET state='leased' WHERE id=?",f.job.id);
 assert.throws(()=>captureMaintenanceOverride(f.deps,'agent','host','reviewed'),/force_unknown_only/);
});


test('resolved legacy executor bootstrap fences are observable and can be closed with current executor evidence',t=>{
  const f=fixture(t),at=f.deps.now().toISOString();
  f.db.exec(`CREATE TABLE machine_executor_bootstraps(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,executor_id TEXT NOT NULL DEFAULT '',install_generation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE privileged_executors(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,state TEXT NOT NULL,install_generation INTEGER NOT NULL,last_seen TEXT NOT NULL);
    CREATE TABLE privileged_audit(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,job_id TEXT NOT NULL DEFAULT '',actor_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,active INTEGER NOT NULL);`);
  f.db.run("INSERT INTO machine_executor_bootstraps VALUES('legacy-bootstrap','host','agent','unknown','old-executor',4)");
  f.db.run("INSERT INTO users VALUES('admin','admin',1)");
  assert.deepEqual(maintenanceBlockers(f.deps,'agent','host'),[{kind:'executor_bootstrap',id:'legacy-bootstrap',state:'unknown'}]);
  assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),true);
  assert.match(maintenanceFenceMessage(f.deps,'agent','host'),/executor_bootstrap legacy-b unknown/);
  assert.throws(()=>prepareMachineMaintenance(f.deps,'host','agent'),/maintenance_execution_pending: executor_bootstrap/);
  assert.throws(()=>resolveLegacyExecutorBootstrap(f.deps,'host','legacy-bootstrap','admin','current executor supersedes legacy fence'),/current_executor_required/);
  f.db.run("INSERT INTO privileged_executors VALUES('current-executor','host','agent','active',5,?)",at);
  const closed=resolveLegacyExecutorBootstrap(f.deps,'host','legacy-bootstrap','admin','Current active executor supersedes the uncertain legacy bootstrap; no remote mutation.');
  assert.equal(closed.status,'unknown');
  assert.equal(closed.resolved_by,'admin');
  assert.equal(maintenanceWorkBusy(f.deps,'agent','host'),false);
  assert.deepEqual(maintenanceBlockers(f.deps,'agent','host'),[]);
  const audit=f.db.get<any>("SELECT * FROM privileged_audit WHERE event='legacy_executor_bootstrap_closed'");
  assert.equal(audit.machine_id,'host');assert.equal(audit.job_id,'legacy-bootstrap');
  assert.throws(()=>resolveLegacyExecutorBootstrap(f.deps,'host','legacy-bootstrap','admin','repeat'),/already_closed/);
});

test('legacy executor bootstrap closure rejects stale or older executors',t=>{
  const f=fixture(t),at=f.deps.now().toISOString();
  f.db.exec(`CREATE TABLE machine_executor_bootstraps(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,executor_id TEXT NOT NULL DEFAULT '',install_generation INTEGER NOT NULL DEFAULT 0,resolved_at TEXT NOT NULL DEFAULT '',resolved_by TEXT NOT NULL DEFAULT '',resolution_reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE privileged_executors(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,state TEXT NOT NULL,install_generation INTEGER NOT NULL,last_seen TEXT NOT NULL);
    CREATE TABLE privileged_audit(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,job_id TEXT NOT NULL DEFAULT '',actor_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,active INTEGER NOT NULL);`);
  f.db.run("INSERT INTO machine_executor_bootstraps VALUES('legacy-bootstrap','host','agent','unknown','old-executor',6,'','','')");
  f.db.run("INSERT INTO users VALUES('admin','admin',1)");
  f.db.run("INSERT INTO privileged_executors VALUES('older-executor','host','agent','active',5,?)",at);
  assert.throws(()=>resolveLegacyExecutorBootstrap(f.deps,'host','legacy-bootstrap','admin','evidence'),/current_executor_required/);
  f.db.run("UPDATE privileged_executors SET install_generation=7,last_seen=?",'2020-01-01T00:00:00.000Z');
  assert.throws(()=>resolveLegacyExecutorBootstrap(f.deps,'host','legacy-bootstrap','admin','evidence'),/current_executor_required/);
});
