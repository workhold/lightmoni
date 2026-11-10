import test from 'node:test';
import assert from 'node:assert/strict';
import {sdkTelemetryQueries} from '../src/ops/telemetry-queries.js';
import {Executor} from '../src/server/query.js';

const range={from:'2026-11-10T00:00:17.123Z',to:'2026-11-10T01:00:17.123Z'};
const time=`event_time>=parseDateTime64BestEffort('${range.from}') AND event_time<parseDateTime64BestEffort('${range.to}')`;
const tables:any[]=[
 {name:'metric_business_histogram',logical_name:'business',kind:'metric',metric_type:'histogram',system:false,columns:[{name:'window_seconds'}]},
 {name:'metric_business_gauge',logical_name:'business',kind:'metric',metric_type:'gauge',system:false,columns:[]},
 {name:'log_business',logical_name:'business',kind:'log',system:false,columns:[]},
 {name:'metric_lightmoni_application_gauge',logical_name:'lightmoni_application',kind:'metric',metric_type:'gauge',system:true,columns:[]},
];
function fixture(periods:number[]){
 const reads:{sql:string;params:Record<string,string>}[]=[];
 const executor=new Executor({async query(sql:string,params:Record<string,string>){
  reads.push({sql,params:{...params}});
  if(sql.includes('groupUniqArray'))return {data:[{periods}],meta:[],rows:1};
  return {data:[{value:3}],meta:[{name:'value',type:'Float64'}],rows:1};
 }}as any,{list:async()=>tables}as any);
 const queries=sdkTelemetryQueries(tables,'app',time,{cluster_id:'cluster',deployment_id:'instance'}).queries;
 const execute=(source='application-monitoring',interval_ms=60000)=>executor.execute({range,interval_ms,source,queries});
 return {reads,queries,execute};
}
test('application SDK queries align actual fixed windows while keeping log and container ranges exact',async()=>{
 const f=fixture([30]);
 f.queries.push({refId:'load',sql:`SELECT avg(value) AS value FROM metric_lightmoni_application_gauge WHERE ${time} AND attributes['application_id']='app'`});
 const response=await f.execute();
 assert(response.results.every(r=>r.status==='success'),JSON.stringify(response.results));
 const metric=response.results.find(r=>r.refId==='sdk_metrics')!;
 assert.deepEqual(metric.frames[0].meta?.metric_window_alignment,{range:{from:'2026-11-10T00:00:00Z',to:'2026-11-10T01:00:00Z'},interval_ms:60000});
 for(const ref of ['load','sdk_logs'])assert.equal(response.results.find(r=>r.refId===ref)!.frames[0].meta,undefined);
 const metricRead=f.reads.find(r=>r.sql.includes('AS metric_type'))!;
 assert.equal(metricRead.params.__lm_from,'2026-11-10 00:00:00');
 assert.equal(metricRead.params.__lm_to,'2026-11-10 01:00:00');
 assert.doesNotMatch(metricRead.sql,/2026-11-10T00:00:17|toStartOfMinute/);
 assert.match(metricRead.sql,/toStartOfInterval/);
 const logs=f.reads.find(r=>r.sql.includes('log_business'))!;
 assert(logs.sql.includes(range.from));assert.equal(logs.params.__lm_from,'2026-11-10 00:00:17.123');
});
test('application SDK metrics use fixed window starts, preserving event times for non-windowed points',()=>{
 const f=fixture([30]),sql=f.queries.find(q=>q.refId==='sdk_metrics')!.sql;
 assert.match(sql,/if\(window_seconds>0,window_start,event_time\) AS metric_time/);
 assert.match(sql,/\$__timeFilter\(metric_time\)/);
 assert.match(sql,/\$__timeInterval\(metric_time\)/);
 assert.match(sql,/\$__timeFilter\(event_time\)/);
 assert.match(sql,/instance_id='instance'/);
 assert.match(sql,/lightmoni.cluster_id.*cluster/);
 const logs=f.queries.find(q=>q.refId==='sdk_logs')!.sql;
 assert(logs.includes(range.from));
});
test('application alignment handles all seven periods and mixed history without relaxing ordinary SQL',async()=>{
 for(const periods of [[10],[30],[60],[300],[600],[1800],[3600],[30,300]]){
  const f=fixture(periods),result=await f.execute();
  const metrics=result.results.find(r=>r.refId==='sdk_metrics')!;
  assert.equal(metrics.status,'success',JSON.stringify({periods,metrics}));
  const alignment=metrics.frames[0].meta!.metric_window_alignment;
  for(const seconds of periods){assert.equal(Date.parse(alignment.range.from)%(seconds*1000),0);assert.equal(Date.parse(alignment.range.to)%(seconds*1000),0);assert.equal(alignment.interval_ms%(seconds*1000),0)}
  for(const source of ['explore','application-monitoring-other'])assert.equal((await f.execute(source)).results.find(r=>r.refId==='sdk_metrics')!.status,'error');
 }
 for(const interval of [0,-1,NaN])assert.equal((await fixture([30]).execute('application-monitoring',interval)).results[0].status,'error');
 const legacy=fixture([]),result=await legacy.execute();
 assert.equal(result.results[0].status,'success');assert.equal(result.results[0].frames[0].meta,undefined);
 assert.equal(legacy.reads.find(r=>r.sql.includes('AS metric_type'))!.params.__lm_from,'2026-11-10 00:00:17.123');
});
