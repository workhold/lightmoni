import test from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {blockingAgentJobSQL} from '../src/server/agent-job-fence.js';

function fixture(){
 const db=new DB(':memory:');
 db.exec("CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,execution_principal TEXT);CREATE TABLE privileged_jobs(id TEXT PRIMARY KEY,agent_id TEXT,task_run_id TEXT,capability TEXT,state TEXT,resolved_at TEXT,resolved_by TEXT,resolution_reason TEXT)");
 db.run("INSERT INTO agent_jobs VALUES('job','agent','unknown','privileged_executor')");
 db.run("INSERT INTO privileged_jobs VALUES('job','agent','job','operations.managed.v1','unknown','2026-11-03T00:00:00Z','admin','Verified worker ended')");
 return {db,blocked:()=>!!db.get(`SELECT j.id FROM agent_jobs j WHERE ${blockingAgentJobSQL(db,'j')}`)};
}
test('an audited matching managed reconciliation releases the fence without rewriting either unknown result',()=>{
 const f=fixture();try{assert.equal(f.blocked(),false);for(const table of ['agent_jobs','privileged_jobs'])assert.equal(f.db.get<{state:string}>(`SELECT state FROM ${table}`)?.state,'unknown');}finally{f.db.close()}
});
test('ordinary, foreign, incomplete and unreconciled unknown results remain fenced',()=>{
 const cases=[['id','foreign'],['agent_id','foreign'],['task_run_id','foreign'],['capability','container.managed.v1'],['state','succeeded'],['resolved_at',''],['resolved_by',''],['resolution_reason','   ']];
 for(const [column,value] of cases){const f=fixture();try{f.db.run(`UPDATE privileged_jobs SET ${column}=?`,value);assert.equal(f.blocked(),true,column);}finally{f.db.close()}}
 const f=fixture();try{for(const principal of ['ordinary_agent',null]){f.db.run('UPDATE agent_jobs SET execution_principal=?',principal);assert.equal(f.blocked(),true);}}finally{f.db.close()}
});
test('active jobs still block and missing reconciliation authority stays conservative',()=>{
 const f=fixture();try{
  for(const state of ['queued','leased','accepted','preflighting','staging','activating','verifying']){f.db.run('UPDATE agent_jobs SET state=?',state);assert.equal(f.blocked(),true,state)}
  for(const state of ['succeeded','failed','cancelled']){f.db.run('UPDATE agent_jobs SET state=?',state);assert.equal(f.blocked(),false,state)}
  f.db.run("UPDATE agent_jobs SET state='unknown'");f.db.exec('DROP TABLE privileged_jobs');assert.equal(f.blocked(),true);
  assert.throws(()=>blockingAgentJobSQL(f.db,'j; DELETE FROM agent_jobs'),/invalid_job_table_alias/);
 }finally{f.db.close()}
});
