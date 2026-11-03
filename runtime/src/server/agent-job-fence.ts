import type {DB} from '../shared/sqlite.js';

/** A reviewed managed result stays unknown; its audited root identity releases
 * only that job's host fence. Ordinary and unresolved jobs remain barriers. */
export function blockingAgentJobSQL(db:DB,alias='agent_jobs'):string {
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))throw Error('invalid_job_table_alias');
 const pending=`${alias}.state NOT IN ('succeeded','failed','cancelled')`;
 if(!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='privileged_jobs'"))return pending;
 return `${pending} AND NOT EXISTS (
  SELECT 1 FROM privileged_jobs reconciled WHERE ${alias}.state='unknown' AND ${alias}.execution_principal='privileged_executor'
   AND reconciled.id=${alias}.id AND reconciled.agent_id=${alias}.agent_id
   AND reconciled.task_run_id=${alias}.id AND reconciled.capability='operations.managed.v1' AND reconciled.state='unknown'
   AND reconciled.resolved_at<>'' AND reconciled.resolved_by<>'' AND trim(reconciled.resolution_reason)<>'')`;
}
