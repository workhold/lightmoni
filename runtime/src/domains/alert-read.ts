import { isLosslessNumber } from "lossless-json";
import type { User } from "../shared/types.js";
import type { Alerts } from "./alerts.js";
import { parseJSON } from "../shared/json.js";
import { AlertCapabilityError, type AlertCapabilities } from "./alert-capabilities.js";
import { encode } from "./common.js";

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
}
