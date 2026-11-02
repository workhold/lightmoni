import { constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync } from 'node:fs';
import { join,dirname,parse } from 'node:path';
import { canonicalJSON,parseStrictJSON,sha256 } from '../shared/privileged-executor.js';
import { managedExecutionPayload,type ManagedExecutionPayload } from '../shared/managed-execution.js';
import { fail,HTTPError } from '../shared/http.js';
import type { Dependencies } from '../shared/types.js';
import type { AgentJobStore } from './agent-jobs.js';
import type { PrivilegedExecutorStore } from './privileged-executors.js';
import type { OperationPayload } from '../operations/types.js';
import type { ReleaseArtifactStore } from '../deployment/artifact-store.js';
type Row=Record<string,any>;
const terminal=(s:string)=>['succeeded','failed','cancelled','unknown'].includes(s);
/** Trusted composition adapter. Browser/ordinary APIs cannot create this bridge
 * or supply its actor, operation payload or artifact storage path. */
export function connectManagedExecutorJobs(deps:Dependencies,options:{jobs:AgentJobStore;executors:PrivilegedExecutorStore;artifacts:ReleaseArtifactStore;resolvePlatform:(job:Row)=>OperationPayload}) {
  const {db}=deps,{jobs,executors}=options,now=()=>deps.now().toISOString();
  const activeActor=(actor:string)=>{if(!actor||!db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",actor))fail(403,'active_human_admin_required');return actor;};
  const source=(job:Row):{payload:ManagedExecutionPayload;actor:string}=>{
    if(job.execution_principal!=='privileged_executor'||terminal(job.state))fail(409,'managed_job_not_active');
    const action=job.actions[0];let actor='',operation:OperationPayload|undefined;
    if(action.kind==='operations') {
      if(action.domain==='platform') {
        operation=options.resolvePlatform(job);
        actor=db.get<Row>('SELECT actor FROM ops_platform_runs WHERE id=? AND job_id=?',job.operation_id,job.id)?.actor;
      }else{
        const run=db.get<Row>('SELECT * FROM ops_runs WHERE id=? AND job_id=?',job.operation_id,job.id);
        const resource=run&&db.get<Row>('SELECT * FROM ops_resources WHERE id=?',run.resource_id);
        if(!run||!resource||Number(resource.revision)!==Number(run.resource_revision)||resource.agent_id!==job.agent_id||!run.approved_by||run.state==='awaiting_approval')fail(409,'operations_revision_changed');
        actor=run.approved_by;operation=parseStrictJSON(deps.decrypt(run.payload_cipher));
      }
    }else if(action.kind==='systemd_probe') {
      const preflight=db.get<Row>('SELECT p.*,t.config_json,t.machine_id FROM service_target_preflights p JOIN service_targets t ON t.id=p.target_id WHERE p.id=? AND p.job_id=? AND p.agent_id=?',action.preflightID,job.id,job.agent_id);
      const host=preflight&&db.get<Row>('SELECT agent_id FROM managed_machines WHERE id=?',preflight.machine_id);
      if(!preflight||host?.agent_id!==job.agent_id||preflight.target_revision!==action.targetRevision||JSON.parse(preflight.config_json).unit!==job.target.config.unit||JSON.parse(preflight.config_json).release_directory!==job.target.config.release_directory)fail(409,'preflight_target_changed');
      actor=job.target.actor;
    }else if(action.kind==='docker') {
      const host=db.get<Row>('SELECT agent_id FROM managed_machines WHERE id=?',job.target.docker_machine_id);
      if(!host||host.agent_id!==job.agent_id||!job.target.audit_id)fail(403,'managed_docker_binding_changed');
      actor=job.target.actor;
    }else {
      const deployment=db.get<Row>('SELECT * FROM deployments WHERE id=? AND operation_id=?',job.deployment_id,job.operation_id);
      const target=deployment&&db.get<Row>('SELECT * FROM service_targets WHERE id=? AND service_id=?',deployment.target_id,deployment.service_id);
      const host=target&&db.get<Row>('SELECT agent_id FROM managed_machines WHERE id=?',target.machine_id);
      if(!deployment||!target||!host||host.agent_id!==job.agent_id||target.id!==job.target.id||canonicalJSON(JSON.parse(target.config_json))!==canonicalJSON(job.target.config))fail(409,'deployment_target_changed');
      actor=deployment.approved_by;
      if(!actor)fail(403,'deployment_approval_required');
      for(const stage of job.actions.filter((a:Row)=>a.kind==='stage_artifact')) {
        const release=db.get<Row>("SELECT * FROM releases WHERE id=? AND service_id=? AND status='ready'",stage.release_id,stage.service_id);
        if(!release||deployment.release_id!==stage.release_id||release.artifact_digest!==stage.sha256||Number(release.artifact_size)!==stage.size)fail(409,'deployment_release_changed');
      }
    }
    const payload=managedExecutionPayload({kind:'managed',operation:'execute',resource_id:job.id,resource_revision:1,job:{id:job.id,agent_id:job.agent_id,expires_at:job.expires_at,capabilities:job.capabilities,actions:job.actions,target:job.target},...(operation?{operation_payload:operation}:{}),timeout_ms:600000,max_output_bytes:262144});
    return {payload,actor:activeActor(actor)};
  };
  const nextSequence=(id:string)=>Number(db.get<Row>('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM agent_job_events WHERE job_id=?',id)?.n??1);
  const receipt=(root:Row,value:Row)=>{
    const job=jobs.get(root.id);if(terminal(job.state))return;
    let result:Row;
    if(value.stdout){try{result=parseStrictJSON(value.stdout,128<<10);}catch{fail(400,'invalid_managed_receipt');}}
    else result={state:value.state,code:value.code,summary:'Managed execution requires review',snapshot:{},started_at:root.started_at,finished_at:now()};
    if(result.state!==value.state||!result.snapshot||typeof result.snapshot!=='object'||typeof result.summary!=='string')fail(400,'managed_receipt_state_mismatch');
    jobs.result(root.agent_id,root.id,{lease_id:root.lease_id,...result});
    const final=jobs.get(root.id);
    // Domain health/identity checks are authoritative even for a valid signature.
    if(final.state!==value.state)db.run('UPDATE privileged_jobs SET state=?,code=? WHERE id=?',final.state,final.receipt.code??'invalid_managed_receipt',root.id);
  };
  jobs.setPrivilegedReadiness?.(agent=>executors.requireManagedReady(agent));
  jobs.setPrivilegedCancellation?.((id,actor)=>{executors.cancel(id,actor.split(': ')[0]);});
  executors.managed={
    prepare(executor) {
      if(db.get("SELECT id FROM privileged_jobs WHERE executor_id=? AND state='queued'",executor.id))return;
      const row=db.get<Row>("SELECT id FROM agent_jobs WHERE agent_id=? AND execution_principal='privileged_executor' AND state='queued' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM privileged_jobs p WHERE p.id=agent_jobs.id) ORDER BY created_at,id LIMIT 1",executor.agent_id,now());
      if(!row)return;
      try{const job=jobs.get(row.id),approved=source(job);executors.enqueueManaged(job,approved.payload,approved.actor);}
      catch(error){if(!(error instanceof HTTPError))throw error;jobs.cancel(row.id,'approval_invalid: '+error.message);}
    },
    validate(root) {
      const approved=source(jobs.get(root.id));
      if(sha256(canonicalJSON(approved.payload))!==root.payload_sha256)fail(409,'managed_approval_changed');
    },
    claim(root) {jobs.leasePrivileged!(root.id,root.lease_id,root.lease_expires_at);},
    sync(root) {
      const job=jobs.get(root.id);if(terminal(job.state))return;
      if(root.state==='running')db.run('UPDATE agent_jobs SET lease_expires_at=? WHERE id=?',root.lease_expires_at,root.id);
      if(root.state==='cancelled'&&job.state==='queued'){jobs.cancel(root.id,'executor cancellation');return;}
      if(root.state==='unknown'&&job.lease_expires_at<=now()){jobs.expireLeases?.();return;}
      if(['unknown','failed','cancelled'].includes(root.state)&&job.lease_id)receipt(root,{state:root.state,code:root.code,stdout:''});
    },
    event(root,value) {
      const job=jobs.get(root.id);
      const event:Row=value.detail??{phase:value.phase,summary:'Managed operation state updated'};
      if(event.phase!==value.phase)fail(400,'managed_event_phase_mismatch');
      jobs.event(root.agent_id,root.id,{lease_id:root.lease_id,sequence:nextSequence(root.id),...event});
    },
    result:receipt,
    artifact(root,value) {
      if(typeof value.release_id!=='string'||!Number.isSafeInteger(value.offset)||value.offset<0)fail(400,'invalid_artifact_range');
      const p=parseStrictJSON(deps.decrypt(root.payload_enc)) as ManagedExecutionPayload;
      const a=p.job.actions.find((a:Row)=>a.kind==='stage_artifact'&&a.release_id===value.release_id);
      if(!a||!p.job.capabilities.includes('artifact.stage')||value.offset>=a.size)fail(403,'artifact_not_authorized');
      const base=realpathSync(options.artifacts.directory),path=join(base,'sha256',a.sha256.slice(0,2),a.sha256);
      for(let at=dirname(path);at!==parse(at).root;at=dirname(at)){const s=lstatSync(at);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==0&&s.uid!==process.geteuid?.()||s.mode&0o022&&!(s.uid===0&&s.mode&0o1000))fail(403,'unsafe_artifact_storage');}
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const s=fstatSync(fd);if(!s.isFile()||s.size!==a.size)fail(409,'artifact_changed');const bytes=Buffer.alloc(Math.min(384<<10,a.size-value.offset));if(readSync(fd,bytes,0,bytes.length,value.offset)!==bytes.length)fail(409,'artifact_changed');return{sha256:a.sha256,size:a.size,offset:value.offset,data:bytes.toString('base64')};}finally{closeSync(fd);}
    },
  };
}
