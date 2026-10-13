import {useEffect,useRef,useState} from 'react';
import {api,post} from '../../shared/api';
import {Alert,Button,Checkbox,Collapse,Input,InputNumber,Select,Space,Spin,Switch,Tag,message} from '../../shared/ui';
import type {CatalogTable,Parameter,QueryResult,TimeRange} from '../../shared/types';
import {newAlertRule,noDataOptions,type AlertGroup,type AlertRule} from '../alerts/types';
import {groupHasNotificationTargets,priorities,priorityColors,priorityNames,rulePriority} from '../alerts/response-model';
import AlertPreviewDialog from '../alerts/AlertPreviewDialog';
import {normalizeAlertPreview,type AlertPreviewData} from '../alerts/alert-preview';
import {bindQueries,rightAxisRefs,type Panel,type Variable,type Values} from './model';
import {unitLabel} from './formatting';
import {alertLines,alertWindowLabel,chartAlertSQL,conditionLabels,lineKey,reducerOptions} from './panel-alerts';

export type PanelAlertDraft={key:string;rule:AlertRule;dirty:boolean};
export default function PanelAlerts({panel,tables,variables,values,choices,range,results,onChange,drafts,setDrafts}:{panel:Panel;tables:CatalogTable[];variables:Variable[];values:Values;choices:Record<string,string[]>;range:TimeRange;results:QueryResult[];onChange:(options:Record<string,unknown>)=>void;drafts:PanelAlertDraft[];setDrafts:(update:PanelAlertDraft[]|((current:PanelAlertDraft[])=>PanelAlertDraft[]))=>void}){
 const [groups,setGroups]=useState<AlertGroup[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[preview,setPreview]=useState<AlertPreviewData>(),[previewOpen,setPreviewOpen]=useState(false),[previewError,setPreviewError]=useState(''),[toast,holder]=message.useMessage();
 const latest=useRef(panel);latest.current=panel;
 const lines=alertLines(panel,results),ids=Array.isArray(panel.options.alert_rule_ids)?panel.options.alert_rule_ids as string[]:[];
 const makePanelAlertDraft=():PanelAlertDraft=>({key:crypto.randomUUID(),dirty:false,rule:{...newAlertRule(),name:`${panel.title} 告警`,for_seconds:0,notify_health:false,panel_condition:{panel_id:panel.id,query_ref:panel.queries.find(query=>query.enabled!==false)?.refId??'',reducer:'last'}}});
 useEffect(()=>{let active=true;void Promise.all([api<AlertRule[]>('/alerts/rules'),api<AlertGroup[]>('/alerts/groups')]).then(([rules,groups])=>{
  if(!active)return;setGroups(groups);const order=(id:string)=>ids.includes(id)?ids.indexOf(id):ids.length;
  const selected=rules.filter(rule=>ids.includes(rule.id)||rule.panel_condition?.panel_id===panel.id).sort((a,b)=>order(a.id)-order(b.id)||(a.panel_condition?.query_ref??'').localeCompare(b.panel_condition?.query_ref??'')||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  setDrafts(current=>current.length?current:selected.length?selected.map(rule=>({key:rule.id,dirty:false,rule:{...rule,group_ids:rule.group_ids?.length?rule.group_ids:[...new Set(tables.filter(table=>rule.source_table_ids.includes(table.id)&&table.alert_group_id).map(table=>table.alert_group_id!))],panel_condition:rule.panel_condition??{panel_id:'',query_ref:panel.queries.find(query=>query.enabled!==false)?.refId??'',reducer:'avg'}}})):[makePanelAlertDraft()]);
  const selectedIDs=selected.map(rule=>rule.id);
  if(ids.some(id=>!selectedIDs.includes(id)))setError('部分告警已删除，可重新配置当前图表的告警条件。');
  if(ids.length!==selectedIDs.length||ids.some(id=>!selectedIDs.includes(id)))onChange({...latest.current.options,alert_rule_ids:selectedIDs});
 }).catch(e=>{if(active)setError((e as Error).message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 function change(key:string,update:Partial<AlertRule>){setDrafts(current=>current.map(draft=>draft.key===key?{...draft,dirty:true,rule:{...draft.rule,...update}}:draft));setError('');}
 async function ruleBody(draft:PanelAlertDraft){
  const rule=draft.rule,query=bindQueries(panel.queries,variables,values,choices).find(query=>query.refId===rule.panel_condition?.query_ref);
  if(!query)throw new Error('请选择当前图表中启用的查询或曲线');
  const source=await post<{sql:string;params?:Record<string,Parameter>;source_table_ids:string[]}>('/dashboards/alert-draft',{query,range});
  const generated=chartAlertSQL(panel,rule,source,results),line=lines.find(line=>line.value===lineKey(rule.panel_condition!));
  // A copied panel gets its own alert; editing it must not change the original panel.
  const owned=rule.id&&rule.panel_condition?.panel_id===panel.id,body={...rule,...generated,id:owned?rule.id:'',revision:owned?rule.revision:0,name:`${panel.title} · ${line?.label??query.refId} · ${conditionLabels[rule.operator]??rule.operator}`,unit:rule.panel_condition?.reducer==='count'?'':String(rightAxisRefs(panel.options).includes(query.refId)?panel.options.right_unit??'':panel.options.unit??''),kind:'sql',source_table_ids:source.source_table_ids,value_field:'value',threshold:rule.operator==='no_data'?'0':rule.threshold,panel_condition:{...rule.panel_condition!,panel_id:panel.id}};
  return {body,owned};
 }
 async function previewRule(draft:PanelAlertDraft){if(busy)return;setBusy('preview:'+draft.key);setError('');setPreview(undefined);setPreviewError('');setPreviewOpen(true);try{
  const {body}=await ruleBody(draft);setPreview(normalizeAlertPreview(await post<AlertPreviewData>('/alerts/preview',body),body));
 }catch(e){setPreviewError((e as Error).message);}finally{setBusy('');}}
 async function save(draft:PanelAlertDraft){if(busy)return;setBusy(draft.key);setError('');try{
  const rule=draft.rule;if(!rule.group_ids?.length)throw new Error('请选择接收通知的告警组');
  const {body,owned}=await ruleBody(draft),checked=normalizeAlertPreview(await post<AlertPreviewData>('/alerts/preview',body),body),failure=checked.states.find(state=>state.health==='error');
  if(failure)throw new Error(failure.error??'告警查询执行失败，请检查当前图表的查询');
  if(rule.enabled&&!checked.routes.length)throw new Error('当前等级没有可用通知目标，请检查组成员、值班和通知接入');
  const saved=await api<AlertRule>('/alerts/rules'+(owned?'/'+rule.id:''),{method:owned?'PUT':'POST',body:JSON.stringify(body)});
  setDrafts(current=>current.map(item=>item.key===draft.key?{...item,rule:saved,dirty:false}:item));
  const options=latest.current.options,currentIDs=Array.isArray(options.alert_rule_ids)?options.alert_rule_ids as string[]:[],nextIDs=[...new Set(currentIDs.includes(rule.id)?currentIDs.map(id=>id===rule.id?saved.id:id):[...currentIDs,saved.id])];
  onChange({...options,alert_rule_ids:nextIDs,show_alert_thresholds:options.show_alert_thresholds??true,alert_revision:Number(options.alert_revision??0)+1});void toast.success('告警已保存并生效');
 }catch(e){setError((e as Error).message);}finally{setBusy('');}}
 async function remove(draft:PanelAlertDraft){setBusy(draft.key);setError('');try{
  if(draft.rule.id&&draft.rule.panel_condition?.panel_id===panel.id)await api('/alerts/rules/'+draft.rule.id,{method:'DELETE'});
  setDrafts(current=>current.filter(item=>item.key!==draft.key));const options=latest.current.options;onChange({...options,alert_rule_ids:ids.filter(id=>id!==draft.rule.id),alert_revision:Number(options.alert_revision??0)+1});
 }catch(e){setError((e as Error).message);}finally{setBusy('');}}
 if(loading)return <Spin size="small"/>;
 return <div className="lm-panel-settings lm-panel-alerts">{holder}<h3>当前图表告警</h3><p>选择图表中的线，设置触发条件和接收通知的告警组。</p>
 {drafts.map((draft,index)=>{const rule=draft.rule,selection=rule.panel_condition!,key=lineKey(selection),options=lines.some(line=>line.value===key)?lines:[...lines,{value:key,label:`查询 ${selection.query_ref} · ${String(selection.series?.value??'所选曲线')}`,...selection}],noData=rule.operator==='no_data';return <section className="lm-panel-alert-rule" key={draft.key} aria-label={`告警条件 ${index+1}`}>
  <header><strong>条件 {index+1}</strong><Tag color={priorityColors[rulePriority(rule.severity)]}>{rulePriority(rule.severity)}</Tag><Tag color={draft.dirty||!rule.id?'default':rule.enabled?'success':'default'}>{draft.dirty||!rule.id?'未保存':rule.enabled?'已启用':'已暂停'}</Tag><Button type="text" size="small" danger disabled={!!busy} onClick={()=>void remove(draft)}>移除</Button></header>
  <label>告警等级<Select aria-label={`图表告警等级 ${index+1}`} value={rulePriority(rule.severity)} disabled={!!busy} options={priorities.map(value=>({value,label:<Tag color={priorityColors[value]}>{value} · {priorityNames[value]}</Tag>}))} onChange={severity=>change(draft.key,{severity})}/></label>
  <label>监控的线<Select aria-label={`告警曲线 ${index+1}`} value={key} showSearch optionFilterProp="label" options={options} disabled={!!busy} onChange={value=>{const line=lines.find(line=>line.value===value)!;change(draft.key,{panel_condition:{...selection,query_ref:line.query_ref,series:line.series}});}}/></label>
  <label>触发条件<Select aria-label={`告警触发条件 ${index+1}`} value={rule.operator} disabled={!!busy} options={Object.entries(conditionLabels).filter(([value])=>['gt','lt','no_data',rule.operator].includes(value)).map(([value,label])=>({value,label}))} onChange={operator=>change(draft.key,{operator})}/></label>
  {!noData&&<label>阈值<Input aria-label={`告警阈值 ${index+1}`} value={rule.threshold} disabled={!!busy} onChange={e=>change(draft.key,{threshold:e.target.value})}/><small>{selection.reducer==='count'?'使用有效点数':'使用查询原始单位'}{selection.reducer!=='count'&&(rightAxisRefs(panel.options).includes(selection.query_ref)?panel.options.right_unit:panel.options.unit)?`（${unitLabel(rightAxisRefs(panel.options).includes(selection.query_ref)?panel.options.right_unit:panel.options.unit)}）`:''}</small></label>}
  <label>{noData?'多久没有打点 / 秒':'回看窗口 / 秒'}<InputNumber aria-label={`告警回看窗口 ${index+1}`} min={1} max={604800} precision={0} value={rule.window_seconds} disabled={!!busy} onChange={value=>change(draft.key,{window_seconds:value??1})}/></label>
  <label>窗口结束延迟 / 秒<InputNumber aria-label={`告警窗口结束延迟 ${index+1}`} min={0} max={604800} precision={0} value={rule.delay_seconds??0} disabled={!!busy} onChange={value=>change(draft.key,{delay_seconds:value??0})}/></label>
  <small aria-label={`告警查询区间 ${index+1}`}>查询区间：{alertWindowLabel(rule.window_seconds,rule.delay_seconds??0)}</small>
  {!noData&&<><label>取值方式<Select aria-label={`告警取值方式 ${index+1}`} value={selection.reducer} disabled={!!busy} options={reducerOptions} onChange={reducer=>change(draft.key,{panel_condition:{...selection,reducer}})}/></label>
  <label>无数据时<Select aria-label={`告警无数据处理 ${index+1}`} value={rule.no_data_policy??'keep_state'} disabled={!!busy} options={noDataOptions} onChange={no_data_policy=>change(draft.key,{no_data_policy,no_data_value:rule.no_data_value??'0'})}/></label>
  {rule.no_data_policy==='value'&&<label>替代值<Input aria-label={`告警无数据替代值 ${index+1}`} value={rule.no_data_value??'0'} disabled={!!busy} onChange={e=>change(draft.key,{no_data_value:e.target.value})}/></label>}
  <small>适用于窗口为空、全 NULL 或曲线消失；查询失败和图表补零单独处理。</small></>}
  <label>告警组<Select aria-label={`图表告警组 ${index+1}`} mode="multiple" maxCount={16} showSearch optionFilterProp="label" placeholder="选择接收通知的告警组" value={rule.group_ids??[]} disabled={!!busy} options={groups.map(group=>({value:group.id,label:group.name+(!group.enabled?'（已禁用）':!groupHasNotificationTargets(group)?'（未配置人员或接入）':''),disabled:!group.enabled||!groupHasNotificationTargets(group)}))} onChange={group_ids=>change(draft.key,{group_ids})}/></label>
  {!groups.length&&<small>还没有告警组，请先在告警与通知中创建。</small>}
  <Collapse size="small" items={[{key:'evaluation',label:'检查与持续时间',children:<><label>检查间隔 / 秒<InputNumber aria-label={`告警检查间隔 ${index+1}`} min={1} max={86400} value={rule.interval_seconds} disabled={!!busy} onChange={value=>change(draft.key,{interval_seconds:value??1})}/></label><label>持续异常 / 秒<InputNumber aria-label={`告警持续异常 ${index+1}`} min={0} value={rule.for_seconds} disabled={!!busy} onChange={value=>change(draft.key,{for_seconds:value??0})}/></label><small>0 表示条件满足后立即告警，恢复正常后自动发送恢复通知。</small></>}]} />
  <footer><Space><Switch aria-label={`启用图表告警 ${index+1}`} size="small" checked={rule.enabled} disabled={!!busy} onChange={enabled=>change(draft.key,{enabled})}/><span>启用</span></Space><Space size={6}><Button size="small" loading={busy==='preview:'+draft.key} disabled={!!busy&&busy!=='preview:'+draft.key} onClick={()=>void previewRule(draft)}>预览告警</Button><Button type="primary" size="small" loading={busy===draft.key} disabled={!!busy&&busy!==draft.key} onClick={()=>void save(draft)}>保存告警</Button></Space></footer>
 </section>;})}
 <Button block disabled={!!busy||drafts.length>=16||!lines.length} onClick={()=>setDrafts(current=>[...current,{...makePanelAlertDraft(),dirty:true}])}>添加告警条件</Button>
 {error&&<Alert type="error" showIcon title={error} style={{marginTop:12}}/>}
 <h3>图表标记</h3><div className="lm-panel-alert-display"><Checkbox checked={panel.options.show_alert_thresholds!==false} onChange={e=>onChange({...panel.options,show_alert_thresholds:e.target.checked})}>显示告警水位线</Checkbox><Checkbox checked={panel.options.show_alert_events!==false} onChange={e=>onChange({...panel.options,show_alert_events:e.target.checked})}>显示触发与恢复标记</Checkbox></div>
 <p>保存告警后立即生效；图表设置随大盘保存。</p><Button href="/alerts" type="link" style={{padding:0}}>管理告警组与通知</Button>
 <AlertPreviewDialog open={previewOpen} loading={busy.startsWith('preview:')} error={previewError} data={preview} groups={groups} onClose={()=>setPreviewOpen(false)}/></div>;
}
