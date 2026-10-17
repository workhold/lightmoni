import type { ModelDiscoveryInput, ModelDiscoveryResult } from './types';
import { isModelProtocol, modelConnectionError } from './model-protocol.ts';

export interface DiscoveryState {
  status: 'idle' | 'waiting' | 'loading' | 'success' | 'error';
  result?: ModelDiscoveryResult;
  error?: string;
}

export function discoveryInput(values: { base_url?: string; api_key?: string; clear_key?: boolean; protocol?: string }, hasKey: boolean): ModelDiscoveryInput | undefined {
  const base = values.base_url?.trim() ?? '';
  const protocol = values.protocol ?? 'auto';
  if (protocol !== 'auto' && !isModelProtocol(protocol)) return undefined;
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || base.includes('?') || base.includes('#') || base.length > 2048) return undefined;
  } catch { return undefined; }
  return { base_url: base, api_key: values.api_key ?? '', use_saved_key: hasKey && !values.clear_key, protocol };
}

// Query lifecycle is independent of the model field, so discovery never selects
// or overwrites a manually entered model. Generations also guard transports that
// do not honor cancellation.
export class ModelDiscovery {
  private request: (input: ModelDiscoveryInput, signal: AbortSignal) => Promise<ModelDiscoveryResult>;
  private publish: (state: DiscoveryState) => void;
  private debounceMs: number;
  private input?: ModelDiscoveryInput;
  private endpointHintBase?: string;
  private result?: ModelDiscoveryResult;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private generation = 0;

  constructor(request: ModelDiscovery['request'], publish: ModelDiscovery['publish'], debounceMs = 700) {
    this.request = request; this.publish = publish; this.debounceMs = debounceMs;
  }

  setInput(input?: ModelDiscoveryInput) {
    if (JSON.stringify(input) === JSON.stringify(this.input)) return;
    this.cancel(); this.result = undefined; this.endpointHintBase = undefined; this.input = input ? { ...input } : undefined;
    if (!this.input) { this.publish({ status: 'idle' }); return; }
    this.publish({ status: 'waiting' });
    this.timer = setTimeout(() => this.refresh(), this.debounceMs);
  }

  refresh() {
    this.cancel();
    if (!this.input) return;
    this.result = undefined;
    // Retain the original endpoint as evidence for automatic detection when
    // refreshing the same corrected base. Editing the connection clears it.
    const version = this.generation, input = { ...this.input, base_url: this.endpointHintBase ?? this.input.base_url }, abort = new AbortController();
    this.abort = abort; this.publish({ status: 'loading' });
    void this.request(input, abort.signal).then(result => {
      if (version !== this.generation || abort.signal.aborted) return;
      // Accept the discovered base as the same input, preventing a feedback
      // query when the UI displays the canonical address.
      this.input = { ...input, base_url: result.base_url };
      this.endpointHintBase = input.protocol === 'auto' && result.protocol_source === 'endpoint-path' ? input.base_url : undefined;
      this.result = result;
      this.publish({ status: 'success', result });
    }).catch(error => {
      if (version !== this.generation || abort.signal.aborted) return;
      this.publish({ status: 'error', error: modelConnectionError(error) });
    }).finally(() => { if (version === this.generation) this.abort = undefined; });
  }

  currentResult(input?: ModelDiscoveryInput): ModelDiscoveryResult | undefined {
    return input && JSON.stringify(input) === JSON.stringify(this.input) ? this.result : undefined;
  }

  dispose() { this.cancel(); this.input = undefined; this.endpointHintBase = undefined; this.result = undefined; }

  private cancel() {
    this.generation++;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.abort?.abort(); this.abort = undefined;
  }
}
