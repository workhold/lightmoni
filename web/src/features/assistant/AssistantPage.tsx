import { createUUID } from '../../shared/uuid';
import {useI18n} from '../../shared/i18n';
import type {Translator} from '../../shared/i18n';
import {chinese} from '../alerts/translation';
import {isDashboardGrid} from '../dashboards/layout';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {MessageScroller} from '@shadcn/react/message-scroller';
import { ArrowDownOutlined, ArrowRightOutlined, BarChartOutlined, BellOutlined, CheckOutlined, CloseOutlined, CodeOutlined, CopyOutlined, DeleteOutlined, EditOutlined, FolderOutlined, FilePdfOutlined, HistoryOutlined, LoadingOutlined, MessageOutlined, PictureOutlined, PlusOutlined, PicRightOutlined, ReloadOutlined, SearchOutlined, SettingOutlined, SlidersOutlined, ThunderboltOutlined } from '@ant-design/icons';
import XMarkdown, { type ComponentProps } from '@ant-design/x-markdown';
import '@ant-design/x-markdown/themes/light.css';
import '@ant-design/x-markdown/themes/dark.css';
import {useAppearance} from '../../shared/appearance';
import { App, Alert, AutoComplete, Button, Checkbox, Collapse, Drawer, Input, Modal, Popconfirm, Popover, Select, Space, Spin, Table, Tag, Tooltip } from '../../shared/ui';
import { api } from '../../shared/api';
import {boundedMonitoringContext} from '../../shared/assistant-context';
import type { CatalogTable, QueryResponse, TimeRange, User } from '../../shared/types';
import { streamTurn, fetchSession, TurnStreamError } from './client';
import { toolSummary, toolReviewPath, formatElapsed } from './tool-summary';
import { readAttachment } from './attachments';
import { assistantTimeline, queryRangeFromTurn } from './timeline';
import SSHCheckSummary,{type SSHCheckResult} from '../../shared/SSHCheckSummary';
import AgentUpdateProgress from './AgentUpdateProgress';
import WorkbenchInspector,{type WorkbenchTab} from './WorkbenchInspector';
import {agentUpdateToolValue} from './agent-update-progress';
import AlertProposalProgress from './AlertProposalProgress';
import AssistantComposer, { type ComposerCommand, type ComposerInput } from './AssistantComposer';
import type { AssistantConfig, AssistantContext, AssistantEvent, AssistantSession, Attachment, CodeTaskResult, DashboardDraft, DraftPanel, ToolTrace, TurnView } from './types';
import './assistant.css';
import './assistant-workspace.css';

export interface AssistantPanelProps {
  compact?: boolean;
  initialContext?: AssistantContext;
  initialPrompt?: string;
  onDashboardDraft?: (draft: DashboardDraft) => Promise<void>;
  onSQL?: (sql: string) => void;
}

interface QueuedTurn { id: string; text: string; attachments: Attachment[]; context: AssistantContext; retry?: boolean }
// A dropped stream does not mean a dead turn: the server keeps running and
// persisting events, so the UI polls the session until a terminal event lands.
const RECOVERY_POLL_MS = 2000, RECOVERY_FAILURES = 3, RECOVERY_LIMIT_MS = 30 * 60_000;
const TERMINAL_EVENT_TYPES = ['turn.completed', 'turn.failed', 'turn.cancelled'];
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
function errorText(error: unknown,t:Translator=chinese): string {
  if (error instanceof Error && /invalid request origin/i.test(error.message)) return t("请求来源校验失败：请通过平台配置的访问地址打开工作台后重试。","Request origin validation failed. Open the workbench through the configured platform address and retry.");
  return error instanceof Error ? error.message : t("操作失败，请重试","Operation failed. Please retry.");
}

// Adapted from Doca ai-markdown.tsx (MIT; see NOTICE.md). Raw HTML and
// auto-loading external media remain disabled when rendering telemetry text.
const Answer = memo(function Answer({ text, streaming, onSQL }: { text: string; streaming?: boolean; onSQL?: (sql: string) => void }) {
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
});

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
function toolLabelMap(t:Translator=chinese): Record<string,string> {
  return {
    list_managed_machines:t("查询主机","Find managed hosts"),get_managed_machine:t("读取主机信息","Read managed host"),check_managed_machine_ssh:t("SSH 安装检查","SSH installation preflight"),propose_agent_install:t("准备 Agent 部署计划","Prepare Agent deployment plan"),get_agent_installation:t("核验 Agent 部署","Verify Agent deployment"),propose_agent_update:t("准备 Agent 更新计划","Prepare Agent update plan"),
    list_tables: t("读取数据表目录","Read table catalog"), describe_table: t("检查表结构","Inspect table schema"), run_query: t("执行 SQL 查询","Run SQL query"), draft_dashboard: t("生成大盘草稿","Generate dashboard draft"), code_task: t("执行代码任务","Run code task"),
    list_alert_rules: t("查询告警规则","Find alert rules"), get_alert_rule: t("读取告警规则","Read alert rule"), list_alert_silences: t("查询静默窗口","Find silence windows"), get_alert_silence: t("读取静默窗口","Read silence window"), list_alert_groups: t("查询告警组","Find alert groups"), get_alert_proposal: t("核验告警提案","Verify alert proposal"), propose_alert_change: t("准备告警变更","Prepare alert change"),
    list_services:t('查询服务目录','Find services'),get_service_deployment:t('读取服务部署','Read service deployment'),get_service_deployment_events:t('读取部署事件','Read deployment events'),propose_service_deployment:t('准备服务部署计划','Prepare service deployment plan'),
    list_agent_releases:t('查询 Agent 版本','Find Agent releases'),get_agent_update:t('读取 Agent 更新','Read Agent update'),scan_sdk_instrumentation:t('扫描 SDK 插桩','Scan SDK instrumentation'),propose_sdk_instrumentation:t('准备 SDK 插桩方案','Prepare SDK instrumentation plan'),
    list_operations_resources:t('查询运维资源','Find operations resources'),get_operations_run:t('读取运维执行','Read operations run'),propose_operations_action:t('准备运维操作','Prepare operations action'),
    list_tasks:t('查询任务','Find tasks'),get_task:t('读取任务','Read task'),list_task_runs:t('查询任务执行','Find task runs'),get_task_run:t('读取任务执行','Read task run'),get_task_proposal:t('读取任务提案','Read task proposal'),propose_task_action:t('准备任务操作','Prepare task action'),
  };
}
function toolLabel(name:string,t:Translator=chinese): string { return toolLabelMap(t)[name] ?? name.replaceAll('_',' '); }

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

  const tools = turn.tools.filter(tool => tool.name !== 'code_task' || canUseCodeTasks);
  if (!tools.length) return null;
  return <div className="lm-assistant-tools">{tools.map(tool => {
    if (tool.name === 'code_task') return <CodeTaskProgress key={tool.callId} tool={tool} />;
    if (tool.name === 'propose_alert_change') return <AlertProposalProgress key={tool.callId} tool={tool} />;
    const agentUpdate = agentUpdateToolValue(tool.name, tool.result);
    if (agentUpdate) return <AgentUpdateProgress key={tool.callId} value={agentUpdate} canApprove={canApproveAgentUpdate} />;
    const result = tool.result as { draft?: DashboardDraft; error?: string;id?:string;machine_id?:string;status?:string;review_url?:string } | undefined;
    const input=tool.input as {machine_id?:string;sql?:string} | undefined;
    const badges=toolSummary(tool.name,tool.result,t);
    const reviewPath=toolReviewPath(tool.result,window.location.origin);
    return <Collapse key={tool.callId} size="small" ghost items={[{ key: tool.callId, label: <Space wrap><span className={`lm-assistant-tool-dot ${tool.status}`} /><span>{toolLabel(tool.name,t)}</span><span className="lm-assistant-tool-badges">{badges.map((badge,index)=><span key={index} className={`lm-assistant-tool-badge ${badge.kind??''}`}>{badge.text}</span>)}</span><Tag bordered={false} color={tool.status === 'error' ? 'error' : tool.status === 'success' ? 'success' : tool.status === 'cancelled' ? 'default' : 'processing'}>{tool.status === 'running' ? t("执行中","Running") : tool.status === 'error' ? t("失败","Failed") : tool.status === 'cancelled' ? t("已取消","Cancelled") : t("完成","Completed")}</Tag></Space>, children: <div>{tool.name==='check_managed_machine_ssh'&&<div className="lm-assistant-terminal"><div className="lm-assistant-terminal-label">SSH · {t('固定只读安装检查','Fixed read-only installation check')}</div><pre><span>$</span> ssh {input?.machine_id??t('已登记主机','registered host')} <em>{t('由中心执行受限预检','restricted preflight via center')}</em></pre></div>}{tool.name==='run_query'&&input?.sql&&<div className="lm-assistant-terminal"><div className="lm-assistant-terminal-label">SQL</div><pre>{input.sql}</pre></div>}{(tool.input!==undefined||tool.result!==undefined)&&<details className="lm-assistant-tool-raw"><summary>{t('原始参数与结果','Raw arguments and result')}</summary><div className="lm-assistant-tool-heading">{t("调用参数","Call arguments")}</div><pre className="lm-assistant-tool-json">{readable(tool.input)}</pre>{tool.result !== undefined && <><div className="lm-assistant-tool-heading">{t("执行结果","Execution result")}</div><pre className="lm-assistant-tool-json">{readable(tool.result)}</pre></>}</details>}{tool.status==='success'&&tool.name==='check_managed_machine_ssh'&&result?.id&&<SSHCheckSummary result={tool.result as SSHCheckResult}/>} {tool.status==='success'&&tool.name==='propose_agent_install'&&result?.id&&result.machine_id&&<Button type="primary" onClick={()=>navigate(`/machines?machine=${encodeURIComponent(result.machine_id!)}&deployment=${encodeURIComponent(result.id!)}`)}>{t('审阅部署计划','Review deployment plan')}</Button>}{tool.status==='success'&&tool.name!=='propose_agent_install'&&reviewPath&&<Button type="primary" onClick={()=>navigate(reviewPath)}>{t('审阅此计划','Review this plan')}</Button>}{tool.status === 'success' && result?.draft && <Button type="primary" onClick={() => onDraft(result.draft!, queryRangeFromTurn(turn, tool.callId))}>{t("审阅大盘草稿","Review dashboard draft")}</Button>}</div> }]} />;
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
  const [now,setNow]=useState(()=>Date.now());
  const running=turn.status==='running';
  useEffect(()=>{
    if(!running)return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return()=>window.clearInterval(timer);
  },[running]);
  if(!turn.tools.length)return null;
  const attention=turn.tools.some(tool=>(tool.name==='draft_dashboard'&&!!(tool.result as {draft?:unknown}|undefined)?.draft)||reviewRequired(tool.result));
  const failedStep=turn.tools.some(tool=>tool.status==='error');
  const open=manual??(turn.status==='running'||turn.status==='failed'||attention);
  const elapsed=formatElapsed(turn.startedAt,turn.endedAt,now);
  const label=running?t(`正在执行 ${turn.tools.length} 项操作`,`Working on ${turn.tools.length} steps`):attention?t(`${turn.tools.length} 项操作需要查看`,`${turn.tools.length} steps need review`):failedStep||turn.status==='failed'?t(`${turn.tools.length} 项操作 · 含失败`,`${turn.tools.length} steps · includes a failure`):t(`已完成 ${turn.tools.length} 项操作`,`Completed ${turn.tools.length} steps`);
  return <div className="lm-assistant-activity"><button type="button" className="lm-assistant-activity-trigger" aria-expanded={open} onClick={()=>setManual(!open)}><span className={`lm-assistant-activity-indicator ${failedStep?'failed':turn.status}`} aria-hidden="true"/><span>{label}</span>{elapsed&&<span className="lm-assistant-activity-elapsed">{elapsed}</span>}<span className="lm-assistant-activity-chevron" aria-hidden="true">⌄</span></button>{open&&<div className="lm-assistant-activity-content">{running&&<ol className="lm-assistant-tool-rows" aria-label={t('工具执行进度','Tool progress')}>{turn.tools.map(tool=><li key={tool.callId} className={`lm-assistant-tool-row ${tool.status}`}><span className={`lm-assistant-tool-dot ${tool.status}`} aria-hidden="true"/><span className="lm-assistant-tool-row-name">{toolLabel(tool.name,t)}</span><span className="lm-assistant-tool-row-elapsed">{formatElapsed(tool.startedAt,tool.endedAt,now)}</span></li>)}</ol>}<ToolProgress turn={turn} onDraft={onDraft} canUseCodeTasks={canUseCodeTasks} canApproveAgentUpdate={canApproveAgentUpdate}/></div>}</div>;
}

function RunStatus({ turn, recovering, stopping, onStop }: { turn?: TurnView; recovering: boolean; stopping: boolean; onStop: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const tool = turn?.tools.filter(item => item.status === 'running').at(-1);
  const label = recovering ? t('连接中断，正在恢复…', 'Connection lost, recovering…')
    : tool ? toolLabel(tool.name, t)
      : turn?.answer ? t('正在生成回答', 'Writing a response')
        : turn ? t('正在分析', 'Analyzing') : t('正在提交消息', 'Submitting message');
  return <div className="lm-assistant-runbar">
    <div className="lm-assistant-runbar-state" role="status">
      <span className="lm-assistant-activity-indicator running" aria-hidden="true" />
      <strong className={recovering ? 'lm-assistant-runbar-recovery' : undefined}>{label}</strong>
    </div>
    {!!turn?.tools.length && <span className="lm-assistant-runbar-steps">{t(`${turn.tools.length} 步`, `${turn.tools.length} steps`)}</span>}
    <span className="lm-assistant-runbar-elapsed" aria-hidden="true">{formatElapsed(turn?.startedAt ?? turn?.timestamp, undefined, now) || '00:00'}</span>
    <button type="button" className="lm-assistant-runbar-stop" aria-label={t('停止当前响应', 'Stop current response')} disabled={stopping} onClick={onStop}>
      {stopping ? <LoadingOutlined spin /> : <span className="lm-assistant-stop-square" aria-hidden="true" />}
      <span>{stopping ? t('正在停止', 'Stopping') : t('停止', 'Stop')}</span>
    </button>
  </div>;
}

type CategoryOption={value:string;label:ReactNode;create?:boolean};

function CategoryField({value,options,className,onCommit,ariaLabel,placeholder,disabled}:{value:string;options:{value:string;label:ReactNode}[];className?:string;onCommit:(value:string)=>void;ariaLabel:string;placeholder:string;disabled?:boolean}) {
  const {t}=useI18n(),[draft,setDraft]=useState(value.trim()),committed=useRef(value.trim());
  useEffect(()=>{committed.current=value.trim();setDraft(value.trim())},[value]);
  const commit=(next:string)=>{const normalized=next.trim();if(normalized===committed.current)return;committed.current=normalized;onCommit(normalized);};
  const text=draft.trim();
  const categoryOptions:CategoryOption[]=(():CategoryOption[]=>{
    if(!text||options.some(option=>option.value===text))return options;
    return [{value:text,label:<span className="lm-assistant-category-create"><PlusOutlined aria-hidden="true"/>{t(`创建新分类：${text}`,`Create new category: ${text}`)}</span>,create:true},...options];
  })();
  return <AutoComplete
    className={className}
    value={draft}
    options={categoryOptions}
    disabled={disabled}
    onChange={next=>setDraft(String(next))}
    onSelect={next=>{const nextText=String(next).trim();setDraft(nextText);commit(nextText)}}
    onBlur={()=>commit(draft)}
    onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit(text)}}}
    filterOption={(input,option)=>Boolean((option as CategoryOption).create)||String(option?.value||'').toLowerCase().includes(input.toLowerCase())}
    defaultActiveFirstOption={Boolean(text)&&!options.some(option=>option.value===text)}
    placeholder={placeholder}
    aria-label={ariaLabel}
  />;
}

function CategoryManager({categories,onRequestDelete,onRequestRename}:{categories:{value:string;count:number;baseKey?:string}[];onRequestDelete:(value:string)=>void;onRequestRename:(value:string)=>void}) {
  const {t}=useI18n(),[open,setOpen]=useState(false);
  return <>
    <button type="button" className="lm-assistant-category-manage" onClick={()=>setOpen(true)}><SlidersOutlined aria-hidden="true"/><span>{t("管理分类","Manage categories")}</span></button>
    <Modal open={open} title={t("管理分类","Manage categories")} footer={null} onCancel={()=>setOpen(false)} destroyOnHidden>
      <div className="lm-assistant-category-manager">
        {categories.map(item=>(
          <div className="lm-assistant-category-manager-row" key={item.value}>
            <span className="lm-assistant-category-manager-name">{item.value}</span>
            <small>{t(`${item.count} 个对话`,`${item.count} conversations`)}</small>
            <Button type="text" size="small" icon={<EditOutlined/>} aria-label={t(`重命名分类 ${item.value}`,`Rename category ${item.value}`)} onClick={()=>onRequestRename(item.value)}/>
            <Button type="text" size="small" danger icon={<DeleteOutlined/>} aria-label={t(`删除分类 ${item.value}`,`Delete category ${item.value}`)} onClick={()=>onRequestDelete(item.value)}/>
          </div>
        ))}
      </div>
    </Modal>
  </>;
}

function SessionHeaderEditor({title,category,options,disabled,onTitleCommit,onCategoryCommit}:{title:string;category:string;options:{value:string;label:ReactNode}[];disabled:boolean;onTitleCommit:(title:string)=>void;onCategoryCommit:(category:string)=>void}) {
  const {t}=useI18n(),[draft,setDraft]=useState(title),committed=useRef(title);
  useEffect(()=>{committed.current=title;setDraft(title)},[title]);
  const commit=()=>{const next=draft.trim();if(!next||next===committed.current)return;committed.current=next;onTitleCommit(next);};
  return <div className="lm-session-header-editor">
    <Input
      className="lm-session-title-input"
      value={draft}
      disabled={disabled}
      onChange={event=>setDraft(event.target.value)}
      onBlur={commit}
      onPressEnter={commit}
      aria-label={t('对话标题','Conversation title')}
      placeholder={t('输入对话标题','Enter conversation title')}
      maxLength={240}
      size="small"
    />
    <CategoryField
      className="lm-session-category-input"
      value={category}
      options={options}
      disabled={disabled}
      onCommit={onCategoryCommit}
      ariaLabel={t('对话分类','Conversation category')}
      placeholder={t('未分类','Uncategorized')}
    />
  </div>;
}

const HISTORY_DRAWER_MEDIA = '(max-width: 920px)';
const INSPECTOR_DRAWER_MEDIA = '(max-width: 1260px)';

export function AssistantPanel({ compact = false, initialContext, initialPrompt, onDashboardDraft, onSQL }: AssistantPanelProps) {
 const {language,t}=useI18n();
 const pageTitles:Record<string,string>={
  '概览':t('概览','Overview'),'监控大盘':t('监控大盘','Dashboards'),'日志探索':t('日志探索','Log explorer'),
  '告警中心':t('告警中心','Alerts'),'节点助手':t('节点助手','Node assistants'),'主机管理':t('主机管理','Machines'),
  '数据接入':t('数据接入','Data ingestion'),'数据管理':t('数据管理','Data management'),'AI 助手':t('AI 助手','AI assistant'),
  '个人设置':t('个人设置','Personal settings'),'管理后台':t('管理后台','Administration'),'监控工作台':t('监控工作台','Monitoring workspace'),
 };

  const ideas = [
  { icon: <SearchOutlined />, title: t("分析异常日志","Investigate log anomalies"), text: t("分析当前时间范围的日志，找出主要错误、发生趋势和可能的原因。区分数据事实与推测，并给出后续排查 SQL。","Analyze logs in the current time range for key errors, trends and possible causes. Distinguish facts from hypotheses and provide SQL for further investigation."), detail: t("找出主要错误和趋势","Find the leading errors and trends") },
  { icon: <BarChartOutlined />, title: t("创建服务大盘","Create a service dashboard"), text: t("根据现有数据创建服务监控大盘，包含请求量、错误率和延迟。先检查可用数据表，并生成可审阅的大盘草稿。","Create a service monitoring dashboard from available data, covering request volume, error rate and latency. Inspect available tables first and generate a dashboard draft for review."), detail: t("请求量、错误率和延迟","Request volume, error rate and latency") },
  { icon: <CodeOutlined />, title: t("编写查询 SQL","Write a SQL query"), text: t("检查现有数据表与字段，生成按服务统计请求量、错误率和延迟的 ClickHouse SQL。说明时间过滤和聚合方式。","Inspect available tables and fields, then generate ClickHouse SQL for request volume, error rate and latency by service. Explain time filters and aggregation."), detail: t("基于已接入的数据表","Build a query from available tables") },
  { icon: <BellOutlined />, title: t("检查告警规则","Review alert rules"), text: t("查看当前页面相关的告警规则和静默窗口，说明当前配置。根据我的要求准备变更提案，展示前后差异与影响，等我确认后再应用。","Review alert rules and silence windows relevant to this page. Explain the current configuration, then prepare a change proposal showing differences and impact. Wait for my confirmation before applying it."), detail: t("查看阈值与静默窗口","Review thresholds and silence windows") },
];

  const navigate=useNavigate();
  const [searchParams,setSearchParams]=useSearchParams();
  const requestedSessionId=compact?null:searchParams.get('session') || null;
  const [config, setConfig] = useState<AssistantConfig>();
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState('');
  const [configRefresh, setConfigRefresh] = useState(0);
  const [user, setUser] = useState<User>();
  const [tables, setTables] = useState<CatalogTable[]>([]);
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [sessionStatus, setSessionStatus] = useState<AssistantSession['status']>();
  const [text, setText] = useState(initialPrompt ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingAttachment, setReadingAttachment] = useState(false);
  const [context, setContext] = useState<AssistantContext>(initialContext ?? {});
  const [lookback, setLookback] = useState(1);
  const [creating, setCreating] = useState(false);
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [recoveringIds, setRecoveringIds] = useState<string[]>([]);
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  const [openingSession, setOpeningSession] = useState(false);
  const [sessionReadError, setSessionReadError] = useState<{id:string;detail:string}>();
  const loading = configLoading || openingSession || !!sessionReadError;
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [hiddenBaseCategories,setHiddenBaseCategories]=useState<string[]>([]);
  const [customCategories,setCustomCategories]=useState<string[]>([]);
  const [categoryDelete,setCategoryDelete]=useState<{value:string;count:number;baseKey?:string}>();
  const [deletingCategory,setDeletingCategory]=useState(false);
  const [categoryRename,setCategoryRename]=useState<{value:string;next:string;count:number;baseKey?:string}>();
  const [renamingCategory,setRenamingCategory]=useState(false);
  const [inspectorTab,setInspectorTab]=useState<WorkbenchTab>('context');
  const [selectedArtifact,setSelectedArtifact]=useState<string>();
  const [inspectorOpen,setInspectorOpen]=useState(false);
  const [historyNarrow,setHistoryNarrow]=useState(() => window.matchMedia(HISTORY_DRAWER_MEDIA).matches);
  const [inspectorNarrow,setInspectorNarrow]=useState(() => window.matchMedia(INSPECTOR_DRAWER_MEDIA).matches);
  const historyInDrawer=compact || historyNarrow;
  const inspectorInDrawer=compact || inspectorNarrow;
  const [draft, setDraft] = useState<DashboardDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  const [codeWorkspace, setCodeWorkspace] = useState(initialContext?.code_workspace ?? '.');
  const {message}=App.useApp();
  const [preview, setPreview] = useState<Record<number, QueryResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const activeTurns = useRef(new Map<string,AbortController>());
  const cancelRequests = useRef(new Set<string>());
  const creatingRef = useRef(false);
  const attachmentRead = useRef(false);
  const selectionVersion = useRef(0);
  const selectedSession = useRef<string | null>(null);
  const sessionRead = useRef<AbortController | undefined>(undefined);
  const eventCache = useRef(new Map<string,AssistantEvent[]>());
  const queuedTurns = useRef(new Map<string,QueuedTurn[]>());
  const drafts = useRef(new Map<string,{text:string;attachments:Attachment[]}>());
  const composerInput = useRef<ComposerInput>(null);
  const previewController = useRef<AbortController | null>(null);
  const turns = useMemo(() => assistantTimeline(events, language, sessionStatus === 'failed'), [events, language, sessionStatus]);
  const table = tables.find(item => item.name === context.table);
  const sessionRunning = !!sessionId && (activeTurns.current.has(sessionId) || runningIds.includes(sessionId) || sessionStatus === 'running');
  const busy = creating || sessionRunning;
  const isWelcome = !sessionId && !requestedSessionId && !creating && !openingSession && !sessionReadError;
  const queue = sessionId ? queuedTurns.current.get(sessionId) ?? [] : [];
  void queueVersion;

  async function refreshSessions(signal?: AbortSignal) {
    const data = await api<{ items: AssistantSession[] }>('/assistant/sessions', { signal });
    if (signal?.aborted) return;
    setSessions(data.items);
    setRunningIds(data.items.filter(item => item.status === 'running').map(item => item.id));
  }
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setConfigError('');
    setConfigLoading(true);
    void api<AssistantConfig>('/assistant/config', { signal }).then(model => {
      if (signal.aborted) return;
      setConfig(model);
      setCodeWorkspace(initialContext?.code_workspace ?? model.code_workspace ?? '.');
    }).catch(problem => { if (!signal.aborted) setConfigError(errorText(problem,t)); })
      .finally(() => { if (!signal.aborted) setConfigLoading(false); });
    return () => controller.abort();
  }, [configRefresh]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api<CatalogTable[]>('/catalog/tables', { signal }).then(catalog => {
      if (signal.aborted) return;
      setTables(Array.isArray(catalog) ? catalog : []);
      setCatalogUnavailable(false);
    }).catch(() => { if (!signal.aborted) setCatalogUnavailable(true); });
    return () => controller.abort();
  }, [catalogRefresh]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api<User>('/auth/me', { signal }).then(actor => { if (!signal.aborted) setUser(actor); }).catch(() => {});
    let timer: number | undefined;
    const poll = async (initial = false) => {
      try { await refreshSessions(AbortSignal.any([signal, AbortSignal.timeout(10000)])); }
      catch (problem) { if (initial && !signal.aborted) setError(errorText(problem,t)); }
      finally { if (!signal.aborted) timer = window.setTimeout(poll, 3000); }
    };
    void poll(true);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const history = window.matchMedia(HISTORY_DRAWER_MEDIA);
    const inspector = window.matchMedia(INSPECTOR_DRAWER_MEDIA);
    const updateHistory = (event: MediaQueryListEvent) => {
      setHistoryNarrow(event.matches);
      setHistoryOpen(false);
    };
    const updateInspector = (event: MediaQueryListEvent) => {
      setInspectorNarrow(event.matches);
      if (event.matches) setInspectorOpen(false);
    };
    history.addEventListener('change', updateHistory);
    inspector.addEventListener('change', updateInspector);
    return () => {
      history.removeEventListener('change', updateHistory);
      inspector.removeEventListener('change', updateInspector);
    };
  }, []);
  useEffect(() => { if (initialPrompt !== undefined) setText(initialPrompt); }, [initialPrompt]);
  useEffect(() => { if (initialContext) { setContext(initialContext); if (initialContext.code_workspace !== undefined) setCodeWorkspace(initialContext.code_workspace); } }, [initialContext]);
  useEffect(() => () => sessionRead.current?.abort(), []);

  function setSessionLocation(id: string | null, replace = false) {
    if (compact || id === requestedSessionId) return;
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (id) next.set('session', id);
      else next.delete('session');
      return next;
    }, { replace, preventScrollReset: true });
  }

  function selectConversation(id: string) {
    if (compact || requestedSessionId === id) {
      if (id !== selectedSession.current || sessionReadError) void loadSession(id);
      else setHistoryOpen(false);
    } else {
      setSessionLocation(id);
      setHistoryOpen(false);
    }
  }

  useEffect(() => {
    if (compact) return;
    if (requestedSessionId === selectedSession.current) {
      if (sessionRead.current || sessionReadError) {
        sessionRead.current?.abort();
        setOpeningSession(false);
        setSessionReadError(undefined);
      }
    } else if (requestedSessionId) {
      void loadSession(requestedSessionId);
    } else {
      newConversation({ syncLocation: false, focus: false });
    }
  }, [compact, requestedSessionId]);

  async function loadSession(id: string) {
    const version = ++selectionVersion.current;
    sessionRead.current?.abort();
    const controller = new AbortController();
    sessionRead.current = controller;
    if (selectedSession.current !== id) drafts.current.set(selectedSession.current ?? 'new', { text, attachments });
    setError('');
    setSessionReadError(undefined);
    setOpeningSession(true);
    try {
      const session = await fetchSession(id, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      if (controller.signal.aborted || version !== selectionVersion.current) return;
      const changed = selectedSession.current !== id;
      selectedSession.current = id;
      setSessionId(id);
      applySessionSnapshot(session);
      setSessions(previous => previous.some(item => item.id === id) ? previous : [{ ...session, events: null, messages: null }, ...previous]);
      setSelectedArtifact(undefined);
      if (changed) {
        const draft = drafts.current.get(id);
        setText(draft?.text ?? '');
        setAttachments(draft?.attachments ?? []);
        setAttachmentError('');
      }
      setHistoryOpen(false);
    } catch (problem) {
      if (!controller.signal.aborted && version === selectionVersion.current) setSessionReadError({ id, detail: errorText(problem, t) });
    } finally {
      if (sessionRead.current === controller) {
        sessionRead.current = undefined;
        setOpeningSession(false);
      }
    }
  }

  function applySessionSnapshot(session: AssistantSession) {
    const stored = session.events ?? [];
    const lastStored = stored.at(-1)?.sequence ?? -1;
    const events = [...stored, ...(eventCache.current.get(session.id) ?? []).filter(event => event.sequence > lastStored)];
    eventCache.current.set(session.id, events);
    if (selectedSession.current === session.id) {
      setEvents(events);
      setSessionStatus(session.status);
    }
  }

  function updateQueue(id:string, items:QueuedTurn[]) { queuedTurns.current.set(id,items); setQueueVersion(value=>value+1); }
  function takeNext(id: string) {
    const [next, ...remaining] = queuedTurns.current.get(id) ?? [];
    if (!next || next.retry) return;
    updateQueue(id, remaining);
    return next;
  }

  async function recoverTurn(id: string, requestID: string, turnID: string | undefined, signal: AbortSignal) {
    setRecoveringIds(previous=>previous.includes(id)?previous:[...previous,id]);
    const started=Date.now();
    let failures = 0, missing = 0;
    try {
      while(Date.now()-started<RECOVERY_LIMIT_MS) {
        await new Promise(resolve=>setTimeout(resolve,RECOVERY_POLL_MS));
        if (signal.aborted) break;
        try {
          const session = await fetchSession(id, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
          failures = 0;
          applySessionSnapshot(session);
          const stored = session.events ?? [];
          turnID ??= stored.find(event => event.type === 'user.message' && event.data.request_id === requestID)?.turn_id;
          if (turnID) {
            const finished = stored.some(event => event.turn_id === turnID && TERMINAL_EVENT_TYPES.includes(event.type));
            if (finished || session.status && session.status !== 'running') return { accepted: true, settled: true };
          } else if (++missing >= 2) {
            break;
          }
        } catch {
          if (signal.aborted || ++failures >= RECOVERY_FAILURES) break;
        }
      }
      return { accepted: !!turnID, settled: false };
    } finally { setRecoveringIds(previous=>previous.filter(value=>value!==id)); }
  }
  async function runTurn(id:string, item:QueuedTurn) {
    if (activeTurns.current.has(id)) return;
    const abort = new AbortController(); activeTurns.current.set(id,abort); setRunningIds(previous=>[...new Set([...previous,id])]);
    let turnID: string | undefined;
    let settled = false;
    try {
      await streamTurn(id,item.text,item.context,event=>{
        turnID ??= event.turn_id;
        const merged=mergeEvents(eventCache.current.get(id)??[],[event]); eventCache.current.set(id,merged);
        if (selectedSession.current === id) { setSessionStatus('running'); setEvents(merged); }
      },abort.signal,language,item.attachments,item.id);
      settled = true;
    } catch (problem) {
      let accepted = !!turnID;
      if (problem instanceof TurnStreamError && problem.code !== 'http' && !abort.signal.aborted) {
        const recovered = await recoverTurn(id, item.id, turnID, abort.signal);
        accepted = recovered.accepted || problem.code === 'accepted';
        settled = recovered.settled;
      }
      if (!settled && !abort.signal.aborted) {
        if (!accepted) updateQueue(id, [{ ...item, retry: true }, ...(queuedTurns.current.get(id) ?? [])]);
        if (selectedSession.current === id) setError(accepted ? errorText(problem,t) : t('提交未确认，消息保留在待发送队列。','Submission was not confirmed. The message is still in the queue.') + ' ' + errorText(problem,t));
      }
    } finally {
      try { applySessionSnapshot(await fetchSession(id, AbortSignal.timeout(10000))); } catch { /* Keep received progress. */ }
      const next=settled?takeNext(id):undefined;
      activeTurns.current.delete(id);
      if(next)void runTurn(id,next);
      else setRunningIds(previous=>previous.filter(value=>value!==id));
    }
  }

  const followingSession = !!sessionId && !activeTurns.current.has(sessionId) &&
    (sessionRunning || turns.at(-1)?.status === 'running');
  useEffect(() => {
    if (!sessionId || !followingSession) return;
    const id = sessionId;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const session = await fetchSession(id, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        if (signal.aborted || selectedSession.current !== id || activeTurns.current.has(id)) return;
        applySessionSnapshot(session);
        if (session.status && session.status !== 'running') {
          setRunningIds(previous => previous.filter(value => value !== id));
          const next = takeNext(id);
          if (next) void runTurn(id, next);
          return;
        }
      } catch { /* Retain the last observation and try again. */ }
      if (!signal.aborted) timer = window.setTimeout(poll, RECOVERY_POLL_MS);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sessionId, followingSession]);

  async function send(value = text) {
    const prompt=value.trim()||(attachments.length?t('请分析这些附件','Analyze these attachments'):'');
    if (!prompt || !config?.enabled || loading || attachmentRead.current || creatingRef.current) return;
    const frozenContext = boundedMonitoringContext({ ...context, range: context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) });
    delete frozenContext.code_workspace;
    if (user?.role === 'admin' && config.code_tasks_enabled) frozenContext.code_workspace = codeWorkspace.trim() || '.';
    const item:QueuedTurn={id:createUUID(),text:prompt,attachments:[...attachments],context:frozenContext};
    let id=sessionId;
    if(!id){
      creatingRef.current=true;
      const version=++selectionVersion.current;
      setCreating(true);
      try {
        const session=await api<AssistantSession>('/assistant/sessions',{method:'POST',body:JSON.stringify({title:item.text.slice(0,60),category:newCategory})});
        id=session.id;
        setSessions(previous=>[session,...previous.filter(item=>item.id!==session.id)]);
        if (version !== selectionVersion.current) {
          void runTurn(id, item);
          return;
        }
        selectedSession.current=id;
        setSessionId(id);
        setSessionLocation(id,true);
        drafts.current.delete('new');
        applySessionSnapshot(session);
      }
      catch(problem){if(version===selectionVersion.current)setError(errorText(problem,t));return;}
      finally{creatingRef.current=false;setCreating(false);}
    }
    setText('');setAttachments([]);setAttachmentError('');drafts.current.set(id,{text:'',attachments:[]});setError('');
    if(activeTurns.current.has(id)||sessionRunning){updateQueue(id,[...(queuedTurns.current.get(id)??[]),item]);return;}
    void runTurn(id,item);
  }

  async function cancel(id=sessionId):Promise<boolean> {
    if (!id || cancelRequests.current.has(id)) return false;
    cancelRequests.current.add(id);
    setStoppingIds(previous => [...previous, id]);
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }); return true; }
    catch (problem) { if (selectedSession.current === id) setError(errorText(problem,t)); return false; }
    finally {
      cancelRequests.current.delete(id);
      setStoppingIds(previous => previous.filter(value => value !== id));
    }
  }

  async function prioritize(itemId:string){
    if(!sessionId)return;
    const items=queuedTurns.current.get(sessionId)??[],index=items.findIndex(item=>item.id===itemId);
    if(index<0)return;
    updateQueue(sessionId,[{ ...items[index], retry: false },...items.filter(item=>item.id!==itemId)]);
    if(sessionRunning)await cancel(sessionId);
    else {const next=takeNext(sessionId);if(next)void runTurn(sessionId,next);}
  }
  function removeQueued(itemId:string){if(sessionId)updateQueue(sessionId,(queuedTurns.current.get(sessionId)??[]).filter(item=>item.id!==itemId));}
  async function addFiles(files:File[]){
    if(!files.length || attachmentRead.current)return;
    attachmentRead.current=true;
    const version=selectionVersion.current;
    setReadingAttachment(true);setAttachmentError('');
    try { const added:Attachment[]=[];for(const file of files){if(attachments.length+added.length>=4)throw Error(t('最多添加 4 个附件','Add up to 4 attachments'));added.push(await readAttachment(file));}if([...attachments,...added].reduce((total,item)=>total+(item.kind==='image'?(item.data?.length??0)*.75:0),0)>(1<<20))throw Error(t('图片总大小不能超过 1 MiB','Images cannot exceed 1 MiB in total'));if(version===selectionVersion.current)setAttachments(previous=>[...previous,...added]); }
    catch(problem){if(version===selectionVersion.current)setAttachmentError(errorText(problem,t));}
    finally{attachmentRead.current=false;setReadingAttachment(false);}
  }

  function openSettings() { navigate('/admin?tab=models'); }

  const selectedSessionData=sessions.find(session=>session.id===sessionId);
  const recoveringNow=!!sessionId&&recoveringIds.includes(sessionId);
  const runningTurn=sessionRunning?turns.filter(turn=>turn.status==='running').at(-1):undefined;
  function openDraft(value: DashboardDraft, analysisRange?: TimeRange) {
    setInspectorTab('artifacts');
    setInspectorOpen(true);
    const copy = structuredClone(value);
    for (const panel of copy.panels) if (panel.grid && !isDashboardGrid(panel.grid)) delete panel.grid;
    setDraft({ ...copy, range: copy.range ?? analysisRange ?? context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) });
    setDraftError('');
    setPreview({});
  }
  function updatePanel(index: number, update: Partial<DraftPanel>) { setDraft(previous => previous ? { ...previous, panels: previous.panels.map((panel, panelIndex) => panelIndex === index ? { ...panel, ...update } : panel) } : previous); setPreview({}); }
  async function previewDraft() {
    if (!draft) return; setPreviewing(true); setDraftError(''); const abort = new AbortController(); previewController.current = abort;
    try { const result: Record<number, QueryResponse> = {}; for (let index = 0; index < draft.panels.length; index++) { result[index] = await api<QueryResponse>('/query', { method: 'POST', signal: abort.signal, body: JSON.stringify({ request_id: createUUID(), range: draft.range ?? context.range ?? rangeFor(lookback), interval_ms: 60000, source: 'assistant-preview', queries: draft.panels[index].queries }) }); } setPreview(result); }
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
  function focusComposer() {
    requestAnimationFrame(() => composerInput.current?.focus({ preventScroll: true, cursor: 'end' }));
  }
  function newConversation({ syncLocation = true, focus = true, draftText = text }: { syncLocation?: boolean; focus?: boolean; draftText?: string } = {}) {
    ++selectionVersion.current;
    sessionRead.current?.abort();
    setOpeningSession(false);
    setSessionReadError(undefined);
    drafts.current.set(selectedSession.current ?? 'new', { text: draftText, attachments });
    selectedSession.current = null;
    setSessionId(null);
    setSessionStatus(undefined);
    setEvents([]);
    setSelectedArtifact(undefined);
    const draft = drafts.current.get('new');
    setText(draft?.text ?? '');
    setAttachments(draft?.attachments ?? []);
    setAttachmentError('');
    setError('');
    setHistoryOpen(false);
    if (syncLocation) setSessionLocation(null);
    if (focus) focusComposer();
  }
  function insertPrompt(prompt: string) {
    const draft = text.trimEnd();
    const next = draft ? `${draft}\n\n${prompt}` : prompt;
    if (next.length > 16000) setError(t('当前草稿已接近字数上限，请缩短后再插入。', 'Shorten the current draft before inserting another prompt.'));
    else setText(next);
    focusComposer();
  }
  async function copyOutput(answer: string, sql = false) {
    try {
      await navigator.clipboard.writeText(answer);
      void message.success(sql ? t('已复制 SQL', 'SQL copied') : t('已复制回答', 'Response copied'));
    } catch {
      void message.error(t('无法访问剪贴板，请选择回答文字手动复制。', 'Clipboard access is unavailable. Select and copy the response text.'));
    }
  }
  function handleCommand(command: ComposerCommand) {
    switch (command) {
      case 'new': newConversation({ draftText: '' }); break;
      case 'history': if (historyInDrawer) setHistoryOpen(true); else setHistoryCollapsed(false); break;
      case 'artifacts': setInspectorTab('artifacts'); setInspectorOpen(true); break;
      case 'stop': void cancel(); break;
    }
  }
  const categoryLabel=(value?:string)=>value?.trim()?value.trim():t("未分类","Uncategorized");
  const baseCategories=useMemo(()=>[
    {key:'monitoring',value:t("监控","Monitoring")},
    {key:'agents-hosts',value:t("Agent 与主机","Agents & hosts")},
    {key:'operations',value:t("运维任务","Operations")},
    {key:'research',value:t("研究","Research")},
  ],[t]);
  const hiddenCategoryStorageKey=user?`lightmoni.assistant.hiddenCategories.${user.id}`:'';
  useEffect(()=>{if(!user)return;try{const hidden=localStorage.getItem(`lightmoni.assistant.hiddenCategories.${user.id}`);const custom=localStorage.getItem(`lightmoni.assistant.customCategories.${user.id}`);setHiddenBaseCategories(hidden?JSON.parse(hidden):[]);setCustomCategories(custom?JSON.parse(custom):[]);}catch{setHiddenBaseCategories([]);setCustomCategories([]);}},[user]);
  const categoryOptions=useMemo(()=>{
    const suggested=baseCategories.filter(item=>!hiddenBaseCategories.includes(item.key)).map(item=>item.value);
    const used=sessions.map(session=>session.category?.trim()||"").filter(Boolean);
    const values=[...new Set([t("未分类","Uncategorized"),...suggested,...customCategories,...used])];
    return values.map(value=>({value:value===t("未分类","Uncategorized")?"":value,label:categoryLabel(value)}));
  },[baseCategories,customCategories,hiddenBaseCategories,sessions,t]);
  const categoryOptionsFor=(value?:string)=>categoryOptions.some(option=>option.value===(value||""))?categoryOptions:[...categoryOptions,{value:value||"",label:categoryLabel(value)}];
  const managedCategories=useMemo(()=>{
    const values=[...new Set([
      ...baseCategories.filter(item=>!hiddenBaseCategories.includes(item.key)).map(item=>item.value),
      ...customCategories,
      ...sessions.map(session=>session.category?.trim()||"").filter(Boolean),
    ])];
    return values.map(value=>({value,count:sessions.filter(session=>(session.category?.trim()||"")===value).length,baseKey:baseCategories.find(item=>item.value===value)?.key}));
  },[baseCategories,customCategories,hiddenBaseCategories,sessions]);

  function requestDeleteCategory(value:string){
    const normalized=value.trim();
    if(!normalized)return;
    setCategoryDelete({value:normalized,count:sessions.filter(session=>(session.category?.trim()||"")===normalized).length,baseKey:baseCategories.find(item=>item.value===normalized)?.key});
  }
  async function deleteCategory(){
    const target=categoryDelete;
    if(!target)return;
    setDeletingCategory(true);
    try {
      const result=await api<{updated_count:number;skipped_count:number;skipped_session_ids:string[]}>(`/assistant/categories/${encodeURIComponent(target.value)}`,{method:'DELETE'});
      setSessions(previous=>previous.map(session=>(session.category?.trim()||"")===target.value&&!result.skipped_session_ids.includes(session.id)?{...session,category:""}:session));
      if(target.baseKey){
        setHiddenBaseCategories(previous=>{
          const next=[...new Set([...previous,target.baseKey!])];
          try{localStorage.setItem(`lightmoni.assistant.hiddenCategories.${user?.id}`,JSON.stringify(next));}catch{}
          return next;
        });
      }
      setCategoryDelete(undefined);
      if(result.skipped_count)void message.warning(t(`分类已部分删除；${result.skipped_count} 个正在响应的对话保持原分类`, `Category partially deleted; ${result.skipped_count} responding conversations kept their category`));
      else void message.success(t('分类已删除','Category deleted'));
    }
    catch(problem){setError(errorText(problem,t));void message.error(errorText(problem,t));}
    finally{setDeletingCategory(false);}
  }
  function updateCustomCategories(update:(values:string[])=>string[]){
    setCustomCategories(previous=>{
      const next=update(previous);
      try{localStorage.setItem(`lightmoni.assistant.customCategories.${user?.id}`,JSON.stringify(next));}catch{}
      return next;
    });
  }
  function requestRenameCategory(value:string){
    const normalized=value.trim();
    if(!normalized)return;
    setCategoryRename({value:normalized,next:normalized,count:sessions.filter(session=>(session.category?.trim()||"")===normalized).length,baseKey:baseCategories.find(item=>item.value===normalized)?.key});
  }
  async function renameCategory(){
    const target=categoryRename;
    if(!target)return;
    const next=target.next.trim();
    if(!next||next===target.value||new TextEncoder().encode(next).length>32)return;
    setRenamingCategory(true);
    try {
      if(target.count>0){
        const result=await api<{updated_count:number;skipped_count:number;skipped_session_ids:string[]}>(`/assistant/categories/${encodeURIComponent(target.value)}`,{method:'PATCH',body:JSON.stringify({category:next})});
        setSessions(previous=>previous.map(session=>(session.category?.trim()||"")===target.value&&!result.skipped_session_ids.includes(session.id)?{...session,category:next}:session));
        if(result.updated_count>0||result.skipped_count===0){
          updateCustomCategories(previous=>[...new Set([...(target.baseKey&&result.skipped_count===0&&target.baseKey?[...previous]:previous.filter(value=>value!==target.value)),next])]);
          if(target.baseKey&&result.skipped_count===0){
            setHiddenBaseCategories(previous=>{
              const nextHidden=[...new Set([...previous,target.baseKey!])];
              try{localStorage.setItem(`lightmoni.assistant.hiddenCategories.${user?.id}`,JSON.stringify(nextHidden));}catch{}
              return nextHidden;
            });
          }
        }
        setCategoryRename(undefined);
        if(result.skipped_count)void message.warning(t(`分类已部分重命名；${result.skipped_count} 个正在响应的对话保持原分类`, `Category partially renamed; ${result.skipped_count} responding conversations kept their category`));
        else void message.success(t('分类已重命名','Category renamed'));
      } else {
        if(target.baseKey){
          setHiddenBaseCategories(previous=>{
            const nextHidden=[...new Set([...previous,target.baseKey!])];
            try{localStorage.setItem(`lightmoni.assistant.hiddenCategories.${user?.id}`,JSON.stringify(nextHidden));}catch{}
            return nextHidden;
          });
        }
        updateCustomCategories(previous=>[...new Set([...previous.filter(value=>value!==target.value),next])]);
        setCategoryRename(undefined);
        void message.success(t('分类建议已重命名','Category suggestion renamed'));
      }
    }
    catch(problem){setError(errorText(problem,t));void message.error(errorText(problem,t));}
    finally{setRenamingCategory(false);}
  }
  async function updateSessionCategory(id:string,category:string){
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify({category})}); setSessions(previous=>previous.map(session=>session.id===id?{...session,category}:session)); }
    catch(problem){ setError(errorText(problem,t)); void message.error(errorText(problem,t)); }
  }
  async function updateSessionTitle(id:string,title:string){
    const normalized=title.trim();
    if(!normalized)return;
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify({title:normalized})}); setSessions(previous=>previous.map(session=>session.id===id?{...session,title:normalized}:session)); }
    catch(problem){ setError(errorText(problem,t)); void message.error(errorText(problem,t)); }
  }
  async function deleteSession(id:string){
    setDeletingIds(previous=>[...new Set([...previous,id])]);
    try { await api(`/assistant/sessions/${encodeURIComponent(id)}`,{method:"DELETE"}); setSessions(previous=>previous.filter(session=>session.id!==id)); eventCache.current.delete(id); queuedTurns.current.delete(id); if(selectedSession.current===id)newConversation(); drafts.current.delete(id); void message.success(t("对话已删除","Conversation deleted")); }
    catch(problem){ setError(errorText(problem,t)); void message.error(errorText(problem,t)); }
    finally { setDeletingIds(previous=>previous.filter(value=>value!==id)); }
  }
  function historyContent() {
    const needle = search.trim().toLowerCase();
    const visible=sessions.filter(session=>session.title.toLowerCase().includes(needle)||categoryLabel(session.category).toLowerCase().includes(needle));
    const groups=[...new Set(visible.map(session=>session.category?.trim()||""))].sort((a,b)=>Number(!a)-Number(!b)||a.localeCompare(b));
    return <div className="lm-assistant-history">
      <div className="lm-assistant-history-actions">
        <Button icon={<PlusOutlined />} aria-label={t('新对话', 'New conversation')} disabled={creating} onClick={() => newConversation()}>{t('新对话', 'New conversation')}</Button>
        <Popover trigger="click" placement="bottomRight" content={<label className="lm-assistant-category-picker">
          <span>{t('新对话分类', 'New conversation category')}</span>
          <CategoryField className="lm-assistant-category-input" value={newCategory} options={categoryOptions} disabled={creating} onCommit={setNewCategory}
            ariaLabel={t('新对话分类', 'New conversation category')} placeholder={t('选择或输入分类', 'Select or enter a category')} />
        </label>}>
          <Button type="text" icon={<FolderOutlined />} aria-label={t('设置新对话分类', 'Set new conversation category')} title={newCategory || t('设置新对话分类', 'Set new conversation category')} />
        </Popover>
      </div>
      <Input allowClear prefix={<SearchOutlined aria-hidden="true" />} aria-label={t('搜索对话', 'Search conversations')} placeholder={t('搜索对话', 'Search conversations')} value={search} onChange={event=>setSearch(event.target.value)} className="lm-assistant-history-search" />
      <div className="lm-assistant-history-list">
      {groups.map(category=>{
        const items=visible.filter(session=>(session.category?.trim()||"")===category);
        return <section className="lm-assistant-history-group" key={category||"uncategorized"}>
          <header><span>{categoryLabel(category)}</span><small>{items.length}</small></header>
          {items.map(session=>{
            const status=runningIds.includes(session.id)?'running':session.status;
            const deleting=deletingIds.includes(session.id), running=status==='running';
            return <div className={`lm-assistant-session-row ${sessionId===session.id?'active':''}`} key={session.id}>
              <button type="button" className={`lm-assistant-session ${sessionId===session.id?'active':''}`} aria-current={sessionId===session.id?'page':undefined} disabled={creating||deleting} onClick={()=>selectConversation(session.id)}>
                <MessageOutlined aria-hidden="true"/>
                <span className="lm-assistant-session-name">
                  <span className="lm-assistant-session-title" title={session.title}>{session.title}</span>
                  {session.updated_at && <small>{new Date(session.updated_at).toLocaleDateString(language, { month: 'short', day: 'numeric' })}</small>}
                </span>
                {status&&status!=='idle'&&<span className={`lm-assistant-session-status ${status}`} aria-label={status==='running'?t('响应中','Responding'):status==='failed'?t('失败','Failed'):t('待确认','Needs review')}>{status==='running'?<LoadingOutlined spin/>:status==='failed'?t('失败','Failed'):t('待确认','Review')}</span>}
              </button>
              <Popconfirm title={t('删除该对话？', 'Delete this conversation?')} description={t('消息和附件会一起删除。', 'Its messages and attachments will be deleted.')} onConfirm={()=>deleteSession(session.id)} okText={t('删除','Delete')} cancelText={t('取消','Cancel')} okButtonProps={{danger:true}}>
                <Button className="lm-assistant-session-delete" type="text" danger icon={<DeleteOutlined/>} loading={deleting} disabled={deleting||running} aria-label={t("删除对话","Delete conversation")}/>
              </Popconfirm>
            </div>;
          })}
        </section>;
      })}
      {!visible.length && <div className="lm-assistant-history-empty">{needle ? t('没有匹配的对话', 'No matching conversations') : t('还没有对话', 'No conversations yet')}</div>}
      </div>
      <footer className="lm-assistant-history-footer"><CategoryManager categories={managedCategories} onRequestDelete={requestDeleteCategory} onRequestRename={requestRenameCategory}/></footer>
    </div>;
  }

  const scopeControls=<div className="lm-assistant-scope"><div className="lm-assistant-scope-heading"><strong>{t('分析范围与设置','Analysis scope and settings')}</strong>{config?.enabled&&<span>{config.model}</span>}</div>{catalogUnavailable && <Alert type="warning" showIcon title={t('暂时无法读取数据表','Data tables are temporarily unavailable')} action={<Button size="small" onClick={() => setCatalogRefresh(value => value + 1)}>{t('重试','Retry')}</Button>} />}<label>{t('数据表','Data table')}<Select showSearch allowClear placeholder={t('全部数据表','All data tables')} value={context.table} onChange={value => setContext(previous => ({ ...previous, table: value, service: undefined }))} options={tables.map(item => ({ value: item.name, label: item.name }))} /></label><label>{t('服务','Service')}<Select showSearch allowClear placeholder={t('全部服务','All services')} value={context.service} onChange={value => setContext(previous => ({ ...previous, service: value }))} options={(table?.services ?? [...new Set(tables.flatMap(item => item.services))]).map(service => ({ value: service, label: service }))} /></label>{context.range ? <div className="lm-assistant-scope-fixed">{t('当前页面时间范围','Current page time range')}</div> : <label>{t('时间范围','Time range')}<Select value={lookback} options={[{ value: .25, label: t('最近 15 分钟','Last 15 minutes') }, { value: 1, label: t('最近 1 小时','Last hour') }, { value: 6, label: t('最近 6 小时','Last 6 hours') }, { value: 24, label: t('最近 24 小时','Last 24 hours') }]} onChange={setLookback} /></label>}{user?.role === 'admin' && config?.code_tasks_enabled && <label>{t('代码工作区','Code workspace')}<Input aria-label={t('代码工作区','Code workspace')} value={codeWorkspace} onChange={event => setCodeWorkspace(event.target.value)} placeholder="." maxLength={512} /><small>{t('代码任务在隔离副本中运行，审批后应用修改。','Code tasks run in an isolated copy and apply changes after approval.')}</small></label>}{user?.role === 'admin' && <Button type="text" icon={<SettingOutlined/>} onClick={openSettings}>{t('模型连接设置','Model connection settings')}</Button>}</div>;

  const scopeLabel = context.service || context.table || (context.range ? t('页面时间范围', 'Page time range')
    : t(lookback < 1 ? '最近 15 分钟' : `最近 ${lookback} 小时`, lookback < 1 ? 'Last 15 minutes' : `Last ${lookback}h`));
  const historyVisible = historyInDrawer ? historyOpen : !historyCollapsed;
  const workspaceTitle = selectedSessionData?.title || t('新对话', 'New conversation');
  const inspector = inspectorOpen && <WorkbenchInspector
    tab={inspectorTab} onTabChange={setInspectorTab} context={context} session={selectedSessionData}
    categoryLabel={categoryLabel(selectedSessionData?.category)} running={sessionRunning} model={config?.model}
    turns={turns} selectedArtifact={selectedArtifact}
    onSelectArtifact={id => { setSelectedArtifact(id); setInspectorTab('artifacts'); }}
    onOpenDashboard={(value, range) => { openDraft(value, range); if (inspectorInDrawer) setInspectorOpen(false); }}
    onUseSql={onSQL ? sql => {
      onSQL(sql);
      void message.success(t('SQL 已填入查询编辑器', 'SQL moved to the query editor'));
      if (inspectorInDrawer) setInspectorOpen(false);
    } : undefined}
    onCopySql={sql => void copyOutput(sql, true)}
    onNavigate={url => { navigate(url); if (inspectorInDrawer) setInspectorOpen(false); }}
  />;

  return <div className={`lm-assistant ${compact ? 'is-compact' : ''}`}>
    {!historyInDrawer && historyVisible && <aside className="lm-assistant-sidebar" aria-label={t('对话历史', 'Conversation history')}>
      <div className="lm-assistant-sidebar-title">{t('对话历史', 'Conversation history')}</div>
      {historyContent()}
    </aside>}
    <section className={`lm-assistant-main ${isWelcome ? 'is-welcome' : ''}`} aria-label={t('会话工作台', 'Conversation workspace')}>
      <header className="lm-workbench-head">
        <div className="lm-workbench-title">
          <Tooltip title={historyVisible ? t('收起对话历史', 'Hide conversations') : t('打开对话历史', 'Show conversations')}>
            <Button className="lm-workbench-history-toggle" type="text" icon={<HistoryOutlined />} aria-label={t('对话历史', 'Conversation history')}
              aria-expanded={historyVisible} onClick={() => historyInDrawer ? setHistoryOpen(!historyOpen) : setHistoryCollapsed(!historyCollapsed)} />
          </Tooltip>
          <h2 title={workspaceTitle}>{workspaceTitle}</h2>
          {selectedSessionData?.category && <span className="lm-workbench-category" title={selectedSessionData.category}>{selectedSessionData.category}</span>}
          {selectedSessionData && <Popover key={selectedSessionData.id} title={t('编辑对话', 'Edit conversation')} trigger="click" placement="bottomLeft" content={<SessionHeaderEditor
            title={selectedSessionData.title} category={selectedSessionData.category || ''}
            options={categoryOptionsFor(selectedSessionData.category)} disabled={sessionRunning}
            onTitleCommit={title => void updateSessionTitle(selectedSessionData.id, title)}
            onCategoryCommit={category => void updateSessionCategory(selectedSessionData.id, category)}
          />}>
            <Button className="lm-workbench-edit" type="text" icon={<EditOutlined />} aria-label={t('编辑对话', 'Edit conversation')} disabled={sessionRunning} />
          </Popover>}
        </div>
        <div className="lm-workbench-actions">
          {!!config?.enabled && <span className="lm-workbench-model" title={config.model}>{config.model}</span>}
          <Tooltip title={t('上下文与产物', 'Context and artifacts')}>
            <Button className="lm-workbench-inspector-toggle" type="text" icon={<PicRightOutlined />} aria-label={t('上下文与产物', 'Context and artifacts')}
              aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(value => !value)} />
          </Tooltip>
        </div>
      </header>
      {context.page && <div className="lm-assistant-page-context"><span>{t('来自', 'From')}</span>
        <strong>{context.dashboard_title ?? pageTitles[context.page.title] ?? context.page.title}</strong>
        {context.panels && <Tag>{context.panels.length} {t('个面板', 'panels')}</Tag>}
        {context.log_query?.keyword && <Tag>{t('关键词', 'Keyword')} {context.log_query.keyword}</Tag>}
        {!!context.selected_logs?.length && <Tag>{t('已选日志', 'Selected log')}</Tag>}
        {context.query && <Tag>{t('当前 SQL', 'Current SQL')}</Tag>}
        {context.context_truncated && <Tag>{t('上下文已精简', 'Context trimmed')}</Tag>}
      </div>}
      {configError && <Alert className="lm-assistant-banner" type="error" showIcon title={t('模型配置读取失败', 'Could not load model settings')} description={configError}
        action={<Button onClick={() => setConfigRefresh(value => value + 1)}>{t('重试', 'Retry')}</Button>} />}
      {!configLoading && config && !config.enabled && <Alert className="lm-assistant-banner" type="info" showIcon title={t('连接 AI 模型后开始使用', 'Connect an AI model to get started')}
        description={user?.role === 'admin' ? t('从模型管理配置服务、密钥和模型。', 'Open model management to configure the service, credential, and model.') : t('请联系管理员配置并启用 AI 模型。', 'Ask an administrator to configure and enable an AI model.')}
        action={user?.role === 'admin' ? <Button onClick={openSettings}>{t('配置模型', 'Configure model')}</Button> : undefined} />}
      <MessageScroller.Provider key={sessionId ?? 'new'} autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={56}>
        <MessageScroller.Root className="lm-assistant-scroll-root">
          <MessageScroller.Viewport className="lm-assistant-feed" aria-label={t('对话消息', 'Conversation messages')}>
            <MessageScroller.Content className="lm-assistant-thread">
              {sessionReadError ? <Alert type="error" showIcon title={t('无法打开此对话', 'Could not open this conversation')} description={sessionReadError.detail}
                action={<Button onClick={() => void loadSession(sessionReadError.id)}>{t('重试', 'Retry')}</Button>} />
              : openingSession || (requestedSessionId && !sessionId) || creating ? <div className="lm-assistant-loading" role="status"><Spin />{t('正在打开对话', 'Opening conversation')}</div>
              : isWelcome ? <div className="lm-assistant-welcome">
                <span className="lm-assistant-welcome-mark" aria-hidden="true"><ThunderboltOutlined /></span>
                <h3>{t('想排查什么？', 'What would you like to investigate?')}</h3>
              </div>
              : !turns.length && !busy ? <div className="lm-assistant-welcome"><h3>{t('这段对话还没有消息', 'This conversation has no messages yet')}</h3></div>
              : turns.map(turn => <MessageScroller.Item key={turn.id} messageId={turn.id} scrollAnchor>
                <section className="lm-assistant-turn">
                  <div className="lm-assistant-user">
                    <div className="lm-assistant-user-content">
                      <p>{turn.text}</p>
                      {!!turn.attachments.length && <div className="lm-assistant-sent-attachments">{turn.attachments.map((attachment, index) =>
                        <span className="lm-assistant-attachment" key={`${index}-${attachment.name}`}>
                          {attachment.kind === 'pdf' ? <FilePdfOutlined aria-hidden="true" /> : <PictureOutlined aria-hidden="true" />}
                          <span>{attachment.name}</span>{attachment.pages && <small>{attachment.pages} {t('页', 'pages')}</small>}
                        </span>
                      )}</div>}
                    </div>
                    <Tooltip title={t('复用提问', 'Reuse prompt')}><Button className="lm-assistant-reuse-prompt" type="text" icon={<EditOutlined />}
                      aria-label={t('复用提问', 'Reuse prompt')} disabled={!config?.enabled || openingSession} onClick={() => insertPrompt(turn.text)} /></Tooltip>
                  </div>
                  <div className="lm-assistant-reply">
                    <span className="lm-assistant-role assistant" aria-hidden="true"><ThunderboltOutlined /></span>
                    <div className="lm-assistant-reply-body">
                      {turn.compacting && turn.status === 'running' && <div className="lm-assistant-run-meta" role="status">{t('正在整理较早的对话…', 'Summarizing earlier conversation…')}</div>}
                      {turn.compacted && <div className="lm-assistant-run-meta">{turn.degraded ? t('历史整理已降级，原始记录仍保留', 'History summary degraded; original records are retained') : t('较早的对话已整理，原始记录仍保留', 'Earlier conversation summarized; original records are retained')}</div>}
                      <ToolActivity turn={turn} onDraft={openDraft} canUseCodeTasks={user?.role === 'admin'} canApproveAgentUpdate={user?.role === 'admin'} />
                      {turn.answer && <Answer text={turn.answer} streaming={turn.status === 'running' && busy} onSQL={onSQL} />}
                      {turn.error && <Alert type={turn.status === 'cancelled' ? 'info' : 'error'} title={turn.error} showIcon />}
                      {turn.status !== 'running' && (turn.answer || turn.usage || turn.compactionUsage) && <div className="lm-assistant-reply-actions">
                        {turn.answer && <Tooltip title={t('复制回答', 'Copy response')}>
                          <Button type="text" icon={<CopyOutlined />} aria-label={t('复制回答', 'Copy response')} onClick={() => void copyOutput(turn.answer)} />
                        </Tooltip>}
                        {(turn.usage || turn.compactionUsage) && <details className="lm-assistant-usage">
                          <summary>{t('模型用量', 'Model usage')}</summary>
                          {turn.usage && <p>{formatUsage(turn.usage, t)}</p>}
                          {turn.compactionUsage && <p>{t('历史整理', 'History summary')} · {formatUsage(turn.compactionUsage, t)}</p>}
                        </details>}
                      </div>}
                    </div>
                  </div>
                </section>
              </MessageScroller.Item>)}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {!isWelcome && <MessageScroller.Button className="lm-assistant-jump-latest" aria-label={t('跳转到最新消息', 'Jump to latest message')}>
            <ArrowDownOutlined aria-hidden="true" /> {t('回到最新', 'Jump to latest')}
          </MessageScroller.Button>}
        </MessageScroller.Root>
      </MessageScroller.Provider>
      <div className="lm-assistant-composer-wrap">
        {sessionRunning && <RunStatus turn={runningTurn} recovering={recoveringNow} stopping={stoppingIds.includes(sessionId ?? '')} onStop={() => void cancel()} />}
        {queue.length > 0 && <div className="lm-assistant-queue" aria-label={t('待发送消息', 'Queued messages')}>
          <div className="lm-assistant-queue-heading">{t(`待发送 · ${queue.length}`, `Queued · ${queue.length}`)}</div>
          {queue.map(item => <div className="lm-assistant-queue-item" key={item.id}>
            <span title={item.text}>{item.text}{item.attachments.length > 0 && <small> · {item.attachments.length} {t('个附件', 'attachments')}</small>}</span>
            <Button size="small" onClick={() => void prioritize(item.id)}>{sessionRunning ? t('打断并发送', 'Interrupt and send') : item.retry ? t('重试发送', 'Retry send') : t('立即发送', 'Send now')}</Button>
            <Button size="small" type="text" icon={<CloseOutlined />} aria-label={t('移除待发消息', 'Remove queued message')} onClick={() => removeQueued(item.id)} />
          </div>)}
        </div>}
        {error && <Alert className="lm-assistant-composer-error" type="error" showIcon closable onClose={() => setError('')} title={error} />}
        <AssistantComposer input={composerInput} text={text} onTextChange={setText} attachments={attachments} attachmentError={attachmentError}
          readingAttachment={readingAttachment} onAddFiles={files => void addFiles(files)}
          onRemoveAttachment={index => setAttachments(previous => previous.filter((_, i) => i !== index))}
          disabled={!config?.enabled || loading} running={sessionRunning} starting={creating}
          onSend={() => void send()} onCommand={handleCommand} scope={scopeControls} scopeLabel={scopeLabel} scopeInDrawer={historyNarrow} />
      </div>
      {isWelcome && config?.enabled && <div className="lm-assistant-ideas" aria-label={t('常用问题', 'Suggested prompts')}>
        {ideas.map(idea => <button type="button" key={idea.title} onClick={() => insertPrompt(idea.text)}>
          <span className="lm-assistant-idea-icon" aria-hidden="true">{idea.icon}</span>
          <span className="lm-assistant-idea-copy"><strong>{idea.title}</strong><small>{idea.detail}</small></span>
          <ArrowRightOutlined className="lm-assistant-idea-arrow" aria-hidden="true" />
        </button>)}
      </div>}
    </section>
    {!inspectorInDrawer && inspector}
    {inspectorInDrawer && <Drawer title={t('上下文与产物', 'Context and artifacts')} className="lm-inspector-drawer" open={inspectorOpen} onClose={() => setInspectorOpen(false)}
      size="min(378px, 100vw)" destroyOnHidden>{inspector}</Drawer>}
    {historyInDrawer && <Drawer title={t('对话历史', 'Conversation history')} className="lm-assistant-history-drawer" open={historyOpen} onClose={() => setHistoryOpen(false)}
      size="min(378px, 100vw)" destroyOnHidden>{historyContent()}</Drawer>}
    <Modal
      open={!!categoryRename}
      title={t("重命名分类","Rename category")}
      onCancel={()=>{if(!renamingCategory)setCategoryRename(undefined);}}
      confirmLoading={renamingCategory}
      okText={t("重命名","Rename")}
      cancelText={t("取消","Cancel")}
      destroyOnHidden
      onOk={()=>void renameCategory()}
      okButtonProps={{disabled:!categoryRename?.next.trim()||categoryRename.next.trim()===categoryRename.value||(new TextEncoder().encode(categoryRename.next.trim())).length>32}}
    >
      {categoryRename&&<div className="lm-assistant-category-rename">
        <p><strong>{categoryRename.value}</strong></p>
        <Input aria-label={t('新分类名','New category name')} value={categoryRename.next} onChange={event=>setCategoryRename({...categoryRename,next:event.target.value})} placeholder={t('输入新分类名','Enter a new category name')} />
        <Alert showIcon type="info" title={categoryRename.count?t(`有 ${categoryRename.count} 个对话将使用新分类`,`${categoryRename.count} conversations will use the new category`):t('该分类当前没有对话','No conversations currently use this category')} description={t('目标分类已存在时会合并。对话、消息和附件都会保留。','Existing target categories are merged. Conversations, messages and attachments are preserved.')} />
      </div>}
    </Modal>
    <Modal
      open={!!categoryDelete}
      title={t("删除分类","Delete category")}
      onCancel={()=>{if(!deletingCategory)setCategoryDelete(undefined);}}
      confirmLoading={deletingCategory}
      okText={t("删除分类","Delete category")}
      cancelText={t("取消","Cancel")}
      okButtonProps={{danger:true}}
      destroyOnHidden
      onOk={()=>void deleteCategory()}
    >
      {categoryDelete&&<div className="lm-assistant-category-delete-confirm">
        <p><strong>{categoryDelete.value}</strong></p>
        {categoryDelete.count?<Alert showIcon type="warning" title={t(`有 ${categoryDelete.count} 个对话将变为未分类`,`${categoryDelete.count} conversations will become uncategorized`)} description={t('对话、消息和附件都会保留。','Conversations, messages and attachments are preserved.')} />:<Alert showIcon type="info" title={t('该分类当前没有对话','No conversations currently use this category')} description={t('确认后会从新对话建议中移除。','It will be removed from new-conversation suggestions after confirmation.')} />}
      </div>}
    </Modal>
    <Modal open={!!draft} title={t("审阅大盘草稿","Review dashboard draft")} width={880} onCancel={() => { if (!draftSaving) { previewController.current?.abort(); setDraft(null); } }} footer={<Space><Button onClick={() => void previewDraft()} loading={previewing} disabled={draftSaving}>{t("运行查询预览","Run query preview")}</Button><Button onClick={() => { previewController.current?.abort(); setDraft(null); }} disabled={draftSaving}>{t("取消","Cancel")}</Button><Button type="primary" onClick={() => void saveDraft()} loading={draftSaving} disabled={previewing || !draft?.title.trim()}>{t("确认保存大盘","Save dashboard")}</Button></Space>} destroyOnHidden>{draft && <div className="lm-assistant-draft"><Alert type="info" title={t("检查查询和面板配置，确认后保存","Review queries and panel settings, then confirm to save")} showIcon />{draft.range && <p className="lm-assistant-draft-range">{t("分析时间（UTC）：","Analysis time (UTC): ")}{draft.range.from} → {draft.range.to}</p>}<label>{t("大盘名称","Dashboard name")}<Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>{draft.panels.map((panel, index) => <div className="lm-assistant-draft-panel" key={panel.id ?? index}><div className="lm-assistant-draft-panel-title"><Input value={panel.title} onChange={event => updatePanel(index, { title: event.target.value })} /><Select value={panel.type} options={['timeseries', 'bar', 'pie', 'stat', 'table', 'heatmap', 'gauge'].map(type => ({ value: type, label: type }))} onChange={type => updatePanel(index, { type })} /></div>{panel.queries.map((query, queryIndex) => <div className="lm-assistant-draft-query" key={query.refId}><span>{t("查询","Query")}{query.refId}</span><Input.TextArea value={query.sql} rows={4} onChange={event => updatePanel(index, { queries: panel.queries.map((item, itemIndex) => itemIndex === queryIndex ? { ...item, sql: event.target.value } : item) })} /></div>)}{preview[index]?.results.map(result => <div key={result.refId}><Space><Tag color={result.status === 'error' ? 'error' : 'success'}>{result.refId} · {result.status}</Tag><small>{result.elapsed_ms} ms</small>{result.truncated && <Tag color="warning">{t("结果已截断","Results truncated")}</Tag>}</Space>{result.error && <Alert type="error" title={result.error} />}{result.frames.map((frame, frameIndex) => <Table key={frameIndex} size="small" scroll={{ x: true }} pagination={{ pageSize: 5, size: 'small' }} columns={frame.columns.map((column, columnIndex) => ({ title: column.name, key: column.name, render: (_: unknown, row: unknown[]) => readable(row[columnIndex]) }))} dataSource={frame.rows} rowKey={(_, rowIndex) => String(rowIndex)} />)}</div>)}</div>)}{draftError && <Alert type="error" title={draftError} showIcon />}</div>}</Modal>
  </div>;
}

export default function AssistantPage() {
 const {language,t}=useI18n();
 return <AssistantPanel />; }
