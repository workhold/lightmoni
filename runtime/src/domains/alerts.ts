import { parseJSON } from "../shared/json.js";
import { isLosslessNumber } from "lossless-json";
import type { Dependencies, Module } from "../shared/types.js";
import {
  bodies,
  clone,
  encode,
  hash,
  id,
  parseTime,
  rowObject,
  stamp,
  normalizeStamp,
  unique,
} from "./common.js";
import {
  allowedResponse,
  notificationMethods,
  onCall,
  policy,
  priority,
  priorityRank,
  responseActiveSeconds,
  nightPeriod,
} from "./alert-policy.js";
import { registerAlertAPI } from "./alert-api.js";
import {
  Notifications,
  channelMethod,
  recipientKey,
  validateRecipient,
  rateKey,
} from "./alert-notify.js";
import {
  collectPendingEvidence,
  notifyResolved,
  syncDueDirectories,
} from "./alert-evidence.js";
const schema = `
CREATE TABLE IF NOT EXISTS alert_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,body TEXT NOT NULL,secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_rules(id TEXT PRIMARY KEY,body TEXT NOT NULL,last_eval TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS alert_states(rule_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(rule_id,fingerprint));
CREATE TABLE IF NOT EXISTS alert_events(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alert_events_rule_time ON alert_events(rule_id,created_at);
CREATE TABLE IF NOT EXISTS alert_outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,channel_id TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,next_attempt TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(event_id,channel_id,target));
CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox(status,next_attempt);
CREATE TABLE IF NOT EXISTS alert_send_attempts(id TEXT PRIMARY KEY,rate_key TEXT NOT NULL,attempted_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alert_attempt_rate ON alert_send_attempts(rate_key,attempted_at);
CREATE TABLE IF NOT EXISTS alert_rate_blocks(rate_key TEXT PRIMARY KEY,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_notification_profiles(user_id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_responses(id TEXT PRIMARY KEY,episode TEXT NOT NULL,group_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(episode,group_id));
CREATE INDEX IF NOT EXISTS alert_responses_state ON alert_responses(state,created_at);
CREATE TABLE IF NOT EXISTS alert_response_events(id TEXT PRIMARY KEY,response_id TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alert_response_events_response ON alert_response_events(response_id,at);
CREATE TABLE IF NOT EXISTS alert_assignments(response_id TEXT NOT NULL,user_id TEXT NOT NULL,user_name TEXT NOT NULL,stage TEXT NOT NULL,priority TEXT NOT NULL,notified_at TEXT NOT NULL,ack_at TEXT NOT NULL DEFAULT '',ack_method TEXT NOT NULL DEFAULT '',outcome TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(response_id,user_id));
CREATE INDEX IF NOT EXISTS alert_assignments_time ON alert_assignments(notified_at,user_id);
CREATE TABLE IF NOT EXISTS alert_claim_tokens(token_hash TEXT PRIMARY KEY,response_id TEXT NOT NULL,user_id TEXT NOT NULL,method TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_silences(id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_directory_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL,secret TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS alert_voice_receipts(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,provider_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,processed INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS alert_voice_receipts_pending ON alert_voice_receipts(processed,created_at);`;
const canonical = (v: any): string =>
  encode(
    v && typeof v === "object" && !isLosslessNumber(v) && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, parseJSON(canonical(v[k]))]),
        )
      : Array.isArray(v)
        ? v.map((x) => parseJSON(canonical(x)))
        : (v ?? null),
  );
export const fingerprint = (v: any) =>
  hash(
    canonical(v).replace(
      /[<>&\u2028\u2029]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    ),
  );
function rational(value: any): [bigint, bigint] {
  const s = String(value);
  if (s.includes("/")) {
    const parts = s.split("/");
    if (parts.length !== 2) throw Error("invalid number");
    const [a, b] = rational(parts[0]),
      [c, d] = rational(parts[1]);
    if (!c) throw Error("invalid number");
    return [a * d, b * c];
  }
  const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (!m[2] && !m[3])) throw Error("invalid number");
  const e = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (!Number.isSafeInteger(e) || Math.abs(e) > 100000)
    throw Error("invalid number");
  let n = BigInt((m[2] || "0") + (m[3] || "")) * (m[1] === "-" ? -1n : 1n);
  return e >= 0 ? [n * 10n ** BigInt(e), 1n] : [n, 10n ** BigInt(-e)];
}
export function finiteNumber(v: any): boolean {
  try {
    rational(v);
    return true;
  } catch {
    return false;
  }
}
export function breached(value: any, threshold: any, op: string): boolean {
  try {
    const [a, b] = rational(value),
      [c, d] = rational(threshold);
    let n = a * d - c * b;
    if (b * d < 0) n = -n;
    return (
      (
        {
          gt: n > 0n,
          gte: n >= 0n,
          lt: n < 0n,
          lte: n <= 0n,
          eq: n === 0n,
          ne: n !== 0n,
        } as any
      )[op] ?? false
    );
  } catch {
    return false;
  }
}
export function applyNoData(s: any, r: any): any {
  if (s.health !== "no_data" || r.operator === "no_data") return s;
  s._missing = true;
  if (["zero", "value"].includes(r.no_data_policy)) {
    s.value = r.no_data_policy === "value" ? r.no_data_value : "0";
    s.health = "ok";
    s.status = breached(s.value, r.threshold, r.operator) ? "firing" : "normal";
  } else if (["alerting", "normal"].includes(r.no_data_policy)) {
    s.health = "ok";
    s.status = r.no_data_policy === "alerting" ? "firing" : "normal";
  }
  return s;
}
const elapsed = (now: Date, s: string, seconds: number) =>
  Number.isFinite(parseTime(s)) &&
  now.getTime() - parseTime(s) >= (seconds || 0) * 1000;
export function transition(
  old: any,
  input: any,
  r: any,
  now: Date,
): {
  state: any;
  kinds: string[];
} {
  const s = {
      status: "normal",
      health: "",
      since: "",
      episode: "",
      health_episode: "",
      consecutive_failures: 0,
      ...clone(old),
      rule_id: r.id,
      fingerprint: input.fingerprint,
      labels: input.labels ?? {},
      value: input.value ?? "",
      error: input.error ?? "",
    },
    kinds: string[] = [],
    gap =
      old.health !== "ok" ||
      (Number.isFinite(parseTime(old.last_eval)) &&
        now.getTime() - parseTime(old.last_eval) > r.interval_seconds * 2000);
  if (input.health !== "ok") {
    s.consecutive_failures = 0;
    if (old.health !== input.health) s.health_since = stamp(now);
    if (s.status === "pending") {
      s.status = "normal";
      s.since = "";
    }
    if (s.status === "recovering") {
      s.status = "firing";
      s.since = "";
    }
    s.health = input.health;
    if (
      r.notify_health &&
      !s.health_episode &&
      elapsed(now, s.health_since, r.health_for_seconds)
    ) {
      s.health_episode = id();
      kinds.push(input.health);
    }
    s.last_eval = stamp(now);
    return { state: s, kinds };
  }
  if (s.health_episode) {
    kinds.push("health_resolved");
    s.health_episode = "";
  }
  s.health = "ok";
  s.health_since = "";
  if (!input._missing) s.last_success = stamp(now);
  if (input.status === "firing") {
    if (gap || ["normal", "recovering"].includes(old.status))
      s.consecutive_failures = 0;
    if (
      !Number.isFinite(parseTime(old.last_eval)) ||
      now.getTime() > parseTime(old.last_eval)
    )
      s.consecutive_failures++;
    const ready = s.consecutive_failures >= Math.max(1, r.for_count || 1);
    if (s.status !== "firing") {
      if (s.status !== "pending" || gap) s.since = stamp(now);
      s.status = "pending";
      if (s.episode) s.status = "firing";
      else if (ready && elapsed(now, s.since, r.for_seconds)) {
        s.status = "firing";
        s.episode = id();
        kinds.push("firing");
        s.last_notify = stamp(now);
      }
    } else if (
      r.repeat_seconds > 0 &&
      elapsed(now, s.last_notify, r.repeat_seconds)
    ) {
      kinds.push("reminder");
      s.last_notify = stamp(now);
    }
  } else {
    s.consecutive_failures = 0;
    if (s.episode) {
      if (s.status !== "recovering" || gap) s.since = stamp(now);
      s.status = "recovering";
      if (elapsed(now, s.since, r.recovery_seconds)) {
        kinds.push("resolved");
        s.status = "normal";
        s.since = "";
      }
    } else {
      s.status = "normal";
      s.since = "";
    }
  }
  s.last_eval = stamp(now);
  return { state: s, kinds };
}
export class Alerts implements Module {
  readonly notifications: Notifications;
  readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private directoryTimer?: ReturnType<typeof setInterval>;
  private workerTimer?: ReturnType<typeof setInterval>;
  private workerPromise?: Promise<void>;
  private tickPromise?: Promise<void>;
  private directoryPromise?: Promise<void>;
  closed = false;
  constructor(
    readonly deps: Dependencies,
    fetcher: typeof fetch = fetch,
  ) {
    deps.db.exec(schema);
    this.notifications = new Notifications(this, fetcher);
    for (const row of deps.db.all<any>(
      "SELECT id,next_attempt,created_at FROM alert_outbox WHERE next_attempt<>''",
    )) {
      if (
        Number.isFinite(parseTime(row.next_attempt)) &&
        Number.isFinite(parseTime(row.created_at))
      )
        deps.db.run(
          "UPDATE alert_outbox SET next_attempt=?,created_at=? WHERE id=?",
          normalizeStamp(row.next_attempt),
          normalizeStamp(row.created_at),
          row.id,
        );
    }
    registerAlertAPI(this);
  }
  now(): Date {
    return this.deps.now();
  }
  list(sql: string, ...p: any[]): any[] {
    return bodies(this.deps, sql, ...p);
  }
  body(table: string, key: string): any {
    const row = this.deps.db.get<any>(
      `SELECT body FROM ${table} WHERE id=?`,
      key,
    );
    return row ? parseJSON(row.body) : undefined;
  }
  groups(): any[] {
    return this.list("SELECT body FROM alert_groups ORDER BY name");
  }
  group(key: string): any {
    const g = this.body("alert_groups", key);
    return g;
  }
  rules(): any[] {
    return this.list("SELECT body FROM alert_rules ORDER BY id");
  }
  response(key: string): any {
    return this.body("alert_responses", key);
  }
  channel(key: string, secrets = false): any {
    const row = this.deps.db.get<any>(
      "SELECT body,secret FROM alert_channels WHERE id=?",
      key,
    );
    if (!row) return undefined;
    const c = parseJSON(row.body);
    c.config ??= {};
    c.has_secret = !!row.secret;
    if (secrets && row.secret)
      Object.assign(c.config, parseJSON(this.deps.decrypt(row.secret)));
    return c;
  }
  member(key: string): any {
    const user = this.deps.db.get<any>(
      "SELECT id,name,active FROM users WHERE id=?",
      key,
    );
    if (!user?.active) return undefined;
    const p = this.deps.db.get<any>(
      "SELECT body FROM user_notification_profiles WHERE user_id=?",
      key,
    );
    return { ...user, profile: p ? parseJSON(p.body) : { user_id: key } };
  }
  activeMembers(keys: string[]): string[] {
    return unique(keys ?? []).filter((key) => !!this.member(key));
  }
  async ruleGroups(rule: any): Promise<any[]> {
    let keys = rule.group_ids ?? [];
    if (!keys.length) {
      const tables = await this.deps.cat.list(this.controller.signal);
      keys = tables
        .filter(
          (t) => rule.source_table_ids?.includes(t.id) && t.alert_group_id,
        )
        .map((t) => t.alert_group_id);
    }
    return unique<string>(keys)
      .map((k) => this.group(k))
      .filter((g) => g?.enabled);
  }
  responseTargets(
    g: any,
    methods: string[],
    users: string[],
  ): {
    targets: any[];
    warnings: string[];
  } {
    const targets: any[] = [],
      warnings: string[] = [],
      auto = new Set<string>();
    for (const c of this.list(
      "SELECT body FROM alert_channels ORDER BY name,id",
    )) {
      const kind = channelMethod(c.type);
      if (
        !c.enabled ||
        !methods.includes(kind) ||
        (g.channel_ids?.length && !g.channel_ids.includes(c.id)) ||
        (!g.channel_ids?.length && auto.has(kind) && kind !== "chat")
      )
        continue;
      auto.add(kind);
      if (
        ["feishu", "dingtalk", "wecom", "webhook", "pushplus"].includes(c.type)
      ) {
        const mentions: string[] = [];
        for (const key of users) {
          const p = this.member(key)?.profile ?? {};
          let v = p.feishu_id;
          if (c.type === "dingtalk")
            v =
              p.dingtalk_id ||
              String(p.phone ?? "").replace(/^\+86(?=\d{11}$)/, "");
          if (c.type === "wecom") v = p.wecom_id;
          if (v) mentions.push(v);
        }
        targets.push({
          target: {
            channel_id: c.id,
            recipient:
              c.type === "pushplus"
                ? { kind: "self", value: "", mentions: [] }
                : { kind: "channel", value: "bound", mentions },
          },
          user_ids: users,
        });
        continue;
      }
      for (const key of users) {
        const user = this.member(key);
        if (!user) continue;
        const p = user.profile,
          recipient =
            kind === "email"
              ? { kind: "email", value: p.email }
              : c.type === "feishu_app"
                ? { kind: "feishu_user", value: p.feishu_id }
                : { kind: "phone", value: p.phone };
        if (!recipient.value) {
          warnings.push(`${user.name}缺少${kind}联系方式`);
          continue;
        }
        try {
          validateRecipient(c.type, recipient);
        } catch (e) {
          warnings.push(user.name + "：" + (e as Error).message);
          continue;
        }
        targets.push({
          target: { channel_id: c.id, recipient },
          user_id: key,
          user_ids: [key],
        });
      }
    }
    if (!targets.length) warnings.push("没有可用通知渠道或联系方式");
    return { targets, warnings };
  }
  async route(rule: any): Promise<{
    routes: any[];
    warnings: string[];
  }> {
    const tables = await this.deps.cat.list(this.controller.signal),
      groups = this.groups(),
      routes: any[] = [],
      warnings: string[] = [],
      keys = [...(rule.group_ids ?? [])];
    for (const tid of rule.source_table_ids ?? []) {
      const t = tables.find((t) => t.id === tid);
      if (!t) throw Error("source table no longer exists: " + tid);
      if (!rule.group_ids?.length) {
        if (!t.alert_group_id)
          warnings.push(t.name + ": 未配置有效告警组/目标");
        else keys.push(t.alert_group_id);
      }
    }
    const seen = new Map<string, any>();
    for (const key of keys) {
      const g = groups.find((g) => g.id === key);
      if (!g?.enabled || (!g.targets?.length && !g.members?.length)) {
        warnings.push(key + ": 未配置有效告警组/目标");
        continue;
      }
      if (g.members?.length) {
        const out = this.responseTargets(
          g,
          policy(g, priority(rule.severity)).methods,
          this.activeMembers(onCall(g, this.now()).primary),
        );
        warnings.push(...out.warnings);
        for (const t of out.targets)
          routes.push({
            target: t.target,
            group_ids: [g.id],
            user_id: t.user_id,
          });
        continue;
      }
      for (const raw of g.targets) {
        const t = clone(raw),
          c = this.channel(t.channel_id);
        if (!c?.enabled) {
          warnings.push(g.name + ": 通知渠道不可用");
          continue;
        }
        const k = t.channel_id + recipientKey(t.recipient);
        if (seen.has(k)) {
          const v = seen.get(k);
          v.target.recipient.mentions = unique([
            ...(v.target.recipient.mentions ?? []),
            ...(t.recipient.mentions ?? []),
          ]).sort();
          v.group_ids = unique([...v.group_ids, g.id]);
        } else {
          const v = { target: t, group_ids: [g.id] };
          seen.set(k, v);
          routes.push(v);
        }
      }
    }
    return { routes, warnings };
  }
  async inspect(r: any, now = this.now()): Promise<any> {
    const to = new Date(now.getTime() - (r.delay_seconds || 0) * 1000),
      from = new Date(to.getTime() - r.window_seconds * 1000),
      range = { from: stamp(from), to: stamp(to) },
      p = {
        states: [] as any[],
        range,
        ...(await this.route(r)),
        result: undefined as any,
      };
    try {
      p.result = await this.deps.query(
        {
          request_id: id(),
          source: "alert",
          range,
          interval_ms: r.interval_seconds * 1000,
          queries: [{ refId: "A", sql: r.sql, params: r.params }],
        },
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
      );
    } catch (e) {
      p.states.push({
        rule_id: r.id,
        labels: {},
        health: "error",
        error: (e as Error).message,
      });
      return p;
    }
    if (p.result.results.length !== 1)
      throw Error("invalid query result count");
    const result = p.result.results[0];
    if (result.status === "error" || !result.complete || result.truncated) {
      p.states.push({
        rule_id: r.id,
        labels: {},
        health: "error",
        error: result.error || "query incomplete/truncated",
      });
      return p;
    }
    const seen = new Set<string>();
    for (const f of result.frames) {
      const vi = f.columns.findIndex((c: any) => c.name === r.value_field);
      if (
        f.rows.length &&
        (vi < 0 || !/(?:Int|Float|Decimal)/.test(f.columns[vi].type))
      )
        throw Error(
          "numeric field " +
            r.value_field +
            " not found or has non-numeric type",
        );
      for (const row of f.rows) {
        const labels: Record<string, string> = {},
          typed: Record<string, any> = {};
        for (const name of r.label_fields ?? []) {
          const n = f.columns.findIndex((c: any) => c.name === name);
          if (n < 0 || n >= row.length)
            throw Error(`label field ${name} missing`);
          labels[name] = String(row[n]);
          typed[name] = [f.columns[n].type, row[n]];
        }
        const fp = fingerprint(r.label_fields?.length ? typed : labels);
        if (seen.has(fp))
          throw Error("duplicate label combination; aggregate in SQL");
        seen.add(fp);
        const state: any = {
          rule_id: r.id,
          fingerprint: fp,
          labels,
          health: "ok",
          status: "normal",
        };
        if (row[vi] == null) state.health = "no_data";
        else {
          state.value = String(row[vi]);
          if (!finiteNumber(state.value))
            throw Error("query value must be finite numeric");
          if (breached(state.value, r.threshold, r.operator))
            state.status = "firing";
        }
        p.states.push(state);
        if (p.states.length > 1000)
          throw Error("alert instance limit exceeded");
      }
    }
    if (!p.states.length)
      p.states.push({
        rule_id: r.id,
        fingerprint: fingerprint({}),
        labels: {},
        health: "no_data",
        status: "normal",
      });
    if (r.operator === "no_data")
      for (const s of p.states)
        if (
          s.health === "no_data" ||
          (s.health === "ok" && breached(s.value, "0", "eq"))
        )
          Object.assign(s, { health: "ok", status: "firing", value: "0" });
    p.states = p.states.map((s) => applyNoData(s, r));
    return p;
  }
  queue(d: any): void {
    d = { attempts: 0, error: "", provider_id: "", next_attempt: "", ...d };
    const pending =
      this.deps.db.get<any>(
        "SELECT count(*) AS n FROM alert_outbox WHERE status IN ('queued','retry','sending')",
      )?.n ?? 0;
    if (Number(pending) >= 10000)
      throw Error("notification queue capacity reached");
    this.deps.db.run(
      "INSERT OR IGNORE INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)",
      d.id,
      d.event_id,
      d.channel_id,
      recipientKey(d.recipient),
      d.status,
      d.next_attempt,
      d.created_at,
      encode(d),
    );
  }
  saveResponse(r: any): void {
    this.deps.db.run(
      "UPDATE alert_responses SET state=?,body=? WHERE id=?",
      r.state,
      encode(r),
      r.id,
    );
  }
  audit(
    r: any,
    kind: string,
    user = "",
    method = "",
    message = "",
    at = this.now(),
  ): void {
    const a = {
      id: id(),
      response_id: r.id,
      at: stamp(at),
      kind,
      user_id: user,
      method,
      message,
    };
    this.deps.db.run(
      "INSERT INTO alert_response_events(id,response_id,at,body) VALUES(?,?,?,?)",
      a.id,
      r.id,
      a.at,
      encode(a),
    );
  }
  cancelResponse(r: any, reason: string): void {
    Object.assign(r, {
      state: "cancelled",
      generation: r.generation + 1,
      deferred_reason: reason,
      resolution_notified: true,
    });
    this.saveResponse(r);
    this.audit(r, "cancelled", "", "", reason);
    this.deps.db.run(
      "UPDATE alert_assignments SET outcome='cancelled' WHERE response_id=? AND outcome='pending'",
      r.id,
    );
    this.cancelQueue(r.id);
  }
  cancelQueue(responseID: string): void {
    this.deps.db.run(
      "UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?",
      responseID,
    );
  }
  cancelRule(key: string, reason: string): void {
    for (const r of this.list(
      "SELECT body FROM alert_responses WHERE json_extract(body,'$.rule_id')=? AND state NOT IN ('resolved','cancelled')",
      key,
    ))
      this.cancelResponse(r, reason);
    this.deps.db.run(
      "UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.rule_id')=?",
      key,
    );
  }
  startResponse(event: any, rule: any, g: any): void {
    if (!g.members?.length || event.kind === "reminder") return;
    const row = this.deps.db.get<any>(
      "SELECT body FROM alert_responses WHERE episode=? AND group_id=?",
      event.episode,
      g.id,
    );
    if (["resolved", "health_resolved"].includes(event.kind)) {
      if (!row) return;
      const r = parseJSON(row.body);
      if (r.state === "resolved") return;
      Object.assign(r, {
        state: "resolved",
        resolved_at: event.created_at,
        generation: r.generation + 1,
        deferred_reason: "已恢复，停止后续通知",
        event,
      });
      this.saveResponse(r);
      this.deps.db.run(
        "UPDATE alert_assignments SET outcome='recovered' WHERE response_id=? AND outcome='pending'",
        r.id,
      );
      this.cancelQueue(r.id);
      this.audit(
        r,
        "resolved",
        "",
        "",
        "监测已恢复，停止后续通知",
        new Date(event.created_at),
      );
      return;
    }
    if (row) return;
    const now = stamp(this.now()),
      r = {
        id: id(),
        episode: event.episode,
        rule_id: rule.id,
        group_id: g.id,
        group_name: g.name,
        state: "unclaimed",
        priority: priority(rule.severity),
        original_priority: priority(rule.severity),
        stage: "primary",
        owner_id: "",
        owner_name: "",
        ack_method: "",
        ack_at: "",
        handling_until: "",
        created_at: event.created_at,
        resolved_at: "",
        last_tick: now > event.created_at ? now : event.created_at,
        last_round_at: "",
        active_seconds: 0,
        level_active_seconds: 0,
        since_round_seconds: 0,
        round: 0,
        stage_round: 0,
        successful_rounds: 0,
        counted_round: 0,
        generation: 1,
        exhausted: false,
        deferred_reason: "",
        group: clone(g),
        event: clone(event),
        evidence: {
          status: rule.evidence_profile?.log_table_id
            ? "pending"
            : "unconfigured",
          logs: [],
          trace_ids: [],
        },
        resolution_notified: false,
      };
    this.deps.db.run(
      "INSERT OR IGNORE INTO alert_responses(id,episode,group_id,state,created_at,body) VALUES(?,?,?,?,?,?)",
      r.id,
      r.episode,
      r.group_id,
      r.state,
      r.created_at,
      encode(r),
    );
    this.audit(
      r,
      "triggered",
      "",
      "",
      "等待值班人员接手",
      new Date(event.created_at),
    );
  }
  async evaluate(r: any, now = this.now()): Promise<void> {
    const groups = await this.ruleGroups(r);
    let p: any;
    try {
      p = await this.inspect(r, now);
    } catch (e) {
      p = {
        states: [
          {
            rule_id: r.id,
            fingerprint: fingerprint({}),
            labels: {},
            health: "error",
            error: (e as Error).message,
          },
        ],
        range: {
          from: stamp(new Date(now.getTime() - r.window_seconds * 1000)),
          to: stamp(now),
        },
        routes: [],
        warnings: [(e as Error).message],
      };
    }
    const olds = this.list(
        "SELECT body FROM alert_states WHERE rule_id=?",
        r.id,
      ),
      oldMap = new Map<string, any>(olds.map((s) => [s.fingerprint, s]));
    let incoming = new Map<string, any>(),
      globalError = "";
    for (const s of p.states) {
      s.fingerprint ||= fingerprint(s.labels ?? {});
      incoming.set(s.fingerprint, s);
      if (s.health === "error") globalError = s.error;
    }
    if (globalError && olds.length) incoming.clear();
    if (
      olds.length &&
      p.states.length === 1 &&
      (p.states[0]._missing ||
        p.states[0].health === "no_data" ||
        (r.operator === "no_data" && p.states[0].status === "firing")) &&
      !Object.keys(p.states[0].labels ?? {}).length &&
      r.label_fields?.length
    )
      incoming.clear();
    const grouped = [...incoming.values()].some(
      (s) => Object.keys(s.labels ?? {}).length && s.health !== "error",
    );
    for (const old of olds)
      if (!incoming.has(old.fingerprint)) {
        let s: any = {
          rule_id: r.id,
          fingerprint: old.fingerprint,
          labels: old.labels,
          health: globalError ? "error" : "no_data",
          error: globalError,
        };
        if (r.operator === "no_data" && !globalError)
          Object.assign(s, { health: "ok", status: "firing", value: "0" });
        s = applyNoData(s, r);
        if (
          !globalError &&
          !Object.keys(old.labels ?? {}).length &&
          r.label_fields?.length &&
          grouped
        )
          s = { ...s, health: "ok", status: "normal", value: "1" };
        incoming.set(old.fingerprint, s);
      }
    this.deps.db.transaction(() => {
      const current = this.body("alert_rules", r.id);
      if (!current || current.revision !== r.revision || !current.enabled)
        return;
      for (const [fp, input] of incoming) {
        const old = oldMap.get(fp) ?? {},
          out = transition(old, input, r, now),
          s = out.state,
          kinds = out.kinds;
        s.silenced = parseTime(current.silence_until) > now.getTime();
        if (
          old.silenced &&
          !s.silenced &&
          (s.status === "firing" || s.health_episode)
        ) {
          kinds.push("reminder");
          s.last_notify = stamp(now);
        }
        for (const kind of kinds) {
          const episode =
            kind === "health_resolved"
              ? old.health_episode
              : ["no_data", "error"].includes(kind)
                ? s.health_episode
                : s.episode;
          const event: any = {
            id: id(),
            rule_id: r.id,
            rule_name: r.name,
            rule_revision: r.revision,
            range: p.range,
            kind,
            episode,
            created_at: stamp(now),
            state: clone(s),
            source_table_ids: r.source_table_ids,
            group_ids: groups.map((g) => g.id),
            message: `${r.name} · ${kind}\n数值 ${s.value} · 阈值 ${r.operator} ${r.threshold}\n${encode(s.labels)}\n窗口 [${p.range.from}, ${p.range.to})`,
          };
          if (
            input._missing &&
            r.no_data_policy &&
            !["", "keep_state"].includes(r.no_data_policy)
          )
            event.message +=
              "\n窗口无数据 · " +
              (
                {
                  zero: "按 0 计算",
                  value: "按指定值计算",
                  alerting: "视为告警",
                  normal: "视为正常",
                } as any
              )[r.no_data_policy];
          if (r.operator === "no_data")
            event.message = `${r.name} · ${kind}\n${r.window_seconds} 秒内没有打点 · 当前点数 ${s.value}\n${encode(s.labels)}\n窗口 [${p.range.from}, ${p.range.to})`;
          if (p.warnings.length) event.message += "\n" + p.warnings.join("; ");
          for (const route of p.routes)
            event.group_ids = unique([...event.group_ids, ...route.group_ids]);
          this.deps.db.run(
            "INSERT INTO alert_events(id,rule_id,created_at,body) VALUES(?,?,?,?)",
            event.id,
            r.id,
            event.created_at,
            encode(event),
          );
          if (["resolved", "health_resolved"].includes(kind)) {
            for (const oldResponse of this.list(
              "SELECT body FROM alert_responses WHERE episode=? AND state<>'resolved'",
              episode,
            ))
              this.startResponse(event, r, oldResponse.group);
          } else for (const g of groups) this.startResponse(event, r, g);
          for (const route of p.routes) {
            if (
              groups.some(
                (g) => g.members?.length && route.group_ids.includes(g.id),
              )
            )
              continue;
            const time = stamp(now);
            this.queue({
              id: id(),
              event_id: event.id,
              rule_id: r.id,
              group_ids: route.group_ids,
              table_ids: r.source_table_ids,
              channel_id: route.target.channel_id,
              recipient: route.target.recipient,
              status: s.silenced ? "suppressed" : "queued",
              created_at: time,
              updated_at: time,
              next_attempt: time,
              payload: event,
            });
          }
        }
        if (kinds.includes("resolved")) s.episode = "";
        if (
          input.status !== "firing" ||
          input.health !== "ok" ||
          (Number.isFinite(parseTime(old.last_eval)) &&
            now.getTime() - parseTime(old.last_eval) >
              r.interval_seconds * 2000)
        ) {
          if (s.episode)
            this.deps.db.run(
              "UPDATE alert_responses SET body=json_set(body,'$.night_count',0,'$.night_last_round_at','','$.night_eligible_at','') WHERE episode=? AND state NOT IN ('resolved','cancelled')",
              s.episode,
            );
        }
        if (
          r.label_fields?.length &&
          !Object.keys(input.labels ?? {}).length &&
          grouped &&
          s.status === "normal"
        )
          this.deps.db.run(
            "DELETE FROM alert_states WHERE rule_id=? AND fingerprint=?",
            r.id,
            fp,
          );
        else
          this.deps.db.run(
            "INSERT INTO alert_states(rule_id,fingerprint,body) VALUES(?,?,?) ON CONFLICT(rule_id,fingerprint) DO UPDATE SET body=excluded.body",
            r.id,
            fp,
            encode(s),
          );
      }
      this.deps.db.run(
        "UPDATE alert_rules SET last_eval=? WHERE id=?",
        stamp(now),
        r.id,
      );
    });
  }
  async syncResponseRoutes(): Promise<void> {
    for (const state of this.list(
      "SELECT body FROM alert_states WHERE coalesce(json_extract(body,'$.episode'),'')<>'' OR coalesce(json_extract(body,'$.health_episode'),'')<>''",
    )) {
      const rule = this.body("alert_rules", state.rule_id);
      if (!rule?.enabled) continue;
      const groups = await this.ruleGroups(rule);
      for (const episode of [state.episode, state.health_episode]) {
        if (!episode) continue;
        const row = this.deps.db.get<any>(
          "SELECT body FROM alert_events WHERE rule_id=? AND json_extract(body,'$.episode')=? ORDER BY created_at,rowid LIMIT 1",
          rule.id,
          episode,
        );
        if (!row) continue;
        const event = parseJSON(row.body);
        event.state = state;
        event.kind = episode === state.episode ? "firing" : state.health;
        const ids = groups.filter((g) => g.members?.length).map((g) => g.id);
        this.deps.db.transaction(() => {
          const currentRule = this.body("alert_rules", rule.id),
            currentState = this.deps.db.get<any>(
              "SELECT body FROM alert_states WHERE rule_id=? AND fingerprint=?",
              rule.id,
              state.fingerprint,
            );
          if (
            !currentRule?.enabled ||
            currentRule.revision !== rule.revision ||
            !currentState ||
            ![
              parseJSON(currentState.body).episode,
              parseJSON(currentState.body).health_episode,
            ].includes(episode)
          )
            return;
          for (const r of this.list(
            "SELECT body FROM alert_responses WHERE episode=? AND state NOT IN ('resolved','cancelled')",
            episode,
          ))
            if (!ids.includes(r.group_id))
              this.cancelResponse(r, "责任组路由已变更");
          for (const g of groups) {
            const raw = this.deps.db.get<any>(
              "SELECT body FROM alert_responses WHERE episode=? AND group_id=?",
              episode,
              g.id,
            );
            if (raw) {
              const r = parseJSON(raw.body);
              if (
                r.state === "cancelled" &&
                ["责任组路由已变更", "规则已禁用"].includes(r.deferred_reason)
              ) {
                Object.assign(r, {
                  state:
                    r.owner_id && g.members.includes(r.owner_id)
                      ? "acknowledged"
                      : "unclaimed",
                  group: g,
                  stage: "primary",
                  round: 0,
                  stage_round: 0,
                  successful_rounds: 0,
                  counted_round: 0,
                  since_round_seconds: 0,
                  level_active_seconds: 0,
                  last_tick: stamp(this.now()),
                  exhausted: false,
                  deferred_reason: "",
                  generation: r.generation + 1,
                  resolution_notified: false,
                });
                if (r.state === "unclaimed")
                  Object.assign(r, {
                    owner_id: "",
                    owner_name: "",
                    ack_at: "",
                    ack_method: "",
                    handling_until: "",
                  });
                this.saveResponse(r);
                this.audit(r, "resumed", "", "", "按当前责任组恢复响应");
              }
            } else this.startResponse(event, rule, g);
          }
        });
      }
    }
  }
  advanceNightRound(r: any, rule: any, now: Date, silences: any[]): void {
    const p = policy(r.group, r.priority),
      period = nightPeriod(r, now);
    if (p.night_mode !== "after_count" || !period || r.state !== "unclaimed")
      return;
    const reason = allowedResponse(r, now, silences, rule.silence_until);
    if (reason && !reason.startsWith("夜间仅记录")) return;
    if (r.night_period !== period)
      Object.assign(r, {
        night_period: period,
        night_count: 0,
        night_last_round_at: "",
        night_eligible_at: "",
      });
    const row = this.deps.db.get<any>(
      "SELECT body FROM alert_states WHERE rule_id=? AND fingerprint=?",
      r.rule_id,
      r.event.state.fingerprint,
    );
    if (!row) return;
    const state = parseJSON(row.body);
    let active =
      state.episode === r.episode &&
      state.status === "firing" &&
      state.health === "ok";
    if (["error", "no_data"].includes(r.event.kind))
      active =
        state.health_episode === r.episode && state.health === r.event.kind;
    if (
      !active ||
      now.getTime() - parseTime(state.last_eval) > rule.interval_seconds * 2000
    ) {
      Object.assign(r, {
        night_count: 0,
        night_last_round_at: "",
        night_eligible_at: "",
      });
      return;
    }
    if (
      r.night_eligible_at ||
      (r.night_last_round_at &&
        (now.getTime() - parseTime(r.night_last_round_at) <
          p.repeat_seconds * 1000 ||
          parseTime(state.last_eval) <= parseTime(r.night_last_round_at)))
    )
      return;
    r.night_count = (r.night_count || 0) + 1;
    r.night_last_round_at = stamp(now);
    let message = `夜间仅记录：同一指标持续告警第${r.night_count}/${p.night_after_count}轮，间隔${p.repeat_seconds}秒`;
    if (r.night_count >= p.night_after_count) {
      Object.assign(r, {
        night_eligible_at: stamp(now),
        last_tick: stamp(now),
        stage: "primary",
        round: 0,
        stage_round: 0,
        successful_rounds: 0,
        counted_round: 0,
        level_active_seconds: 0,
        since_round_seconds: 0,
        exhausted: false,
        generation: r.generation + 1,
      });
      this.cancelQueue(r.id);
      message = `夜间持续告警达到${p.night_after_count}轮，开始按夜间方式通知`;
    }
    this.saveResponse(r);
    this.audit(r, "night_recorded", "", "", message, now);
  }
  enqueueRound(r: any, now: Date): void {
    const previous = r.stage,
      shift = onCall(r.group, now);
    let users: string[] = [],
      out: {
        targets: any[];
        warnings: string[];
      };
    for (;;) {
      users = this.activeMembers(
        r.stage === "backup"
          ? shift.backup
          : r.stage === "fallback"
            ? r.group.fallback
            : shift.primary,
      );
      out = this.responseTargets(r.group, notificationMethods(r, now), users);
      if (!users.length) {
        out.targets = [];
        out.warnings.push("主备及兜底没有有效值班人员");
      }
      if (out.targets.length || r.stage === "fallback") break;
      r.stage = r.stage === "primary" ? "backup" : "fallback";
    }
    if (previous !== r.stage) {
      r.stage_round = 0;
      r.generation++;
    }
    if (!out.targets.length) {
      r.exhausted = true;
      r.deferred_reason = out.warnings.join("；");
      this.saveResponse(r);
      this.audit(r, "unreachable", "", "", r.deferred_reason, now);
      return;
    }
    this.deps.db.transaction(() => {
      r.round++;
      r.stage_round++;
      r.since_round_seconds = 0;
      r.last_round_at = stamp(now);
      r.deferred_reason = out.warnings.join("；");
      for (const t of out.targets) {
        const token = id(),
          method = channelMethod(this.channel(t.target.channel_id)?.type),
          link =
            this.deps.externalURL.replace(/\/$/, "") +
            "/a/" +
            encodeURIComponent(token);
        this.deps.db.run(
          "INSERT INTO alert_claim_tokens(token_hash,response_id,user_id,method,expires_at) VALUES(?,?,?,?,?)",
          hash(token),
          r.id,
          t.user_id || "",
          method + "_link",
          stamp(new Date(now.getTime() + 604800000)),
        );
        const payload = clone(r.event);
        payload.id = `${r.id}:${r.generation}:${r.round}`;
        payload.message = `[${r.priority}] ${payload.rule_name}\n责任组 ${r.group_name} · ${r.stage} · 第${r.round}轮\n${r.event.message}`;
        const time = stamp(now);
        this.queue({
          id: id(),
          event_id: payload.id,
          rule_id: r.rule_id,
          group_ids: [r.group_id],
          table_ids: payload.source_table_ids,
          channel_id: t.target.channel_id,
          recipient: t.target.recipient,
          status: "queued",
          next_attempt: time,
          created_at: time,
          updated_at: time,
          payload,
          response_id: r.id,
          stage: r.stage,
          user_id: t.user_id || "",
          user_ids: t.user_ids,
          priority: r.priority,
          ack_url: link,
          generation: r.generation,
        });
      }
      this.saveResponse(r);
      this.audit(
        r,
        "notifying",
        "",
        "",
        `${r.priority} · ${r.stage} · 第${r.round}轮，${users.length}人`,
        now,
      );
    });
  }
  async tickResponses(): Promise<void> {
    await this.syncResponseRoutes();
    const rs = this.list(
        "SELECT body FROM alert_responses WHERE state NOT IN ('resolved','cancelled') ORDER BY json_extract(body,'$.last_tick'),id LIMIT 1000",
      ),
      silences = this.list("SELECT body FROM alert_silences"),
      now = this.now();
    for (const r of rs) {
      const g = this.group(r.group_id),
        rule = this.body("alert_rules", r.rule_id);
      if (!g?.enabled || !rule?.enabled) continue;
      r.group.members = g.members;
      this.advanceNightRound(r, rule, now, silences);
      let reason = allowedResponse(r, now, silences, rule.silence_until),
        delta =
          r.state === "unclaimed"
            ? responseActiveSeconds(
                r,
                parseTime(r.last_tick),
                now.getTime(),
                silences,
                rule.silence_until,
              )
            : 0;
      r.last_tick = stamp(now);
      if (r.state === "acknowledged") {
        if (
          this.member(r.owner_id) &&
          g.members.includes(r.owner_id) &&
          (!r.handling_until || parseTime(r.handling_until) > now.getTime())
        ) {
          this.saveResponse(r);
          continue;
        }
        if (reason) {
          r.deferred_reason = reason;
          this.saveResponse(r);
          continue;
        }
        Object.assign(r, {
          state: "unclaimed",
          generation: r.generation + 1,
          exhausted: false,
          owner_id: "",
          owner_name: "",
          since_round_seconds: 0,
          round: 0,
          stage: "backup",
          stage_round: 0,
          level_active_seconds: 0,
        });
        delta = 0;
        this.saveResponse(r);
        this.audit(
          r,
          "handling_timeout",
          "",
          "",
          "处理期限已到，重新通知备班",
          now,
        );
      }
      r.active_seconds += delta;
      r.level_active_seconds += delta;
      r.since_round_seconds += delta;
      const old = r.deferred_reason;
      if (reason) {
        r.deferred_reason = reason;
        this.saveResponse(r);
        continue;
      }
      if (
        old?.startsWith("静默") ||
        old?.startsWith("夜间仅记录") ||
        ["通知窗口外", "规则静默"].includes(old)
      ) {
        r.since_round_seconds = policy(r.group, r.priority).repeat_seconds;
        r.deferred_reason = "";
      }
      if (r.exhausted) {
        this.saveResponse(r);
        continue;
      }
      let p = policy(r.group, r.priority);
      if (
        r.round > 0 &&
        r.counted_round !== r.round &&
        this.deps.db.get<any>(
          "SELECT id FROM alert_outbox WHERE event_id=? AND status IN ('accepted','succeeded','confirmed') LIMIT 1",
          `${r.id}:${r.generation}:${r.round}`,
        )
      ) {
        r.successful_rounds++;
        r.counted_round = r.round;
      }
      let changed = false;
      if (
        p.fallback_after_seconds > 0 &&
        r.level_active_seconds >= p.fallback_after_seconds &&
        r.stage !== "fallback"
      ) {
        r.stage = "fallback";
        changed = true;
      } else if (
        p.backup_after_seconds > 0 &&
        r.level_active_seconds >= p.backup_after_seconds &&
        r.stage === "primary"
      ) {
        r.stage = "backup";
        changed = true;
      }
      if (
        p.escalate_after_rounds > 0 &&
        r.successful_rounds >= p.escalate_after_rounds &&
        r.since_round_seconds >= p.repeat_seconds &&
        priorityRank(p.escalate_to) < priorityRank(r.priority)
      ) {
        Object.assign(r, {
          priority: p.escalate_to,
          level_active_seconds: 0,
          round: 0,
          successful_rounds: 0,
          counted_round: 0,
          since_round_seconds: 0,
          generation: r.generation + 1,
        });
        changed = true;
        p = policy(r.group, r.priority);
        reason = allowedResponse(r, now, silences, rule.silence_until);
        if (reason) {
          r.deferred_reason = reason;
          this.saveResponse(r);
          continue;
        }
      }
      if (changed) {
        r.generation++;
        r.exhausted = false;
        r.stage_round = 0;
      }
      if (
        r.round === 0 ||
        changed ||
        r.since_round_seconds >= p.repeat_seconds
      ) {
        if (p.max_rounds > 0 && r.stage_round >= p.max_rounds) {
          if (
            (r.stage === "primary" && p.backup_after_seconds > 0) ||
            (r.stage !== "fallback" && p.fallback_after_seconds > 0)
          )
            r.deferred_reason = "本层通知次数已到，等待下一层升级";
          else {
            r.exhausted = true;
            r.deferred_reason = "升级已耗尽，等待人工接手";
          }
        } else this.enqueueRound(r, now);
      }
      this.saveResponse(r);
    }
  }
  async acknowledge(
    key: string,
    userID: string,
    method: string,
    now = this.now(),
  ): Promise<any> {
    let r = this.response(key);
    const user = this.member(userID),
      g = r && this.group(r.group_id);
    if (!r) throw Error("告警事件不存在");
    if (!user || !g?.members.includes(userID))
      throw Error("接手人不是当前有效告警组成员");
    if (["resolved", "cancelled"].includes(r.state)) throw Error("告警已恢复");
    const rule = this.body("alert_rules", r.rule_id);
    if (!rule) throw Error("告警规则已删除");
    if (
      !rule.enabled ||
      !(await this.ruleGroups(rule)).some((g) => g.id === r.group_id)
    )
      throw Error("告警规则已暂停或责任组已变更");
    this.deps.db.transaction(() => {
      // Catalog lookup yields to other handlers. Re-read mutable state before claiming.
      const latest = this.response(key),
        currentRule = this.body("alert_rules", r.rule_id),
        currentGroup = this.group(r.group_id),
        currentUser = this.member(userID);
      if (!latest) throw Error("告警事件不存在");
      if (["resolved", "cancelled"].includes(latest.state))
        throw Error("告警已恢复");
      if (
        !currentRule?.enabled ||
        currentRule.revision !== rule.revision ||
        !currentGroup?.enabled
      )
        throw Error("告警规则或责任组已变更，请重试");
      if (!currentUser || !currentGroup.members.includes(userID))
        throw Error("接手人不是当前有效告警组成员");
      r = latest;
      if (r.state === "acknowledged") {
        if (r.owner_id === userID) return;
        throw Error("已由" + r.owner_name + "接手");
      }
      Object.assign(r, {
        state: "acknowledged",
        owner_id: userID,
        owner_name: user.name,
        ack_method: method,
        ack_at: stamp(now),
        generation: r.generation + 1,
        last_tick: stamp(now),
        exhausted: false,
        deferred_reason: "",
      });
      const seconds = policy(r.group, r.priority).handling_seconds;
      if (seconds > 0)
        r.handling_until = stamp(new Date(now.getTime() + seconds * 1000));
      this.saveResponse(r);
      this.cancelQueue(r.id);
      this.deps.db.run(
        "UPDATE alert_assignments SET outcome='peer_claimed' WHERE response_id=? AND outcome='pending' AND user_id<>?",
        r.id,
        userID,
      );
      this.deps.db.run(
        "UPDATE alert_assignments SET ack_at=CASE WHEN ack_at='' THEN ? ELSE ack_at END,ack_method=CASE WHEN ack_at='' THEN ? ELSE ack_method END,outcome='claimed' WHERE response_id=? AND user_id=?",
        r.ack_at,
        method,
        r.id,
        userID,
      );
      this.audit(r, "acknowledged", userID, method, user.name + "已接手", now);
    });
    return r;
  }
  updateDelivery(d: any): void {
    this.deps.db.run(
      `UPDATE alert_outbox SET status=CASE WHEN json_extract(body,'$.delivery_status')='answered' THEN 'confirmed' ELSE ? END,next_attempt=CASE WHEN json_extract(body,'$.delivery_status')='answered' THEN '' ELSE ? END,body=CASE WHEN json_extract(body,'$.delivery_status')='answered' THEN json_set(?,'$.status','confirmed','$.next_attempt','','$.delivery_status','answered','$.provider_id',json_extract(body,'$.provider_id')) ELSE ? END WHERE id=?`,
      d.status,
      d.next_attempt ?? "",
      encode(d),
      encode(d),
      d.id,
    );
  }
  recordNotified(d: any, now = this.now()): void {
    if (
      !d.response_id ||
      ["resolved", "health_resolved"].includes(d.payload.kind) ||
      !["accepted", "succeeded", "confirmed"].includes(d.status)
    )
      return;
    const r = this.response(d.response_id);
    if (!r) return;
    this.deps.db.transaction(() => {
      for (const key of d.user_ids ?? []) {
        const user = this.member(key);
        if (!user) continue;
        let outcome = "pending",
          ack = "",
          method = "";
        if (r.state === "acknowledged") {
          outcome = "peer_claimed";
          if (r.owner_id === key) {
            outcome = "claimed";
            ack = r.ack_at;
            method = r.ack_method;
          }
        }
        if (r.state === "resolved") outcome = "recovered";
        this.deps.db.run(
          "INSERT OR IGNORE INTO alert_assignments(response_id,user_id,user_name,stage,priority,notified_at,ack_at,ack_method,outcome) VALUES(?,?,?,?,?,?,?,?,?)",
          r.id,
          key,
          user.name,
          d.stage || r.stage,
          d.priority || r.priority,
          stamp(now),
          ack,
          method,
          outcome,
        );
      }
    });
  }
  async deliveryAllowed(d: any): Promise<string> {
    const r = this.response(d.response_id);
    if (!r) return "告警事件不存在";
    const recovery = ["resolved", "health_resolved"].includes(d.payload.kind);
    if (
      (!recovery && r.state !== "unclaimed") ||
      (recovery && r.state !== "resolved") ||
      d.generation !== r.generation
    )
      return "告警已接手、恢复或升级";
    const g = this.group(r.group_id);
    if (!g?.enabled) return "告警组不可用";
    r.group.members = g.members;
    for (const key of d.user_ids ?? [])
      if (!g.members.includes(key) || !this.member(key))
        return "通知成员已变更";
    if (d.user_id) {
      const u = this.member(d.user_id);
      if (!u || !g.members.includes(d.user_id))
        return "接收人已停用或移出告警组";
      const v = (
        {
          phone: u.profile.phone,
          email: u.profile.email,
          feishu_user: u.profile.feishu_id,
        } as any
      )[d.recipient.kind];
      if (v !== undefined) {
        const p = { ...d.recipient, value: v };
        try {
          validateRecipient(this.channel(d.channel_id)?.type, p);
        } catch {
          return "接收人联系方式已变更";
        }
        if (p.value !== d.recipient.value) return "接收人联系方式已变更";
      }
    }
    const rule = this.body("alert_rules", r.rule_id);
    if (!rule?.enabled) return "规则已禁用";
    if (!(await this.ruleGroups(rule)).some((g) => g.id === r.group_id))
      return "责任组路由已变更";
    const latest = this.response(d.response_id),
      latestRule = this.body("alert_rules", r.rule_id),
      latestGroup = this.group(r.group_id);
    if (
      !latest ||
      latest.generation !== d.generation ||
      (!recovery && latest.state !== "unclaimed") ||
      (recovery && latest.state !== "resolved")
    )
      return "告警已接手、恢复或升级";
    if (
      !latestRule?.enabled ||
      latestRule.revision !== rule.revision ||
      !latestGroup?.enabled ||
      latestGroup.revision !== g.revision
    )
      return "规则或责任组已变更";
    const reason = allowedResponse(
      r,
      this.now(),
      this.list("SELECT body FROM alert_silences"),
      rule.silence_until,
    );
    if (reason) return reason;
    if (
      !recovery &&
      !notificationMethods(r, this.now()).includes(
        channelMethod(this.channel(d.channel_id)?.type),
      )
    )
      return "当前时段不使用此通知方式";
    return "";
  }
  async sendPending(): Promise<void> {
    return this.notifications.sendPending();
  }
  async evaluateDue(): Promise<void> {
    for (const r of this.rules()) {
      if (this.closed) break;
      if (!r.enabled) continue;
      const row = this.deps.db.get<any>(
        "SELECT last_eval FROM alert_rules WHERE id=?",
        r.id,
      );
      if (
        !row?.last_eval ||
        this.now().getTime() - parseTime(row.last_eval) >=
          r.interval_seconds * 1000
      )
        await this.evaluate(r);
    }
  }
  async workDue(): Promise<void> {
    if (!this.closed) {
      await this.notifications.processVoiceReceipts();
      await collectPendingEvidence(this);
      await this.tickResponses();
      await notifyResolved(this);
      await this.sendPending();
    }
  }
  async tick(): Promise<void> {
    await this.evaluateDue();
    await this.workDue();
  }
  start(): void {
    if (this.timer) return;
    this.deps.db.run(
      "UPDATE alert_outbox SET status='unknown' WHERE status='sending'",
    );
    for (const s of this.list("SELECT body FROM alert_states")) {
      if (s.status === "pending") {
        s.status = "normal";
        s.since = "";
        s.consecutive_failures = 0;
      }
      if (s.status === "recovering") {
        s.status = "firing";
        s.since = "";
      }
      if (s.health !== "ok") s.health_since = stamp(this.now());
      this.deps.db.run(
        "UPDATE alert_states SET body=? WHERE rule_id=? AND fingerprint=?",
        encode(s),
        s.rule_id,
        s.fingerprint,
      );
    }
    const run = () => {
      if (this.tickPromise || this.closed) return;
      this.tickPromise = this.evaluateDue()
        .catch((e) => {
          if (!this.closed) this.deps.logger.error("Alert worker failed", e);
        })
        .finally(() => {
          this.tickPromise = undefined;
        });
    };
    this.timer = setInterval(run, 1000);
    this.timer.unref();
    this.workerTimer = setInterval(() => {
      if (this.workerPromise || this.closed) return;
      this.workerPromise = this.workDue()
        .catch((e) => {
          if (!this.closed)
            this.deps.logger.error("Alert delivery worker failed", e);
        })
        .finally(() => {
          this.workerPromise = undefined;
        });
    }, 1000);
    this.workerTimer.unref();
    this.directoryTimer = setInterval(() => {
      if (this.directoryPromise || this.closed) return;
      this.directoryPromise = syncDueDirectories(this)
        .catch((e) => this.deps.logger.warn("Directory worker failed", e))
        .finally(() => {
          this.directoryPromise = undefined;
        });
    }, 60000);
    this.directoryTimer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.directoryTimer) clearInterval(this.directoryTimer);
    if (this.workerTimer) clearInterval(this.workerTimer);
    await Promise.allSettled([
      this.tickPromise,
      this.workerPromise,
      this.directoryPromise,
    ]);
  }
}
export function registerAlerts(deps: Dependencies): Alerts {
  return new Alerts(deps);
}
