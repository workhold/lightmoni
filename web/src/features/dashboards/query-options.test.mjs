import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const {durationMS,panelIntervalFor,queryOptions,sqlAggregation,changeSQLAggregation}=loadSource(new URL('./query-options.ts',import.meta.url));
const range={from:'2026-10-11T00:00:00Z',to:'2026-10-11T01:00:00Z'};

test('fixed bucket width is independent of reporting cadence, viewport and point target',()=>{
 for(const width of [200,1400]){
  assert.equal(panelIntervalFor(range,{query_interval:'1m',query_min_interval:'5m',query_max_points:10},width),60000);
  assert.equal(panelIntervalFor(range,{query_interval:'5min'},width),300000);
 }
 assert.equal(durationMS('30s'),30000);assert.equal(durationMS(' 1min '),60000);
});
test('Grafana auto rounding responds to range and pixel width, respects the minimum and fixed resolution',()=>{
 assert.equal(panelIntervalFor(range,{},600),5000);
 assert.equal(panelIntervalFor(range,{},120),30000);
 assert.equal(panelIntervalFor(range,{query_min_interval:'30s'},1400),30000);
 assert.equal(panelIntervalFor(range,{query_max_points:12},200),300000);
 assert.equal(panelIntervalFor(range,{query_max_points:12},1400),300000);
 assert.equal(panelIntervalFor({...range,to:'2026-10-12T00:00:00Z'},{},600),120000);
});
test('invalid query options reject before execution; unrelated visual settings do not affect resolution',()=>{
 for(const query_interval of ['0s','-1m','1','1.5m','1M','auto;SELECT 1','366d'])assert.throws(()=>panelIntervalFor(range,{query_interval}));
 for(const query_max_points of [0,1.5,10001,'100',null])assert.throws(()=>panelIntervalFor(range,{query_max_points}));
 assert.throws(()=>panelIntervalFor({from:'bad',to:'bad'},{}));
 assert.deepEqual(queryOptions({query_interval:'5m',unit:'ms',left_max:100}),{query_interval:'5m',query_min_interval:undefined,query_max_points:undefined});
});
test('switching raw sample aggregation preserves time buckets, labels, parameters and unit conversion',()=>{
 const sql="SELECT $__timeInterval(start_time) AS time, service AS series, avg(duration_ns)/1000000 AS value FROM trace_app WHERE $__timeFilter(start_time) AND service={service:String} GROUP BY time,series ORDER BY time";
 assert.equal(sqlAggregation(sql).value,'avg');
 const p95=changeSQLAggregation(sql,'p95');assert.equal(p95,sql.replace('avg(duration_ns)','quantileExact(0.95)(duration_ns)'));
 assert.equal(sqlAggregation(p95).value,'p95');assert.equal(changeSQLAggregation(p95,'max'),sql.replace('avg(duration_ns)','max(duration_ns)'));
 for(const value of ['avg','min','sum','count','p50','p90','p99'])assert.equal(sqlAggregation(changeSQLAggregation(sql,value)).value,value);
});
test('comments, quoted identifiers and nested scalar expressions survive aggregation changes',()=>{
 const sql="SELECT $__timeInterval(event_time) AS time, concat(service, 'avg(value)') AS series, sum(toDecimal256(value_int,0) /* max(fake) */) AS value FROM metric_app_sum WHERE $__timeFilter(event_time) GROUP BY time,series";
 const changed=changeSQLAggregation(sql,'p95');
 assert.ok(changed.includes("concat(service, 'avg(value)')"));assert.ok(changed.includes('quantileExact(0.95)(toDecimal256(value_int,0) /* max(fake) */)'));
 assert.equal(sqlAggregation('SELECT avg(`value`) AS value FROM metric_app').sample,'`value`');
});
test('weighted, nested, multi-aggregate, windowed, count-star and other custom SQL require explicit SQL editing',()=>{
 for(const sql of [
  'SELECT sum(sum)/nullIf(sum(count),0) AS value FROM metric_histogram',
  'SELECT avg(value) AS a, max(value) AS b FROM metric_app',
  'SELECT avg(value) FROM (SELECT avg(value) AS value FROM metric_app)',
  'WITH samples AS (SELECT value FROM metric_app) SELECT avg(value) FROM samples',
  'SELECT avg(value) OVER () FROM metric_app',
  'SELECT count() FROM log_app',
  'SELECT count(*) FROM log_app',
  'SELECT count(DISTINCT value) FROM metric_app',
  'SELECT quantile(0.95)(value) FROM metric_app',
  'SELECT quantileExact(0.8)(value) FROM metric_app',
  "SELECT 'avg(value)' FROM metric_app",
 ]){assert.equal(sqlAggregation(sql),undefined,sql);assert.throws(()=>changeSQLAggregation(sql,'p95'));}
 assert.throws(()=>changeSQLAggregation('SELECT avg(value) FROM metric_app','sql-injection'));
});
