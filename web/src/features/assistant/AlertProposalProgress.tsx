import {useI18n} from '../../shared/i18n';
import type {Translator} from '../../shared/i18n';
import {chinese} from '../alerts/translation';
import {useEffect, useRef, useState} from 'react';
import {BellOutlined, ReloadOutlined} from '@ant-design/icons';
import {Alert, App, Button, Collapse, Modal, Space, Tag} from '../../shared/ui';
import {api} from '../../shared/api';
import {publishAlertChange} from '../../shared/alert-changes';
import type {AlertChangeOperation, AlertChangeProposal, ToolTrace} from './types';

const operationNames=(t:Translator=chinese): Record<AlertChangeOperation, string>=>({
  'rule.update': t("修改告警规则","Update alert rule"), 'rule.silence': t("调整规则临时静默","Adjust temporary rule silence"),
  'silence.create': t("创建静默窗口","Create silence window"), 'silence.update': t("修改静默窗口","Update silence window"), 'silence.end': t("提前结束静默","End silence early"),
});
const fieldNames=(t:Translator=chinese): Record<string, string>=>({
  id: 'ID', name: t("名称","Name"), kind: t("规则类型","Rule type"), enabled: t("启用","Enable"), revision: t("版本","Revision"), version: t("版本","Revision"), sql: 'SQL',
  source_table_ids: t("来源表","Source tables"), group_ids: t("告警组","Alert group"), services: t("服务","Service"), params: t("查询参数","Query parameters"), value_field: t("值字段","Value field"), label_fields: t("标签字段","Label fields"),
  operator: t("比较方式","Comparison"), threshold: t("阈值","Threshold"), interval_seconds: t("求值间隔（秒）","Evaluation interval (seconds)"), window_seconds: t("窗口（秒）","Window (seconds)"), delay_seconds: t("延迟（秒）","Delay (seconds)"),
  no_data_policy: t("无数据策略","Missing-data policy"), no_data_value: t("无数据值","Missing-data value"), for_seconds: t("持续异常（秒）","Anomaly duration (seconds)"), for_count: t("持续异常次数","Consecutive anomaly count"),
  recovery_seconds: t("恢复等待（秒）","Recovery wait (seconds)"), repeat_seconds: t("重复通知间隔（秒）","Repeat notification interval (seconds)"), health_for_seconds: t("采集恢复等待（秒）","Collection recovery wait (seconds)"), notify_health: t("通知采集恢复","Notify collection recovery"),
  severity: t("告警级别","Alert priority"), evidence_profile: t("现场关联","Evidence links"), silence_until: t("临时静默截止","Temporary silence until"), unit: t("单位","Unit"), panel_condition: t("图表条件","Chart condition"),
  scope: t("静默范围","Silence scope"), group_id: t("告警组 ID","Alert group ID"), rule_id: t("规则 ID","Rule ID"), response_id: t("事件 ID","Incident ID"), service: t("服务","Service"), from: t("开始时间","Start time"), until: t("结束时间","End time"),
  daily_start: t("每日开始","Daily start"), daily_end: t("每日结束","Daily end"), weekdays: t("重复星期（0 为周日）","Weekdays (0 is Sunday)"), timezone: t("时区","Time zone"), reason: t("原因","Reason"), created_by: t("创建人 ID","Created by user ID"), priorities: t("适用级别","Applicable priorities"), ended_at: t("实际结束时间","Actual end time"),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function proposalFrom(value: unknown): AlertChangeProposal | undefined {
  if (!isObject(value)) return;
  if (typeof value.id !== 'string' || !value.id || typeof value.session_id !== 'string' ||
      typeof value.operation !== 'string' || !Object.hasOwn(operationNames(), value.operation) ||
      typeof value.target_id !== 'string' || !['awaiting_approval', 'completed'].includes(String(value.status)) ||
      !Object.hasOwn(value, 'before') || !(value.before === null || isObject(value.before)) ||
      !Object.hasOwn(value, 'after') || !(value.after === null || isObject(value.after)) ||
      typeof value.summary !== 'string' || typeof value.reason !== 'string' ||
      !Array.isArray(value.impact) || !value.impact.every(item => typeof item === 'string') ||
      typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) return;
  return value as unknown as AlertChangeProposal;
}
function failureText(error: unknown,t:Translator=chinese) { return error instanceof Error ? error.message : t("操作失败，请重试","Operation failed. Please retry."); }
function fieldValue(value: unknown,t:Translator=chinese) {
  if (value === undefined) return t("（无此字段）","(field absent)");
  if (value === null) return t("空","Null");
  if (value === '') return t("（空）","(empty)");
  if (typeof value === 'boolean') return value ? t("是","Yes") : t("否","No");
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function ProposalDetails({proposal}: {proposal: AlertChangeProposal}) {
 const {language,t}=useI18n();

  const fieldsLabel=fieldNames(t),operationLabels=operationNames(t);
  const fields = [...new Set([...Object.keys(proposal.before ?? {}), ...Object.keys(proposal.after ?? {})])];
  return <>
    <p className="lm-assistant-alert-summary">{proposal.summary}</p>
    <dl className="lm-assistant-alert-meta">
      <div><dt>{t("操作","Actions")}</dt><dd>{operationLabels[proposal.operation]}</dd></div>
      <div><dt>{t("目标 ID","Target ID")}</dt><dd><code>{proposal.target_id || t("新静默窗口","New silence window")}</code></dd></div>
      <div><dt>{t("创建时间","Created at")}</dt><dd><time dateTime={proposal.created_at}>{new Date(proposal.created_at).toLocaleString()} · {proposal.created_at}</time></dd></div>
      <div><dt>{t("有效期至","Expires at")}</dt><dd><time dateTime={proposal.expires_at}>{new Date(proposal.expires_at).toLocaleString()} · {proposal.expires_at}</time></dd></div>
      {proposal.applied_at && <div><dt>{t("应用时间","Applied at")}</dt><dd><time dateTime={proposal.applied_at}>{new Date(proposal.applied_at).toLocaleString()}</time></dd></div>}
      <div><dt>{t("变更原因","Reason for change")}</dt><dd>{proposal.reason}</dd></div>
    </dl>
    {proposal.impact.length > 0 && <div className="lm-assistant-alert-impact"><strong>{t("影响","Impact")}</strong><ul>{proposal.impact.map((impact, index) => <li key={index}>{impact}</li>)}</ul></div>}
    {proposal.operation !== 'rule.update' && <p className="lm-assistant-code-task-meta">{t("静默期间继续求值，匹配范围内的通知将被抑制；结束静默后按告警策略恢复通知。","Evaluation continues during silence, while matching notifications are suppressed. Notifications resume under the alert policy when silence ends.")}</p>}
    <div className="lm-assistant-alert-diff" aria-label={t("告警变更前后对比","Alert change comparison")}>
      <div className="lm-assistant-alert-diff-head"><span>{t("字段","Field")}</span><span>{t("变更前","Before")}{proposal.before === null ? t("（不存在）"," (does not exist)") : ''}</span><span>{t("变更后","After")}{proposal.after === null ? t("（不存在）"," (does not exist)") : ''}</span></div>
      {fields.map(field => {
        const before = proposal.before?.[field], after = proposal.after?.[field];
        return <div className={`lm-assistant-alert-diff-row${JSON.stringify(before) !== JSON.stringify(after) ? ' changed' : ''}`} key={field}>
          <strong>{fieldsLabel[field] ?? field}<small>{fieldsLabel[field] ? field : ''}</small></strong>
          <div><span className="lm-assistant-alert-mobile-label">{t("变更前","Before")}</span><pre>{fieldValue(before,t)}</pre></div>
          <div><span className="lm-assistant-alert-mobile-label">{t("变更后","After")}</span><pre>{fieldValue(after,t)}</pre></div>
        </div>;
      })}
    </div>
  </>;
}

function AppliedResult({proposal}: {proposal: AlertChangeProposal}) {
 const {language,t}=useI18n();

  const fieldsLabel=fieldNames(t);
  if (proposal.result === undefined) return null;
  const result = isObject(proposal.result) ? proposal.result : undefined;
  const endedAt = proposal.operation === 'silence.end' ? result?.ended_at || result?.until : undefined;
  return <div className="lm-assistant-alert-result">
    {typeof endedAt === 'string' && <p className="lm-assistant-alert-effective">{t("静默结束实际生效时间：","Silence ended at: ")}<time dateTime={endedAt}>{Number.isFinite(Date.parse(endedAt)) ? new Date(endedAt).toLocaleString() + ' · ' : ''}{endedAt}</time></p>}
    <Collapse size="small" items={[{key:'result',label:t("实际生效配置（完整）","Effective configuration (complete)"),children:result ? <dl className="lm-assistant-alert-meta">{Object.entries(result).map(([field,value]) => <div key={field}><dt>{fieldsLabel[field] ?? field}</dt><dd><pre>{fieldValue(value,t)}</pre></dd></div>)}</dl> : <pre>{fieldValue(proposal.result,t)}</pre>}]}/>
  </div>;
}

export default function AlertProposalProgress({tool}: {tool: ToolTrace}) {
 const {language,t}=useI18n();

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
      if (!current || current.id !== proposalId) throw new Error(t("提案内容不完整，请刷新重试","Proposal is incomplete. Refresh and retry."));
      verifiedRef.current = true;
      setProposal(current); setVerified(true); setApplyError(''); setNow(Date.now());
      return current;
    } catch (error) {
      if (!abort.signal.aborted && mounted.current) setRefreshError(failureText(error,t));
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
      if (!current || current.id !== confirmed.id || current.status !== 'completed') throw new Error(t("无法确认变更结果，请刷新提案","Could not verify the change result. Refresh the proposal."));
      approvalRef.current = undefined;
      publishAlertChange();
      if (mounted.current) { setProposal(current); setVerified(true); setApproval(undefined); void message.success(t("告警变更已应用","Alert change applied")); }
    } catch (error) {
      verifiedRef.current = false; approvalRef.current = undefined;
      if (mounted.current) { setApplyError(failureText(error,t)); setVerified(false); setApproval(undefined); }
    } finally {
      applyingRef.current = false;
      if (mounted.current) setApplying(false);
    }
  }

  const expired = !!proposal && Date.parse(proposal.expires_at) <= now;
  const status = !verified ? refreshing ? t("核验中","Verifying") : t("状态未确认","Status unverified") : proposal?.status === 'completed' ? t("已应用","Applied") : expired ? t("已过期","Expired") : t("待确认","Awaiting confirmation");
  const toolError = !initial && tool.status === 'error' ? (tool.result as {error?: string} | undefined)?.error : undefined;
  return <div className="lm-assistant-alert-proposal">
    <div className="lm-assistant-code-task-header"><Space wrap><BellOutlined/><strong>{t("告警变更提案","Alert change proposal")}</strong><Tag color={verified && proposal?.status === 'completed' ? 'success' : 'warning'}>{proposalId ? status : tool.status === 'running' ? t("准备中","Preparing") : t("准备失败","Preparation failed")}</Tag></Space>{proposalId && <Button size="small" type="text" icon={<ReloadOutlined/>} loading={refreshing} disabled={applying} onClick={() => void refreshProposal()}>{t("刷新提案","Refresh proposal")}</Button>}</div>
    {!proposal && <p>{toolError || (tool.status === 'running' ? t("正在读取配置并准备变更提案…","Reading configuration and preparing a change proposal…") : t("未收到可核验的提案，请重新准备。","No verifiable proposal received. Prepare a new one."))}</p>}
    {refreshError && <Alert type="warning" showIcon title={t("无法核验当前提案，暂不能确认","Could not verify the proposal; confirmation is unavailable")} description={refreshError}/>}
    {applyError && <Alert type="error" showIcon title={t("变更尚未确认应用","Change application is not yet verified")} description={t(`${applyError}；请刷新提案后核验当前状态。`,`${applyError}; refresh the proposal to verify the current status.`)}/>}
    {proposal && <ProposalDetails proposal={proposal}/>}
    {verified && proposal?.status === 'completed' && <AppliedResult proposal={proposal}/>}
    {verified && proposal?.status === 'awaiting_approval' && expired && <Alert type="warning" showIcon title={t("提案已过期，请让助手重新准备变更","Proposal expired. Ask the assistant to prepare it again.")}/>}
    {verified && !refreshError && proposal?.status === 'awaiting_approval' && !expired && <div className="lm-assistant-code-approval"><small>{t("请审阅完整前后配置；确认后将立即修改告警配置。","Review the complete before-and-after configuration. Confirmation immediately changes alert settings.")}</small><Button type="primary" disabled={applying} loading={refreshing} onClick={() => void reviewApply()}>{t("审阅并确认变更","Review and confirm change")}</Button></div>}
    <Modal open={!!approval} title={t("确认告警变更","Confirm alert change")} width={1000} styles={{body:{maxHeight:'65dvh',overflowY:'auto'}}} okText={t("确认应用变更","Apply change")} cancelText={t("取消","Cancel")} confirmLoading={applying} okButtonProps={{disabled: !verified || refreshing || !!refreshError || expired}} cancelButtonProps={{disabled: applying}} mask={{closable: !applying}} closable={!applying} keyboard={!applying} onCancel={() => { if (!applyingRef.current) { approvalRef.current = undefined; setApproval(undefined); } }} onOk={() => void confirmApply()} destroyOnHidden>
      {approval && <div className="lm-assistant-alert-confirm"><Alert type="warning" showIcon title={t("确认后立即应用以下告警变更","Confirmation immediately applies the following alert change")}/><ProposalDetails proposal={approval}/></div>}
    </Modal>
  </div>;
}
