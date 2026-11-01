import { fail } from '../shared/http.js';
import { dockerInventory, type DockerInventory } from '../shared/application-observation.js';
import { safeDockerCode } from '../shared/docker-jobs.js';
import type { DB } from '../shared/sqlite.js';
import type { Dependencies, Handler } from '../shared/types.js';
import type { AgentJobStore } from '../server/agent-jobs.js';

const terminal=(state:string)=>['succeeded','failed','cancelled','unknown'].includes(state);
const publicJob=(job:any)=>({id:job.id,state:job.state,operation:job.actions?.[0]?.operation,container_id:job.actions?.[0]?.container_id??'',issued_at:job.issued_at,expires_at:job.expires_at,code:job.receipt?.code?safeDockerCode(job.receipt.code):''});

export function dockerObservation(db:DB,agentID:string,heartbeat:any){
  let snapshot: DockerInventory|undefined=dockerInventory(heartbeat.docker_inventory);
  let activeID='';
  if(!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_jobs'"))return {snapshot,activeID};
  const completed=db.all<any>("SELECT receipt_json FROM agent_jobs WHERE agent_id=? AND json_extract(target_json,'$.docker_machine_id') IS NOT NULL AND state='succeeded' ORDER BY updated_at DESC,rowid DESC LIMIT 1",agentID);
  for(const row of completed){try{const candidate=dockerInventory(JSON.parse(row.receipt_json).snapshot?.docker?.inventory);if(candidate&&(!snapshot||Date.parse(candidate.observed_at)>Date.parse(snapshot.attempted_at??snapshot.observed_at)))snapshot=candidate;}catch{}}
  const last=db.get<any>("SELECT id,state,receipt_json,updated_at FROM agent_jobs WHERE agent_id=? AND json_extract(target_json,'$.docker_machine_id') IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",agentID);
  if(last&&!terminal(last.state))activeID=last.id;
  if(last&&['failed','unknown'].includes(last.state)&&(!snapshot||Date.parse(last.updated_at)>Date.parse(snapshot.attempted_at??snapshot.observed_at))){
    const receipt=JSON.parse(last.receipt_json||'{}');
    snapshot={observed_at:snapshot?.observed_at??new Date(0).toISOString(),attempted_at:last.updated_at,state:'unavailable',error:safeDockerCode(receipt.code),containers:snapshot?.containers??[],truncated:snapshot?.truncated??false};
  }
  return {snapshot,activeID};
}

export function registerDockerJobs(deps:Dependencies,jobs:AgentJobStore,safe:(fn:Handler)=>Handler,host:(machineID:string)=>any){
  const path='/api/v1/ops/machines/:id/docker-jobs';
  deps.router.get(path+'/:jobID',safe(ctx=>{
    const machine=host(ctx.params.id),job=jobs.get(ctx.params.jobID);
    if(job.target?.docker_machine_id!==machine.id||job.agent_id!==machine.agent_id)fail(404,'docker_job_not_found');
    ctx.json(publicJob(job));
  }));
  deps.router.post(path,safe(() => {
    fail(410, 'legacy_agent_payload_removed');
  }));
}
