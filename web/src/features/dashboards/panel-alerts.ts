import {monitoringText,type MonitoringLanguage} from '../monitoring-translations.ts';
import type {Parameter,QueryResult} from '../../shared/types';
import type {AlertRule,PanelCondition} from '../alerts/types';
import {printable,type Dashboard,type Panel} from './model';

export function panelAlertLinks(dashboards:Dashboard[],rule:Pick<AlertRule,'id'|'panel_condition'>){
 const destinations=dashboards.flatMap(dashboard=>dashboard.panels.filter(panel=>panel.id===rule.panel_condition?.panel_id||Array.isArray(panel.options.alert_rule_ids)&&panel.options.alert_rule_ids.includes(rule.id)).map(panel=>({
  dashboardID:dashboard.id,panelID:panel.id,label:`${dashboard.title} / ${panel.title}`,owned:panel.id===rule.panel_condition?.panel_id,
  href:`/dashboards/${encodeURIComponent(dashboard.id)}?${new URLSearchParams({panel:panel.id,tab:'alerts'})}`,
 })));
 return destinations.sort((a,b)=>Number(b.owned)-Number(a.owned));
}

export const conditionLabels:Record<string,string>={gt:'高于',lt:'低于',no_data:'没有打点',gte:'高于或等于',lte:'低于或等于',eq:'等于',ne:'不等于'};
export const reducerOptions=[{value:'last',label:'最新点'},{value:'avg',label:'窗口平均值'},{value:'max',label:'窗口最大值'},{value:'min',label:'窗口最小值'},{value:'sum',label:'窗口总和'},{value:'count',label:'有效点数'}];
export function alertWindowLabel(windowSeconds:number,delaySeconds:number){
 const offset=(seconds:number)=>seconds===0?'now':`now-${seconds%60===0?`${seconds/60}min`:`${seconds}s`}`;
 return `${offset(windowSeconds+delaySeconds)} ~ ${offset(delaySeconds)}`;
}
export type AlertLine={value:string;label:string;query_ref:string;series?:Parameter};
export const lineKey=(selection:Pick<PanelCondition,'query_ref'|'series'>)=>JSON.stringify([selection.query_ref,selection.series??null]);
function seriesParameter(type:string,value:unknown):Parameter{
 while(/^(Nullable|LowCardinality)\(/.test(type))type=type.slice(type.indexOf('(')+1,-1);
 if(type.startsWith('UInt'))type='UInt64';else if(type.startsWith('Int'))type='Int64';else if(type.startsWith('Float'))type='Float64';else if(type.startsWith('Decimal'))type='Decimal(38,9)';else if(type!=='Bool'){type='String';if(value!==null)value=typeof value==='string'?value:printable(value);}
 return {type,value};
}

export function alertLines(panel:Panel,results:QueryResult[],language:MonitoringLanguage='zh-CN'):AlertLine[]{
 const l=(text:string,...values:unknown[])=>monitoringText(text,language,...values);

 const aliases=panel.options.series_aliases as Record<string,string>|undefined,seriesField=String(panel.options.series??''),lines:AlertLine[]=[];
 for(const query of panel.queries.filter(query=>query.enabled!==false)){
  const all={query_ref:query.refId};lines.push({...all,value:lineKey(all),label:l("查询 {0} · {1}",query.refId,seriesField?l("全部曲线"):String(panel.options.y??'value'))});
  if(!seriesField)continue;
  const seen=new Set<string>();
  for(const frame of results.filter(result=>result.refId===query.refId&&result.status==='success').flatMap(result=>result.frames)){
   const index=frame.columns.findIndex(column=>column.name===seriesField);if(index<0)continue;
   for(const row of frame.rows){const series=seriesParameter(frame.columns[index].type,row[index]),selection={query_ref:query.refId,series},key=lineKey(selection);if(seen.has(key))continue;seen.add(key);
    const name=(panel.queries.length>1?`${query.refId} · `:'')+printable(row[index]);lines.push({...selection,value:key,label:aliases?.[name]??name});
   }
  }
 }
 return lines;
}

export function chartAlertSQL(panel:Panel,rule:AlertRule,source:{sql:string;params?:Record<string,Parameter>},results:QueryResult[],language:MonitoringLanguage='zh-CN'){
 const l=(text:string,...values:unknown[])=>monitoringText(text,language,...values);

 const selection=rule.panel_condition;if(!selection)throw new Error(l("请选择当前图表的线"));
 const quote=(name:string)=>'`'+name.replaceAll('`','``')+'`',field=(name:string)=>'panel_alert_source.'+quote(name),value=field(String(panel.options.y??'value')),series=String(panel.options.series??'');
 let time=String(panel.options.x??'time');
 const frames=results.filter(result=>result.refId===selection.query_ref).flatMap(result=>result.frames),columns=frames.flatMap(frame=>frame.columns);
 if(columns.length&&!columns.some(column=>column.name===String(panel.options.y??'value')&&/Int|Float|Decimal/.test(column.type)))throw new Error(l("当前查询没有图表使用的数值字段，请检查字段映射"));
 const noData=rule.operator==='no_data',params={...source.params},where:string[]=[];
 if(!reducerOptions.some(option=>option.value===selection.reducer))throw new Error(l("请选择有效的取值方式"));
 if(selection.series){
  if(!series)throw new Error(l("所选曲线的序列字段已移除，请重新选择"));
  if(selection.series.value===null)where.push(`isNull(${field(series)})`);
  else{let parameter='panel_alert_series';while(parameter in params)parameter+='x';params[parameter]=selection.series;where.push(`${field(series)} = {${parameter}:${selection.series.type}}`);}
 }
 if(!noData)where.push(`isNotNull(${value})`);
 const grouped=!!series&&!selection.series;
 let directScalar=false,expression=`countIf(isNotNull(${value}))`;
 if(!noData){
  if(selection.reducer==='last'){
   const timestamps=[...new Map(columns.filter(column=>/^Date(?:Time|32)?/.test(column.type.replace(/^Nullable\((.*)\)$/,'$1'))).map(column=>[column.name,column])).values()];
   if(columns.length&&!timestamps.some(column=>column.name===time)){
    if(['stat','gauge'].includes(panel.type)&&!grouped){
     if(timestamps.length===1)time=timestamps[0].name;
     else if(timestamps.length===0&&frames.reduce((n,frame)=>n+frame.rows.length,0)<=1)directScalar=true;
     else throw new Error(l("最新值需要时间字段，请运行查询或选择其他取值方式"));
    }else throw new Error(l("最新值需要时间字段，请运行查询或选择其他取值方式"));
   }
   // A scalar card may return an already aggregated single value without time.
   // Keep it lossless; LIMIT 2 lets the evaluator reject future ambiguous rows.
   expression=directScalar?value:`argMaxOrNull(${value}, ${field(time)})`;
  }else expression=`${selection.reducer}OrNull(${value})`;
 }
 return {sql:`SELECT\n  ${grouped?field(series)+' AS '+quote(series)+',\n  ':''}${expression} AS value\nFROM (\n${source.sql.trim().replace(/;\s*$/,'')}\n) AS panel_alert_source${where.length?'\nWHERE '+where.join(' AND '):''}${grouped?'\nGROUP BY '+field(series):directScalar?'\nLIMIT 2':''}`,params,label_fields:grouped?[series]:[]};
}
