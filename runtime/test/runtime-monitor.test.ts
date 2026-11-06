import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeMonitor } from '../src/server/monitor.js';
import type { Ingest, Normalized } from '../src/server/ingest.js';

test('center monitor delivers fresh runtime metrics and logs through the explicit internal sink',async()=>{
 const received:Normalized[]=[],tables:string[]=[];
 const monitor=new RuntimeMonitor({
  cat:{ensure:async()=>''},
  internal:async(table:string,rows:Normalized[])=>{tables.push(table);received.push(...rows);},
 } as unknown as Ingest,['private-monitor-secret']);
 try{
  await monitor.start();monitor.accepted('logs',3,120);monitor.request('logs',200,2.5);
  monitor.log('info','local internal message private-monitor-secret');await monitor.client.flush();
  assert.ok(tables.length>0,'internal callbacks must receive the collected metrics');
  assert.ok(tables.every(table=>table==='lightmoni'));
  for(const name of ['heartbeat','heap_bytes','active_resources','event_loop_delay_ms','pending_batches','dropped_records','ingest_requests','received_records','received_bytes','ingest_duration'])
   assert.ok(received.some(n=>n.kind==='metric'&&n.row.name==='lightmoni.center.'+name),name);
  const heartbeat=received.find(n=>n.row.name==='lightmoni.center.heartbeat')!;
  assert.equal(heartbeat.row.value_float,1);assert.equal(heartbeat.row.service,'lightmoni-center');
  assert.ok(Date.parse(heartbeat.row.event_time.replace(' ','T')+'Z')>Date.now()-10000);
  assert.ok(received.some(n=>n.kind==='log'&&n.row.body==='local internal message [redacted]'));
  assert.doesNotMatch(JSON.stringify(received),/private-monitor-secret/);
 }finally{await monitor.close();}
});
