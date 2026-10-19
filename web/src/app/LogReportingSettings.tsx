import {useI18n} from '../shared/i18n';
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

function Conditions({value,onChange,disabled,sdk=false}:{value:Condition[];onChange:(v:Condition[])=>void;disabled:boolean;sdk?:boolean}){
 const {t}=useI18n();
const update=(i:number,patch:Partial<Condition>)=>onChange(value.map((c,index)=>index===i?{...c,...patch}:c));
 return <div className="lm-log-conditions">{value.map((c,i)=><div className="lm-log-condition" key={i}>
  <div className="lm-log-condition-fields"><Input aria-label={t(`匹配字段 ${i+1}`,`Matching field ${i+1}`)} value={c.field} disabled={disabled} onChange={e=>update(i,{field:e.target.value})} placeholder={sdk?t("service 或 instance_id","service or instance_id"):'attr:user_id'}/><Select aria-label={t(`匹配方式 ${i+1}`,`Matching operator ${i+1}`)} value={c.operator} disabled={disabled} onChange={operator=>update(i,{operator})} options={[{value:'in',label:t("等于任一值","Equals any value")},{value:'exists',label:t("字段存在","Field exists")}]}/><Button disabled={disabled} size="small" onClick={()=>onChange(value.filter((_,index)=>index!==i))}>{t("删除条件","Remove condition")}</Button></div>
  {c.operator==='in'&&<div className="lm-log-condition-values"><Select aria-label={t(`值类型 ${i+1}`,`Value type ${i+1}`)} value={c.type} disabled={disabled} onChange={type=>update(i,{type})} options={[{value:'string',label:t("字符串","String")},{value:'number',label:t("数字","Number")},{value:'boolean',label:t("布尔值","Boolean")}]}/><Input.TextArea aria-label={t(`匹配值 ${i+1}`,`Matching value ${i+1}`)} value={c.text} autoSize={{minRows:1,maxRows:4}} disabled={disabled} onChange={e=>update(i,{text:e.target.value})} placeholder={t("每行一个值","One value per line")}/></div>}
 </div>)}<Button size="small" disabled={disabled||value.length>=8} onClick={()=>onChange([...value,{...condition(),field:sdk?'service':'attr:user_id'}])}>{t("添加条件","Add condition")}</Button></div>;
}
function RuleList({value,onChange,disabled,exclude=false,sdk=false}:{value:Rule[];onChange:(v:Rule[])=>void;disabled:boolean;exclude?:boolean;sdk?:boolean}){
 const {t}=useI18n();

 const update=(i:number,patch:Partial<Rule>)=>onChange(value.map((r,index)=>index===i?{...r,...patch}:r));
 return <div className="lm-log-rules">{value.length===0&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={exclude?t("尚未配置排除规则","No exclusion rules configured"):t("未配置上报规则，业务日志将全部忽略","No reporting rules configured; all business logs will be ignored")}/>}{value.map((r,i)=><div className="lm-log-rule" key={i}>
  <div className="lm-log-rule-heading"><Input aria-label={t(`规则名称 ${i+1}`,`Rule name ${i+1}`)} value={r.name} disabled={disabled} placeholder={t("规则名称","Rule name")} onChange={e=>update(i,{name:e.target.value})}/>{!exclude&&<label>{t("保留","Keep")} <InputNumber aria-label={t(`保留比例 ${i+1}`,`Retention percentage ${i+1}`)} value={r.percent} min={0} max={100} precision={4} formatter={(v,info)=>info.userTyping?info.input:String(v??'').replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1')} suffix="%" disabled={disabled} onChange={v=>update(i,{percent:v??0})}/></label>}<Button danger disabled={disabled} size="small" onClick={()=>onChange(value.filter((_,index)=>index!==i))}>{t("删除规则","Remove rule")}</Button></div>
  {!exclude&&r.conditions.length===0&&<p className="lm-log-rule-all">{t("匹配所有日志","Match all logs")}</p>}
  <Conditions value={r.conditions} onChange={conditions=>update(i,{conditions})} disabled={disabled} sdk={sdk}/>
 </div>)}<Button disabled={disabled||value.length>=32} onClick={()=>onChange([...value,{name:t(`规则 ${value.length+1}`,`Rule ${value.length+1}`),percent:100,conditions:[{...condition(),field:sdk?'service':'attr:user_id'}]}])}>{exclude?t("添加排除规则","Add exclusion rule"):t("添加上报规则","Add reporting rule")}</Button></div>;
}

const fromRules=(rules:LogExcludeRule[]):Rule[]=>rules.map(r=>({name:r.name,percent:'rate'in r?(r as LogRule).rate*100:100,conditions:fromConditions(r.conditions)}));

export function LogReportingEditor({table,onClose}:{table?:CatalogTable;onClose:()=>void}){
 const {t}=useI18n();
function toConditions(values:Condition[]):LogCondition[]{return values.map(c=>{
 if(!c.field.trim())throw new Error(t("请填写匹配字段","Enter a matching field"));
 if(c.operator==='exists')return {field:c.field.trim(),operator:'exists'};
 const lines=c.text.split('\n').map(v=>v.trim()).filter(Boolean);if(!lines.length)throw new Error(t("请填写匹配值，每行一个","Enter matching values, one per line"));
 const parsed=lines.map(v=>{if(c.type==='boolean'){if(!['true','false'].includes(v))throw new Error(t("布尔值请填写 true 或 false","Enter true or false for boolean values"));return v==='true';}if(c.type==='number'){const n=Number(v);if(!Number.isFinite(n)||Number.isInteger(n)&&!Number.isSafeInteger(n))throw new Error(t("数字必须有限且精确；长 UID 请使用字符串","Numbers must be finite and precise. Use strings for long UIDs"));return n;}return v;});
 return {field:c.field.trim(),operator:'in',values:parsed};
});}
const toExclusions=(rules:Rule[]):LogExcludeRule[]=>rules.map(r=>({name:r.name,conditions:toConditions(r.conditions)}));
const text=(e:unknown)=>e instanceof Error?e.message:t("操作失败","Operation failed");

 const {message}=App.useApp(),[rules,setRules]=useState<Rule[]>([]),[exclude,setExclude]=useState<Rule[]>([]),[key,setKey]=useState('event_id'),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 useEffect(()=>{if(!table)return;const abort=new AbortController();setLoading(true);setLoaded(false);setError('');api<LogSamplingPolicy>(`/catalog/tables/${encodeURIComponent(table.id)}/log-sampling`,{signal:abort.signal}).then(p=>{setRules(fromRules(p.rules));setExclude(fromRules(p.exclude??[]));setKey(p.key??'event_id');setLoaded(true);}).catch(e=>{if(!abort.signal.aborted)setError(text(e));}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[table]);
 const disabled=loading||saving||!loaded;
 const save=async()=>{if(!table)return;setSaving(true);setError('');try{const policy=copyLogSampling({key,rules:rules.map(r=>({name:r.name,rate:r.percent/100,conditions:toConditions(r.conditions)})),exclude:toExclusions(exclude)});await api(`/catalog/tables/${encodeURIComponent(table.id)}/log-sampling`,{method:'PUT',body:JSON.stringify(policy)});void message.success(t("日志上报规则已保存，SDK 将动态更新","Log reporting rules saved. SDKs will update dynamically"));onClose();}catch(e){setError(text(e));}finally{setSaving(false);}};
 return <Modal title={t(`日志上报规则 · ${table?.name??''}`,`Log reporting rules · ${table?.name??''}`)} width={760} style={{top:32}} open={!!table} styles={{body:{maxHeight:'calc(100dvh - 220px)',overflowY:'auto'}}} onCancel={()=>{if(!saving)onClose();}} onOk={()=>void save()} okText={t("保存并下发","Save and distribute")} cancelText={t("取消","Cancel")} confirmLoading={saving} okButtonProps={{disabled:loading||!loaded}} destroyOnHidden>
  <p>{t("先检查排除规则，再检查上报规则。未命中上报规则的日志不入队；多条命中时取最高保留比例。","Exclusion rules are checked before reporting rules. Logs that match no reporting rule are not queued. If multiple rules match, the highest retention percentage applies.")}</p>
  <p className="lm-log-hint">{t("Go、Node.js、浏览器和 Python SDK 默认每 30 秒更新。指标与链路保持完整上报。","Go, Node.js, browser, and Python SDKs update every 30 seconds by default. Metrics and traces continue to be reported in full.")}</p>
  {error&&<Alert type="error" title={error} style={{marginBottom:12}}/>}{loading?<Spin/>:<><div className="lm-log-sampling-key"><span>{t("稳定采样依据","Stable sampling key")}</span><Input aria-label={t("稳定采样依据","Stable sampling key")} disabled={disabled} value={key} onChange={e=>setKey(e.target.value)} placeholder={t("event_id 或 attr:session_id","event_id or attr:session_id")}/></div><p className="lm-log-hint">{t("使用 attr:user_id 或 attr:session_id 保留完整用户或会话；字段缺失时按单条日志采样。匹配字段支持 attr:属性、resource:资源属性、service 和 severity。","Use attr:user_id or attr:session_id to retain complete users or sessions. When the key is missing, sampling applies per log. Matching supports attr:attribute, resource:resource_attribute, service, and severity.")}</p>
  <Tabs items={[{key:'report',label:t(`上报规则 (${rules.length})`,`Reporting rules (${rules.length})`),children:<><Space wrap style={{marginBottom:12}}><Button disabled={disabled} onClick={()=>setRules([...rules,{name:t("QA 用户","QA users"),percent:100,conditions:[condition()]}])}>{t("添加 QA 用户","Add QA users")}</Button><Button disabled={disabled} onClick={()=>setRules([...rules,{name:t("VIP 用户","VIP users"),percent:100,conditions:[{field:'attr:is_vip',operator:'in',type:'boolean',text:'true'}]}])}>{t("添加 VIP 用户","Add VIP users")}</Button><Button disabled={disabled} onClick={()=>setRules([...rules,{name:t("错误日志","Error logs"),percent:100,conditions:[{field:'severity',operator:'in',type:'string',text:'ERROR\nFATAL'}]}])}>{t("添加错误日志","Add error logs")}</Button><Button disabled={disabled} onClick={()=>setRules([...rules,{name:t("普通日志","General logs"),percent:10,conditions:[]}])}>{t("添加全部日志 10%","Add all logs at 10%")}</Button></Space><RuleList value={rules} onChange={setRules} disabled={disabled}/></>},{key:'exclude',label:t(`排除规则 (${exclude.length})`,`Exclusion rules (${exclude.length})`),children:<><p>{t("命中任一排除规则即忽略日志，包括 QA、VIP 和错误日志。可用 attr:user_id 屏蔽指定 UID。","Any matching exclusion rule drops the log, including QA, VIP, and error logs. Use attr:user_id to exclude specific UIDs.")}</p><RuleList value={exclude} onChange={setExclude} disabled={disabled} exclude/></>}]}/></>}
 </Modal>;
}

export function SDKReportingEditor({open,onClose}:{open:boolean;onClose:()=>void}){
 const {t}=useI18n();
const toExclusions=(rules:Rule[]):LogExcludeRule[]=>rules.map(r=>({name:r.name,conditions:toConditions(r.conditions)}));
const text=(e:unknown)=>e instanceof Error?e.message:t("操作失败","Operation failed");
function toConditions(values:Condition[]):LogCondition[]{return values.map(c=>{
 if(!c.field.trim())throw new Error(t("请填写匹配字段","Enter a matching field"));
 if(c.operator==='exists')return {field:c.field.trim(),operator:'exists'};
 const lines=c.text.split('\n').map(v=>v.trim()).filter(Boolean);if(!lines.length)throw new Error(t("请填写匹配值，每行一个","Enter matching values, one per line"));
 const parsed=lines.map(v=>{if(c.type==='boolean'){if(!['true','false'].includes(v))throw new Error(t("布尔值请填写 true 或 false","Enter true or false for boolean values"));return v==='true';}if(c.type==='number'){const n=Number(v);if(!Number.isFinite(n)||Number.isInteger(n)&&!Number.isSafeInteger(n))throw new Error(t("数字必须有限且精确；长 UID 请使用字符串","Numbers must be finite and precise. Use strings for long UIDs"));return n;}return v;});
 return {field:c.field.trim(),operator:'in',values:parsed};
});}

 const {message}=App.useApp(),[rules,setRules]=useState<Rule[]>([]),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!open)return;const abort=new AbortController();setLoading(true);setLoaded(false);setError('');api<{disable_rules:LogExcludeRule[]}>('/settings/sdk-reporting',{signal:abort.signal}).then(p=>{setRules(fromRules(p.disable_rules));setLoaded(true);}).catch(e=>{if(!abort.signal.aborted)setError(text(e));}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[open]);
 return <Modal title={t("SDK 停报规则","SDK reporting suspension rules")} open={open} width={760} style={{top:32}} styles={{body:{maxHeight:'calc(100dvh - 220px)',overflowY:'auto'}}} onCancel={()=>{if(!saving)onClose();}} okText={t("保存并下发","Save and distribute")} cancelText={t("取消","Cancel")} okButtonProps={{disabled:loading||!loaded}} confirmLoading={saving} onOk={async()=>{setSaving(true);setError('');try{const disable_rules=copyExclusions(toExclusions(rules),true);await api('/settings/sdk-reporting',{method:'PUT',body:JSON.stringify({disable_rules})});void message.success(t("SDK 停报规则已保存","SDK reporting suspension rules saved"));onClose();}catch(e){setError(text(e));}finally{setSaving(false);}}} destroyOnHidden>
  <p>{t("命中任一规则后，该 SDK 停止日志、指标、链路和自监控上报，并清空未发送数据；配置更新继续运行，移除规则后自动恢复。","When any rule matches, the SDK stops reporting logs, metrics, traces, and self-monitoring data, and clears unsent data. Configuration updates continue; reporting resumes automatically after the rule is removed.")}</p><p className="lm-log-hint">{t("支持 Go、Node.js、浏览器和 Python SDK。字段可填写 service、instance_id、sdk.language 或 resource:资源属性。同一规则的多个条件必须全部命中。","Supports Go, Node.js, browser, and Python SDKs. Fields include service, instance_id, sdk.language, and resource:resource_attribute. All conditions within a rule must match.")}</p>
  {error&&<Alert type="error" title={error} style={{marginBottom:12}}/>}{loading?<Spin/>:<RuleList value={rules} onChange={setRules} disabled={loading||saving||!loaded} exclude sdk/>}
 </Modal>;
}
