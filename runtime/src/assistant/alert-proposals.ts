import { randomBytes } from "node:crypto";
import { isLosslessNumber } from "lossless-json";
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
}
interface StoredProposal {
  owner_id: string;
  change: AlertChange;
  proposal: AlertProposal;
}
const maxBytes = 48 << 10;
const ttl = 15 * 60 * 1000;
const operations: AlertOperation[] = ["rule.update", "rule.silence", "silence.create", "silence.update", "silence.end"];
/** UI and worker use native JSON; represent exact large integers as decimal strings. */
export function publicAlertValue<T>(value: T): T {
  if (isLosslessNumber(value)) return value.value as T;
  if (typeof value === "bigint") return value.toString() as T;
  if (Array.isArray(value)) return value.map(publicAlertValue) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicAlertValue(item)])) as T;
  return value;
}
function bounded(value: unknown): void {
  if (bytes(encode(value)) > maxBytes)
    throw new AssistantError(400, "告警配置过大，请缩小变更范围", "alert_change_too_large");
}
export function validateAlertIntent(value: any): asserts value is AlertIntent {
  object(value, ["operation", "target_id", "patch", "silence", "until", "reason"], ["operation", "reason"]);
  bounded(value);
  if (!operations.includes(value.operation) || !text(value.reason).trim() || text(value.reason).length > 1000)
    throw new AssistantError(400, "请提供有效的告警操作和变更原因", "invalid_alert_change");
  if (value.operation !== "silence.create" && (typeof value.target_id !== "string" || !value.target_id.trim() || value.target_id.length > 128))
    throw new AssistantError(400, "请先查询并指定准确的目标 ID", "invalid_alert_change");
  const permitted = value.operation === "rule.update" || value.operation === "silence.update" ? "patch" : value.operation === "silence.create" ? "silence" : value.operation === "rule.silence" ? "until" : undefined;
  for (const field of ["patch", "silence", "until"])
    if (field !== permitted && value[field] !== undefined)
      throw new AssistantError(400, "变更字段与操作类型不符", "invalid_alert_change");
  if (permitted === "until" && typeof value.until !== "string")
    throw new AssistantError(400, "静默结束时间必须为 RFC3339，解除时填写空字符串", "invalid_alert_change");
  if (permitted === "patch" || permitted === "silence") {
    const v = value[permitted];
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length)
      throw new AssistantError(400, "请提供明确的变更内容", "invalid_alert_change");
  }
}

/** Host-owned durable proposals. The model can create a proposal, never apply one. */
export class AlertProposalService {
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
    if (!actor?.id || !sessionId) throw new AssistantError(401, "需要有效的用户与会话");
    validateAlertIntent(intent);
    let input: any;
    if (intent.operation.startsWith("rule.")) {
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
      id: randomBytes(16).toString("hex"), session_id: sessionId,
      operation: change.operation, target_id: change.target_id,
      status: "awaiting_approval", before: publicAlertValue(change.before), after: publicAlertValue(change.after),
      summary: change.summary, impact: clone(change.impact), reason: intent.reason.trim(),
      created_at: at.toISOString(), expires_at: new Date(at.getTime() + ttl).toISOString(),
    };
    bounded(proposal);
    // Reserve space for the completed readback before accepting an approvable preview.
    bounded({ ...proposal, status: "completed", applied_at: at.toISOString(), result: { ...publicAlertValue(change.after), version: "0".repeat(128) } });
    const stored: StoredProposal = { owner_id: actor.id, change, proposal };
    this.db.run("INSERT INTO assistant_alert_proposals(id,owner_id,session_id,body) VALUES(?,?,?,?)", proposal.id, actor.id, sessionId, this.encrypt(encode(stored)));
    return clone(proposal);
  }
  private live(value: StoredProposal): void {
    if (parseTime(value.proposal.expires_at) <= this.now().getTime())
      throw new AssistantError(409, "提案已过期，请重新生成变更预览", "alert_proposal_expired");
  }
  async apply(actor: Actor, id: string, signal: AbortSignal): Promise<AlertProposal> {
    const stored = this.load(actor, id);
    if (stored.proposal.status === "completed") return clone(stored.proposal);
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
