import { randomUUID } from 'node:crypto';
import type { Dependencies } from '../shared/types.js';
import { fail } from '../shared/http.js';
import { blockingAgentJobSQL } from './agent-job-fence.js';

const has = (db: Dependencies['db'], table: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);

/** Queued work has no side effects yet and its claim path is fenced by maintenance. */
const unclaimed = (row:any) => row.state==='queued' && !row.started_at && !row.lease_id && !row.lease_hash
  && !row.lease_expires_at && (!('attempts' in row) || row.attempts===0);

export function maintenanceWorkBusy(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine=''): boolean {
  const {db}=deps;
  if(!agent&&machine)agent=db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id??'';
  if(has(db,'machine_executor_bootstraps')&&db.get("SELECT id FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND status IN ('running','verifying','unknown') LIMIT 1",agent,machine,machine))return true;
  if(has(db,'task_runs')&&db.all<any>("SELECT * FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))",agent,machine,machine).some(t=>!unclaimed(t)))return true;
  if(has(db,'agent_jobs')&&db.all<any>(`SELECT * FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)}`,agent).some(j=>!unclaimed(j)))return true;
  return has(db,'privileged_jobs')&&db.all<any>("SELECT * FROM privileged_jobs WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))",agent,machine,machine).some(j=>!unclaimed(j));
}

export function pendingMaintenancePreparation(db: Dependencies['db'], agent: string, machine='', exclude=''): boolean {
  return has(db,'machine_maintenance_preparations')&&!!db.get("SELECT machine_id FROM machine_maintenance_preparations WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND token<>? AND expires_ms>? LIMIT 1",agent,machine,machine,exclude,Date.now())
    || has(db,'machine_state_recoveries')&&!!db.get("SELECT id FROM machine_state_recoveries WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND id<>? AND status='awaiting_approval' AND expires_at>? LIMIT 1",agent,machine,machine,exclude,new Date().toISOString());
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
