import { isLosslessNumber } from "lossless-json";
import type { User } from "../shared/types.js";
import { HTTPError } from "../shared/http.js";
import { finiteNumber, fingerprint, type Alerts } from "./alerts.js";
import { clone, encode, id, parseTime, stamp, unique } from "./common.js";
import { clockMinutes, priority, validZone } from "./alert-policy.js";
import { autoEvidence, validateEvidence } from "./alert-evidence.js";

const numberFields = [
  "interval_seconds",
  "window_seconds",
  "for_seconds",
  "for_count",
  "recovery_seconds",
  "delay_seconds",
  "health_for_seconds",
  "repeat_seconds",
];
export function normalizeRule(v: any): any {
  validateRuleShape(v);
  v = clone(v);
  for (const key of numberFields) v[key] ??= 0;
  for (const key of [
    "source_table_ids",
    "group_ids",
    "label_fields",
    "services",
  ])
    v[key] ??= [];
  for (const key of [
    "name",
    "sql",
    "value_field",
    "threshold",
    "operator",
    "kind",
    "severity",
    "no_data_policy",
    "no_data_value",
    "silence_until",
    "unit",
  ])
    v[key] ??= "";
  v.enabled = !!v.enabled;
  v.notify_health = !!v.notify_health;
  return v;
}
export async function validateRule(m: Alerts, v: any): Promise<void> {
  if (v.evidence_profile == null) await autoEvidence(m, v);
  if (
    v.severity &&
    !["P0", "P1", "P2", "P3", "warning", "critical"].includes(v.severity)
  )
    throw Error("告警级别必须为P0至P3");
  v.severity = priority(v.severity);
  await validateEvidence(m, v.evidence_profile);
  if (!["metric", "sql", "log"].includes(v.kind))
    throw Error("invalid alert kind");
  if (!v.name.trim() || !v.sql.trim() || !v.value_field)
    throw Error("name, SQL and value field required");
  if (!finiteNumber(v.threshold))
    throw Error("threshold must be a finite number");
  if (!["gt", "gte", "lt", "lte", "eq", "ne", "no_data"].includes(v.operator))
    throw Error("invalid operator");
  if (
    numberFields.some((k) => !Number.isInteger(v[k])) ||
    v.interval_seconds < 1 ||
    v.interval_seconds > 86400 ||
    v.window_seconds < 1 ||
    v.window_seconds > 604800 ||
    [
      "for_seconds",
      "recovery_seconds",
      "delay_seconds",
      "health_for_seconds",
      "repeat_seconds",
    ].some((k) => v[k] < 0)
  )
    throw Error("invalid evaluation/window duration");
  if (v.for_count < 0 || v.for_count > 1000)
    throw Error("连续异常检测次数必须为1到1000");
  v.for_count ||= 1;
  if (
    !["", "keep_state", "zero", "alerting", "normal", "value"].includes(
      v.no_data_policy,
    )
  )
    throw Error("invalid no-data policy");
  if (
    v.no_data_policy === "value" &&
    v.operator !== "no_data" &&
    !finiteNumber(v.no_data_value)
  )
    throw Error("无数据替代值必须为有限数值");
  if (
    v.panel_condition &&
    !["last", "avg", "max", "min", "sum", "count"].includes(
      v.panel_condition.reducer,
    )
  )
    throw Error("invalid panel reducer");
  const refs = await m.deps.referencedTables(v.sql, m.controller.signal),
    tables = await m.deps.cat.list(m.controller.signal),
    actual = refs
      .map((name) => {
        const t = tables.find((t) => t.name === name);
        if (!t) throw Error("SQL reads unknown table");
        return t.id;
      })
      .sort();
  if (
    !actual.length ||
    encode(actual) !== encode([...v.source_table_ids].sort())
  )
    throw Error(
      "source_table_ids must match SQL AST tables: " + actual.join(", "),
    );
  if (v.label_fields.length > 10) throw Error("too many label fields");
  if (v.group_ids.length > 16) throw Error("最多绑定 16 个告警组");
  if (
    unique(v.group_ids).length !== v.group_ids.length ||
    v.group_ids.some((key: string) => !key || !m.group(key))
  )
    throw Error("请选择有效且不重复的告警组");
}
function measurement(rule: any): string {
  const v = normalizeRule(rule);
  v.for_count = Math.max(1, v.for_count);
  for (const key of [
    "id",
    "revision",
    "name",
    "enabled",
    "severity",
    "unit",
    "repeat_seconds",
    "silence_until",
    "evidence_profile",
  ])
    delete v[key];
  return encode(
    Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, v[k]]),
    ),
  );
}

export type AlertOperation =
  | "rule.update"
  | "rule.silence"
  | "silence.create"
  | "silence.update"
  | "silence.end";
export interface AlertChange {
  operation: AlertOperation;
  target_id: string;
  expected_version: string;
  before: any | null;
  after: any;
  summary: string;
  impact: string[];
}
type Actor = Pick<User, "id" | "role">;
export class AlertCapabilityError extends HTTPError {
  constructor(
    status: number,
    message: string,
    readonly code?: string,
  ) {
    super(status, message);
  }
}
const fail = (status: number, message: string, code?: string): never => {
  throw new AlertCapabilityError(status, message, code);
};
const ruleStrings = [
  "name", "sql", "value_field", "operator", "kind", "severity",
  "no_data_policy", "silence_until", "unit",
];
const ruleArrays = ["source_table_ids", "group_ids", "label_fields", "services"];
const ruleFields = [
  ...ruleStrings, ...ruleArrays, ...numberFields, "threshold", "no_data_value",
  "enabled", "notify_health", "params", "panel_condition", "evidence_profile",
];
const silenceFields = [
  "scope", "group_id", "rule_id", "response_id", "service", "from", "until",
  "daily_start", "daily_end", "weekdays", "timezone", "reason", "priorities", "labels",
];
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
function safe(value: any, depth = 0): void {
  if (depth > 20) fail(400, "配置嵌套过深");
  if (value === null || ["string", "boolean", "undefined"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(400, "配置数值必须有限");
    return;
  }
  if (isLosslessNumber(value)) return;
  if (typeof value !== "object") fail(400, "配置必须为 JSON 数据");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail(400, "配置必须为普通 JSON 对象");
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key)) fail(400, "配置包含不允许的属性");
    safe(value[key], depth + 1);
  }
}
function object(value: any, allowed?: string[]): void {
  safe(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || isLosslessNumber(value))
    fail(400, "配置必须为对象");
  if (allowed && Object.keys(value).some((k) => !allowed.includes(k)))
    fail(400, "配置包含不支持或只读的字段");
}
function strings(v: any, keys: string[]): void {
  for (const key of keys)
    if (v[key] != null && typeof v[key] !== "string") fail(400, key + " 必须为字符串");
}
function stringArrays(v: any, keys: string[]): void {
  for (const key of keys)
    if (v[key] != null && (!Array.isArray(v[key]) || v[key].some((x: any) => typeof x !== "string")))
      fail(400, key + " 必须为字符串数组");
}
function validateRuleShape(v: any, patch = false): void {
  object(v, patch ? ruleFields.filter((key) => key !== "silence_until") : [...ruleFields, "id", "revision", "version"]);
  if (patch && Object.entries(v).some(([k, value]) => value == null && !["params", "panel_condition", "evidence_profile"].includes(k))) fail(400, "规则字段不能为 null");
  strings(v, [...ruleStrings, "id", "version"]);
  stringArrays(v, ruleArrays);
  for (const key of [...numberFields, "revision"])
    if (v[key] != null && (!Number.isSafeInteger(v[key]) || v[key] < 0))
      fail(400, key + " 必须为非负整数");
  for (const key of ["enabled", "notify_health"])
    if (v[key] != null && typeof v[key] !== "boolean") fail(400, key + " 必须为布尔值");
  for (const key of ["threshold", "no_data_value"])
    if (v[key] != null && typeof v[key] !== "string" && typeof v[key] !== "number" && !isLosslessNumber(v[key]))
      fail(400, key + " 必须为数值或数值字符串");
  if (v.params != null) {
    object(v.params);
    for (const p of Object.values(v.params) as any[]) {
      object(p, ["type", "value"]);
      if (typeof p.type !== "string" || !Object.hasOwn(p, "value")) fail(400, "无效的 SQL 参数");
    }
  }
  if (v.panel_condition != null) {
    object(v.panel_condition, ["panel_id", "query_ref", "series", "reducer"]);
    strings(v.panel_condition, ["panel_id", "query_ref", "reducer"]);
    if (v.panel_condition.series != null) {
      object(v.panel_condition.series, ["type", "value"]);
      if (typeof v.panel_condition.series.type !== "string") fail(400, "无效的面板序列参数");
    }
  }
  if (v.evidence_profile != null) {
    const p = v.evidence_profile;
    object(p, ["log_table_id", "trace_table_ids", "label_mappings", "lookback_seconds"]);
    strings(p, ["log_table_id"]);
    stringArrays(p, ["trace_table_ids"]);
    if (p.lookback_seconds != null && !Number.isSafeInteger(p.lookback_seconds)) fail(400, "无效的取证回看窗口");
    if (p.label_mappings != null) {
      object(p.label_mappings);
      if (Object.values(p.label_mappings).some((x) => typeof x !== "string")) fail(400, "无效的取证标签映射");
    }
  }
  if (v.silence_until && !Number.isFinite(parseTime(v.silence_until))) fail(400, "invalid silence end");
}
function validateSilenceShape(v: any, patch = false): void {
  object(v, patch ? silenceFields : [...silenceFields, "id", "created_by", "revision", "ended_at", "version"]);
  if (patch && Object.values(v).some((value) => value == null)) fail(400, "静默字段不能为 null");
  strings(v, [...silenceFields.filter((k) => !["weekdays", "priorities", "labels"].includes(k)), "id", "created_by", "ended_at", "version"]);
  stringArrays(v, ["priorities"]);
  if (v.weekdays != null && (!Array.isArray(v.weekdays) || v.weekdays.some((x: any) => !Number.isInteger(x) || x < 0 || x > 6)))
    fail(400, "无效的星期");
  if (v.labels != null) {
    object(v.labels);
    if (Object.values(v.labels).some((x) => typeof x !== "string")) fail(400, "无效的标签匹配条件");
  }
  if (v.revision != null && (!Number.isSafeInteger(v.revision) || v.revision < 0)) fail(400, "无效的静默版本");
}
export function alertVersion(value: any): string {
  if (!value) return "";
  const copy = clone(value);
  delete copy.version;
  return String(copy.revision ?? 0) + ":" + fingerprint(copy);
}
function view(value: any): any {
  return { ...clone(value), version: alertVersion(value) };
}
function withoutVersion(value: any): any {
  const copy = clone(value);
  delete copy.version;
  return copy;
}
function checkRevision(value: any, revision: any): void {
  if (!Number.isSafeInteger(revision) || revision < 1) fail(400, "更新需要有效 revision");
  if (value.revision !== revision) fail(409, "告警规则已更新，请刷新后重试", "revision_conflict");
}
function checkVersion(value: any, version: any): void {
  if (typeof version !== "string" || !version) fail(400, "更新需要有效 version");
  if (alertVersion(value) !== version) fail(409, "静默已更新，请刷新后重试", "revision_conflict");
}
interface RuleSave {
  target_id: string;
  expected_version: string;
  before: any | null;
  after: any;
}

/** Shared business operations; callers own the synchronous SQLite transaction. */
export class AlertCapabilities {
  private prepared = new WeakMap<object, string>();
  constructor(readonly alerts: Alerts) {}
  private actor(actor: Actor): void {
    if (!actor?.id) fail(403, "需要登录");
  }
  async listRules(actor: Actor, filters: Record<string, any> = {}): Promise<any[]> {
    this.actor(actor);
    const tables = filters.group_id ? await this.alerts.deps.cat.list(this.alerts.controller.signal) : [];
    return this.alerts.rules().filter((v) =>
      (!filters.id || filters.id === v.id) &&
      (!filters.rule_id || filters.rule_id === v.id) &&
      (!filters.name || v.name.toLowerCase().includes(String(filters.name).toLowerCase())) &&
      (!filters.service || !v.services?.length || v.services.includes(filters.service)) &&
      (!filters.table_id || v.source_table_ids?.includes(filters.table_id)) &&
      (filters.enabled == null || String(v.enabled) === String(filters.enabled)) &&
      (!filters.group_id || v.group_ids?.includes(filters.group_id) || (!v.group_ids?.length && tables.some((t) => v.source_table_ids?.includes(t.id) && t.alert_group_id === filters.group_id)))
    ).map(view);
  }
  getRule(actor: Actor, key: string): any {
    this.actor(actor);
    const value = this.alerts.body("alert_rules", key);
    if (!value) fail(404, "告警规则不存在");
    return view(value);
  }
  listSilences(actor: Actor, filters: Record<string, any> = {}): any[] {
    this.actor(actor);
    return this.alerts.list("SELECT body FROM alert_silences ORDER BY rowid DESC").filter((s) =>
      ["scope", "group_id", "rule_id", "response_id", "service"].every((k) => !filters[k] || s[k] === filters[k])
    ).map(view);
  }
  getSilence(actor: Actor, key: string): any {
    this.actor(actor);
    const value = this.alerts.body("alert_silences", key);
    if (!value) fail(404, "静默不存在");
    return view(value);
  }
  listGroups(actor: Actor): any[] {
    this.actor(actor);
    return this.alerts.groups().map((g) => ({ id: g.id, name: g.name, enabled: !!g.enabled }));
  }
  private scopePermission(actor: Actor, s: any): boolean {
    const m = this.alerts;
    return actor.role === "admin" ||
      (s.scope === "group" && !!m.group(s.group_id)?.members?.includes(actor.id)) ||
      (s.scope === "incident" && !!m.response(s.response_id) && !!m.group(m.response(s.response_id).group_id)?.members?.includes(actor.id));
  }
  private silencePermission(actor: Actor, s: any): boolean {
    return s.created_by === actor.id || this.scopePermission(actor, s);
  }
  private target(s: any): void {
    const m = this.alerts;
    if (s.scope === "group" && !m.group(s.group_id)) fail(400, "静默告警组不存在");
    if (s.scope === "rule" && !m.body("alert_rules", s.rule_id)) fail(400, "静默告警规则不存在");
    if (s.scope === "incident" && !m.response(s.response_id)) fail(400, "静默事件不存在");
  }
  private validateSilence(value: any): any {
    validateSilenceShape(value);
    const s = withoutVersion(value);
    if (!["all", "group", "rule", "incident", "service"].includes(s.scope)) fail(400, "无效的静默范围");
    s.timezone ||= "Asia/Shanghai";
    if (!validZone(s.timezone)) fail(400, "无效的时区");
    s.from ||= stamp(this.alerts.now());
    if (!Number.isFinite(parseTime(s.from))) fail(400, "无效的开始时间");
    if (s.daily_start || s.daily_end) {
      try { clockMinutes(s.daily_start); clockMinutes(s.daily_end); }
      catch (e) { fail(400, (e as Error).message); }
    }
    if ((!s.until && !s.daily_start) || (s.until && !(parseTime(s.until) > parseTime(s.from)))) fail(400, "静默结束时间必须晚于开始时间");
    const target = ({ group: "group_id", rule: "rule_id", incident: "response_id", service: "service" } as Record<string, string>)[s.scope];
    if (target && !s[target]) fail(400, "静默范围缺少目标");
    if ((s.priorities ?? []).some((p: string) => priority(p) !== p)) fail(400, "无效的告警级别");
    this.target(s);
    s.reason ||= "临时静默";
    return s;
  }
  private checkSilencePermission(actor: Actor, before: any | null, after: any, ending = false): void {
    if (before && !this.silencePermission(actor, before)) fail(403, "没有修改此静默的权限");
    if (!ending && !this.scopePermission(actor, after)) fail(403, "没有此范围的静默权限");
  }
  async prepareRuleSave(actor: Actor, input: any, key?: string, signal?: AbortSignal): Promise<RuleSave> {
    this.actor(actor);
    signal?.throwIfAborted();
    const value = normalizeRule(input);
    delete value.version;
    try { await validateRule(this.alerts, value); }
    catch (e) { if (e instanceof AlertCapabilityError) throw e; fail(400, (e as Error).message); }
    signal?.throwIfAborted();
    value.id = key || id();
    const before = this.alerts.body("alert_rules", value.id) ?? null;
    if (before) checkRevision(before, value.revision);
    value.revision = (before?.revision ?? 0) + 1;
    const prepared = { target_id: value.id, expected_version: alertVersion(before), before, after: value };
    this.prepared.set(prepared, fingerprint(prepared));
    return prepared;
  }
  commitRuleSave(actor: Actor, save: RuleSave): any {
    this.actor(actor);
    this.integrity(save);
    const current = this.alerts.body("alert_rules", save.target_id);
    if (alertVersion(current) !== save.expected_version) fail(409, "告警规则已更新，请刷新后重试", "revision_conflict");
    if ((save.after.group_ids ?? []).some((k: string) => !this.alerts.group(k))) fail(409, "告警组已更新，请重试");
    this.writeRule(save.before, save.after);
    return this.getRule(actor, save.target_id);
  }
  async prepare(actor: Actor, operation: AlertOperation, input: any, signal?: AbortSignal): Promise<AlertChange> {
    this.actor(actor);
    signal?.throwIfAborted();
    let before: any = null, after: any, target_id = "", impact: string[] = [];
    if (operation === "rule.update" || operation === "rule.silence") {
      object(input, operation === "rule.update" ? ["id", "revision", "patch"] : ["id", "revision", "until"]);
      before = withoutVersion(this.getRule(actor, input.id));
      checkRevision(before, input.revision);
      target_id = before.id;
      if (operation === "rule.update") {
        validateRuleShape(input.patch, true);
        if (!Object.keys(input.patch).length) fail(400, "请指定需要修改的规则字段");
        after = normalizeRule({ ...before, ...input.patch });
        try { await validateRule(this.alerts, after); }
        catch (e) { if (e instanceof AlertCapabilityError) throw e; fail(400, (e as Error).message); }
        if (measurement(before) !== measurement(after)) impact.push("规则判断变更将清除当前求值状态并取消未发送通知与当前响应。");
        if (!after.enabled) impact.push("禁用后停止规则求值，取消未发送通知与当前响应。");
      } else {
        if (typeof input.until !== "string" || (input.until && !Number.isFinite(parseTime(input.until)))) fail(400, "invalid silence end");
        after = { ...before, silence_until: input.until };
        impact.push(input.until ? "仍执行规则并保存事件，在指定时间前抑制通知。" : "解除规则临时静默；已抑制通知不会重新发送。");
      }
      after.revision = before.revision + 1;
    } else if (operation === "silence.create") {
      object(input, ["silence"]);
      validateSilenceShape(input.silence, true);
      after = this.validateSilence(input.silence);
      target_id = id();
      Object.assign(after, { id: target_id, created_by: actor.id, revision: 1 });
      this.checkSilencePermission(actor, null, after);
      impact.push("静默窗口匹配的告警仍求值并保存事件，生效期间抑制通知。");
    } else if (operation === "silence.update" || operation === "silence.end") {
      object(input, operation === "silence.update" ? ["id", "version", "patch"] : ["id", "version"]);
      before = withoutVersion(this.getSilence(actor, input.id));
      checkVersion(before, input.version);
      target_id = before.id;
      if (operation === "silence.update") {
        validateSilenceShape(input.patch, true);
        if (!Object.keys(input.patch).length) fail(400, "请指定需要修改的静默字段");
        if (before.ended_at) fail(409, "静默已结束，不能修改");
        after = this.validateSilence({ ...before, ...input.patch });
        impact.push("按新的范围和时间窗口抑制通知；已抑制通知不会重新发送。");
      } else {
        after = { ...before, ended_at: stamp(this.alerts.now()), until: stamp(this.alerts.now()) };
        impact.push("确认时立即结束此静默，包括尚未开始或周期窗口；具体截止时间以执行回执为准，已抑制通知不会重新发送。");
      }
      after.revision = (before.revision ?? 0) + 1;
      this.checkSilencePermission(actor, before, after, operation === "silence.end");
    } else fail(400, "不支持的告警操作");
    signal?.throwIfAborted();
    const change: AlertChange = { operation, target_id, expected_version: alertVersion(before), before, after,
      summary: ({ "rule.update": "修改告警规则", "rule.silence": "调整规则静默", "silence.create": "创建静默窗口", "silence.update": "修改静默窗口", "silence.end": "结束静默窗口" })[operation] + "：" + (after.name || after.reason || target_id), impact };
    this.prepared.set(change, fingerprint(change));
    return change;
  }
  async revalidate(actor: Actor, stored: AlertChange, signal?: AbortSignal): Promise<AlertChange> {
    this.actor(actor);
    signal?.throwIfAborted();
    object(stored, ["operation", "target_id", "expected_version", "before", "after", "summary", "impact"]);
    if (!["rule.update", "rule.silence", "silence.create", "silence.update", "silence.end"].includes(stored.operation)) fail(400, "不支持的告警操作");
    if (!stored.target_id || typeof stored.target_id !== "string" || stored.after?.id !== stored.target_id) fail(400, "变更目标无效");
    const rule = stored.operation.startsWith("rule.");
    const current = this.alerts.body(rule ? "alert_rules" : "alert_silences", stored.target_id) ?? null;
    if (alertVersion(current) !== stored.expected_version || alertVersion(stored.before) !== stored.expected_version) fail(409, "目标已更新，请重新生成提案", "revision_conflict");
    if (stored.operation === "silence.create") {
      if (stored.before !== null || stored.after.created_by !== actor.id || stored.after.revision !== 1) fail(400, "静默创建元数据无效");
    } else if (!current || stored.after.revision !== (current.revision ?? 0) + 1) fail(409, "目标版本无效", "revision_conflict");
    let after: any;
    if (rule) {
      validateRuleShape(stored.after);
      if (stored.operation === "rule.silence") {
        after = { ...current, silence_until: stored.after.silence_until, revision: stored.after.revision };
        if (typeof after.silence_until !== "string") fail(400, "invalid silence end");
      } else after = normalizeRule(stored.after);
      try { await validateRule(this.alerts, after); }
      catch (e) { if (e instanceof AlertCapabilityError) throw e; fail(400, (e as Error).message); }
    } else {
      validateSilenceShape(stored.after);
      if (current && stored.after.created_by !== current.created_by) fail(400, "静默创建者不能修改");
      if (stored.operation === "silence.end") {
        if (!stored.after.ended_at || !Number.isFinite(parseTime(stored.after.ended_at)) || stored.after.until !== stored.after.ended_at) fail(400, "静默结束时间无效");
        after = { ...current, ended_at: stored.after.ended_at, until: stored.after.until, revision: stored.after.revision };
      } else {
        if (stored.after.ended_at !== current?.ended_at) fail(400, "静默结束状态不能修改");
        after = this.validateSilence(stored.after);
      }
      this.checkSilencePermission(actor, current, after, stored.operation === "silence.end");
    }
    signal?.throwIfAborted();
    if (fingerprint(after) !== fingerprint(stored.after)) fail(409, "告警配置校验结果已改变，请重新生成提案");
    const change = clone(stored);
    this.prepared.set(change, fingerprint(change));
    return change;
  }
  private integrity(change: object): void {
    if (!this.prepared.has(change) || this.prepared.get(change) !== fingerprint(change)) fail(400, "告警变更准备结果已改变，请重新生成");
  }
  commit(actor: Actor, change: AlertChange): any {
    this.actor(actor);
    this.integrity(change);
    const rule = change.operation.startsWith("rule.");
    const current = this.alerts.body(rule ? "alert_rules" : "alert_silences", change.target_id);
    if (alertVersion(current) !== change.expected_version) fail(409, "目标已更新，请刷新并重新生成提案", "revision_conflict");
    if (rule) {
      validateRuleShape(change.after);
      if ((change.after.group_ids ?? []).some((k: string) => !this.alerts.group(k))) fail(409, "告警组已更新，请重新生成提案");
      if (change.operation === "rule.update") this.writeRule(current, change.after);
      else this.writeRuleSilence(change.after);
      return this.getRule(actor, change.target_id);
    }
    this.checkSilencePermission(actor, current ?? null, change.after, change.operation === "silence.end");
    if (change.operation !== "silence.end") this.target(change.after);
    const db = this.alerts.deps.db;
    const endedAt = change.operation === "silence.end" ? stamp(this.alerts.now()) : "";
    const committed = change.operation === "silence.end"
      ? { ...change.after, until: endedAt, ended_at: endedAt }
      : change.after;
    if (change.operation === "silence.create") db.run("INSERT INTO alert_silences(id,body) VALUES(?,?)", change.target_id, encode(change.after));
    else db.run("UPDATE alert_silences SET body=? WHERE id=?", encode(committed), change.target_id);
    return this.getSilence(actor, change.target_id);
  }
  private writeRule(before: any, value: any): void {
    const m = this.alerts, db = m.deps.db;
    const changed = !before || measurement(before) !== measurement(value);
    db.run("INSERT INTO alert_rules(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,last_eval=''", value.id, encode(value));
    if (changed) db.run("DELETE FROM alert_states WHERE rule_id=?", value.id);
    else if (before.enabled !== value.enabled)
      for (const s of m.list("SELECT body FROM alert_states WHERE rule_id=?", value.id)) {
        if (s.status === "pending") s.status = "normal";
        if (s.status === "recovering") s.status = "firing";
        s.since = "";
        s.last_eval = "";
        s.consecutive_failures = 0;
        if (s.health !== "ok") s.health_since = stamp(m.now());
        db.run("UPDATE alert_states SET body=? WHERE rule_id=? AND fingerprint=?", encode(s), value.id, s.fingerprint);
      }
    if (changed || !value.enabled) {
      m.cancelRule(value.id, value.enabled ? "规则判断已变更" : "规则已禁用");
      db.run("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND event_id IN (SELECT id FROM alert_events WHERE rule_id=?)", value.id);
    }
  }
  private writeRuleSilence(value: any): void {
    const m = this.alerts, db = m.deps.db;
    db.run("UPDATE alert_rules SET body=? WHERE id=?", encode(value), value.id);
    if (parseTime(value.silence_until) > m.now().getTime()) {
      db.run("UPDATE alert_outbox SET status='suppressed' WHERE status IN ('queued','retry') AND event_id IN (SELECT id FROM alert_events WHERE rule_id=?)", value.id);
      for (const s of m.list("SELECT body FROM alert_states WHERE rule_id=?", value.id)) {
        s.silenced = true;
        db.run("UPDATE alert_states SET body=? WHERE rule_id=? AND fingerprint=?", encode(s), value.id, s.fingerprint);
      }
    }
  }
}
