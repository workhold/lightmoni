import {pendingMachineInstallation} from '../../src/server/machine-installations-guard.js';
import {hasPendingAgentUpdate} from '../../src/server/machine-agent-updates-guard.js';
import {pendingDockerInstallation} from '../../src/server/machine-docker-guard.js';
import {hasPrivilegedExecution} from '../../src/server/privileged-execution-guard.js';
import {randomUUID} from 'node:crypto';
import {registerAgentJobs as registerQueue} from '../../src/server/agent-jobs.js';
import type {Dependencies} from '../../src/shared/types.js';

/** Domain tests simulate a trusted executor's leases and receipts. Signed wire
 * authorization is exercised separately in managed-executor-jobs.test.ts. */
export function registerAgentJobs(deps:Dependencies,options:Parameters<typeof registerQueue>[1]={}) {
  const jobs=registerQueue(deps,options),{db}=deps;
  jobs.setPrivilegedReadiness?.(()=>{});
  const claim=jobs.claim.bind(jobs);
  jobs.claim=(agentID,capabilities,cursor)=>{
    const ordinary=claim(agentID,capabilities,cursor);if(ordinary)return ordinary;
    const now=deps.now().toISOString();
    if(pendingMachineInstallation(db,'',agentID)||hasPendingAgentUpdate(db,agentID)||pendingDockerInstallation(db,'',agentID)||hasPrivilegedExecution(db,'',agentID))return null;
    if(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_uninstallations'")) {
      const hosts=!!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_machines'");
      const sql="(agent_id=? AND status IN ('awaiting_approval','running','unknown','succeeded'))"+(hosts?" OR (machine_id IN (SELECT id FROM managed_machines WHERE agent_id=?) AND status IN ('awaiting_approval','running','unknown'))":"");
      if(db.get('SELECT id FROM machine_uninstallations WHERE '+sql+' LIMIT 1',agentID,...(hosts?[agentID]:[])))return null;
    }
    if(db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state IN ('leased','accepted','preflighting','staging','activating','verifying') AND lease_expires_at>?",agentID,now))return null;
    const pending=db.get<{id:string}>("SELECT id FROM agent_jobs WHERE agent_id=? AND state='queued' AND execution_principal='privileged_executor' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM json_each(agent_jobs.capabilities_json) WHERE value NOT IN (SELECT value FROM json_each(?))) ORDER BY created_at,id LIMIT 1",agentID,now,JSON.stringify(capabilities));
    return pending?jobs.leasePrivileged!(pending.id,randomUUID(),new Date(deps.now().getTime()+45000).toISOString()):null;
  };
  // Fixtures expose a deliberately synthetic executor observation; production
  // capabilities never come from the ordinary Agent heartbeat.
  if(!db.get("SELECT 1 FROM sqlite_master WHERE name='privileged_executors'")) {
    (db as any).native.function('fixture_executor_observation',(heartbeat:string)=>{
      let value:any={};try{value=JSON.parse(heartbeat);}catch{}
      return deps.encrypt(JSON.stringify({policy_generation:1,capabilities:['operations.managed.v1'],operations_capabilities:[...new Set(['operations.platform',...(value.operations_capabilities??[])])]}));
    });
    db.exec(`CREATE VIEW privileged_executors AS SELECT a.id AS id,m.id AS machine_id,a.id AS agent_id,'active' AS state,1 AS install_generation,a.last_seen,fixture_executor_observation(a.heartbeat) AS observation_enc FROM agents a JOIN managed_machines m ON m.agent_id=a.id;
      CREATE VIEW privileged_machine_policies AS SELECT id AS machine_id,agent_id,1 AS generation,'["operations.managed.v1"]' AS capabilities_json,(SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1) AS approved_by FROM managed_machines;`);
  }
  return jobs;
}

export type * from '../../src/server/agent-jobs.js';
