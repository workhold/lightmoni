import { copyLogSampling, copyExclusions, matches, sampleLog } from './sampling.js';
export class DeliveryError extends Error {
    retryable;
    retryAfterMs;
    rejectedRecords;
    constructor(message, retryable = false, retryAfterMs = 0, rejectedRecords = 0) {
        super(message);
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.rejectedRecords = rejectedRecords;
        this.name = "DeliveryError";
    }
}
const encoder = new TextEncoder();
const maxInt64 = (1n << 63n) - 1n;
const maxUint64 = (1n << 64n) - 1n;
function nowNano() { return BigInt(Date.now()) * 1000000n; }
function uuid() { return globalThis.crypto.randomUUID(); }
function validTable(table) { return /^[a-z][a-z0-9_]{0,47}$/.test(table) && !/^(log|metric|trace)_/.test(table); }
function finite(value) { return Number.isFinite(value); }
function validTrace(value) { return !!value && /^[0-9a-f]{32}$/.test(value.traceId) && !/^0+$/.test(value.traceId) && /^[0-9a-f]{16}$/.test(value.spanId) && !/^0+$/.test(value.spanId) && Number.isInteger(value.flags) && value.flags >= 0 && value.flags <= 255 && (value.traceState === undefined || (typeof value.traceState === "string" && value.traceState.length <= 512)); }
function nano(value) { return value.toString(); }
function otlpValue(value) {
    if (typeof value === "string")
        return { stringValue: value };
    if (typeof value === "boolean")
        return { boolValue: value };
    if (typeof value === "bigint") {
        if (value < -(1n << 63n) || value > maxInt64)
            throw new Error("attribute integer outside Int64");
        return { intValue: value.toString() };
    }
    if (!finite(value))
        throw new Error("attribute must be finite");
    if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value))
            throw new Error("unsafe integer attribute; use bigint");
        return { intValue: value.toString() };
    }
    return { doubleValue: value };
}
class State {
    options;
    settings;
    resource;
    instanceId;
    instruments = new Map();
    logs = new Map();
    spans = new Map();
    queue = [];
    stats = { pendingBatches: 0, pendingBytes: 0, bufferBytes: 0, deliveredBatches: 0, retriedBatches: 0, droppedRecords: 0, rejectedRecords: 0, invalidRecords: 0, overflowRecords: 0, sampledOutLogs: 0, unmatchedLogs: 0, excludedLogs: 0, disabledRecords: 0, reportingDisabled: false };
    changed = new Set();
    exporter;
    localSampling = {};
    remoteSampling = {};
    remoteDisabled = false;
    reportingGeneration = 0;
    configInterval;
    configRequest;
    configLoading;
    sequence = 0;
    sourceSequence = 0n;
    failureSequence = 0;
    failure;
    closing = false;
    stopped = false;
    working = false;
    retryNow;
    request;
    interval;
    selfInterval;
    selfLast = -Infinity;
    selfStarted = false;
    selfPrevious;
    constructor(options) {
        this.options = options;
        options.resource = { ...options.resource };
        if (!options.service || encoder.encode(options.service).length > 128 || !validTable(options.table))
            throw new Error("valid service and logical table are required");
        this.updateLogSampling(options.logSampling ?? {});
        Object.assign(this.stats, { sampledOutLogs: 0, unmatchedLogs: 0, excludedLogs: 0, disabledRecords: 0, reportingDisabled: options.disabled ?? false });
        if (options.configIntervalMs !== undefined && (!Number.isSafeInteger(options.configIntervalMs) || options.configIntervalMs < 1000))
            throw new Error('configuration interval must be at least one second');
        this.settings = {
            intervalMs: options.intervalMs ?? 10_000, requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
            retryMinMs: options.retryMinMs ?? 200, retryMaxMs: options.retryMaxMs ?? 30_000,
            queueBytes: options.queueBytes ?? 8 * 1024 * 1024, queueBatches: options.queueBatches ?? 256,
            bufferBytes: options.bufferBytes ?? 8 * 1024 * 1024, maxBatchBytes: options.maxBatchBytes ?? 1024 * 1024,
            cardinalityLimit: options.cardinalityLimit ?? 2000, maxInstruments: options.maxInstruments ?? 256,
            maxAttributes: options.maxAttributes ?? 32, maxAttributeBytes: options.maxAttributeBytes ?? 4096,
        };
        for (const value of Object.values(this.settings))
            if (!Number.isSafeInteger(value) || value <= 0)
                throw new Error("SDK limits and timeouts must be positive integers");
        if (this.settings.retryMaxMs < this.settings.retryMinMs || this.settings.maxBatchBytes > this.settings.queueBytes)
            throw new Error("invalid retry/batch limits");
        this.instanceId = options.instanceId ?? uuid();
        const resource = this.attributes(options.resource ?? {});
        if (resource.some(a => a.key === "service.name" || a.key === "service.instance.id"))
            throw new Error("configure service identity separately");
        this.resource = { attributes: [...resource, { key: "service.name", value: { stringValue: options.service } }, { key: "service.instance.id", value: { stringValue: this.instanceId } }] };
        const mode = options.mode ?? "direct";
        if (!["agent", "direct", "auto"].includes(mode))
            throw new Error("mode must be agent, direct, or auto");
        const selectedRoute = mode === "agent" || (mode === "auto" && options.agentEndpoint) ? "agent" : "direct";
        const routeEndpoint = selectedRoute === "agent" ? (options.agentEndpoint ?? "http://127.0.0.1:4318") : options.endpoint;
        if (!options.exporter) {
            const endpoint = new URL(routeEndpoint ?? "");
            if (!/^https?:$/.test(endpoint.protocol))
                throw new Error("endpoint must use HTTP or HTTPS");
        }
        if (mode === "auto" && !options.exporter && !options.agentEndpoint && (!options.endpoint || !options.key))
            throw new Error("auto_route_unavailable: configure an Agent or direct credentials");
        if (mode === "agent" && !options.exporter && !options.localToken && options.agentEndpoint && !options.agentEndpoint.startsWith("http://127.0.0.1"))
            throw new Error("agent mode requires local token for non-loopback endpoint");
        this.stats.configuredMode = mode;
        this.stats.selectedRoute = selectedRoute;
        this.stats.agentProbe = mode === "auto" ? "pending" : "not_probed";
        this.stats.credentialSource = "explicit";
        this.exporter = options.exporter ?? (mode === "auto" ? new AutoExporter(options.agentEndpoint ?? "http://127.0.0.1:4318", options.localToken, options.endpoint, options.key, this.stats) : new HTTPExporter(routeEndpoint, () => selectedRoute === "agent" ? this.options.localToken : this.options.key));
        this.interval = setInterval(() => { if (!this.closing) {
            this.collect();
            this.kick();
        } }, this.settings.intervalMs);
        // A library timer should not prevent an otherwise finished Node process exiting.
        const timer = this.interval;
        timer.unref?.();
        this.selfInterval = setInterval(() => { if (!this.closing) {
            this.collectSelf();
            this.kick();
        } }, 30_000);
        this.selfInterval.unref?.();
        if (options.remoteConfig !== false && (options.configEndpoint || options.endpoint)) {
            this.configInterval = setInterval(() => { if (!this.closing)
                void this.refreshConfig().catch(error => { this.stats.configError = error instanceof Error ? error.message : String(error); }); }, options.configIntervalMs ?? 30_000);
            this.configInterval.unref?.();
        }
    }
    updateLogSampling(policies) {
        const snapshot = {};
        for (const [table, p] of Object.entries(policies)) {
            if (!validTable(table) || ['lightmoni_center', 'lightmoni_agent', 'lightmoni_sdk'].includes(table))
                throw new Error('invalid log policy table');
            snapshot[table] = copyLogSampling(p);
        }
        this.localSampling = snapshot;
    }
    setReportingDisabled(disabled) {
        if (this.stats.reportingDisabled === disabled)
            return;
        this.stats.reportingDisabled = disabled;
        if (disabled) {
            this.reportingGeneration++;
            this.request?.abort();
            this.retryNow?.();
            this.stats.disabledRecords += this.queue.reduce((n, q) => n + q.records, 0) + [...this.logs.values(), ...this.spans.values()].reduce((n, rows) => n + rows.length, 0);
            for (const m of this.instruments.values()) {
                this.stats.disabledRecords += m.series.size;
                m.series.clear();
                m.start = nowNano();
            }
            this.queue.length = 0;
            this.logs.clear();
            this.spans.clear();
            this.stats.pendingBytes = 0;
            this.stats.pendingBatches = 0;
            this.stats.bufferBytes = 0;
        }
        else {
            this.selfLast = -Infinity;
            for (const m of this.instruments.values())
                m.start = nowNano();
        }
        this.notify();
    }
    refreshConfig() {
        if (this.configLoading)
            return this.configLoading;
        this.configLoading = this.fetchConfig().finally(() => { this.configLoading = undefined; });
        return this.configLoading;
    }
    async fetchConfig() {
        const endpoint = this.options.configEndpoint ?? this.options.endpoint;
        if (!endpoint || this.closing)
            throw new Error('remote configuration is disabled or SDK closed');
        const request = new AbortController();
        this.configRequest = request;
        const timer = setTimeout(() => request.abort(), 5000);
        try {
            const response = await fetch(endpoint.replace(/\/$/, '') + '/v1/sdk-config', { headers: this.options.key ? { Authorization: `Bearer ${this.options.key}` } : {}, signal: request.signal, redirect: 'error' });
            if (response.status !== 200) {
                void response.body?.cancel();
                throw new Error(`SDK configuration HTTP ${response.status}`);
            }
            if (!response.body)
                throw new Error('missing SDK configuration');
            const reader = response.body.getReader(), parts = [];
            let length = 0;
            while (true) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                length += chunk.value.length;
                if (length > 1024 * 1024) {
                    await reader.cancel();
                    throw new Error('SDK configuration exceeds 1 MiB');
                }
                parts.push(chunk.value);
            }
            const raw = new Uint8Array(length);
            let offset = 0;
            for (const part of parts) {
                raw.set(part, offset);
                offset += part.length;
            }
            const config = JSON.parse(new TextDecoder().decode(raw));
            if (!config || typeof config.revision !== 'string' || !config.revision || config.revision.length > 128 || !config.log_sampling || Array.isArray(config.log_sampling) || typeof config.log_sampling !== 'object' || Object.keys(config.log_sampling).length > 200 || Object.keys(config).some(k => !['revision', 'log_sampling', 'disable_rules'].includes(k)))
                throw new Error('invalid SDK configuration');
            const policies = {};
            for (const [table, p] of Object.entries(config.log_sampling)) {
                if (!validTable(table) || ['lightmoni_center', 'lightmoni_agent', 'lightmoni_sdk'].includes(table))
                    throw new Error('invalid log policy table');
                policies[table] = copyLogSampling(p);
            }
            const disable = copyExclusions(config.disable_rules ?? [], true);
            if (this.closing)
                return;
            this.remoteSampling = policies;
            this.remoteDisabled = disable.some(rule => matches(rule.conditions, this.samplingRecord()));
            this.setReportingDisabled(!!this.options.disabled || this.remoteDisabled);
            this.stats.configRevision = config.revision;
            this.stats.configError = undefined;
        }
        catch (error) {
            throw new Error(error instanceof Error && error.message.startsWith('SDK configuration') ? error.message : 'SDK configuration unavailable or invalid');
        }
        finally {
            clearTimeout(timer);
            this.configRequest = undefined;
        }
    }
    samplingRecord(attrs = {}, level = '', context) { return { record: { service: this.options.service, instance_id: this.instanceId, 'sdk.language': 'typescript', severity: level.toUpperCase(), trace_id: context?.traceId, event_id: `${this.instanceId}:${this.sourceSequence}` }, attributes: attrs, resource: { ...this.options.resource, 'service.name': this.options.service, 'service.instance.id': this.instanceId } }; }
    attributes(attrs) {
        const keys = Object.keys(attrs).sort();
        if (keys.length > this.settings.maxAttributes)
            throw new Error("attribute count exceeded");
        const values = keys.map(key => { if (!key || encoder.encode(key).length > 128)
            throw new Error("invalid attribute key"); return { key, value: otlpValue(attrs[key]) }; });
        if (encoder.encode(JSON.stringify(values)).length > this.settings.maxAttributeBytes)
            throw new Error("attribute bytes exceeded");
        return values;
    }
    invalid(error) { this.stats.invalidRecords++; this.stats.lastError = error instanceof Error ? error.message : String(error); }
    lost(records, message) {
        this.stats.droppedRecords += records;
        this.failureSequence = this.sequence;
        this.failure = new Error(message);
        this.stats.lastError = message;
    }
    store(map, table, record) {
        if (this.closing) {
            this.invalid("record after shutdown");
            return;
        }
        if (this.stats.reportingDisabled) {
            this.stats.disabledRecords++;
            return;
        }
        const size = encoder.encode(JSON.stringify(record)).length + 64;
        if (this.stats.bufferBytes + size > this.settings.bufferBytes) {
            this.lost(1, "SDK record buffer capacity exceeded; telemetry lost");
            return;
        }
        this.stats.bufferBytes += size;
        const rows = map.get(table) ?? [];
        rows.push(record);
        map.set(table, rows);
    }
    instrument(table, name, kind, options) {
        if (this.closing || !name || encoder.encode(name).length > 255 || (options.unit?.length ?? 0) > 64 || (options.description?.length ?? 0) > 1024)
            throw new Error("invalid metric identity or SDK closed");
        const boundaries = kind === "histogram" ? [...(options.boundaries ?? [5, 10, 25, 50, 100, 250, 500, 1000])] : [];
        if (boundaries.length > 128 || boundaries.some((n, i) => !finite(n) || (i > 0 && boundaries[i - 1] >= n)))
            throw new Error("histogram boundaries must be finite and increasing");
        const key = `${table}\0${name}`, existing = this.instruments.get(key);
        const normalized = { unit: options.unit ?? "", description: options.description ?? "", boundaries };
        if (existing) {
            if (existing.kind !== kind || existing.options.unit !== normalized.unit || JSON.stringify(existing.options.boundaries) !== JSON.stringify(boundaries))
                throw new Error("conflicting metric registration");
            return existing;
        }
        if (this.instruments.size >= this.settings.maxInstruments)
            throw new Error("instrument limit exceeded");
        const instrument = { table, name, kind, options: normalized, series: new Map(), start: nowNano() };
        this.instruments.set(key, instrument);
        return instrument;
    }
    record(metric, value, attrs) {
        if (this.closing) {
            this.invalid("metric after shutdown");
            return;
        }
        if (this.stats.reportingDisabled) {
            this.stats.disabledRecords++;
            return;
        }
        let attributes;
        try {
            attributes = this.attributes(attrs);
        }
        catch (e) {
            this.invalid(e);
            return;
        }
        let integer = 0n;
        if (metric.kind === "counter") {
            if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
                this.invalid("counter requires a nonnegative safe integer or bigint");
                return;
            }
            integer = BigInt(value);
            if (integer < 0 || integer > maxInt64) {
                this.invalid("counter increment outside Int64");
                return;
            }
        }
        else if (typeof value !== "number" || !finite(value)) {
            this.invalid("metric requires a finite number");
            return;
        }
        let key = JSON.stringify(attributes), point = metric.series.get(key);
        if (!point && metric.series.size >= this.settings.cardinalityLimit) {
            key = "overflow";
            attributes = [{ key: "otel.metric.overflow", value: { boolValue: true } }];
            point = metric.series.get(key);
            this.stats.overflowRecords++;
        }
        if (!point) {
            const cost = encoder.encode(key).length + 128 + 8 * ((metric.options.boundaries?.length ?? 0) + 1);
            if (this.stats.bufferBytes + cost > this.settings.bufferBytes) {
                this.lost(1, "SDK aggregate buffer capacity exceeded; telemetry lost");
                return;
            }
            this.stats.bufferBytes += cost;
            const n = Number(value);
            point = { attributes, integer: 0n, value: 0, count: 0n, buckets: (metric.options.boundaries ?? []).map(() => 0n).concat(0n), observed: nowNano(), min: n, max: n };
            metric.series.set(key, point);
        }
        if (metric.kind === "counter") {
            if (point.integer + integer > maxInt64) {
                this.invalid("counter overflow");
                return;
            }
            point.integer += integer;
        }
        else if (metric.kind === "gauge")
            point.value = Number(value);
        else {
            const n = Number(value);
            if (!finite(point.value + n) || point.count === maxUint64) {
                this.invalid("histogram overflow");
                return;
            }
            point.value += n;
            point.count++;
            let bucket = (metric.options.boundaries ?? []).findIndex(b => n <= b);
            if (bucket < 0)
                bucket = point.buckets.length - 1;
            point.buckets[bucket]++;
            point.min = Math.min(point.min, n);
            point.max = Math.max(point.max, n);
        }
        point.observed = nowNano();
    }
    collect() {
        if (this.stats.reportingDisabled)
            return;
        const at = new Date().toISOString(), end = nowNano();
        const tables = new Set([...this.logs.keys(), ...this.spans.keys(), ...Array.from(this.instruments.values(), i => i.table)]);
        for (const table of [...tables].sort()) {
            const metrics = [];
            for (const m of [...this.instruments.values()].sort((a, b) => a.name.localeCompare(b.name)))
                if (m.table === table) {
                    const finish = end < m.start ? m.start : end;
                    for (const [, p] of [...m.series].sort(([a], [b]) => a.localeCompare(b))) {
                        const point = { attributes: p.attributes, timeUnixNano: nano(m.kind === "gauge" ? p.observed : finish) };
                        const record = { name: m.name, unit: m.options.unit, description: m.options.description };
                        if (m.kind === "counter") {
                            Object.assign(point, { startTimeUnixNano: nano(m.start), asInt: p.integer.toString() });
                            record.sum = { dataPoints: [point], aggregationTemporality: 1, isMonotonic: true };
                        }
                        else if (m.kind === "gauge") {
                            point.asDouble = p.value;
                            record.gauge = { dataPoints: [point] };
                        }
                        else {
                            Object.assign(point, { startTimeUnixNano: nano(m.start), explicitBounds: m.options.boundaries, bucketCounts: p.buckets.map(String), count: p.count.toString(), sum: p.value, min: p.min, max: p.max });
                            record.histogram = { dataPoints: [point], aggregationTemporality: 1 };
                        }
                        metrics.push(record);
                    }
                    m.series.clear();
                    m.start = finish;
                }
            this.pack("metrics", table, metrics, at);
            this.pack("logs", table, this.logs.get(table) ?? [], at);
            this.pack("traces", table, this.spans.get(table) ?? [], at);
        }
        this.logs.clear();
        this.spans.clear();
        this.stats.bufferBytes = 0;
        this.collectSelf();
    }
    collectSelf() {
        const clock = performance.now();
        if (this.stats.reportingDisabled || this.options.selfTelemetry === false || clock - this.selfLast < 30_000)
            return;
        this.selfLast = clock;
        const at = new Date().toISOString(), time = nano(nowNano());
        const attributes = [{ key: 'lightmoni.component', value: { stringValue: 'sdk' } }, { key: 'sdk.language', value: { stringValue: 'typescript' } }, { key: 'sdk.version', value: { stringValue: '0.1.0' } }];
        const values = { heartbeat: 1, pending_batches: this.stats.pendingBatches, pending_bytes: this.stats.pendingBytes, retried_batches: this.stats.retriedBatches, dropped_records: this.stats.droppedRecords, rejected_records: this.stats.rejectedRecords, invalid_records: this.stats.invalidRecords, overflow_records: this.stats.overflowRecords };
        this.enqueueSelf('metrics', Object.entries(values).map(([name, value]) => ({ name: `lightmoni.sdk.${name}`, gauge: { dataPoints: [{ timeUnixNano: time, attributes, asDouble: value }] } })), at);
        const changed = this.selfPrevious && ['retriedBatches', 'droppedRecords', 'rejectedRecords', 'invalidRecords', 'overflowRecords'].some(key => this.stats[key] > this.selfPrevious[key]);
        if (!this.selfStarted || changed) {
            const event = this.selfStarted ? 'diagnostics_changed' : 'started';
            const row = { timeUnixNano: time, severityText: changed ? 'WARN' : 'INFO', severityNumber: changed ? 13 : 9, body: { stringValue: changed ? 'LightMoni SDK delivery, buffer or input diagnostics changed' : 'LightMoni SDK started' }, attributes: [...attributes, ...this.attributes({ event })] };
            if (this.enqueueSelf('logs', [row], at)) {
                this.selfStarted = true;
                this.selfPrevious = { ...this.stats };
            }
        }
    }
    enqueueSelf(signal, rows, at) {
        const bytes = this.payload(signal, rows).length;
        if (bytes > this.settings.maxBatchBytes || this.queue.length >= this.settings.queueBatches || this.stats.pendingBytes + bytes > this.settings.queueBytes)
            return false;
        this.enqueue(signal, this.options.table, rows, at);
        return true;
    }
    payload(signal, records) {
        const scope = { name: "lightmoni/sdk/typescript" };
        if (signal === "metrics") {
            const merged = new Map();
            for (const record of records) {
                const name = String(record.name), previous = merged.get(name);
                if (!previous) {
                    merged.set(name, structuredClone(record));
                    continue;
                }
                for (const kind of ["sum", "gauge", "histogram"])
                    if (previous[kind]) {
                        const before = previous[kind];
                        before.dataPoints.push(...record[kind].dataPoints);
                    }
            }
            return encoder.encode(JSON.stringify({ resourceMetrics: [{ resource: this.resource, scopeMetrics: [{ scope, metrics: [...merged.values()] }] }] }));
        }
        if (signal === "logs")
            return encoder.encode(JSON.stringify({ resourceLogs: [{ resource: this.resource, scopeLogs: [{ scope, logRecords: records }] }] }));
        return encoder.encode(JSON.stringify({ resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope, spans: records }] }] }));
    }
    pack(signal, table, records, at) {
        let group = [];
        const baseSize = this.payload(signal, []).length;
        let size = baseSize;
        for (const record of records) {
            // Before merging same-name metrics this is an upper bound on the final
            // JSON size. Each record is encoded once rather than growing O(n²).
            const cost = encoder.encode(JSON.stringify(record)).length + 1;
            if (group.length && size + cost > this.settings.maxBatchBytes) {
                this.enqueue(signal, table, group, at);
                group = [];
                size = baseSize;
            }
            group.push(record);
            size += cost;
        }
        if (group.length)
            this.enqueue(signal, table, group, at);
    }
    enqueue(signal, table, records, at) {
        const payload = this.payload(signal, records);
        this.sequence++;
        if (payload.length > this.settings.maxBatchBytes || this.queue.length >= this.settings.queueBatches || this.stats.pendingBytes + payload.length > this.settings.queueBytes) {
            this.lost(records.length, "SDK queue or batch capacity exceeded; telemetry lost");
            return;
        }
        this.queue.push({ sequence: this.sequence, records: records.length, batch: { signal, table, service: this.options.service, id: uuid(), createdAt: at, contentType: "application/json", payload } });
        this.stats.pendingBytes += payload.length;
        this.stats.pendingBatches++;
    }
    notify() { for (const changed of [...this.changed])
        changed(); }
    kick() { if (!this.working && !this.stopped)
        void this.pump(); }
    async pump() {
        this.working = true;
        let backoff = this.settings.retryMinMs;
        try {
            while (this.queue.length && !this.stopped) {
                const item = this.queue[0];
                this.request = new AbortController();
                const timer = setTimeout(() => this.request?.abort(), this.settings.requestTimeoutMs);
                let failure;
                try {
                    await this.exporter.deliver({ ...item.batch, payload: item.batch.payload.slice() }, this.request.signal);
                }
                catch (error) {
                    failure = error;
                }
                finally {
                    clearTimeout(timer);
                    this.request = undefined;
                }
                if (this.stopped)
                    break;
                if (this.queue[0] !== item) {
                    backoff = this.settings.retryMinMs;
                    continue;
                }
                if (!failure) {
                    this.queue.shift();
                    this.stats.pendingBatches--;
                    this.stats.pendingBytes -= item.batch.payload.length;
                    this.stats.deliveredBatches++;
                    backoff = this.settings.retryMinMs;
                    this.notify();
                    continue;
                }
                this.stats.lastError = failure instanceof Error ? failure.message : String(failure);
                if (failure instanceof DeliveryError && !failure.retryable) {
                    this.queue.shift();
                    this.stats.pendingBatches--;
                    this.stats.pendingBytes -= item.batch.payload.length;
                    this.stats.rejectedRecords += failure.rejectedRecords || item.records;
                    this.failure = failure;
                    this.failureSequence = item.sequence;
                    this.notify();
                    backoff = this.settings.retryMinMs;
                    continue;
                }
                this.stats.retriedBatches++;
                const delay = Math.max(Math.floor(backoff * (0.5 + Math.random() / 2)), failure instanceof DeliveryError ? failure.retryAfterMs : 0);
                await new Promise(resolve => { const timer = setTimeout(() => { this.retryNow = undefined; resolve(); }, delay); this.retryNow = () => { clearTimeout(timer); this.retryNow = undefined; resolve(); }; });
                backoff = Math.min(backoff * 2, this.settings.retryMaxMs);
            }
        }
        finally {
            this.working = false;
            this.notify();
        }
    }
    async wait(target, timeoutMs) {
        const until = Date.now() + timeoutMs;
        while (this.queue.length && this.queue[0].sequence <= target) {
            if (this.stopped)
                throw new Error("SDK stopped before durable acknowledgment");
            const remaining = until - Date.now();
            if (remaining <= 0)
                throw new Error("flush incomplete: timeout before durable acknowledgment");
            await new Promise(resolve => { const done = () => { clearTimeout(timer); this.changed.delete(done); resolve(); }; const timer = setTimeout(done, remaining); this.changed.add(done); });
        }
        if (this.failure && this.failureSequence <= target)
            throw this.failure;
    }
}
export class Counter {
    state;
    metric;
    constructor(state, metric) {
        this.state = state;
        this.metric = metric;
    }
    add(value, attrs = {}) { this.state.record(this.metric, value, attrs); }
}
export class Gauge {
    state;
    metric;
    constructor(state, metric) {
        this.state = state;
        this.metric = metric;
    }
    record(value, attrs = {}) { this.state.record(this.metric, value, attrs); }
}
export class Histogram {
    state;
    metric;
    constructor(state, metric) {
        this.state = state;
        this.metric = metric;
    }
    record(value, attrs = {}) { this.state.record(this.metric, value, attrs); }
}
export class LightMoni {
    state;
    table;
    boundTrace;
    constructor(state, table, boundTrace) {
        this.state = state;
        this.table = table;
        this.boundTrace = boundTrace;
    }
    static create(options) { return new LightMoni(new State({ ...options }), options.table); }
    get meter() { return this; }
    get instanceId() { return this.state.instanceId; }
    withTable(table) { if (!validTable(table))
        throw new Error("invalid logical table"); return new LightMoni(this.state, table, this.boundTrace); }
    currentTrace() {
        const value = this.boundTrace ?? this.state.options.contextProvider?.();
        return validTrace(value) ? { ...value } : undefined;
    }
    /** Immutable binding, safe across concurrent browser tasks and table clients. */
    withTrace(context) {
        if (!validTrace(context))
            throw new Error("invalid trace context");
        return new LightMoni(this.state, this.table, Object.freeze({ ...context }));
    }
    withSpan(name, action, attrs = {}, parent = this.currentTrace()) {
        const span = this.startSpan(name, attrs, parent), client = this.withTrace(span.context);
        const run = () => {
            try {
                const result = action(client, span);
                if (result != null && typeof result.then === "function") {
                    return Promise.resolve(result).then(value => { span.end(); return value; }, error => { span.setError(error); span.end(); throw error; });
                }
                span.end();
                return result;
            }
            catch (error) {
                span.setError(error);
                span.end();
                throw error;
            }
        };
        try {
            return this.state.options.contextRunner ? this.state.options.contextRunner(span.context, run) : run();
        }
        catch (error) {
            span.setError(error);
            span.end();
            throw error;
        }
    }
    /** Use within a request/task scope to propagate its W3C context downstream. */
    fetch(input, init) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const trace = this.currentTrace();
        if (trace) {
            headers.delete("tracestate");
            for (const [key, value] of Object.entries(injectTrace(trace)))
                headers.set(key, value);
        }
        return globalThis.fetch(input, { ...init, headers });
    }
    counter(name, options = {}) { return new Counter(this.state, this.state.instrument(this.table, name, "counter", options)); }
    gauge(name, options = {}) { return new Gauge(this.state, this.state.instrument(this.table, name, "gauge", options)); }
    histogram(name, options = {}) { return new Histogram(this.state, this.state.instrument(this.table, name, "histogram", options)); }
    stats() { return { ...this.state.stats }; }
    updateKey(key) { this.state.options.key = key; this.state.retryNow?.(); }
    updateLogSampling(policies) { if (this.state.closing)
        throw new Error('SDK closed'); this.state.updateLogSampling(policies); }
    setReportingEnabled(enabled) { this.state.options.disabled = !enabled; this.state.setReportingDisabled(!enabled || this.state.remoteDisabled); }
    async refreshConfig() { await this.state.refreshConfig(); }
    /** Trace metadata is optional and separate from attrs; no context creates no trace. */
    log(level, body, attrs = {}, context = this.currentTrace()) {
        if (this.state.closing) {
            this.state.invalid('record after shutdown');
            return;
        }
        if (this.state.stats.reportingDisabled) {
            this.state.stats.disabledRecords++;
            return;
        }
        if (encoder.encode(body).length > 64 * 1024) {
            this.state.invalid("log body exceeded 64 KiB");
            return;
        }
        let attributes;
        try {
            attributes = this.state.attributes(attrs);
        }
        catch (e) {
            this.state.invalid(e);
            return;
        }
        this.state.sourceSequence++;
        if (!validTrace(context))
            context = undefined;
        const policy = this.state.remoteSampling[this.table] ?? this.state.localSampling[this.table];
        if (policy) {
            const decision = sampleLog(policy, this.table, this.state.samplingRecord(attrs, level, context));
            if (!decision.keep) {
                if (decision.reason === 'excluded')
                    this.state.stats.excludedLogs++;
                else if (decision.reason === 'unmatched')
                    this.state.stats.unmatchedLogs++;
                else
                    this.state.stats.sampledOutLogs++;
                return;
            }
            attributes = attributes.filter(a => !['lightmoni.sampling.rate', 'lightmoni.sampling.weight', 'lightmoni.sampling.rule'].includes(a.key));
            attributes.push({ key: 'lightmoni.sampling.rate', value: { doubleValue: decision.rate } }, { key: 'lightmoni.sampling.weight', value: { doubleValue: 1 / decision.rate } }, { key: 'lightmoni.sampling.rule', value: { stringValue: decision.reason } });
        }
        attributes = attributes.filter(a => a.key !== "lightmoni.source_id" && a.key !== "lightmoni.source_seq");
        attributes.push({ key: "lightmoni.source_id", value: { stringValue: this.state.instanceId } }, { key: "lightmoni.source_seq", value: { intValue: this.state.sourceSequence.toString() } });
        const time = nano(nowNano()), severity = { trace: 1, debug: 5, info: 9, warn: 13, warning: 13, error: 17, fatal: 21 }[level.toLowerCase()] ?? 9;
        const record = { timeUnixNano: time, observedTimeUnixNano: time, severityNumber: severity, severityText: level.toUpperCase(), body: { stringValue: body }, attributes };
        if (validTrace(context))
            Object.assign(record, { traceId: context.traceId, spanId: context.spanId, flags: context.flags });
        this.state.store(this.state.logs, this.table, record);
    }
    startSpan(name, attrs = {}, parent = this.currentTrace()) { return new Span(this.state, this.table, name, attrs, parent ?? undefined); }
    async flush({ timeoutMs = 10_000 } = {}) { if (this.state.stopped)
        throw new Error("SDK is closed"); this.state.collect(); const target = this.state.sequence; this.state.kick(); await this.state.wait(target, timeoutMs); }
    async shutdown({ timeoutMs = 10_000 } = {}) {
        if (this.state.stopped) {
            if (this.state.failure)
                throw this.state.failure;
            return;
        }
        this.state.closing = true;
        clearInterval(this.state.interval);
        clearInterval(this.state.selfInterval);
        clearInterval(this.state.configInterval);
        this.state.configRequest?.abort();
        try {
            await this.flush({ timeoutMs });
        }
        finally {
            this.state.stopped = true;
            this.state.request?.abort();
            this.state.retryNow?.();
            this.state.notify();
        }
    }
}
export function createLightMoni(options) { return LightMoni.create(options); }
export class Span {
    state;
    table;
    context;
    data;
    ended = false;
    reportingGeneration;
    suppressed;
    constructor(state, table, name, attrs, parent) {
        this.state = state;
        this.table = table;
        this.reportingGeneration = state.reportingGeneration;
        this.suppressed = state.stats.reportingDisabled;
        if (!validTrace(parent))
            parent = undefined;
        this.context = { traceId: parent?.traceId ?? uuid().replaceAll("-", ""), spanId: uuid().replaceAll("-", "").slice(0, 16), flags: parent?.flags ?? 1, traceState: parent?.traceState };
        let attributes = [];
        try {
            attributes = state.attributes(attrs);
        }
        catch (e) {
            state.invalid(e);
        }
        this.data = { traceId: this.context.traceId, spanId: this.context.spanId, name, kind: 1, flags: this.context.flags, startTimeUnixNano: nano(nowNano()), attributes };
        if (parent) {
            this.data.parentSpanId = parent.spanId;
            if (parent.traceState)
                this.data.traceState = parent.traceState;
        }
    }
    setError(error) { if (!this.ended)
        this.data.status = { code: 2, message: String(error).slice(0, 4096) }; }
    setKind(kind) { if (!this.ended)
        this.data.kind = kind; }
    end() { if (this.ended)
        return; this.ended = true; if (this.suppressed || this.reportingGeneration !== this.state.reportingGeneration) {
        this.state.stats.disabledRecords++;
        return;
    } const time = nowNano(), start = BigInt(String(this.data.startTimeUnixNano)); this.data.endTimeUnixNano = nano(time < start ? start : time); const name = String(this.data.name); if (!name || encoder.encode(name).length > 255) {
        this.state.invalid("invalid span name");
        return;
    } this.state.store(this.state.spans, this.table, this.data); }
}
export function extractTrace(headers) {
    const normalized = headers instanceof Headers ? headers : Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const parent = normalized instanceof Headers ? normalized.get("traceparent") : normalized.traceparent;
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(parent ?? "");
    if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
        return undefined;
    const traceState = normalized instanceof Headers ? normalized.get("tracestate") : normalized.tracestate;
    return { traceId: match[1], spanId: match[2], flags: Number.parseInt(match[3], 16), traceState: traceState && traceState.length <= 512 ? traceState : undefined };
}
export function injectTrace(context) { if (!validTrace(context))
    throw new Error("invalid trace context"); return { traceparent: `00-${context.traceId}-${context.spanId}-${context.flags.toString(16).padStart(2, "0")}`, ...(context.traceState ? { tracestate: context.traceState } : {}) }; }
export class HTTPExporter {
    endpoint;
    key;
    constructor(endpoint, key = () => undefined) {
        this.endpoint = endpoint;
        this.key = key;
    }
    async deliver(batch, signal) {
        const headers = { "Content-Type": batch.contentType, "X-Lightmoni-Table": batch.table, "X-Lightmoni-Batch-ID": batch.id, "X-Lightmoni-Batch-Created-At": batch.createdAt };
        const key = this.key();
        if (key)
            headers.Authorization = `Bearer ${key}`;
        let response;
        try {
            response = await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/${batch.signal}`, { method: "POST", headers, body: batch.payload.slice().buffer, signal, redirect: "error" });
        }
        catch {
            throw new DeliveryError("telemetry network request failed", true);
        }
        if (response.status !== 200) {
            const retryable = [401, 403, 429, 502, 503, 504].includes(response.status), retry = response.headers.get("Retry-After");
            let delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Math.max(0, Date.parse(retry) - Date.now()) || 0 : 0;
            if (response.status === 401 || response.status === 403)
                delay = Math.max(delay, 30_000);
            void response.body?.cancel();
            throw new DeliveryError(`telemetry rejected with HTTP ${response.status}`, retryable, delay);
        }
        if (!response.body)
            return;
        const reader = response.body.getReader();
        let bytes = 0;
        const parts = [];
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                bytes += chunk.value.length;
                if (bytes > 64 * 1024) {
                    await reader.cancel();
                    throw new DeliveryError("telemetry response size exceeded");
                }
                parts.push(chunk.value);
            }
        }
        catch (e) {
            if (e instanceof DeliveryError)
                throw e;
            throw new DeliveryError("telemetry acknowledgment interrupted", true);
        }
        if (!bytes)
            return;
        const body = new Uint8Array(bytes);
        let at = 0;
        for (const part of parts) {
            body.set(part, at);
            at += part.length;
        }
        if (!response.headers.get("Content-Type")?.startsWith("application/json"))
            throw new DeliveryError("expected an OTLP JSON acknowledgment", true);
        let result;
        try {
            result = JSON.parse(new TextDecoder().decode(body));
        }
        catch {
            throw new DeliveryError("invalid OTLP JSON acknowledgment", true);
        }
        const partial = result.partialSuccess;
        if (partial) {
            const rejected = Number(partial.rejectedLogRecords ?? partial.rejectedDataPoints ?? partial.rejectedSpans ?? 0);
            if (rejected > 0)
                throw new DeliveryError("OTLP partial success (not retried)", false, 0, rejected);
        }
    }
}
/** Auto mode probes only the configured local Agent once, before the first
 * business body. A failed probe may safely select direct; delivery failures
 * after selection never switch routes for the same batch. */
class AutoExporter {
    agentEndpointValue;
    localToken;
    stats;
    selected;
    agent;
    direct;
    constructor(agentEndpointValue, localToken, endpoint, key, stats) {
        this.agentEndpointValue = agentEndpointValue;
        this.localToken = localToken;
        this.stats = stats;
        this.agent = new HTTPExporter(agentEndpointValue, () => localToken);
        this.direct = endpoint ? new HTTPExporter(endpoint, () => key) : undefined;
    }
    async select(signal) {
        if (this.selected)
            return this.selected;
        const agentEndpoint = this.agentEndpointValue.replace(/\/$/, "");
        try {
            const headers = {};
            if (this.localToken)
                headers.Authorization = `Bearer ${this.localToken}`;
            const response = await fetch(`${agentEndpoint}/healthz`, { method: "GET", headers, signal, redirect: "error" });
            await response.body?.cancel();
            if (response.ok) {
                this.selected = "agent";
                this.stats.selectedRoute = "agent";
                this.stats.agentProbe = "healthy";
                return this.selected;
            }
            this.stats.agentProbe = `http_${response.status}`;
            // An HTTP response proves the endpoint exists. Auth/protocol failures
            // must remain visible and cannot silently bypass the configured Agent.
            throw new DeliveryError(`Agent health probe failed with HTTP ${response.status}`);
        }
        catch (error) {
            if (error instanceof DeliveryError || signal.aborted)
                throw error;
            this.stats.agentProbe = "unavailable";
        }
        if (!this.direct) {
            this.stats.lastRouteError = "auto_route_unavailable";
            throw new DeliveryError("auto_route_unavailable: Agent unavailable and direct credentials are missing");
        }
        this.selected = "direct";
        this.stats.selectedRoute = "direct";
        this.stats.fallbackCount = (this.stats.fallbackCount ?? 0) + 1;
        return this.selected;
    }
    async deliver(batch, signal) { const selected = await this.select(signal); if (selected === "agent")
        return this.agent.deliver(batch, signal); return this.direct.deliver(batch, signal); }
}
