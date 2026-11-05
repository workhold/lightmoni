import { randomUUID } from 'node:crypto';
import type { Dependencies } from '../shared/types.js';
import { fail } from '../shared/http.js';
import { blockingAgentJobSQL } from './agent-job-fence.js';

const has = (db: Dependencies['db'], table: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);

/** Only an unclaimed, control-plane-authored read can wait behind maintenance. */
function deferrableInspections(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string): Set<string> {
  const {db}=deps, ids=new Set<string>();
  if(!has(db,'agent_jobs')||!has(db,'ops_platform_runs'))return ids;
  for(const j of db.all<any>(`SELECT j.*,r.payload_cipher,r.resource_id,r.id run_id FROM agent_jobs j
    JOIN ops_platform_runs r ON r.job_id=j.id AND r.id=j.operation_id AND r.agent_id=j.agent_id
    WHERE j.agent_id=? AND j.state='queued' AND r.state='queued' AND j.attempts=0 AND j.lease_id='' AND j.lease_expires_at=''`,agent)) {
    try {
      const p=JSON.parse(deps.decrypt(j.payload_cipher)),actions=JSON.parse(j.actions_json),target=JSON.parse(j.target_json);
      if(j.execution_principal!=='privileged_executor'||j.deployment_id!=='platform-'+j.resource_id||target.operations_resource_id!==j.resource_id
        ||actions.length!==1||actions[0].kind!=='operations'||actions[0].domain!=='platform'||actions[0].operation_id!==j.run_id
        ||p.operation_id!==j.run_id||p.operation!=='inspect'||p.resource?.agent_id!==agent||p.resource.id!==j.resource_id
        ||!['node.inspect','workload.inspect','gateway.inspect'].includes(p.resource.config?.task))continue;
      if(has(db,'privileged_jobs')) {
        const root=db.get<any>('SELECT state,started_at,lease_id FROM privileged_jobs WHERE id=?',j.id);
        if(root&&(root.state!=='queued'||root.started_at||root.lease_id))continue;
      }
      ids.add(j.id);
    } catch { /* Unreadable or unrecognized work remains a maintenance barrier. */ }
  }
  return ids;
}

export function maintenanceWorkBusy(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine=''): boolean {
  const {db}=deps;
  if(!agent&&machine)agent=db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id??'';
  const reads=deferrableInspections(deps,agent);
  if(has(db,'machine_executor_bootstraps')&&db.get("SELECT id FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND status IN ('running','verifying','unknown') LIMIT 1",agent,machine,machine))return true;
  if(has(db,'task_runs')&&db.all<any>("SELECT id,state FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))",agent,machine,machine).some(t=>t.state!=='queued'||!reads.has(t.id)))return true;
  if(has(db,'agent_jobs')&&db.all<any>(`SELECT id FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)}`,agent).some(j=>!reads.has(j.id)))return true;
  return has(db,'privileged_jobs')&&db.all<any>("SELECT id,state FROM privileged_jobs WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))",agent,machine,machine).some(j=>j.state!=='queued'||!reads.has(j.id));
}

export function pendingMaintenancePreparation(db: Dependencies['db'], agent: string, machine='', exclude=''): boolean {
  return has(db,'machine_maintenance_preparations')&&!!db.get("SELECT machine_id FROM machine_maintenance_preparations WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND token<>? AND expires_ms>? LIMIT 1",agent,machine,machine,exclude,Date.now());
}

/** A short persisted gate covers only read-only SSH planning, never remote mutation. */
export function prepareMachineMaintenance(deps: Pick<Dependencies,'db'|'decrypt'>, machine: string, agent: string) {
  const {db}=deps,token=randomUUID();
  db.exec('CREATE TABLE IF NOT EXISTS machine_maintenance_preparations(machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,token TEXT NOT NULL,expires_ms INTEGER NOT NULL)');
  db.transaction(()=>{
    if(db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id!==agent)fail(409,'maintenance_binding_changed');
    if(pendingMaintenancePreparation(db,agent,machine))fail(409,'maintenance_preparation_pending');
    if(maintenanceWorkBusy(deps,agent,machine))fail(409,'maintenance_execution_pending');
    db.run('DELETE FROM machine_maintenance_preparations WHERE machine_id=? AND expires_ms<=?',machine,Date.now());
    db.run('INSERT INTO machine_maintenance_preparations VALUES(?,?,?,?)',machine,agent,token,Date.now()+120000);
  });
  return {token,release:()=>db.run('DELETE FROM machine_maintenance_preparations WHERE machine_id=? AND token=?',machine,token)};
}
