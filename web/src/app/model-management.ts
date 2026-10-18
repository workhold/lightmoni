export type BillingCurrency = 'CNY' | 'USD';
export type UsageDays = 7 | 30 | 90;

export interface ModelBilling {
  base_url: string;
  protocol: string;
  model: string;
  currency: BillingCurrency;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
}

export interface EstimatedCost {
  currency: string;
  amount: number;
  requests: number;
  partial_requests: number;
}

export interface UsageStats {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_missing: number;
  output_missing: number;
  total_missing: number;
  unpriced_requests: number;
  partial_priced_requests: number;
  succeeded_requests: number;
  failed_requests: number;
  cancelled_requests: number;
  pending_requests: number;
  unknown_status_requests: number;
  estimated_costs: EstimatedCost[];
}

export interface ModelIdentity { base_url: string; protocol?: string; model: string }

export function modelIdentity(value?: ModelIdentity): string {
  return value ? JSON.stringify([value.base_url, value.protocol || 'openai-chat-completions', value.model]) : '';
}

export function billingIsDirty(billing: ModelBilling, values: Partial<Pick<ModelBilling, 'currency' | 'input_price_per_million' | 'output_price_per_million'>>): boolean {
  return values.currency !== billing.currency || priceValue(values.input_price_per_million) !== billing.input_price_per_million || priceValue(values.output_price_per_million) !== billing.output_price_per_million;
}

export function validUsagePage(page: number, rows: number, size = 10): number {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(rows / size)));
}

export function recentDaily<T extends { date: string }>(daily: T[]): T[] {
  return [...daily].sort((a, b) => b.date.localeCompare(a.date));
}

export function calendarDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value ?? '').join('-');
}

export interface ModelUsage {
  days: UsageDays;
  from: string;
  to: string;
  timezone: string;
  totals: UsageStats;
  daily: (UsageStats & { date: string })[];
  models: (UsageStats & { base_url: string; protocol: string; model: string })[];
  sources: (UsageStats & { source: string })[];
}

export interface UsageRecord {
  id: string;
  request_id?: string;
  status?: string;
  failure_reason?: string;
  timestamp: string;
  completed_at?: string;
  source: string;
  phase: string;
  base_url: string;
  protocol: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  currency: string;
  estimated_cost: number | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  input_estimated_cost: number | null;
  output_estimated_cost: number | null;
  cost_status?: string;
}

export interface UsageDetails {
  records: UsageRecord[];
  limit: number;
  has_more: boolean;
  from: string;
  to: string;
  timezone: string;
}

export function priceValue(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : value;
}

export function validPrice(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9);
}

export function billingPayload(billing: ModelBilling, values: Pick<ModelBilling, 'currency'> & {
  input_price_per_million?: number | null;
  output_price_per_million?: number | null;
}): ModelBilling {
  return {
    base_url: billing.base_url,
    protocol: billing.protocol,
    model: billing.model,
    currency: values.currency,
    input_price_per_million: priceValue(values.input_price_per_million),
    output_price_per_million: priceValue(values.output_price_per_million),
  };
}

const integers = new Intl.NumberFormat('zh-CN');
const amounts = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function tokenCount(value: number, missing: number, requests: number): string {
  return requests > 0 && missing >= requests ? '未知' : integers.format(value);
}

export function costAmount(value: number): string {
  if (value > 0 && value < 0.000001) return '< 0.000001';
  return amounts.format(value);
}

export function usageSource(source: string): string {
  return source === 'assistant' ? 'AI 助手（含历史整理）' : source === 'connection-test' ? '连接测试' : source === 'code-task' ? '代码任务（Pi）' : source || '未知来源';
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function timezoneChoices(current: string): { value: string; label: string }[] {
  const supported = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try { zones = supported.supportedValuesOf?.('timeZone') ?? []; } catch { /* Fall back to common IANA zones. */ }
  return [...new Set([current, 'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London', ...zones])]
    .map(value => ({ value, label: value }));
}

export function usageDateRange(from: string, to: string, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${formatter.format(new Date(from))} 至 ${formatter.format(new Date(new Date(to).getTime() - 1))}`;
  } catch { return ''; }
}
