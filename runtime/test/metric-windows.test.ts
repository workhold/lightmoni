import {test}from'node:test';import assert from'node:assert/strict';
import{metricWindow,copyMetricWindows,metricPeriods}from'../../sdk/typescript/src/windows.js';
import{parse,format}from'@clickhouse/parser';import{expandMetricFunctions}from'../src/server/metric-query.js';
import{normalize,mergeMetricWindows,stamp}from'../src/server/ingest.js';import{createLightMoni,type FrozenBatch}from'@lightmoni/sdk';
import{DB}from'../src/shared/sqlite.js';import{registerMetricWindows,windowHistory}from'../src/server/metric-windows.js';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import { Executor } from '../src/server/query.js';
test('UTC windows have fixed epoch boundaries for every supported period and activate policies atomically',()=>{
 const at=BigInt(Date.parse('2026-10-19T04:00:17.999Z'))*1000000n;
 for(const seconds of metricPeriods){const p=copyMetricWindows({business:[{seconds,effective_at:0}]});const w=metricWindow(p,'business',at);assert.equal(w.start%(BigInt(seconds)*1000000000n),0n);assert.ok(w.start<=at&&at<w.start+BigInt(seconds)*1000000000n);}
 const effective=1800000000;const p=copyMetricWindows({business:[{seconds:30,effective_at:0},{seconds:300,effective_at:effective}]});assert.equal(metricWindow(p,'business',BigInt(effective-1)*1000000000n).seconds,30);assert.equal(metricWindow(p,'business',BigInt(effective)*1000000000n).seconds,300);
 for(const v of [{business:[{seconds:20,effective_at:0}]},{business:[{seconds:30,effective_at:1}]},{business:[{seconds:30,effective_at:0},{seconds:60,effective_at:0}]}])assert.throws(()=>copyMetricWindows(v));
});
test('window configuration schedules at a common future boundary and preserves current history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lm-window-'));const db=new DB(join(dir,'state.db'));const handlers:Record<string,any>={};
 try{registerMetricWindows({db,auth:{requireAdmin(){}},router:{get(p:string,f:any){handlers['GET '+p]=f;},put(p:string,f:any){handlers['PUT '+p]=f;}}}as any);const before=Math.floor(Date.now()/1000);let result:any;
 await handlers['PUT /api/v1/metric-windows/:table']({params:{table:'business'},body:async()=>({window_seconds:300}),json:(v:any)=>result=v});const future=result.history.at(-1);assert.ok(future.effective_at>=before+60);assert.equal(future.effective_at%300,0);assert.equal(future.seconds,300);assert.equal(windowHistory(db,'business')[0].seconds,30);
 await assert.rejects(()=>handlers['PUT /api/v1/metric-windows/:table']({params:{table:'business'},body:async()=>({window_seconds:20})}));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('metric helpers expand as AST expressions and preserve SQL aliases and qualified columns',()=>{
 const sql=format(expandMetricFunctions(parse("SELECT p995(t.distribution) AS tail, metric_max(t.distribution) AS high, 'p95(distribution)' AS literal FROM business AS t")));
 assert.match(sql,/quantileExactWeightedArray\(0\.995\)/);assert.match(sql,/t\.distribution/);assert.match(sql,/AS tail/);assert.match(sql,/'p95\(distribution\)'/);assert.doesNotMatch(sql,/metric_max\(/);
 assert.throws(()=>expandMetricFunctions(parse('SELECT p95(distribution,1) FROM business')));
});
test('one SDK batch combines complementary points into one aligned window with compact bounded distribution',async()=>{
 const batches:FrozenBatch[]=[];const client=createLightMoni({service:'window-test',env:'test',remoteConfig:false,selfTelemetry:false,exporter:{async deliver(b){batches.push(b);}}});
 for(const value of [1e-200,1e200,-1e-200,-1e200,0])client.record('business','range',{},value,1);
 client.record('business','range',{},100,5);await client.shutdown();
 const rows=mergeMetricWindows(batches.flatMap(b=>normalize('metrics',JSON.parse(new TextDecoder().decode(b.payload)),stamp(BigInt(Date.now())*1000000n),'key')));assert.equal(rows.length,1);const r=rows[0].row;assert.equal(r.window_seconds,30);assert.equal(Date.parse(r.window_start.replace(' ','T')+'Z')%30000,0);assert.equal(r.count,'10');assert.equal(r.distribution_count,'5');assert.equal(r.min,null);assert.equal(r.max,null);assert.equal(r.sum,100);assert.ok(r.positive_counts.length+r.negative_counts.length<=1024);assert.deepEqual(r.bucket_values,[]);assert.deepEqual(r.bucket_counts,[]);
});

test('each table selects one of seven periods, preserves pending activation and can cancel it', async () => {
 const db = new DB(':memory:');
 const handlers: Record<string, any> = {};
 let timestamp = 1800000017;
 registerMetricWindows({db, now:()=>new Date(timestamp*1000), auth:{requireAdmin(){}}, router:{get(p:string,f:any){handlers['GET '+p]=f;},put(p:string,f:any){handlers['PUT '+p]=f;}}} as any);
 const request = async (table:string, body?:unknown) => {
  let response:any;
  await handlers[(body===undefined?'GET ':'PUT ')+'/api/v1/metric-windows/:table']({params:{table},body:async()=>body,json:(value:any)=>response=value});
  return response;
 };
 try {
  const initial=await request('business');
  assert.equal(initial.default_seconds,30);
  assert.deepEqual(initial.periods,[10,30,60,300,600,1800,3600]);
  for(const [index,seconds] of initial.periods.entries()) {
   assert.ok(initial.periods.slice(0,index).every((smaller:number)=>seconds%smaller===0));
   const policy=await request('table_'+seconds,{window_seconds:seconds});
   assert.equal(policy.history.at(-1).seconds,seconds);
   if(seconds!==30){const next=policy.history.at(-1);assert.ok(next.effective_at>=timestamp+60);assert.equal(next.effective_at%seconds,0);assert.equal(next.effective_at%30,0);}
  }
  const pending=(await request('business',{window_seconds:300})).history.at(-1);
  timestamp+=20;
  assert.deepEqual((await request('business',{window_seconds:300})).history.at(-1),pending);
  assert.deepEqual((await request('business',{window_seconds:30})).history,[{seconds:30,effective_at:0}]);
  assert.equal((await request('table_10')).history.at(-1).seconds,10);
  for(const body of [null,[],30,{},{window_seconds:[10,30]},{window_seconds:'30'},{window_seconds:true},{window_seconds:20},{window_seconds:120},{window_seconds:30,other:1}]) {
   await assert.rejects(request('business',body),(error:any)=>error.status===400);
  }
  assert.deepEqual((await request('business')).history,[{seconds:30,effective_at:0}]);
 } finally {db.close();}
});

test('queries enforce actual window multiples, align dashboard ranges and preserve legacy data', async () => {
 let periods:number[]=[30];
 const reads:{sql:string;params:any}[]=[];
 const executor=new Executor({async query(sql:string,params:any){
  if(sql.includes('groupUniqArray'))return {data:[{periods}],meta:[],rows:1};
  reads.push({sql,params:{...params}});
  return {data:[{value:3}],meta:[{name:'value',type:'Float64'}],rows:1};
 }} as any,{async list(){return [{name:'metric_business_histogram',logical_name:'business',kind:'metric',metric_type:'histogram',system:false,columns:[{name:'window_seconds'}]}];}} as any);
 const range={from:'2026-10-19T00:00:00Z',to:'2026-10-19T01:00:00Z'};
 const execute=async(interval_ms:number,source?:string,queryRange=range)=>(await executor.execute({range:queryRange,interval_ms,source,queries:[{refId:'A',sql:'SELECT sum(value) AS value FROM business WHERE $__timeFilter(window_start)'}]})).results[0];
 for(const interval of [30000,60000,300000])assert.equal((await execute(interval)).status,'success');
 for(const interval of [10000,45000,0,-30000])assert.equal((await execute(interval)).status,'error');
 assert.equal((await execute(60000,undefined,{from:'2026-10-19T00:00:01Z',to:range.to})).status,'error');
 periods=[30,300];
 assert.equal((await execute(60000)).status,'error');
 assert.equal((await execute(300000)).status,'success');
 const dashboard=await execute(10000,'dashboard-panel',{from:'2026-10-19T00:00:17Z',to:'2026-10-19T01:00:17Z'});
 assert.equal(dashboard.status,'success');
 assert.equal(dashboard.frames[0].meta?.metric_window_alignment.interval_ms,300000);
 assert.equal(reads.at(-1)?.params.__lm_interval,'300000');
 assert.equal(reads.at(-1)?.params.__lm_from,'2026-10-19 00:00:00');
 periods=[];
 assert.equal((await execute(10000,undefined,{from:'2026-10-19T00:00:01Z',to:range.to})).status,'success');
});
