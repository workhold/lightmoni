import type {Dependencies,Module} from '../shared/types.js';
import type {MachineTerminalAccess} from './managed-machines.js';
import type {AgentJobStore} from './agent-jobs.js';
import type {PrivilegedExecutorStore} from './privileged-executors.js';
import type {TaskRunStore} from './task-center.js';
import {defaultSSHRunner,SSHError,type SSHRunner} from './machine-ssh.js';

type Candidate={id:string;machine_id:string;kind:'privileged'|'ordinary'|'task'};
const JOB_ID=/^[a-f0-9-]{32,36}$/;

/** Only the centre initiates approved host work. The installed worker is run
 * once through the pinned SSH channel; resident Agent loops never claim it. */
export function registerCenterSSHDispatch(deps:Dependencies,access:MachineTerminalAccess,jobs:AgentJobStore,executors:PrivilegedExecutorStore,
  runner:SSHRunner=defaultSSHRunner,intervalMs=1000,taskRuns?:TaskRunStore):Module&{tick():void} {
  const {db}=deps,active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  let timer:ReturnType<typeof setInterval>|undefined,closed=false;
  jobs.setSSHOnly?.();executors.setSSHOnly();taskRuns?.setSSHOnly();
  const pending=(job:Candidate)=>db.get<{state:string}>(`SELECT state FROM ${job.kind==='privileged'?'privileged_jobs':job.kind==='task'?'task_runs':'agent_jobs'} WHERE id=?`,job.id)?.state==='queued';
  const failQueued=(job:Candidate,code:string)=>{
    if(!pending(job))return;
    if(job.kind==='privileged')executors.failQueuedSSH(job.id,code);
    else if(job.kind==='task')taskRuns?.failQueuedSSH(job.id,code);
    else jobs.failQueuedSSH?.(job.id,code);
  };
  const run=async(job:Candidate,controller:AbortController)=>{
    if(!JOB_ID.test(job.id)){failQueued(job,'invalid_job_id');return;}
    let lease:ReturnType<MachineTerminalAccess['acquireTerminal']>|undefined;
    try{
      if(!pending(job))return;
      lease=access.acquireTerminal(job.machine_id,undefined,()=>controller.abort());
      if(!lease.valid())throw Error('ssh_binding_changed');
      const direct=lease.machine.username==='root',ordinary=lease.machine.username==='lightmoni-agent';
      const executable='/usr/local/bin/lightmoni-agent';
      const command=job.kind==='privileged'||job.kind==='task'
        ? `${direct?'':'sudo -n '}${executable} ${job.kind==='task'?'task-once':'managed-once'} --job-id ${job.id}`
        : `${ordinary?'':'sudo -n -u lightmoni-agent '}${executable} jobs-once --config /etc/lightmoni-agent/config.json --job-id ${job.id}`;
      await runner({machine:lease.machine,credentialID:lease.credentialID,privateKey:lease.privateKey,
        ...(lease.credentialMethod==='password'?{password:lease.password}:{}),command,
        port:lease.machine.port,signal:controller.signal,verifyHostKey:key=>lease!.verifyHostKey(key),timeoutMs:2*60*60_000});
      lease.markUsed();
    }catch(error){
      if(closed)return;
      const code=controller.signal.aborted||error instanceof Error&&error.message==='ssh_binding_changed'?'ssh_binding_changed'
        :error instanceof SSHError&&error.code==='host_key_mismatch'?'host_key_mismatch'
        :error instanceof SSHError&&error.code==='timed_out'?'ssh_timeout':'ssh_dispatch_failed';
      // A running job may already have changed the host. Its lease and
      // read-only reconciliation path retain the unknown result.
      failQueued(job,code);
    }finally{lease?.release();}
  };
  const tick=()=>{
    if(closed)return;
    for(const row of db.all<{id:string}>(`SELECT DISTINCT m.id FROM agent_jobs j JOIN managed_machines m ON m.agent_id=j.agent_id
      WHERE j.state='queued' AND j.execution_principal='privileged_executor' LIMIT 100`)){
      try{executors.prepareSSH(row.id);}catch(error){deps.logger.warn('ssh_managed_prepare_failed',error);}
    }
    const candidates:Candidate[]=[
      ...db.all<{id:string;machine_id:string}>("SELECT id,machine_id FROM privileged_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 100")
        .map(row=>({...row,kind:'privileged' as const})),
      ...db.all<{id:string;machine_id:string}>(`SELECT j.id,m.id AS machine_id FROM agent_jobs j JOIN managed_machines m ON m.agent_id=j.agent_id
        WHERE j.state='queued' AND j.execution_principal='ordinary_agent' ORDER BY j.created_at,j.id LIMIT 100`)
        .map(row=>({...row,kind:'ordinary' as const})),
      ...(taskRuns?db.all<{id:string;machine_id:string}>(`SELECT id,host_id AS machine_id FROM task_runs WHERE state='queued'
        AND execution_principal='agent' AND (trigger='manual' OR (trigger='retry' AND requested_by!='scheduler'))
        ORDER BY created_at,id LIMIT 100`).map(row=>({...row,kind:'task' as const})):[]),
    ];
    for(const job of candidates){
      if(active.has(job.machine_id))continue;
      const controller=new AbortController(),promise=run(job,controller).catch(error=>deps.logger.error('center_ssh_dispatch_failed',error))
        .finally(()=>active.delete(job.machine_id));
      active.set(job.machine_id,{controller,promise});
    }
  };
  return {tick,start(){timer=setInterval(tick,intervalMs);timer.unref();queueMicrotask(tick);},async close(){
    closed=true;if(timer)clearInterval(timer);
    for(const item of active.values())item.controller.abort();
    await Promise.allSettled([...active.values()].map(item=>item.promise));
  }};
}
