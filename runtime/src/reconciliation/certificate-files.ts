import { getCertificateMaterial } from '../ops/certificates.js';
import type { PlatformOptions, PlatformResource } from '../ops/types.js';
import { operationExecutionCapabilities } from '../server/managed-executor-status.js';
import { blockingAgentJobSQL } from '../server/agent-job-fence.js';
import { desiredHash } from '../shared/desired-state.js';

const ACTIVE=new Set(['queued','leased','accepted','preflighting','staging','activating','verifying','running']);
/** A directory target fans out into individually fenced, continuously checked files. */
export function registerCertificateFiles({store,deps,reconciliation}:PlatformOptions) {
  if(!reconciliation)return;
  const members=(target:PlatformResource)=>{
    if(!target.spec.cluster_id)return deps.db.all<any>('SELECT id machine_id,agent_id FROM managed_machines WHERE agent_id=?',target.spec.agent_id);
    const cluster=store.get(target.spec.cluster_id,'cluster');
    return cluster.spec.machine_ids.map((id:string)=>deps.db.get<any>('SELECT id machine_id,agent_id FROM managed_machines WHERE id=?',id)).filter((m:any)=>m?.agent_id);
  };
  reconciliation.register({kind:'file.certificate',category:'file',collect:()=>store.list('certificate_target').filter(t=>t.spec.type==='directory').flatMap(target=>{
    const certificate=store.get(target.spec.certificate_id,'certificate');
    const version=target.spec.enabled?certificate.status.certificate_version:target.status.desired_certificate_version;
    if(!version&&!target.status.cleanup_requested)return [];
    const material=version?getCertificateMaterial(store,certificate.id,version):{};
    // The physical key includes the destination, so a path edit retains cleanup
    // intent for the old path instead of overwriting its identity.
    const physical=desiredHash([target.spec.path,target.spec.certificate_id,target.spec.certificate_file,target.spec.private_key_file]);
    return members(target).map((m:any)=>({key:target.id+':'+physical,machine_id:m.machine_id,agent_id:m.agent_id,owner_id:target.id,actor:target.authorized_by,
      desired:{present:!target.status.cleanup_requested,config:{...target.spec,...material,machine_id:m.machine_id,agent_id:m.agent_id}},
      summary:{certificate_id:certificate.id,certificate_version:version??'',cluster_id:target.spec.cluster_id??'',path:target.spec.path,certificate_file:target.spec.certificate_file,private_key_file:target.spec.private_key_file,present:!target.status.cleanup_requested,suspended:!target.spec.enabled&&!target.status.cleanup_requested},
    }));
  }),reconcile:r=>{
    if(!store.authorized(r.actor))return {state:'blocked',code:'operations_authorization_revoked'};
    const current=store.list('certificate_target').find(t=>t.id===r.owner_id);
    if(!current)return {state:'blocked',code:'cleanup_ownership_required'};
    if(deps.db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',r.machine_id)?.agent_id!==r.agent_id)return {state:'blocked',code:'agent_binding_changed'};
    if(!current.spec.enabled&&!current.status.cleanup_requested&&!current.status.managed_sync_requested)return {state:'blocked',code:'certificate_sync_suspended'};
    const agent=deps.db.get<any>('SELECT last_seen FROM agents WHERE id=?',r.agent_id);
    if(!agent||deps.now().getTime()-Date.parse(agent.last_seen)>120000)return {state:'pending',code:'agent_offline'};
    if(!operationExecutionCapabilities(deps,r.agent_id).includes('operations.platform.reconciliation.v1'))return {state:'blocked',code:'reconciliation_agent_upgrade_required'};
    const locked=deps.db.get<any>(`SELECT id,state FROM agent_jobs j WHERE agent_id=? AND ${blockingAgentJobSQL(deps.db,'j')} LIMIT 1`,r.agent_id);
    if(locked)return {state:locked.state==='unknown'?'blocked':'pending',code:locked.state==='unknown'?'unknown_execution_result':'machine_busy'};
    const run=r.job_id?store.action(r.job_id):undefined;
    if(run&&ACTIVE.has(run.state))return {state:'pending',job_id:run.id};
    const raw=run?deps.db.get<any>('SELECT payload_cipher FROM ops_platform_runs WHERE id=?',run.id):undefined;
    const config=raw?JSON.parse(deps.decrypt(raw.payload_cipher)).resource.config:{};
    const bound=config.reconciliation_hash===r.desired_hash&&config.reconciliation_generation===r.generation;
    if(bound&&run?.state==='failed'&&/OWNERSHIP|UNSAFE_MANAGED_PATH/.test(String(run.result.code??run.result.error??'')))return {state:'blocked',code:'certificate_ownership_conflict',job_id:run.id};
    const remove=r.deleted||!r.desired.present;
    const queue=(task:string,repair=false)=>{
      const job=store.queue(current,r.agent_id,task.split('.')[1],{...r.desired.config,task,repair,automatic:true,
        expected_absent:remove,reconciliation_cleanup:remove,reconciliation_hash:r.desired_hash,reconciliation_resource_id:r.id,reconciliation_generation:r.generation},r.actor);
      return {state:'pending' as const,code:task==='certificate.inspect'?'verifying_certificate':'repairing_certificate',job_id:job.id};
    };
    if(bound&&run?.state==='failed'&&r.state!=='drifted')return {state:'drifted',code:'certificate_attempt_failed',job_id:run.id};
    if(bound&&run?.state==='succeeded'&&r.state!=='in_sync'&&deps.now().getTime()-Date.parse(run.updated_at)<60000) {
      if(config.task==='certificate.inspect') {
        if(run.result.configuration_matches===true)return {state:'in_sync',job_id:run.id};
        return queue(remove?'certificate.remove':'certificate.install',!remove&&run.result.managed===true);
      }
    }
    if(bound&&run?.state==='failed'&&!config.task?.endsWith('.inspect'))return queue(remove?'certificate.remove':'certificate.install',config.repair===true);
    return queue('certificate.inspect');
  }});
}
