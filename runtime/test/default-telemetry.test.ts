import test from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {bindApplicationRows,applicationObservation} from '../src/shared/application-observation.js';
import {flushObservationBatches,observationDiagnostic,saveObservationBatch} from '../src/privileged-executor/observation.js';
import {sdkTelemetryQueries,websiteTelemetryQueries} from '../src/ops/telemetry-queries.js';
import {Executor} from '../src/server/query.js';
function fixture(t:any){
 const db=new DB(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE agents(id TEXT,host_id TEXT);INSERT INTO agents VALUES('agent','host');CREATE TABLE ops_platform_resources(id TEXT,kind TEXT,spec_cipher TEXT);CREATE TABLE ops_cluster_instances(id TEXT,owner_id TEXT,cluster_id TEXT,machine_id TEXT,agent_id TEXT);INSERT INTO ops_cluster_instances VALUES('deployment','gateway','cluster','machine','agent')");
 db.run('INSERT INTO ops_platform_resources VALUES(?,?,?)','gateway','application',JSON.stringify({role:'openresty',service_name:'entry'}));return db;
}
const row=(site:string)=>({kind:'log',subtype:'',row:{attributes:{deployment_id:'deployment',container_id:'a'.repeat(64),website_id:site},body:'original access log'}});
test('a deleted website keeps its container log and no longer poisons the durable batch',t=>{
 const db=fixture(t),r=row('deleted-site');bindApplicationRows(db,'agent',[r],s=>s);
 assert.equal(r.row.body,'original access log');assert.equal((r.row.attributes as any).website_id,undefined);
 assert.equal((r.row.attributes as any).unregistered_website_id,'deleted-site');assert.equal((r.row as any).service,'entry');
 assert.throws(()=>bindApplicationRows(db,'foreign-agent',[row('deleted-site')],s=>s),/ownership/);
 db.run("UPDATE ops_platform_resources SET spec_cipher=? WHERE id='gateway'",JSON.stringify({role:'generic'}));assert.throws(()=>bindApplicationRows(db,'agent',[row('deleted-site')],s=>s),/website_observation_ownership/);
});
test('managed website ownership follows saved service deployments while foreign clusters are refused',t=>{
 const db=fixture(t);db.run('INSERT INTO ops_platform_resources VALUES(?,?,?)','service','application',JSON.stringify({deployments:[{cluster_id:'cluster'}]}));
 db.run('INSERT INTO ops_platform_resources VALUES(?,?,?)','site','website',JSON.stringify({routing_mode:'managed',service_application_id:'service',cluster_ids:[]}));
 assert.doesNotThrow(()=>bindApplicationRows(db,'agent',[row('site')],s=>s));
 db.run("UPDATE ops_platform_resources SET spec_cipher=? WHERE id='service'",JSON.stringify({deployments:[{cluster_id:'foreign'}]}));assert.throws(()=>bindApplicationRows(db,'agent',[row('site')],s=>s),/website_observation_ownership/);
});
test('one rejected log leaves its cursor and batch intact while metrics drain and retry survives',async t=>{
 const db=new DB(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE batches(id TEXT,signal TEXT,payload BLOB,created_at TEXT);CREATE TABLE log_cursors(id TEXT,offset INTEGER);INSERT INTO log_cursors VALUES(\'stdout\',42)');
 for(const [id,signal] of [['log1','logs'],['metric1','metrics'],['log2','logs']])db.run('INSERT INTO batches VALUES(?,?,?,?)',id,signal,Buffer.from(id),'2026-11-04');
 const sent:string[]=[];const errors=await flushObservationBatches(db,async b=>{sent.push(b.id);if(b.signal==='logs')throw Error('executor_http_403')},new AbortController().signal);
 assert.deepEqual(sent,['metric1','log1']);assert.deepEqual(errors,['executor_http_403']);assert.equal(db.get<any>('SELECT offset FROM log_cursors')!.offset,42);assert.equal(db.get<any>('SELECT count(*) n FROM batches')!.n,2);
 await flushObservationBatches(db,async b=>{sent.push(b.id)},new AbortController().signal);assert.equal(db.get<any>('SELECT count(*) n FROM batches')!.n,0);assert.deepEqual(sent.slice(-2),['log1','log2']);
});
test('collection status cannot carry raw secrets or unexpected fields',()=>{
 const status={state:'degraded',attempted_at:new Date().toISOString(),last_success_at:'',error:'executor_http_403',queue_batches:1,queue_bytes:10};assert.deepEqual(applicationObservation(status),status);
 assert.throws(()=>applicationObservation({...status,error:'password=secret'}),/invalid_application_observation/);assert.throws(()=>applicationObservation({...status,secret:'private'}),/invalid_application_observation/);assert.equal(observationDiagnostic(Error('Bearer private')),'application_collection_failed');
});
test('a full log backlog cannot consume the metric reserve',t=>{
 const db=new DB(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE batches(id TEXT,signal TEXT,payload BLOB,created_at TEXT)');
 db.run("INSERT INTO batches VALUES('backlog','logs',zeroblob(?),'2026-11-04')",28<<20);
 assert.throws(()=>saveObservationBatch(db,'new-log','logs',Buffer.from('line')),/observation_queue_full/);
 assert.doesNotThrow(()=>saveObservationBatch(db,'new-metric','metrics',Buffer.from('metric')));
 assert.equal(db.get<any>("SELECT count(*) n FROM batches WHERE signal='metrics'")!.n,1);
});
test('SDK and website queries pass the real read-only AST and retain fixed identity filters',async()=>{
 const tables:any[]=[{name:'metric_custom_gauge',logical_name:'custom',kind:'metric',metric_type:'gauge',system:false,columns:[]},{name:'metric_custom_histogram',logical_name:'custom',kind:'metric',metric_type:'histogram',system:false,columns:[]},{name:'log_business',logical_name:'business',kind:'log',system:false,columns:[]},{name:'log_lightmoni_application',logical_name:'lightmoni_application',kind:'log',system:true,columns:[]}];
 const executed:string[]=[];const reader:any={query:async(sql:string)=>{executed.push(sql);return {meta:[],data:[],rows:0}}};const executor=new Executor(reader,{list:async()=>tables} as any);
 const sdk=sdkTelemetryQueries(tables,"app'one",'event_time>=now()-INTERVAL 1 HOUR',{deployment_id:'instance',cluster_id:'cluster'});
 const queries=[...sdk.queries,...websiteTelemetryQueries('site','event_time>=now()-INTERVAL 1 HOUR')];
 const result=await executor.execute({source:'test',range:{from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()},interval_ms:60000,queries});
 assert(result.results.every(r=>r.status==='empty'),JSON.stringify(result.results));assert.equal(executed.length,4);
 assert.match(sdk.queries[0].sql,/lightmoni.application_id/);assert.match(sdk.queries[0].sql,/instance_id='instance'/);assert.doesNotMatch(sdk.queries[1].sql,/FROM `log_lightmoni_application`/);
 assert.match(queries[3].sql,/website_id.*site/);
});
