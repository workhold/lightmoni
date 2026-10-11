import assert from 'node:assert/strict';
import test from 'node:test';
import {boundedMonitoringContext} from './assistant-context.ts';
const size=value=>Buffer.byteLength(JSON.stringify(value));

test('normal monitoring context preserves unsaved SQL, filters and range without mutating the source',()=>{
 const input={page:{path:'/dashboards/current',title:'监控大盘'},dashboard_id:'current',range:{from:'2026-10-11T00:00:00Z',to:'2026-10-11T01:00:00Z'},panels:[{id:'a',title:'错误数',type:'stat',queries:[{refId:'A',sql:'SELECT count() FROM log_app'}]}],variables:{service:'orders'},filters:[{field:'severity',value:'ERROR'}]};
 const output=boundedMonitoringContext(input);
 assert.deepEqual(output,input);assert.notEqual(output,input);assert.notEqual(output.panels,input.panels);
});

test('large multibyte SQL and selected logs are bounded by UTF-8 byte size and mark truncation',()=>{
 const text='日志上下文🙂'.repeat(10000),input={query:{sql:text},selected_logs:[{body:text}],table:'log_app'};
 const output=boundedMonitoringContext(input);
 assert.ok(size(output)<=28000);assert.equal(output.context_truncated,true);assert.equal(input.query.sql,text);assert.equal(output.table,'log_app');
});

test('oversized parameter keys fall back to an already reduced page snapshot',()=>{
 const input={page:{path:'/query?sql='+'中'.repeat(40000),title:'SQL 工作台'},query:{sql:'SELECT 1',params:{['巨大参数名'.repeat(10000)]:{type:'String',value:'x'}}},table:'log_app'};
 const output=boundedMonitoringContext(input);
 assert.ok(size(output)<=28000);assert.equal(output.context_truncated,true);assert.equal(output.table,'log_app');assert.equal(output.query,undefined);
});
