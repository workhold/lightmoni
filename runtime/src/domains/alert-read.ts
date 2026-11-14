import { isLosslessNumber } from "lossless-json";
import type { User } from "../shared/types.js";
import type { Alerts } from "./alerts.js";
import { parseJSON } from "../shared/json.js";
import { AlertCapabilityError, type AlertCapabilities } from "./alert-capabilities.js";
import { encode, parseTime, stamp } from "./common.js";

export type AlertActor = Pick<User, "id" | "role">;
export interface AlertProposalReader { get(actor: AlertActor, id: string): any }

/** UI and model adapters share exact large-number handling and bounded public values. */
export function publicAlertValue<T>(value: T): T {
  if (isLosslessNumber(value)) return value.value as T;
  if (typeof value === "bigint") return value.toString() as T;
  if (Array.isArray(value)) return value.map(publicAlertValue) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicAlertValue(item)])) as T;
  return value;
}
function bounded<T>(value: T): T {
  value = publicAlertValue(value);
  if (Buffer.byteLength(encode(value)) > 32 << 10)
    throw new AlertCapabilityError(400, "告警信息过大，请缩小查询或变更范围", "alert_result_too_large");
  return value;
}
function page(items: any[], input: any) {
  const limit = input.limit ?? 30, offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000)
    throw new AlertCapabilityError(400, "invalid alert pagination");
  return bounded({ items: items.slice(offset, offset + limit), total: items.length, offset, limit, has_more: offset + limit < items.length });
}

export async function filteredAlertRuleIDs(m: Alerts, query: URLSearchParams, signal: AbortSignal, rules = m.rules()): Promise<Set<string>> {
  const tables = await m.deps.cat.list(signal);
  return new Set(rules.filter(v => {
    if ((query.get("rule_id") && query.get("rule_id") !== v.id)
      || (query.get("table_id") && !v.source_table_ids?.includes(query.get("table_id")))
      || (query.get("service") && v.services?.length && !v.services.includes(query.get("service")))
      || (query.get("enabled") && String(v.enabled) !== query.get("enabled"))) return false;
    const gid = query.get("group_id");
    return !gid || v.group_ids?.includes(gid) || (!v.group_ids?.length && tables.some(t => v.source_table_ids?.includes(t.id) && t.alert_group_id === gid));
  }).map(v => v.id));
}

/** Read-only alert application service shared by assistant, MCP and HTTP. */
export class AlertReadService {
  constructor(private readonly capabilities: AlertCapabilities, private readonly proposals?: AlertProposalReader) {}

  async listRules(actor: AlertActor, input: any) {
    const rules = await this.capabilities.listRules(actor);
    return page(rules.filter(rule => (!input.search || rule.name.toLowerCase().includes(input.search.toLowerCase()))
      && (!input.service || !rule.services?.length || rule.services.includes(input.service))
      && (input.enabled == null || rule.enabled === input.enabled)).map(rule => ({
        id: rule.id, name: rule.name, revision: rule.revision, version: rule.version, enabled: rule.enabled,
        severity: rule.severity, kind: rule.kind, threshold: rule.threshold, operator: rule.operator,
        services: rule.services, source_table_ids: rule.source_table_ids, group_ids: rule.group_ids, silence_until: rule.silence_until,
      })), input);
  }
  getRule(actor: AlertActor, id: string) { return bounded({ rule: this.capabilities.getRule(actor, id) }); }
  listSilences(actor: AlertActor, input: any) {
    const items = this.capabilities.listSilences(actor).filter(s => (!input.scope || s.scope === input.scope)
      && (!input.target_id || [s.rule_id, s.group_id, s.response_id, s.service].includes(input.target_id)));
    return page(items, input);
  }
  getSilence(actor: AlertActor, id: string) { return bounded({ silence: this.capabilities.getSilence(actor, id) }); }
  listGroups(actor: AlertActor, input: any) { return page(this.capabilities.listGroups(actor), input); }
  getProposal(actor: AlertActor, id: string) {
    if (!this.proposals) throw new AlertCapabilityError(404, "告警变更提案不存在", "alert_proposal_not_found");
    // ProposalService already enforces its 48 KiB preview/receipt contract.
    return { proposal: publicAlertValue(this.proposals.get(actor, id)) };
  }
  nativeIncidents(input: any) {
    const m = this.capabilities.alerts;
    let where = "1=1"; const params: any[] = [];
    for (const key of ["state", "group_id"]) if (input[key]) { where += " AND " + key + "=?"; params.push(input[key]); }
    if (input.priority) { where += " AND json_extract(body,'$.priority')=?"; params.push(input.priority); }
    return m.list("SELECT body FROM alert_responses WHERE " + where + " ORDER BY created_at DESC LIMIT 500", ...params);
  }
  listIncidents(input: any) {
    const items = this.nativeIncidents(input).map(v => ({id:v.id,episode:v.episode,group_id:v.group_id,state:v.state,priority:v.priority,
      created_at:v.created_at,owner_id:v.owner_id,owner_name:v.owner_name,ack_at:v.ack_at,ack_method:v.ack_method,
      handling_until:v.handling_until,exhausted:v.exhausted,round:v.round,stage_round:v.stage_round}));
    return page(items, input);
  }
  getIncident(id: string) {
    const m = this.capabilities.alerts, incident = m.response(id);
    if (!incident) throw new AlertCapabilityError(404, "事件不存在", "resource_not_found");
    const value = {incident, timeline:m.list("SELECT body FROM alert_response_events WHERE response_id=? ORDER BY at,rowid", id)};
    if (Buffer.byteLength(encode(value)) > 60 << 10) throw new AlertCapabilityError(413, "事件详情过大", "result_too_large");
    return value;
  }
  private async deliveries(input: any, signal: AbortSignal) {
    const m = this.capabilities.alerts, query = new URLSearchParams();
    for (const key of ["rule_id","group_id","table_id","service","enabled","status"]) if (input[key] !== undefined) query.set(key, String(input[key]));
    const allowed = await filteredAlertRuleIDs(m, query, signal);
    return m.deps.db.all<any>("SELECT body,status FROM alert_outbox ORDER BY created_at DESC LIMIT 1000")
      .map(row => ({...parseJSON(row.body), status:row.status}))
      .filter(v => ((!query.get("service") && !query.get("enabled")) || allowed.has(v.rule_id))
        && (!query.get("table_id") || v.table_ids?.includes(query.get("table_id")))
        && (!query.get("group_id") || v.group_ids?.includes(query.get("group_id")))
        && (!query.get("rule_id") || v.rule_id === query.get("rule_id"))
        && (!query.get("status") || v.status === query.get("status")));
  }
  nativeDeliveries(input: any, signal: AbortSignal) { return this.deliveries(input, signal); }
  async listDeliveries(input: any, signal: AbortSignal) {
    const items = (await this.deliveries(input, signal)).map(v => ({id:v.id,response_id:v.response_id,event_id:v.event_id,rule_id:v.rule_id,
      group_ids:v.group_ids,table_ids:v.table_ids,service:v.service,status:v.status,delivery_status:v.delivery_status,
      attempts:v.attempts,provider_id:v.provider_id,channel_id:v.channel_id,next_attempt:v.next_attempt,created_at:v.created_at,
      updated_at:v.updated_at,error_present:!!v.error}));
    return page(items, input);
  }
  responseStatistics(input: any) { return alertResponseStatistics(this.capabilities.alerts, input); }
}

export function alertResponseStatistics(m: Alerts, input: any) {
  const from = Number.isFinite(parseTime(input.from)) ? new Date(input.from) : new Date(m.now().getTime() - 30 * 86400000),
    to = Number.isFinite(parseTime(input.to)) ? new Date(input.to) : new Date(m.now().getTime() + 1000);
  if (to <= from) throw new AlertCapabilityError(400, "统计结束时间必须晚于开始时间");
  let where = "a.notified_at>=? AND a.notified_at<?";
  const params: any[] = [stamp(from), stamp(to)];
  if (input.group_id) { where += " AND i.group_id=?"; params.push(input.group_id); }
  if (input.priority) { where += " AND a.priority=?"; params.push(input.priority); }
  const rows = m.deps.db.all<any>(`SELECT a.response_id,a.user_id,a.user_name,a.stage,a.priority,a.notified_at,a.ack_at,a.ack_method,a.outcome,i.body FROM alert_assignments a JOIN alert_responses i ON i.id=a.response_id WHERE ${where} ORDER BY a.notified_at DESC LIMIT 20000`, ...params),
    users = new Map<string, any>(), records: any[] = [];
  const ensure = (uid: string, name: string) => {
    if (!users.has(uid)) users.set(uid, {user_id:uid,user_name:name,notified:0,acknowledged:0,peer_claimed:0,recovered:0,cancelled:0,pending:0,
      ack_rate:0,mean_ack_seconds:0,median_ack_seconds:0,p95_ack_seconds:0,methods:{},priorities:{},durations:[]});
    return users.get(uid);
  };
  for (const row of rows) {
    const incident = parseJSON(row.body), value = ensure(row.user_id, row.user_name);
    value.notified++; value.priorities[row.priority] = (value.priorities[row.priority] || 0) + 1;
    let seconds = 0;
    if (row.ack_at) {
      value.acknowledged++; value.methods[row.ack_method] = (value.methods[row.ack_method] || 0) + 1;
      seconds = Math.max(0, (parseTime(row.ack_at) - parseTime(row.notified_at)) / 1000);
      value.durations.push(seconds); value.mean_ack_seconds += seconds;
    } else value[["peer_claimed","recovered","cancelled"].includes(row.outcome) ? row.outcome : "pending"]++;
    const {body, ...record} = row;
    records.push({...record,group_id:incident.group_id,group_name:incident.group_name,rule_id:incident.rule_id,
      rule_name:incident.event.rule_name,source_priority:incident.original_priority,ack_seconds:seconds});
  }
  const zero = input.group_id ? (m.group(input.group_id)?.members ?? []).map((key:string) => m.member(key)).filter(Boolean)
    : m.deps.db.all<any>("SELECT id,name FROM users WHERE active=1");
  for (const user of zero) ensure(user.id, user.name);
  const out = [...users.values()].map(value => {
    if (value.notified) value.ack_rate = value.acknowledged * 100 / value.notified;
    if (value.acknowledged) {
      value.mean_ack_seconds /= value.acknowledged; value.durations.sort((a:number,b:number) => a-b);
      const n=value.durations.length,mid=Math.floor(n/2);
      value.median_ack_seconds = n%2 ? value.durations[mid] : (value.durations[mid-1]+value.durations[mid])/2;
      value.p95_ack_seconds = value.durations[Math.max(0,Math.ceil(n*0.95)-1)];
    }
    delete value.durations; return value;
  }).sort((a,b) => a.user_name.localeCompare(b.user_name));
  return {from:stamp(from),to:stamp(to),users:out,records,truncated:records.length===20000,
    definition:"接手率=本人接手告警数/实际通知本人的不同组告警数；多渠道与重试去重。接手时长从首次通知受理到接手。其他人接手与自动恢复单独列示。"};
}
