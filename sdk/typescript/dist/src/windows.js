export const metricPeriods = [10, 30, 60, 300, 600, 1800, 3600];
export function copyMetricWindows(input) {
    if (input === undefined)
        return {};
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 200)
        throw Error('invalid metric windows');
    const result = {};
    for (const [table, history] of Object.entries(input)) {
        if (!/^[a-z][a-z0-9_]{0,47}$/.test(table) || !Array.isArray(history) || history.length > 256)
            throw Error('invalid metric window history');
        let previous = -1;
        result[table] = history.map(p => { if (!p || Object.keys(p).some(k => !['seconds', 'effective_at'].includes(k)) || !metricPeriods.includes(p.seconds) || !Number.isSafeInteger(p.effective_at) || p.effective_at < 0 || p.effective_at <= previous || p.effective_at % p.seconds)
            throw Error('invalid metric window policy'); previous = p.effective_at; return { seconds: p.seconds, effective_at: p.effective_at }; });
    }
    return result;
}
export function metricWindow(policies, table, now) { const seconds = Number(now / 1000000000n); let period = 30; for (const p of policies[table] ?? [])
    if (p.effective_at <= seconds)
        period = p.seconds; return { seconds: period, start: BigInt(Math.floor(seconds / period) * period) * 1000000000n }; }
