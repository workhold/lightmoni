import { randomUUID } from 'node:crypto';
import type { Dependencies } from '../shared/types.js';
import { fail } from '../shared/http.js';
import { blockingAgentJobSQL } from './agent-job-fence.js';

const has = (db: Dependencies['db'], table: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);

/** Queued work has no side effects yet and its claim path is fenced by maintenance. */
const unclaimed = (row:any) => row.state==='queued' && !row.started_at && !row.lease_id && !row.lease_hash
  && !row.lease_expires_at && (!('attempts' in row) || row.attempts===0);

export type MaintenanceBlocker = { kind: 'executor_bootstrap'|'task_run'|'agent_job'|'privileged_job'; id: string; state: string };
export type MaintenanceOverride = { reason: string; blockers: MaintenanceBlocker[] };
const ignored = (override: MaintenanceOverride | undefined, kind: MaintenanceBlocker['kind'], row: any) =>
  row.state === 'unknown' && !!override?.blockers.some(item => item.kind === kind && item.id === row.id && item.state === 'unknown');

export function maintenanceWorkBusy(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine='', override?:MaintenanceOverride): boolean {
  const {db}=deps;
  if(!agent&&machine)agent=db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id??'';
  if(has(db,'machine_executor_bootstraps')&&db.get("SELECT id FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND status IN ('running','verifying','unknown') LIMIT 1",agent,machine,machine))return true;
  if(has(db,'task_runs')&&db.all<any>("SELECT * FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))",agent,machine,machine).some(t=>!unclaimed(t)&&!ignored(override,'task_run',t)))return true;
  if(has(db,'agent_jobs')&&db.all<any>(`SELECT * FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)}`,agent).some(j=>!unclaimed(j)&&!ignored(override,'agent_job',j)))return true;
  return has(db,'privileged_jobs')&&db.all<any>("SELECT * FROM privileged_jobs WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))",agent,machine,machine).some(j=>!unclaimed(j)&&!ignored(override,'privileged_job',j));
}

/** Read-only detail for actionable 409s. Never used as a gate. */
export function maintenanceBlockers(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine='', limit=8): MaintenanceBlocker[] {
  const {db}=deps;
  if(!agent&&machine)agent=db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id??'';
  const out: MaintenanceBlocker[]=[];
  const push=(kind:MaintenanceBlocker['kind'],rows:any[])=>{for(const r of rows){if(out.length>=limit)return;out.push({kind,id:String(r.id),state:String(r.state)});}};
  if(has(db,'machine_executor_bootstraps'))push('executor_bootstrap',db.all<any>("SELECT id,status AS state FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND status IN ('running','verifying','unknown') LIMIT ?",agent,machine,machine,limit));
  if(has(db,'task_runs'))push('task_run',db.all<any>("SELECT * FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))",agent,machine,machine).filter(t=>!unclaimed(t)));
  if(has(db,'agent_jobs'))push('agent_job',db.all<any>(`SELECT * FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)}`,agent).filter(j=>!unclaimed(j)));
  if(has(db,'privileged_jobs'))push('privileged_job',db.all<any>("SELECT * FROM privileged_jobs WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))",agent,machine,machine).filter(j=>!unclaimed(j)));
  return out;
}

const snapshot = (items:MaintenanceBlocker[]) => JSON.stringify([...items].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
export function captureMaintenanceOverride(deps:Pick<Dependencies,'db'|'decrypt'>,agent:string,machine:string,reason:string):MaintenanceOverride {
  const why=reason.trim(), blockers=maintenanceBlockers(deps,agent,machine,33);
  if(!why||Buffer.byteLength(why)>512||/[\u0000-\u001f\u007f]/.test(why))fail(400,'force_reason_required');
  if(!blockers.length||blockers.length>32||blockers.some(item=>item.state!=='unknown'||item.kind==='executor_bootstrap'))fail(409,'force_unknown_only');
  const override={reason:why,blockers};
  if(maintenanceWorkBusy(deps,agent,machine,override))fail(409,'maintenance_execution_pending');
  return override;
}
export function assertMaintenanceOverride(deps:Pick<Dependencies,'db'|'decrypt'>,agent:string,machine:string,override?:MaintenanceOverride) {
  if(!override)return;
  if(!override.reason||!Array.isArray(override.blockers)||!override.blockers.length||override.blockers.length>32
    ||override.blockers.some(item=>item.state!=='unknown'||item.kind==='executor_bootstrap'))fail(409,'force_override_invalid');
  const current=maintenanceBlockers(deps,agent,machine,33);
  if(snapshot(current)!==snapshot(override.blockers)||maintenanceWorkBusy(deps,agent,machine,override))fail(409,'force_override_changed');
}

export function pendingMaintenancePreparation(db: Dependencies['db'], agent: string, machine='', exclude=''): boolean {
  return has(db,'machine_maintenance_preparations')&&!!db.get("SELECT machine_id FROM machine_maintenance_preparations WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND token<>? AND expires_ms>? LIMIT 1",agent,machine,machine,exclude,Date.now())
    || has(db,'machine_state_recoveries')&&!!db.get("SELECT id FROM machine_state_recoveries WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND id<>? AND status='awaiting_approval' AND expires_at>? LIMIT 1",agent,machine,machine,exclude,new Date().toISOString());
}

/** A short persisted gate covers only read-only SSH planning, never remote mutation. */
export function prepareMachineMaintenance(deps: Pick<Dependencies,'db'|'decrypt'>, machine: string, agent: string, waitForActiveWork=false, override?:MaintenanceOverride) {
  const {db}=deps,token=randomUUID();
  db.exec('CREATE TABLE IF NOT EXISTS machine_maintenance_preparations(machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,token TEXT NOT NULL,expires_ms INTEGER NOT NULL)');
  db.transaction(()=>{
    if(db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id!==agent)fail(409,'maintenance_binding_changed');
    if(pendingMaintenancePreparation(db,agent,machine))fail(409,'maintenance_preparation_pending');
    if(!waitForActiveWork&&maintenanceWorkBusy(deps,agent,machine,override))fail(409,'maintenance_execution_pending');
    db.run('DELETE FROM machine_maintenance_preparations WHERE machine_id=? AND expires_ms<=?',machine,Date.now());
    db.run('INSERT INTO machine_maintenance_preparations VALUES(?,?,?,?)',machine,agent,token,Date.now()+120000);
  });
  return {token,
    renew:()=>{if(!db.run('UPDATE machine_maintenance_preparations SET expires_ms=? WHERE machine_id=? AND token=? AND expires_ms>?',Date.now()+120000,machine,token,Date.now()).changes)fail(409,'maintenance_preparation_expired');},
    release:()=>db.run('DELETE FROM machine_maintenance_preparations WHERE machine_id=? AND token=?',machine,token)};
}
