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

const unresolvedExecutorBootstrap = (row:any) =>
  ['running','verifying','unknown'].includes(row.status) && !row.resolved_at;

export function maintenanceWorkBusy(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine='', override?:MaintenanceOverride): boolean {
  const {db}=deps;
  if(!agent&&machine)agent=db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id??'';
  if(has(db,'machine_executor_bootstraps')&&db.all<any>("SELECT * FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?))",agent,machine,machine).some(unresolvedExecutorBootstrap))return true;
  if(has(db,'task_runs')&&db.all<any>("SELECT * FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))",agent,machine,machine).some(t=>!unclaimed(t)&&!ignored(override,'task_run',t)))return true;
  if(has(db,'agent_jobs')&&db.all<any>(`SELECT * FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)}`,agent).some(j=>!unclaimed(j)&&!ignored(override,'agent_job',j)))return true;
  return has(db,'privileged_jobs')&&db.all<any>("SELECT * FROM privileged_jobs WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))",agent,machine,machine).some(j=>!unclaimed(j)&&!ignored(override,'privileged_job',j));
}

/** Read-only detail for actionable 409s. Never used as a gate. */
export function maintenanceBlockers(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine='', limit=8): MaintenanceBlocker[] {
  const {db}=deps;
  if(!agent&&machine)agent=db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',machine)?.agent_id??'';
  const out: MaintenanceBlocker[]=[];
  const push=(kind:MaintenanceBlocker['kind'],rows:any[],state:(row:any)=>string)=>{for(const row of rows){if(out.length>=limit)return;out.push({kind,id:String(row.id),state:state(row)});}};
  if(has(db,'machine_executor_bootstraps'))push('executor_bootstrap',db.all<any>("SELECT * FROM machine_executor_bootstraps WHERE (agent_id=? OR (?<>'' AND machine_id=?))",agent,machine,machine).filter(unresolvedExecutorBootstrap),row=>String(row.status));
  if(has(db,'task_runs'))push('task_run',db.all<any>("SELECT * FROM task_runs WHERE (agent_id=? OR (?<>'' AND host_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at='' AND superseded_by=''))",agent,machine,machine).filter(t=>!unclaimed(t)),row=>String(row.state));
  if(has(db,'agent_jobs'))push('agent_job',db.all<any>(`SELECT * FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(db)}`,agent).filter(j=>!unclaimed(j)),row=>String(row.state));
  if(has(db,'privileged_jobs'))push('privileged_job',db.all<any>("SELECT * FROM privileged_jobs WHERE (agent_id=? OR (?<>'' AND machine_id=?)) AND (state IN ('queued','running') OR (state='unknown' AND resolved_at=''))",agent,machine,machine),row=>String(row.state));
  return out;
}

export function maintenanceBlockersText(blockers:MaintenanceBlocker[]) {
  return blockers.map(blocker=>`${blocker.kind} ${blocker.id.slice(0,8)} ${blocker.state}`).join('、');
}

export function maintenanceFenceMessage(deps: Pick<Dependencies,'db'|'decrypt'>, agent: string, machine='') {
  const blockers=maintenanceBlockers(deps,agent,machine);
  return blockers.length?`maintenance_execution_pending: ${maintenanceBlockersText(blockers)}`:'maintenance_execution_pending';
}

const snapshot = (items: MaintenanceBlocker[]) => JSON.stringify([...items].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
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

const ensureColumn=(db:Dependencies['db'],table:string,column:string,definition:string)=>{
  if(!db.all<any>(`PRAGMA table_info(${table})`).some(row=>row.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

/**
 * Close a legacy first-install bootstrap fence without rewriting its unknown
 * outcome. A newer active executor for the same machine/Agent is durable center
 * evidence that the uncertain bootstrap generation no longer needs dispatch.
 */
export function resolveLegacyExecutorBootstrap(deps:Dependencies,machineID:string,bootstrapID:string,actor:string,reason:string) {
  const {db}=deps,at=deps.now().toISOString();
  if(!has(db,'machine_executor_bootstraps'))fail(404,'executor_bootstrap_not_found');
  ensureColumn(db,'machine_executor_bootstraps','resolved_at',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'machine_executor_bootstraps','resolved_by',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'machine_executor_bootstraps','resolution_reason',"TEXT NOT NULL DEFAULT ''");
  const host=db.get<any>('SELECT id,agent_id FROM managed_machines WHERE id=?',machineID);
  if(!host?.agent_id)fail(404,'machine_not_found');
  const saved=db.get<any>('SELECT * FROM machine_executor_bootstraps WHERE id=? AND machine_id=? AND agent_id=?',bootstrapID,machineID,host.agent_id);
  if(!saved)fail(404,'executor_bootstrap_not_found');
  if(saved.status!=='unknown')fail(409,'only_unresolved_unknown_bootstrap_can_be_closed');
  if(saved.resolved_at)fail(409,'executor_bootstrap_already_closed');
  const why=reason.trim();
  if(!why||Buffer.byteLength(why)>500||/[\u0000-\u001f\u007f]/.test(why))fail(400,'invalid_resolution_reason');
  if(!db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",actor))fail(403,'active_human_admin_required');
  if(!has(db,'privileged_executors'))fail(409,'executor_bootstrap_current_executor_required');
  const executor=()=>db.get<any>("SELECT * FROM privileged_executors WHERE machine_id=? AND agent_id=? AND state='active' ORDER BY CAST(install_generation AS INTEGER) DESC,last_seen DESC,id LIMIT 1",machineID,host.agent_id);
  const current=executor();
  const lastSeen=Date.parse(current?.last_seen||'');
  if(!current||!Number.isSafeInteger(Number(current.install_generation))||Number(current.install_generation)<Number(saved.install_generation||0)
    ||!Number.isFinite(lastSeen)||lastSeen<=deps.now().getTime()-120_000)fail(409,'executor_bootstrap_current_executor_required');
  if(!has(db,'privileged_audit'))fail(503,'executor_bootstrap_audit_unavailable');
  return db.transaction(()=>{
    const locked=db.get<any>('SELECT * FROM machine_executor_bootstraps WHERE id=? AND status=? AND resolved_at=?',bootstrapID,'unknown','');
    if(!locked)fail(409,'executor_bootstrap_state_changed');
    const verified=executor();
    if(verified?.id!==current.id||verified?.install_generation!==current.install_generation||verified?.last_seen!==current.last_seen)fail(409,'executor_bootstrap_executor_changed');
    db.run("UPDATE machine_executor_bootstraps SET resolved_at=?,resolved_by=?,resolution_reason=? WHERE id=? AND status='unknown' AND resolved_at=''",at,actor,why,bootstrapID);
    db.run("INSERT INTO privileged_audit(id,machine_id,job_id,actor_id,event,created_at,detail_json) VALUES(?,?,?,?,?,?,?)",
      randomUUID(),machineID,bootstrapID,actor,'legacy_executor_bootstrap_closed',at,JSON.stringify({executor_id:current.id,install_generation:Number(current.install_generation),reason:why}));
    return {id:bootstrapID,machine_id:machineID,agent_id:host.agent_id,status:'unknown',executor_id:saved.executor_id,install_generation:Number(saved.install_generation||0),resolved_at:at,resolved_by:actor,resolution_reason:why};
  });
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
    if(!waitForActiveWork&&maintenanceWorkBusy(deps,agent,machine,override))fail(409,maintenanceFenceMessage(deps,agent,machine));
    db.run('DELETE FROM machine_maintenance_preparations WHERE machine_id=? AND expires_ms<=?',machine,Date.now());
    db.run('INSERT INTO machine_maintenance_preparations VALUES(?,?,?,?)',machine,agent,token,Date.now()+120000);
  });
  return {token,
    renew:()=>{if(!db.run('UPDATE machine_maintenance_preparations SET expires_ms=? WHERE machine_id=? AND token=? AND expires_ms>?',Date.now()+120000,machine,token,Date.now()).changes)fail(409,'maintenance_preparation_expired');},
    release:()=>db.run('DELETE FROM machine_maintenance_preparations WHERE machine_id=? AND token=?',machine,token)};
}
