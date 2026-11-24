import type {Translator} from '../../shared/i18n';
import type {QueryResponse} from '../../shared/types';

export interface ToolBadge { kind?: 'error' | 'warn'; text: string }

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Compact, human-readable badges for common tool result shapes; empty when nothing notable. */
export function toolSummary(name: string, result: unknown, t: Translator): ToolBadge[] {
  const error = result && typeof result === 'object' ? (result as {error?: unknown}).error : undefined;
  if (typeof error === 'string' && error.trim()) return [{kind: 'error', text: error.length > 180 ? error.slice(0, 180) + '…' : error}];
  if (name === 'run_query') {
    // The tool receipt wraps the response: {query: QueryResponse, range, ...}.
    const payload = result as {query?: QueryResponse; results?: QueryResponse['results']} | undefined;
    const results = payload?.query?.results ?? payload?.results ?? [];
    if (!Array.isArray(results) || !results.length) return [];
    const rows = results.reduce((total, item) => total + (item.frames ?? []).reduce((sum, frame) => sum + count(frame.rows), 0), 0);
    const elapsed = results.reduce((total, item) => total + (item.elapsed_ms ?? 0), 0);
    const badges: ToolBadge[] = [];
    const failed = results.find(item => item.status === 'error');
    if (failed?.error) {
      const text = String(failed.error);
      badges.push({kind: 'error', text: text.length > 180 ? text.slice(0, 180) + '…' : text});
    }
    if (results.length > 1) badges.push({text: t(`${results.length} 个查询`, `${results.length} queries`)});
    badges.push({text: t(`${rows} 行`, `${rows} rows`)});
    if (elapsed > 0) badges.push({text: t(`${elapsed} ms`, `${elapsed} ms`)});
    if (results.some(item => item.truncated)) badges.push({kind: 'warn', text: t('结果已截断', 'Results truncated')});
    return badges;
  }
  if (name === 'draft_dashboard') {
    const panels = count((result as {draft?: {panels?: unknown}} | undefined)?.draft?.panels);
    return panels ? [{text: t(`${panels} 个面板`, `${panels} panels`)}] : [];
  }
  if (name === 'describe_table') {
    const columns = count((result as {columns?: unknown} | undefined)?.columns);
    return columns ? [{text: t(`${columns} 列`, `${columns} columns`)}] : [];
  }
  if (name.startsWith('list_')) {
    const page = result as Record<string, unknown> | undefined;
    const fields: Record<string, string> = {
      list_tables: 'tables',
      list_tasks: 'tasks',
      list_managed_machines: 'machines',
    };
    const field = fields[name];
    const entries = Array.isArray(result) ? result : page?.[field ?? 'items'];
    if (!Array.isArray(entries)) return [];
    const items = entries.length;
    if (!field && !items && page?.next_offset == null) return [];
    const badges: ToolBadge[] = [{
      text: name === 'list_tables'
        ? t(`${items} 个数据表`, `${items} tables`)
        : t(`${items} 条`, `${items} items`),
    }];
    if (typeof page?.next_offset === 'number' && page.next_offset > 0) {
      badges.push({kind: 'warn', text: t('还有下一页', 'More results available')});
    }
    return badges;
  }
  return [];
}

/** Resolve native review links without navigating outside this workbench. */
export function toolReviewPath(value: unknown, origin: string): string | undefined {
  const result = value as {
    review_url?: unknown;
    proposal?: {review_url?: unknown};
    run?: {review_url?: unknown};
  } | undefined;
  for (const candidate of [result?.review_url, result?.proposal?.review_url, result?.run?.review_url]) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate, origin);
      if (url.origin === origin && /^https?:$/.test(url.protocol) &&
          !url.username && !url.password && /^\/(?!\/)/.test(url.pathname) &&
          (candidate.startsWith('/') || /^https?:\/\//i.test(candidate))) {
        return url.pathname + url.search + url.hash;
      }
    } catch {
      // Ignore malformed receipts and keep the original result available.
    }
  }
}
/** Formatted elapsed time between ISO timestamps; falls back to the ticking clock for running work. */
export function formatElapsed(startedAt: string | undefined, endedAt: string | undefined, nowMs: number): string {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return '';
  const end = endedAt ? Date.parse(endedAt) : Number.isFinite(nowMs) ? nowMs : Number.NaN;
  if (!Number.isFinite(end) || end < start) return '';
  const total = Math.max(0, Math.round((end - start) / 1000));
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
