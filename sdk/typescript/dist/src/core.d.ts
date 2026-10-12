import { type LogSamplingPolicy } from './sampling.js';
export type { LogSamplingPolicy, LogRule, LogCondition, LogExcludeRule, SDKConfig } from './sampling.js';
export type Attributes = Record<string, string | boolean | number | bigint>;
export type Signal = "metrics" | "logs" | "traces";
export interface FrozenBatch {
    signal: Signal;
    table: string;
    service: string;
    id: string;
    createdAt: string;
    contentType: "application/json";
    payload: Uint8Array;
}
export interface Exporter {
    deliver(batch: FrozenBatch, signal: AbortSignal): Promise<void>;
}
export interface TraceContext {
    traceId: string;
    spanId: string;
    flags: number;
    traceState?: string;
}
export interface Options {
    service: string;
    table: string;
    endpoint?: string;
    key?: string;
    selfTelemetry?: boolean;
    logSampling?: Record<string, LogSamplingPolicy>;
    disabled?: boolean;
    remoteConfig?: boolean;
    configEndpoint?: string;
    configIntervalMs?: number;
    instanceId?: string;
    resource?: Attributes;
    exporter?: Exporter;
    intervalMs?: number;
    requestTimeoutMs?: number;
    retryMinMs?: number;
    retryMaxMs?: number;
    queueBytes?: number;
    queueBatches?: number;
    bufferBytes?: number;
    maxBatchBytes?: number;
    cardinalityLimit?: number;
    maxInstruments?: number;
    maxAttributes?: number;
    maxAttributeBytes?: number;
    contextProvider?: () => TraceContext | undefined;
}
export interface MetricOptions {
    unit?: string;
    description?: string;
    boundaries?: number[];
}
export interface Stats {
    pendingBatches: number;
    pendingBytes: number;
    bufferBytes: number;
    deliveredBatches: number;
    retriedBatches: number;
    droppedRecords: number;
    rejectedRecords: number;
    invalidRecords: number;
    overflowRecords: number;
    lastError?: string;
    sampledOutLogs: number;
    unmatchedLogs: number;
    excludedLogs: number;
    disabledRecords: number;
    reportingDisabled: boolean;
    configRevision?: string;
    configError?: string;
}
export declare class DeliveryError extends Error {
    readonly retryable: boolean;
    readonly retryAfterMs: number;
    readonly rejectedRecords: number;
    constructor(message: string, retryable?: boolean, retryAfterMs?: number, rejectedRecords?: number);
}
type AnyValue = {
    stringValue: string;
} | {
    boolValue: boolean;
} | {
    intValue: string;
} | {
    doubleValue: number;
};
type Attribute = {
    key: string;
    value: AnyValue;
};
type RecordValue = Record<string, unknown>;
type Settings = Required<Pick<Options, "intervalMs" | "requestTimeoutMs" | "retryMinMs" | "retryMaxMs" | "queueBytes" | "queueBatches" | "bufferBytes" | "maxBatchBytes" | "cardinalityLimit" | "maxInstruments" | "maxAttributes" | "maxAttributeBytes">>;
type Point = {
    attributes: Attribute[];
    integer: bigint;
    value: number;
    count: bigint;
    buckets: bigint[];
    observed: bigint;
    min: number;
    max: number;
};
type Instrument = {
    table: string;
    name: string;
    kind: "counter" | "gauge" | "histogram";
    options: MetricOptions;
    series: Map<string, Point>;
    start: bigint;
};
type Queued = {
    sequence: number;
    batch: FrozenBatch;
    records: number;
};
declare class State {
    readonly options: Options;
    readonly settings: Settings;
    readonly resource: {
        attributes: Attribute[];
    };
    readonly instanceId: string;
    readonly instruments: Map<string, Instrument>;
    readonly logs: Map<string, RecordValue[]>;
    readonly spans: Map<string, RecordValue[]>;
    readonly queue: Queued[];
    readonly stats: Stats;
    readonly changed: Set<() => void>;
    readonly exporter: Exporter;
    localSampling: Record<string, LogSamplingPolicy>;
    remoteSampling: Record<string, LogSamplingPolicy>;
    remoteDisabled: boolean;
    reportingGeneration: number;
    configInterval?: ReturnType<typeof setInterval>;
    configRequest?: AbortController;
    configLoading?: Promise<void>;
    sequence: number;
    sourceSequence: bigint;
    failureSequence: number;
    failure?: Error;
    closing: boolean;
    stopped: boolean;
    working: boolean;
    retryNow?: () => void;
    request?: AbortController;
    interval: ReturnType<typeof setInterval>;
    selfInterval: ReturnType<typeof setInterval>;
    selfLast: number;
    selfStarted: boolean;
    selfPrevious?: Stats;
    constructor(options: Options);
    updateLogSampling(policies: Record<string, LogSamplingPolicy>): void;
    setReportingDisabled(disabled: boolean): void;
    refreshConfig(): Promise<void>;
    private fetchConfig;
    samplingRecord(attrs?: Attributes, level?: string, context?: TraceContext): {
        record: {
            service: string;
            instance_id: string;
            'sdk.language': string;
            severity: string;
            trace_id: string | undefined;
            event_id: string;
        };
        attributes: Attributes;
        resource: {
            'service.name': string;
            'service.instance.id': string;
        };
    };
    attributes(attrs: Attributes): Attribute[];
    invalid(error: unknown): void;
    lost(records: number, message: string): void;
    store(map: Map<string, RecordValue[]>, table: string, record: RecordValue): void;
    instrument(table: string, name: string, kind: Instrument["kind"], options: MetricOptions): Instrument;
    record(metric: Instrument, value: number | bigint, attrs: Attributes): void;
    collect(): void;
    collectSelf(): void;
    enqueueSelf(signal: Signal, rows: RecordValue[], at: string): boolean;
    payload(signal: Signal, records: RecordValue[]): Uint8Array;
    pack(signal: Signal, table: string, records: RecordValue[], at: string): void;
    enqueue(signal: Signal, table: string, records: RecordValue[], at: string): void;
    notify(): void;
    kick(): void;
    pump(): Promise<void>;
    wait(target: number, timeoutMs: number): Promise<void>;
}
export declare class Counter {
    private readonly state;
    private readonly metric;
    constructor(state: State, metric: Instrument);
    add(value: number | bigint, attrs?: Attributes): void;
}
export declare class Gauge {
    private readonly state;
    private readonly metric;
    constructor(state: State, metric: Instrument);
    record(value: number, attrs?: Attributes): void;
}
export declare class Histogram {
    private readonly state;
    private readonly metric;
    constructor(state: State, metric: Instrument);
    record(value: number, attrs?: Attributes): void;
}
export declare class LightMoni {
    private readonly state;
    readonly table: string;
    private constructor();
    static create(options: Options): LightMoni;
    get meter(): LightMoni;
    get instanceId(): string;
    withTable(table: string): LightMoni;
    counter(name: string, options?: MetricOptions): Counter;
    gauge(name: string, options?: MetricOptions): Gauge;
    histogram(name: string, options?: MetricOptions): Histogram;
    stats(): Stats;
    updateKey(key: string): void;
    updateLogSampling(policies: Record<string, LogSamplingPolicy>): void;
    setReportingEnabled(enabled: boolean): void;
    refreshConfig(): Promise<void>;
    log(level: string, body: string, attrs?: Attributes, context?: TraceContext | undefined): void;
    startSpan(name: string, attrs?: Attributes, parent?: TraceContext | undefined): Span;
    flush({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<void>;
    shutdown({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<void>;
}
export declare function createLightMoni(options: Options): LightMoni;
export declare class Span {
    private readonly state;
    private readonly table;
    readonly context: TraceContext;
    private readonly data;
    private ended;
    private readonly reportingGeneration;
    private readonly suppressed;
    constructor(state: State, table: string, name: string, attrs: Attributes, parent?: TraceContext);
    setError(error: unknown): void;
    setKind(kind: 1 | 2 | 3 | 4 | 5): void;
    end(): void;
}
export declare function extractTrace(headers: Headers | Record<string, string | undefined>): TraceContext | undefined;
export declare function injectTrace(context: TraceContext): Record<string, string>;
export declare class HTTPExporter implements Exporter {
    private readonly endpoint;
    private readonly key;
    constructor(endpoint: string, key?: () => string | undefined);
    deliver(batch: FrozenBatch, signal: AbortSignal): Promise<void>;
}
