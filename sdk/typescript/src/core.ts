export type Attributes = Record<string, string | boolean | number | bigint>;
export type Signal = "metrics" | "logs" | "traces";
export interface FrozenBatch {
  signal: Signal; table: string; service: string; id: string;
  createdAt: string; contentType: "application/json"; payload: Uint8Array;
}
export interface Exporter { deliver(batch: FrozenBatch, signal: AbortSignal): Promise<void> }
export interface TraceContext { traceId: string; spanId: string; flags: number; traceState?: string }
export interface Options {
  service: string; table: string; endpoint?: string; key?: string;
  instanceId?: string; resource?: Attributes; exporter?: Exporter;
  intervalMs?: number; requestTimeoutMs?: number; retryMinMs?: number; retryMaxMs?: number;
  queueBytes?: number; queueBatches?: number; bufferBytes?: number; maxBatchBytes?: number;
  cardinalityLimit?: number; maxInstruments?: number; maxAttributes?: number; maxAttributeBytes?: number;
  contextProvider?: () => TraceContext | undefined;
}
export interface MetricOptions { unit?: string; description?: string; boundaries?: number[] }
export interface Stats {
  pendingBatches: number; pendingBytes: number; bufferBytes: number; deliveredBatches: number;
  retriedBatches: number; droppedRecords: number; rejectedRecords: number;
  invalidRecords: number; overflowRecords: number; lastError?: string;
}
export class DeliveryError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0, readonly rejectedRecords = 0) { super(message); this.name = "DeliveryError"; }
}

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };
type Attribute = { key: string; value: AnyValue };
type RecordValue = Record<string, unknown>;
type Settings = Required<Pick<Options, "intervalMs" | "requestTimeoutMs" | "retryMinMs" | "retryMaxMs" | "queueBytes" | "queueBatches" | "bufferBytes" | "maxBatchBytes" | "cardinalityLimit" | "maxInstruments" | "maxAttributes" | "maxAttributeBytes">>;
type Point = { attributes: Attribute[]; integer: bigint; value: number; count: bigint; buckets: bigint[]; observed: bigint; min: number; max: number };
type Instrument = { table: string; name: string; kind: "counter" | "gauge" | "histogram"; options: MetricOptions; series: Map<string, Point>; start: bigint };
type Queued = { sequence: number; batch: FrozenBatch; records: number };
const encoder = new TextEncoder();
const maxInt64 = (1n << 63n) - 1n;
const maxUint64 = (1n << 64n) - 1n;
function nowNano(): bigint { return BigInt(Date.now()) * 1_000_000n; }
function uuid(): string { return globalThis.crypto.randomUUID(); }
function validTable(table: string): boolean { return /^[a-z][a-z0-9_]{0,47}$/.test(table) && !/^(log|metric|trace)_/.test(table); }
function finite(value: number): boolean { return Number.isFinite(value); }
function validTrace(value: TraceContext | undefined): value is TraceContext { return !!value && /^[0-9a-f]{32}$/.test(value.traceId) && !/^0+$/.test(value.traceId) && /^[0-9a-f]{16}$/.test(value.spanId) && !/^0+$/.test(value.spanId) && Number.isInteger(value.flags) && value.flags >= 0 && value.flags <= 255; }
function nano(value: bigint): string { return value.toString(); }
function otlpValue(value: Attributes[string]): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "bigint") { if (value < -(1n << 63n) || value > maxInt64) throw new Error("attribute integer outside Int64"); return { intValue: value.toString() }; }
  if (!finite(value)) throw new Error("attribute must be finite");
  if (Number.isInteger(value)) { if (!Number.isSafeInteger(value)) throw new Error("unsafe integer attribute; use bigint"); return { intValue: value.toString() }; }
  return { doubleValue: value };
}

class State {
  readonly settings: Settings;
  readonly resource: { attributes: Attribute[] };
  readonly instanceId: string;
  readonly instruments = new Map<string, Instrument>();
  readonly logs = new Map<string, RecordValue[]>();
  readonly spans = new Map<string, RecordValue[]>();
  readonly queue: Queued[] = [];
  readonly stats: Stats = { pendingBatches: 0, pendingBytes: 0, bufferBytes: 0, deliveredBatches: 0, retriedBatches: 0, droppedRecords: 0, rejectedRecords: 0, invalidRecords: 0, overflowRecords: 0 };
  readonly changed = new Set<() => void>();
  readonly exporter: Exporter;
  sequence = 0;
  sourceSequence = 0n;
  failureSequence = 0;
  failure?: Error;
  closing = false;
  stopped = false;
  working = false;
  retryNow?: () => void;
  request?: AbortController;
  interval: ReturnType<typeof setInterval>;
  constructor(readonly options: Options) {
    if (!options.service || encoder.encode(options.service).length > 128 || !validTable(options.table)) throw new Error("valid service and logical table are required");
    this.settings = {
      intervalMs: options.intervalMs ?? 10_000, requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      retryMinMs: options.retryMinMs ?? 200, retryMaxMs: options.retryMaxMs ?? 30_000,
      queueBytes: options.queueBytes ?? 8 * 1024 * 1024, queueBatches: options.queueBatches ?? 256,
      bufferBytes: options.bufferBytes ?? 8 * 1024 * 1024, maxBatchBytes: options.maxBatchBytes ?? 1024 * 1024,
      cardinalityLimit: options.cardinalityLimit ?? 2000, maxInstruments: options.maxInstruments ?? 256,
      maxAttributes: options.maxAttributes ?? 32, maxAttributeBytes: options.maxAttributeBytes ?? 4096,
    };
    for (const value of Object.values(this.settings)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("SDK limits and timeouts must be positive integers");
    if (this.settings.retryMaxMs < this.settings.retryMinMs || this.settings.maxBatchBytes > this.settings.queueBytes) throw new Error("invalid retry/batch limits");
    this.instanceId = options.instanceId ?? uuid();
    const resource = this.attributes(options.resource ?? {});
    if (resource.some(a => a.key === "service.name" || a.key === "service.instance.id")) throw new Error("configure service identity separately");
    this.resource = { attributes: [...resource, { key: "service.name", value: { stringValue: options.service } }, { key: "service.instance.id", value: { stringValue: this.instanceId } }] };
    if (!options.exporter) {
      const endpoint = new URL(options.endpoint ?? "");
      if (!/^https?:$/.test(endpoint.protocol)) throw new Error("endpoint must use HTTP or HTTPS");
    }
    this.exporter = options.exporter ?? new HTTPExporter(options.endpoint!, () => this.options.key);
    this.interval = setInterval(() => { if (!this.closing) { this.collect(); this.kick(); } }, this.settings.intervalMs);
    // A library timer should not prevent an otherwise finished Node process exiting.
    const timer = this.interval as unknown as { unref?: () => void }; timer.unref?.();
  }
  attributes(attrs: Attributes): Attribute[] {
    const keys = Object.keys(attrs).sort();
    if (keys.length > this.settings.maxAttributes) throw new Error("attribute count exceeded");
    const values = keys.map(key => { if (!key || encoder.encode(key).length > 128) throw new Error("invalid attribute key"); return { key, value: otlpValue(attrs[key]) }; });
    if (encoder.encode(JSON.stringify(values)).length > this.settings.maxAttributeBytes) throw new Error("attribute bytes exceeded");
    return values;
  }
  invalid(error: unknown): void { this.stats.invalidRecords++; this.stats.lastError = error instanceof Error ? error.message : String(error); }
  lost(records: number, message: string): void {
    this.stats.droppedRecords += records; this.failureSequence = this.sequence;
    this.failure = new Error(message); this.stats.lastError = message;
  }
  store(map: Map<string, RecordValue[]>, table: string, record: RecordValue): void {
    if (this.closing) { this.invalid("record after shutdown"); return; }
    const size = encoder.encode(JSON.stringify(record)).length + 64;
    if (this.stats.bufferBytes + size > this.settings.bufferBytes) { this.lost(1, "SDK record buffer capacity exceeded; telemetry lost"); return; }
    this.stats.bufferBytes += size; const rows = map.get(table) ?? []; rows.push(record); map.set(table, rows);
  }
  instrument(table: string, name: string, kind: Instrument["kind"], options: MetricOptions): Instrument {
    if (this.closing || !name || encoder.encode(name).length > 255 || (options.unit?.length ?? 0) > 64 || (options.description?.length ?? 0) > 1024) throw new Error("invalid metric identity or SDK closed");
    const boundaries = kind === "histogram" ? [...(options.boundaries ?? [5, 10, 25, 50, 100, 250, 500, 1000])] : [];
    if (boundaries.length > 128 || boundaries.some((n, i) => !finite(n) || (i > 0 && boundaries[i - 1] >= n))) throw new Error("histogram boundaries must be finite and increasing");
    const key = `${table}\0${name}`, existing = this.instruments.get(key);
    const normalized: MetricOptions = { unit: options.unit ?? "", description: options.description ?? "", boundaries };
    if (existing) { if (existing.kind !== kind || existing.options.unit !== normalized.unit || JSON.stringify(existing.options.boundaries) !== JSON.stringify(boundaries)) throw new Error("conflicting metric registration"); return existing; }
    if (this.instruments.size >= this.settings.maxInstruments) throw new Error("instrument limit exceeded");
    const instrument: Instrument = { table, name, kind, options: normalized, series: new Map(), start: nowNano() }; this.instruments.set(key, instrument); return instrument;
  }
  record(metric: Instrument, value: number | bigint, attrs: Attributes): void {
    if (this.closing) { this.invalid("metric after shutdown"); return; }
    let attributes: Attribute[];
    try { attributes = this.attributes(attrs); } catch (e) { this.invalid(e); return; }
    let integer = 0n;
    if (metric.kind === "counter") {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) { this.invalid("counter requires a nonnegative safe integer or bigint"); return; }
      integer = BigInt(value); if (integer < 0 || integer > maxInt64) { this.invalid("counter increment outside Int64"); return; }
    } else if (typeof value !== "number" || !finite(value)) { this.invalid("metric requires a finite number"); return; }
    let key = JSON.stringify(attributes), point = metric.series.get(key);
    if (!point && metric.series.size >= this.settings.cardinalityLimit) {
      key = "overflow"; attributes = [{ key: "otel.metric.overflow", value: { boolValue: true } }]; point = metric.series.get(key); this.stats.overflowRecords++;
    }
    if (!point) {
      const cost = encoder.encode(key).length + 128 + 8 * ((metric.options.boundaries?.length ?? 0) + 1);
      if (this.stats.bufferBytes + cost > this.settings.bufferBytes) { this.lost(1, "SDK aggregate buffer capacity exceeded; telemetry lost"); return; }
      this.stats.bufferBytes += cost; const n = Number(value);
      point = { attributes, integer: 0n, value: 0, count: 0n, buckets: (metric.options.boundaries ?? []).map(() => 0n).concat(0n), observed: nowNano(), min: n, max: n }; metric.series.set(key, point);
    }
    if (metric.kind === "counter") {
      if (point.integer + integer > maxInt64) { this.invalid("counter overflow"); return; } point.integer += integer;
    } else if (metric.kind === "gauge") point.value = Number(value);
    else {
      const n = Number(value); if (!finite(point.value + n) || point.count === maxUint64) { this.invalid("histogram overflow"); return; }
      point.value += n; point.count++; let bucket = (metric.options.boundaries ?? []).findIndex(b => n <= b); if (bucket < 0) bucket = point.buckets.length - 1; point.buckets[bucket]++; point.min = Math.min(point.min, n); point.max = Math.max(point.max, n);
    }
    point.observed = nowNano();
  }
  collect(): void {
    const at = new Date().toISOString(), end = nowNano();
    const tables = new Set([...this.logs.keys(), ...this.spans.keys(), ...Array.from(this.instruments.values(), i => i.table)]);
    for (const table of [...tables].sort()) {
      const metrics: RecordValue[] = [];
      for (const m of [...this.instruments.values()].sort((a, b) => a.name.localeCompare(b.name))) if (m.table === table) {
        const finish = end < m.start ? m.start : end;
        for (const [, p] of [...m.series].sort(([a], [b]) => a.localeCompare(b))) {
          const point: RecordValue = { attributes: p.attributes, timeUnixNano: nano(m.kind === "gauge" ? p.observed : finish) };
          const record: RecordValue = { name: m.name, unit: m.options.unit, description: m.options.description };
          if (m.kind === "counter") { Object.assign(point, { startTimeUnixNano: nano(m.start), asInt: p.integer.toString() }); record.sum = { dataPoints: [point], aggregationTemporality: 1, isMonotonic: true }; }
          else if (m.kind === "gauge") { point.asDouble = p.value; record.gauge = { dataPoints: [point] }; }
          else { Object.assign(point, { startTimeUnixNano: nano(m.start), explicitBounds: m.options.boundaries, bucketCounts: p.buckets.map(String), count: p.count.toString(), sum: p.value, min: p.min, max: p.max }); record.histogram = { dataPoints: [point], aggregationTemporality: 1 }; }
          metrics.push(record);
        }
        m.series.clear(); m.start = finish;
      }
      this.pack("metrics", table, metrics, at); this.pack("logs", table, this.logs.get(table) ?? [], at); this.pack("traces", table, this.spans.get(table) ?? [], at);
    }
    this.logs.clear(); this.spans.clear(); this.stats.bufferBytes = 0;
  }
  payload(signal: Signal, records: RecordValue[]): Uint8Array {
    const scope = { name: "lightmoni/sdk/typescript" };
    if (signal === "metrics") {
      const merged = new Map<string, RecordValue>();
      for (const record of records) {
        const name = String(record.name), previous = merged.get(name);
        if (!previous) { merged.set(name, structuredClone(record)); continue; }
        for (const kind of ["sum", "gauge", "histogram"]) if (previous[kind]) {
          const before = previous[kind] as { dataPoints: unknown[] }; before.dataPoints.push(...(record[kind] as { dataPoints: unknown[] }).dataPoints);
        }
      }
      return encoder.encode(JSON.stringify({ resourceMetrics: [{ resource: this.resource, scopeMetrics: [{ scope, metrics: [...merged.values()] }] }] }));
    }
    if (signal === "logs") return encoder.encode(JSON.stringify({ resourceLogs: [{ resource: this.resource, scopeLogs: [{ scope, logRecords: records }] }] }));
    return encoder.encode(JSON.stringify({ resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope, spans: records }] }] }));
  }
  pack(signal: Signal, table: string, records: RecordValue[], at: string): void {
    let group: RecordValue[] = [];
    const baseSize = this.payload(signal, []).length;
    let size = baseSize;
    for (const record of records) {
      // Before merging same-name metrics this is an upper bound on the final
      // JSON size. Each record is encoded once rather than growing O(n²).
      const cost = encoder.encode(JSON.stringify(record)).length + 1;
      if (group.length && size + cost > this.settings.maxBatchBytes) { this.enqueue(signal, table, group, at); group = []; size = baseSize; }
      group.push(record);
      size += cost;
    }
    if (group.length) this.enqueue(signal, table, group, at);
  }
  enqueue(signal: Signal, table: string, records: RecordValue[], at: string): void {
    const payload = this.payload(signal, records); this.sequence++;
    if (payload.length > this.settings.maxBatchBytes || this.queue.length >= this.settings.queueBatches || this.stats.pendingBytes + payload.length > this.settings.queueBytes) { this.lost(records.length, "SDK queue or batch capacity exceeded; telemetry lost"); return; }
    this.queue.push({ sequence: this.sequence, records: records.length, batch: { signal, table, service: this.options.service, id: uuid(), createdAt: at, contentType: "application/json", payload } }); this.stats.pendingBytes += payload.length; this.stats.pendingBatches++;
  }
  notify(): void { for (const changed of [...this.changed]) changed(); }
  kick(): void { if (!this.working && !this.stopped) void this.pump(); }
  async pump(): Promise<void> {
    this.working = true; let backoff = this.settings.retryMinMs;
    try { while (this.queue.length && !this.stopped) {
      const item = this.queue[0]; this.request = new AbortController();
      const timer = setTimeout(() => this.request?.abort(), this.settings.requestTimeoutMs);
      let failure: unknown;
      try { await this.exporter.deliver({ ...item.batch, payload: item.batch.payload.slice() }, this.request.signal); } catch (error) { failure = error; } finally { clearTimeout(timer); this.request = undefined; }
      if (this.stopped) break;
      if (!failure) { this.queue.shift(); this.stats.pendingBatches--; this.stats.pendingBytes -= item.batch.payload.length; this.stats.deliveredBatches++; backoff = this.settings.retryMinMs; this.notify(); continue; }
      this.stats.lastError = failure instanceof Error ? failure.message : String(failure);
      if (failure instanceof DeliveryError && !failure.retryable) {
        this.queue.shift(); this.stats.pendingBatches--; this.stats.pendingBytes -= item.batch.payload.length; this.stats.rejectedRecords += failure.rejectedRecords || item.records; this.failure = failure; this.failureSequence = item.sequence; this.notify(); backoff = this.settings.retryMinMs; continue;
      }
      this.stats.retriedBatches++;
      const delay = Math.max(Math.floor(backoff * (0.5 + Math.random() / 2)), failure instanceof DeliveryError ? failure.retryAfterMs : 0);
      await new Promise<void>(resolve => { const timer = setTimeout(() => { this.retryNow = undefined; resolve(); }, delay); this.retryNow = () => { clearTimeout(timer); this.retryNow = undefined; resolve(); }; });
      backoff = Math.min(backoff * 2, this.settings.retryMaxMs);
    } } finally { this.working = false; this.notify(); }
  }
  async wait(target: number, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.queue.length && this.queue[0].sequence <= target) {
      if (this.stopped) throw new Error("SDK stopped before durable acknowledgment");
      const remaining = until - Date.now(); if (remaining <= 0) throw new Error("flush incomplete: timeout before durable acknowledgment");
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.changed.delete(done); resolve(); }; const timer = setTimeout(done, remaining); this.changed.add(done); });
    }
    if (this.failure && this.failureSequence <= target) throw this.failure;
  }
}

export class Counter { constructor(private readonly state: State, private readonly metric: Instrument) {} add(value: number | bigint, attrs: Attributes = {}): void { this.state.record(this.metric, value, attrs); } }
export class Gauge { constructor(private readonly state: State, private readonly metric: Instrument) {} record(value: number, attrs: Attributes = {}): void { this.state.record(this.metric, value, attrs); } }
export class Histogram { constructor(private readonly state: State, private readonly metric: Instrument) {} record(value: number, attrs: Attributes = {}): void { this.state.record(this.metric, value, attrs); } }
export class LightMoni {
  private constructor(private readonly state: State, readonly table: string) {}
  static create(options: Options): LightMoni { return new LightMoni(new State({ ...options }), options.table); }
  get meter(): LightMoni { return this; }
  get instanceId(): string { return this.state.instanceId; }
  withTable(table: string): LightMoni { if (!validTable(table)) throw new Error("invalid logical table"); return new LightMoni(this.state, table); }
  counter(name: string, options: MetricOptions = {}): Counter { return new Counter(this.state, this.state.instrument(this.table, name, "counter", options)); }
  gauge(name: string, options: MetricOptions = {}): Gauge { return new Gauge(this.state, this.state.instrument(this.table, name, "gauge", options)); }
  histogram(name: string, options: MetricOptions = {}): Histogram { return new Histogram(this.state, this.state.instrument(this.table, name, "histogram", options)); }
  stats(): Stats { return { ...this.state.stats }; }
  updateKey(key: string): void { this.state.options.key = key; this.state.retryNow?.(); }
  log(level: string, body: string, attrs: Attributes = {}, context = this.state.options.contextProvider?.()): void {
    if (encoder.encode(body).length > 64 * 1024) { this.state.invalid("log body exceeded 64 KiB"); return; }
    let attributes: Attribute[]; try { attributes = this.state.attributes(attrs); } catch (e) { this.state.invalid(e); return; }
    this.state.sourceSequence++;
    attributes = attributes.filter(a => a.key !== "lightmoni.source_id" && a.key !== "lightmoni.source_seq");
    attributes.push({ key: "lightmoni.source_id", value: { stringValue: this.state.instanceId } }, { key: "lightmoni.source_seq", value: { intValue: this.state.sourceSequence.toString() } });
    const time = nano(nowNano()), severity = ({ trace: 1, debug: 5, info: 9, warn: 13, warning: 13, error: 17, fatal: 21 } as Record<string, number>)[level.toLowerCase()] ?? 9;
    const record: RecordValue = { timeUnixNano: time, observedTimeUnixNano: time, severityNumber: severity, severityText: level.toUpperCase(), body: { stringValue: body }, attributes };
    if (validTrace(context)) Object.assign(record, { traceId: context.traceId, spanId: context.spanId, flags: context.flags });
    this.state.store(this.state.logs, this.table, record);
  }
  startSpan(name: string, attrs: Attributes = {}, parent = this.state.options.contextProvider?.()): Span { return new Span(this.state, this.table, name, attrs, parent); }
  async flush({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<void> { if (this.state.stopped) throw new Error("SDK is closed"); this.state.collect(); const target = this.state.sequence; this.state.kick(); await this.state.wait(target, timeoutMs); }
  async shutdown({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state.stopped) { if (this.state.failure) throw this.state.failure; return; }
    this.state.closing = true; clearInterval(this.state.interval);
    try { await this.flush({ timeoutMs }); } finally { this.state.stopped = true; this.state.request?.abort(); this.state.retryNow?.(); this.state.notify(); }
  }
}
export function createLightMoni(options: Options): LightMoni { return LightMoni.create(options); }

export class Span {
  readonly context: TraceContext;
  private readonly data: RecordValue;
  private ended = false;
  constructor(private readonly state: State, private readonly table: string, name: string, attrs: Attributes, parent?: TraceContext) {
    if (!validTrace(parent)) parent = undefined;
    this.context = { traceId: parent?.traceId ?? uuid().replaceAll("-", ""), spanId: uuid().replaceAll("-", "").slice(0, 16), flags: parent?.flags ?? 1, traceState: parent?.traceState };
    let attributes: Attribute[] = []; try { attributes = state.attributes(attrs); } catch (e) { state.invalid(e); }
    this.data = { traceId: this.context.traceId, spanId: this.context.spanId, name, kind: 1, flags: this.context.flags, startTimeUnixNano: nano(nowNano()), attributes };
    if (parent) { this.data.parentSpanId = parent.spanId; if (parent.traceState) this.data.traceState = parent.traceState; }
  }
  setError(error: unknown): void { if (!this.ended) this.data.status = { code: 2, message: String(error).slice(0, 4096) }; }
  setKind(kind: 1 | 2 | 3 | 4 | 5): void { if (!this.ended) this.data.kind = kind; }
  end(): void { if (this.ended) return; this.ended = true; const time = nowNano(), start = BigInt(String(this.data.startTimeUnixNano)); this.data.endTimeUnixNano = nano(time < start ? start : time); const name = String(this.data.name); if (!name || encoder.encode(name).length > 255) { this.state.invalid("invalid span name"); return; } this.state.store(this.state.spans, this.table, this.data); }
}

export function extractTrace(headers: Headers | Record<string, string | undefined>): TraceContext | undefined {
  const parent = headers instanceof Headers ? headers.get("traceparent") : headers.traceparent;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(parent ?? "");
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  const traceState = headers instanceof Headers ? headers.get("tracestate") : headers.tracestate;
  return { traceId: match[1], spanId: match[2], flags: Number.parseInt(match[3], 16), traceState: traceState && traceState.length <= 512 ? traceState : undefined };
}
export function injectTrace(context: TraceContext): Record<string, string> { return { traceparent: `00-${context.traceId}-${context.spanId}-${context.flags.toString(16).padStart(2, "0")}`, ...(context.traceState ? { tracestate: context.traceState } : {}) }; }

export class HTTPExporter implements Exporter {
  constructor(private readonly endpoint: string, private readonly key: () => string | undefined = () => undefined) {}
  async deliver(batch: FrozenBatch, signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": batch.contentType, "X-Lightmoni-Table": batch.table, "X-Lightmoni-Batch-ID": batch.id, "X-Lightmoni-Batch-Created-At": batch.createdAt };
    const key = this.key(); if (key) headers.Authorization = `Bearer ${key}`;
    let response: Response;
    try { response = await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/${batch.signal}`, { method: "POST", headers, body: batch.payload.slice().buffer as ArrayBuffer, signal, redirect: "error" }); }
    catch { throw new DeliveryError("telemetry network request failed", true); }
    if (response.status !== 200) {
      const retryable = [401, 403, 429, 502, 503, 504].includes(response.status), retry = response.headers.get("Retry-After");
      let delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Math.max(0, Date.parse(retry) - Date.now()) || 0 : 0;
      if (response.status === 401 || response.status === 403) delay = Math.max(delay, 30_000);
      void response.body?.cancel(); throw new DeliveryError(`telemetry rejected with HTTP ${response.status}`, retryable, delay);
    }
    if (!response.body) return;
    const reader = response.body.getReader(); let bytes = 0; const parts: Uint8Array[] = [];
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 64 * 1024) { await reader.cancel(); throw new DeliveryError("telemetry response size exceeded"); } parts.push(chunk.value); } }
    catch (e) { if (e instanceof DeliveryError) throw e; throw new DeliveryError("telemetry acknowledgment interrupted", true); }
    if (!bytes) return;
    const body = new Uint8Array(bytes); let at = 0; for (const part of parts) { body.set(part, at); at += part.length; }
    if (!response.headers.get("Content-Type")?.startsWith("application/json")) throw new DeliveryError("expected an OTLP JSON acknowledgment", true);
    let result: { partialSuccess?: { rejectedLogRecords?: string; rejectedDataPoints?: string; rejectedSpans?: string } };
    try { result = JSON.parse(new TextDecoder().decode(body)); } catch { throw new DeliveryError("invalid OTLP JSON acknowledgment", true); }
    const partial = result.partialSuccess; if (partial) { const rejected = Number(partial.rejectedLogRecords ?? partial.rejectedDataPoints ?? partial.rejectedSpans ?? 0); if (rejected > 0) throw new DeliveryError("OTLP partial success (not retried)", false, 0, rejected); }
  }
}
