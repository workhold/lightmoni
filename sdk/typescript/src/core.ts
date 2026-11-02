import {CenterEndpoints} from "./endpoints.js";
import { copyMetricWindows, metricWindow, type MetricWindows } from './windows.js';
import { Distribution } from './distribution.js';
import { copyLogSampling, copyExclusions, matches, sampleLog, type LogSamplingPolicy, type SDKConfig, type LogExcludeRule } from './sampling.js';
export type { LogSamplingPolicy, LogRule, LogCondition, LogExcludeRule, SDKConfig } from './sampling.js';
export type Attributes = Record<string, string | boolean | number | bigint>;
export type Signal = "metrics" | "logs" | "traces";
export interface FrozenBatch {
  signal: Signal; table: string; service: string; id: string;
  createdAt: string; contentType: "application/json"; payload: Uint8Array;
}
export interface Exporter { deliver(batch: FrozenBatch, signal: AbortSignal): Promise<void> }
export interface TraceContext { traceId: string; spanId: string; flags: number; traceState?: string }
export interface Options {
  service: string; env?: string; service_version?: string; instance_id?: string; table?: string; endpoint?: string; key?: string;
  selfTelemetry?: boolean;
  logSampling?: Record<string, LogSamplingPolicy>; disabled?: boolean;
  remoteConfig?: boolean; configEndpoint?: string; configIntervalMs?: number;
  instanceId?: string; resource?: Attributes; exporter?: Exporter;
  intervalMs?: number; requestTimeoutMs?: number; retryMinMs?: number; retryMaxMs?: number;
  queueBytes?: number; queueBatches?: number; bufferBytes?: number; maxBatchBytes?: number;
  cardinalityLimit?: number; maxInstruments?: number; maxAttributes?: number; maxAttributeBytes?: number;
  /** Optional current-context hook for log/span correlation; read when recording. */
  contextProvider?: () => TraceContext | undefined;
  /** Runs a scoped action; Node installs AsyncLocalStorage automatically. */
  contextRunner?: <T>(context: TraceContext, action: () => T) => T;
}
export interface MetricOptions { unit?: string; description?: string; boundaries?: number[] }
export interface Stats {
  pendingBatches: number; pendingBytes: number; bufferBytes: number; deliveredBatches: number;
  retriedBatches: number; droppedRecords: number; rejectedRecords: number;
  invalidRecords: number; overflowRecords: number; lastError?: string;
  sampledOutLogs: number; unmatchedLogs: number; excludedLogs: number; disabledRecords: number;
  reportingDisabled: boolean; configRevision?: string; configError?: string;
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
function validTrace(value: TraceContext | undefined | null): value is TraceContext { return !!value && /^[0-9a-f]{32}$/.test(value.traceId) && !/^0+$/.test(value.traceId) && /^[0-9a-f]{16}$/.test(value.spanId) && !/^0+$/.test(value.spanId) && Number.isInteger(value.flags) && value.flags >= 0 && value.flags <= 255 && (value.traceState === undefined || (typeof value.traceState === "string" && value.traceState.length <= 512)); }
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
  private metricWindows:MetricWindows={};
  readonly observations = new Map<string, {table:string;name:string;attributes:Attribute[];distribution:Distribution;summaryCount:bigint;summarySum:number;seconds:number;cost:number}>();
  readonly logs = new Map<string, RecordValue[]>();
  readonly spans = new Map<string, RecordValue[]>();
  readonly queue: Queued[] = [];
  readonly stats: Stats = { pendingBatches: 0, pendingBytes: 0, bufferBytes: 0, deliveredBatches: 0, retriedBatches: 0, droppedRecords: 0, rejectedRecords: 0, invalidRecords: 0, overflowRecords: 0, sampledOutLogs:0, unmatchedLogs:0, excludedLogs:0, disabledRecords:0, reportingDisabled:false };
  readonly changed = new Set<() => void>();
  readonly exporter: Exporter;
  readonly endpoints?: CenterEndpoints;
  endpointInterval?: ReturnType<typeof setInterval>;
  localSampling: Record<string, LogSamplingPolicy> = {};
  remoteSampling: Record<string, LogSamplingPolicy> = {};
  remoteDisabled = false;
  reportingGeneration = 0;
  configInterval?: ReturnType<typeof setInterval>;
  configRequest?: AbortController;
  configLoading?: Promise<void>;
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
  selfInterval: ReturnType<typeof setInterval>;
  selfLast = -Infinity;
  selfStarted = false;
  selfPrevious?: Stats;
  constructor(readonly options: Options) {
    options.resource = {...options.resource};
    if (!options.service || encoder.encode(options.service).length > 128 || (options.table !== undefined && !validTable(options.table))) throw new Error("valid service and logical table are required");
    this.updateLogSampling(options.logSampling ?? {});
    Object.assign(this.stats, {sampledOutLogs:0,unmatchedLogs:0,excludedLogs:0,disabledRecords:0,reportingDisabled:options.disabled??false});
    if(options.configIntervalMs!==undefined&&(!Number.isSafeInteger(options.configIntervalMs)||options.configIntervalMs<1000))throw new Error('configuration interval must be at least one second');
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
    for (const value of [options.env, options.service_version, options.instance_id]) if (value !== undefined && (typeof value !== "string" || !value.trim() || encoder.encode(value).length > 128)) throw new Error("invalid resource identity");
    this.instanceId = options.instance_id ?? options.instanceId ?? uuid();
    if(options.env) options.resource!["deployment.environment.name"] = options.env;
    if(options.service_version) options.resource!["service.version"] = options.service_version;
    const resource = this.attributes(options.resource ?? {});
    if (resource.some(a => a.key === "service.name" || a.key === "service.instance.id")) throw new Error("configure service identity separately");
    this.resource = { attributes: [...resource, { key: "service.name", value: { stringValue: options.service } }, { key: "service.instance.id", value: { stringValue: this.instanceId } }] };
    if (!options.exporter) {
      const endpoint = new URL(options.endpoint ?? "");
      if (!/^https?:$/.test(endpoint.protocol)) throw new Error("endpoint must use HTTP or HTTPS");
    }
    this.endpoints = options.exporter ? undefined : new CenterEndpoints(options.endpoint!, ():HeadersInit => this.options.key ? {Authorization:`Bearer ${this.options.key}`} : {});
    this.exporter = options.exporter ?? new HTTPExporter(options.endpoint!, () => this.options.key, this.endpoints);
    if(this.endpoints){this.endpointInterval=setInterval(()=>{if(!this.closing)void this.endpoints!.refresh().catch(()=>{});},30000);(this.endpointInterval as unknown as {unref?:()=>void}).unref?.();}
    this.interval = setInterval(() => { if (!this.closing) { this.collect(false); this.kick(); } }, this.settings.intervalMs);
    // A library timer should not prevent an otherwise finished Node process exiting.
    const timer = this.interval as unknown as { unref?: () => void }; timer.unref?.();
    this.selfInterval = setInterval(() => { if (!this.closing) { this.collectSelf(); this.kick(); } }, 30_000);
    (this.selfInterval as unknown as { unref?: () => void }).unref?.();
    if(options.remoteConfig!==false&&(options.configEndpoint||options.endpoint)) {
      this.configInterval=setInterval(()=>{if(!this.closing)void this.refreshConfig().catch(error=>{this.stats.configError=error instanceof Error?error.message:String(error);});},options.configIntervalMs??30_000);
      (this.configInterval as unknown as {unref?:()=>void}).unref?.();
    }
  }
  updateLogSampling(policies:Record<string,LogSamplingPolicy>):void {
    const snapshot:Record<string,LogSamplingPolicy>={};for(const [table,p]of Object.entries(policies)){if(!validTable(table)||['lightmoni'].includes(table))throw new Error('invalid log policy table');snapshot[table]=copyLogSampling(p);}this.localSampling=snapshot;
  }
  setReportingDisabled(disabled:boolean):void {
    if(this.stats.reportingDisabled===disabled)return;this.stats.reportingDisabled=disabled;
    if(disabled){this.reportingGeneration++;this.request?.abort();this.retryNow?.();this.stats.disabledRecords+=this.queue.reduce((n,q)=>n+q.records,0)+[...this.logs.values(),...this.spans.values()].reduce((n,rows)=>n+rows.length,0);
      for(const m of this.instruments.values()){this.stats.disabledRecords+=m.series.size;m.series.clear();m.start=nowNano();}this.observations.clear();this.queue.length=0;this.logs.clear();this.spans.clear();this.stats.pendingBytes=0;this.stats.pendingBatches=0;this.stats.bufferBytes=0;
    }else{this.selfLast=-Infinity;for(const m of this.instruments.values())m.start=nowNano();}this.notify();
  }
  refreshConfig():Promise<void> {
    if(this.configLoading)return this.configLoading;
    this.configLoading=this.fetchConfig().finally(()=>{this.configLoading=undefined;});return this.configLoading;
  }
  private async fetchConfig():Promise<void> {
    const endpoint=this.options.configEndpoint??this.options.endpoint;if(!endpoint||this.closing)throw new Error('remote configuration is disabled or SDK closed');
    const request=new AbortController();this.configRequest=request;const timer=setTimeout(()=>request.abort(new DOMException("request timed out","TimeoutError")),5000);
    try{
      const init:RequestInit={headers:this.options.key?{Authorization:`Bearer ${this.options.key}`}:{},signal:request.signal,redirect:'error'};
      const response=await (this.endpoints && endpoint===this.options.endpoint ? this.endpoints.request('/v1/sdk-config',init) : fetch(endpoint.replace(/\/$/,'')+'/v1/sdk-config',init));
      if(response.status!==200){void response.body?.cancel();throw new Error(`SDK configuration HTTP ${response.status}`);}
      if(!response.body)throw new Error('missing SDK configuration');const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
      while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>1024*1024){await reader.cancel();throw new Error('SDK configuration exceeds 1 MiB');}parts.push(chunk.value);}
      const raw=new Uint8Array(length);let offset=0;for(const part of parts){raw.set(part,offset);offset+=part.length;}
      const config=JSON.parse(new TextDecoder().decode(raw)) as SDKConfig;
      if(!config||typeof config.revision!=='string'||!config.revision||config.revision.length>128||!config.log_sampling||Array.isArray(config.log_sampling)||typeof config.log_sampling!=='object'||Object.keys(config.log_sampling).length>200||Object.keys(config).some(k=>!['revision','log_sampling','disable_rules','metric_windows'].includes(k)))throw new Error('invalid SDK configuration');
      const policies:Record<string,LogSamplingPolicy>={};for(const[table,p]of Object.entries(config.log_sampling)){if(!validTable(table)||['lightmoni'].includes(table))throw new Error('invalid log policy table');policies[table]=copyLogSampling(p);}
      const windows=copyMetricWindows(config.metric_windows);
      const disable=copyExclusions(config.disable_rules??[],true);
      if(this.closing)return;this.metricWindows=windows;this.remoteSampling=policies;this.remoteDisabled=disable.some(rule=>matches(rule.conditions,this.samplingRecord()));this.setReportingDisabled(!!this.options.disabled||this.remoteDisabled);this.stats.configRevision=config.revision;this.stats.configError=undefined;
    }catch(error){throw new Error(error instanceof Error&&error.message.startsWith('SDK configuration')?error.message:'SDK configuration unavailable or invalid');}finally{clearTimeout(timer);this.configRequest=undefined;}
  }
  samplingRecord(attrs:Attributes={},level='',context?:TraceContext){return {record:{service:this.options.service,instance_id:this.instanceId,'sdk.language':'typescript',severity:level.toUpperCase(),trace_id:context?.traceId,event_id:`${this.instanceId}:${this.sourceSequence}`},attributes:attrs,resource:{...this.options.resource,'service.name':this.options.service,'service.instance.id':this.instanceId}};}
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
    if (!validTable(table)) { this.invalid("select a table with withTable before recording"); return; }
    if (this.closing) { this.invalid("record after shutdown"); return; }
    if(this.stats.reportingDisabled){this.stats.disabledRecords++;return;}
    const size = encoder.encode(JSON.stringify(record)).length + 64;
    if (this.stats.bufferBytes + size > this.settings.bufferBytes) { this.lost(1, "SDK record buffer capacity exceeded; telemetry lost"); return; }
    this.stats.bufferBytes += size; const rows = map.get(table) ?? []; rows.push(record); map.set(table, rows);
  }
  instrument(table: string, name: string, kind: Instrument["kind"], options: MetricOptions): Instrument {
    if (!validTable(table) || this.closing || !name || encoder.encode(name).length > 255 || (options.unit?.length ?? 0) > 64 || (options.description?.length ?? 0) > 1024) throw new Error("invalid metric identity or SDK closed");
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
    if(this.stats.reportingDisabled){this.stats.disabledRecords++;return;}
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
  observe(table:string,name:string,dimensions:Record<string,string>,value:number,count:number|bigint):void {
    if(this.closing){this.invalid("record after shutdown");return;}
    if(this.stats.reportingDisabled){this.stats.disabledRecords++;return;}
    if(!this.options.env?.trim() || !validTable(table) || ['lightmoni'].includes(table) || !name || encoder.encode(name).length>255 || !Number.isFinite(value) || !dimensions || typeof dimensions!=='object' || Array.isArray(dimensions)) {this.invalid("record requires env, business table, metric name, dimensions and finite value");return;}
    let weight:bigint;try{if(typeof count==='number'&&(!Number.isSafeInteger(count)||count<1))throw new Error();weight=BigInt(count);if(weight<1n||weight>maxUint64)throw new Error();}catch{this.invalid("count must be a positive integer");return;}
    let attributes:Attribute[];
    try {for(const [key,val] of Object.entries(dimensions))if(!/^key([1-9]|1[0-6])$/.test(key)||typeof val!=='string')throw new Error("dimensions must be key1..key16 strings");attributes=this.attributes(Object.fromEntries(Object.entries(dimensions).filter(([,v])=>v!=='')));}catch(error){this.invalid(error);return;}
    const window=metricWindow(this.metricWindows,table,nowNano());const key=JSON.stringify([table,name,attributes,window.seconds,String(window.start)]);let group=this.observations.get(key);
    if(!group){if(this.observations.size>=this.settings.cardinalityLimit)this.collect(false);if(this.observations.size>=this.settings.cardinalityLimit){this.stats.overflowRecords++;return;}const cost=encoder.encode(key).length+256;if(this.stats.bufferBytes+cost>this.settings.bufferBytes){this.lost(1,"SDK aggregate buffer capacity exceeded");return;}this.stats.bufferBytes+=cost;group={table,name,attributes,distribution:new Distribution(window.start),seconds:window.seconds,cost,summaryCount:0n,summarySum:0};this.observations.set(key,group);}
    if(weight>1n){if(group.summaryCount+weight>maxUint64||!Number.isFinite(group.summarySum+value)){this.invalid("summary overflow");return;}group.summaryCount+=weight;group.summarySum+=value;return;}
    const previous=group.distribution.bytes;
    if(!group.distribution.observe(value,this.settings.bufferBytes-this.stats.bufferBytes)){this.invalid("distribution capacity or numeric overflow");return;}
    this.stats.bufferBytes+=group.distribution.bytes-previous;
  }
  collect(force=true): void {
    if(this.stats.reportingDisabled)return;
    const at = new Date().toISOString(), end = nowNano();
    const grouped=new Map<string,RecordValue[]>();
    for(const [key,group] of this.observations){
      const finish=group.distribution.start+BigInt(group.seconds)*1_000_000_000n;
      if(!force&&finish>end)continue;
      const until=end<finish?end:finish;
      const attributes=[...group.attributes,{key:'lightmoni.window_seconds',value:{intValue:String(group.seconds)}}];
      this.observations.delete(key);
      const rows=grouped.get(group.table)??[];
      if(group.distribution.count)rows.push({name:group.name,exponentialHistogram:{dataPoints:[group.distribution.point(until,attributes)],aggregationTemporality:1}});
      if(group.summaryCount)rows.push({name:group.name,summary:{dataPoints:[{attributes,startTimeUnixNano:String(group.distribution.start),timeUnixNano:String(until),count:String(group.summaryCount),sum:group.summarySum,quantileValues:[]}]}});
      grouped.set(group.table,rows);
    }
    for(const [table,rows] of grouped)this.pack("metrics",table,rows,at);
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
    this.logs.clear(); this.spans.clear(); this.stats.bufferBytes = [...this.observations.values()].reduce((n,g)=>n+g.cost+g.distribution.bytes,0);
    this.collectSelf();
  }
  collectSelf(): void {
    const clock = performance.now();
    if (!this.options.key || this.stats.reportingDisabled || this.options.selfTelemetry === false || clock - this.selfLast < 30_000) return;
    this.selfLast = clock;
    const at = new Date().toISOString(), time = nano(nowNano());
    const attributes: Attribute[] = [{key:'lightmoni.component',value:{stringValue:'sdk'}},{key:'sdk.language',value:{stringValue:'typescript'}},{key:'sdk.version',value:{stringValue:'0.1.0'}}];
    const values = { heartbeat: 1, pending_batches: this.stats.pendingBatches, pending_bytes: this.stats.pendingBytes, retried_batches: this.stats.retriedBatches, dropped_records: this.stats.droppedRecords, rejected_records: this.stats.rejectedRecords, invalid_records: this.stats.invalidRecords, overflow_records: this.stats.overflowRecords };
    this.enqueueSelf('metrics', Object.entries(values).map(([name,value]) => ({ name: `lightmoni.sdk.${name}`, gauge: { dataPoints: [{ timeUnixNano: time, attributes, asDouble: value }] } })), at);
    const changed = this.selfPrevious && (['retriedBatches','droppedRecords','rejectedRecords','invalidRecords','overflowRecords'] as const).some(key => this.stats[key] > this.selfPrevious![key]);
    if (!this.selfStarted || changed) {
      const event = this.selfStarted ? 'diagnostics_changed' : 'started';
      const row = { timeUnixNano: time, severityText: changed ? 'WARN' : 'INFO', severityNumber: changed ? 13 : 9, body: { stringValue: changed ? 'LightMoni SDK delivery, buffer or input diagnostics changed' : 'LightMoni SDK started' }, attributes: [...attributes, ...this.attributes({ event })] };
      if (this.enqueueSelf('logs', [row], at)) { this.selfStarted = true; this.selfPrevious = { ...this.stats }; }
    }
  }
  enqueueSelf(signal: Signal, rows: RecordValue[], at: string): boolean {
    const bytes = this.payload(signal, rows).length;
    if (bytes > this.settings.maxBatchBytes || this.queue.length >= this.settings.queueBatches || this.stats.pendingBytes + bytes > this.settings.queueBytes) return false;
    this.enqueue(signal, "lightmoni", rows, at); return true;
  }
  payload(signal: Signal, records: RecordValue[]): Uint8Array {
    const scope = { name: "lightmoni/sdk/typescript" };
    if (signal === "metrics") {
      const scopes = new Map<string, Map<string, RecordValue>>();
      for (const record of records) {
        const kind=["sum","gauge","histogram","exponentialHistogram","summary"].find(k=>record[k])!;
        const name=String(record.name),base=scopes.get("")??new Map<string,RecordValue>();scopes.set("",base);
        const baseKind=base.has(name)?["sum","gauge","histogram","exponentialHistogram","summary"].find(k=>base.get(name)![k]):undefined;
        const scopeKind=baseKind&&baseKind!==kind?kind:"";
        const merged=scopes.get(scopeKind)??new Map<string,RecordValue>();scopes.set(scopeKind,merged);
        const previous=merged.get(name);
        if(!previous)merged.set(name,structuredClone(record));
        else (previous[kind] as {dataPoints:unknown[]}).dataPoints.push(...(record[kind] as {dataPoints:unknown[]}).dataPoints);
      }
      return encoder.encode(JSON.stringify({resourceMetrics:[{resource:this.resource,scopeMetrics:[...scopes].map(([kind,merged])=>({scope:{...scope,name:scope.name+(kind?"/"+kind:"")},metrics:[...merged.values()]}))}]}));
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
      const item = this.queue[0];
      if (item.batch.table === "lightmoni" && !this.options.key) {
        this.queue.shift(); this.stats.pendingBatches--; this.stats.pendingBytes -= item.batch.payload.length; this.notify(); continue;
      }
      this.request = new AbortController();
      const timer = setTimeout(() => this.request?.abort(new DOMException("request timed out","TimeoutError")), this.settings.requestTimeoutMs);
      let failure: unknown;
      try { await this.exporter.deliver({ ...item.batch, payload: item.batch.payload.slice() }, this.request.signal); } catch (error) { failure = error; } finally { clearTimeout(timer); this.request = undefined; }
      if (this.stopped) break;
      if(this.queue[0]!==item){backoff=this.settings.retryMinMs;continue;}
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
  private constructor(private readonly state: State, readonly table: string, private readonly boundTrace?: TraceContext) {}
  static create(options: Options): LightMoni { return new LightMoni(new State({ ...options }), options.table ?? ""); }
  /** Record one observation; aggregation and delivery are automatic. */
  record(table:string,metric_name:string,dimensions:Record<string,string>,value:number,count:number|bigint):void {this.state.observe(table,metric_name,dimensions,value,count);}
  get meter(): LightMoni { return this; }
  get instanceId(): string { return this.state.instanceId; }
  withTable(table: string): LightMoni { if (!validTable(table)) throw new Error("invalid logical table"); return new LightMoni(this.state, table, this.boundTrace); }
  currentTrace(): TraceContext | undefined {
    const value = this.boundTrace ?? this.state.options.contextProvider?.();
    return validTrace(value) ? { ...value } : undefined;
  }
  /** Immutable binding, safe across concurrent browser tasks and table clients. */
  withTrace(context: TraceContext): LightMoni {
    if (!validTrace(context)) throw new Error("invalid trace context");
    return new LightMoni(this.state, this.table, Object.freeze({ ...context }));
  }
  withSpan<T>(name: string, action: (client: LightMoni, span: Span) => T, attrs: Attributes = {}, parent: TraceContext | null | undefined = this.currentTrace()): T {
    const span = this.startSpan(name, attrs, parent), client = this.withTrace(span.context);
    const run = () => {
      try {
        const result = action(client, span);
        if (result != null && typeof (result as { then?: unknown }).then === "function") {
          return Promise.resolve(result).then(value => { span.end(); return value; }, error => { span.setError(error); span.end(); throw error; }) as T;
        }
        span.end(); return result;
      } catch (error) { span.setError(error); span.end(); throw error; }
    };
    try { return this.state.options.contextRunner ? this.state.options.contextRunner(span.context, run) : run(); }
    catch (error) { span.setError(error); span.end(); throw error; }
  }
  /** Use within a request/task scope to propagate its W3C context downstream. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const trace = this.currentTrace();
    if (trace) {
      headers.delete("tracestate");
      for (const [key, value] of Object.entries(injectTrace(trace))) headers.set(key, value);
    }
    return globalThis.fetch(input, { ...init, headers });
  }
  counter(name: string, options: MetricOptions = {}): Counter { return new Counter(this.state, this.state.instrument(this.table, name, "counter", options)); }
  gauge(name: string, options: MetricOptions = {}): Gauge { return new Gauge(this.state, this.state.instrument(this.table, name, "gauge", options)); }
  histogram(name: string, options: MetricOptions = {}): Histogram { return new Histogram(this.state, this.state.instrument(this.table, name, "histogram", options)); }
  stats(): Stats { return { ...this.state.stats }; }
  updateKey(key: string): void { this.state.options.key = key; this.state.retryNow?.(); }
  updateLogSampling(policies:Record<string,LogSamplingPolicy>):void{if(this.state.closing)throw new Error('SDK closed');this.state.updateLogSampling(policies);}
  setReportingEnabled(enabled:boolean):void{this.state.options.disabled=!enabled;this.state.setReportingDisabled(!enabled||this.state.remoteDisabled);}
  async refreshConfig():Promise<void>{await this.state.refreshConfig();}
  async refreshEndpoints():Promise<void>{await this.state.endpoints?.refresh();}
  endpointStatus(){return this.state.endpoints?.status();}
  /** Trace metadata is optional and separate from attrs; no context creates no trace. */
  log(level: string, body: string, attrs: Attributes = {}, context = this.currentTrace()): void {
    if(this.state.closing){this.state.invalid('record after shutdown');return;}if(this.state.stats.reportingDisabled){this.state.stats.disabledRecords++;return;}
    if (encoder.encode(body).length > 64 * 1024) { this.state.invalid("log body exceeded 64 KiB"); return; }
    let attributes: Attribute[]; try { attributes = this.state.attributes(attrs); } catch (e) { this.state.invalid(e); return; }
    this.state.sourceSequence++;
    if (!validTrace(context)) context = undefined;
    const policy=this.state.remoteSampling[this.table]??this.state.localSampling[this.table];
    if(policy){const decision=sampleLog(policy,this.table,this.state.samplingRecord(attrs,level,context));
      if(!decision.keep){if(decision.reason==='excluded')this.state.stats.excludedLogs++;else if(decision.reason==='unmatched')this.state.stats.unmatchedLogs++;else this.state.stats.sampledOutLogs++;return;}
      attributes=attributes.filter(a=>!['lightmoni.sampling.rate','lightmoni.sampling.weight','lightmoni.sampling.rule'].includes(a.key));attributes.push({key:'lightmoni.sampling.rate',value:{doubleValue:decision.rate}},{key:'lightmoni.sampling.weight',value:{doubleValue:1/decision.rate}},{key:'lightmoni.sampling.rule',value:{stringValue:decision.reason}});
    }
    attributes = attributes.filter(a => a.key !== "lightmoni.source_id" && a.key !== "lightmoni.source_seq");
    attributes.push({ key: "lightmoni.source_id", value: { stringValue: this.state.instanceId } }, { key: "lightmoni.source_seq", value: { intValue: this.state.sourceSequence.toString() } });
    const time = nano(nowNano()), severity = ({ trace: 1, debug: 5, info: 9, warn: 13, warning: 13, error: 17, fatal: 21 } as Record<string, number>)[level.toLowerCase()] ?? 9;
    const record: RecordValue = { timeUnixNano: time, observedTimeUnixNano: time, severityNumber: severity, severityText: level.toUpperCase(), body: { stringValue: body }, attributes };
    if (validTrace(context)) Object.assign(record, { traceId: context.traceId, spanId: context.spanId, flags: context.flags });
    this.state.store(this.state.logs, this.table, record);
  }
  startSpan(name: string, attrs: Attributes = {}, parent: TraceContext | null | undefined = this.currentTrace()): Span { if (!validTable(this.table)) throw new Error("select a table with withTable before recording"); return new Span(this.state, this.table, name, attrs, parent ?? undefined); }
  async flush({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<void> { if (this.state.stopped) throw new Error("SDK is closed"); this.state.collect(); const target = this.state.sequence; this.state.kick(); await this.state.wait(target, timeoutMs); }
  async shutdown({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state.stopped) { if (this.state.failure) throw this.state.failure; return; }
    this.state.closing = true; clearInterval(this.state.interval); clearInterval(this.state.selfInterval);clearInterval(this.state.configInterval);this.state.configRequest?.abort();clearInterval(this.state.endpointInterval);
    try { await this.flush({ timeoutMs }); } finally { this.state.stopped = true; this.state.endpoints?.close(); this.state.request?.abort(); this.state.retryNow?.(); this.state.notify(); }
  }
}
export function createLightMoni(options: Options): LightMoni { return LightMoni.create(options); }

export class Span {
  readonly context: TraceContext;
  private readonly data: RecordValue;
  private ended = false;
  private readonly reportingGeneration:number;
  private readonly suppressed:boolean;
  constructor(private readonly state: State, private readonly table: string, name: string, attrs: Attributes, parent?: TraceContext) {
    this.reportingGeneration=state.reportingGeneration;this.suppressed=state.stats.reportingDisabled;
    if (!validTrace(parent)) parent = undefined;
    this.context = { traceId: parent?.traceId ?? uuid().replaceAll("-", ""), spanId: uuid().replaceAll("-", "").slice(0, 16), flags: parent?.flags ?? 1, traceState: parent?.traceState };
    let attributes: Attribute[] = []; try { attributes = state.attributes(attrs); } catch (e) { state.invalid(e); }
    this.data = { traceId: this.context.traceId, spanId: this.context.spanId, name, kind: 1, flags: this.context.flags, startTimeUnixNano: nano(nowNano()), attributes };
    if (parent) { this.data.parentSpanId = parent.spanId; if (parent.traceState) this.data.traceState = parent.traceState; }
  }
  setError(error: unknown): void { if (!this.ended) this.data.status = { code: 2, message: String(error).slice(0, 4096) }; }
  setKind(kind: 1 | 2 | 3 | 4 | 5): void { if (!this.ended) this.data.kind = kind; }
  end(): void { if (this.ended) return; this.ended = true; if(this.suppressed||this.reportingGeneration!==this.state.reportingGeneration){this.state.stats.disabledRecords++;return;}const time = nowNano(), start = BigInt(String(this.data.startTimeUnixNano)); this.data.endTimeUnixNano = nano(time < start ? start : time); const name = String(this.data.name); if (!name || encoder.encode(name).length > 255) { this.state.invalid("invalid span name"); return; } this.state.store(this.state.spans, this.table, this.data); }
}

export function extractTrace(headers: Headers | Record<string, string | undefined>): TraceContext | undefined {
  const normalized = headers instanceof Headers ? headers : Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const parent = normalized instanceof Headers ? normalized.get("traceparent") : normalized.traceparent;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(parent ?? "");
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  const traceState = normalized instanceof Headers ? normalized.get("tracestate") : normalized.tracestate;
  return { traceId: match[1], spanId: match[2], flags: Number.parseInt(match[3], 16), traceState: traceState && traceState.length <= 512 ? traceState : undefined };
}
export function injectTrace(context: TraceContext): Record<string, string> { if (!validTrace(context)) throw new Error("invalid trace context"); return { traceparent: `00-${context.traceId}-${context.spanId}-${context.flags.toString(16).padStart(2, "0")}`, ...(context.traceState ? { tracestate: context.traceState } : {}) }; }

export class HTTPExporter implements Exporter {
  constructor(private readonly endpoint: string, private readonly key: () => string | undefined = () => undefined, private readonly endpoints?: CenterEndpoints) {}
  async deliver(batch: FrozenBatch, signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": batch.contentType, "X-Lightmoni-Table": batch.table, "X-Lightmoni-Batch-ID": batch.id, "X-Lightmoni-Batch-Created-At": batch.createdAt };
    const key = this.key(); if (key) headers.Authorization = `Bearer ${key}`;
    let response: Response;
    try { const init:RequestInit={method:"POST",headers,body:batch.payload.slice().buffer as ArrayBuffer,signal,redirect:"error"}; response = await (this.endpoints ? this.endpoints.request(`/v1/${batch.signal}`,init) : fetch(`${this.endpoint.replace(/\/$/, "")}/v1/${batch.signal}`,init)); }
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
