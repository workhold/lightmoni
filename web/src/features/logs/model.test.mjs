import test from 'node:test';
import assert from 'node:assert/strict';
import {attributes,attributeType,sortRows,boundBuffer,csv,normalizeSpec,logFieldMetadata} from './model.ts';

test('large integer attributes retain every digit and original numeric type',()=>{
 const row={event_id:'one',attributes_json:'{"seq":18446744073709551615,"string":"18446744073709551615","quote":"x\\\"42","fraction":0.25}'};
 assert.equal(attributes(row).seq,'18446744073709551615');
 assert.equal(attributeType(row,'seq'),'number');assert.equal(attributeType(row,'string'),'string');
 assert.equal(attributes(row).quote,'x"42');assert.equal(attributes(row).fraction,0.25);
});
test('cached attributes invalidate when payload or malformed-JSON fallback changes',()=>{
 const row={event_id:'cached',attributes_json:'{"seq":18446744073709551615}'};
 assert.equal(attributes(row).seq,'18446744073709551615');assert.equal(attributeType(row,'seq'),'number');
 row.attributes_json='{"seq":"updated","ok":true}';
 assert.equal(attributes(row).seq,'updated');assert.equal(attributeType(row,'seq'),'string');assert.equal(attributeType(row,'ok'),'boolean');
 row.attributes_json='{broken';row.attributes={seq:42};
 assert.equal(attributes(row).seq,42);assert.equal(attributeType(row,'seq'),'number');
 row.attributes={seq:'fallback'};assert.equal(attributes(row).seq,'fallback');assert.equal(attributeType(row,'seq'),'string');
});
test('field metadata retains discovery order and the first available scalar type',()=>{
 const rows=[{event_id:'a',attributes_json:'{"status":200,"seq":18446744073709551615,"string":"123"}'},
  {event_id:'b',attributes_json:'{"status":"later","late":true}'},
  {event_id:'c',attributes_json:'{"later":0.25}'}];
 const meta=logFieldMetadata([{name:'event_time',type:'DateTime64'},{name:'attributes',type:'Map(String,String)'}],rows);
 assert.deepEqual(meta.names,['event_time','attributes','attr:status','attr:seq','attr:string','attr:late','attr:later']);
 assert.equal(meta.kinds.get('event_time'),'时间');assert.equal(meta.kinds.get('attributes'),'对象');
 assert.equal(meta.kinds.get('attr:status'),'数字');assert.equal(meta.kinds.get('attr:seq'),'数字');
 assert.equal(meta.kinds.get('attr:string'),'文本');assert.equal(meta.kinds.get('attr:late'),'布尔');
 const next=logFieldMetadata([],rows.slice(1));assert.equal(next.kinds.get('attr:status'),'文本');
 const fallback=logFieldMetadata([],[{event_id:'undefined',attributes_json:'broken',attributes:{optional:undefined}},
  {event_id:'defined',attributes_json:'{"optional":true}'}]);assert.equal(fallback.kinds.get('attr:optional'),'布尔');
});
test('live ordering retains nanoseconds, id tie-breaks and RFC3339 offset equivalence',()=>{
 const rows=[{event_id:'b',event_time:'2026-10-10T00:00:00.123456789Z'},{event_id:'a',event_time:'2026-10-10T08:00:00.123456789+08:00'},{event_id:'c',event_time:'2026-10-10T00:00:00.123456788Z'}];
 assert.deepEqual(sortRows(rows,'asc').map(r=>r.event_id),['c','a','b']);assert.deepEqual(sortRows(rows,'desc').map(r=>r.event_id),['b','a','c']);
});
test('UTF-8 byte budget and row cap never silently grow the realtime buffer',()=>{
 const rows=[{event_id:'1',body:'中文'.repeat(30)},{event_id:'2',body:'safe'}];
 assert.equal(boundBuffer(rows,10,100).truncated,true);assert.equal(boundBuffer(rows,10,100).rows.length,0);
 assert.deepEqual(boundBuffer(rows,1,10000).rows.map(r=>r.event_id),['1']);assert.equal(boundBuffer(rows,1,10000).truncated,true);
});
test('CSV preserves newlines and quotes, and neutralizes spreadsheet formulas',()=>{
 assert.equal(csv([{event_id:'1',body:'=HYPERLINK("evil")\n第二行'}],['body']),'"body"\r\n"\'=HYPERLINK(""evil"")\n第二行"');
});

test('partial form input receives current query defaults',()=>{
 const spec=normalizeSpec({table_id:'log_app',range:{from:'2026-10-10T00:00:00Z',to:'2026-10-10T01:00:00Z'},interval_ms:60000});assert.deepEqual(spec.services,[]);assert.deepEqual(spec.filters,[]);assert.equal(spec.keyword,'');assert.equal(spec.sql,'');assert.equal(spec.interval_ms,60000);
});

test('shared query links preserve typed filters, multiple services and absolute display settings',async()=>{
 const {initialSpec,initialView,logURL,readLogURL}=await import('./model.ts');
 const spec={...initialSpec('log_app'),range:{from:'2026-10-10T00:00:00.123456789Z',to:'2026-10-10T01:00:00Z'},services:['支付 api','worker'],keyword:'https://api:443 错误 *',filters:[{scope:'attribute',field:'seq',type:'number',op:'gte',value:'18446744073709551615'},{scope:'column',field:'severity',type:'string',op:'in',value:['ERROR','WARN'],disabled:true}],interval_ms:60000,sort:'asc'};
 const view={...initialView,columns:['body','attr:seq'],widths:{body:700},query_syntax:'literal',row_lines:3,fields_collapsed:true,refresh_seconds:10};
 const link=logURL(spec,'event-42',undefined,view),p=new URLSearchParams(link.split('?')[1]);
 const parsed=readLogURL(p.toString(),initialSpec(p.get('table')));
 assert.deepEqual(parsed.spec,spec);assert.equal(parsed.view.row_lines,3);assert.equal(parsed.view.refresh_seconds,0);assert.equal(parsed.view.lookback,0);assert.equal(p.get('event'),'event-42');assert.deepEqual(parsed.view.columns,view.columns);
 assert.equal(p.has('session'),false);assert.equal(p.has('key'),false);
});
test('simple query links work and malformed sharing payloads never silently broaden a query',async()=>{
 const {initialSpec,logURL,readLogURL}=await import('./model.ts');
 const fallback=initialSpec('log_app');const old=readLogURL('?service=api&from=2026-10-10T00%3A00%3A00Z&to=2026-10-10T01%3A00%3A00Z',fallback);
 assert.deepEqual(old.spec.services,['api']);assert.equal(old.spec.range.from,'2026-10-10T00:00:00Z');
 for(const q of ['{',JSON.stringify({v:2,query:{}}),JSON.stringify({v:1,query:{keyword:'',services:'api'}})])assert.throws(()=>readLogURL('?q='+encodeURIComponent(q),fallback),/链接中的条件无效/);
 assert.equal(new URLSearchParams(logURL(fallback,undefined,'saved-1').split('?')[1]).has('q'),false);
});

test('trace links become literal typed log filters and survive sharing',async()=>{
 const {initialSpec,logURL,readLogURL}=await import('./model.ts');
 const trace="trace' OR 1=1 --";
 const parsed=readLogURL('?trace_id='+encodeURIComponent(trace),initialSpec('log_app'));
 assert.deepEqual(parsed.spec.filters,[{scope:'column',field:'trace_id',type:'string',op:'eq',value:trace}]);
 const link=logURL(parsed.spec),again=readLogURL(link.slice(link.indexOf('?')),initialSpec('log_app'));
 assert.deepEqual(again.spec.filters,parsed.spec.filters);
 const combined=readLogURL(link.slice(link.indexOf('?'))+'&trace_id='+encodeURIComponent(trace),initialSpec('log_app'));
 assert.deepEqual(combined.spec.filters,parsed.spec.filters);
});
