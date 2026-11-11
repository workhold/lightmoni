import { setTimeout as delay } from 'node:timers/promises';

export type InstallationPendingReason = 'activation_pending' | 'runtime_heartbeat_pending' | 'privileged_executor_pending';
export type InstallationReadinessCode = InstallationPendingReason | 'installation_confirmation_cancelled' | 'installation_record_changed';

export class InstallationReadinessError extends Error {
  constructor(readonly code: InstallationReadinessCode) {
    super(code);
    this.name = 'InstallationReadinessError';
  }
}

interface ReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  monotonic?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Observe the same installation only. Never replay bootstrap or change credentials here.
export async function waitForInstallationReadiness<T>(
  observe: () => { pending: InstallationPendingReason } | { ready: T },
  signal: AbortSignal,
  options: ReadinessOptions = {},
): Promise<T> {
  const monotonic = options.monotonic ?? (() => performance.now());
  const deadline = monotonic() + Math.max(0, options.timeoutMs ?? 60_000);
  const interval = Math.max(1, options.pollIntervalMs ?? 1_000);
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const cancelled = () => { if (signal.aborted) throw new InstallationReadinessError('installation_confirmation_cancelled'); };
  for (;;) {
    cancelled();
    const state = observe();
    cancelled();
    if ('ready' in state) return state.ready;
    const remaining = deadline - monotonic();
    if (remaining <= 0) throw new InstallationReadinessError(state.pending);
    try { await sleep(Math.min(interval, remaining), signal); }
    catch (error) { cancelled(); throw error; }
  }
}
