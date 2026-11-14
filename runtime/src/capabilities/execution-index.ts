import type { Dependencies } from "../shared/types.js";

export type ExecutionDomain = "task" | "deployment" | "operation" | "agent_installation" | "agent_update";
export interface ExecutionIndexEntry {
  id: string;
  domain: ExecutionDomain;
  native_id: string;
  host_id: string;
  state: string;
  updated_at: string;
}

/** Safe execution association only. Native stores remain authoritative. */
export class ExecutionIndex {
  constructor(private readonly deps: Dependencies) {}

  refresh(domain: ExecutionDomain, nativeID: string, hostID: string, state: string): void {
    this.deps.db.run(`INSERT INTO execution_index(id,domain,native_id,host_id,state,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(domain,native_id) DO UPDATE SET host_id=excluded.host_id,state=excluded.state,updated_at=excluded.updated_at`,
      `${domain}:${nativeID}`, domain, nativeID, hostID, state, this.deps.now().toISOString());
  }

  list(domain?: ExecutionDomain, limit = 5000): ExecutionIndexEntry[] {
    return domain
      ? this.deps.db.all<ExecutionIndexEntry>("SELECT * FROM execution_index WHERE domain=? ORDER BY updated_at DESC,id DESC LIMIT ?", domain, limit)
      : this.deps.db.all<ExecutionIndexEntry>("SELECT * FROM execution_index ORDER BY updated_at DESC,id DESC LIMIT ?", limit);
  }

  get(id: string): ExecutionIndexEntry | undefined {
    return this.deps.db.get<ExecutionIndexEntry>("SELECT * FROM execution_index WHERE id=?", id);
  }
}
