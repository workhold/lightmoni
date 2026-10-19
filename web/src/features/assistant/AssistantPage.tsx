import {useI18n} from '../../shared/i18n';
import type {Translator} from '../../shared/i18n';
import {chinese} from '../alerts/translation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {useNavigate} from 'react-router-dom';
import { ArrowUpOutlined, CheckOutlined, CodeOutlined, CopyOutlined, HistoryOutlined, MessageOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import XMarkdown, { type ComponentProps } from '@ant-design/x-markdown';
import '@ant-design/x-markdown/themes/light.css';
import '@ant-design/x-markdown/themes/dark.css';
import {useAppearance} from '../../shared/appearance';
import { App, Alert, Button, Checkbox, Collapse, Drawer, Empty, Input, Modal, Select, Space, Spin, Table, Tag, Tooltip } from '../../shared/ui';
import { api } from '../../shared/api';
import {boundedMonitoringContext} from '../../shared/assistant-context';
import type { CatalogTable, QueryResponse, TimeRange, User } from '../../shared/types';
import { streamTurn } from './client';
import { assistantTimeline, queryRangeFromTurn } from './timeline';
import SSHCheckSummary,{type SSHCheckResult} from '../../shared/SSHCheckSummary';
import AlertProposalProgress from './AlertProposalProgress';
import type { AssistantConfig, AssistantContext, AssistantEvent, AssistantSession, CodeTaskResult, DashboardDraft, DraftPanel, ToolTrace, TurnView } from './types';
import './assistant.css';

export interface AssistantPanelProps {
  compact?: boolean;
  initialContext?: AssistantContext;
  initialPrompt?: string;
  onDashboardDraft?: (draft: DashboardDraft) => Promise<void>;
  onSQL?: (sql: string) => void;
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

function ToolProgress({ turn, onDraft, canUseCodeTasks }: { turn: TurnView; onDraft: (draft: DashboardDraft, range?: TimeRange) => void; canUseCodeTasks: boolean }) {
 const {language,t}=useI18n();
 const navigate=useNavigate();
  const toolLabels: Record<string, string> = { list_managed_machines:t("查询主机","Find managed hosts"),get_managed_machine:t("读取主机信息","Read managed host"),check_managed_machine_ssh:t("SSH 安装检查","SSH installation preflight"),propose_agent_install:t("准备 Agent 部署计划","Prepare Agent deployment plan"),get_agent_installation:t("核验 Agent 部署","Verify Agent deployment"), list_tables: t("读取数据表目录","Read table catalog"), describe_table: t("检查表结构","Inspect table schema"), run_query: t("执行 SQL 查询","Run SQL query"), draft_dashboard: t("生成大盘草稿","Generate dashboard draft"), code_task: t("执行代码任务","Run code task"), list_alert_rules: t("查询告警规则","Find alert rules"), get_alert_rule: t("读取告警规则","Read alert rule"), list_alert_silences: t("查询静默窗口","Find silence windows"), get_alert_silence: t("读取静默窗口","Read silence window"), list_alert_groups: t("查询告警组","Find alert groups"), get_alert_proposal: t("核验告警提案","Verify alert proposal"), propose_alert_change: t("准备告警变更","Prepare alert change") };

  const tools = turn.tools.filter(tool => tool.name !== 'code_task' || canUseCodeTasks);
  if (!tools.length) return null;
  return <div className="lm-assistant-tools">{tools.map(tool => {
    if (tool.name === 'code_task') return <CodeTaskProgress key={tool.callId} tool={tool} />;
    if (tool.name === 'propose_alert_change') return <AlertProposalProgress key={tool.callId} tool={tool} />;
    const result = tool.result as { draft?: DashboardDraft; error?: string;id?:string;machine_id?:string;status?:string } | undefined;
    return <Collapse key={tool.callId} size="small" ghost items={[{ key: tool.callId, label: <Space><span className={`lm-assistant-tool-dot ${tool.status}`} /><span>{toolLabels[tool.name] ?? tool.name}</span><Tag bordered={false} color={tool.status === 'error' ? 'error' : tool.status === 'success' ? 'success' : 'processing'}>{tool.status === 'running' ? t("执行中","Running") : tool.status === 'error' ? t("失败","Failed") : t("完成","Completed")}</Tag></Space>, children: <div><div className="lm-assistant-tool-heading">{t("调用参数","Call arguments")}</div><pre className="lm-assistant-tool-json">{readable(tool.input)}</pre>{tool.result !== undefined && <><div className="lm-assistant-tool-heading">{t("执行结果","Execution result")}</div><pre className="lm-assistant-tool-json">{readable(tool.result)}</pre></>}{tool.status==='success'&&tool.name==='check_managed_machine_ssh'&&result?.id&&<SSHCheckSummary result={tool.result as SSHCheckResult}/>} {tool.status==='success'&&tool.name==='propose_agent_install'&&result?.id&&result.machine_id&&<Button type="primary" onClick={()=>navigate(`/machines?machine=${encodeURIComponent(result.machine_id!)}&deployment=${encodeURIComponent(result.id!)}`)}>{t('审阅部署计划','Review deployment plan')}</Button>}{tool.status === 'success' && result?.draft && <Button type="primary" onClick={() => onDraft(result.draft!, queryRangeFromTurn(turn, tool.callId))}>{t("审阅大盘草稿","Review dashboard draft")}</Button>}</div> }]} />;
  })}</div>;
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
  const [context, setContext] = useState<AssistantContext>(initialContext ?? {});
  const [lookback, setLookback] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState<DashboardDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  const [codeWorkspace, setCodeWorkspace] = useState(initialContext?.code_workspace ?? '.');
  const {message}=App.useApp();
  const [preview, setPreview] = useState<Record<number, QueryResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const turns = useMemo(() => assistantTimeline(events,language), [events,language]);
  const table = tables.find(item => item.name === context.table);

  async function refreshSessions() { const data = await api<{ items: AssistantSession[] }>('/assistant/sessions'); setSessions(data.items); }
  useEffect(() => {
    let alive = true;
    Promise.all([api<AssistantConfig>('/assistant/config'), api<{ items: AssistantSession[] }>('/assistant/sessions'), api<User>('/auth/me'), api<CatalogTable[]>('/catalog/tables')]).then(([model, history, actor, catalog]) => {
      if (!alive) return;
      setConfig(model); setSessions(history.items); setUser(actor); setTables(Array.isArray(catalog) ? catalog : []); setCodeWorkspace(initialContext?.code_workspace ?? model.code_workspace ?? '.');
    }).catch(problem => { if (alive) setError(errorText(problem,t)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.current?.abort(); previewController.current?.abort(); };
  }, []);
  useEffect(()=>{if(error)void message.error(error);},[error,message]);
  useEffect(() => { if (initialPrompt !== undefined) setText(initialPrompt); }, [initialPrompt]);
  useEffect(() => { if (initialContext) { setContext(initialContext); if (initialContext.code_workspace !== undefined) setCodeWorkspace(initialContext.code_workspace); } }, [initialContext]);
  useEffect(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [events]);

  async function loadSession(id: string) {
    setError(''); setLoading(true);
    try { const session = await api<AssistantSession>(`/assistant/sessions/${encodeURIComponent(id)}`); setSessionId(id); setEvents(session.events ?? []); follow.current = true; setHistoryOpen(false); }
    catch (problem) { setError(errorText(problem,t)); } finally { setLoading(false); }
  }

  async function send(value = text) {
    if (busy || !value.trim() || !config?.enabled) return;
    setBusy(true); setError('');  follow.current = true;
    const abort = new AbortController(); controller.current = abort;
    let id = sessionId, accepted = false;
    try {
      if (!id) {
        const session = await api<AssistantSession>('/assistant/sessions', { method: 'POST', body: JSON.stringify({ title: value.trim().slice(0, 60) }), signal: abort.signal });
        id = session.id; setSessionId(id); setEvents([]);
      }
      const frozenContext = boundedMonitoringContext({ ...context, range: context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) });
      delete frozenContext.code_workspace;
      if (user?.role === 'admin' && config.code_tasks_enabled) frozenContext.code_workspace = codeWorkspace.trim() || '.';
      await streamTurn(id, value.trim(), frozenContext, event => {
        if (event.type === 'user.message') { accepted = true; setText(''); }
        setEvents(previous => previous.some(item => item.sequence === event.sequence) ? previous : [...previous, event]);
      }, abort.signal,language);
    } catch (problem) {
      if (!abort.signal.aborted) setError(errorText(problem,t));
      if (!accepted) setText(value);
    } finally {
      controller.current = null; setBusy(false);
      if (id) { try { const session = await api<AssistantSession>(`/assistant/sessions/${encodeURIComponent(id)}`); setEvents(session.events ?? []); } catch { /* Keep already received progress if reconnection fails. */ } }
      void refreshSessions().catch(problem => setError(errorText(problem,t)));
    }
  }

  async function cancel() {
    if (!sessionId) { controller.current?.abort(); return; }
    try { await api(`/assistant/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: '{}' }); }
    catch (problem) { setError(errorText(problem,t)); controller.current?.abort(); }
  }

  function openSettings() { navigate('/admin?tab=models'); }

  function openDraft(value: DashboardDraft, analysisRange?: TimeRange) { const copy = JSON.parse(JSON.stringify(value)) as DashboardDraft; setDraft({ ...copy, range: copy.range ?? analysisRange ?? context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) }); setDraftError(''); setPreview({});  }
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
  function newConversation() { setSessionId(null); setEvents([]); setText(''); setError(''); setHistoryOpen(false); }
  function historyContent() { return <><Button block icon={<PlusOutlined />} disabled={busy} onClick={newConversation}>{t("新对话","New conversation")}</Button><Input allowClear size="small" placeholder={t("搜索对话","Search conversations")} value={search} onChange={event => setSearch(event.target.value)} className="lm-assistant-history-search" />{sessions.filter(session => session.title.toLowerCase().includes(search.toLowerCase())).map(session => <button className={`lm-assistant-session ${sessionId === session.id ? 'active' : ''}`} key={session.id} disabled={busy} onClick={() => void loadSession(session.id)}><MessageOutlined /><span>{session.title}</span></button>)}{!sessions.length && <div className="lm-assistant-history-empty">{t("对话会保存在这里","Conversations are saved here")}</div>}</>; }

  return <div className={`lm-assistant ${compact ? 'is-compact' : ''}`}>
    {!compact && <aside className="lm-assistant-sidebar"><div className="lm-assistant-sidebar-title"><HistoryOutlined /><span>{t("对话历史","Conversation history")}</span></div>{historyContent()}</aside>}
    <main className="lm-assistant-main"><header className="lm-assistant-header"><div><h2>{t("AI 助手","AI assistant")}</h2><p>{t("用自然语言查询、分析与创建大盘","Query, analyze and create dashboards in natural language")}</p></div><Space><Tooltip title={t("对话历史","Conversation history")}><Button className={compact ? undefined : 'lm-assistant-mobile-history'} icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)} aria-label={t("对话历史","Conversation history")} /></Tooltip>{config?.enabled && <Tag bordered={false} color="processing">{config.model}</Tag>}{user?.role === 'admin' && <Tooltip title={t("模型连接设置","Model connection settings")}><Button icon={<SettingOutlined />} onClick={openSettings} aria-label={t("模型连接设置","Model connection settings")} /></Tooltip>}</Space></header>
      {context.page&&<div className="lm-assistant-page-context"><span>{t("当前页面","Current page")}</span><strong>{context.dashboard_title??pageTitles[context.page.title]??context.page.title}</strong>{context.panels&&<Tag>{context.panels.length} {t("个面板"," panels")}</Tag>}{context.log_query?.keyword&&<Tag>{t("关键词：","Keyword: ")}{context.log_query.keyword}</Tag>}{!!context.selected_logs?.length&&<Tag>{t("已选日志","Selected log")}</Tag>}{context.query&&<Tag>{t("当前 SQL","Current SQL")}</Tag>}{context.context_truncated&&<Tag>{t("上下文已精简","Context trimmed")}</Tag>}</div>}
      <div className="lm-assistant-context"><Select showSearch allowClear placeholder={t("全部数据表","All data tables")} value={context.table} onChange={value => setContext(previous => ({ ...previous, table: value, service: undefined }))} options={tables.map(item => ({ value: item.name, label: item.name }))} style={{ minWidth: 190 }} disabled={busy} /><Select showSearch allowClear placeholder={t("全部服务","All services")} value={context.service} onChange={value => setContext(previous => ({ ...previous, service: value }))} options={(table?.services ?? [...new Set(tables.flatMap(item => item.services))]).map(service => ({ value: service, label: service }))} style={{ minWidth: 150 }} disabled={busy} />{context.range ? <Tag>{t("当前页面时间范围","Current page time range")}</Tag> : <Select value={lookback} options={[{ value: .25, label: t("最近 15 分钟","Last 15 minutes") }, { value: 1, label: t("最近 1 小时","Last hour") }, { value: 6, label: t("最近 6 小时","Last 6 hours") }, { value: 24, label: t("最近 24 小时","Last 24 hours") }]} onChange={setLookback} disabled={busy} />}</div>

      {user?.role === 'admin' && config?.code_tasks_enabled && <div className="lm-assistant-code-workspace"><label htmlFor="lm-assistant-code-workspace">{t("代码工作区","Code workspace")}</label><Input id="lm-assistant-code-workspace" aria-label={t("代码工作区","Code workspace")} value={codeWorkspace} onChange={event => setCodeWorkspace(event.target.value)} placeholder="." maxLength={512} disabled={busy} /><small>{t("相对于已配置的工作区根目录；代码任务在隔离副本中运行，审批后应用修改。","Relative to the configured workspace root. Code tasks run in an isolated copy and apply changes after approval.")}</small></div>}
      {!loading && !config?.enabled && <Alert type="info" showIcon title={t("连接 AI 模型后开始使用","Connect an AI model to get started")} description={user?.role === 'admin' ? t("填写模型服务地址和 API Key，自动获取模型并选择调用协议。密钥由后端保管。","Enter a model service URL and API key, fetch available models and choose the API protocol. Keys are stored by the backend.") : t("请联系管理员配置并启用 AI 模型。","Ask an administrator to configure and enable an AI model.")} action={user?.role === 'admin' ? <Button onClick={openSettings}>{t("配置模型","Configure model")}</Button> : undefined} />}
      <div className="lm-assistant-feed" ref={feed} onScroll={() => { const element = feed.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} aria-live="polite">{loading ? <div className="lm-assistant-loading"><Spin /></div> : !turns.length ? <div className="lm-assistant-welcome"><div className="lm-assistant-orb"><ThunderboltOutlined /></div><h3>{t("从一个问题开始","Start with a question")}</h3><p>{t("我会先读取数据结构，再帮助你查询与分析。","I will inspect the data schema before helping you query and analyze it.")}</p><div className="lm-assistant-ideas">{ideas.map(idea => <button key={idea.title} onClick={() => setText(idea.text)}><strong>{idea.title}<span>↗</span></strong><small>{idea.detail}</small></button>)}</div></div> : turns.map(turn => <section key={turn.id} className="lm-assistant-turn"><div className="lm-assistant-user"><span className="lm-assistant-role">{t("你","You")}</span><div>{turn.text}</div></div><div className="lm-assistant-reply"><span className="lm-assistant-role assistant">AI</span><div className="lm-assistant-reply-body">{turn.compacting && turn.status === 'running' && <div className="lm-assistant-run-meta" role="status">{t("正在整理较早的对话…","Summarizing earlier conversation…")}</div>}{turn.compacted && <div className="lm-assistant-run-meta">{t("较早的对话已整理，原始记录仍保留","Earlier conversation summarized; original records are retained")}</div>}<ToolProgress turn={turn} onDraft={openDraft} canUseCodeTasks={user?.role === 'admin'} />{turn.answer && <Answer text={turn.answer} streaming={turn.status === 'running' && busy} onSQL={onSQL} />}{turn.status === 'running' && busy && <div className="lm-assistant-thinking"><span /><span /><span />{t("正在分析","Analyzing")}</div>}{(turn.usage || turn.compactionUsage) && <div className="lm-assistant-run-meta">{turn.usage && <span>{t("模型报告用量：","Reported model usage: ")}{formatUsage(turn.usage,t)}</span>}{turn.compactionUsage && <span>{turn.usage ? ' · ' : ''}{t("历史整理：","History summary: ")}{formatUsage(turn.compactionUsage,t)}</span>}</div>}{turn.error && <Alert type={turn.status === 'cancelled' ? 'info' : 'error'} title={turn.error} showIcon />}</div></div></section>)}</div>
      <div className="lm-assistant-composer"><Input.TextArea aria-label={t("给 AI 助手的问题","Question for the AI assistant")} placeholder={t("询问日志中的异常，或描述你想创建的大盘…","Ask about log anomalies, or describe a dashboard to create…")} value={text} onChange={event => setText(event.target.value)} autoSize={{ minRows: 2, maxRows: 7 }} maxLength={16000} disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="lm-assistant-composer-actions"><small>{t("Enter 发送 · Shift + Enter 换行","Enter to send · Shift + Enter for a new line")}</small>{busy ? <Button danger icon={<StopOutlined />} onClick={() => void cancel()}>{t("停止","Stop")}</Button> : <Button type="primary" aria-label={t("发送","Send")} icon={<ArrowUpOutlined />} disabled={!text.trim() || !config?.enabled || loading} onClick={() => void send()}>{t("发送","Send")}</Button>}</div></div>
    </main>
    <Drawer title={t("对话历史","Conversation history")} open={historyOpen} onClose={() => setHistoryOpen(false)} size="default" destroyOnHidden>{historyContent()}</Drawer>
    <Modal open={!!draft} title={t("审阅大盘草稿","Review dashboard draft")} width={880} onCancel={() => { if (!draftSaving) { previewController.current?.abort(); setDraft(null); } }} footer={<Space><Button onClick={() => void previewDraft()} loading={previewing} disabled={draftSaving}>{t("运行查询预览","Run query preview")}</Button><Button onClick={() => { previewController.current?.abort(); setDraft(null); }} disabled={draftSaving}>{t("取消","Cancel")}</Button><Button type="primary" onClick={() => void saveDraft()} loading={draftSaving} disabled={previewing || !draft?.title.trim()}>{t("确认保存大盘","Save dashboard")}</Button></Space>} destroyOnHidden>{draft && <div className="lm-assistant-draft"><Alert type="info" title={t("检查查询和面板配置，确认后保存","Review queries and panel settings, then confirm to save")} showIcon />{draft.range && <p className="lm-assistant-draft-range">{t("分析时间（UTC）：","Analysis time (UTC): ")}{draft.range.from} → {draft.range.to}</p>}<label>{t("大盘名称","Dashboard name")}<Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>{draft.panels.map((panel, index) => <div className="lm-assistant-draft-panel" key={panel.id ?? index}><div className="lm-assistant-draft-panel-title"><Input value={panel.title} onChange={event => updatePanel(index, { title: event.target.value })} /><Select value={panel.type} options={['timeseries', 'bar', 'pie', 'stat', 'table', 'heatmap', 'gauge'].map(type => ({ value: type, label: type }))} onChange={type => updatePanel(index, { type })} /></div>{panel.queries.map((query, queryIndex) => <div className="lm-assistant-draft-query" key={query.refId}><span>{t("查询","Query")}{query.refId}</span><Input.TextArea value={query.sql} rows={4} onChange={event => updatePanel(index, { queries: panel.queries.map((item, itemIndex) => itemIndex === queryIndex ? { ...item, sql: event.target.value } : item) })} /></div>)}{preview[index]?.results.map(result => <div key={result.refId}><Space><Tag color={result.status === 'error' ? 'error' : 'success'}>{result.refId} · {result.status}</Tag><small>{result.elapsed_ms} ms</small>{result.truncated && <Tag color="warning">{t("结果已截断","Results truncated")}</Tag>}</Space>{result.error && <Alert type="error" title={result.error} />}{result.frames.map((frame, frameIndex) => <Table key={frameIndex} size="small" scroll={{ x: true }} pagination={{ pageSize: 5, size: 'small' }} columns={frame.columns.map((column, columnIndex) => ({ title: column.name, key: column.name, render: (_: unknown, row: unknown[]) => readable(row[columnIndex]) }))} dataSource={frame.rows} rowKey={(_, rowIndex) => String(rowIndex)} />)}</div>)}</div>)}{draftError && <Alert type="error" title={draftError} showIcon />}</div>}</Modal>
  </div>;
}

export default function AssistantPage() {
 const {language,t}=useI18n();
 return <AssistantPanel />; }
