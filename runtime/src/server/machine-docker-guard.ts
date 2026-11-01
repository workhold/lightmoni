import type { DB } from '../shared/sqlite.js';
import { fail } from '../shared/http.js';
export function pendingDockerInstallation(db:DB,machineID='',agentID='') {
  if(!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_docker_installations'"))return undefined;
  return db.get<any>("SELECT * FROM machine_docker_installations WHERE (machine_id=? OR (?<>'' AND agent_id=?)) AND state IN ('running','unknown') LIMIT 1",machineID,agentID,agentID);
}
export function assertNoDockerInstallation(db:DB,machineID='',agentID='') {
  if(pendingDockerInstallation(db,machineID,agentID))fail(409,'docker_installation_pending');
}
