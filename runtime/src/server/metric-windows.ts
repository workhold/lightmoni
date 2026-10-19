import { fail } from '../shared/http.js';
import { validTable, systemTable } from './auth.js';
import type { DB } from '../shared/sqlite.js';
import type { Dependencies } from '../shared/types.js';
export const METRIC_PERIODS = [10, 30, 60, 300, 600, 1800, 3600];
export const DEFAULT_METRIC_PERIOD = 30;
type WindowPolicy = { seconds: number; effective_at: number };

export function windowHistory(db: DB, table: string): WindowPolicy[] {
  return [
    { seconds: DEFAULT_METRIC_PERIOD, effective_at: 0 },
    ...db.all<WindowPolicy>(
      'SELECT window_seconds seconds,effective_at FROM metric_window_config WHERE logical_name=? ORDER BY effective_at', table,
    ),
  ];
}

export function metricWindows(db: DB, allowed?: (table: string) => boolean) {
  const result: Record<string, WindowPolicy[]> = {};
  for (const { logical_name } of db.all<{ logical_name: string }>('SELECT DISTINCT logical_name FROM metric_window_config')) {
    if (!allowed || allowed(logical_name)) result[logical_name] = windowHistory(db, logical_name);
  }
  return result;
}

export function initializeWindows(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS metric_window_config(logical_name TEXT NOT NULL,effective_at INTEGER NOT NULL,window_seconds INTEGER NOT NULL,PRIMARY KEY(logical_name,effective_at))');
}

export function registerMetricWindows({ router, db, auth, now = () => new Date() }: Dependencies) {
  initializeWindows(db);
  const table = (name: string) => {
    if (!validTable(name) || systemTable(name)) fail(400, 'invalid business metric table');
    return name;
  };
  const response = (name: string) => ({ table: name, default_seconds: DEFAULT_METRIC_PERIOD, periods: METRIC_PERIODS, history: windowHistory(db, name) });
  router.get('/api/v1/metric-windows/:table', c => c.json(response(table(c.params.table))));
  router.put('/api/v1/metric-windows/:table', async c => {
    auth.requireAdmin(c);
    const name = table(c.params.table);
    const value = await c.body<any>();
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'window_seconds')
      || !METRIC_PERIODS.includes(value.window_seconds)) {
      fail(400, 'window_seconds must be 10,30,60,300,600,1800 or 3600');
    }
    const timestamp = Math.floor(now().getTime() / 1000);
    db.transaction(() => {
      const history = windowHistory(db, name);
      const current = history.filter(p => p.effective_at <= timestamp).at(-1)!;
      const pending = history.find(p => p.effective_at > timestamp);
      // Re-saving a pending choice must not keep postponing its activation.
      if (pending?.seconds === value.window_seconds) return;
      db.run('DELETE FROM metric_window_config WHERE logical_name=? AND effective_at>?', name, timestamp);
      if (current.seconds === value.window_seconds) return;
      // All seven choices form a divisibility chain, so max is their LCM.
      const alignment = Math.max(current.seconds, value.window_seconds);
      const effectiveAt = Math.ceil((timestamp + 60) / alignment) * alignment;
      db.run('INSERT INTO metric_window_config VALUES(?,?,?)', name, effectiveAt, value.window_seconds);
    });
    c.json(response(name));
  });
}
