import test from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {hostCapacity} from '../src/shared/host-capacity.js';
import {currentAgentCapacity} from '../src/server/agent-hosts.js';
import {publicTableName} from '../src/server/catalog.js';

test('optional capacity validates finite positive values and cannot claim zero hardware',()=>{
 assert.deepEqual(hostCapacity({}),{cpu_count:null,memory_total_mb:null});
 assert.deepEqual(hostCapacity({cpu_count:8,memory_total_mb:16384.5}),{cpu_count:8,memory_total_mb:16384.5});
 for(const cpu_count of [0,-1,1.5,'8',Infinity])assert.throws(()=>hostCapacity({cpu_count}));
 for(const memory_total_mb of [0,-1,NaN,Infinity,'16384'])assert.throws(()=>hostCapacity({memory_total_mb}));
});
test('capacity belongs only to current active Agent, retains stale timestamp and tolerates old or corrupt reports',()=>{
 const db=new DB(':memory:'),now=new Date('2026-11-09T00:00:00Z');
 try{
  db.exec("CREATE TABLE managed_machines(id TEXT,agent_id TEXT);CREATE TABLE agents(id TEXT,heartbeat TEXT,last_seen TEXT);CREATE TABLE agent_lifecycle(agent_id TEXT,state TEXT);INSERT INTO managed_machines VALUES('machine','current');");
  db.run('INSERT INTO agents VALUES(?,?,?)','current',JSON.stringify({cpu_count:8,memory_total_mb:16384}),now.toISOString());
  assert.deepEqual(currentAgentCapacity(db,'machine','current',now),{cpu_count:8,memory_total_mb:16384,observed_at:now.toISOString(),stale:false});
  assert.equal(currentAgentCapacity(db,'machine','current',new Date(now.getTime()+90001)).stale,true);
  assert.equal(currentAgentCapacity(db,'machine','previous',now).cpu_count,null);
  db.run("UPDATE agents SET heartbeat='{}'");assert.equal(currentAgentCapacity(db,'machine','current',now).observed_at,'');
  db.run("UPDATE agents SET heartbeat='broken'");assert.equal(currentAgentCapacity(db,'machine','current',now).cpu_count,null);
  db.run("UPDATE agents SET heartbeat=?",JSON.stringify({cpu_count:8,memory_total_mb:16384}));
  db.exec("INSERT INTO agent_lifecycle VALUES('current','removed')");assert.equal(currentAgentCapacity(db,'machine','current',now).cpu_count,null);
 }finally{db.close()}
});
test('center keeps canonical metric prefixes for every SDK wire subtype and legacy system namespace',()=>{
 for(const subtype of ['sum','gauge','histogram']){
  assert.equal(publicTableName('business','metric',subtype),`metric_business_${subtype}`);
  assert.equal(publicTableName('lightmoni','metric',subtype),`lightmoni_metric_${subtype}`);
  assert.equal(publicTableName('lightmoni_application','metric',subtype),`metric_lightmoni_application_${subtype}`);
 }
 assert.equal(publicTableName('business','log'),'log_business');
 assert.equal(publicTableName('business','trace'),'trace_business');
});
