import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const {alertLines,alertWindowLabel,chartAlertSQL,panelAlertLinks}=loadSource(new URL('./panel-alerts.ts',import.meta.url));
const panel={id:'panel',title:'CPU',queries:[{refId:'A',sql:'SELECT time,service,value FROM metric_host_gauge'},{refId:'B',enabled:false}],options:{x:'time',y:'value',series:'service',series_aliases:{"A · order'api":'订单服务'}},type:'line'};
const results=[{refId:'A',status:'success',frames:[{columns:[{name:'time',type:'DateTime64(9)'},{name:'service',type:'LowCardinality(String)'},{name:'value',type:'Decimal(38,9)'}],rows:[[1,"order'api",'0.8'],[2,"order'api",'0.9'],[1,'worker','0.2']]}]}];
const rule={operator:'gt',panel_condition:{panel_id:'panel',query_ref:'A',reducer:'last'}};
test('alert links find unsaved bindings, prefer the owning panel and omit unrelated charts',()=>{
 const alert={...rule,id:'rule'},dashboards=[
  {id:'copy',title:'副本',panels:[{...panel,id:'copied',options:{alert_rule_ids:['rule']}}]},
  {id:'dash / 1',title:'生产大盘',panels:[{...panel,id:'panel'}, {...panel,id:'other'}]},
 ];
 const links=panelAlertLinks(dashboards,alert);
 assert.equal(links.length,2);assert.equal(links[0].label,'生产大盘 / CPU');
 assert.equal(links[0].href,'/dashboards/dash%20%2F%201?panel=panel&tab=alerts');
 assert.equal(links[1].panelID,'copied');
 assert.deepEqual(panelAlertLinks(dashboards,{id:'standalone'}),[]);
 assert.deepEqual(panelAlertLinks([],{...alert,panel_condition:{panel_id:'deleted'}}),[]);
});
test('line picker shows current enabled queries and deduplicates real series with aliases',()=>{
 const lines=alertLines(panel,results);assert.deepEqual(lines.map(line=>line.label),['查询 A · 全部曲线','订单服务','A · worker']);assert.deepEqual(lines[1].series,{type:'String',value:"order'api"});
});
test('latest point is determined by chart time, with one independent value per line',()=>{
 const generated=chartAlertSQL(panel,rule,{sql:panel.queries[0].sql+';'},results);
 assert.match(generated.sql,/argMaxOrNull\(panel_alert_source\.`value`, panel_alert_source\.`time`\)/);assert.match(generated.sql,/WHERE isNotNull\(panel_alert_source\.`value`\)/);assert.match(generated.sql,/GROUP BY panel_alert_source\.`service`/);assert.deepEqual(generated.label_fields,['service']);assert.doesNotMatch(generated.sql,/;\s*\)/);
});
test('selected line is a typed parameter, preserving SQL parameters and lossless values',()=>{
 const series={type:'String',value:"order'api"},source={sql:panel.queries[0].sql,params:{panel_alert_series:{type:'UInt64',value:'18446744073709551615'}}};
 const generated=chartAlertSQL(panel,{...rule,panel_condition:{...rule.panel_condition,series}},source,results);
 assert.match(generated.sql,/`service` = \{panel_alert_seriesx:String\}/);assert.doesNotMatch(generated.sql,/order'api/);assert.deepEqual(generated.params.panel_alert_seriesx,series);assert.equal(generated.params.panel_alert_series.value,'18446744073709551615');assert.deepEqual(generated.label_fields,[]);
});
test('missing points count only actual non-null query values; display gap filling is ignored',()=>{
 const generated=chartAlertSQL({...panel,options:{...panel.options,null_mode:'zero'}},{...rule,operator:'no_data'}, {sql:panel.queries[0].sql},results);
 assert.match(generated.sql,/countIf\(isNotNull\(panel_alert_source\.`value`\)\)/);assert.doesNotMatch(generated.sql,/argMax|fill|coalesce/i);
 const selected=chartAlertSQL(panel,{...rule,operator:'no_data',panel_condition:{...rule.panel_condition,series:{type:'String',value:null}}},{sql:panel.queries[0].sql},results);
 assert.match(selected.sql,/WHERE isNull\(panel_alert_source\.`service`\)/);assert.deepEqual(selected.params,{});
});
test('a latest-point condition rejects absent time fields and invalid value mappings',()=>{
 assert.throws(()=>chartAlertSQL({...panel,options:{...panel.options,x:'missing'}},rule,{sql:'SELECT 1'},results),/时间字段/);
 assert.throws(()=>chartAlertSQL({...panel,options:{...panel.options,y:'service'}},rule,{sql:'SELECT 1'},results),/数值字段/);
});
test('delayed windows show both bounds relative to evaluation time',()=>{
 assert.equal(alertWindowLabel(600,120),'now-12min ~ now-2min');
 assert.equal(alertWindowLabel(300,0),'now-5min ~ now');
 assert.equal(alertWindowLabel(10,2),'now-12s ~ now-2s');
});
test('sum and count preserve missing values for the evaluator policy',()=>{
 for(const reducer of ['sum','count']){
  const generated=chartAlertSQL(panel,{...rule,panel_condition:{...rule.panel_condition,reducer}},{sql:panel.queries[0].sql},results);
  assert.ok(generated.sql.includes(`${reducer}OrNull(panel_alert_source.\`value\`)`));assert.match(generated.sql,/GROUP BY/);assert.doesNotMatch(generated.sql,/coalesce|ifNull/);
 }
 assert.throws(()=>chartAlertSQL(panel,{...rule,panel_condition:{...rule.panel_condition,reducer:'invalid'}},{sql:panel.queries[0].sql},results),/取值方式/);
});
