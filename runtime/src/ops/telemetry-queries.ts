import type {Table} from '../shared/types.js';
export const literal=(v:string)=>"'"+v.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const tableName=(t:Table)=>'`'+t.name+'`';
export function sdkTelemetryQueries(tables:Table[],applicationID:string,time:string,filters:Record<string,string>){
 const all=tables.filter(t=>!t.system&&/^[a-z][a-z0-9_]*$/.test(t.name)&&['metric','log'].includes(t.kind));
 const selected=all.slice(0,32);
 const scope=`JSONExtractString(resource_json,'lightmoni.application_id')=${literal(applicationID)}`
  +Object.entries(filters).filter(([,v])=>v).map(([k,v])=>k==='deployment_id'?` AND instance_id=${literal(v)}`:` AND JSONExtractString(resource_json,'lightmoni.${k}')=${literal(v)}`).join('');
 const metrics=selected.filter(t=>t.kind==='metric'&&['gauge','sum','histogram'].includes(t.metric_type??''));
 const logs=selected.filter(t=>t.kind==='log');
 const queries:{refId:string;sql:string}[]=[];
 if(metrics.length){
  const sql=metrics.map(t=>{
   const histogram=t.metric_type==='histogram';
   const clock=histogram?'metric_time':'event_time';
   const source=histogram?`(SELECT *,if(window_seconds>0,window_start,event_time) AS metric_time FROM ${tableName(t)})`:tableName(t);
   return `SELECT $__timeInterval(${clock}) AS time,${literal(t.name)} AS table_name,name,unit,instance_id,${literal(t.metric_type!)} AS metric_type,${histogram?'sum(sum) / nullIf(sum(count),0)':'avg(value)'} AS value,${histogram?'sum(count)':'count()'} AS samples FROM ${source} WHERE $__timeFilter(${clock}) AND ${scope} GROUP BY time,name,unit,instance_id`;
  }).join(' UNION ALL ');
  queries.push({refId:'sdk_metrics',sql:`SELECT * FROM (${sql}) ORDER BY time,name LIMIT 5000`});
 }
 if(logs.length){
  const sql=logs.map(t=>`SELECT ${literal(t.name)} AS table_name,event_id,event_time,severity,body,service,instance_id FROM ${tableName(t)} WHERE ${time} AND ${scope}`).join(' UNION ALL ');
  queries.push({refId:'sdk_logs',sql:`SELECT * FROM (${sql}) ORDER BY event_time DESC LIMIT 200`});
 }
 return {queries,tables:selected.map(t=>({name:t.name,kind:t.kind,metric_type:t.metric_type??''})),truncated:all.length>selected.length};
}
export function websiteTelemetryQueries(websiteID:string,time:string){
 const scope=`attributes['website_id']=${literal(websiteID)}`,table='log_lightmoni_application';
 return [{refId:'web',sql:`SELECT toStartOfMinute(event_time) AS time,attributes['website_id'] AS website_id,attributes['cluster_id'] AS cluster_id,count() / 60.0 AS qps,avg(toFloat64OrZero(attributes['request_duration'])) AS duration,countIf(toUInt16OrZero(attributes['http_status'])>=500) AS server_errors,count() AS requests FROM ${table} WHERE ${time} AND ${scope} GROUP BY time,website_id,cluster_id ORDER BY time LIMIT 1500`},
 {refId:'access',sql:`SELECT event_id,event_time,body,attributes['http_status'] AS status,attributes['request_duration'] AS duration,attributes['http_host'] AS host,attributes['http_method'] AS method,attributes['http_uri'] AS uri,attributes['cluster_id'] AS cluster_id FROM ${table} WHERE ${time} AND ${scope} ORDER BY event_time DESC LIMIT 200`}];
}
