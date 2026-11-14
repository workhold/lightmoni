import type { Dependencies } from "../shared/types.js";
import { fail } from "../shared/http.js";

export type ProposalDomain = "task" | "alert" | "deployment" | "operation" | "agent_installation" | "instrumentation";
export interface ProposalIndexLink {
  domain: ProposalDomain;
  nativeID: string;
  capability: string;
  ownerID: string;
  source: string;
  operation: string;
  status: "awaiting_approval" | "completed";
  nativeState: string;
  reviewURL: string;
  hostID?: string;
  createdAt?: string;
}
export interface ProposalIndexEntry {
  id: string;
  domain: ProposalDomain;
  native_id: string;
  capability: string;
  owner_id: string;
  source: string;
  operation: string;
  status: "awaiting_approval" | "completed";
  native_state: string;
  review_url: string;
  host_id: string;
  created_at: string;
  updated_at: string;
}

/** Safe association only. Native proposal stores remain authoritative. */
export class ProposalIndex {
  constructor(private readonly deps: Dependencies) {
    deps.db.exec(`CREATE TABLE IF NOT EXISTS capability_proposals(
      id TEXT PRIMARY KEY,domain TEXT NOT NULL,native_id TEXT NOT NULL,capability TEXT NOT NULL,
      owner_id TEXT NOT NULL,source TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,
      native_state TEXT NOT NULL,review_url TEXT NOT NULL,host_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(domain,native_id));
      CREATE INDEX IF NOT EXISTS capability_proposals_owner ON capability_proposals(owner_id,created_at);`);
  }

  link(input: ProposalIndexLink): void {
    const id = `${input.domain}:${input.nativeID}`, at = input.createdAt ?? this.deps.now().toISOString();
    this.deps.db.run(`INSERT INTO capability_proposals(id,domain,native_id,capability,owner_id,source,operation,status,native_state,review_url,host_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(domain,native_id) DO NOTHING`,
      id, input.domain, input.nativeID, input.capability, input.ownerID, input.source, input.operation, input.status,
      input.nativeState, input.reviewURL, input.hostID ?? "", at, at);
    const saved = this.deps.db.get<ProposalIndexEntry>("SELECT * FROM capability_proposals WHERE domain=? AND native_id=?", input.domain, input.nativeID);
    if (!saved || saved.capability !== input.capability || saved.owner_id !== input.ownerID || saved.source !== input.source || saved.operation !== input.operation)
      fail(409, "proposal_index_conflict");
  }

  refresh(domain: ProposalDomain, nativeID: string, status: "awaiting_approval" | "completed", nativeState: string, reviewURL: string): void {
    this.deps.db.run("UPDATE capability_proposals SET status=?,native_state=?,review_url=?,updated_at=? WHERE domain=? AND native_id=?",
      status, nativeState, reviewURL, this.deps.now().toISOString(), domain, nativeID);
  }

  list(ownerID: string, domain?: ProposalDomain, status?: "awaiting_approval" | "completed", limit = 5000): ProposalIndexEntry[] {
    const where = ["owner_id=?"], params: any[] = [ownerID];
    if (domain) { where.push("domain=?"); params.push(domain); }
    if (status) { where.push("status=?"); params.push(status); }
    return this.deps.db.all<ProposalIndexEntry>(`SELECT * FROM capability_proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`, ...params, limit);
  }

  get(id: string): ProposalIndexEntry | undefined {
    return this.deps.db.get<ProposalIndexEntry>("SELECT * FROM capability_proposals WHERE id=?", id);
  }
}
