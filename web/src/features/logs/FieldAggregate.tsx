import {useMonitoringI18n} from '../monitoring-i18n';
import {useEffect,useState} from 'react';
import {Alert,Button,Empty,Select,Spin,Tooltip} from '../../shared/ui';
import {post} from '../../shared/api';
import type {QueryFrame} from '../../shared/types';
import {asRows,printable,type Filter,type Spec} from './model';

interface Aggregate {frame:QueryFrame;field:string;total:string|number;present:string|number;truncated:boolean;generated_at:string;scope:string}
export function useFieldAggregate(spec:Spec,field:string|undefined,version?:string){
 const [data,setData]=useState<{value:Aggregate;signature:string}>(),[loading,setLoading]=useState(false),[error,setError]=useState('');const signature=JSON.stringify(spec);
 useEffect(()=>{if(!field||!spec.table_id){setData(undefined);return}const abort=new AbortController();setLoading(true);setError('');void post<Aggregate>('/logs/aggregate',{spec:JSON.parse(signature),field,limit:10},abort.signal).then(result=>{if(!abort.signal.aborted)setData({value:result,signature})}).catch(err=>{if(!abort.signal.aborted)setError((err as Error).message)}).finally(()=>{if(!abort.signal.aborted)setLoading(false)});return()=>abort.abort()},[signature,field,version]);
 return {data:data?.signature===signature&&data.value.field===field?data.value:undefined,loading,error};
}
export function aggregateFilter(field:string,value:unknown,rawType:unknown,op='eq'):Filter|undefined{
 const kind=String(rawType),attr=field.startsWith('attr:');if(kind==='Null'||kind==='Array'||kind==='Object')return;
 let normalized=value,type:Filter['type']=/Number|Int|Float/.test(kind)?'number':kind==='Bool'?'boolean':'string';
 if(attr){if(type==='number'){const raw=String(value);normalized=/^-?\d+$/.test(raw)&&!Number.isSafeInteger(Number(raw))?raw:Number(raw)}else if(type==='boolean')normalized=String(value)==='true';else {try{normalized=JSON.parse(String(value))}catch{/* original scalar */}}}
 return {scope:attr?'attribute':'column',field:field.replace(/^attr:/,''),type,op,value:normalized};
}
export function TopValues({field,data,onFilter,compact=false}:{field:string;data:Aggregate;onFilter:(filter:Filter)=>void;compact?:boolean}){
 const {l,language}=useMonitoringI18n();

 const values=asRows(data.frame),total=Number(data.total),present=Number(data.present);return <div className={`lm-log-aggregate-values ${compact?'compact':''}`}>
  {values.length?values.map(row=>{const f=aggregateFilter(field,row.value,row.value_type),label=printable(f?.value??row.value),percent=total?Number(row.count)/total*100:0;return <div className="lm-log-value-row" key={String(row.value_type)+String(row.value)}><button disabled={!f} title={l("筛选 {0} = {1}",field,label)} onClick={()=>f&&onFilter(f)}><span className="lm-log-value-bar" style={{width:percent+'%'}}/><span className="lm-log-value-label">{label||l("空字符串")}</span>{field.startsWith('attr:')&&<span className="lm-log-value-type">{f?.type==='number'?l("数字"):f?.type==='boolean'?l("布尔"):f?.type==='string'?l("文本"):String(row.value_type)}</span>}<b>{String(row.count)}</b><small>{percent.toFixed(1)}%</small></button>{f&&<Tooltip title={l("排除此值")}><Button size="small" type="text" aria-label={l("排除 {0} {1}",field,label)} onClick={()=>onFilter({...f,op:'ne'})}>−</Button></Tooltip>}</div>}):<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={l("此字段没有匹配值")}/>}
  <small className="lm-log-aggregate-scope">{total.toLocaleString()} {l(" 条匹配 · ")}{present.toLocaleString()} {l(" 条有此字段")}{total>present?l(" · {0} 条缺失",(total-present).toLocaleString()):''}{data.truncated?l(" · 聚合已截断"):''}</small>
 </div>
}
export default function FieldAggregate({spec,fields,version,onFilter,field,onField,onMore,expanded=false}:{spec:Spec;fields:string[];version?:string;onFilter:(f:Filter)=>void;field:string;onField:(field:string)=>void;onMore?:()=>void;expanded?:boolean}){
 const {l,language}=useMonitoringI18n();

 const {data,loading,error}=useFieldAggregate(spec,field,version);return <section className={`lm-log-aggregate ${expanded?'expanded':''}`}><header><b>{l("字段聚合")}</b><Select size="small" aria-label={l("聚合维度")} showSearch value={field} options={fields.map(name=>({value:name,label:name==='severity'?'severity / level':name.replace(/^attr:/,'@ ')}))} onChange={onField}/><div className="lm-log-aggregate-shortcuts"><Button size="small" type={field==='service'?'primary':'text'} onClick={()=>onField('service')}>service</Button><Button size="small" type={field==='severity'?'primary':'text'} onClick={()=>onField('severity')}>level</Button></div>{loading&&<Spin size="small"/>}<small>{l("Top 10 · 当前查询范围")}</small>{!expanded&&onMore&&<Button size="small" type="link" onClick={onMore}>{l("查看更多")}</Button>}</header>{expanded&&<p className="lm-log-aggregate-range">{new Date(spec.range.from).toLocaleString()} — {new Date(spec.range.to).toLocaleString()} {l(" · 当前查询完整范围的 Top 值；点击任意值查看原始日志。")}</p>}{error?<Alert type="error" title={error}/>:data?<TopValues field={field} data={data} onFilter={onFilter} compact={!expanded}/>:<Spin size="small"/>}</section>
}
