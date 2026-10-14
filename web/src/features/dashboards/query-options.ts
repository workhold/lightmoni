import type {TimeRange} from '../../shared/types';
import {defaultQueryInterval,intervalFor,visibleSQL} from './model';

export const intervalChoices=[{value:'auto',label:'自动'},{value:'10s',label:'10s'},{value:'30s',label:'30s'},{value:'1m',label:'1min'},{value:'5m',label:'5min'},{value:'15m',label:'15min'},{value:'1h',label:'1h'},{value:'1d',label:'1d'}];
export const aggregationChoices=[{value:'avg',label:'avg · 平均值'},{value:'max',label:'max · 最大值'},{value:'min',label:'min · 最小值'},{value:'sum',label:'sum · 求和'},{value:'count',label:'count · 样本数'},{value:'p50',label:'p50 · 中位数'},{value:'p90',label:'p90'},{value:'p95',label:'p95'},{value:'p99',label:'p99'}];
const queryKeys=['query_interval','query_min_interval','query_max_points'] as const;
export function queryOptions(options:Record<string,unknown>):Record<string,unknown>{return Object.fromEntries(queryKeys.map(key=>[key,options[key]]));}
export function durationMS(value:unknown):number{
 const match=typeof value==='string'?/^([1-9]\d*)(ms|s|m|min|h|d)$/.exec(value.trim()):null;
 if(!match)throw new Error('聚合间隔须为正整数加单位，例如 30s、1min、5min 或 1h');
 const milliseconds=Number(match[1])*({ms:1,s:1000,m:60000,min:60000,h:3600000,d:86400000}[match[2]]??0);
 if(!Number.isSafeInteger(milliseconds)||milliseconds>31536000000)throw new Error('聚合间隔不能超过 365d');
 return milliseconds;
}
export function validateQueryOptions(options:Record<string,unknown>):void{
 if(options.query_interval!==undefined&&options.query_interval!=='auto')durationMS(options.query_interval);
 if(options.query_min_interval!==undefined&&options.query_min_interval!=='')durationMS(options.query_min_interval);
 const points=options.query_max_points;
 if(points!==undefined&&(typeof points!=='number'||!Number.isInteger(points)||points<1||points>10000))throw new Error('最大数据点须为 1–10000 的整数');
}
export function panelIntervalFor(range:TimeRange,options:Record<string,unknown>,width=600):number{
 validateQueryOptions(options);
 const duration=Date.parse(range.to)-Date.parse(range.from);
 if(!Number.isFinite(duration)||duration<=0)throw new Error('开始时间必须早于结束时间');
 const interval=options.query_interval??defaultQueryInterval;
 if(interval!=='auto')return durationMS(interval);
 const resolution=typeof options.query_max_points==='number'?options.query_max_points:Math.max(1,Math.min(10000,Math.floor(width)||600));
 const minimum=options.query_min_interval?durationMS(options.query_min_interval):1000;
 return Math.max(minimum,intervalFor(range,resolution));
}
export function intervalLabel(milliseconds:number):string{
 for(const [unit,size] of [['d',86400000],['h',3600000],['min',60000],['s',1000]] as const)if(milliseconds>=size&&milliseconds%size===0)return `${milliseconds/size}${unit}`;
 return `${milliseconds}ms`;
}

type Aggregate={start:number;end:number;sample:string;value:string};
function closingParen(sql:string,start:number):number{let depth=0;for(let index=start;index<sql.length;index++){if(sql[index]==='(')depth++;if(sql[index]===')'&&--depth===0)return index;}return -1;}
/** Only a single, direct SELECT is eligible. Weighted formulas and subqueries stay editable SQL. */
export function sqlAggregation(sql:string):Aggregate|undefined{
 const visible=visibleSQL(sql);
 if(!/^\s*SELECT\b/i.test(visible)||(visible.match(/\bSELECT\b/gi)??[]).length!==1||/\b(?:WITH|UNION|OVER|DISTINCT)\b/i.test(visible))return;
 const calls=[...visible.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)];
 const aggregates=calls.filter(call=>/^(?:avg|min|max|sum|count|quantile|median|argM|uniq|any|groupArray|groupUniqArray|varPop|varSamp|stddev|histogram|corr|covar)/i.test(call[1]));
 if(aggregates.length!==1)return;
 const call=aggregates[0],name=call[1].toLowerCase(),start=call.index!;
 // Do not rewrite a condition or an aggregate unrelated to the SELECT projection.
 const from=/\bFROM\b/i.exec(visible);if(from&&start>from.index)return;
 let open=visible.indexOf('(',start),end=closingParen(visible,open),value=name;
 if(end<0)return;
 if(name==='quantileexact'){
  const level=Number(visible.slice(open+1,end).trim()),percentile=[50,90,95,99].find(p=>p/100===level);
  if(!percentile)return;
  value=`p${percentile}`;open=end+1;while(/\s/.test(visible[open]??'')&&open<visible.length)open++;
  if(visible[open]!=='(')return;end=closingParen(visible,open);if(end<0)return;
 }else if(!['avg','min','max','sum','count'].includes(name))return;
 const sample=sql.slice(open+1,end);
 if(!sample.trim()||visible.slice(open+1,end).trim()==='*'||/\bSELECT\b/i.test(visible.slice(open+1,end)))return;
 // A comma at argument depth zero denotes multiple arguments, which cannot be switched safely.
 let depth=0;for(const char of visible.slice(open+1,end)){if(char==='(')depth++;else if(char===')')depth--;else if(char===','&&depth===0)return;}
 return {start,end:end+1,sample,value};
}
export function changeSQLAggregation(sql:string,value:string):string{
 if(!aggregationChoices.some(choice=>choice.value===value))throw new Error('未知聚合函数');
 const aggregate=sqlAggregation(sql);if(!aggregate)throw new Error('复合聚合请直接编辑 SQL');
 const expression=value.startsWith('p')?`quantileExact(${Number(value.slice(1))/100})(${aggregate.sample})`:`${value}(${aggregate.sample})`;
 return sql.slice(0,aggregate.start)+expression+sql.slice(aggregate.end);
}
