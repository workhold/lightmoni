import { randomBytes } from "node:crypto";
import { publicAlertValue } from "../domains/alert-read.js";
import { capabilityDigest, type CapabilityIdempotencyPolicy } from "../capabilities/idempotency.js";
import type { DB } from "../shared/sqlite.js";
import type { AlertCapabilities, AlertChange, AlertOperation } from "../domains/alert-capabilities.js";
import { clone, encode, parseTime } from "../domains/common.js";
import { parseJSON } from "../shared/json.js";
import { AssistantError, bytes, object, text } from "./types.js";

type Actor = { id: string; role: string };
export interface AlertIntent {
  operation: AlertOperation;
  target_id?: string;
  patch?: Record<string, any>;
  silence?: Record<string, any>;
  until?: string;
  user_id?: string;
  confirm_possible_duplicate?: boolean;
  reason: string;
}
export interface AlertProposal {
  id: string;
  session_id: string;
  operation: AlertOperation;
  target_id: string;
  status: "awaiting_approval" | "completed";
  before: any;
  after: any;
  summary: string;
  impact: string[];
  reason: string;
  created_at: string;
  expires_at: string;
  applied_at?: string;
  result?: any;
  idempotency_replayed?: boolean;
}
interface StoredProposal {
  owner_id: string;
  change: AlertChange;
  proposal: AlertProposal;
  source?: AlertProposalSource;
}
export interface AlertProposalSource {
  source: "assistant" | "mcp" | "web";
  session_id?: string;
  grant_id?: string;
  credential_id?: string;
}
export interface AlertProposalAuthorization {
  beforeApply(actor: Actor, source: AlertProposalSource, change: AlertChange): void;
}
export interface AlertProposalIndexer {
  afterCreate(actor: Actor, source: AlertProposalSource, change: AlertChange, proposal: AlertProposal): void;
}
const maxBytes = 48 << 10;
const ttl = 15 * 60 * 1000;
const operations: AlertOperation[] = ["delivery.retry", "incident.renew", "incident.escalate", "incident.transfer", "incident.ack", "rule.update", "rule.silence", "silence.create", "silence.update", "silence.end"];
export { publicAlertValue } from "../domains/alert-read.js";
function bounded(value: unknown): void {
  if (bytes(encode(value)) > maxBytes)
    throw new AssistantError(400, "告警配置过大，请缩小变更范围", "alert_change_too_large");
}
export function validateAlertIntent(value: any): asserts value is AlertIntent {
  object(value, ["operation", "target_id", "patch", "silence", "until", "user_id", "confirm_possible_duplicate", "reason"], ["operation", "reason"]);
  bounded(value);
  if (!operations.includes(value.operation) || !text(value.reason).trim() || text(value.reason).length > 1000)
    throw new AssistantError(400, "请提供有效的告警操作和变更原因", "invalid_alert_change");
  if (value.operation !== "silence.create" && (typeof value.target_id !== "string" || !value.target_id.trim() || value.target_id.length > 128))
    throw new AssistantError(400, "请先查询并指定准确的目标 ID", "invalid_alert_change");
  const permitted = value.operation === "delivery.retry" ? "confirm_possible_duplicate" : value.operation === "incident.transfer" ? "user_id" : value.operation === "rule.update" || value.operation === "silence.update" ? "patch" : value.operation === "silence.create" ? "silence" : value.operation === "rule.silence" ? "until" : undefined;
  for (const field of ["patch", "silence", "until", "user_id", "confirm_possible_duplicate"])
    if (field !== permitted && value[field] !== undefined)
      throw new AssistantError(400, "变更字段与操作类型不符", "invalid_alert_change");
  if (permitted === "until" && typeof value.until !== "string")
    throw new AssistantError(400, "静默结束时间必须为 RFC3339，解除时填写空字符串", "invalid_alert_change");
  if (permitted === "user_id" && (typeof value.user_id !== "string" || !value.user_id.trim() || value.user_id.length > 128))
    throw new AssistantError(400, "请指定有效的转交成员 ID", "invalid_alert_change");
  if (permitted === "confirm_possible_duplicate" && value.confirm_possible_duplicate !== undefined && typeof value.confirm_possible_duplicate !== "boolean")
    throw new AssistantError(400, "重复发送确认必须为布尔值", "invalid_alert_change");
  if (permitted === "patch" || permitted === "silence") {
    const v = value[permitted];
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length)
      throw new AssistantError(400, "请提供明确的变更内容", "invalid_alert_change");
  }
}

/** Host-owned durable proposals. The model can create a proposal, never apply one. */
export class AlertProposalService {
  private authorization?: AlertProposalAuthorization;
  private indexer?: AlertProposalIndexer;
  constructor(
    private db: DB,
    private capabilities: AlertCapabilities,
    private now: () => Date,
    private encrypt: (plain: string) => string,
    private decrypt: (cipher: string) => string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_alert_proposals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_alert_audit(proposal_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,operation TEXT NOT NULL,target_id TEXT NOT NULL,applied_at TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }
  useAuthorization(authorization: AlertProposalAuthorization): void { this.authorization = authorization; }
  useProposalIndex(indexer: AlertProposalIndexer): void { this.indexer = indexer; }
  private load(actor: Actor, id: string): StoredProposal {
    const row = this.db.get<{ body: string }>("SELECT body FROM assistant_alert_proposals WHERE id=? AND owner_id=?", id, actor.id);
    if (!row) throw new AssistantError(404, "告警变更提案不存在", "alert_proposal_not_found");
    try {
      const value: StoredProposal = parseJSON(this.decrypt(row.body));
      if (value.owner_id !== actor.id || value.proposal.id !== id) throw Error();
      return value;
    } catch {
      throw new AssistantError(500, "无法读取告警变更提案", "alert_proposal_unavailable");
    }
  }
  get(actor: Actor, id: string): AlertProposal {
    return publicAlertValue(this.load(actor, id).proposal);
  }
  recent(actor: Actor, sessionId: string): Record<string, unknown>[] {
    return this.db.all<{ id: string }>("SELECT id FROM assistant_alert_proposals WHERE owner_id=? AND session_id=? ORDER BY rowid DESC LIMIT 20", actor.id, sessionId).map(({ id }) => {
      const p = this.get(actor, id);
      return { id: p.id, operation: p.operation, target_id: p.target_id, status: p.status, expired: p.status !== "completed" && parseTime(p.expires_at) <= this.now().getTime(), created_at: p.created_at, applied_at: p.applied_at, expires_at: p.expires_at };
    });
  }
  async create(actor: Actor, sessionId: string, intent: AlertIntent, signal: AbortSignal): Promise<AlertProposal> {
    return this.createFrom(actor, {source:"assistant",session_id:sessionId}, intent, signal);
  }
  async createFrom(actor: Actor, source: AlertProposalSource, intent: AlertIntent, signal: AbortSignal, idempotency?: CapabilityIdempotencyPolicy): Promise<AlertProposal> {
    if (!actor?.id || source.source === "assistant" && !source.session_id) throw new AssistantError(401, "需要有效的用户与会话");
    if (source.source === "mcp" && !source.grant_id) throw new AssistantError(403, "缺少外部授权");
    validateAlertIntent(intent);
    const inputHash = idempotency ? capabilityDigest(intent) : "", keyHash = idempotency ? capabilityDigest(idempotency.key) : "";
    const replay = () => {
      if (!idempotency) return undefined;
      const old = this.db.get<{input_hash:string;proposal_id:string}>("SELECT input_hash,proposal_id FROM capability_idempotency WHERE installation_id=? AND user_id=? AND capability=? AND key_hash=?", idempotency.installationID, actor.id, idempotency.capability, keyHash);
      if (!old) return undefined;
      if (old.input_hash !== inputHash) throw new AssistantError(409, "idempotency_conflict", "idempotency_conflict");
      return {...this.get(actor, old.proposal_id), idempotency_replayed: true};
    };
    const existing = replay(); if (existing) return existing;
    let input: any;
    if (intent.operation === "delivery.retry") input = { id: intent.target_id, confirm_possible_duplicate: intent.confirm_possible_duplicate === true };
    else if (["incident.ack", "incident.transfer", "incident.escalate", "incident.renew"].includes(intent.operation)) input = { id: intent.target_id, ...(intent.operation === "incident.transfer" ? { user_id: intent.user_id } : {}) };
    else if (intent.operation.startsWith("rule.")) {
      const current = this.capabilities.getRule(actor, intent.target_id!);
      input = { id: current.id, revision: current.revision, ...(intent.operation === "rule.update" ? { patch: intent.patch } : { until: intent.until }) };
    } else if (intent.operation === "silence.create") input = { silence: intent.silence };
    else {
      const current = this.capabilities.getSilence(actor, intent.target_id!);
      input = { id: current.id, version: current.version, ...(intent.operation === "silence.update" ? { patch: intent.patch } : {}) };
    }
    const change = await this.capabilities.prepare(actor, intent.operation, input, signal);
    signal.throwIfAborted();
    const at = this.now();
    const proposal: AlertProposal = {
      id: randomBytes(16).toString("hex"), session_id: source.session_id ?? "",
      operation: change.operation, target_id: change.target_id,
      status: "awaiting_approval", before: publicAlertValue(change.before), after: publicAlertValue(change.after),
      summary: change.summary, impact: clone(change.impact), reason: intent.reason.trim(),
      created_at: at.toISOString(), expires_at: new Date(at.getTime() + ttl).toISOString(),
    };
    bounded(proposal);
    // Reserve space for the completed readback before accepting an approvable preview.
    bounded({ ...proposal, status: "completed", applied_at: at.toISOString(), result: { ...publicAlertValue(change.after), version: "0".repeat(128) } });
    const stored: StoredProposal = { owner_id: actor.id, change, proposal, source: clone(source) };
    return this.db.transaction(() => {
      const existing = replay(); if (existing) return existing;
      this.db.run("INSERT INTO assistant_alert_proposals(id,owner_id,session_id,body) VALUES(?,?,?,?)", proposal.id, actor.id, proposal.session_id, this.encrypt(encode(stored)));
      this.indexer?.afterCreate(actor, source, change, proposal);
      if (idempotency) this.db.run("INSERT INTO capability_idempotency(installation_id,user_id,capability,key_hash,input_hash,proposal_id,created_at) VALUES(?,?,?,?,?,?,?)", idempotency.installationID, actor.id, idempotency.capability, keyHash, inputHash, proposal.id, this.now().toISOString());
      return clone(proposal);
    });
  }
  private live(value: StoredProposal): void {
    if (parseTime(value.proposal.expires_at) <= this.now().getTime())
      throw new AssistantError(409, "提案已过期，请重新生成变更预览", "alert_proposal_expired");
  }
  async apply(actor: Actor, id: string, signal: AbortSignal): Promise<AlertProposal> {
    const stored = this.load(actor, id);
    if (stored.proposal.status === "completed") return clone(stored.proposal);
    if (stored.source?.source === "mcp" && !this.authorization) throw new AssistantError(503, "外部授权校验不可用", "authorization_unavailable");
    if (stored.source) this.authorization?.beforeApply(actor, stored.source, stored.change);
    this.live(stored);
    let checked: AlertChange;
    try {
      checked = await this.capabilities.revalidate(actor, stored.change, signal);
    } catch (error) {
      // A concurrent confirmation may have completed while async validation waited.
      const latest = this.load(actor, id);
      if (latest.proposal.status === "completed") return clone(latest.proposal);
      throw error;
    }
    signal.throwIfAborted();
    if (encode(checked.before) !== encode(stored.change.before) || encode(checked.after) !== encode(stored.change.after) || checked.expected_version !== stored.change.expected_version)
      throw new AssistantError(409, "告警配置或校验结果已变化，请重新生成变更预览", "alert_proposal_conflict");
    return this.db.transaction(() => {
      const latest = this.load(actor, id);
      if (latest.proposal.status === "completed") return clone(latest.proposal);
      if (latest.source) this.authorization?.beforeApply(actor, latest.source, latest.change);
      this.live(latest);
      const result = this.capabilities.commit(actor, checked);
      const proposal: AlertProposal = { ...latest.proposal, status: "completed", applied_at: this.now().toISOString(), result: publicAlertValue(result) };
      bounded(proposal);
      latest.proposal = proposal;
      this.db.run("UPDATE assistant_alert_proposals SET body=? WHERE id=? AND owner_id=?", this.encrypt(encode(latest)), id, actor.id);
      this.db.run("INSERT INTO assistant_alert_audit(proposal_id,actor_id,session_id,operation,target_id,applied_at,receipt) VALUES(?,?,?,?,?,?,?)", id, actor.id, proposal.session_id, proposal.operation, proposal.target_id, proposal.applied_at, this.encrypt(encode(proposal)));
      return clone(proposal);
    });
  }
}
