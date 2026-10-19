import {useEffect, useRef, useState} from 'react';
import {BellOutlined, ReloadOutlined} from '@ant-design/icons';
import {Alert, App, Button, Collapse, Modal, Space, Tag} from '../../shared/ui';
import {api} from '../../shared/api';
import {publishAlertChange} from '../../shared/alert-changes';
import type {AlertChangeOperation, AlertChangeProposal, ToolTrace} from './types';

const operationNames: Record<AlertChangeOperation, string> = {
  'rule.update': '修改告警规则', 'rule.silence': '调整规则临时静默',
  'silence.create': '创建静默窗口', 'silence.update': '修改静默窗口', 'silence.end': '提前结束静默',
};
const fieldNames: Record<string, string> = {
  id: 'ID', name: '名称', kind: '规则类型', enabled: '启用', revision: '版本', version: '版本', sql: 'SQL',
  source_table_ids: '来源表', group_ids: '告警组', services: '服务', params: '查询参数', value_field: '值字段', label_fields: '标签字段',
  operator: '比较方式', threshold: '阈值', interval_seconds: '求值间隔（秒）', window_seconds: '窗口（秒）', delay_seconds: '延迟（秒）',
  no_data_policy: '无数据策略', no_data_value: '无数据值', for_seconds: '持续异常（秒）', for_count: '持续异常次数',
  recovery_seconds: '恢复等待（秒）', repeat_seconds: '重复通知间隔（秒）', health_for_seconds: '采集恢复等待（秒）', notify_health: '通知采集恢复',
  severity: '告警级别', evidence_profile: '现场关联', silence_until: '临时静默截止', unit: '单位', panel_condition: '图表条件',
  scope: '静默范围', group_id: '告警组 ID', rule_id: '规则 ID', response_id: '事件 ID', service: '服务', from: '开始时间', until: '结束时间',
  daily_start: '每日开始', daily_end: '每日结束', weekdays: '重复星期（0 为周日）', timezone: '时区', reason: '原因', created_by: '创建人 ID', priorities: '适用级别', ended_at: '实际结束时间',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function proposalFrom(value: unknown): AlertChangeProposal | undefined {
  if (!isObject(value)) return;
  if (typeof value.id !== 'string' || !value.id || typeof value.session_id !== 'string' ||
      typeof value.operation !== 'string' || !Object.hasOwn(operationNames, value.operation) ||
      typeof value.target_id !== 'string' || !['awaiting_approval', 'completed'].includes(String(value.status)) ||
      !Object.hasOwn(value, 'before') || !(value.before === null || isObject(value.before)) ||
      !Object.hasOwn(value, 'after') || !(value.after === null || isObject(value.after)) ||
      typeof value.summary !== 'string' || typeof value.reason !== 'string' ||
      !Array.isArray(value.impact) || !value.impact.every(item => typeof item === 'string') ||
      typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) return;
  return value as unknown as AlertChangeProposal;
}
function failureText(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试'; }
function fieldValue(value: unknown) {
  if (value === undefined) return '（无此字段）';
  if (value === null) return '空';
  if (value === '') return '（空）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function ProposalDetails({proposal}: {proposal: AlertChangeProposal}) {
  const fields = [...new Set([...Object.keys(proposal.before ?? {}), ...Object.keys(proposal.after ?? {})])];
  return <>
    <p className="lm-assistant-alert-summary">{proposal.summary}</p>
    <dl className="lm-assistant-alert-meta">
      <div><dt>操作</dt><dd>{operationNames[proposal.operation]}</dd></div>
      <div><dt>目标 ID</dt><dd><code>{proposal.target_id || '新静默窗口'}</code></dd></div>
      <div><dt>创建时间</dt><dd><time dateTime={proposal.created_at}>{new Date(proposal.created_at).toLocaleString()} · {proposal.created_at}</time></dd></div>
      <div><dt>有效期至</dt><dd><time dateTime={proposal.expires_at}>{new Date(proposal.expires_at).toLocaleString()} · {proposal.expires_at}</time></dd></div>
      {proposal.applied_at && <div><dt>应用时间</dt><dd><time dateTime={proposal.applied_at}>{new Date(proposal.applied_at).toLocaleString()}</time></dd></div>}
      <div><dt>变更原因</dt><dd>{proposal.reason}</dd></div>
    </dl>
    {proposal.impact.length > 0 && <div className="lm-assistant-alert-impact"><strong>影响</strong><ul>{proposal.impact.map((impact, index) => <li key={index}>{impact}</li>)}</ul></div>}
    {proposal.operation !== 'rule.update' && <p className="lm-assistant-code-task-meta">静默期间继续求值，匹配范围内的通知将被抑制；结束静默后按告警策略恢复通知。</p>}
    <div className="lm-assistant-alert-diff" aria-label="告警变更前后对比">
      <div className="lm-assistant-alert-diff-head"><span>字段</span><span>变更前{proposal.before === null ? '（不存在）' : ''}</span><span>变更后{proposal.after === null ? '（不存在）' : ''}</span></div>
      {fields.map(field => {
        const before = proposal.before?.[field], after = proposal.after?.[field];
        return <div className={`lm-assistant-alert-diff-row${JSON.stringify(before) !== JSON.stringify(after) ? ' changed' : ''}`} key={field}>
          <strong>{fieldNames[field] ?? field}<small>{fieldNames[field] ? field : ''}</small></strong>
          <div><span className="lm-assistant-alert-mobile-label">变更前</span><pre>{fieldValue(before)}</pre></div>
          <div><span className="lm-assistant-alert-mobile-label">变更后</span><pre>{fieldValue(after)}</pre></div>
        </div>;
      })}
    </div>
  </>;
}

function AppliedResult({proposal}: {proposal: AlertChangeProposal}) {
  if (proposal.result === undefined) return null;
  const result = isObject(proposal.result) ? proposal.result : undefined;
  const endedAt = proposal.operation === 'silence.end' ? result?.ended_at || result?.until : undefined;
  return <div className="lm-assistant-alert-result">
    {typeof endedAt === 'string' && <p className="lm-assistant-alert-effective">静默结束实际生效时间：<time dateTime={endedAt}>{Number.isFinite(Date.parse(endedAt)) ? new Date(endedAt).toLocaleString() + ' · ' : ''}{endedAt}</time></p>}
    <Collapse size="small" items={[{key:'result',label:'实际生效配置（完整）',children:result ? <dl className="lm-assistant-alert-meta">{Object.entries(result).map(([field,value]) => <div key={field}><dt>{fieldNames[field] ?? field}</dt><dd><pre>{fieldValue(value)}</pre></dd></div>)}</dl> : <pre>{fieldValue(proposal.result)}</pre>}]}/>
  </div>;
}

export default function AlertProposalProgress({tool}: {tool: ToolTrace}) {
  const initial = proposalFrom((tool.result as {proposal?: unknown} | undefined)?.proposal);
  const proposalId = initial?.id;
  const [proposal, setProposal] = useState(initial);
  const [verified, setVerified] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [approval, setApproval] = useState<AlertChangeProposal>();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  // Invalidate approvals and lock submission before React renders a focus,
  // cancellation, or second click from the same event loop turn.
  const applyingRef = useRef(false);
  const verifiedRef = useRef(false);
  const approvalRef = useRef<AlertChangeProposal | undefined>(undefined);
  const mounted = useRef(true);
  const {message} = App.useApp();

  async function refreshProposal(): Promise<AlertChangeProposal | undefined> {
    if (!proposalId || applyingRef.current) return;
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    verifiedRef.current = false; approvalRef.current = undefined;
    setRefreshing(true); setVerified(false); setRefreshError(''); setApproval(undefined);
    try {
      const current = proposalFrom(await api<unknown>(`/assistant/alert-proposals/${encodeURIComponent(proposalId)}`, {signal: abort.signal}));
      if (abort.signal.aborted || !mounted.current) return;
      if (!current || current.id !== proposalId) throw new Error('提案内容不完整，请刷新重试');
      verifiedRef.current = true;
      setProposal(current); setVerified(true); setApplyError(''); setNow(Date.now());
      return current;
    } catch (error) {
      if (!abort.signal.aborted && mounted.current) setRefreshError(failureText(error));
    } finally {
      if (!abort.signal.aborted && mounted.current) setRefreshing(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    verifiedRef.current = false; approvalRef.current = undefined;
    setProposal(initial); setVerified(false); setApproval(undefined); setApplyError('');
    void refreshProposal();
    return () => { mounted.current = false; verifiedRef.current = false; approvalRef.current = undefined; request.current?.abort(); };
  }, [proposalId]);
  useEffect(() => {
    const onFocus = () => { if (!applyingRef.current) void refreshProposal(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [proposalId]);
  useEffect(() => {
    if (!proposal) return;
    const remaining = Date.parse(proposal.expires_at) - Date.now();
    if (remaining > 0 && remaining < 2_147_483_647) {
      const timer = setTimeout(() => setNow(Date.now()), remaining + 1);
      return () => clearTimeout(timer);
    }
  }, [proposal?.expires_at]);

  async function reviewApply() {
    setApplyError('');
    const current = await refreshProposal();
    if (mounted.current && !request.current?.signal.aborted && current?.status === 'awaiting_approval' && Date.parse(current.expires_at) > Date.now()) { approvalRef.current = current; setApproval(current); }
  }
  async function confirmApply() {
    const confirmed = approvalRef.current;
    if (applyingRef.current || !mounted.current || !confirmed || !verifiedRef.current || !verified || refreshing || proposal?.status !== 'awaiting_approval' || Date.parse(confirmed.expires_at) <= Date.now()) return;
    applyingRef.current = true;
    request.current?.abort();
    setApplying(true); setApplyError('');
    try {
      const current = proposalFrom(await api<unknown>(`/assistant/alert-proposals/${encodeURIComponent(confirmed.id)}/apply`, {method: 'POST', body: '{}'}));
      if (!current || current.id !== confirmed.id || current.status !== 'completed') throw new Error('无法确认变更结果，请刷新提案');
      approvalRef.current = undefined;
      publishAlertChange();
      if (mounted.current) { setProposal(current); setVerified(true); setApproval(undefined); void message.success('告警变更已应用'); }
    } catch (error) {
      verifiedRef.current = false; approvalRef.current = undefined;
      if (mounted.current) { setApplyError(failureText(error)); setVerified(false); setApproval(undefined); }
    } finally {
      applyingRef.current = false;
      if (mounted.current) setApplying(false);
    }
  }

  const expired = !!proposal && Date.parse(proposal.expires_at) <= now;
  const status = !verified ? refreshing ? '核验中' : '状态未确认' : proposal?.status === 'completed' ? '已应用' : expired ? '已过期' : '待确认';
  const toolError = !initial && tool.status === 'error' ? (tool.result as {error?: string} | undefined)?.error : undefined;
  return <div className="lm-assistant-alert-proposal">
    <div className="lm-assistant-code-task-header"><Space wrap><BellOutlined/><strong>告警变更提案</strong><Tag color={verified && proposal?.status === 'completed' ? 'success' : 'warning'}>{proposalId ? status : tool.status === 'running' ? '准备中' : '准备失败'}</Tag></Space>{proposalId && <Button size="small" type="text" icon={<ReloadOutlined/>} loading={refreshing} disabled={applying} onClick={() => void refreshProposal()}>刷新提案</Button>}</div>
    {!proposal && <p>{toolError || (tool.status === 'running' ? '正在读取配置并准备变更提案…' : '未收到可核验的提案，请重新准备。')}</p>}
    {refreshError && <Alert type="warning" showIcon title="无法核验当前提案，暂不能确认" description={refreshError}/>}
    {applyError && <Alert type="error" showIcon title="变更尚未确认应用" description={`${applyError}；请刷新提案后核验当前状态。`}/>}
    {proposal && <ProposalDetails proposal={proposal}/>}
    {verified && proposal?.status === 'completed' && <AppliedResult proposal={proposal}/>}
    {verified && proposal?.status === 'awaiting_approval' && expired && <Alert type="warning" showIcon title="提案已过期，请让助手重新准备变更"/>}
    {verified && !refreshError && proposal?.status === 'awaiting_approval' && !expired && <div className="lm-assistant-code-approval"><small>请审阅完整前后配置；确认后将立即修改告警配置。</small><Button type="primary" disabled={applying} loading={refreshing} onClick={() => void reviewApply()}>审阅并确认变更</Button></div>}
    <Modal open={!!approval} title="确认告警变更" width={1000} styles={{body:{maxHeight:'65dvh',overflowY:'auto'}}} okText="确认应用变更" cancelText="取消" confirmLoading={applying} okButtonProps={{disabled: !verified || refreshing || !!refreshError || expired}} cancelButtonProps={{disabled: applying}} mask={{closable: !applying}} closable={!applying} keyboard={!applying} onCancel={() => { if (!applyingRef.current) { approvalRef.current = undefined; setApproval(undefined); } }} onOk={() => void confirmApply()} destroyOnHidden>
      {approval && <div className="lm-assistant-alert-confirm"><Alert type="warning" showIcon title="确认后立即应用以下告警变更"/><ProposalDetails proposal={approval}/></div>}
    </Modal>
  </div>;
}
