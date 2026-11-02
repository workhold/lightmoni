import {useI18n} from '../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Select, Spin, Table, Tabs, Tag } from '../shared/ui';
import { api } from '../shared/api';
import { protocolLabel, isModelProtocol } from '../features/assistant/model-protocol';
import { browserTimezone, calendarDate, costAmount, recentDaily, timezoneChoices, tokenCount, usageDateRange, usageSource, validUsagePage, type ModelUsage, type UsageDays, type UsageDetails, type UsageRecord, type UsageStats } from './model-management';

function Tokens({ value, missing, requests }: { value: number; missing: number; requests: number }) {
 const {t,language:uiLanguage}=useI18n();

  return <div className="lm-model-token-value"><strong>{tokenCount(value, missing, requests,uiLanguage)}</strong>{missing > 0 && <small>{missing}  {t("次未报告","requests unreported")}{missing < requests ? t("，显示已知部分","; showing known usage") : ''}</small>}</div>;
}

function Costs({ stats }: { stats: UsageStats }) {
 const {t,language:uiLanguage}=useI18n();

  return <div className="lm-model-costs">
    {stats.estimated_costs.map(cost => <span className="lm-model-cost" key={cost.currency}><strong>{cost.currency} {costAmount(cost.amount,uiLanguage)}</strong><small>{cost.requests}  {t("次完整计价","fully priced requests")}{(cost.partial_requests ?? 0) > 0 ? t(` · ${cost.partial_requests} 次部分计价`,` · ${cost.partial_requests} partially priced requests`) : ''}</small></span>)}
    {stats.estimated_costs.length === 0 && <span>{stats.requests === 0 ? t("暂无估算费用","No estimated cost yet") : t("未计价","Unpriced")}</span>}
    {(stats.partial_priced_requests ?? 0) > 0 && <small className="lm-model-unpriced">{stats.partial_priced_requests}  {t("次仅部分计价，金额未包含未知部分","partially priced requests; amounts exclude unknown components")}</small>}
    {stats.unpriced_requests > 0 && <small className="lm-model-unpriced">{stats.unpriced_requests}  {t("次完全未计价","fully unpriced requests")}</small>}
  </div>;
}

function Statuses({ stats, compact = false }: { stats: UsageStats; compact?: boolean }) {
 const {t}=useI18n();
const statuses = [
  ['succeeded', t("成功","Succeeded"), 'success', 'succeeded_requests'],
  ['failed', t("失败","Failed"), 'error', 'failed_requests'],
  ['cancelled', t("已取消","Cancelled"), 'default', 'cancelled_requests'],
  ['pending', t("进行中","In progress"), 'processing', 'pending_requests'],
  ['', t("状态未知","Unknown status"), 'default', 'unknown_status_requests'],
] as const;

  return <div className={compact ? 'lm-model-status-compact' : 'lm-model-usage-statuses'}>{statuses.filter(([, , , key]) => !compact || stats[key] > 0).map(([status, label, color, key]) => <Tag key={status} color={color}>{label} {stats[key] ?? 0}</Tag>)}</div>;
}

export default function ModelUsageStats({ revision }: { revision: number }) {
 const {t,language:uiLanguage}=useI18n();
function statusTag(status?: string) {
  const [, label, color] = statuses.find(([value]) => value === status) ?? statuses[4];
  return <Tag color={color}>{label}</Tag>;
}
function timestamp(value: string, timezone: string): string {
  try { return new Intl.DateTimeFormat(uiLanguage, { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)); }
  catch { return t("时间未知","Unknown time"); }
}
function knownNumber(value: number | null | undefined, price = false): string {
  return value == null ? t("未知","Unknown") : price ? costAmount(value,uiLanguage) : value.toLocaleString(uiLanguage);
}
function modelCell(row: { model: string; protocol: string; base_url: string }) {
  return <div className="lm-model-usage-model"><strong>{row.model || t("未知模型（历史用量）","Unknown model (historical usage)")}</strong><small>{isModelProtocol(row.protocol) ? protocolLabel(row.protocol,uiLanguage) : t("未知协议","Unknown protocol")}</small><small>{row.base_url || t("历史服务地址未知","Historical service URL unknown")}</small></div>;
}
const statuses = [
  ['succeeded', t("成功","Succeeded"), 'success', 'succeeded_requests'],
  ['failed', t("失败","Failed"), 'error', 'failed_requests'],
  ['cancelled', t("已取消","Cancelled"), 'default', 'cancelled_requests'],
  ['pending', t("进行中","In progress"), 'processing', 'pending_requests'],
  ['', t("状态未知","Unknown status"), 'default', 'unknown_status_requests'],
] as const;

  const [days, setDays] = useState<UsageDays>(30);
  const [timezone, setTimezone] = useState(browserTimezone);
  const zones = useMemo(() => timezoneChoices(timezone), [timezone]);
  const [usage, setUsage] = useState<ModelUsage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState('');
  const [activeTab, setActiveTab] = useState('daily');
  const [pages, setPages] = useState({ daily: 1, models: 1, details: 1 });
  const [details, setDetails] = useState<UsageDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [detailsRefresh, setDetailsRefresh] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    const abort = new AbortController();
    setLoading(true); setError('');
    const query = new URLSearchParams({ days: String(days), timezone });
    void api<ModelUsage>(`/assistant/usage?${query}`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted && version === generation.current) {
        setUsage(value); setRefreshedAt(new Date().toISOString());
        setPages(current => ({ ...current, daily: validUsagePage(current.daily, value.daily.length), models: validUsagePage(current.models, value.models.length) }));
      }
    }).catch(() => {
      if (!abort.signal.aborted && version === generation.current) setError(t("无法加载模型用量统计，请稍后重试。已有结果已保留。","Unable to load model usage. Try again later. Previous results are retained."));
    }).finally(() => {
      if (!abort.signal.aborted && version === generation.current) setLoading(false);
    });
    return () => { abort.abort(); generation.current++; };
  }, [days, timezone, refresh, revision]);

  // Fetch accounting metadata only when requested, using the range of the
  // displayed report rather than a possibly still-loading filter selection.
  useEffect(() => {
    if (activeTab !== 'details' || !usage) return;
    const abort = new AbortController();
    setDetailsLoading(true); setDetailsError('');
    const query = new URLSearchParams({ days: String(usage.days), timezone: usage.timezone, limit: '100' });
    void api<UsageDetails>(`/assistant/usage/details?${query}`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) {
        setDetails(value); setPages(current => ({ ...current, details: validUsagePage(current.details, value.records.length) }));
      }
    }).catch(() => {
      if (!abort.signal.aborted) setDetailsError(t("无法加载调用明细，请重试。已有明细已保留。","Unable to load request details. Try again. Previous details are retained."));
    }).finally(() => { if (!abort.signal.aborted) setDetailsLoading(false); });
    return () => abort.abort();
  }, [activeTab, usage, detailsRefresh]);

  const metricColumns = [
    { title: t("调用次数","Requests"), key: 'requests', width: 140, render: (_: unknown, row: UsageStats) => <><strong>{row.requests}</strong><Statuses stats={row} compact /></> },
    { title: t("输入 Token","Input tokens"), key: 'input', width: 145, render: (_: unknown, row: UsageStats) => <Tokens value={row.input_tokens} missing={row.input_missing} requests={row.requests} /> },
    { title: t("输出 Token","Output tokens"), key: 'output', width: 145, render: (_: unknown, row: UsageStats) => <Tokens value={row.output_tokens} missing={row.output_missing} requests={row.requests} /> },
    { title: t("总 Token","Total tokens"), key: 'total', width: 145, render: (_: unknown, row: UsageStats) => <Tokens value={row.total_tokens} missing={row.total_missing} requests={row.requests} /> },
    { title: t("已知估算费用","Known estimated cost"), key: 'cost', width: 230, render: (_: unknown, row: UsageStats) => <Costs stats={row} /> },
  ];
  const pagination = (key: 'daily' | 'models' | 'details') => ({ current: pages[key], pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, onChange: (page: number) => setPages(current => ({ ...current, [key]: page })) });
  const today = usage ? calendarDate(new Date(), usage.timezone) : '';
  const changedFilters = usage && (usage.days !== days || usage.timezone !== timezone);

  return <section className="lm-surface lm-model-usage" aria-labelledby="model-usage-title">
    <div className="lm-settings-section-head">
      <div><h2 id="model-usage-title">{t("Token 消耗统计","Token usage")}</h2><p>{t("记录 AI 助手、历史整理和连接测试的请求状态与已报告用量；多币种分别汇总。","Request status and reported usage for the AI assistant, history compaction, and connection tests. Currencies are summarized separately.")}</p></div>
      <Button onClick={() => setRefresh(value => value + 1)} disabled={loading}>{t("刷新统计","Refresh statistics")}</Button>
    </div>
    <div className="lm-model-usage-filters">
      <div><label htmlFor="model-usage-days">{t("统计范围","Time range")}</label><Select id="model-usage-days" value={days} onChange={setDays} options={[{ value: 7, label: t("最近 7 天","Last 7 days") }, { value: 30, label: t("最近 30 天","Last 30 days") }, { value: 90, label: t("最近 90 天","Last 90 days") }]} /></div>
      <div><label htmlFor="model-usage-timezone">{t("统计时区","Time zone")}</label><Select id="model-usage-timezone" value={timezone} onChange={setTimezone} showSearch optionFilterProp="label" options={zones} /></div>
    </div>
    {loading && <div className="lm-model-inline-loading" role="status"><Spin size="small" />{t("正在刷新模型用量","Refreshing model usage")}{usage ? t("，已有结果已保留","; previous results are retained") : ''}…</div>}
    {error && <Alert className="lm-model-section-alert" type="error" showIcon title={error} action={<Button onClick={() => setRefresh(value => value + 1)}>{t("重试统计","Retry statistics")}</Button>} />}
    {usage && <>
      {changedFilters && <Alert className="lm-model-section-alert" type="info" showIcon title={t(`当前仍显示最近 ${usage.days} 天、${usage.timezone} 的结果，所选范围将在加载成功后更新。`,`Still showing the last ${usage.days} days in ${usage.timezone}. The selected range updates after loading succeeds.`)} />}
      <p className="lm-settings-hint lm-model-usage-freshness">{usageDateRange(usage.from, usage.to, usage.timezone,uiLanguage)} · {usage.timezone}  {t("· 含今天的","· Including today:")} {usage.days}  {t("个日历日（今天未结束）","calendar days (today is incomplete)")}<span>{t("最后刷新：","Last refreshed: ")}{timestamp(refreshedAt, usage.timezone)}</span></p>
      <div className="lm-model-usage-summary">
        <div><span>{t("调用次数","Requests")}</span><strong>{usage.totals.requests.toLocaleString(uiLanguage)}</strong></div>
        <div><span>{t("输入 Token","Input tokens")}</span><Tokens value={usage.totals.input_tokens} missing={usage.totals.input_missing} requests={usage.totals.requests} /></div>
        <div><span>{t("输出 Token","Output tokens")}</span><Tokens value={usage.totals.output_tokens} missing={usage.totals.output_missing} requests={usage.totals.requests} /></div>
        <div><span>{t("总 Token","Total tokens")}</span><Tokens value={usage.totals.total_tokens} missing={usage.totals.total_missing} requests={usage.totals.requests} /></div>
      </div>
      <Statuses stats={usage.totals} />
      <div className="lm-model-usage-cost-total"><span>{t("已知部分的估算费用","Estimated cost of known usage")}</span><Costs stats={usage.totals} /></div>
      {usage.totals.requests === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("所选时间范围内暂无用量记录","No usage recorded in the selected time range")} /> : <Tabs activeKey={activeTab} onChange={setActiveTab} className="lm-model-usage-tables" items={[
        { key: 'daily', label: t("按日统计","By day"), children: <Table size="small" rowKey="date" dataSource={recentDaily(usage.daily)} pagination={pagination('daily')} scroll={{ x: 950 }} columns={[{ title: t("日期（最近优先）","Date (newest first)"), key: 'date', width: 150, render: (_: unknown, row: ModelUsage['daily'][number]) => <>{row.date}{row.date === today && <div><Tag color="processing">{t("今天 · 未结束","Today · Incomplete")}</Tag></div>}</> }, ...metricColumns]} /> },
        { key: 'models', label: t("按模型","By model"), children: <Table size="small" rowKey={row => JSON.stringify([row.base_url, row.protocol, row.model])} dataSource={usage.models} pagination={pagination('models')} scroll={{ x: 1050 }} columns={[{ title: t("模型 / 服务","Model / service"), key: 'model', width: 245, render: (_: unknown, row: ModelUsage['models'][number]) => modelCell(row) }, ...metricColumns]} /> },
        { key: 'sources', label: t("按来源","By source"), children: <Table size="small" rowKey="source" dataSource={usage.sources} pagination={false} scroll={{ x: 980 }} columns={[{ title: t("调用来源","Request source"), dataIndex: 'source', key: 'source', width: 175, render: (source:string)=>usageSource(source,uiLanguage) }, ...metricColumns]} /> },
        { key: 'details', label: t("调用明细","Request details"), children: <>
          <p className="lm-settings-hint">{t("最近 100 次调用，按请求开始时间倒序；单价和分项费用保留调用时的快照，不随当前单价变化。","The latest 100 requests, ordered by start time. Prices and cost components are snapshots from each request and do not change with current prices.")}</p>
          {detailsLoading && <div className="lm-model-inline-loading" role="status"><Spin size="small" />{t("正在加载调用明细…","Loading request details…")}</div>}
          {detailsError && <Alert className="lm-model-section-alert" type="error" showIcon title={detailsError} action={<Button onClick={() => setDetailsRefresh(value => value + 1)}>{t("重试明细","Retry details")}</Button>} />}
          {details && <>
            <p className="lm-settings-hint">{t("明细范围：","Details range: ")}{usageDateRange(details.from, details.to, details.timezone,uiLanguage)} · {details.timezone}{details.has_more ? t(` · 仅展示最近 ${details.limit} 次，范围内还有更早的调用`,` · Showing only the latest ${details.limit} requests; earlier requests exist in this range`) : ''}</p>
            <Table size="small" rowKey="id" dataSource={details.records} pagination={pagination('details')} scroll={{ x: 1520 }} columns={[
              { title: t("请求 / 时间","Request / time"), key: 'request', width: 230, render: (_: unknown, row: UsageRecord) => <div className="lm-model-usage-model"><strong>{row.request_id || t("历史请求 ID 未知","Historical request ID unknown")}</strong><small>{t("开始：","Started: ")}{timestamp(row.timestamp, details.timezone)}</small>{row.completed_at && <small>{t("结束：","Completed: ")}{timestamp(row.completed_at, details.timezone)}</small>}<small>{usageSource(row.source,uiLanguage)}{row.phase === 'compact' ? t("· 历史整理","· History compaction") : ''}</small></div> },
              { title: t("模型 / 服务","Model / service"), key: 'model', width: 230, render: (_: unknown, row: UsageRecord) => modelCell(row) },
              { title: t("状态","Status"), key: 'status', width: 100, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines">{statusTag(row.status)}{row.failure_reason === 'service_interrupted' && <span>{t("服务中断","Service interrupted")}</span>}</div> },
              { title: 'Token', key: 'tokens', width: 150, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><span>{t("输入：","Input: ")}{knownNumber(row.input_tokens)}</span><span>{t("输出：","Output: ")}{knownNumber(row.output_tokens)}</span><span>{t("总计：","Total: ")}{knownNumber(row.total_tokens)}</span></div> },
              { title: t("当时单价 / 百万 Token","Request prices / million tokens"), key: 'prices', width: 230, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><span>{t("输入：","Input: ")}{row.input_price_per_million == null ? t("未知","Unknown") : `${row.currency} ${knownNumber(row.input_price_per_million, true)}`}</span><span>{t("输出：","Output: ")}{row.output_price_per_million == null ? t("未知","Unknown") : `${row.currency} ${knownNumber(row.output_price_per_million, true)}`}</span></div> },
              { title: t("输入 / 输出估算费用","Estimated input / output cost"), key: 'components', width: 230, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><span>{t("输入：","Input: ")}{row.input_estimated_cost == null ? t("未计价","Unpriced") : `${row.currency} ${knownNumber(row.input_estimated_cost, true)}`}</span><span>{t("输出：","Output: ")}{row.output_estimated_cost == null ? t("未计价","Unpriced") : `${row.currency} ${knownNumber(row.output_estimated_cost, true)}`}</span></div> },
              { title: t("已知估算费用","Known estimated cost"), key: 'cost', width: 210, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><strong>{row.estimated_cost == null ? t("未计价","Unpriced") : `${row.currency} ${costAmount(row.estimated_cost,uiLanguage)}`}</strong><Tag color={row.cost_status === 'partial' ? 'warning' : undefined}>{row.cost_status === 'complete' ? t("完整计价","Fully priced") : row.cost_status === 'partial' ? t("部分计价（另有未知部分）","Partially priced (some components unknown)") : t("完全未计价","Fully unpriced")}</Tag></div> },
            ]} />
          </>}
        </> },
      ]} />}
      <p className="lm-settings-hint">{t("缺失的 Token 与未配置单价不按零计算；失败、取消或进行中的请求仍可能产生用量。仅统计仍可读取的历史和运行时已报告的用量，费用为估算值。","Missing tokens and unknown prices are not treated as zero. Failed, cancelled, and pending requests may still incur usage. Statistics include readable history and reported runtime usage only; costs are estimates.")}</p>
    </>}
  </section>;
}
