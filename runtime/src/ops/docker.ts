import { id } from '../shared/crypto.js';
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
  deps.router.post(path,safe(async ctx=>{
    const body=await ctx.body<any>();
    if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_docker_action');
    const response=deps.db.transaction(()=>{
    const machine=host(ctx.params.id);
    const operation=body.operation,containerID=body.container_id,requestID=body.request_id;
    if(!['inventory','start','stop','restart'].includes(operation)||typeof requestID!=='string'||!/^[a-zA-Z0-9-]{16,64}$/.test(requestID))fail(400,'invalid_docker_action');
    if(operation==='inventory'?containerID!==undefined:!(/^[a-f0-9]{64}$/.test(containerID??'')))fail(400,'invalid_docker_container');
    if(operation!=='inventory'&&body.confirmed!==true)fail(400,'docker_confirmation_required');
    const previous=deps.db.get<any>("SELECT id,agent_id,actions_json FROM agent_jobs WHERE deployment_id=? AND operation_id=?",'docker-'+machine.id,requestID);
    if(previous){
      const action=JSON.parse(previous.actions_json)[0];
      if(previous.agent_id!==machine.agent_id||action.operation!==operation||action.container_id!==containerID)fail(409,'docker_request_conflict');
      return {body:publicJob(jobs.get(previous.id)),status:200};
    }
    if(!machine.online)fail(409,'docker_agent_offline');
    if(!machine.docker_capabilities.includes(operation==='inventory'?'docker.inventory':'docker.control'))fail(409,'docker_agent_upgrade_required');
    if(machine.active_job){
      const active=jobs.get(machine.active_job);
      if(operation==='inventory'&&active.actions[0]?.operation==='inventory')return {body:publicJob(active),status:200};
      fail(409,'docker_job_in_progress');
    }
    if(operation!=='inventory'&&(!['ready','degraded'].includes(machine.state)||!machine.containers.some((c:any)=>c.id===containerID)))fail(409,'docker_fresh_inventory_required');
    const job=jobs.enqueue({agentID:machine.agent_id,deploymentID:'docker-'+machine.id,operationID:requestID,actions:[{kind:'docker',operation,...(containerID?{container_id:containerID}:{})}],capabilities:[operation==='inventory'?'docker.inventory':'docker.control'],target:{docker_machine_id:machine.id,actor:ctx.user.id,audit_id:id()},expiresInSeconds:120});
    return {body:publicJob(job),status:202};
    });
    ctx.json(response.body,response.status);
  }));
}
