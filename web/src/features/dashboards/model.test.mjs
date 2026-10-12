import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const {resolveRange,bindQueries,variableOrder,numeric,intervalFor,parameterReferences,thresholdsFor,thresholdColor,valueMapping,colorForSeries,displayedPoint,insertTimeGaps,timeBarRows,hasTimeBuckets,axisScale,rightAxisRefs,formatValue,adaptPanelType,histogramRows,timelineRows,pieRows}=loadSource(new URL('./model.ts',import.meta.url));

test('one now is shared by both range bounds; empty/reversed ranges reject',()=>{
 const range=resolveRange({from:'now-1h',to:'now'},Date.UTC(2026,9,10,12));
 assert.deepEqual(range,{from:'2026-10-10T11:00:00.000Z',to:'2026-10-10T12:00:00.000Z'});
 assert.throws(()=>resolveRange({from:'now',to:'now'}));assert.throws(()=>resolveRange({from:'not-a-date',to:'now'}));
 assert.equal(intervalFor(range,600),5000);
});
test('multi-dimensional values remain typed; quotes and commas are never SQL-interpolated',()=>{
 const queries=[{refId:'A',sql:'SELECT count() FROM log_app WHERE service IN {service:Array(String)}',params:{fixed:{type:'UInt64',value:'18446744073709551615'}}},{refId:'B',sql:'SELECT 2',enabled:false}];
 const variables=[{name:'service',type:'custom',multi:true,all:true}];
 const out=bindQueries(queries,variables,{service:['__all__']},{service:["order'api",'地区,上海']});
 assert.equal(out.length,1);assert.equal(out[0].sql,queries[0].sql);
 assert.deepEqual(out[0].params.service,{type:'Array(String)',value:["order'api",'地区,上海']});
 assert.equal(out[0].params.fixed.value,'18446744073709551615');
 assert.throws(()=>bindQueries([{refId:'A',sql:'SELECT {service:String}'}],variables,{service:['a','b']},{}));
});
test('dependent variable queries have a deterministic order and reject cycles',()=>{
 const variables=[{name:'host',type:'query',sql:'SELECT host_id WHERE service={service:String}'},{name:'service',type:'query',sql:'SELECT service'}];
 assert.deepEqual(variableOrder(variables).map(v=>v.name),['service','host']);
 assert.throws(()=>variableOrder([{name:'a',sql:'SELECT {b:String}'},{name:'b',sql:'SELECT {a:String}'}]));
});
test('unsafe integers and decimals cannot silently become approximate chart numbers',()=>{
 assert.equal(numeric('9007199254740991'),9007199254740991);assert.equal(numeric(null),null);assert.equal(numeric('0.125'),0.125);
 assert.throws(()=>numeric('18446744073709551615'));assert.throws(()=>numeric('0.123456789012345678'));
 assert.equal(numeric('18446744073709551615',true),Number('18446744073709551615'));assert.equal(numeric('not a number'),null);
});
test('variables inside SQL comments and quoted text are not parameter references',()=>{
 assert.deepEqual(parameterReferences("SELECT '{fake:String}', \"{column:String}\", `name` -- {comment:String}\n WHERE service={service:Array(String)} /* {blocked:String} */"),[{name:'service',type:'Array(String)'}]);
 assert.deepEqual(variableOrder([{name:'a',type:'query',sql:"SELECT '{a:String}'"}]).map(v=>v.name),['a']);
});
test('thresholds are ordered, inclusive and never classify null as zero',()=>{
 const options={base_color:'#3974f0',thresholds:[{value:0.8,color:'#dc4446'},{value:0.6,color:'#e9a23b'}]};
 assert.deepEqual(thresholdsFor(options).map(t=>t.value),[0.6,0.8]);assert.equal(thresholdColor(0.59,options),'#3974f0');assert.equal(thresholdColor(0.6,options),'#e9a23b');assert.equal(thresholdColor(0.8,options),'#dc4446');assert.equal(thresholdColor(null,options),'#3974f0');
});
test('value mappings preserve literal null and large original values',()=>{
 const options={value_mappings:[{match:'null',text:'无数据',color:'#64738a'},{match:'exact',value:'null',text:'文本null',color:'#3974f0'},{match:'exact',value:'18446744073709551615',text:'大整数',color:'#dc4446'},{match:'range',from:0,to:5,text:'正常',color:'#22a699'}]};
 assert.equal(valueMapping(null,options).text,'无数据');assert.equal(valueMapping('null',options).text,'文本null');assert.equal(valueMapping('18446744073709551615',options).text,'大整数');assert.equal(valueMapping(5,options).text,'正常');assert.equal(valueMapping(6,options),undefined);
});
test('explicit null policies and time gaps do not mutate source rows',()=>{
 assert.equal(displayedPoint(null,{}),null);assert.equal(displayedPoint(null,{null_mode:'zero'}),0);
 const rows=[{__x:0,__y:2,__refId:'A',__series:'api',__isTime:true},{__x:3000,__y:4,__refId:'A',__series:'api',__isTime:true}];
 const gap=insertTimeGaps(rows,1000,'gap',['A']);assert.equal(gap.length,3);assert.equal(gap[1].__y,null);
 const zero=insertTimeGaps(rows,1000,'zero',['A']);assert.deepEqual(zero.map(r=>r.__y),[2,0,0,4]);assert.equal(rows.length,2);assert.equal(insertTimeGaps(rows,1000,'connect',['A']).length,2);
 assert.equal(hasTimeBuckets("SELECT '$__timeInterval(time)'"),false);assert.equal(hasTimeBuckets('SELECT $__timeInterval(time)'),true);
 const sampled=[0,5000,10000,30000,35000].map(__x=>({__x,__y:1,__refId:'A',__series:'api',__isTime:true}));const estimated=insertTimeGaps(sampled,1000,'gap',['A']);assert.equal(estimated.length,6);assert.equal(estimated.find(row=>row.__synthetic).__x,15000);
});
test('series colors stay stable and time bars use separate positive and negative stacks',()=>{
 const options={series_colors:{api:'#dc4446'}};assert.equal(colorForSeries('api',0,options),'#dc4446');assert.equal(colorForSeries('api',3,options),'#dc4446');
 const rows=[{__x:1000,__y:2,__series:'a'},{__x:1000,__y:3,__series:'b'},{__x:1000,__y:-1,__series:'c'}];
 const bars=timeBarRows(rows,1000,true);assert.deepEqual(bars.map(r=>[r.__bar_lower,r.__bar_upper]),[[0,2],[2,5],[-1,0]]);assert.deepEqual(bars.map(r=>[r.__bar_start,r.__bar_end]),[[1000,2000],[1000,2000],[1000,2000]]);
 const grouped=timeBarRows(rows,1000,false);assert.ok(grouped[0].__bar_end<grouped[1].__bar_start);assert.equal(rows[0].__bar_start,undefined);
});
test('dual axes keep separate scale keys, bounds, and positive-only logarithmic domains',()=>{
 const options={right_axis_refs:['B'],left_min:0,left_max:1,right_scale:'log',right_min:1000,right_max:10000000};
 assert.deepEqual(rightAxisRefs(options),['B']);assert.equal(axisScale(options,'left',[{__y:0.15}]).key,'lightmoni-left-y');
 assert.deepEqual(axisScale(options,'left',[{__y:0.15}]).domain,[0,1]);const right=axisScale(options,'right',[{__y:1000000}]);assert.equal(right.key,'lightmoni-right-y');assert.equal(right.type,'log');assert.deepEqual(right.domain,[1000,10000000]);
 assert.throws(()=>axisScale(options,'right',[{__y:0}]));assert.throws(()=>axisScale({right_min:10,right_max:1},'right',[]));assert.throws(()=>axisScale({right_scale:'log',right_min:0},'right',[]));
 const left=[{__x:1000,__y:0.1,__series:'A · cpu'}],rightRows=[{__x:1000,__y:1000000,__series:'B · memory'}],domain=['A · cpu','B · memory'];
 const l=timeBarRows(left,1000,false,domain),r=timeBarRows(rightRows,1000,false,domain);assert.ok(l[0].__bar_end<r[0].__bar_start);assert.equal(r[0].__bar_upper,1000000);assert.equal(l[0].__bar_upper,0.1);
});

test('automatic axes leave headroom and optionally frame the data with padding on both sides',()=>{
 const position=(value,domain)=>(value-domain[0])/(domain[1]-domain[0]);
 const rows=[80,90,100,null,NaN,Infinity].map(__y=>({__y}));
 const zero=axisScale({},'left',rows);assert.equal(zero.domain[0],0);assert.ok(Math.abs(position(100,zero.domain)-0.85)<1e-12);
 const fitted=axisScale({left_zero:false},'left',rows);assert.ok(fitted.domain[0]>0);assert.ok(Math.abs(position(80,fitted.domain)-0.15)<1e-12);assert.ok(Math.abs(position(100,fitted.domain)-0.85)<1e-12);
 for(const values of [[-100,-80],[-20,100],[1e-10,2e-10],[1e200,2e200]]){
  const domain=axisScale({left_zero:false},'left',values.map(__y=>({__y}))).domain;
  assert.ok(domain.every(Number.isFinite));assert.ok(Math.abs(position(values[0],domain)-0.15)<1e-12);assert.ok(Math.abs(position(values[1],domain)-0.85)<1e-12);
 }
 assert.ok(axisScale({},'left',[{__y:-100},{__y:-80}]).domain[1]>=0);
 const large=axisScale({},'left',Array.from({length:150000},(_,__y)=>({__y})));assert.ok(Math.abs(position(149999,large.domain)-0.85)<1e-12);
});

test('constant, zero and empty data keep a valid axis, while explicit bounds take precedence',()=>{
 for(const value of [0,80,-80])for(const zero of [true,false]){
  const domain=axisScale({left_zero:zero},'left',[{__y:value}]).domain;
  assert.ok(domain[0]<domain[1]);assert.ok(domain[0]<=value&&domain[1]>=value);
 }
 assert.equal(axisScale({},'left',[{__y:0}]).domain[0],0);
 assert.ok(axisScale({left_zero:false},'left',[{__y:0}]).domain[0]<0);
 assert.deepEqual(axisScale({left_zero:true,left_min:75,left_max:110},'left',[{__y:80},{__y:100}]).domain,[75,110]);
 const partial=axisScale({left_min:70},'left',[{__y:80},{__y:100}]).domain;assert.equal(partial[0],70);assert.ok(Math.abs((100-70)/(partial[1]-70)-0.85)<1e-12);
 assert.equal(axisScale({left_max:0},'left',[{__y:0}]).domain[1],0);
 assert.doesNotThrow(()=>axisScale({left_min:500},'left',[]));assert.doesNotThrow(()=>axisScale({left_max:-500},'left',[]));
 assert.throws(()=>axisScale({left_min:101},'left',[{__y:80},{__y:100}]));
});

test('stack totals and visible annotations determine the range without stacking the annotations',()=>{
 const rows=[{__x:1,__y:80},{__x:1,__y:90},{__x:2,__y:100},{__x:2,__y:-20},{__x:2,__y:-30}];
 const domain=axisScale({stacked:true,left_zero:false},'left',rows).domain;assert.ok(Math.abs((-50-domain[0])/(domain[1]-domain[0])-0.15)<1e-12);assert.ok(Math.abs((170-domain[0])/(domain[1]-domain[0])-0.85)<1e-12);
 const annotated=axisScale({stacked:true},'left',rows,[300]).domain;assert.ok(Math.abs((300-annotated[0])/(annotated[1]-annotated[0])-0.85)<1e-12);
 assert.equal(rows[0].__y,80);
});

test('logarithmic padding is measured in display space and axes retain independent zero policies',()=>{
 const domain=axisScale({right_scale:'log'},'right',[{__y:10},{__y:1000}]).domain;
 const position=value=>(Math.log(value)-Math.log(domain[0]))/(Math.log(domain[1])-Math.log(domain[0]));
 assert.ok(Math.abs(position(10)-0.15)<1e-12);assert.ok(Math.abs(position(1000)-0.85)<1e-12);
 const constant=axisScale({right_scale:'log'},'right',[{__y:100}]).domain;assert.ok(constant[0]>0&&constant[0]<100&&constant[1]>100);
 const options={left_zero:false,right_zero:true},rows=[{__y:80},{__y:100}];assert.ok(axisScale(options,'left',rows).domain[0]>0);assert.equal(axisScale(options,'right',rows).domain[0],0);
});

test('byte formatting is compact and shared by axes and tooltip without changing raw values',()=>{
 assert.equal(formatValue(1024,'bytes'),'1.00 KiB');assert.equal(formatValue(1024**3*96.5,'bytes'),'96.50 GiB');assert.equal(formatValue(-1024,'bytes'),'-1.00 KiB');assert.equal(formatValue(0,'bytes'),'0.00 B');assert.equal(formatValue(0.14,'percentunit'),'14.00%');assert.equal(formatValue(12.5,'ms'),'12.50 ms');
});

test('visualization switching uses typed query fields and restores value units after sample distribution',()=>{
 const panel={type:'line',options:{x:'time',y:'value',series:'host',unit:'percentunit',right_axis_refs:['B']},queries:[{refId:'A',sql:'SELECT'}],grid:{x:0,y:0,w:6,h:3}};const results=[{refId:'A',frames:[{columns:[{name:'time',type:'DateTime64(3)'},{name:'host',type:'String'},{name:'value',type:'Float64'}],rows:[]}]}];
 const pie=adaptPanelType(panel,'pie',results);assert.equal(pie.options.x,'host');assert.equal(pie.options.pie_reducer,'mean');assert.deepEqual(pie.options.right_axis_refs,[]);
 const hist=adaptPanelType(panel,'histogram',results);assert.equal(hist.options.histogram_mode,'auto');assert.equal(hist.options.y,'value');assert.equal(hist.options.unit,'');assert.equal(adaptPanelType(hist,'line',results).options.unit,'percentunit');
 assert.equal(adaptPanelType(panel,'gauge',results).options.max,1);assert.equal(adaptPanelType(panel,'gauge',results).grid.h,5);assert.equal(adaptPanelType(panel,'stat',results).grid.h,3);assert.equal(adaptPanelType(panel,'timeline',results).options.timeline_mode,'auto');
});
test('sample histograms count finite observations and preserve raw input rows',()=>{
 const rows=[0,1,2,3,null].map(__y=>({__y,__series:'cpu',__refId:'A'}));const out=histogramRows(rows,2);assert.equal(out.reduce((sum,row)=>sum+row.__y,0),4);assert.deepEqual(out.map(row=>row.__y),[2,2]);assert.equal(rows[0].__x,undefined);assert.equal(out.at(-1).__upper,3);assert.equal(out[0].__isTime,false);
});
test('automatic state intervals are independent by series and pie categories aggregate explicitly',()=>{
 const rows=[{__x:1000,__isTime:true,__refId:'A',__series:'host',__y:0.1},{__x:3000,__isTime:true,__refId:'A',__series:'host',__y:0.3}];assert.deepEqual(timelineRows(rows).map(row=>row.__upper),[3000,5000]);assert.equal(rows[0].__upper,undefined);assert.throws(()=>timelineRows([{__x:'invalid',__isTime:false}]));
 const pie=pieRows(rows.map(row=>({...row,__x:'host'})),'mean');assert.equal(pie.length,1);assert.equal(pie[0].__y,0.2);assert.equal(pieRows(rows.map(row=>({...row,__x:'host'})),'last')[0].__y,0.3);
});
