import {useEffect,useState} from 'react';
import {Alert,App,Button,Empty,Input,InputNumber,Modal,Select,Space,Spin,Tabs} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable} from '../shared/types';
import {copyLogSampling,copyExclusions,type LogCondition,type LogRule,type LogExcludeRule,type LogSamplingPolicy} from '../../../sdk/typescript/src/sampling';
import './log-reporting.css';

type Condition={field:string;operator:'in'|'exists';type:'string'|'number'|'boolean';text:string};
type Rule={name:string;percent:number;conditions:Condition[]};
const condition=():Condition=>({field:'attr:user_id',operator:'in',type:'string',text:''});
const fromConditions=(values:LogCondition[]):Condition[]=>values.map(c=>({field:c.field,operator:c.operator,type:typeof c.values?.[0]==='boolean'?'boolean':typeof c.values?.[0]==='number'?'number':'string',text:c.values?.map(String).join('\n')??''}));
function toConditions(values:Condition[]):LogCondition[]{return values.map(c=>{
 if(!c.field.trim())throw new Error('请填写匹配字段');
 if(c.operator==='exists')return {field:c.field.trim(),operator:'exists'};
 const lines=c.text.split('\n').map(v=>v.trim()).filter(Boolean);if(!lines.length)throw new Error('请填写匹配值，每行一个');
 const parsed=lines.map(v=>{if(c.type==='boolean'){if(!['true','false'].includes(v))throw new Error('布尔值请填写 true 或 false');return v==='true';}if(c.type==='number'){const n=Number(v);if(!Number.isFinite(n)||Number.isInteger(n)&&!Number.isSafeInteger(n))throw new Error('数字必须有限且精确；长 UID 请使用字符串');return n;}return v;});
 return {field:c.field.trim(),operator:'in',values:parsed};
});}
function Conditions({value,onChange,disabled,sdk=false}:{value:Condition[];onChange:(v:Condition[])=>void;disabled:boolean;sdk?:boolean}){
 const update=(i:number,patch:Partial<Condition>)=>onChange(value.map((c,index)=>index===i?{...c,...patch}:c));
 return <div className="lm-log-conditions">{value.map((c,i)=><div className="lm-log-condition" key={i}>
  <div className="lm-log-condition-fields"><Input aria-label={`匹配字段 ${i+1}`} value={c.field} disabled={disabled} onChange={e=>update(i,{field:e.target.value})} placeholder={sdk?'service 或 instance_id':'attr:user_id'}/><Select aria-label={`匹配方式 ${i+1}`} value={c.operator} disabled={disabled} onChange={operator=>update(i,{operator})} options={[{value:'in',label:'等于任一值'},{value:'exists',label:'字段存在'}]}/><Button disabled={disabled} size="small" onClick={()=>onChange(value.filter((_,index)=>index!==i))}>删除条件</Button></div>
  {c.operator==='in'&&<div className="lm-log-condition-values"><Select aria-label={`值类型 ${i+1}`} value={c.type} disabled={disabled} onChange={type=>update(i,{type})} options={[{value:'string',label:'字符串'},{value:'number',label:'数字'},{value:'boolean',label:'布尔值'}]}/><Input.TextArea aria-label={`匹配值 ${i+1}`} value={c.text} autoSize={{minRows:1,maxRows:4}} disabled={disabled} onChange={e=>update(i,{text:e.target.value})} placeholder="每行一个值"/></div>}
 </div>)}<Button size="small" disabled={disabled||value.length>=8} onClick={()=>onChange([...value,{...condition(),field:sdk?'service':'attr:user_id'}])}>添加条件</Button></div>;
}
function RuleList({value,onChange,disabled,exclude=false,sdk=false}:{value:Rule[];onChange:(v:Rule[])=>void;disabled:boolean;exclude?:boolean;sdk?:boolean}){
 const update=(i:number,patch:Partial<Rule>)=>onChange(value.map((r,index)=>index===i?{...r,...patch}:r));
 return <div className="lm-log-rules">{value.length===0&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={exclude?'尚未配置排除规则':'未配置上报规则，业务日志将全部忽略'}/>}{value.map((r,i)=><div className="lm-log-rule" key={i}>
  <div className="lm-log-rule-heading"><Input aria-label={`规则名称 ${i+1}`} value={r.name} disabled={disabled} placeholder="规则名称" onChange={e=>update(i,{name:e.target.value})}/>{!exclude&&<label>保留 <InputNumber aria-label={`保留比例 ${i+1}`} value={r.percent} min={0} max={100} precision={4} formatter={(v,info)=>info.userTyping?info.input:String(v??'').replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1')} suffix="%" disabled={disabled} onChange={v=>update(i,{percent:v??0})}/></label>}<Button danger disabled={disabled} size="small" onClick={()=>onChange(value.filter((_,index)=>index!==i))}>删除规则</Button></div>
  {!exclude&&r.conditions.length===0&&<p className="lm-log-rule-all">匹配所有日志</p>}
  <Conditions value={r.conditions} onChange={conditions=>update(i,{conditions})} disabled={disabled} sdk={sdk}/>
 </div>)}<Button disabled={disabled||value.length>=32} onClick={()=>onChange([...value,{name:`规则 ${value.length+1}`,percent:100,conditions:[{...condition(),field:sdk?'service':'attr:user_id'}]}])}>添加{exclude?'排除':'上报'}规则</Button></div>;
}
const toExclusions=(rules:Rule[]):LogExcludeRule[]=>rules.map(r=>({name:r.name,conditions:toConditions(r.conditions)}));
const fromRules=(rules:LogExcludeRule[]):Rule[]=>rules.map(r=>({name:r.name,percent:'rate'in r?(r as LogRule).rate*100:100,conditions:fromConditions(r.conditions)}));
const text=(e:unknown)=>e instanceof Error?e.message:'操作失败';

export function LogReportingEditor({table,onClose}:{table?:CatalogTable;onClose:()=>void}){
 const {message}=App.useApp(),[rules,setRules]=useState<Rule[]>([]),[exclude,setExclude]=useState<Rule[]>([]),[key,setKey]=useState('event_id'),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 useEffect(()=>{if(!table)return;const abort=new AbortController();setLoading(true);setLoaded(false);setError('');api<LogSamplingPolicy>(`/catalog/tables/${encodeURIComponent(table.id)}/log-sampling`,{signal:abort.signal}).then(p=>{setRules(fromRules(p.rules));setExclude(fromRules(p.exclude??[]));setKey(p.key??'event_id');setLoaded(true);}).catch(e=>{if(!abort.signal.aborted)setError(text(e));}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[table]);
 const disabled=loading||saving||!loaded;
 const save=async()=>{if(!table)return;setSaving(true);setError('');try{const policy=copyLogSampling({key,rules:rules.map(r=>({name:r.name,rate:r.percent/100,conditions:toConditions(r.conditions)})),exclude:toExclusions(exclude)});await api(`/catalog/tables/${encodeURIComponent(table.id)}/log-sampling`,{method:'PUT',body:JSON.stringify(policy)});void message.success('日志上报规则已保存，SDK 将动态更新');onClose();}catch(e){setError(text(e));}finally{setSaving(false);}};
 return <Modal title={`日志上报规则 · ${table?.name??''}`} width={760} style={{top:32}} open={!!table} styles={{body:{maxHeight:'calc(100dvh - 220px)',overflowY:'auto'}}} onCancel={()=>{if(!saving)onClose();}} onOk={()=>void save()} okText="保存并下发" cancelText="取消" confirmLoading={saving} okButtonProps={{disabled:loading||!loaded}} destroyOnHidden>
  <p>先检查排除规则，再检查上报规则。未命中上报规则的日志不入队；多条命中时取最高保留比例。</p>
  <p className="lm-log-hint">Go、Node.js 和浏览器 SDK 默认每 30 秒更新。指标与链路保持完整上报。</p>
  {error&&<Alert type="error" title={error} style={{marginBottom:12}}/>}{loading?<Spin/>:<><div className="lm-log-sampling-key"><span>稳定采样依据</span><Input aria-label="稳定采样依据" disabled={disabled} value={key} onChange={e=>setKey(e.target.value)} placeholder="event_id 或 attr:session_id"/></div><p className="lm-log-hint">使用 attr:user_id 或 attr:session_id 保留完整用户或会话；字段缺失时按单条日志采样。匹配字段支持 attr:属性、resource:资源属性、service 和 severity。</p>
  <Tabs items={[{key:'report',label:`上报规则 (${rules.length})`,children:<><Space wrap style={{marginBottom:12}}><Button disabled={disabled} onClick={()=>setRules([...rules,{name:'QA 用户',percent:100,conditions:[condition()]}])}>添加 QA 用户</Button><Button disabled={disabled} onClick={()=>setRules([...rules,{name:'VIP 用户',percent:100,conditions:[{field:'attr:is_vip',operator:'in',type:'boolean',text:'true'}]}])}>添加 VIP 用户</Button><Button disabled={disabled} onClick={()=>setRules([...rules,{name:'错误日志',percent:100,conditions:[{field:'severity',operator:'in',type:'string',text:'ERROR\nFATAL'}]}])}>添加错误日志</Button><Button disabled={disabled} onClick={()=>setRules([...rules,{name:'普通日志',percent:10,conditions:[]}])}>添加全部日志 10%</Button></Space><RuleList value={rules} onChange={setRules} disabled={disabled}/></>},{key:'exclude',label:`排除规则 (${exclude.length})`,children:<><p>命中任一排除规则即忽略日志，包括 QA、VIP 和错误日志。可用 attr:user_id 屏蔽指定 UID。</p><RuleList value={exclude} onChange={setExclude} disabled={disabled} exclude/></>}]}/></>}
 </Modal>;
}

export function SDKReportingEditor({open,onClose}:{open:boolean;onClose:()=>void}){
 const {message}=App.useApp(),[rules,setRules]=useState<Rule[]>([]),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!open)return;const abort=new AbortController();setLoading(true);setLoaded(false);setError('');api<{disable_rules:LogExcludeRule[]}>('/settings/sdk-reporting',{signal:abort.signal}).then(p=>{setRules(fromRules(p.disable_rules));setLoaded(true);}).catch(e=>{if(!abort.signal.aborted)setError(text(e));}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[open]);
 return <Modal title="SDK 停报规则" open={open} width={760} style={{top:32}} styles={{body:{maxHeight:'calc(100dvh - 220px)',overflowY:'auto'}}} onCancel={()=>{if(!saving)onClose();}} okText="保存并下发" cancelText="取消" okButtonProps={{disabled:loading||!loaded}} confirmLoading={saving} onOk={async()=>{setSaving(true);setError('');try{const disable_rules=copyExclusions(toExclusions(rules),true);await api('/settings/sdk-reporting',{method:'PUT',body:JSON.stringify({disable_rules})});void message.success('SDK 停报规则已保存');onClose();}catch(e){setError(text(e));}finally{setSaving(false);}}} destroyOnHidden>
  <p>命中任一规则后，该 SDK 停止日志、指标、链路和自监控上报，并清空未发送数据；配置更新继续运行，移除规则后自动恢复。</p><p className="lm-log-hint">支持 Go、Node.js 和浏览器 SDK。字段可填写 service、instance_id、sdk.language 或 resource:资源属性。同一规则的多个条件必须全部命中。</p>
  {error&&<Alert type="error" title={error} style={{marginBottom:12}}/>}{loading?<Spin/>:<RuleList value={rules} onChange={setRules} disabled={loading||saving||!loaded} exclude sdk/>}
 </Modal>;
}
