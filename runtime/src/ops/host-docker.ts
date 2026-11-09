import {id} from '../shared/crypto.js';
import {fail} from '../shared/http.js';
import {hostDockerHash,hostDockerReadOnly,normalizeHostDockerAction,type HostDockerAction} from '../shared/host-docker.js';
import type {Dependencies,Context,Handler} from '../shared/types.js';
import type {AgentJobStore} from '../server/agent-jobs.js';
import {blockingAgentJobSQL} from '../server/agent-job-fence.js';

export function registerHostDockerJobs(deps:Dependencies,jobs:AgentJobStore,safe:(fn:Handler)=>Handler,host:(id:string)=>any){
 const path='/api/v1/ops/machines/:id/container-jobs';
 const human=(ctx:Context)=>{
  deps.auth.requireAdmin(ctx);const live=deps.auth.user(ctx.req);
  if(ctx.req.headers.authorization||!ctx.req.headers.cookie?.split(';').some(p=>p.trim().startsWith('lm_session='))||live?.id!==ctx.user.id||live?.role!=='admin'||!deps.db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",ctx.user.id))fail(403,'human_admin_session_required');
 };
 const publicJob=(j:any)=>({id:j.id,request_id:j.operation_id,state:j.state,blocking:!!deps.db.get(`SELECT id FROM agent_jobs WHERE id=? AND ${blockingAgentJobSQL(deps.db)}`,j.id),action:j.actions[0],issued_at:j.issued_at,expires_at:j.expires_at,code:j.receipt?.code??'',result:j.state==='succeeded'||j.actions[0]?.operation==='remove_many'?j.receipt?.snapshot?.host_docker??null:null});
 const owned=(machine:any,jobID:string)=>{const j=jobs.get(jobID);if(j.agent_id!==machine.agent_id||j.target?.host_docker_machine_id!==machine.id)fail(404,'container_job_not_found');return j};
 deps.router.get(path,safe(ctx=>{human(ctx);const m=host(ctx.params.id);ctx.json({jobs:deps.db.all<any>("SELECT id FROM agent_jobs WHERE agent_id=? AND json_extract(target_json,'$.host_docker_machine_id')=? ORDER BY created_at DESC,rowid DESC LIMIT 50",m.agent_id,m.id).map(r=>publicJob(owned(m,r.id)))});}));
 deps.router.get(path+'/:jobID',safe(ctx=>{human(ctx);ctx.json(publicJob(owned(host(ctx.params.id),ctx.params.jobID)));}));
 deps.router.post(path,safe(async ctx=>{
  human(ctx);const body=await ctx.body<any>();
  if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['action','request_id','confirmed'].includes(k))||typeof body.request_id!=='string'||!/^[a-zA-Z0-9-]{16,64}$/.test(body.request_id))fail(400,'invalid_host_docker_action');
  let action:HostDockerAction;try{action=normalizeHostDockerAction(body.action)}catch{fail(400,'invalid_host_docker_action')}
  if(!hostDockerReadOnly(action)&&body.confirmed!==true)fail(400,'docker_confirmation_required');
  const response=deps.db.transaction(()=>{
   human(ctx);const m=host(ctx.params.id);
   const old=deps.db.get<any>('SELECT id FROM agent_jobs WHERE deployment_id=? AND operation_id=?','host-docker-'+m.id,body.request_id);
   if(old){const j=owned(m,old.id);if(hostDockerHash(normalizeHostDockerAction(j.actions[0]))!==hostDockerHash(action))fail(409,'docker_request_conflict');return {job:j,status:200}}
   if(!m.online)fail(409,'docker_agent_offline');
   if(!m.docker_capabilities.includes('docker.host'))fail(409,'host_docker_upgrade_required');
   if(['inspect_many','remove_many'].includes(action.operation)&&!m.docker_capabilities.includes('docker.host.batch'))fail(409,'host_docker_upgrade_required');
   if(m.state!=='ready'||m.truncated)fail(409,'docker_fresh_inventory_required');
   if(action.operation==='remove_many'&&action.targets.some(target=>!m.containers.some((c:any)=>c.id===target.container_id&&c.name===target.name&&(!action.stopped_only||['exited','created','dead'].includes(c.state)))))fail(409,'docker_fresh_inventory_required');
   if(action.operation==='prune_images'){
    const preview=owned(m,action.preview_job_id),r=preview.receipt?.snapshot?.host_docker;
    if(preview.state!=='succeeded'||preview.actions[0]?.operation!=='images'||!r||r.truncated||r.observed_at!==action.previewed_at||deps.now().getTime()-Date.parse(r.observed_at)>300000)fail(409,'host_docker_preview_expired');
    if(action.images.some(target=>!r.images.some((i:any)=>i.id===target.image_id&&i.revision===target.expected_revision&&!i.in_use)))fail(409,'host_docker_preview_changed');
   }
   const j=jobs.enqueue({agentID:m.agent_id,deploymentID:'host-docker-'+m.id,operationID:body.request_id,actions:[action],capabilities:['docker.host'],target:{host_docker_machine_id:m.id,actor:ctx.user.id,audit_id:id()},expiresInSeconds:300});
   return {job:j,status:202};
  });ctx.json(publicJob(response.job),response.status);
 }));
}
