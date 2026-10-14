import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpOutlined, CheckOutlined, CopyOutlined, HistoryOutlined, MessageOutlined, PlusOutlined, SettingOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
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
import type { AssistantConfig, AssistantContext, AssistantEvent, AssistantSession, DashboardDraft, DraftPanel, TurnView } from './types';
import { ModelSettings } from './ModelSettings';
import './assistant.css';

export interface AssistantPanelProps {
  compact?: boolean;
  initialContext?: AssistantContext;
  initialPrompt?: string;
  onDashboardDraft?: (draft: DashboardDraft) => Promise<void>;
  onSQL?: (sql: string) => void;
}

const toolLabels: Record<string, string> = { list_tables: '读取数据表目录', describe_table: '检查表结构', run_query: '执行 SQL 查询', draft_dashboard: '生成大盘草稿' };
const ideas = [
  { title: '创建服务大盘', text: '根据现有数据创建服务监控大盘，包含请求量、错误率和延迟。先检查可用数据表，并生成可审阅的大盘草稿。', detail: '请求量、错误率和延迟' },
  { title: '分析异常日志', text: '分析当前时间范围的日志，找出主要错误、发生趋势和可能的原因。区分数据事实与推测，并给出后续排查 SQL。', detail: '定位问题与下一步排查' },
  { title: '帮我写 SQL', text: '检查现有数据表与字段，生成按服务统计请求量、错误率和延迟的 ClickHouse SQL。说明时间过滤和聚合方式。', detail: '根据真实字段生成查询' },
];

function readable(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }
function formatUsage(usage: NonNullable<TurnView['usage']>): string {
  const counts: string[] = [];
  if (usage.input_tokens !== undefined) counts.push(`输入 ${usage.input_tokens.toLocaleString()}`);
  if (usage.output_tokens !== undefined) counts.push(`输出 ${usage.output_tokens.toLocaleString()}`);
  if (usage.total_tokens !== undefined) counts.push(`合计 ${usage.total_tokens.toLocaleString()}`);
  return counts.join(' · ') + ' tokens';
}
function rangeFor(hours: number): TimeRange { const to = new Date(); return { from: new Date(to.getTime() - hours * 3_600_000).toISOString(), to: to.toISOString() }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试'; }

// Adapted from Doca ai-markdown.tsx (MIT; see NOTICE.md). Raw HTML and
// auto-loading external media remain disabled when rendering telemetry text.
function Answer({ text, streaming, onSQL }: { text: string; streaming?: boolean; onSQL?: (sql: string) => void }) {
  const {dark}=useAppearance();
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const components = {
    code: ({ children, className, lang, block }: ComponentProps) => {
      if (!block) return <code>{children}</code>;
      const code = String(children ?? ''), language = String(lang || className?.replace(/^language-/, '') || 'text').split(/\s/)[0];
      return <div className="lm-assistant-code"><div className="lm-assistant-code-bar"><span>{language}</span><Space size={4}>{onSQL && /sql/i.test(language) && <Button size="small" onClick={() => onSQL(code)}>使用 SQL</Button>}<Button size="small" type="text" icon={copied === code ? <CheckOutlined /> : <CopyOutlined />} onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(code); setCopyError(''); } catch { setCopyError('无法写入剪贴板，请手动复制代码'); } }}>{copied === code ? '已复制' : '复制'}</Button></Space></div><pre>{code}</pre></div>;
    },
    pre: ({ children }: ComponentProps) => <div>{children}</div>,
    img: ({ alt }: ComponentProps) => <span>[{String(alt || '图片')}]</span>,
    input: ({ checked, type }: ComponentProps) => type === 'checkbox' ? <Checkbox checked={!!checked} disabled /> : null,
  };
  return <div className="lm-assistant-answer"><XMarkdown content={text} className={dark?'x-markdown-dark':'x-markdown-light'} config={{ gfm: true }} escapeRawHtml openLinksInNewTab streaming={{ hasNextChunk: !!streaming, enableAnimation: !!streaming && !window.matchMedia('(prefers-reduced-motion: reduce)').matches }} dompurifyConfig={{ USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'video', 'audio', 'source', 'object', 'embed', 'form', 'button', 'link', 'meta'] }} components={components} />{copyError && <small>{copyError}</small>}</div>;
}

function ToolProgress({ turn, onDraft }: { turn: TurnView; onDraft: (draft: DashboardDraft, range?: TimeRange) => void }) {
  if (!turn.tools.length) return null;
  return <div className="lm-assistant-tools"><Collapse size="small" ghost items={turn.tools.map(tool => {
    const result = tool.result as { draft?: DashboardDraft; error?: string } | undefined;
    return { key: tool.callId, label: <Space><span className={`lm-assistant-tool-dot ${tool.status}`} /><span>{toolLabels[tool.name] ?? tool.name}</span><Tag bordered={false} color={tool.status === 'error' ? 'error' : tool.status === 'success' ? 'success' : 'processing'}>{tool.status === 'running' ? '执行中' : tool.status === 'error' ? '失败' : '完成'}</Tag></Space>, children: <div><div className="lm-assistant-tool-heading">调用参数</div><pre className="lm-assistant-tool-json">{readable(tool.input)}</pre>{tool.result !== undefined && <><div className="lm-assistant-tool-heading">执行结果</div><pre className="lm-assistant-tool-json">{readable(tool.result)}</pre></>}{tool.status === 'success' && result?.draft && <Button type="primary" onClick={() => onDraft(result.draft!, queryRangeFromTurn(turn, tool.callId))}>审阅大盘草稿</Button>}</div> };
  })} /></div>;
}

export function AssistantPanel({ compact = false, initialContext, initialPrompt, onDashboardDraft, onSQL }: AssistantPanelProps) {
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<DashboardDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  const {message}=App.useApp();
  const [preview, setPreview] = useState<Record<number, QueryResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const turns = useMemo(() => assistantTimeline(events), [events]);
  const table = tables.find(item => item.name === context.table);

  async function refreshSessions() { const data = await api<{ items: AssistantSession[] }>('/assistant/sessions'); setSessions(data.items); }
  useEffect(() => {
    let alive = true;
    Promise.all([api<AssistantConfig>('/assistant/config'), api<{ items: AssistantSession[] }>('/assistant/sessions'), api<User>('/auth/me'), api<CatalogTable[]>('/catalog/tables')]).then(([model, history, actor, catalog]) => {
      if (!alive) return;
      setConfig(model); setSessions(history.items); setUser(actor); setTables(Array.isArray(catalog) ? catalog : []);
    }).catch(problem => { if (alive) setError(errorText(problem)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.current?.abort(); previewController.current?.abort(); };
  }, []);
  useEffect(()=>{if(error)void message.error(error);},[error,message]);
  useEffect(() => { if (initialPrompt !== undefined) setText(initialPrompt); }, [initialPrompt]);
  useEffect(() => { if (initialContext) setContext(initialContext); }, [initialContext]);
  useEffect(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [events]);

  async function loadSession(id: string) {
    setError(''); setLoading(true);
    try { const session = await api<AssistantSession>(`/assistant/sessions/${encodeURIComponent(id)}`); setSessionId(id); setEvents(session.events ?? []); follow.current = true; setHistoryOpen(false); }
    catch (problem) { setError(errorText(problem)); } finally { setLoading(false); }
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
      await streamTurn(id, value.trim(), frozenContext, event => {
        if (event.type === 'user.message') { accepted = true; setText(''); }
        setEvents(previous => previous.some(item => item.sequence === event.sequence) ? previous : [...previous, event]);
      }, abort.signal);
    } catch (problem) {
      if (!abort.signal.aborted) setError(errorText(problem));
      if (!accepted) setText(value);
    } finally {
      controller.current = null; setBusy(false);
      if (id) { try { const session = await api<AssistantSession>(`/assistant/sessions/${encodeURIComponent(id)}`); setEvents(session.events ?? []); } catch { /* Keep already received progress if reconnection fails. */ } }
      void refreshSessions().catch(problem => setError(errorText(problem)));
    }
  }

  async function cancel() {
    if (!sessionId) { controller.current?.abort(); return; }
    try { await api(`/assistant/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: '{}' }); }
    catch (problem) { setError(errorText(problem)); controller.current?.abort(); }
  }

  function openSettings() { setSettingsOpen(true); }

  function openDraft(value: DashboardDraft, analysisRange?: TimeRange) { const copy = JSON.parse(JSON.stringify(value)) as DashboardDraft; setDraft({ ...copy, range: copy.range ?? analysisRange ?? context.range ?? rangeFor(context.query?.lookback_hours ?? lookback) }); setDraftError(''); setPreview({});  }
  function updatePanel(index: number, update: Partial<DraftPanel>) { setDraft(previous => previous ? { ...previous, panels: previous.panels.map((panel, panelIndex) => panelIndex === index ? { ...panel, ...update } : panel) } : previous); setPreview({}); }
  async function previewDraft() {
    if (!draft) return; setPreviewing(true); setDraftError(''); const abort = new AbortController(); previewController.current = abort;
    try { const result: Record<number, QueryResponse> = {}; for (let index = 0; index < draft.panels.length; index++) { result[index] = await api<QueryResponse>('/query', { method: 'POST', signal: abort.signal, body: JSON.stringify({ request_id: crypto.randomUUID(), range: draft.range ?? context.range ?? rangeFor(lookback), interval_ms: 60000, source: 'assistant-preview', queries: draft.panels[index].queries }) }); } setPreview(result); }
    catch (problem) { if (!abort.signal.aborted) setDraftError(errorText(problem)); } finally { setPreviewing(false); previewController.current = null; }
  }
  async function saveDraft() {
    if (!draft || !draft.title.trim()) return;
    setDraftSaving(true); setDraftError('');
    try {
      if (onDashboardDraft) await onDashboardDraft(draft);
      else await api('/dashboards', { method: 'POST', body: JSON.stringify(draft) });
      setDraft(null); void message.success(`已保存大盘“${draft.title}”`);
    } catch (problem) { setDraftError(errorText(problem)); } finally { setDraftSaving(false); }
  }

  function newConversation() { setSessionId(null); setEvents([]); setText(''); setError(''); setHistoryOpen(false); }
  function historyContent() { return <><Button block icon={<PlusOutlined />} disabled={busy} onClick={newConversation}>新对话</Button><Input allowClear size="small" placeholder="搜索对话" value={search} onChange={event => setSearch(event.target.value)} className="lm-assistant-history-search" />{sessions.filter(session => session.title.toLowerCase().includes(search.toLowerCase())).map(session => <button className={`lm-assistant-session ${sessionId === session.id ? 'active' : ''}`} key={session.id} disabled={busy} onClick={() => void loadSession(session.id)}><MessageOutlined /><span>{session.title}</span></button>)}{!sessions.length && <div className="lm-assistant-history-empty">对话会保存在这里</div>}</>; }

  return <div className={`lm-assistant ${compact ? 'is-compact' : ''}`}>
    {!compact && <aside className="lm-assistant-sidebar"><div className="lm-assistant-sidebar-title"><HistoryOutlined /><span>对话历史</span></div>{historyContent()}</aside>}
    <main className="lm-assistant-main"><header className="lm-assistant-header"><div><h2>AI 助手</h2><p>用自然语言查询、分析与创建大盘</p></div><Space><Tooltip title="对话历史"><Button className={compact ? undefined : 'lm-assistant-mobile-history'} icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)} aria-label="对话历史" /></Tooltip>{config?.enabled && <Tag bordered={false} color="processing">{config.model}</Tag>}{user?.role === 'admin' && <Tooltip title="模型连接设置"><Button icon={<SettingOutlined />} onClick={openSettings} aria-label="模型连接设置" /></Tooltip>}</Space></header>
      {context.page&&<div className="lm-assistant-page-context"><span>当前页面</span><strong>{context.dashboard_title??context.page.title}</strong>{context.panels&&<Tag>{context.panels.length} 个面板</Tag>}{context.log_query?.keyword&&<Tag>关键词：{context.log_query.keyword}</Tag>}{!!context.selected_logs?.length&&<Tag>已选日志</Tag>}{context.query&&<Tag>当前 SQL</Tag>}{context.context_truncated&&<Tag>上下文已精简</Tag>}</div>}
      <div className="lm-assistant-context"><Select showSearch allowClear placeholder="全部数据表" value={context.table} onChange={value => setContext(previous => ({ ...previous, table: value, service: undefined }))} options={tables.map(item => ({ value: item.name, label: item.name }))} style={{ minWidth: 190 }} disabled={busy} /><Select showSearch allowClear placeholder="全部服务" value={context.service} onChange={value => setContext(previous => ({ ...previous, service: value }))} options={(table?.services ?? [...new Set(tables.flatMap(item => item.services))]).map(service => ({ value: service, label: service }))} style={{ minWidth: 150 }} disabled={busy} />{context.range ? <Tag>当前页面时间范围</Tag> : <Select value={lookback} options={[{ value: .25, label: '最近 15 分钟' }, { value: 1, label: '最近 1 小时' }, { value: 6, label: '最近 6 小时' }, { value: 24, label: '最近 24 小时' }]} onChange={setLookback} disabled={busy} />}</div>

      {!loading && !config?.enabled && <Alert type="info" showIcon title="连接 AI 模型后开始使用" description={user?.role === 'admin' ? '填写模型服务地址和 API Key，自动获取模型并选择调用协议。密钥由后端保管。' : '请联系管理员配置并启用 AI 模型。'} action={user?.role === 'admin' ? <Button onClick={openSettings}>配置模型</Button> : undefined} />}
      <div className="lm-assistant-feed" ref={feed} onScroll={() => { const element = feed.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} aria-live="polite">{loading ? <div className="lm-assistant-loading"><Spin /></div> : !turns.length ? <div className="lm-assistant-welcome"><div className="lm-assistant-orb"><ThunderboltOutlined /></div><h3>从一个问题开始</h3><p>我会先读取数据结构，再帮助你查询与分析。</p><div className="lm-assistant-ideas">{ideas.map(idea => <button key={idea.title} onClick={() => setText(idea.text)}><strong>{idea.title}<span>↗</span></strong><small>{idea.detail}</small></button>)}</div></div> : turns.map(turn => <section key={turn.id} className="lm-assistant-turn"><div className="lm-assistant-user"><span className="lm-assistant-role">你</span><div>{turn.text}</div></div><div className="lm-assistant-reply"><span className="lm-assistant-role assistant">AI</span><div className="lm-assistant-reply-body">{turn.compacting && turn.status === 'running' && <div className="lm-assistant-run-meta" role="status">正在整理较早的对话…</div>}{turn.compacted && <div className="lm-assistant-run-meta">较早的对话已整理，原始记录仍保留</div>}<ToolProgress turn={turn} onDraft={openDraft} />{turn.answer && <Answer text={turn.answer} streaming={turn.status === 'running' && busy} onSQL={onSQL} />}{turn.status === 'running' && busy && <div className="lm-assistant-thinking"><span /><span /><span />正在分析</div>}{(turn.usage || turn.compactionUsage) && <div className="lm-assistant-run-meta">{turn.usage && <span>模型报告用量：{formatUsage(turn.usage)}</span>}{turn.compactionUsage && <span>{turn.usage ? ' · ' : ''}历史整理：{formatUsage(turn.compactionUsage)}</span>}</div>}{turn.error && <Alert type={turn.status === 'cancelled' ? 'info' : 'error'} title={turn.error} showIcon />}</div></div></section>)}</div>
      <div className="lm-assistant-composer"><Input.TextArea aria-label="给 AI 助手的问题" placeholder="询问日志中的异常，或描述你想创建的大盘…" value={text} onChange={event => setText(event.target.value)} autoSize={{ minRows: 2, maxRows: 7 }} maxLength={16000} disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="lm-assistant-composer-actions"><small>Enter 发送 · Shift + Enter 换行</small>{busy ? <Button danger icon={<StopOutlined />} onClick={() => void cancel()}>停止</Button> : <Button type="primary" aria-label="发送" icon={<ArrowUpOutlined />} disabled={!text.trim() || !config?.enabled || loading} onClick={() => void send()}>发送</Button>}</div></div>
    </main>
    <Drawer title="对话历史" open={historyOpen} onClose={() => setHistoryOpen(false)} size="default" destroyOnHidden>{historyContent()}</Drawer>
    <ModelSettings open={settingsOpen} config={config} onClose={() => setSettingsOpen(false)} onSaved={setConfig} />
    <Modal open={!!draft} title="审阅大盘草稿" width={880} onCancel={() => { if (!draftSaving) { previewController.current?.abort(); setDraft(null); } }} footer={<Space><Button onClick={() => void previewDraft()} loading={previewing} disabled={draftSaving}>运行查询预览</Button><Button onClick={() => { previewController.current?.abort(); setDraft(null); }} disabled={draftSaving}>取消</Button><Button type="primary" onClick={() => void saveDraft()} loading={draftSaving} disabled={previewing || !draft?.title.trim()}>确认保存大盘</Button></Space>} destroyOnHidden>{draft && <div className="lm-assistant-draft"><Alert type="info" title="检查查询和面板配置，确认后保存" showIcon />{draft.range && <p className="lm-assistant-draft-range">分析时间（UTC）：{draft.range.from} → {draft.range.to}</p>}<label>大盘名称<Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>{draft.panels.map((panel, index) => <div className="lm-assistant-draft-panel" key={panel.id ?? index}><div className="lm-assistant-draft-panel-title"><Input value={panel.title} onChange={event => updatePanel(index, { title: event.target.value })} /><Select value={panel.type} options={['timeseries', 'bar', 'pie', 'stat', 'table', 'heatmap', 'gauge'].map(type => ({ value: type, label: type }))} onChange={type => updatePanel(index, { type })} /></div>{panel.queries.map((query, queryIndex) => <div className="lm-assistant-draft-query" key={query.refId}><span>查询 {query.refId}</span><Input.TextArea value={query.sql} rows={4} onChange={event => updatePanel(index, { queries: panel.queries.map((item, itemIndex) => itemIndex === queryIndex ? { ...item, sql: event.target.value } : item) })} /></div>)}{preview[index]?.results.map(result => <div key={result.refId}><Space><Tag color={result.status === 'error' ? 'error' : 'success'}>{result.refId} · {result.status}</Tag><small>{result.elapsed_ms} ms</small>{result.truncated && <Tag color="warning">结果已截断</Tag>}</Space>{result.error && <Alert type="error" title={result.error} />}{result.frames.map((frame, frameIndex) => <Table key={frameIndex} size="small" scroll={{ x: true }} pagination={{ pageSize: 5, size: 'small' }} columns={frame.columns.map((column, columnIndex) => ({ title: column.name, key: column.name, render: (_: unknown, row: unknown[]) => readable(row[columnIndex]) }))} dataSource={frame.rows} rowKey={(_, rowIndex) => String(rowIndex)} />)}</div>)}</div>)}{draftError && <Alert type="error" title={draftError} showIcon />}</div>}</Modal>
  </div>;
}

export default function AssistantPage() { return <AssistantPanel />; }
