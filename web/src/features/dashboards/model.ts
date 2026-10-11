import type {Parameter, SQLQuery, TimeRange, QueryFrame, QueryResult} from '../../shared/types';
export interface Grid {x:number;y:number;w:number;h:number}
export interface DashboardQuery extends SQLQuery {enabled?:boolean}
export interface Panel {id:string;title:string;type:string;queries:DashboardQuery[];options:Record<string,unknown>;grid:Grid}
export interface Variable {name:string;label?:string;type:'custom'|'query'|'text'|'constant';options?:string[];sql?:string;multi?:boolean;all?:boolean;value?:unknown}
export interface Dashboard {id:string;title:string;description:string;panels:Panel[];variables:Variable[];range:TimeRange;refresh:number;revision:number;updated_at?:string}
export interface Template {id:string;title:string;description:string;type:string;table_id:string;sql:string;options:Record<string,unknown>}
export type Values = Record<string,string|string[]>;
export interface Threshold {value:number;color:string;label?:string}
export interface ValueMapping {match:'exact'|'range'|'null';value?:string;from?:number;to?:number;text:string;color:string}
export const palette=['#73bf69','#5794f2','#f2cc0c','#b877d9','#ff7383','#6ed0e0','#ff9830','#f993bd','#c8f2c2','#8ab8ff','#f2495c','#70dbb8','#ca95e5','#b2b8c2','#a4d9ed','#ffdf77','#e7a4ac','#a2c871','#d8b5ed','#7fbdd8'];
export const isColor=(value:unknown):value is string=>typeof value==='string'&&/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
export function thresholdsFor(options:Record<string,unknown>):Threshold[]{return Array.isArray(options.thresholds)?(options.thresholds as Threshold[]).filter(t=>t&&Number.isFinite(t.value)&&isColor(t.color)).sort((a,b)=>a.value-b.value):[];}
export function thresholdColor(value:unknown,options:Record<string,unknown>):string{
 let color=isColor(options.base_color)?options.base_color:palette[0];let n:number|null;
 try{n=numeric(value,options.approximate===true);}catch{return color;}
 if(n===null)return color;for(const threshold of thresholdsFor(options)){if(n>=threshold.value)color=threshold.color;}return color;
}
export function valueMapping(value:unknown,options:Record<string,unknown>):ValueMapping|undefined{
 if(!Array.isArray(options.value_mappings))return;
 for(const m of options.value_mappings as ValueMapping[]){if(!m||typeof m.text!=='string'||!isColor(m.color))continue;if(m.match==='null'&&value===null)return m;
  if(m.match==='exact'&&value!==null&&value!==undefined&&String(value)===String(m.value))return m;
  if(m.match==='range'){let n:number|null;try{n=numeric(value,options.approximate===true);}catch{continue;}if(n!==null&&typeof m.from==='number'&&typeof m.to==='number'&&n>=m.from&&n<=m.to)return m;}
 }
}
export function colorForSeries(name:string,index:number,options:Record<string,unknown>):string{const overrides=options.series_colors;if(overrides&&typeof overrides==='object'){const color=(overrides as Record<string,unknown>)[name];if(isColor(color))return color;}return palette[index]??`hsl(${(index*137.508)%360},65%,65%)`;}
export function displayedPoint(value:number|null,options:Record<string,unknown>):number|null{return value===null&&options.null_mode==='zero'?0:value;}
export function insertTimeGaps(rows:Record<string,unknown>[],interval:number,mode:string,refs:string[]):Record<string,unknown>[]{
 if(interval<=0||mode==='connect'||refs.length===0)return rows;const output:Record<string,unknown>[]=[];const groups=new Map<string,Record<string,unknown>[]>();for(const row of rows){const key=String(row.__refId)+'\0'+String(row.__series);const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 for(const group of groups.values()){group.sort((a,b)=>Number(a.__x)-Number(b.__x));const deltas=group.slice(1).map((row,i)=>Number(row.__x)-Number(group[i].__x)).filter(delta=>delta>0).sort((a,b)=>a-b),cadence=group.length>=4?deltas[Math.floor(deltas.length/2)]??interval:interval,expected=Math.max(interval,cadence);for(let index=0;index<group.length;index++){const row=group[index],previous=group[index-1];if(previous&&row.__isTime===true&&refs.includes(String(row.__refId))&&Number(row.__x)-Number(previous.__x)>(mode==='zero'?interval:expected)*1.5){
   if(mode==='zero'){for(let x=Number(previous.__x)+interval;x<Number(row.__x);x+=interval){if(output.length>=20000)throw new Error('空值补零会产生过多点，请缩小时间范围');output.push({...previous,__x:x,__y:0,__rawY:null,__synthetic:true});}}
   else output.push({...previous,__x:Number(previous.__x)+expected,__y:null,__rawY:null,__synthetic:true});
  }output.push(row);}}
 return output;
}
export function timeBarRows(rows:Record<string,unknown>[],interval:number,stacked:boolean,seriesDomain?:string[]):Record<string,unknown>[]{
 const names=seriesDomain??[...new Set(rows.map(row=>String(row.__series)))],positive=new Map<number,number>(),negative=new Map<number,number>();
 const times=[...new Set(rows.map(row=>Number(row.__x)))].sort((a,b)=>a-b),observed=times.length>1?Math.min(...times.slice(1).map((x,i)=>x-times[i])):60000;
 const width=interval>0?interval:observed;
 return rows.filter(row=>typeof row.__y==='number').map(row=>{const x=Number(row.__x),value=Number(row.__y),index=names.indexOf(String(row.__series));let start=x,end=x+width,lower=0,upper=value;
  if(stacked){const sums=value<0?negative:positive;lower=sums.get(x)??0;upper=lower+value;sums.set(x,upper);}
  else{const slot=width/Math.max(1,names.length);start=x+index*slot+slot*0.05;end=start+slot*0.9;}
  return {...row,__bar_start:start,__bar_end:end,__bar_lower:Math.min(lower,upper),__bar_upper:Math.max(lower,upper)};
 });
}
export function rightAxisRefs(options:Record<string,unknown>):string[]{return Array.isArray(options.right_axis_refs)?options.right_axis_refs.filter((ref):ref is string=>typeof ref==='string'):[];}
/** Distinct keys keep an axis independent, while its marks and point overlays share a scale. */
export function axisScale(options:Record<string,unknown>,side:'left'|'right',rows:Record<string,unknown>[],annotations:number[]=[]):Record<string,unknown>{
 const type=options[`${side}_scale`]==='log'?'log':'linear',finite=rows.filter(row=>typeof row.__y==='number'&&Number.isFinite(row.__y));
 let values=finite.map(row=>Number(row.__y));
 const min=options[`${side}_min`],max=options[`${side}_max`];
 if(min!==undefined&&(!Number.isFinite(min)||typeof min!=='number')||max!==undefined&&(!Number.isFinite(max)||typeof max!=='number')||typeof min==='number'&&typeof max==='number'&&min>=max)throw new Error(`${side==='right'?'右':'左'}轴范围需要有效数值，且最小值小于最大值`);
 if(type==='log'&&(values.some(value=>value<=0)||typeof min==='number'&&min<=0||typeof max==='number'&&max<=0))throw new Error(`${side==='right'?'右':'左'}轴对数尺度只接受大于 0 的值；请切换线性尺度或调整 SQL / 补零策略`);
 if(options.stacked===true){
  const positive=new Map<unknown,number>(),negative=new Map<unknown,number>();
  for(const row of finite){const value=Number(row.__y),sums=value<0?negative:positive;sums.set(row.__x,(sums.get(row.__x)??0)+value);}
  values=[...values,...positive.values(),...negative.values()];
 }
 values.push(...annotations.filter(value=>Number.isFinite(value)&&(type!=='log'||value>0)));
 const zero=type==='linear'&&options[`${side}_zero`]!==false;
 // Work in logarithmic space so padding has the same visual size on both scales.
 const project=(value:number)=>type==='log'?Math.log(value):value,restore=(value:number)=>type==='log'?Math.max(Number.MIN_VALUE,Math.exp(value)):value;
 let dataMin=Infinity,dataMax=-Infinity;
 for(const value of values){const projected=project(value);dataMin=Math.min(dataMin,projected);dataMax=Math.max(dataMax,projected);}
 if(!values.length){dataMin=typeof min==='number'?project(min):typeof max==='number'?project(max)-(type==='log'?1:Math.abs(max)*0.1||1):0;dataMax=typeof max==='number'?project(max):dataMin+(type==='log'?1:Math.abs(dataMin)*0.1||1);}
 let lower=typeof min==='number'?project(min):zero?Math.min(0,dataMin):dataMin,upper=typeof max==='number'?project(max):zero?Math.max(0,dataMax):dataMax;
 if(lower>upper)throw new Error(`${side==='right'?'右':'左'}轴范围与数据不相容，请检查上下界`);
 let padLower=min===undefined&&!(zero&&dataMin>=0),padUpper=max===undefined&&!(zero&&dataMax<0);
 if(lower===upper&&!padLower&&!padUpper){padLower=min===undefined;padUpper=max===undefined;}
 if(lower===upper){const half=type==='log'?Math.log(1.1):Math.abs(lower)*0.05||1;if(padLower)lower-=half;if(padUpper)upper+=half;}
 // Automatic extrema sit at 15% / 85%; a zero baseline or manual bound stays fixed.
 const padding=(upper-lower)*0.15/(1-Number(padLower)*0.15-Number(padUpper)*0.15);
 const domain=[typeof min==='number'?min:restore(lower-(padLower?padding:0)),typeof max==='number'?max:restore(upper+(padUpper?padding:0))].map(value=>Math.max(-Number.MAX_VALUE,Math.min(Number.MAX_VALUE,value)));
 if(domain[0]>=domain[1])throw new Error(`${side==='right'?'右':'左'}轴范围与数据不相容，请检查上下界`);
 return {key:`lightmoni-${side}-y`,type,domain,nice:false,zero:false};
}
export {formatValue} from './formatting';
export const chartTypes=[{value:'line',label:'时间序列 · 折线'},{value:'area',label:'时间序列 · 面积'},{value:'bar',label:'柱状图'},{value:'pie',label:'饼图 / 环图'},{value:'stat',label:'指标卡'},{value:'table',label:'数据表格'},{value:'gauge',label:'仪表盘'},{value:'heatmap',label:'热力图'},{value:'histogram',label:'直方图'},{value:'timeline',label:'状态时间线'}];
// Five rows leave space for the header, axes and legend; compact values/tables need three.
export function panelMinHeight(type:string):number{return ['stat','table'].includes(type)?3:5;}
export function frameFields(results:QueryResult[]):{name:string;type:string}[]{return [...new Map(resultFrames(results).flatMap(({frame})=>frame.columns.map(column=>[column.name,column] as const))).values()];}
export function adaptPanelType(panel:Panel,type:string,results:QueryResult[]):Panel{
 const fields=frameFields(results),numberFields=fields.filter(field=>/Int|Float|Decimal|Number|Double/i.test(field.type)),time=fields.find(field=>/DateTime|^Date(?:32)?$/i.test(field.type)),text=fields.find(field=>/String|Enum|Bool/i.test(field.type));
 const options={...panel.options};if(panel.type==='histogram'&&type!=='histogram'&&options.histogram_value_unit!==undefined)options.unit=options.histogram_value_unit;
 if(!['line','area','bar','timeseries'].includes(type))options.right_axis_refs=[];
 const exists=(name:unknown)=>fields.some(field=>field.name===name),isNumeric=(name:unknown)=>numberFields.some(field=>field.name===name);
 if(fields.length){
  if(type==='pie')options.x=text?.name??fields[0].name;
  else if(type==='histogram'){options.histogram_value_unit=panel.type==='histogram'?options.histogram_value_unit:options.unit;options.unit='';options.histogram_mode='auto';options.x=numberFields[0]?.name??fields[0].name;}
  else if(!exists(options.x)||['line','area','timeline','heatmap'].includes(type)&&time)options.x=time?.name??fields[0].name;
  if(type==='timeline'){const state=fields.find(field=>/^(state|status|severity)$/i.test(field.name));options.y=state?.name??(exists(options.y)?options.y:text?.name);options.timeline_mode=exists(options.upper)?'explicit':'auto';}
  else if(!isNumeric(options.y))options.y=numberFields[0]?.name??fields[1]?.name??fields[0].name;
  if(!exists(options.series))options.series=fields.find(field=>field.name!==options.x&&field.name!==options.y&&/String|Enum/i.test(field.type))?.name;
 }
 if(type==='pie')options.pie_reducer=options.pie_reducer??(['percent','percentunit'].includes(String(options.unit))?'mean':'sum');
 if(type==='gauge'){const max=options.unit==='percentunit'?1:100;options.min=options.min??0;options.max=options.max??max;}
 return {...panel,type,options,grid:{...panel.grid,h:Math.max(panel.grid.h,panelMinHeight(type))}};
}
export function histogramRows(rows:Record<string,unknown>[],bins=20):Record<string,unknown>[]{
 const finite=rows.filter(row=>typeof row.__y==='number'&&Number.isFinite(row.__y)),values=finite.map(row=>Number(row.__y));if(!values.length)return [];
 let min=Math.min(...values),max=Math.max(...values);if(min===max){const half=Math.abs(min)*0.05||0.5;min-=half;max+=half;}const count=Math.max(1,Math.min(100,Math.floor(bins)||20)),width=(max-min)/count,groups=new Map<string,Record<string,unknown>>();
 for(const row of finite){const bucket=Math.min(count-1,Math.floor((Number(row.__y)-min)/width)),key=String(row.__series)+'\0'+bucket,previous=groups.get(key),n=Number(previous?.__y??0)+1;groups.set(key,{...row,__x:min+bucket*width,__upper:min+(bucket+1)*width,__y:n,__rawY:n,__isTime:false});}
 return [...groups.values()].sort((a,b)=>Number(a.__x)-Number(b.__x));
}
export function timelineRows(rows:Record<string,unknown>[],interval=60000):Record<string,unknown>[]{
 const groups=new Map<string,Record<string,unknown>[]>();for(const row of rows){if(!row.__isTime||!Number.isFinite(row.__x))throw new Error('自动状态区间需要有效的时间字段');const key=String(row.__refId)+'\0'+String(row.__series),group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 return [...groups.values()].flatMap(group=>{const sorted=[...group].sort((a,b)=>Number(a.__x)-Number(b.__x)),steps=sorted.slice(1).map((row,index)=>Number(row.__x)-Number(sorted[index].__x)).filter(step=>step>0),cadence=steps.length?Math.min(...steps):interval;return sorted.map((row,index)=>({...row,__upper:Number(sorted[index+1]?.__x??Number(row.__x)+Math.max(1,cadence))}));});
}
export function pieRows(rows:Record<string,unknown>[],reducer='sum',approximate=false):Record<string,unknown>[]{
 const groups=new Map<string,Record<string,unknown>[]>(),refs=new Set(rows.map(row=>row.__refId));for(const row of rows){const key=String(row.__refId)+'\0'+printable(row.__x),group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 return [...groups.values()].map(group=>{const values=group.map(row=>row.__y).filter((value):value is number=>typeof value==='number'),total=values.reduce((sum,value)=>sum+value,0),value=reducer==='last'?group.at(-1)?.__y:reducer==='mean'?(values.length?total/values.length:null):total;if(!approximate&&reducer==='sum'&&values.every(Number.isInteger)&&typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('饼图汇总超过安全整数精度，请在 SQL 中汇总或明确开启近似数值');return {...group[0],__x:(refs.size>1?`${group[0].__refId} · `:'')+printable(group[0].__x),__y:value,__rawY:value};});
}
export const emptyDashboard=():Dashboard=>({id:'',title:'新大盘',description:'',panels:[],variables:[],range:{from:'now-1h',to:'now'},refresh:0,revision:0});
export function visibleSQL(sql:string):string {
 const text=sql.split('');
 for(let index=0;index<sql.length;index++){
  const char=sql[index];if(char==='\''||char==='"'||char==='`'){const quote=char,start=index;for(index++;index<sql.length;index++){if(sql[index]==='\\'){index++;continue;}if(sql[index]===quote){if(sql[index+1]===quote){index++;continue;}break;}}for(let j=start;j<=index&&j<text.length;j++)text[j]=' ';continue;}
  if(sql.slice(index,index+2)==='--'){const start=index,end=sql.indexOf('\n',index+2);index=end===-1?sql.length:end;for(let j=start;j<index;j++)text[j]=' ';continue;}
  if(sql.slice(index,index+2)==='/*'){const start=index,end=sql.indexOf('*/',index+2);index=end===-1?sql.length:end+1;for(let j=start;j<=index&&j<text.length;j++)text[j]=' ';}
 }return text.join('');
}
export function parameterReferences(sql:string):{name:string;type:string}[]{return [...visibleSQL(sql).matchAll(/\{([A-Za-z]\w*):([^}]+)\}/g)].map(match=>({name:match[1],type:match[2]}));}
export const hasTimeBuckets=(sql:string)=>/\$__timeInterval\s*\(/.test(visibleSQL(sql));

export function resolveRange(range:TimeRange,now=Date.now()):TimeRange {
 const parse=(value:string)=>{if(value==='now')return now;const match=/^now-(\d+)(s|m|h|d)$/.exec(value);if(match)return now-Number(match[1])*({s:1000,m:60000,h:3600000,d:86400000}[match[2] as 's'|'m'|'h'|'d']);const n=Date.parse(value);if(!Number.isFinite(n))throw new Error('时间需要为 now-1h 等相对范围或 ISO 日期');return n;};
 const from=parse(range.from),to=parse(range.to);if(from>=to)throw new Error('开始时间必须早于结束时间');return {from:new Date(from).toISOString(),to:new Date(to).toISOString()};
}
export function variableOrder(variables:Variable[]):Variable[]{
 const names=new Set(variables.map(v=>v.name)),done=new Set<string>(),active=new Set<string>(),ordered:Variable[]=[];
 const visit=(v:Variable)=>{if(done.has(v.name))return;if(active.has(v.name))throw new Error(`变量依赖循环：${v.name}`);active.add(v.name);for(const ref of parameterReferences(v.sql??'')){if(names.has(ref.name))visit(variables.find(item=>item.name===ref.name)!);}active.delete(v.name);done.add(v.name);ordered.push(v);};variables.forEach(visit);return ordered;
}
export function bindQueries(queries:DashboardQuery[],variables:Variable[],values:Values,choices:Record<string,string[]>):SQLQuery[]{
 return queries.filter(q=>q.enabled!==false).map(q=>{const params:Record<string,Parameter>={...q.params};for(const {name,type} of parameterReferences(q.sql)){
  const v=variables.find(item=>item.name===name);if(!v)continue;let value=values[name]??v.value??'';if(Array.isArray(value)&&value.includes('__all__'))value=choices[name]??v.options??[];
  if(type.startsWith('Array(')){value=Array.isArray(value)?value:[value];}else{if(Array.isArray(value)){if(value.length!==1)throw new Error(`变量 ${name} 为多选，请使用 {${name}:Array(String)} 和 IN`);value=value[0];}if(type!=='String'&&/^(U?Int|Float|Decimal)/.test(type)&&!/^[-+]?\d+(\.\d+)?$/.test(String(value)))throw new Error(`变量 ${name} 需要数值`);}
  params[name]={type,value};
 };return {refId:q.refId,sql:q.sql,params};});
}
export function newPanel(template?:Template,index=0):Panel {return {id:crypto.randomUUID(),title:template?.title??'新面板',type:template?.type??'line',queries:[{refId:'A',sql:template?.sql??'',params:{}}],options:{x:'time',y:'value',show_points:false,...template?.options},grid:{x:(index%2)*6,y:Math.floor(index/2)*6,w:6,h:6}};}
export function numeric(value:unknown,approximate=false):number|null{
 if(value===null||value===undefined)return null;if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value==='string'&&/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)){
  const n=Number(value);if(!Number.isFinite(n))return null;
  const integer=!value.includes('.')&&!value.toLowerCase().includes('e');
  if(!approximate&&(integer?!Number.isSafeInteger(n):value.replace(/[^0-9]/g,'').replace(/^0+/,'').length>15))throw new Error('数值超过浏览器安全精度。表格保留原值；可明确开启“图表近似数值”或在 SQL 中缩放后转换。');return n;
 }return null;
}
export const printable=(v:unknown)=>v===null?'null':v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
export function resultFrames(results:QueryResult[]):{refId:string;frame:QueryFrame}[]{return results.flatMap(r=>r.frames.map(frame=>({refId:r.refId,frame})));}
export function intervalFor(range:TimeRange,width=600):number{return Math.max(1000,Math.ceil((Date.parse(range.to)-Date.parse(range.from))/Math.max(100,Math.min(1000,width)) /1000)*1000);}
