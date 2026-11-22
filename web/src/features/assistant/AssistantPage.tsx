import {useI18n} from '../../shared/i18n';
import type {Translator} from '../../shared/i18n';
import {chinese} from '../alerts/translation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {useNavigate} from 'react-router-dom';
import {MessageScroller} from '@shadcn/react/message-scroller';
import { ArrowUpOutlined, CheckOutlined, CloseOutlined, CodeOutlined, CopyOutlined, DeleteOutlined, FolderOutlined, FilePdfOutlined, HistoryOutlined, LoadingOutlined, MessageOutlined, PaperClipOutlined, PictureOutlined, PlusOutlined, PicRightOutlined, ReloadOutlined, SettingOutlined, SlidersOutlined, ThunderboltOutlined } from '@ant-design/icons';
import XMarkdown, { type ComponentProps } from '@ant-design/x-markdown';
import '@ant-design/x-markdown/themes/light.css';
import '@ant-design/x-markdown/themes/dark.css';
import {useAppearance} from '../../shared/appearance';
import { App, Alert, AutoComplete, Button, Checkbox, Collapse, Drawer, Input, Modal, Popconfirm, Popover, Select, Space, Spin, Table, Tag, Tooltip } from '../../shared/ui';
import { api } from '../../shared/api';
import {boundedMonitoringContext} from '../../shared/assistant-context';
import type { CatalogTable, QueryResponse, TimeRange, User } from '../../shared/types';
import { streamTurn } from './client';
import { readAttachment } from './attachments';
import { assistantTimeline, queryRangeFromTurn } from './timeline';
import SSHCheckSummary,{type SSHCheckResult} from '../../shared/SSHCheckSummary';
import AgentUpdateProgress from './AgentUpdateProgress';
import WorkbenchInspector,{type WorkbenchTab} from './WorkbenchInspector';
import {agentUpdateToolValue} from './agent-update-progress';
import AlertProposalProgress from './AlertProposalProgress';
import type { AssistantConfig, AssistantContext, AssistantEvent, AssistantSession, Attachment, CodeTaskResult, DashboardDraft, DraftPanel, ToolTrace, TurnView } from './types';
import './assistant.css';

export interface AssistantPanelProps {
  compact?: boolean;
  initialContext?: AssistantContext;
  initialPrompt?: string;
  onDashboardDraft?: (draft: DashboardDraft) => Promise<void>;
  onSQL?: (sql: string) => void;
}

interface QueuedTurn { id: string; text: string; attachments: Attachment[]; context: AssistantContext }
function mergeEvents(previous: AssistantEvent[], incoming: AssistantEvent[]): AssistantEvent[] {
  return [...new Map([...previous, ...incoming].map(event => [event.sequence, event])).values()].sort((a,b) => a.sequence - b.sequence);
}




function readable(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }
function formatUsage(usage: NonNullable<TurnView['usage']>,t:Translator=chinese): string {
  const counts: string[] = [];
  if (usage.input_tokens !== undefined) counts.push(t(`输入 ${usage.input_tokens.toLocaleString()}`,`Input ${usage.input_tokens.toLocaleString()}`));
  if (usage.output_tokens !== undefined) counts.push(t(`输出 ${usage.output_tokens.toLocaleString()}`,`Output ${usage.output_tokens.toLocaleString()}`));
  if (usage.total_tokens !== undefined) counts.push(t(`合计 ${usage.total_tokens.toLocaleString()}`,`Total ${usage.total_tokens.toLocaleString()}`));
  return counts.length ? counts.join(' · ') + ' tokens' : t("未报告 Token 数量","Token usage not reported");
}
function rangeFor(hours: number): TimeRange { const to = new Date(); return { from: new Date(to.getTime() - hours * 3_600_000).toISOString(), to: to.toISOString() }; }
function errorText(error: unknown,t:Translator=chinese): string { return error instanceof Error ? error.message : t("操作失败，请重试","Operation failed. Please retry."); }

// Adapted from Doca ai-markdown.tsx (MIT; see NOTICE.md). Raw HTML and
// auto-loading external media remain disabled when rendering telemetry text.
function Answer({ text, streaming, onSQL }: { text: string; streaming?: boolean; onSQL?: (sql: string) => void }) {
 const {language,t}=useI18n();

  const {dark}=useAppearance();
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const components = {
    code: ({ children, className, lang, block }: ComponentProps) => {
      if (!block) return <code>{children}</code>;
      const code = String(children ?? ''), language = String(lang || className?.replace(/^language-/, '') || 'text').split(/\s/)[0];
      return <div className="lm-assistant-code"><div className="lm-assistant-code-bar"><span>{language}</span><Space size={4}>{onSQL && /sql/i.test(language) && <Button size="small" onClick={() => onSQL(code)}>{t("使用 SQL","Use SQL")}</Button>}<Button size="small" type="text" icon={copied === code ? <CheckOutlined /> : <CopyOutlined />} onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(code); setCopyError(''); } catch { setCopyError(t("无法写入剪贴板，请手动复制代码","Could not access the clipboard. Copy the code manually.")); } }}>{copied === code ? t("已复制","Copied") : t("复制","Copy")}</Button></Space></div><pre>{code}</pre></div>;
    },
    pre: ({ children }: ComponentProps) => <div>{children}</div>,
    img: ({ alt }: ComponentProps) => <span>[{String(alt || t("图片","Image"))}]</span>,
    input: ({ checked, type }: ComponentProps) => type === 'checkbox' ? <Checkbox checked={!!checked} disabled /> : null,
  };
  return <div className="lm-assistant-answer"><XMarkdown content={text} className={dark?'x-markdown-dark':'x-markdown-light'} config={{ gfm: true }} escapeRawHtml openLinksInNewTab streaming={{ hasNextChunk: !!streaming, enableAnimation: !!streaming && !window.matchMedia('(prefers-reduced-motion: reduce)').matches }} dompurifyConfig={{ USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'video', 'audio', 'source', 'object', 'embed', 'form', 'button', 'link', 'meta'] }} components={components} />{copyError && <small>{copyError}</small>}</div>;
}

const codeTaskStatuses=(t:Translator=chinese): Record<CodeTaskResult['status'], { label: string; color: string }>=>({
  running: { label: t("执行中","Running"), color: 'processing' },
  awaiting_approval: { label: t("待审批","Awaiting approval"), color: 'warning' },
  completed: { label: t("已完成","Completed"), color: 'success' },
  failed: { label: t("执行失败","Execution failed"), color: 'error' },
  cancelled: { label: t("已取消","Cancelled"), color: 'default' },
});
const checkStatuses=(t:Translator=chinese)=>({ passed: t("通过","Passed"), failed: t("失败","Failed"), skipped: t("未执行","Not run") });
const stepStatuses=(t:Translator=chinese)=>({ started: t("执行中","Running"), completed: t("完成","Completed"), failed: t("失败","Failed"), cancelled: t("已取消","Cancelled") });
function codeResult(value: unknown): CodeTaskResult | undefined {
  if (!value || typeof value !== 'object') return;
  const result = value as CodeTaskResult;
  if (typeof result.id === 'string' && typeof result.status === 'string' && Object.hasOwn(codeTaskStatuses(), result.status) && Array.isArray(result.changed_files) && Array.isArray(result.checks) && Array.isArray(result.steps)) return result;
}
function codeStepLabel(action: string,t:Translator=chinese): string {
  if (action === 'model turn') return t("模型分析","Model analysis");
  return ({ 'tool:read': t("读取文件","Read file"), 'tool:edit': t("修改文件","Edit file"), 'tool:write': t("写入文件","Write file"), 'tool:bash': t("运行检查","Run check"), 'tool:grep': t("搜索内容","Search content"), 'tool:find': t("查找文件","Find files"), 'tool:ls': t("查看目录","List directory") } as Record<string, string>)[action] ?? action;
}

function CodeTaskProgress({ tool }: { tool: ToolTrace }) {
 const {language,t}=useI18n();

 const statuses=codeTaskStatuses(t),stepLabels=stepStatuses(t),checkLabels=checkStatuses(t);
  const initial = codeResult(tool.result);
  const [result, setResult] = useState(initial);
  const [verified, setVerified] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [approval, setApproval] = useState<CodeTaskResult>();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const request = useRef<AbortController | null>(null);
  const { message } = App.useApp();
  const taskId = initial?.id;

  async function refreshTask(): Promise<CodeTaskResult | undefined> {
    if (!taskId) return;
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    setRefreshing(true); setRefreshError(''); setVerified(false);
    try {
      const current = await api<CodeTaskResult>(`/assistant/code-tasks/${encodeURIComponent(taskId)}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!codeResult(current)) throw new Error(t("任务状态读取失败，请刷新重试","Could not load task status. Refresh and retry."));
      setResult(current); setVerified(true);
      if (current.status !== 'awaiting_approval') setApproval(undefined);
      return current;
    } catch (problem) {
      if (!abort.signal.aborted) { setRefreshError(errorText(problem,t)); setApproval(undefined); }
    } finally { if (!abort.signal.aborted) setRefreshing(false); }
  }
  useEffect(() => {
    setResult(initial); setApproval(undefined); setVerified(false);
    void refreshTask();
    return () => { request.current?.abort(); };
  }, [taskId]);
  useEffect(() => {
    function onFocus() { if (!applying) void refreshTask(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [taskId, applying]);

  async function reviewApply() {
    const current = await refreshTask();
    if (current?.status === 'awaiting_approval' && current.changed_files?.length && current.diff) { setApplyError(''); setApproval(current); }
  }
  async function confirmApply() {
    if (!approval || applying || !verified || refreshing || result?.status !== 'awaiting_approval') return;
    request.current?.abort();
    setApplying(true); setApplyError('');
    try {
      const current = await api<CodeTaskResult>(`/assistant/code-tasks/${encodeURIComponent(approval.id)}/apply`, { method: 'POST', body: '{}' });
      setResult(current); setVerified(true); setApproval(undefined);
      void message.success(t("代码修改已应用到工作区","Code changes applied to the workspace"));
    } catch (problem) { setApplyError(errorText(problem,t)); void refreshTask(); }
    finally { setApplying(false); }
  }

  const status = result ? statuses[result.status] : tool.status === 'running' ? statuses.running : statuses.failed;
  const files = result?.changed_files ?? [], checks = result?.checks ?? [], steps = result?.steps ?? [];
  const failedChecks = checks.filter(check => check.status === 'failed').length;
  const input = tool.input as { task?: string; workspace?: string } | undefined;
  const failure = !result && tool.status === 'error' ? (tool.result as { error?: string } | undefined)?.error : undefined;
  return <div className="lm-assistant-code-task">
    <div className="lm-assistant-code-task-header"><Space wrap><CodeOutlined /><strong>{t("代码任务","Code task")}</strong><Tag color={refreshError ? 'warning' : status.color}>{refreshError ? t("状态未确认","Status unverified") : status.label}</Tag></Space>{taskId && <Button size="small" type="text" icon={<ReloadOutlined />} loading={refreshing} disabled={applying} onClick={() => void refreshTask()}>{t("刷新状态","Refresh status")}</Button>}</div>
    <p className="lm-assistant-code-task-summary">{result?.summary || failure || input?.task || t("正在隔离副本中读取、修改和检查代码…","Reading, editing and checking code in an isolated copy…")}</p>
    {(result?.workspace || input?.workspace) && <div className="lm-assistant-code-task-meta">{t("工作区：","Workspace: ")}<code>{result?.workspace || input?.workspace}</code></div>}
    {refreshError && <Alert type="warning" showIcon title={t("未能确认任务当前状态","Could not verify current task status")} description={refreshError} />}
    {result && <>
      <div className="lm-assistant-code-task-meta"><span>{files.length} {t("个变更文件"," changed files")}</span><span>{steps.length} {t("个步骤"," steps")}</span><span>{checks.length ? t(`${checks.filter(check => check.status === 'passed').length}/${checks.length} 项检查通过`,`${checks.filter(check => check.status === 'passed').length}/${checks.length} checks passed`) : t("未运行检查","No checks run")}</span>{failedChecks > 0 && <Tag color="error">{failedChecks} {t("项检查失败"," checks failed")}</Tag>}</div>
      {files.length > 0 && <ul className="lm-assistant-code-files" aria-label={t("变更文件","Changed files")}>{files.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
      <Collapse size="small" ghost className="lm-assistant-code-details" items={[
        { key: 'steps', label: t(`执行步骤 · ${steps.length}`,`Steps · ${steps.length}`), children: steps.length ? <ol className="lm-assistant-code-steps">{steps.map((step, index) => <li key={`${step.index}-${index}`}><span>{codeStepLabel(step.action,t)}</span><Tag color={step.status === 'failed' ? 'error' : step.status === 'completed' ? 'success' : step.status === 'started' ? 'processing' : 'default'}>{stepLabels[step.status]}</Tag></li>)}</ol> : <span className="lm-assistant-code-task-meta">{t("暂无步骤记录","No steps recorded")}</span> },
        { key: 'checks', label: t(`检查结果 · ${checks.length}`,`Checks · ${checks.length}`), children: checks.length ? checks.map((check, index) => <div className="lm-assistant-code-check" key={index}><Space wrap><code>{check.command}</code><Tag color={check.status === 'passed' ? 'success' : check.status === 'failed' ? 'error' : 'default'}>{checkLabels[check.status]}</Tag></Space>{check.output && <pre className="lm-assistant-tool-json">{check.output}</pre>}</div>) : <span className="lm-assistant-code-task-meta">{t("未运行检查","No checks run")}</span> },
        { key: 'diff', label: t(`代码 Diff · ${files.length} 个文件`,`Code diff · ${files.length} files`), children: result.diff ? <pre className="lm-assistant-code-diff">{result.diff}</pre> : <span className="lm-assistant-code-task-meta">{t("没有代码变更","No code changes")}</span> },
      ]} />
      {verified && !refreshError && result.status === 'awaiting_approval' && files.length > 0 && <div className="lm-assistant-code-approval"><small>{t("修改保存在隔离副本中，审批后写入工作区。","Changes remain in the isolated copy and are applied to the workspace after approval.")}</small><Button type="primary" disabled={!result.diff} loading={refreshing} onClick={() => void reviewApply()}>{t("审阅并批准应用","Review and approve changes")}</Button></div>}
    </>}
    <Modal open={!!approval} title={t("批准应用代码修改","Approve code changes")} width={820} okText={approval ? t(`确认应用 ${approval.changed_files.length} 个文件`,`Apply ${approval.changed_files.length} files`) : t("确认应用","Apply changes")} cancelText={t("取消","Cancel")} confirmLoading={applying} okButtonProps={{ disabled: !verified || refreshing || !!refreshError }} mask={{ closable: !applying }} closable={!applying} cancelButtonProps={{ disabled: applying }} onCancel={() => { if (!applying) setApproval(undefined); }} onOk={() => void confirmApply()} destroyOnHidden>
      {approval && <div className="lm-assistant-code-confirm"><p>{t("将隔离副本中的修改应用到工作区，共","Apply changes from the isolated copy to the workspace: ")}<strong>{approval.changed_files.length} {t("个文件"," files")}</strong>{t("。",".")}</p><p>{approval.summary}</p><ul className="lm-assistant-code-files">{approval.changed_files.map(file => <li key={file}><code>{file}</code></li>)}</ul>{approval.checks.some(check => check.status === 'failed') && <Alert type="warning" showIcon title={t("此任务有检查未通过，请检查结果后决定是否应用","Some checks failed. Review the results before applying changes.")} />}<pre className="lm-assistant-code-diff">{approval.diff}</pre>{approval.expires_at && <p className="lm-assistant-code-task-meta">{t("审批有效期至：","Approval expires at: ")}{new Date(approval.expires_at).toLocaleString()}</p>}{applyError && <Alert type="error" showIcon title={applyError} />}</div>}
    </Modal>
  </div>;
}

function ToolProgress({ turn, onDraft, canUseCodeTasks, canApproveAgentUpdate }: { turn: TurnView; onDraft: (draft: DashboardDraft, range?: TimeRange) => void; canUseCodeTasks: boolean; canApproveAgentUpdate: boolean }) {
 const {language,t}=useI18n();
 const navigate=useNavigate();
  const toolLabels: Record<string, string> = { list_managed_machines:t("查询主机","Find managed hosts"),get_managed_machine:t("读取主机信息","Read managed host"),check_managed_machine_ssh:t("SSH 安装检查","SSH installation preflight"),propose_agent_install:t("准备 Agent 部署计划","Prepare Agent deployment plan"),get_agent_installation:t("核验 Agent 部署","Verify Agent deployment"),propose_agent_update:t("准备 Agent 更新计划","Prepare Agent update plan"), list_tables: t("读取数据表目录","Read table catalog"), describe_table: t("检查表结构","Inspect table schema"), run_query: t("执行 SQL 查询","Run SQL query"), draft_dashboard: t("生成大盘草稿","Generate dashboard draft"), code_task: t("执行代码任务","Run code task"), list_alert_rules: t("查询告警规则","Find alert rules"), get_alert_rule: t("读取告警规则","Read alert rule"), list_alert_silences: t("查询静默窗口","Find silence windows"), get_alert_silence: t("读取静默窗口","Read silence window"), list_alert_groups: t("查询告警组","Find alert groups"), get_alert_proposal: t("核验告警提案","Verify alert proposal"), propose_alert_change: t("准备告警变更","Prepare alert change") };
  Object.assign(toolLabels,{
    list_services:t('查询服务目录','Find services'),get_service_deployment:t('读取服务部署','Read service deployment'),get_service_deployment_events:t('读取部署事件','Read deployment events'),propose_service_deployment:t('准备服务部署计划','Prepare service deployment plan'),
    list_agent_releases:t('查询 Agent 版本','Find Agent releases'),get_agent_update:t('读取 Agent 更新','Read Agent update'),scan_sdk_instrumentation:t('扫描 SDK 插桩','Scan SDK instrumentation'),propose_sdk_instrumentation:t('准备 SDK 插桩方案','Prepare SDK instrumentation plan'),
    list_operations_resources:t('查询运维资源','Find operations resources'),get_operations_run:t('读取运维执行','Read operations run'),propose_operations_action:t('准备运维操作','Prepare operations action'),
    list_tasks:t('查询任务','Find tasks'),get_task:t('读取任务','Read task'),list_task_runs:t('查询任务执行','Find task runs'),get_task_run:t('读取任务执行','Read task run'),get_task_proposal:t('读取任务提案','Read task proposal'),propose_task_action:t('准备任务操作','Prepare task action'),
  });

  const tools = turn.tools.filter(tool => tool.name !== 'code_task' || canUseCodeTasks);
  if (!tools.length) return null;
  return <div className="lm-assistant-tools">{tools.map(tool => {
    if (tool.name === 'code_task') return <CodeTaskProgress key={tool.callId} tool={tool} />;
    if (tool.name === 'propose_alert_change') return <AlertProposalProgress key={tool.callId} tool={tool} />;
    const agentUpdate = agentUpdateToolValue(tool.name, tool.result);
    if (agentUpdate) return <AgentUpdateProgress key={tool.callId} value={agentUpdate} canApprove={canApproveAgentUpdate} />;
    const result = tool.result as { draft?: DashboardDraft; error?: string;id?:string;machine_id?:string;status?:string;review_url?:string } | undefined;
    const input=tool.input as {machine_id?:string;sql?:string} | undefined;
    return <Collapse key={tool.callId} size="small" ghost items={[{ key: tool.callId, label: <Space><span className={`lm-assistant-tool-dot ${tool.status}`} /><span>{toolLabels[tool.name] ?? tool.name.replaceAll('_',' ')}</span><Tag bordered={false} color={tool.status === 'error' ? 'error' : tool.status === 'success' ? 'success' : tool.status === 'cancelled' ? 'default' : 'processing'}>{tool.status === 'running' ? t("执行中","Running") : tool.status === 'error' ? t("失败","Failed") : tool.status === 'cancelled' ? t("已取消","Cancelled") : t("完成","Completed")}</Tag></Space>, children: <div>{tool.name==='check_managed_machine_ssh'&&<div className="lm-assistant-terminal"><div className="lm-assistant-terminal-label">SSH · {t('固定只读安装检查','Fixed read-only installation check')}</div><pre><span>$</span> ssh {input?.machine_id??t('已登记主机','registered host')} <em>{t('由中心执行受限预检','restricted preflight via center')}</em></pre></div>}{tool.name==='run_query'&&input?.sql&&<div className="lm-assistant-terminal"><div className="lm-assistant-terminal-label">SQL</div><pre>{input.sql}</pre></div>}<div className="lm-assistant-tool-heading">{t("调用参数","Call arguments")}</div><pre className="lm-assistant-tool-json">{readable(tool.input)}</pre>{tool.result !== undefined && <><div className="lm-assistant-tool-heading">{t("执行结果","Execution result")}</div><pre className="lm-assistant-tool-json">{readable(tool.result)}</pre></>}{tool.status==='success'&&tool.name==='check_managed_machine_ssh'&&result?.id&&<SSHCheckSummary result={tool.result as SSHCheckResult}/>} {tool.status==='success'&&tool.name==='propose_agent_install'&&result?.id&&result.machine_id&&<Button type="primary" onClick={()=>navigate(`/machines?machine=${encodeURIComponent(result.machine_id!)}&deployment=${encodeURIComponent(result.id!)}`)}>{t('审阅部署计划','Review deployment plan')}</Button>}{tool.status==='success'&&tool.name!=='propose_agent_install'&&typeof result?.review_url==='string'&&/^\/(?!\/)/.test(result.review_url)&&<Button type="primary" onClick={()=>navigate(result.review_url!)}>{t('审阅此计划','Review this plan')}</Button>}{tool.status === 'success' && result?.draft && <Button type="primary" onClick={() => onDraft(result.draft!, queryRangeFromTurn(turn, tool.callId))}>{t("审阅大盘草稿","Review dashboard draft")}</Button>}</div> }]} />;
  })}</div>;
}

function reviewRequired(value:unknown,depth=0):boolean{
  if(!value||typeof value!=='object'||depth>3)return false;
  if(Array.isArray(value))return value.some(item=>reviewRequired(item,depth+1));
  const record=value as Record<string,unknown>;
  return record.status==='awaiting_approval'||record.state==='awaiting_approval'||['proposal','plan','result'].some(key=>reviewRequired(record[key],depth+1));
}

function ToolActivity({turn,onDraft,canUseCodeTasks,canApproveAgentUpdate}:{turn:TurnView;onDraft:(draft:DashboardDraft,range?:TimeRange)=>void;canUseCodeTasks:boolean;canApproveAgentUpdate:boolean}){
  const {t}=useI18n();
  const [manual,setManual]=useState<boolean>();
  if(!turn.tools.length)return null;
  const attention=turn.tools.some(tool=>(tool.name==='draft_dashboard'&&!!(tool.result as {draft?:unknown}|undefined)?.draft)||reviewRequired(tool.result));
  const failedStep=turn.tools.some(tool=>tool.status==='error');
  const open=manual??(turn.status==='running'||turn.status==='failed'||attention);
  const label=turn.status==='running'?t(`正在执行 ${turn.tools.length} 项操作`,`Working on ${turn.tools.length} steps`):attention?t(`${turn.tools.length} 项操作需要查看`,`${turn.tools.length} steps need review`):failedStep||turn.status==='failed'?t(`${turn.tools.length} 项操作 · 含失败`,`${turn.tools.length} steps · includes a failure`):t(`已完成 ${turn.tools.length} 项操作`,`Completed ${turn.tools.length} steps`);
  return <div className="lm-assistant-activity"><button type="button" className="lm-assistant-activity-trigger" aria-expanded={open} onClick={()=>setManual(!open)}><span className={`lm-assistant-activity-indicator ${failedStep?'failed':turn.status}`} aria-hidden="true"/><span>{label}</span><span className="lm-assistant-activity-chevron" aria-hidden="true">⌄</span></button>{open&&<div className="lm-assistant-activity-content"><ToolProgress turn={turn} onDraft={onDraft} canUseCodeTasks={canUseCodeTasks} canApproveAgentUpdate={canApproveAgentUpdate}/></div>}</div>;
}

function CategoryField({value,options,className,onCommit,ariaLabel,placeholder,disabled}:{value:string;options:{value:string;label:string}[];className?:string;onCommit:(value:string)=>void;ariaLabel:string;placeholder:string;disabled?:boolean}) {
  const {t}=useI18n(),[draft,setDraft]=useState(value.trim()),committed=useRef(value.trim());
  useEffect(()=>{committed.current=value.trim();setDraft(value.trim())},[value]);
  const commit=(next:string)=>{const normalized=next.trim();if(normalized===committed.current)return;committed.current=normalized;onCommit(normalized);};
  return <AutoComplete
    className={className}
    value={draft}
    options={options}
    disabled={disabled}
    onChange={next=>setDraft(String(next))}
    onSelect={next=>{const text=String(next);setDraft(text);commit(text)}}
    onBlur={()=>commit(draft)}
    onKeyDown={event=>{if(event.key==='Enter')commit(draft)}}
    filterOption={(input,option)=>String(option?.value||'').toLowerCase().includes(input.toLowerCase())}
    placeholder={placeholder}
    aria-label={ariaLabel}
  />;
}

export function AssistantPanel({ compact = false, initialContext, initialPrompt, onDashboardDraft, onSQL }: AssistantPanelProps) {
 const {language,t}=useI18n();
 const pageTitles:Record<string,string>={
  '概览':t('概览','Overview'),'监控大盘':t('监控大盘','Dashboards'),'日志探索':t('日志探索','Log explorer'),
  '告警中心':t('告警中心','Alerts'),'节点助手':t('节点助手','Node assistants'),'主机管理':t('主机管理','Machines'),
  '数据接入':t('数据接入','Data ingestion'),'数据管理':t('数据管理','Data management'),'AI 助手':t('AI 助手','AI assistant'),
  '个人设置':t('个人设置','Personal settings'),'管理后台':t('管理后台','Administration'),'监控工作台':t('监控工作台','Monitoring workspace'),
 };

  const ideas = [
  { title: t("创建服务大盘","Create service dashboard"), text: t("根据现有数据创建服务监控大盘，包含请求量、错误率和延迟。先检查可用数据表，并生成可审阅的大盘草稿。","Create a service monitoring dashboard from available data, covering request volume, error rate and latency. Inspect available tables first and generate a dashboard draft for review."), detail: t("请求量、错误率和延迟","Request volume, error rate and latency") },
  { title: t("分析异常日志","Analyze error logs"), text: t("分析当前时间范围的日志，找出主要错误、发生趋势和可能的原因。区分数据事实与推测，并给出后续排查 SQL。","Analyze logs in the current time range for key errors, trends and possible causes. Distinguish facts from hypotheses and provide SQL for further investigation."), detail: t("定位问题与下一步排查","Find issues and next investigation steps") },
  { title: t("帮我写 SQL","Help me write SQL"), text: t("检查现有数据表与字段，生成按服务统计请求量、错误率和延迟的 ClickHouse SQL。说明时间过滤和聚合方式。","Inspect available tables and fields, then generate ClickHouse SQL for request volume, error rate and latency by service. Explain time filters and aggregation."), detail: t("根据真实字段生成查询","Generate queries from actual fields") },
  { title: t("调整告警规则","Adjust alert rules"), text: t("查看当前页面相关的告警规则和静默窗口，说明当前配置。根据我的要求准备变更提案，展示前后差异与影响，等我确认后再应用。","Review alert rules and silence windows relevant to this page. Explain the current configuration, then prepare a change proposal showing differences and impact. Wait for my confirmation before applying it."), detail: t("查看规则、调整阈值与静默","Review rules, adjust thresholds and silences") },
];

  const navigate=useNavigate();
  const [config, setConfig] = useState<AssistantConfig>();
  const [user, setUser] = useState<User>();
  const [tables, setTables] = useState<CatalogTable[]>([]);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [text, setText] = useState(initialPrompt ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingAttachment, setReadingAttachment] = useState(false);
  const [context, setContext] = useState<AssistantContext>(initialContext ?? {});
  const [lookback, setLookback] = useState(1);
  const [creating, setCreating] = useState(false);
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [inspectorTab,setInspectorTab]=useState<WorkbenchTab>('context');
  const [selectedArtifact,setSelectedArtifact]=useState<string>();
  const [inspectorOpen,setInspectorOpen]=useState(!compact);
  const [narrow,setNarrow]=useState(false);
  const [draft, setDraft] = useState<DashboardDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  const [codeWorkspace, setCodeWorkspace] = useState(initialContext?.code_workspace ?? '.');
  const {message}=App.useApp();
  const [preview, setPreview] = useState<Record<number, QueryResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const activeTurns = useRef(new Map<string,AbortController>());
  const creatingRef = useRef(false);
  const selectionVersion = useRef(0);
  const selectedSession = useRef<string | null>(null);
  const eventCache = useRef(new Map<string,AssistantEvent[]>());
  const queuedTurns = useRef(new Map<string,QueuedTurn[]>());
  const drafts = useRef(new Map<string,{text:string;attachments:Attachment[]}>());
  const fileInput = useRef<HTMLInputElement>(null);
  const previewController = useRef<AbortController | null>(null);
  const timeline = useMemo(() => assistantTimeline(events,language), [events,language]);
  const turns = useMemo(() => timeline, [timeline]);
  const table = tables.find(item => item.name === context.table);
  const busy = creating || (!!sessionId && (activeTurns.current.has(sessionId) || runningIds.includes(sessionId)));
  const queue = sessionId ? queuedTurns.current.get(sessionId) ?? [] : [];
  void queueVersion;

  async function refreshSessions() { const data = await api<{ items: AssistantSession[] }>('/assistant/sessions'); setSessions(data.items); setRunningIds(previous => { const ids = data.items.filter(item => item.status === 'running').map(item => item.id); return previous.length === ids.length && ids.every(id => previous.includes(id)) ? previous : ids; }); return data; }
  useEffect(() => {
    let alive = true;
    Promise.all([api<AssistantConfig>('/assistant/config'), api<{ items: AssistantSession[] }>('/assistant/sessions'), api<User>('/auth/me'), api<CatalogTable[]>('/catalog/tables')]).then(async ([model, history, actor, catalog]) => {
      if (!alive) return;
      setConfig(model); setSessions(history.items); setUser(actor); setTables(Array.isArray(catalog) ? catalog : []); setCodeWorkspace(initialContext?.code_workspace ?? model.code_workspace ?? '.');
      setRunningIds(previous => { const ids = history.items.filter(item => item.status === 'running').map(item => item.id); return previous.length === ids.length && ids.every(id => previous.includes(id)) ? previous : ids; });
    }).catch(problem => { if (alive) setError(errorText(problem,t)); }).finally(() => { if (alive) setLoading(false); });
    const timer = window.setInterval(() => {
      if (!alive) return;
      void refreshSessions().catch(() => {});
    }, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  useEffect(()=>{
    const query=window.matchMedia('(max-width: 1080px)');
    setNarrow(query.matches);
    if(query.matches)setInspectorOpen(false);
    const changed=(event:MediaQueryListEvent)=>{setNarrow(event.matches);if(event.matches)setInspectorOpen(false);};
    query.addEventListener('change',changed);
    return()=>query.removeEventListener('change',changed);
  },[]);
  useEffect(()=>{if(error)void message.error(error);},[error,message]);
  useEffect(() => { if (initialPrompt !== undefined) setText(initialPrompt); }, [initialPrompt]);
  useEffect(() => { if (initialContext) { setContext(initialContext); if (initialContext.code_workspace !== undefined) setCodeWorkspace(initialContext.code_workspace); } }, [initialContext]);

  async function loadSession(id: string) {
    const version=++selectionVersion.current;
    drafts.current.set(selectedSession.current ?? 'new', {text,attachments});
    setError(''); setLoading(true);
    try { const session = await api<AssistantSession>(`/assistant/sessions/${encodeURIComponent(id)}`); if(version!==selectionVersion.current)return; selectedSession.current=id; setSessionId(id); const merged=mergeEvents(session.events ?? [],eventCache.current.get(id)??[]); eventCache.current.set(id,merged); setEvents(merged); const draft=drafts.current.get(id); setText(draft?.text??'');setAttachments(draft?.attachments??[]);setHistoryOpen(false); }
    catch (problem) { if(version===selectionVersion.current)setError(errorText(problem,t)); } finally { if(version===selectionVersion.current)setLoading(false); }
  }

  function updateQueue(id:string, items:QueuedTurn[]) { queuedTurns.current.set(id,items); setQueueVersion(value=>value+1); }
  function takeNext(id:string) { const items=queuedTurns.current.get(id)??[]; const [next,...remaining]=items; if(next)updateQueue(id,remaining); return next; }
  async function runTurn(id:string, item:QueuedTurn) {
    if (activeTurns.current.has(id)) return;
    const abort = new AbortController(); activeTurns.current.set(id,abort); setRunningIds(previous=>[...new Set([...previous,id])]);
    let accepted=false, settled=false;
    try {
      await streamTurn(id,item.text,item.context,event=>{
        if(event.type==='user.message')accepted=true;
        const merged=mergeEvents(eventCache.current.get(id)??[],[event]); eventCache.current.set(id,merged);
        if(selectedSession.current===id)setEvents(merged);
      },abort.signal,language,item.attachments);
      settled=true;
    } catch (problem) {
      if (!abort.signal.aborted) setError(errorText(problem,t));
      if (!accepted && !abort.signal.aborted) updateQueue(id,[item,...(queuedTurns.current.get(id)??[])]);
    } finally {
      try { const session = await api<AssistantSession>(`/assistant/sessions/${encodeURIComponent(id)}`); const merged=mergeEvents(session.events??[],eventCache.current.get(id)??[]); eventCache.current.set(id,merged); if(selectedSession.current===id)setEvents(merged); } catch { /* Keep received progress. */ }
      void refreshSessions().catch(problem => setError(errorText(problem,t)));
      const next=settled?takeNext(id):undefined;
      activeTurns.current.delete(id);
      if(next)void runTurn(id,next);
      else setRunningIds(previous=>previous.filter(value=>value!==id));
    }
  }

  async function send(value = text) {
    const prompt=value.trim()||(attachments.length?t('请分析这些附件','Analyze these attachments'):'');
    if (!prompt || !config?.enabled || readingAttachment || creatingRef.current) return;
    const frozenContext = boundedMonitoringContext({ ...context, range: context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) });
    delete frozenContext.code_workspace;
    if (user?.role === 'admin' && config.code_tasks_enabled) frozenContext.code_workspace = codeWorkspace.trim() || '.';
    const item:QueuedTurn={id:crypto.randomUUID(),text:prompt,attachments:[...attachments],context:frozenContext};
    let id=sessionId;
    if(!id){
      creatingRef.current=true;
      ++selectionVersion.current;
      setCreating(true);
      try { const session=await api<AssistantSession>('/assistant/sessions',{method:'POST',body:JSON.stringify({title:item.text.slice(0,60),category:newCategory})}); id=session.id; selectedSession.current=id;setSessionId(id);setSessions(previous=>[session,...previous]);setEvents([]);eventCache.current.set(id,[]); }
      catch(problem){setError(errorText(problem,t));return;}
      finally{creatingRef.current=false;setCreating(false);}
    }
    setText('');setAttachments([]);setAttachmentError('');drafts.current.set(id,{text:'',attachments:[]});setError('');
    if(activeTurns.current.has(id)){updateQueue(id,[...(queuedTurns.current.get(id)??[]),item]);return;}
    void runTurn(id,item);
  }

  async function cancel(id=sessionId):Promise<boolean> {
    if (!id) return false;
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }); return true; }
    catch (problem) { setError(errorText(problem,t)); return false; }
  }

  async function prioritize(itemId:string){
    if(!sessionId)return;
    const items=queuedTurns.current.get(sessionId)??[],index=items.findIndex(item=>item.id===itemId);
    if(index<0)return;
    updateQueue(sessionId,[items[index],...items.filter(item=>item.id!==itemId)]);
    if(activeTurns.current.has(sessionId))await cancel(sessionId);
    else {const next=takeNext(sessionId);if(next)void runTurn(sessionId,next);}
  }
  function removeQueued(itemId:string){if(sessionId)updateQueue(sessionId,(queuedTurns.current.get(sessionId)??[]).filter(item=>item.id!==itemId));}
  async function addFiles(files:FileList | null){
    if(!files?.length)return;
    const version=selectionVersion.current;
    setReadingAttachment(true);setAttachmentError('');
    try { const added:Attachment[]=[];for(const file of Array.from(files)){if(attachments.length+added.length>=4)throw Error(t('最多添加 4 个附件','Add up to 4 attachments'));added.push(await readAttachment(file));}if([...attachments,...added].reduce((total,item)=>total+(item.kind==='image'?(item.data?.length??0)*.75:0),0)>(1<<20))throw Error(t('图片总大小不能超过 1 MiB','Images cannot exceed 1 MiB in total'));if(version===selectionVersion.current)setAttachments(previous=>[...previous,...added]); }
    catch(problem){if(version===selectionVersion.current)setAttachmentError(errorText(problem,t));}
    finally{setReadingAttachment(false);if(fileInput.current)fileInput.current.value='';}
  }

  function openSettings() { navigate('/admin?tab=models'); }

  const selectedSessionData=sessions.find(session=>session.id===sessionId);
  const sessionRunning=!!sessionId&&(activeTurns.current.has(sessionId)||runningIds.includes(sessionId));
  function openDraft(value: DashboardDraft, analysisRange?: TimeRange) {
    setInspectorTab('artifacts');setInspectorOpen(true); const copy = JSON.parse(JSON.stringify(value)) as DashboardDraft; setDraft({ ...copy, range: copy.range ?? analysisRange ?? context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) }); setDraftError(''); setPreview({});  }
  function updatePanel(index: number, update: Partial<DraftPanel>) { setDraft(previous => previous ? { ...previous, panels: previous.panels.map((panel, panelIndex) => panelIndex === index ? { ...panel, ...update } : panel) } : previous); setPreview({}); }
  async function previewDraft() {
    if (!draft) return; setPreviewing(true); setDraftError(''); const abort = new AbortController(); previewController.current = abort;
    try { const result: Record<number, QueryResponse> = {}; for (let index = 0; index < draft.panels.length; index++) { result[index] = await api<QueryResponse>('/query', { method: 'POST', signal: abort.signal, body: JSON.stringify({ request_id: crypto.randomUUID(), range: draft.range ?? context.range ?? rangeFor(lookback), interval_ms: 60000, source: 'assistant-preview', queries: draft.panels[index].queries }) }); } setPreview(result); }
    catch (problem) { if (!abort.signal.aborted) setDraftError(errorText(problem,t)); } finally { setPreviewing(false); previewController.current = null; }
  }
  async function saveDraft() {
    if (!draft || !draft.title.trim()) return;
    setDraftSaving(true); setDraftError('');
    try {
      if (onDashboardDraft) await onDashboardDraft(draft);
      else await api('/dashboards', { method: 'POST', body: JSON.stringify(draft) });
      setDraft(null); void message.success(t(`已保存大盘“${draft.title}”`,`Dashboard “${draft.title}” saved`));
    } catch (problem) { setDraftError(errorText(problem,t)); } finally { setDraftSaving(false); }
  }
  function newConversation() { ++selectionVersion.current;setLoading(false);drafts.current.set(selectedSession.current??'new',{text,attachments});selectedSession.current=null;setSessionId(null);setEvents([]);const draft=drafts.current.get('new');setText(draft?.text??'');setAttachments(draft?.attachments??[]);setError('');setHistoryOpen(false); }
  const categoryLabel=(value?:string)=>value?.trim()?value.trim():t("未分类","Uncategorized");
  const categoryOptions=useMemo(()=>{const base=[t("未分类","Uncategorized"),t("监控","Monitoring"),t("Agent 与主机","Agents & hosts"),t("运维任务","Operations"),t("研究","Research")];const values=[...new Set([...base,...sessions.map(session=>session.category?.trim()||"").filter(Boolean)])];return values.map(value=>({value:value===t("未分类","Uncategorized")?"":value,label:categoryLabel(value)}));},[sessions,t]);
  const categoryOptionsFor=(value?:string)=>categoryOptions.some(option=>option.value===(value||""))?categoryOptions:[...categoryOptions,{value:value||"",label:categoryLabel(value)}];
  async function updateSessionCategory(id:string,category:string){
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify({category})}); setSessions(previous=>previous.map(session=>session.id===id?{...session,category}:session)); if(selectedSession.current===id)void loadSession(id); }
    catch(problem){ setError(errorText(problem,t)); void message.error(errorText(problem,t)); }
  }
  async function deleteSession(id:string){
    setDeletingIds(previous=>[...new Set([...previous,id])]);
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}`,{method:"DELETE"}); setSessions(previous=>previous.filter(session=>session.id!==id)); eventCache.current.delete(id);drafts.current.delete(id); if(sessionId===id)newConversation(); void message.success(t("对话已删除","Conversation deleted")); }
    catch(problem){ setError(errorText(problem,t)); void message.error(errorText(problem,t)); }
    finally { setDeletingIds(previous=>previous.filter(value=>value!==id)); }
  }
  function historyContent() {
    const visible=sessions.filter(session=>session.title.toLowerCase().includes(search.toLowerCase())||categoryLabel(session.category).toLowerCase().includes(search.toLowerCase()));
    const groups=[...new Set(visible.map(session=>session.category?.trim()||""))].sort((a,b)=>Number(!a)-Number(!b)||a.localeCompare(b));
    return <div className="lm-assistant-history">
      <Button block icon={<PlusOutlined />} disabled={creating} onClick={newConversation}>{t("新对话","New conversation")}</Button>
      <Input allowClear size="small" placeholder={t("搜索对话","Search conversations")} value={search} onChange={event=>setSearch(event.target.value)} className="lm-assistant-history-search" />
      <label className="lm-assistant-category-picker">
        <span><FolderOutlined aria-hidden="true"/>{t("新对话分类","New conversation category")}</span>
        <CategoryField
          className="lm-assistant-category-input"
          value={newCategory}
          options={categoryOptions}
          disabled={creating}
          onCommit={setNewCategory}
          ariaLabel={t("新对话分类","New conversation category")}
          placeholder={t("输入新分类，回车确认","Type a category, then press Enter")}
        />
      </label>
      {groups.map(category=>{
        const items=visible.filter(session=>(session.category?.trim()||"")===category);
        return <section className="lm-assistant-history-group" key={category||"uncategorized"}>
          <header><span>{categoryLabel(category)}</span><small>{items.length}</small></header>
          {items.map(session=>{
            const status=runningIds.includes(session.id)?'running':session.status;
            const deleting=deletingIds.includes(session.id), running=status==='running';
            return <div className={`lm-assistant-session-row ${sessionId===session.id?'active':''}`} key={session.id}>
              <button className={`lm-assistant-session ${sessionId===session.id?'active':''}`} disabled={creating||deleting} onClick={()=>void loadSession(session.id)}>
                <MessageOutlined aria-hidden="true"/>
                <span className="lm-assistant-session-name">
                  <span>{session.title}</span>
                  <small>{categoryLabel(session.category)} · {new Date(session.updated_at).toLocaleString(language)}</small>
                </span>
                {status&&status!=='idle'&&<span className={`lm-assistant-session-status ${status}`} aria-label={status==='running'?t('响应中','Responding'):status==='failed'?t('失败','Failed'):t('待确认','Needs review')}>{status==='running'?<LoadingOutlined spin/>:status==='failed'?t('失败','Failed'):t('待确认','Review')}</span>}
              </button>
              <CategoryField
                className="lm-assistant-category-select"
                value={session.category||''}
                options={categoryOptionsFor(session.category)}
                disabled={deleting||running}
                onCommit={category=>void updateSessionCategory(session.id,category)}
                ariaLabel={t('对话分类','Conversation category')}
                placeholder={t('未分类','Uncategorized')}
              />
              <Button className="lm-assistant-session-delete" type="text" size="small" danger icon={<DeleteOutlined/>} loading={deleting} disabled={deleting||running} aria-label={t("删除对话","Delete conversation")} onClick={()=>void deleteSession(session.id)}/>
            </div>;
          })}
        </section>;
      })}
      {!visible.length && <div className="lm-assistant-history-empty">{t("对话会保存在这里","Conversations are saved here")}</div>}
    </div>;
  }

  const scopeControls=<div className="lm-assistant-scope"><div className="lm-assistant-scope-heading"><strong>{t('分析范围与设置','Analysis scope and settings')}</strong>{config?.enabled&&<span>{config.model}</span>}</div><label>{t('数据表','Data table')}<Select showSearch allowClear placeholder={t('全部数据表','All data tables')} value={context.table} onChange={value => setContext(previous => ({ ...previous, table: value, service: undefined }))} options={tables.map(item => ({ value: item.name, label: item.name }))} /></label><label>{t('服务','Service')}<Select showSearch allowClear placeholder={t('全部服务','All services')} value={context.service} onChange={value => setContext(previous => ({ ...previous, service: value }))} options={(table?.services ?? [...new Set(tables.flatMap(item => item.services))]).map(service => ({ value: service, label: service }))} /></label>{context.range ? <div className="lm-assistant-scope-fixed">{t('当前页面时间范围','Current page time range')}</div> : <label>{t('时间范围','Time range')}<Select value={lookback} options={[{ value: .25, label: t('最近 15 分钟','Last 15 minutes') }, { value: 1, label: t('最近 1 小时','Last hour') }, { value: 6, label: t('最近 6 小时','Last 6 hours') }, { value: 24, label: t('最近 24 小时','Last 24 hours') }]} onChange={setLookback} /></label>}{user?.role === 'admin' && config?.code_tasks_enabled && <label>{t('代码工作区','Code workspace')}<Input aria-label={t('代码工作区','Code workspace')} value={codeWorkspace} onChange={event => setCodeWorkspace(event.target.value)} placeholder="." maxLength={512} /><small>{t('代码任务在隔离副本中运行，审批后应用修改。','Code tasks run in an isolated copy and apply changes after approval.')}</small></label>}{user?.role === 'admin' && <Button type="text" icon={<SettingOutlined/>} onClick={openSettings}>{t('模型连接设置','Model connection settings')}</Button>}</div>;

  return <div className={`lm-assistant ${compact ? 'is-compact' : ''}`}>
    {!compact && <aside className="lm-assistant-sidebar"><div className="lm-assistant-sidebar-title"><HistoryOutlined /><span>{t("对话历史","Conversation history")}</span></div>{historyContent()}</aside>}
    <main className="lm-assistant-main">
      <header className="lm-workbench-head">
        <div className="lm-workbench-title">
          <span className="lm-workbench-mark"><ThunderboltOutlined/></span>
          <div>
            <strong>{sessionId?(selectedSessionData?.title||t('当前任务','Current task')):t('新任务','New task')}</strong>
            <small>{config?.model||t('模型未配置','Model not configured')} · {sessionRunning?t('运行中','Running'):selectedSessionData?.status==='needs_action'?t('待确认','Needs review'):selectedSessionData?.status==='failed'?t('失败','Failed'):t('空闲','Idle')}</small>
          </div>
        </div>
        <Button className="lm-workbench-inspector-toggle" type={inspectorOpen?'primary':'default'} size="small" icon={<PicRightOutlined/>} aria-pressed={inspectorOpen} onClick={()=>setInspectorOpen(value=>!value)}>{t('检查器','Inspector')}</Button>
      </header>
      {context.page&&<div className="lm-assistant-page-context"><span>{t("当前页面","Current page")}</span><strong>{context.dashboard_title??pageTitles[context.page.title]??context.page.title}</strong>{context.panels&&<Tag>{context.panels.length} {t("个面板"," panels")}</Tag>}{context.log_query?.keyword&&<Tag>{t("关键词：","Keyword: ")}{context.log_query.keyword}</Tag>}{!!context.selected_logs?.length&&<Tag>{t("已选日志","Selected log")}</Tag>}{context.query&&<Tag>{t("当前 SQL","Current SQL")}</Tag>}{context.context_truncated&&<Tag>{t("上下文已精简","Context trimmed")}</Tag>}</div>}
      {!loading && !config?.enabled && <Alert type="info" showIcon title={t("连接 AI 模型后开始使用","Connect an AI model to get started")} description={user?.role === 'admin' ? t("填写模型服务地址和 API Key，自动获取模型并选择调用协议。密钥由后端保管。","Enter a model service URL and API key, fetch available models and choose the API protocol. Keys are stored by the backend.") : t("请联系管理员配置并启用 AI 模型。","Ask an administrator to configure and enable an AI model.")} action={user?.role === 'admin' ? <Button onClick={openSettings}>{t("配置模型","Configure model")}</Button> : undefined} />}
      <MessageScroller.Provider key={sessionId??'new'} autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={56}>
        <MessageScroller.Root className="lm-assistant-scroll-root">
          <MessageScroller.Viewport className="lm-assistant-feed" aria-label={t('对话消息','Conversation messages')}>
            <MessageScroller.Content className="lm-assistant-thread" aria-busy={busy}>
          {loading ? <div className="lm-assistant-loading"><Spin /></div> : !turns.length ? <div className="lm-assistant-welcome"><div className="lm-assistant-orb"><ThunderboltOutlined /></div><h3>{t("从一个问题开始","Start with a question")}</h3><p>{t("我会先读取数据结构，再帮助你查询与分析。","I will inspect the data schema before helping you query and analyze it.")}</p><div className="lm-assistant-ideas">{ideas.map(idea => <button key={idea.title} onClick={() => setText(idea.text)}><strong>{idea.title}<span aria-hidden="true">↗</span></strong><small>{idea.detail}</small></button>)}</div></div> : turns.map(turn =>
            <MessageScroller.Item key={turn.id} messageId={turn.id} scrollAnchor><section className="lm-assistant-turn">
              <div className="lm-assistant-user"><div className="lm-assistant-user-content"><p>{turn.text}</p>{turn.attachments.length>0&&<div className="lm-assistant-sent-attachments">{turn.attachments.map((attachment,index)=><span className="lm-assistant-attachment" key={`${index}-${attachment.name}`}>{attachment.kind==='pdf'?<FilePdfOutlined aria-hidden="true"/>:<PictureOutlined aria-hidden="true"/>}<span>{attachment.name}</span>{attachment.pages&&<small>{attachment.pages} {t('页','pages')}</small>}</span>)}</div>}</div></div>
              <div className="lm-assistant-reply"><span className="lm-assistant-role assistant" aria-hidden="true"><ThunderboltOutlined/></span><div className="lm-assistant-reply-body">
                {turn.compacting && turn.status === 'running' && <div className="lm-assistant-run-meta" role="status">{t("正在整理较早的对话…","Summarizing earlier conversation…")}</div>}
                {turn.compacted && <div className="lm-assistant-run-meta">{turn.degraded ? t("历史整理已降级，原始记录仍保留","History summary degraded; original records are retained") : t("较早的对话已整理，原始记录仍保留","Earlier conversation summarized; original records are retained")}</div>}
                <ToolActivity turn={turn} onDraft={openDraft} canUseCodeTasks={user?.role === 'admin'} canApproveAgentUpdate={user?.role === 'admin'} />
                {turn.answer && <Answer text={turn.answer} streaming={turn.status === 'running' && busy} onSQL={onSQL} />}
                {turn.status === 'running' && busy && <div className="lm-assistant-thinking" role="status"><span /><span /><span />{t("正在分析","Analyzing")}</div>}
                {(turn.usage || turn.compactionUsage) && <div className="lm-assistant-run-meta">{turn.usage && <span>{t("模型报告用量：","Reported model usage: ")}{formatUsage(turn.usage,t)}</span>}{turn.compactionUsage && <span>{turn.usage ? ' · ' : ''}{t("历史整理：","History summary: ")}{formatUsage(turn.compactionUsage,t)}</span>}</div>}
                {turn.error && <Alert type={turn.status === 'cancelled' ? 'info' : 'error'} title={turn.error} showIcon />}
              </div></div>
            </section></MessageScroller.Item>)}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <MessageScroller.Button className="lm-assistant-jump-latest" aria-label={t('跳转到最新消息','Jump to latest message')}>{t('最新消息','Latest')}</MessageScroller.Button>
        </MessageScroller.Root>
      </MessageScroller.Provider>
      <div className="lm-assistant-composer-wrap">
        {queue.length>0&&<div className="lm-assistant-queue" aria-label={t('待发送消息','Queued messages')}><div className="lm-assistant-queue-heading">{t(`待发送 · ${queue.length}`,`Queued · ${queue.length}`)}</div>{queue.map(item=><div className="lm-assistant-queue-item" key={item.id}><span>{item.text}{item.attachments.length>0&&<small> · {item.attachments.length} {t('个附件','attachments')}</small>}</span><Button size="small" onClick={()=>void prioritize(item.id)}>{t('立即发送','Send now')}</Button><Button size="small" type="text" icon={<CloseOutlined/>} aria-label={t('移除待发消息','Remove queued message')} onClick={()=>removeQueued(item.id)}/></div>)}</div>}
        <div className="lm-assistant-composer">
          <input ref={fileInput} type="file" className="lm-assistant-file-input" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" multiple aria-label={t('选择图片或 PDF','Choose images or PDFs')} onChange={event=>void addFiles(event.target.files)}/>
          {attachments.length>0&&<div className="lm-assistant-attachments">{attachments.map((attachment,index)=><span className="lm-assistant-attachment" key={`${index}-${attachment.name}`}>{attachment.kind==='pdf'?<FilePdfOutlined aria-hidden="true"/>:<PictureOutlined aria-hidden="true"/>}<span>{attachment.name}</span><button type="button" aria-label={t(`移除 ${attachment.name}`,`Remove ${attachment.name}`)} onClick={()=>setAttachments(previous=>previous.filter((_,i)=>i!==index))}><CloseOutlined/></button></span>)}</div>}
          <Input.TextArea aria-label={t("给 AI 助手的问题","Question for the AI assistant")} placeholder={t("询问日志中的异常，或描述你想创建的大盘…","Ask about log anomalies, or describe a dashboard to create…")} value={text} onChange={event => setText(event.target.value)} autoSize={{ minRows: 2, maxRows: 7 }} maxLength={16000} disabled={!config?.enabled || loading} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          {attachmentError&&<div className="lm-assistant-attachment-error" role="alert">{attachmentError}</div>}
          <div className="lm-assistant-composer-actions"><div className="lm-assistant-composer-left"><Button type="text" icon={readingAttachment?<LoadingOutlined spin/>:<PaperClipOutlined/>} aria-label={t('添加图片或 PDF','Attach image or PDF')} disabled={!config?.enabled||readingAttachment||attachments.length>=4} onClick={()=>fileInput.current?.click()}/><Popover content={scopeControls} trigger="click" placement="top"><Button type="text" icon={<SlidersOutlined/>} aria-label={t('分析范围与设置','Analysis scope and settings')}/></Popover><Button type="text" className={compact?undefined:'lm-assistant-mobile-history'} icon={<HistoryOutlined/>} aria-label={t('对话历史','Conversation history')} onClick={()=>setHistoryOpen(true)}/><small>{t("图片与文本 PDF · Enter 发送 · Shift + Enter 换行","Images and text PDFs · Enter to send · Shift + Enter for a new line")}</small></div><div className="lm-assistant-composer-send">{busy&&(text.trim()||attachments.length>0)&&<Button size="small" aria-label={t('加入队列','Queue turn')} disabled={creating||readingAttachment} onClick={()=>void send()}>{t('加入队列','Queue turn')}</Button>}{sessionId&&runningIds.includes(sessionId)?<button type="button" className="lm-assistant-send-button" aria-label={t('停止当前响应','Stop current response')} onClick={()=>void cancel()}><span className="lm-assistant-stop-square"/></button>:<button type="button" className="lm-assistant-send-button" aria-label={t('发送','Send')} disabled={(!text.trim()&&!attachments.length)||!config?.enabled||loading||creating||readingAttachment} onClick={()=>void send()}><ArrowUpOutlined/></button>}</div></div>
        </div>
      </div>
    </main>
    {!compact&&!narrow&&inspectorOpen&&<WorkbenchInspector tab={inspectorTab} onTabChange={setInspectorTab} context={context} session={selectedSessionData} categoryLabel={categoryLabel(selectedSessionData?.category)} running={sessionRunning} model={config?.model} turns={turns} selectedArtifact={selectedArtifact} onSelectArtifact={id=>{setSelectedArtifact(id);setInspectorTab('artifacts');}} onOpenDashboard={openDraft} onUseSql={sql=>{onSQL?.(sql);void message.success(t('SQL 已填入查询编辑器','SQL moved to the query editor'));}} onNavigate={url=>navigate(url)}/>}
    <Drawer title={t('助手检查器','Assistant inspector')} className="lm-inspector-drawer" open={inspectorOpen&&(compact||narrow)} onClose={()=>setInspectorOpen(false)} size="default" destroyOnHidden>{(compact||narrow)&&<WorkbenchInspector tab={inspectorTab} onTabChange={setInspectorTab} context={context} session={selectedSessionData} categoryLabel={categoryLabel(selectedSessionData?.category)} running={sessionRunning} model={config?.model} turns={turns} selectedArtifact={selectedArtifact} onSelectArtifact={id=>{setSelectedArtifact(id);setInspectorTab('artifacts');}} onOpenDashboard={value=>{openDraft(value);setInspectorOpen(false);}} onUseSql={sql=>{onSQL?.(sql);setInspectorOpen(false);}} onNavigate={url=>{navigate(url);setInspectorOpen(false);}}/>}</Drawer>
    <Drawer title={t("对话历史","Conversation history")} open={historyOpen} onClose={() => setHistoryOpen(false)} size="default" destroyOnHidden>{historyContent()}</Drawer>
    <Modal open={!!draft} title={t("审阅大盘草稿","Review dashboard draft")} width={880} onCancel={() => { if (!draftSaving) { previewController.current?.abort(); setDraft(null); } }} footer={<Space><Button onClick={() => void previewDraft()} loading={previewing} disabled={draftSaving}>{t("运行查询预览","Run query preview")}</Button><Button onClick={() => { previewController.current?.abort(); setDraft(null); }} disabled={draftSaving}>{t("取消","Cancel")}</Button><Button type="primary" onClick={() => void saveDraft()} loading={draftSaving} disabled={previewing || !draft?.title.trim()}>{t("确认保存大盘","Save dashboard")}</Button></Space>} destroyOnHidden>{draft && <div className="lm-assistant-draft"><Alert type="info" title={t("检查查询和面板配置，确认后保存","Review queries and panel settings, then confirm to save")} showIcon />{draft.range && <p className="lm-assistant-draft-range">{t("分析时间（UTC）：","Analysis time (UTC): ")}{draft.range.from} → {draft.range.to}</p>}<label>{t("大盘名称","Dashboard name")}<Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>{draft.panels.map((panel, index) => <div className="lm-assistant-draft-panel" key={panel.id ?? index}><div className="lm-assistant-draft-panel-title"><Input value={panel.title} onChange={event => updatePanel(index, { title: event.target.value })} /><Select value={panel.type} options={['timeseries', 'bar', 'pie', 'stat', 'table', 'heatmap', 'gauge'].map(type => ({ value: type, label: type }))} onChange={type => updatePanel(index, { type })} /></div>{panel.queries.map((query, queryIndex) => <div className="lm-assistant-draft-query" key={query.refId}><span>{t("查询","Query")}{query.refId}</span><Input.TextArea value={query.sql} rows={4} onChange={event => updatePanel(index, { queries: panel.queries.map((item, itemIndex) => itemIndex === queryIndex ? { ...item, sql: event.target.value } : item) })} /></div>)}{preview[index]?.results.map(result => <div key={result.refId}><Space><Tag color={result.status === 'error' ? 'error' : 'success'}>{result.refId} · {result.status}</Tag><small>{result.elapsed_ms} ms</small>{result.truncated && <Tag color="warning">{t("结果已截断","Results truncated")}</Tag>}</Space>{result.error && <Alert type="error" title={result.error} />}{result.frames.map((frame, frameIndex) => <Table key={frameIndex} size="small" scroll={{ x: true }} pagination={{ pageSize: 5, size: 'small' }} columns={frame.columns.map((column, columnIndex) => ({ title: column.name, key: column.name, render: (_: unknown, row: unknown[]) => readable(row[columnIndex]) }))} dataSource={frame.rows} rowKey={(_, rowIndex) => String(rowIndex)} />)}</div>)}</div>)}{draftError && <Alert type="error" title={draftError} showIcon />}</div>}</Modal>
  </div>;
}

export default function AssistantPage() {
 const {language,t}=useI18n();
 return <AssistantPanel />; }
