import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const {selectLegendSeries,alignTimeSeries,canPlotTimeSeries,nextLegendSort,sortLegendRows}=loadSource(new URL('./series-interaction.ts',import.meta.url));
const {resolveRange}=loadSource(new URL('./model.ts',import.meta.url));

test('legend headers cycle numeric descending/ascending/default and names ascending/descending/default',()=>{
 const descending=nextLegendSort(undefined,'mean');
 assert.deepEqual(descending,{key:'mean',direction:'descending'});
 const ascending=nextLegendSort(descending,'mean');
 assert.deepEqual(ascending,{key:'mean',direction:'ascending'});
 assert.equal(nextLegendSort(ascending,'mean'),undefined);
 const name=nextLegendSort(descending,'name');
 assert.deepEqual(name,{key:'name',direction:'ascending'});
 assert.deepEqual(nextLegendSort(name,'name'),{key:'name',direction:'descending'});
});

test('legend sorting uses numeric precision, keeps missing values last and preserves tied series and colors',()=>{
 const rows=[{label:'service 10',color:'red',calculations:{mean:2.002}},{label:'service 2',color:'blue',calculations:{mean:10}},{label:'empty',color:'gray',calculations:{mean:null}},{label:'tie',color:'green',calculations:{mean:2.002}}];
 assert.deepEqual(sortLegendRows(rows,{key:'mean',direction:'descending'}).map(row=>row.label),['service 2','service 10','tie','empty']);
 assert.deepEqual(sortLegendRows(rows,{key:'mean',direction:'ascending'}).map(row=>row.label),['service 10','tie','service 2','empty']);
 assert.deepEqual(sortLegendRows(rows,{key:'name',direction:'ascending'}).map(row=>row.label),['empty','service 2','service 10','tie']);
 assert.equal(sortLegendRows(rows),rows);
 assert.equal(sortLegendRows(rows,{key:'mean',direction:'descending'})[0],rows[1]);
 assert.deepEqual(rows.map(row=>row.color),['red','blue','gray','green']);
});

test('Grafana legend selection isolates, restores, and supports additive toggles',()=>{
 const series=['api','worker','cache'];
 assert.deepEqual(selectLegendSeries([],series,'worker',false),['api','cache']);
 assert.deepEqual(selectLegendSeries(['api','cache'],series,'worker',false),[]);
 assert.deepEqual(selectLegendSeries(['worker'],series,'worker',false),['api','cache']);
 assert.deepEqual(selectLegendSeries(['api','cache'],series,'api',true),['cache']);
 assert.deepEqual(selectLegendSeries([],series,'api',true),['api']);
 assert.deepEqual(selectLegendSeries([],['api'],'api',false),[]);
});
test('irregular series alignment preserves explicit null gaps and negative/zero values',()=>{
 const row=(name,x,y)=>({__series:name,__x:x,__y:y,__isTime:true});
 const rows=[row('api',3000,2),row('worker',2000,-1),row('api',1000,0),row('api',2000,null)];
 assert.deepEqual(alignTimeSeries(rows,['api','worker']),[[1000,2000,3000],[0,null,2],[undefined,-1,undefined]]);
 assert.equal(rows[0].__x,3000);
 assert.equal(canPlotTimeSeries(rows,'line',{}),true);
 assert.equal(canPlotTimeSeries([...rows,row('api',1000,5)],'line',{}),false);
 assert.equal(canPlotTimeSeries(rows,'line',{stacked:true}),false);
 assert.equal(canPlotTimeSeries([{...rows[0],__isTime:false}],'line',{}),false);
});
test('Grafana date math shares now, supports calendar rounding and month/week offsets',()=>{
 const now=new Date(2026,9,15,14,30,45).getTime();
 assert.equal(resolveRange({from:'now-2w',to:'now'},now).from,new Date(now-14*86400000).toISOString());
 const today=resolveRange({from:'now/d',to:'now'},now);
 assert.equal(today.from,new Date(2026,9,15).toISOString());
 const yesterday=resolveRange({from:'now-1d/d',to:'now-1d/d'},now);
 assert.equal(yesterday.from,new Date(2026,9,14).toISOString());
 assert.equal(yesterday.to,new Date(2026,9,14,23,59,59,999).toISOString());
 assert.equal(resolveRange({from:'now-1M',to:'now'},now).from,new Date(2026,8,15,14,30,45).toISOString());
 assert.throws(()=>resolveRange({from:'now-nonsense',to:'now'},now));
 assert.throws(()=>resolveRange({from:'now+1d',to:'now'},now));
});
