import { createHash } from "node:crypto";
import { LosslessNumber, parse, stringify } from "lossless-json";
import { Decimal } from "decimal.js";
import type { DB } from "../shared/types.js";
import {
  AssistantError,
  type Config,
  type Event,
  type Session,
} from "./types.js";
import { canonicalBase, normalize } from "./provider.js";
export interface Billing {
  base_url: string;
  protocol: string;
  model: string;
  currency: string;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
}
export interface UsageRecord extends Record<string, any> {
  id: string;
  request_id?: string;
  status?: string;
  timestamp: string;
  user_id: string;
  session_id: string;
  turn_id: string;
  source: string;
  phase: string;
  base_url: string;
  protocol: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  currency: string;
  estimated_cost: number | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  input_estimated_cost: number | null;
  output_estimated_cost: number | null;
  cost_status?: string;
}
export const terminal = (status: string) =>
  ["succeeded", "failed", "cancelled"].includes(status);
export const validPrice = (value: any) =>
  value == null ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1e9);
const maxInt = 9223372036854775807n;
const exact = (value: bigint): any =>
  value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : new LosslessNumber(value.toString());
const count = (value: any): any => {
  if (value instanceof LosslessNumber) {
    if (value.value.length > 128) return null;
    try {
      const n = new Decimal(value.value);
      return n.isInteger() && n.gte(0) && n.lte(maxInt.toString())
        ? exact(BigInt(n.toFixed(0)))
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};
const sumCount = (a: any, b: any): any => {
  if (a == null || b == null) return null;
  const total = BigInt(String(a)) + BigInt(String(b));
  return total <= maxInt ? exact(total) : null;
};
const encode = (value: any) => stringify(value) ?? "null";
export const decode = (value: any): any =>
  parse(
    Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value).toString()
      : String(value),
    undefined,
    (raw) => {
      const n = Number(raw);
      return !Number.isInteger(n) || Number.isSafeInteger(n)
        ? n
        : new LosslessNumber(raw);
    },
  );
export function identity(c: Partial<Config>): Billing {
  const cfg = normalize(c);
  let base = cfg.base_url;
  try {
    base = canonicalBase(base, false);
  } catch {}
  return {
    base_url: base,
    protocol: cfg.protocol,
    model: cfg.model,
    currency: "CNY",
    input_price_per_million: null,
    output_price_per_million: null,
  };
}
export const sameIdentity = (a: Billing, b: Billing) =>
  a.base_url === b.base_url && a.protocol === b.protocol && a.model === b.model;
// Go's json.Marshal escapes HTML in strings. Preserve its billing-key identity.
export const billingKey = (b: Billing) =>
  "billing/" +
  createHash("sha256")
    .update(
      JSON.stringify([b.base_url, b.protocol, b.model])
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029"),
    )
    .digest("hex");
export function price(record: UsageRecord, b: Partial<Billing>): UsageRecord {
  record.input_price_per_million = b.input_price_per_million ?? null;
  record.output_price_per_million = b.output_price_per_million ?? null;
  const component = (tokens: number | null, rate: number | null) =>
    tokens != null &&
    Number(String(tokens)) >= 0 &&
    rate != null &&
    validPrice(rate) &&
    Number.isFinite((Number(String(tokens)) * rate) / 1e6)
      ? (Number(String(tokens)) * rate) / 1e6
      : null;
  record.input_estimated_cost = component(
    record.input_tokens,
    record.input_price_per_million,
  );
  record.output_estimated_cost = component(
    record.output_tokens,
    record.output_price_per_million,
  );
  record.estimated_cost = null;
  record.cost_status = "unpriced";
  if (
    record.input_estimated_cost != null ||
    record.output_estimated_cost != null
  ) {
    record.estimated_cost =
      (record.input_estimated_cost ?? 0) + (record.output_estimated_cost ?? 0);
    record.cost_status =
      record.input_estimated_cost != null &&
      record.output_estimated_cost != null
        ? "complete"
        : "partial";
  }
  return record;
}
export function fromEvent(
  event: Event,
  source: string,
): UsageRecord | undefined {
  if (event.type !== "turn.usage") return;
  const d = event.data,
    s = (key: string) => (typeof d[key] === "string" ? d[key] : ""),
    request = s("request_id"),
    input = count(d.input_tokens),
    output = count(d.output_tokens);
  let total = count(d.total_tokens);
  if (total == null) total = sumCount(input, output);
  const record: UsageRecord = {
    id: request
      ? `${event.session_id}/${event.turn_id}/request/${request}`
      : `${event.session_id}/${event.turn_id}/${event.sequence}`,
    timestamp: event.timestamp,
    user_id: s("user_id"),
    session_id: event.session_id,
    turn_id: event.turn_id,
    source: s("source") || source,
    phase: s("phase"),
    base_url: s("base_url"),
    protocol: s("protocol"),
    model: s("model"),
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    currency: s("currency"),
    estimated_cost: null,
    input_price_per_million: null,
    output_price_per_million: null,
    input_estimated_cost: null,
    output_estimated_cost: null,
  };
  if (request) {
    record.request_id = request;
    if (terminal(s("status")) || s("status") === "pending")
      record.status = s("status");
  }
  record.cost_status = "unpriced";
  return record;
}
export function merge(
  existing: UsageRecord,
  incoming: UsageRecord,
): UsageRecord | undefined {
  if (
    existing.status !== "pending" ||
    !terminal(incoming.status || "") ||
    existing.request_id !== incoming.request_id
  )
    return;
  const r = {
    ...existing,
    status: incoming.status,
    completed_at: incoming.completed_at || incoming.timestamp,
    ...(incoming.failure_reason
      ? { failure_reason: incoming.failure_reason }
      : {}),
  };
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const)
    if (incoming[key] != null) r[key] = incoming[key];
  if (r.total_tokens == null)
    r.total_tokens = sumCount(r.input_tokens, r.output_tokens);
  return price(r, existing);
}
// Index nanoseconds separately to retain exact ordering.
function instant(value: string): [number, number] {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error("invalid assistant usage timestamp");
  const fraction = value.match(/\.(\d+)/)?.[1] || "";
  return [
    Math.floor(Date.parse(value) / 1000),
    Number(fraction.padEnd(9, "0")),
  ];
}
export class Store {
  constructor(
    readonly db: DB,
    readonly now: () => Date,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_records(id TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS assistant_usage(id TEXT PRIMARY KEY,timestamp_seconds INTEGER NOT NULL,timestamp_nanos INTEGER NOT NULL,value BLOB NOT NULL); CREATE INDEX IF NOT EXISTS assistant_usage_timestamp ON assistant_usage(timestamp_seconds,timestamp_nanos,id);",
    );
  }
  get<T = any>(id: string): T | undefined {
    const row = this.db.get<{ value: any }>(
      "SELECT value FROM assistant_records WHERE id=?",
      id,
    );
    return row ? decode(row.value) : undefined;
  }
  put(id: string, value: any): void {
    this.db.run(
      "INSERT INTO assistant_records(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      id,
      Buffer.from(encode(value)),
    );
  }
  sessions(prefix: string): Session[] {
    return this.db
      .all<{
        value: any;
      }>(`SELECT value FROM assistant_records WHERE substr(id,1,?)=? ORDER BY COALESCE(json_extract(CAST(value AS TEXT),'$.updated_at'),'') DESC,id LIMIT 200`, prefix.length, prefix)
      .flatMap((row) => {
        try {
          return [decode(row.value)];
        } catch {
          return [];
        }
      });
  }
  record(record: UsageRecord): void {
    if (!record.id?.trim()) throw Error("assistant usage requires an ID");
    const [seconds, nanos] = instant(record.timestamp);
    this.db.transaction(() => {
      const row = this.db.get<{ value: any }>(
        "SELECT value FROM assistant_usage WHERE id=?",
        record.id,
      );
      if (!row) {
        this.db.run(
          "INSERT OR IGNORE INTO assistant_usage(id,timestamp_seconds,timestamp_nanos,value) VALUES(?,?,?,?)",
          record.id,
          seconds,
          nanos,
          Buffer.from(encode(record)),
        );
        return;
      }
      const merged = merge(decode(row.value), record);
      if (merged)
        this.db.run(
          `UPDATE assistant_usage SET value=? WHERE id=? AND json_extract(CAST(value AS TEXT),'$.status')='pending'`,
          Buffer.from(encode(merged)),
          record.id,
        );
    });
  }
  recover(): void {
    for (const row of this.db.all<{ value: any }>(
      `SELECT value FROM assistant_usage WHERE json_extract(CAST(value AS TEXT),'$.status')='pending'`,
    )) {
      const record = decode(row.value) as UsageRecord;
      this.record({
        ...record,
        status: "failed",
        completed_at: this.now().toISOString(),
        failure_reason: "service_interrupted",
      });
    }
  }
  list(from: string, to: string, limit = 0): UsageRecord[] {
    const args: any[] = [],
      clauses: string[] = [];
    if (from) {
      clauses.push("(timestamp_seconds,timestamp_nanos)>=(?,?)");
      args.push(...instant(from));
    }
    if (to) {
      clauses.push("(timestamp_seconds,timestamp_nanos)<(?,?)");
      args.push(...instant(to));
    }
    if (from && to && Date.parse(from) > Date.parse(to))
      throw Error("assistant usage upper bound precedes lower bound");
    let sql =
      "SELECT value FROM assistant_usage" +
      (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
      " ORDER BY timestamp_seconds" +
      (limit ? " DESC" : "") +
      ",timestamp_nanos" +
      (limit ? " DESC" : "") +
      ",id" +
      (limit ? " DESC" : "");
    if (limit) {
      sql += " LIMIT ?";
      args.push(limit);
    }
    return this.db
      .all<{ value: any }>(sql, ...args)
      .map((row) => decode(row.value));
  }
  billing(config: Config): Billing {
    const b = identity(config),
      saved = this.get<Billing>(billingKey(b));
    if (!saved) return b;
    if (
      !sameIdentity(b, saved) ||
      !["CNY", "USD"].includes(saved.currency) ||
      !validPrice(saved.input_price_per_million) ||
      !validPrice(saved.output_price_per_million)
    )
      throw Error("invalid stored model pricing");
    return saved;
  }
}
export class Recorder {
  readonly pending = new Map<string, UsageRecord>();
  readonly completed = new Set<string>();
  constructor(
    readonly store: Store,
    readonly source: string,
    readonly user: string,
    readonly session: string,
    readonly turn: string,
    readonly billing: Billing,
  ) {}
  record(event: Event): void {
    if (!["turn.usage", "model.request.started"].includes(event.type)) return;
    const request = event.data.request_id;
    if (!request && event.type === "turn.usage") {
      const r = fromEvent(event, this.source);
      if (r)
        this.store.record(
          price(
            { ...r, user_id: this.user, source: this.source, ...this.billing },
            this.billing,
          ),
        );
      return;
    }
    if (typeof request !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request))
      throw Error("invalid model request ID");
    if (
      this.completed.has(request) ||
      (this.pending.has(request) && event.type === "model.request.started")
    )
      return;
    const status =
      event.type === "model.request.started" ? "pending" : event.data.status;
    if (status !== "pending" && !terminal(status))
      throw Error("invalid model request status");
    const r = fromEvent(
      {
        ...event,
        session_id: this.session,
        turn_id: this.turn,
        type: "turn.usage",
        timestamp: event.timestamp || this.store.now().toISOString(),
      },
      this.source,
    )!;
    Object.assign(r, {
      ...this.billing,
      user_id: this.user,
      source: this.source,
      status,
    });
    if (status === "pending")
      r.input_tokens = r.output_tokens = r.total_tokens = null;
    else r.completed_at = event.timestamp;
    price(r, this.billing);
    const merged = this.pending.has(request)
      ? merge(this.pending.get(request)!, r)
      : undefined;
    this.store.record(merged ?? r);
    if (status === "pending") this.pending.set(request, r);
    else {
      this.pending.delete(request);
      this.completed.add(request);
    }
  }
  finish(status: "failed" | "cancelled"): void {
    for (const [id, r] of this.pending) {
      this.store.record({
        ...r,
        status,
        completed_at: this.store.now().toISOString(),
      });
      this.pending.delete(id);
      this.completed.add(id);
    }
  }
}
function dateParts(
  at: Date,
  zone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return Object.fromEntries(
    parts
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as any;
}
function midnight(
  year: number,
  month: number,
  day: number,
  zone: string,
): Date {
  const target = new Date(Date.UTC(year, month - 1, day)),
    targetMs = target.getTime();
  let guess = targetMs;
  for (let i = 0; i < 4; i++) {
    const p = dateParts(new Date(guess), zone),
      local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second),
      delta = targetMs - local;
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}
const dateLabel = (date: Date, zone: string) => {
  const p = dateParts(date, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
export function window(
  at: Date,
  days: number,
  zone: string,
): { from: string; to: string; dates: string[] } {
  const today = dateParts(at, zone),
    start = new Date(
      Date.UTC(today.year, today.month - 1, today.day - days + 1),
    ),
    end = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10),
  );
  return {
    from: midnight(
      start.getUTCFullYear(),
      start.getUTCMonth() + 1,
      start.getUTCDate(),
      zone,
    ).toISOString(),
    to: midnight(
      end.getUTCFullYear(),
      end.getUTCMonth() + 1,
      end.getUTCDate(),
      zone,
    ).toISOString(),
    dates,
  };
}
export function options(url: URL): {
  days: number;
  limit: number;
  timezone: string;
} {
  const days = Number(url.searchParams.get("days") ?? 30),
    limit = Number(url.searchParams.get("limit") ?? 100),
    timezone = url.searchParams.get("timezone") || "UTC";
  if (![7, 30, 90].includes(days))
    throw new AssistantError(400, "days must be 7, 30 or 90");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AssistantError(400, "limit must be between 1 and 100");
  try {
    if (timezone === "Local") throw Error();
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new AssistantError(400, "timezone must be an IANA timezone");
  }
  return { days, limit, timezone };
}
function stats(): Record<string, any> {
  return Object.fromEntries(
    [
      "requests",
      "succeeded_requests",
      "failed_requests",
      "cancelled_requests",
      "pending_requests",
      "unknown_status_requests",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "input_missing",
      "output_missing",
      "total_missing",
      "unpriced_requests",
      "partial_priced_requests",
    ]
      .map((key) => [key, 0])
      .concat([["estimated_costs", []]] as any),
  );
}
function add(s: Record<string, any>, r: UsageRecord): void {
  s.requests++;
  const status = ["succeeded", "failed", "cancelled", "pending"].includes(
    r.status || "",
  )
    ? r.status
    : "unknown_status";
  s[status + "_requests"]++;
  for (const key of ["input", "output", "total"]) {
    const value = r[key + "_tokens"];
    if (value == null || Number(String(value)) < 0) s[key + "_missing"]++;
    else {
      const total = BigInt(String(s[key + "_tokens"])) + BigInt(String(value));
      s[key + "_tokens"] = exact(total > maxInt ? maxInt : total);
    }
  }
  const currency = r.currency?.trim().toUpperCase();
  if (
    r.estimated_cost == null ||
    !Number.isFinite(r.estimated_cost) ||
    r.estimated_cost < 0 ||
    !currency
  ) {
    s.unpriced_requests++;
    return;
  }
  const partial = r.cost_status === "partial";
  if (partial) s.partial_priced_requests++;
  let item = s.estimated_costs.find((c: any) => c.currency === currency);
  if (!item) {
    item = { currency, amount: 0, requests: 0, partial_requests: 0 };
    s.estimated_costs.push(item);
    s.estimated_costs.sort((a: any, b: any) =>
      a.currency.localeCompare(b.currency),
    );
  }
  if (Number.isFinite(item.amount + r.estimated_cost)) {
    item.amount += r.estimated_cost;
    item[partial ? "partial_requests" : "requests"]++;
  } else s.unpriced_requests++;
}
export function report(
  records: UsageRecord[],
  at: Date,
  days: number,
  timezone: string,
): any {
  const bounds = window(at, days, timezone),
    totals = stats(),
    daily = bounds.dates.map((date) => ({ date, ...stats() })),
    models: any[] = [],
    sources: any[] = [];
  for (const r of records) {
    if (
      Date.parse(r.timestamp) < Date.parse(bounds.from) ||
      Date.parse(r.timestamp) >= Date.parse(bounds.to) ||
      !Number.isFinite(Date.parse(r.timestamp))
    )
      continue;
    add(totals, r);
    const day = daily.find(
      (d) => d.date === dateLabel(new Date(r.timestamp), timezone),
    );
    if (day) add(day, r);
    let model = models.find(
      (m) =>
        m.base_url === r.base_url &&
        m.protocol === r.protocol &&
        m.model === r.model,
    );
    if (!model) {
      model = {
        base_url: r.base_url,
        protocol: r.protocol,
        model: r.model,
        ...stats(),
      };
      models.push(model);
    }
    add(model, r);
    let source = sources.find((s) => s.source === r.source);
    if (!source) {
      source = { source: r.source, ...stats() };
      sources.push(source);
    }
    add(source, r);
  }
  models.sort((a, b) =>
    [a.base_url, a.protocol, a.model]
      .join("\0")
      .localeCompare([b.base_url, b.protocol, b.model].join("\0")),
  );
  sources.sort((a, b) => a.source.localeCompare(b.source));
  return {
    days,
    from: bounds.from,
    to: bounds.to,
    timezone,
    totals,
    daily,
    models,
    sources,
  };
}
