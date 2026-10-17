import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Select, Spin, Table, Tabs, Tag } from '../shared/ui';
import { api } from '../shared/api';
import { protocolLabel, isModelProtocol } from '../features/assistant/model-protocol';
import { browserTimezone, calendarDate, costAmount, recentDaily, timezoneChoices, tokenCount, usageDateRange, usageSource, validUsagePage, type ModelUsage, type UsageDays, type UsageDetails, type UsageRecord, type UsageStats } from './model-management';

function Tokens({ value, missing, requests }: { value: number; missing: number; requests: number }) {
  return <div className="lm-model-token-value"><strong>{tokenCount(value, missing, requests)}</strong>{missing > 0 && <small>{missing} 次未报告{missing < requests ? '，显示已知部分' : ''}</small>}</div>;
}

function Costs({ stats }: { stats: UsageStats }) {
  return <div className="lm-model-costs">
    {stats.estimated_costs.map(cost => <span className="lm-model-cost" key={cost.currency}><strong>{cost.currency} {costAmount(cost.amount)}</strong><small>{cost.requests} 次完整计价{(cost.partial_requests ?? 0) > 0 ? ` · ${cost.partial_requests} 次部分计价` : ''}</small></span>)}
    {stats.estimated_costs.length === 0 && <span>{stats.requests === 0 ? '暂无估算费用' : '未计价'}</span>}
    {(stats.partial_priced_requests ?? 0) > 0 && <small className="lm-model-unpriced">{stats.partial_priced_requests} 次仅部分计价，金额未包含未知部分</small>}
    {stats.unpriced_requests > 0 && <small className="lm-model-unpriced">{stats.unpriced_requests} 次完全未计价</small>}
  </div>;
}

const statuses = [
  ['succeeded', '成功', 'success', 'succeeded_requests'],
  ['failed', '失败', 'error', 'failed_requests'],
  ['cancelled', '已取消', 'default', 'cancelled_requests'],
  ['pending', '进行中', 'processing', 'pending_requests'],
  ['', '状态未知', 'default', 'unknown_status_requests'],
] as const;
function Statuses({ stats, compact = false }: { stats: UsageStats; compact?: boolean }) {
  return <div className={compact ? 'lm-model-status-compact' : 'lm-model-usage-statuses'}>{statuses.filter(([, , , key]) => !compact || stats[key] > 0).map(([status, label, color, key]) => <Tag key={status} color={color}>{label} {stats[key] ?? 0}</Tag>)}</div>;
}
function statusTag(status?: string) {
  const [, label, color] = statuses.find(([value]) => value === status) ?? statuses[4];
  return <Tag color={color}>{label}</Tag>;
}
function timestamp(value: string, timezone: string): string {
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)); }
  catch { return '时间未知'; }
}
function knownNumber(value: number | null | undefined, price = false): string {
  return value == null ? '未知' : price ? costAmount(value) : value.toLocaleString('zh-CN');
}
function modelCell(row: { model: string; protocol: string; base_url: string }) {
  return <div className="lm-model-usage-model"><strong>{row.model || '未知模型（历史用量）'}</strong><small>{isModelProtocol(row.protocol) ? protocolLabel(row.protocol) : '未知协议'}</small><small>{row.base_url || '历史服务地址未知'}</small></div>;
}

export default function ModelUsageStats({ revision }: { revision: number }) {
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
      if (!abort.signal.aborted && version === generation.current) setError('无法加载模型用量统计，请稍后重试。已有结果已保留。');
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
      if (!abort.signal.aborted) setDetailsError('无法加载调用明细，请重试。已有明细已保留。');
    }).finally(() => { if (!abort.signal.aborted) setDetailsLoading(false); });
    return () => abort.abort();
  }, [activeTab, usage, detailsRefresh]);

  const metricColumns = [
    { title: '调用次数', key: 'requests', width: 140, render: (_: unknown, row: UsageStats) => <><strong>{row.requests}</strong><Statuses stats={row} compact /></> },
    { title: '输入 Token', key: 'input', width: 145, render: (_: unknown, row: UsageStats) => <Tokens value={row.input_tokens} missing={row.input_missing} requests={row.requests} /> },
    { title: '输出 Token', key: 'output', width: 145, render: (_: unknown, row: UsageStats) => <Tokens value={row.output_tokens} missing={row.output_missing} requests={row.requests} /> },
    { title: '总 Token', key: 'total', width: 145, render: (_: unknown, row: UsageStats) => <Tokens value={row.total_tokens} missing={row.total_missing} requests={row.requests} /> },
    { title: '已知估算费用', key: 'cost', width: 230, render: (_: unknown, row: UsageStats) => <Costs stats={row} /> },
  ];
  const pagination = (key: 'daily' | 'models' | 'details') => ({ current: pages[key], pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, onChange: (page: number) => setPages(current => ({ ...current, [key]: page })) });
  const today = usage ? calendarDate(new Date(), usage.timezone) : '';
  const changedFilters = usage && (usage.days !== days || usage.timezone !== timezone);

  return <section className="lm-surface lm-model-usage" aria-labelledby="model-usage-title">
    <div className="lm-settings-section-head">
      <div><h2 id="model-usage-title">Token 消耗统计</h2><p>记录 AI 助手、历史整理和连接测试的请求状态与已报告用量；多币种分别汇总。</p></div>
      <Button onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新统计</Button>
    </div>
    <div className="lm-model-usage-filters">
      <div><label htmlFor="model-usage-days">统计范围</label><Select id="model-usage-days" value={days} onChange={setDays} options={[{ value: 7, label: '最近 7 天' }, { value: 30, label: '最近 30 天' }, { value: 90, label: '最近 90 天' }]} /></div>
      <div><label htmlFor="model-usage-timezone">统计时区</label><Select id="model-usage-timezone" value={timezone} onChange={setTimezone} showSearch optionFilterProp="label" options={zones} /></div>
    </div>
    {loading && <div className="lm-model-inline-loading" role="status"><Spin size="small" />正在刷新模型用量{usage ? '，已有结果已保留' : ''}…</div>}
    {error && <Alert className="lm-model-section-alert" type="error" showIcon title={error} action={<Button onClick={() => setRefresh(value => value + 1)}>重试统计</Button>} />}
    {usage && <>
      {changedFilters && <Alert className="lm-model-section-alert" type="info" showIcon title={`当前仍显示最近 ${usage.days} 天、${usage.timezone} 的结果，所选范围将在加载成功后更新。`} />}
      <p className="lm-settings-hint lm-model-usage-freshness">{usageDateRange(usage.from, usage.to, usage.timezone)} · {usage.timezone} · 含今天的 {usage.days} 个日历日（今天未结束）<span>最后刷新：{timestamp(refreshedAt, usage.timezone)}</span></p>
      <div className="lm-model-usage-summary">
        <div><span>调用次数</span><strong>{usage.totals.requests.toLocaleString('zh-CN')}</strong></div>
        <div><span>输入 Token</span><Tokens value={usage.totals.input_tokens} missing={usage.totals.input_missing} requests={usage.totals.requests} /></div>
        <div><span>输出 Token</span><Tokens value={usage.totals.output_tokens} missing={usage.totals.output_missing} requests={usage.totals.requests} /></div>
        <div><span>总 Token</span><Tokens value={usage.totals.total_tokens} missing={usage.totals.total_missing} requests={usage.totals.requests} /></div>
      </div>
      <Statuses stats={usage.totals} />
      <div className="lm-model-usage-cost-total"><span>已知部分的估算费用</span><Costs stats={usage.totals} /></div>
      {usage.totals.requests === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选时间范围内暂无用量记录" /> : <Tabs activeKey={activeTab} onChange={setActiveTab} className="lm-model-usage-tables" items={[
        { key: 'daily', label: '按日统计', children: <Table size="small" rowKey="date" dataSource={recentDaily(usage.daily)} pagination={pagination('daily')} scroll={{ x: 950 }} columns={[{ title: '日期（最近优先）', key: 'date', width: 150, render: (_: unknown, row: ModelUsage['daily'][number]) => <>{row.date}{row.date === today && <div><Tag color="processing">今天 · 未结束</Tag></div>}</> }, ...metricColumns]} /> },
        { key: 'models', label: '按模型', children: <Table size="small" rowKey={row => JSON.stringify([row.base_url, row.protocol, row.model])} dataSource={usage.models} pagination={pagination('models')} scroll={{ x: 1050 }} columns={[{ title: '模型 / 服务', key: 'model', width: 245, render: (_: unknown, row: ModelUsage['models'][number]) => modelCell(row) }, ...metricColumns]} /> },
        { key: 'sources', label: '按来源', children: <Table size="small" rowKey="source" dataSource={usage.sources} pagination={false} scroll={{ x: 980 }} columns={[{ title: '调用来源', dataIndex: 'source', key: 'source', width: 175, render: usageSource }, ...metricColumns]} /> },
        { key: 'details', label: '调用明细', children: <>
          <p className="lm-settings-hint">最近 100 次调用，按请求开始时间倒序；单价和分项费用保留调用时的快照，不随当前单价变化。</p>
          {detailsLoading && <div className="lm-model-inline-loading" role="status"><Spin size="small" />正在加载调用明细…</div>}
          {detailsError && <Alert className="lm-model-section-alert" type="error" showIcon title={detailsError} action={<Button onClick={() => setDetailsRefresh(value => value + 1)}>重试明细</Button>} />}
          {details && <>
            <p className="lm-settings-hint">明细范围：{usageDateRange(details.from, details.to, details.timezone)} · {details.timezone}{details.has_more ? ` · 仅展示最近 ${details.limit} 次，范围内还有更早的调用` : ''}</p>
            <Table size="small" rowKey="id" dataSource={details.records} pagination={pagination('details')} scroll={{ x: 1520 }} columns={[
              { title: '请求 / 时间', key: 'request', width: 230, render: (_: unknown, row: UsageRecord) => <div className="lm-model-usage-model"><strong>{row.request_id || '历史请求 ID 未知'}</strong><small>开始：{timestamp(row.timestamp, details.timezone)}</small>{row.completed_at && <small>结束：{timestamp(row.completed_at, details.timezone)}</small>}<small>{usageSource(row.source)}{row.phase === 'compact' ? ' · 历史整理' : ''}</small></div> },
              { title: '模型 / 服务', key: 'model', width: 230, render: (_: unknown, row: UsageRecord) => modelCell(row) },
              { title: '状态', key: 'status', width: 100, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines">{statusTag(row.status)}{row.failure_reason === 'service_interrupted' && <span>服务中断</span>}</div> },
              { title: 'Token', key: 'tokens', width: 150, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><span>输入：{knownNumber(row.input_tokens)}</span><span>输出：{knownNumber(row.output_tokens)}</span><span>总计：{knownNumber(row.total_tokens)}</span></div> },
              { title: '当时单价 / 百万 Token', key: 'prices', width: 230, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><span>输入：{row.input_price_per_million == null ? '未知' : `${row.currency} ${knownNumber(row.input_price_per_million, true)}`}</span><span>输出：{row.output_price_per_million == null ? '未知' : `${row.currency} ${knownNumber(row.output_price_per_million, true)}`}</span></div> },
              { title: '输入 / 输出估算费用', key: 'components', width: 230, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><span>输入：{row.input_estimated_cost == null ? '未计价' : `${row.currency} ${knownNumber(row.input_estimated_cost, true)}`}</span><span>输出：{row.output_estimated_cost == null ? '未计价' : `${row.currency} ${knownNumber(row.output_estimated_cost, true)}`}</span></div> },
              { title: '已知估算费用', key: 'cost', width: 210, render: (_: unknown, row: UsageRecord) => <div className="lm-model-detail-lines"><strong>{row.estimated_cost == null ? '未计价' : `${row.currency} ${costAmount(row.estimated_cost)}`}</strong><Tag color={row.cost_status === 'partial' ? 'warning' : undefined}>{row.cost_status === 'complete' ? '完整计价' : row.cost_status === 'partial' ? '部分计价（另有未知部分）' : row.cost_status === 'legacy' ? '历史费用（单价未知）' : '完全未计价'}</Tag></div> },
            ]} />
          </>}
        </> },
      ]} />}
      <p className="lm-settings-hint">缺失的 Token 与未配置单价不按零计算；失败、取消或进行中的请求仍可能产生用量。仅统计仍可读取的历史和运行时已报告的用量，费用为估算值。</p>
    </>}
  </section>;
}
