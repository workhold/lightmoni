export interface HostCapacity {
  cpu_count: number | null;
  memory_total_mb: number | null;
}

/** Optional for old Agents; reject malformed reports before updating heartbeat state. */
export function hostCapacity(value: Record<string, unknown>): HostCapacity {
  const cpu = value.cpu_count, memory = value.memory_total_mb;
  if (cpu != null && (typeof cpu !== 'number' || !Number.isInteger(cpu) || cpu < 1 || cpu > 1048576))
    throw Error('invalid cpu_count');
  if (memory != null && (typeof memory !== 'number' || !Number.isFinite(memory) || memory <= 0 || memory > 1099511627776))
    throw Error('invalid memory_total_mb');
  return {cpu_count: typeof cpu === 'number' ? cpu : null, memory_total_mb: typeof memory === 'number' ? memory : null};
}
