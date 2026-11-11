import type {Dependencies} from '../shared/types.js';
/** Current authenticated executor observation, never an ordinary self-report. */
export function managedExecutorObservation(deps:Pick<Dependencies,'db'|'decrypt'|'now'>,agentID:string):Record<string,any>|undefined {
 const {db}=deps;if(!db.get("SELECT 1 FROM sqlite_master WHERE name='privileged_executors'"))return;
 const row=db.get<any>(`SELECT e.*,p.generation,p.capabilities_json,p.approved_by FROM privileged_executors e JOIN managed_machines m ON m.id=e.machine_id AND m.agent_id=e.agent_id JOIN privileged_machine_policies p ON p.machine_id=e.machine_id AND p.agent_id=e.agent_id WHERE e.agent_id=? AND e.state='active' AND e.install_generation=(SELECT MAX(install_generation) FROM privileged_executors WHERE machine_id=e.machine_id)`,agentID);
 const sshReady=!!db.get("SELECT 1 FROM sqlite_master WHERE type='view' AND name='effective_machine_credentials'")&&!!db.get(`SELECT c.id FROM managed_machines m
   JOIN machine_ssh_accounts a ON a.id=m.default_account_id AND a.deleted_at=''
   JOIN effective_machine_credentials c ON c.id=a.default_credential_id AND c.machine_id=m.id
   WHERE m.agent_id=? AND m.address!='' AND c.revoked_at IS NULL AND c.secret_cleared_at='' AND c.secret_encrypted!=''
   AND c.retention!='one_time' AND (c.retention='permanent' AND c.expires_at='' OR julianday(c.expires_at)>julianday(?))`,agentID,deps.now().toISOString());
 if(!row||!row.last_seen||!sshReady&&deps.now().getTime()-Date.parse(row.last_seen)>60000||!db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",row.approved_by))return;
 try{const observation=JSON.parse(deps.decrypt(row.observation_enc));if(observation.policy_generation!==row.generation||!JSON.parse(row.capabilities_json).includes('operations.managed.v1')||!observation.capabilities.includes('operations.managed.v1'))return;return observation;}catch{return;}
}
export function operationExecutionCapabilities(deps:Pick<Dependencies,'db'|'decrypt'|'now'>,agentID:string):string[] {
 return managedExecutorObservation(deps,agentID)?.operations_capabilities??[];
}
