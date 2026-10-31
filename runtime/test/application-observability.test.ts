import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {DB} from '../src/shared/sqlite.js';
import {SystemLogs} from '../src/server/system-logs.js';
import {ApplicationObserver,dockerBytes} from '../src/agent/application-observer.js';
import {applicationTargets,bindApplicationRows,dockerInventory} from '../src/shared/application-observation.js';
import {defaultConfig} from '../src/agent/config.js';
import {createAgent} from '../src/agent/agent.js';
import {decodeOTLP,nowNano,formatNanoTime} from '../src/shared/otlp.js';
import {Catalog} from '../src/server/catalog.js';
import {systemTable} from '../src/server/auth.js';
function dbFixture(t:any){const db=new DB(':memory:');t.after(()=>db.close());return db;}
test('certificate step journal projects ordered safe diagnostics through the transactional system log outbox',async t=>{
 const db=dbFixture(t);db.exec('CREATE TABLE ops_platform_run_events(id TEXT PRIMARY KEY,run_id TEXT,resource_id TEXT,resource_kind TEXT,resource_revision INTEGER,sequence INTEGER,phase TEXT,state TEXT,detail_json TEXT,created_at TEXT)');
 const rows:any[]=[],logs=new SystemLogs({db,now:()=>new Date()} as any,{internal:async(_table:string,batch:any[])=>{rows.push(...batch)}} as any);
 const insert=()=>db.run('INSERT INTO ops_platform_run_events VALUES(?,?,?,?,?,?,?,?,?,?)','event','run','cert','certificate',2,3,'challenge_verify','failed',JSON.stringify({domain:'example.test',message:'DNS lookup failed token=synthetic-private',code:'acme_issuance_failed',error_type:'urn:ietf:params:acme:error:dns',http_status:400,request_id:'ca-request',private_key_pem:'never-copy'}),new Date().toISOString());
 assert.throws(()=>db.transaction(()=>{insert();throw Error('rollback')}));assert.equal(db.get<any>('SELECT COUNT(*) n FROM system_log_outbox')!.n,0);
 insert();assert.doesNotMatch(db.get<any>('SELECT payload FROM system_log_outbox')!.payload,/synthetic-private|never-copy/);
 await logs.publish();assert.equal(rows.length,1);const attrs=rows[0].row.attributes;
 assert.equal(attrs.run_id,'run');assert.equal(attrs.resource_kind,'certificate');assert.equal(attrs.phase,'challenge_verify');assert.equal(attrs.domain,'example.test');assert.equal(attrs.http_status,'400');assert.equal(attrs.request_id,'ca-request');assert.equal(rows[0].row.severity,'WARN');
 assert.match(rows[0].row.body,/DNS lookup failed/);assert.doesNotMatch(JSON.stringify(rows),/synthetic-private|never-copy/);
 await logs.publish();assert.equal(rows.length,1);
});
function agentFixture(t:any){const dir=mkdtempSync(join(tmpdir(),'lm-044-agent-'));const agent=createAgent({...defaultConfig(),data_dir:dir,endpoint:'http://127.0.0.1:1',control_credential:'test-control',data_credential:'test-data',listen:'127.0.0.1:0',min_free_bytes:0,collect_interval_seconds:3600});t.after(async()=>{await agent.close();rmSync(dir,{recursive:true,force:true});});return agent;}
const target={deployment_id:'instance-a',application_id:'app-a',cluster_id:'cluster-a',machine_id:'machine-a',service_name:'orders',role:'generic'};
const container={id:'a'.repeat(64),name:'orders-app-1',image:'orders:1',state:'running',ports:'8080',deployment_id:target.deployment_id};
test('transactional system log outbox retries, backfills idempotently, excludes secrets and rolls back with state',async t=>{
 const db=dbFixture(t);db.exec(`CREATE TABLE ops_platform_resources(id TEXT,kind TEXT,spec_cipher TEXT);INSERT INTO ops_platform_resources VALUES('r','application','{}');CREATE TABLE ops_platform_runs(id TEXT,resource_id TEXT,resource_revision INTEGER,agent_id TEXT,action TEXT,state TEXT,actor TEXT,created_at TEXT,updated_at TEXT,result_json TEXT,payload_cipher TEXT);`);
 db.run('INSERT INTO ops_platform_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)','run','r',1,'agent','deploy','queued','admin',new Date().toISOString(),new Date().toISOString(),'{}','never-log-this-secret');
 const sent:any[]=[];let unavailable=true;const deps:any={db,now:()=>new Date()};const ingest:any={internal:async(table:string,rows:any[])=>{if(unavailable)throw Error('offline');sent.push({table,rows});}};const logs=new SystemLogs(deps,ingest,['synthetic-password']);
 await assert.rejects(logs.publish(),/offline/);assert.equal(db.get<any>('SELECT delivered FROM system_log_outbox')!.delivered,0);
 unavailable=false;await logs.publish();assert.equal(sent.length,1);assert.equal(sent[0].table,'lightmoni');assert.equal(sent[0].rows[0].row.attributes['lightmoni.component'],'operations');assert.doesNotMatch(JSON.stringify(sent),/never-log-this-secret/);
 db.run("UPDATE ops_platform_runs SET state='succeeded',result_json=? WHERE id='run'",JSON.stringify({cluster_id:'cluster-a'}));await logs.publish();assert.equal(sent[1].rows[0].row.attributes.cluster_id,'cluster-a');
 await new SystemLogs(deps,ingest).publish();assert.equal(sent.length,2);
 assert.throws(()=>db.transaction(()=>{db.run("UPDATE ops_platform_runs SET state='failed' WHERE id='run'");throw Error('rollback');}));await logs.publish();assert.equal(sent.length,2);
 logs.record('error','password=synthetic-password Bearer private-token');await logs.publish();assert.doesNotMatch(sent[2].rows[0].row.body,/synthetic-password|private-token/);
});
test('three applications share exactly one independent gauge and one log physical table',async t=>{
 const db=dbFixture(t),ddl:string[]=[];const ch:any={user:'writer',exec:async(sql:string)=>{ddl.push(sql)},query:async()=>({meta:[],data:[],rows:0})};const cat=new Catalog(db,ch,{...ch,user:'reader'});
 for(const service of ['a','b','c']){await cat.ensure('lightmoni_application','metric','gauge',service);await cat.ensure('lightmoni_application','log','',service);}
 assert.equal(ddl.filter(s=>s.startsWith('CREATE TABLE IF NOT EXISTS _lm_metric_lightmoni_application_gauge')).length,1);assert.equal(ddl.filter(s=>s.startsWith('CREATE TABLE IF NOT EXISTS _lm_log_lightmoni_application')).length,1);assert.equal((await cat.list()).filter(t=>t.logical_name==='lightmoni_application').length,2);assert(systemTable('lightmoni_application'));
});
test('revision backfill uses the whole primary key so simultaneous resource revisions remain distinct',async t=>{
 const db=dbFixture(t);db.exec(`CREATE TABLE ops_platform_resources(id TEXT,kind TEXT);CREATE TABLE ops_platform_revisions(resource_id TEXT,revision INTEGER,created_at TEXT,PRIMARY KEY(resource_id,revision));INSERT INTO ops_platform_revisions VALUES('app-a',1,'2026-10-30T00:00:00Z'),('app-b',1,'2026-10-30T00:00:00Z');`);
 const rows:any[]=[];const logs=new SystemLogs({db,now:()=>new Date()} as any,{internal:async(_table:string,batch:any[])=>{rows.push(...batch)}} as any);
 await logs.publish();assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.row.event_id)).size,2);assert.deepEqual(new Set(rows.map(r=>r.row.attributes.resource_id)),new Set(['app-a','app-b']));
 await new SystemLogs({db,now:()=>new Date()} as any,{internal:async()=>assert.fail('duplicate revision replay')} as any).publish();
});
test('job explanations reach shared logs with credentials redacted and without snapshots or terminal output',async t=>{
 const db=dbFixture(t);db.exec(`CREATE TABLE agent_job_events(job_id TEXT,sequence INTEGER,phase TEXT,summary TEXT,snapshot_json TEXT,occurred_at TEXT,PRIMARY KEY(job_id,sequence));`);
 db.run('INSERT INTO agent_job_events VALUES(?,?,?,?,?,?)','job',1,'failed','preflight failed token=private-value','{"terminal":"never-copy-terminal"}',new Date().toISOString());
 const rows:any[]=[];const logs=new SystemLogs({db,now:()=>new Date()} as any,{internal:async(_table:string,batch:any[])=>{rows.push(...batch)}} as any);
 assert.doesNotMatch(db.get<any>('SELECT payload FROM system_log_outbox')!.payload,/private-value|never-copy-terminal/);await logs.publish();assert.match(rows[0].row.body,/preflight failed token=\[redacted\]/);assert.doesNotMatch(JSON.stringify(rows),/private-value|never-copy-terminal/);
});
test('auth, node, terminal, alert and assistant audit metadata share the system log pipeline',async t=>{
 const db=dbFixture(t),at='2026-10-30T00:00:00Z';db.exec(`CREATE TABLE key_events(id INTEGER PRIMARY KEY,key_id TEXT,at TEXT,status TEXT,detail TEXT);CREATE TABLE agent_lifecycle_events(id TEXT PRIMARY KEY,agent_id TEXT,event TEXT,occurred_at TEXT);CREATE TABLE machine_terminal_events(id TEXT PRIMARY KEY,machine_id TEXT,created_at TEXT,connected_at TEXT,closed_at TEXT);CREATE TABLE alert_events(id TEXT PRIMARY KEY,rule_id TEXT,created_at TEXT,body TEXT);CREATE TABLE alert_response_events(id TEXT PRIMARY KEY,response_id TEXT,at TEXT,body TEXT);CREATE TABLE assistant_alert_audit(proposal_id TEXT PRIMARY KEY,actor_id TEXT,operation TEXT,target_id TEXT,applied_at TEXT,receipt TEXT);`);
 db.run('INSERT INTO key_events VALUES(?,?,?,?,?)',1,'key',at,'rejected','private-detail');db.run('INSERT INTO agent_lifecycle_events VALUES(?,?,?,?)','node-event','agent','removed',at);db.run('INSERT INTO alert_events VALUES(?,?,?,?)','alert','rule',at,'{"kind":"firing","message":"private-notification"}');db.run('INSERT INTO alert_response_events VALUES(?,?,?,?)','response-event','response',at,'{"kind":"claimed","message":"private-contact"}');db.run('INSERT INTO assistant_alert_audit VALUES(?,?,?,?,?,?)','proposal','admin','create','rule',at,'encrypted-private-receipt');
 const rows:any[]=[];const logs=new SystemLogs({db,now:()=>new Date()} as any,{internal:async(_table:string,batch:any[])=>{rows.push(...batch)}} as any);
 db.run('INSERT INTO machine_terminal_events VALUES(?,?,?,?,?)','terminal','machine',at,'','');db.run('UPDATE machine_terminal_events SET connected_at=? WHERE id=?','2026-10-30T00:01:00Z','terminal');db.run('UPDATE machine_terminal_events SET closed_at=? WHERE id=?','2026-10-30T00:02:00Z','terminal');await logs.publish();
 assert.equal(rows.length,8);assert.equal(rows.filter(r=>r.row.attributes.source==='machine_terminal_events').length,3);assert.deepEqual(new Set(rows.map(r=>r.row.attributes['lightmoni.component'])),new Set(['auth','agent','operations','alerts','assistant']));assert.doesNotMatch(JSON.stringify(rows),/private-/);assert(rows.some(r=>r.row.attributes.event==='firing'));
});
test('task-center state, cancellation and resolution reach system logs without script output',async t=>{
 const db=dbFixture(t),at='2026-10-30T00:00:00Z';db.exec(`CREATE TABLE task_runs(id TEXT PRIMARY KEY,task_id TEXT,host_id TEXT,agent_id TEXT,state TEXT,cancel_requested INTEGER,summary TEXT,stdout TEXT,stderr TEXT,snapshot_json TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,resolved_at TEXT,resolved_by TEXT);`);
 db.run('INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)','run','task','machine','agent','queued',0,'','private-stdout','private-stderr','private-script',at,'','','','');const rows:any[]=[];
 const logs=new SystemLogs({db,now:()=>new Date()} as any,{internal:async(_table:string,batch:any[])=>{rows.push(...batch)}} as any);
 db.run("UPDATE task_runs SET state='running',started_at=?",'2026-10-30T00:01:00Z');db.run('UPDATE task_runs SET cancel_requested=1');db.run("UPDATE task_runs SET state='unknown',finished_at=?,summary='execution unknown token=private-token'",'2026-10-30T00:02:00Z');db.run('UPDATE task_runs SET resolved_at=?,resolved_by=?','2026-10-30T00:03:00Z','admin');await logs.publish();
 assert.equal(rows.length,5);assert(rows.every(r=>r.row.attributes['lightmoni.component']==='tasks'&&r.row.attributes.machine_id==='machine'));assert.doesNotMatch(JSON.stringify(rows),/private-/);assert.equal(new Set(rows.map(r=>r.row.event_id)).size,5);
});
test('authenticated deployment ownership overrides spoofed application/cluster/host and rejects foreign Agent',t=>{
 const db=dbFixture(t);db.exec(`CREATE TABLE agents(id TEXT,host_id TEXT);INSERT INTO agents VALUES('agent-a','host-a');CREATE TABLE ops_platform_resources(id TEXT,kind TEXT,spec_cipher TEXT);INSERT INTO ops_platform_resources VALUES('app-a','application','{}');CREATE TABLE ops_cluster_instances(id TEXT,owner_id TEXT,cluster_id TEXT,machine_id TEXT,agent_id TEXT);INSERT INTO ops_cluster_instances VALUES('instance-a','app-a','cluster-a','machine-a','agent-a');`);
 assert.equal(applicationTargets(db,'agent-b').length,0);const row=()=>({kind:'metric',subtype:'gauge',row:{service:'fake',host_id:'fake',attributes:{deployment_id:'instance-a',container_id:container.id,application_id:'fake',cluster_id:'fake'}}});const good=row();bindApplicationRows(db,'agent-a',[good]);assert.equal(good.row.attributes.application_id,'app-a');assert.equal(good.row.attributes.cluster_id,'cluster-a');assert.equal(good.row.host_id,'host-a');assert.equal(good.row.service,'app-a');assert.throws(()=>bindApplicationRows(db,'agent-b',[row()]),/ownership/);assert.throws(()=>bindApplicationRows(db,'agent-a',[{...row(),subtype:'sum'}]),/ownership/);
});
test('inventory allowlist retains external stopped Docker and omits private fields',()=>{
 const value=dockerInventory({state:'ready',observed_at:new Date().toISOString(),containers:[{...container,environment:'secret',command:'secret',labels:'secret',state:'exited',deployment_id:''}]})!;assert.equal(value.containers[0].state,'exited');assert.doesNotMatch(JSON.stringify(value),/secret/);assert.equal(dockerBytes('1.5GiB'),1.5*1024**3);assert.equal(dockerBytes('2 MB'),2e6);assert.equal(dockerBytes('bad'),undefined);
});
test('same-timestamp log lines resume from durable cursor; queue failure does not advance or skip data',async t=>{
 const agent=agentFixture(t),time=formatNanoTime(nowNano()-1000000000n);const read=async()=>({stdout:`${time} one\n${time} two\n${time} three\n`,stderr:''});const observer=new ApplicationObserver(agent,async()=>({stdout:'',stderr:''}),read);await observer.collectLogs(container,target);
 const first=agent.queue.next()!;const msg:any=decodeOTLP('logs',first.payload,first.content_type);assert.equal(msg.resourceLogs[0].scopeLogs[0].logRecords.length,3);const before=agent.queue.db.all('SELECT * FROM log_cursors');await observer.collectLogs(container,target);assert.deepEqual(agent.queue.db.all('SELECT * FROM log_cursors'),before);
 const newer=formatNanoTime(nowNano());const next=new ApplicationObserver(agent,async()=>({stdout:'',stderr:''}),async()=>({stdout:`${time} one\n${time} two\n${time} three\n${newer} four\n`,stderr:''}));const accept=agent.accept.bind(agent);agent.accept=()=>{throw Error('queue full')};await assert.rejects(next.collectLogs(container,target),/queue full/);assert.deepEqual(agent.queue.db.all('SELECT * FROM log_cursors'),before);agent.accept=accept;await next.collectLogs(container,target);assert.equal(agent.queue.db.all<any>('SELECT generation FROM log_cursors')[0].generation,1);
});
test('automatic Docker discovery records app gauges and does not adopt external containers',async t=>{
 const agent=agentFixture(t);let stats=false;const observer=new ApplicationObserver(agent,async(_file,args)=>{if(args.includes('stats')){stats=true;return {stdout:JSON.stringify({ID:container.id,CPUPerc:'2.4%',MemUsage:'32MiB / 1GiB',MemPerc:'3.12%',NetIO:'1MB / 2MB',BlockIO:'3MB / 4MB',PIDs:'5'})+'\n',stderr:''};}return {stdout:[{ID:container.id,Names:container.name,Image:container.image,State:'running',Ports:'',Labels:'io.lightmoni.platform.instance=instance-a'},{ID:'b'.repeat(64),Names:'external',Image:'busybox',State:'exited',Ports:'',Labels:''}].map(x=>JSON.stringify(x)).join('\n'),stderr:''};},async()=>({stdout:'',stderr:''}));observer.targets=[target];await observer.collect();assert(stats);assert.equal(observer.inventory?.containers.length,2);assert.equal(observer.inventory?.containers[1].deployment_id,'');await agent.sdk.flush({timeoutMs:1000});const batch=agent.queue.next()!;const msg:any=decodeOTLP('metrics',batch.payload,batch.content_type);assert.equal(batch.table,'lightmoni_application');assert(msg.resourceMetrics[0].scopeMetrics[0].metrics.some((m:any)=>m.name==='container.memory.used'));
});

test('large log backlog drains multiple batches without tail loss or duplicate cursor sequences',async t=>{
 const agent=agentFixture(t),time=formatNanoTime(nowNano()-1000000000n);const text=Array.from({length:600},(_,i)=>`${time} record-${i}\n`).join('');const observer=new ApplicationObserver(agent,async()=>({stdout:'',stderr:''}),async()=>({stdout:text,stderr:''}));await observer.collectLogs(container,target);let total=0,batch;const sequences:string[]=[];while((batch=agent.queue.next())){const msg:any=decodeOTLP('logs',batch.payload,batch.content_type);const rows=msg.resourceLogs[0].scopeLogs[0].logRecords;total+=rows.length;sequences.push(...rows.map((r:any)=>r.attributes.find((a:any)=>a.key==='lightmoni.source_seq').value.intValue));agent.queue.complete(batch.id);}assert.equal(total,600);assert.equal(new Set(sequences).size,600);await observer.collectLogs(container,target);assert.equal(agent.queue.next(),undefined);
});

test('bounded Docker reader resumes a multiline event larger than its byte cap and retains the final unterminated line',async t=>{
 const agent=agentFixture(t),time=formatNanoTime(nowNano()-1000000000n),dir=mkdtempSync(join(tmpdir(),'lm-044-docker-')),previousPath=process.env.PATH;
 const text=Array.from({length:400},(_,i)=>`${time} request-${i} ${'x'.repeat(900)}`).join('\n');
 writeFileSync(join(dir,'docker'),'#!'+process.execPath+'\nprocess.stdout.write('+JSON.stringify(text)+');\n',{mode:0o700});process.env.PATH=dir+delimiter+previousPath;
 t.after(()=>{process.env.PATH=previousPath;rmSync(dir,{recursive:true,force:true});});
 const observer=new ApplicationObserver(agent);let count=0;const bodies=new Set<string>();
 for(let pass=0;pass<4;pass++){
  await observer.collectLogs(container,target);let batch;
  while((batch=agent.queue.next())){const msg:any=decodeOTLP('logs',batch.payload,batch.content_type);for(const row of msg.resourceLogs[0].scopeLogs[0].logRecords){count++;bodies.add(row.body.stringValue);}agent.queue.complete(batch.id);}
 }
 assert.equal(count,400);assert.equal(bodies.size,400);assert(bodies.has('request-399 '+'x'.repeat(900)));
});
