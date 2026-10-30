import type { DB } from "../../src/shared/sqlite.js";
import { id } from "../../src/shared/crypto.js";
import { createAgentHostSchema } from "../../src/server/agent-hosts.js";
import type { AgentCredentialStore, AgentEnrollmentInput } from "../../src/server/agent-credentials.js";

/** Test setup follows the trusted host-bound issuing path, never the disabled public route. */
export function issueHostEnrollment(db: DB, store: AgentCredentialStore, input: Omit<AgentEnrollmentInput, "machine_id">) {
  createAgentHostSchema(db);
  const machineID = id().slice(0, 16), at = new Date().toISOString();
  db.run(`INSERT INTO managed_machines(id,name,address,port,username,connection_method,created_at,updated_at)
    VALUES(?,?,'fixture.example.test',22,'deploy','direct_ssh',?,?)`, machineID, "fixture " + machineID, at, at);
  return store.issueEnrollment({ ...input, machine_id: machineID });
}
