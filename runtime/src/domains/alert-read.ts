import { isLosslessNumber } from "lossless-json";
import type { User } from "../shared/types.js";
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
}
