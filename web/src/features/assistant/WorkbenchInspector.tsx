import {useMemo,type ReactElement} from 'react';
import { Alert, Button, Space, Tag } from '../../shared/ui';
import {useI18n} from '../../shared/i18n';
import type {Translator} from '../../shared/i18n';
import type { AssistantContext, AssistantSession, TurnView } from './types';
import type { QueryResponse, TimeRange } from '../../shared/types';
import { AuditOutlined, DatabaseOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { formatElapsed } from './tool-summary';

export type WorkbenchTab='context'|'artifacts'|'activity';
export interface WorkbenchInspectorProps {
  tab:WorkbenchTab;
  onTabChange:(tab:WorkbenchTab)=>void;
  context:AssistantContext;
  session?:AssistantSession;
  categoryLabel:string;
  running:boolean;
  model?:string;
  turns:TurnView[];
  selectedArtifact:string|undefined;
  onSelectArtifact:(id:string|undefined)=>void;
  onOpenDashboard:(draft:import('./types').DashboardDraft,range?:TimeRange)=>void;
  onUseSql:(sql:string)=>void;
  onNavigate:(url:string)=>void;
}

type ArtifactKind='sql'|'dashboard'|'code'|'agent_plan'|'host_check'|'tool';
interface WorkbenchArtifact {
  id:string;kind:ArtifactKind;title:string;status:TurnView['status'];
  turnId:string;toolCallId:string;summary:string;
  sql?:string;result?:QueryResponse;dashboard?:import('./types').DashboardDraft;
  code?:import('./types').CodeTaskResult;reviewUrl?:string;evidence?:unknown;
  input?:unknown;
}

const artifactMeta=(kind:ArtifactKind,t:Translator)=>({
  sql:t('SQL 查询','SQL query'),dashboard:t('大盘草稿','Dashboard draft'),
  code:t('代码任务','Code task'),agent_plan:t('Agent 计划','Agent plan'),
  host_check:t('主机检查','Host check'),tool:t('工具调用','Tool call'),
}[kind]);

const statusMeta=(status:TurnView['status'],t:Translator)=>({
  running:{label:t('运行中','Running'),color:'processing'},
  completed:{label:t('成功','Success'),color:'success'},
  failed:{label:t('失败','Failed'),color:'error'},
  cancelled:{label:t('已取消','Cancelled'),color:'default'},
}[status]);

function frameRows(result?:QueryResponse){return result?.results?.flatMap(item=>item.frames||[]).flatMap(frame=>frame.rows)||[];}
function artifactSummary(tool:import('./types').ToolTrace):string{
  const value=tool.result as Record<string,unknown>|undefined, input=tool.input as Record<string,unknown>|undefined;
  if(value&&typeof value==='object'){
    if(typeof value.summary==='string')return value.summary;
    if(typeof value.description==='string')return value.description;
    if(typeof value.error==='string')return value.error;
  }
  if(input&&typeof input==='object'){
    if(typeof input.sql==='string')return input.sql;
    if(typeof input.task==='string')return input.task;
    if(typeof input.machine_id==='string')return String(input.machine_id);
  }
  return '';
}

function buildArtifacts(turns:TurnView[],t:Translator):WorkbenchArtifact[]{
  const artifacts:WorkbenchArtifact[]=[];
  for(const turn of [...turns].reverse()){
    for(const tool of [...turn.tools].reverse()){
      const id=`${turn.id}:${tool.callId}`;
      const value=tool.result as Record<string,any>|undefined;
      const input=tool.input as Record<string,any>|undefined;
      let kind:ArtifactKind='tool',title=tool.name;
      if(tool.name==='run_query'){kind='sql';title=t('只读查询','Read-only query');}
      else if(tool.name==='draft_dashboard'){kind='dashboard';title=String(value?.draft?.title||input?.title||t('大盘草稿','Dashboard draft'));}
      else if(tool.name==='code_task'){kind='code';title=t('代码任务','Code task');}
      else if(tool.name==='propose_agent_install'||tool.name==='propose_agent_update'){kind='agent_plan';title=t('Agent 计划','Agent plan');}
      else if(tool.name==='check_managed_machine_ssh'||tool.name==='get_managed_machine'){kind='host_check';title=t('主机检查','Host check');}
      const artifact:WorkbenchArtifact={id,kind,title,status:tool.status==='success'?'completed':tool.status==='error'?'failed':tool.status==='cancelled'?'cancelled':'running',
        turnId:turn.id,toolCallId:tool.callId,summary:artifactSummary(tool),input,result:kind==='sql'?value as QueryResponse|undefined:undefined,
        dashboard:kind==='dashboard'?value?.draft as import('./types').DashboardDraft|undefined:undefined,
        code:kind==='code'?value as import('./types').CodeTaskResult|undefined:undefined,
        reviewUrl:typeof value?.review_url==='string'?value.review_url:undefined,evidence:value};
      artifacts.push(artifact);
    }
  }
  return artifacts.slice(0,30);
}

function Chip({label,value}:{label:string;value:string}){return <span className="lm-inspector-chip"><small>{label}</small><strong>{value}</strong></span>;}

export default function WorkbenchInspector({tab,onTabChange,context,session,categoryLabel,running,model,turns,selectedArtifact,onSelectArtifact,onOpenDashboard,onUseSql,onNavigate}:WorkbenchInspectorProps){
 const {t}=useI18n();
 const artifacts=useMemo(()=>buildArtifacts(turns,t),[turns,t]);
 const active=artifacts.find(item=>item.id===selectedArtifact)||artifacts[0];
 const tabs: {key:WorkbenchTab;label:string;icon:ReactElement;count?:number}[]=[
  {key:'context',label:t('上下文','Context'),icon:<DatabaseOutlined/>},
  {key:'artifacts',label:t('产物','Artifacts'),icon:<FileTextOutlined/>,count:artifacts.length},
  {key:'activity',label:t('活动','Activity'),icon:<AuditOutlined/>,count:turns.length},
 ];
 const chips:[
   string,string
 ][]=[
   [t('数据表','Table'),context.table||t('全部','All')],
   [t('服务','Service'),context.service||t('全部','All')],
   [t('代码工作区','Workspace'),context.code_workspace||t('未选择','Not selected')],
   [t('页面来源','Page source'),context.page?(context.dashboard_title||context.page.title):t('助手页','Assistant')],
 ];
 const range=context.range?`${context.range.from} → ${context.range.to}`:`${t('最近','Last')} ${context.query?.lookback_hours??1}h`;
 return <aside className="lm-inspector" aria-label={t('助手工作台检查器','Assistant workbench inspector')}>
  <div className="lm-inspector-head">
    <div><small>{t('当前会话','Current session')}</small><strong>{session?.title||t('新任务','New task')}</strong></div>
    <Tag color={running?'processing':'default'}>{running?t('运行中','Running'):(session?.status==='needs_action'?t('待确认','Needs review'):session?.status==='failed'?t('失败','Failed'):t('空闲','Idle'))}</Tag>
  </div>
  <div className="lm-inspector-meta">
    <Chip label={t('分类','Category')} value={categoryLabel}/>
    <Chip label={t('模型','Model')} value={model||t('未配置','Not configured')}/>
    <Chip label={t('时间范围','Range')} value={range}/>
  </div>
  <nav className="lm-inspector-tabs" aria-label={t('检查器分区','Inspector sections')}>
   {tabs.map(item=><button key={item.key} type="button" className={tab===item.key?'active':''} aria-current={tab===item.key?'page':undefined} onClick={()=>onTabChange(item.key)}>{item.icon}<span>{item.label}</span>{item.count!=null&&<small>{item.count}</small>}</button>)}
  </nav>
  <div className="lm-inspector-body">
   {tab==='context'&&<>
    <div className="lm-inspector-chips">{chips.map(([label,value])=><Chip key={label} label={label} value={value}/>)}</div>
    {context.panels?.length?<div className="lm-inspector-card"><strong>{t('页面面板','Page panels')}</strong><p>{t(`${context.panels.length} 个面板已随上下文传入`,`${context.panels.length} panels included in context`)}</p></div>:null}
    {context.selected_logs?.length?<div className="lm-inspector-card"><strong>{t('已选日志','Selected logs')}</strong><p>{t(`${context.selected_logs.length} 条日志已随上下文传入`,`${context.selected_logs.length} log records included`)}</p></div>:null}
    {context.context_truncated&&<Alert type="warning" showIcon title={t('上下文已精简','Context trimmed')}/>}
    <div className="lm-inspector-note">{t('只读上下文不会自动授权任何写入操作。','Read-only context never grants write access.')}</div>
   </>}
   {tab==='artifacts'&&<div className="lm-inspector-list">
    {!artifacts.length&&<>
     <div className="lm-inspector-empty">
      <strong>{t('还没有工具产物','No tool artifacts yet')}</strong>
      <span>{t('发送一个监控、主机或代码任务后，工具证据会出现在这里。','Send a monitoring, host, or code task and tool evidence will appear here.')}</span>
     </div>
     <div className="lm-inspector-quick">
      <button type="button" onClick={()=>onNavigate('/machines')}><strong>{t('检查主机','Inspect hosts')}</strong><span>{t('SSH 预检、Agent 状态和生命周期','SSH checks, Agent state, lifecycle')}</span></button>
      <button type="button" onClick={()=>onNavigate('/dashboards')}><strong>{t('分析监控','Analyze monitoring')}</strong><span>{t('指标、大盘和异常趋势','Metrics, dashboards, trends')}</span></button>
      <button type="button" onClick={()=>onNavigate('/logs')}><strong>{t('排查日志','Investigate logs')}</strong><span>{t('关键词、SQL 和事件定位','Keywords, SQL, event triage')}</span></button>
     </div>
    </>}
    {artifacts.map(item=>{
     const status=statusMeta(item.status,t);
     return <button key={item.id} type="button" className={`lm-inspector-item ${active?.id===item.id?'active':''}`} onClick={()=>onSelectArtifact(item.id)}>
      <span className={`lm-inspector-item-icon ${item.status}`}><FileTextOutlined/></span>
      <span className="lm-inspector-item-body"><small>{artifactMeta(item.kind,t)}</small><strong>{item.title}</strong><span>{item.summary||status.label}</span></span>
      <Tag color={status.color}>{status.label}</Tag>
     </button>;})}
   </div>}
   {tab==='artifacts'&&active&&<div className="lm-inspector-detail">
    <div className="lm-inspector-detail-head"><strong>{active.title}</strong><Tag color={statusMeta(active.status,t).color}>{statusMeta(active.status,t).label}</Tag></div>
    <p>{active.summary||t('暂无摘要。','No summary.')}</p>
    {active.sql&&<pre>{active.sql}</pre>}
    {active.result&&<div className="lm-inspector-card"><strong>{t('查询结果','Query result')}</strong><p>{t(`${frameRows(active.result).length} 行 · ${active.result.results?.length||0} 个查询`,`${frameRows(active.result).length} rows · ${active.result.results?.length||0} queries`)}</p></div>}
    {active.dashboard&&<div className="lm-inspector-card"><strong>{active.dashboard.title}</strong><p>{t(`${active.dashboard.panels.length} 个面板待审阅`,`${active.dashboard.panels.length} panels await review`)}</p><Button size="small" type="primary" onClick={()=>onOpenDashboard(active.dashboard!)}>{t('审阅大盘草稿','Review dashboard draft')}</Button></div>}
    {active.code&&<div className="lm-inspector-card"><strong>{t('代码任务','Code task')}</strong><p>{active.code.summary}</p><p>{active.code.changed_files.length} {t('个变更文件','changed files')}</p></div>}
    {active.reviewUrl&&<Button size="small" type="primary" onClick={()=>onNavigate(active.reviewUrl!)}>{t('打开原始记录','Open original record')}</Button>}
    {active.evidence!==undefined&&!active.sql&&!active.dashboard&&!active.code&&<details><summary>{t('原始证据','Raw evidence')}</summary><pre>{JSON.stringify(active.evidence,null,2)}</pre></details>}
    {active.sql&&onUseSql&&<Button size="small" onClick={()=>onUseSql(active.sql!)}>{t('使用 SQL','Use SQL')}</Button>}
   </div>}
   {tab==='activity'&&<div className="lm-inspector-list">
    {!turns.length&&<div className="lm-inspector-empty">{t('还没有执行活动。','No activity yet.')}</div>}
    {[...turns].reverse().map(turn=>{
     const status=statusMeta(turn.status,t);
     const elapsed=formatElapsed(turn.startedAt,turn.endedAt,Date.now());
     return <div key={turn.id} className="lm-inspector-card">
      <div className="lm-inspector-detail-head"><strong>{turn.text||t('任务','Task')}</strong><Tag color={status.color}>{status.label}</Tag></div>
      <p>{t(`${turn.tools.length} 次工具调用`,`${turn.tools.length} tool calls`)}{elapsed?` · ${t('已用','elapsed')} ${elapsed}`:''}</p>
      {(turn.usage||turn.compactionUsage)&&<p>{turn.usage?`${t('用量','Usage')} ${turn.usage.total_tokens??'—'}`:''}{turn.compactionUsage?`${turn.usage?' · ':''}${t('整理','Summary')} ${turn.compactionUsage.total_tokens??'—'}`:''}</p>}
      {turn.error&&<Alert type={turn.status==='cancelled'?'info':'error'} title={turn.error} showIcon/>}
     </div>;})}
   </div>}
  </div>
  <div className="lm-inspector-foot"><Space size={4}><ThunderboltOutlined/><span>{t('产物仅来自已授权工具，不新增权限。','Artifacts come from authorized tools only.')}</span></Space></div>
 </aside>;
}
