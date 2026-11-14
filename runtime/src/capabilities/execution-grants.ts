import type { Dependencies } from "../shared/types.js";
import { fail } from "../shared/http.js";

interface Binding {domain:string;native_id:string;grant_id:string;user_id:string;source:string;reason:string;created_at:string}
interface Validator {(binding: Binding): void}

/** Associates external proposals with durable execution authorization. */
export class ExecutionGrantRegistry {
  private validator?: Validator;
  constructor(private readonly deps: Dependencies) {
    deps.db.exec(`CREATE TABLE IF NOT EXISTS capability_execution_grants(
      domain TEXT NOT NULL,native_id TEXT NOT NULL,grant_id TEXT NOT NULL,user_id TEXT NOT NULL,
      source TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(domain,native_id))`);
  }
  use(validator: Validator): void { this.validator = validator; }
  bind(domain: string, nativeID: string, input: {grant_id:string;user_id:string;source:string;reason:string}): void {
    const binding: Binding = {domain,native_id:nativeID,grant_id:input.grant_id,user_id:input.user_id,source:input.source,reason:input.reason,created_at:this.deps.now().toISOString()};
    this.deps.db.run(`INSERT INTO capability_execution_grants(domain,native_id,grant_id,user_id,source,reason,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(domain,native_id) DO NOTHING`,binding.domain,binding.native_id,binding.grant_id,binding.user_id,binding.source,binding.reason,binding.created_at);
    const saved=this.deps.db.get<Binding>("SELECT * FROM capability_execution_grants WHERE domain=? AND native_id=?",domain,nativeID);
    if(!saved||saved.grant_id!==binding.grant_id||saved.user_id!==binding.user_id||saved.source!==binding.source||saved.reason!==binding.reason)fail(409,"execution_authorization_conflict");
  }
  assert(domain:string,nativeID:string): void {
    const binding=this.deps.db.get<Binding>("SELECT * FROM capability_execution_grants WHERE domain=? AND native_id=?",domain,nativeID);
    if(!binding)return;
    if(!this.validator)fail(503,"authorization_unavailable");
    try{this.validator(binding);}catch(error){if(error instanceof Error&&error.message==="authorization_unavailable")throw error;fail(403,"authorization_revoked");}
  }
}
