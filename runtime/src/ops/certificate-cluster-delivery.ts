import {randomUUID} from 'node:crypto';
import {HTTPError} from '../shared/http.js';
import type {CertificateMaterial} from './certificates.js';
import type {PlatformOptions,PlatformResource,PlatformRun} from './types.js';

const ACTIVE=new Set(['queued','leased','accepted','preflighting','staging','activating','verifying','running']);
type Member={machine_id:string;agent_id:string;error?:string};
type DeliveryVersion=Pick<CertificateMaterial,'certificate_version'|'fingerprint_sha256'>;
export function createClusterCertificateDelivery({store,deps}:PlatformOptions){
 const {db}=deps,at=()=>deps.now().toISOString();
 const exists=(table:string)=>!!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table);
 const activeAgent=(agentID:string)=>!!db.get('SELECT id FROM agents WHERE id=?',agentID)&&
  (!exists('agent_lifecycle')||!db.get("SELECT agent_id FROM agent_lifecycle WHERE agent_id=? AND state='removed'",agentID));
 function members(target:PlatformResource):Member[]{
  const cluster=store.get(target.spec.cluster_id,'cluster');
  if(!Array.isArray(cluster.spec.machine_ids)||cluster.spec.machine_ids.length>100)throw new HTTPError(409,'invalid_certificate_cluster_members');
  return cluster.spec.machine_ids.map((machineID:string)=>{
   const machine=exists('managed_machines')?db.get<{agent_id:string}>('SELECT agent_id FROM managed_machines WHERE id=?',machineID):undefined;
   const agentID=machine?.agent_id??'';
   return {machine_id:machineID,agent_id:agentID,...(!agentID||!activeAgent(agentID)?{error:'certificate_cluster_machine_agent_required'}:{})};
  });
 }
 function preflight(target:PlatformResource,actor:string,material:CertificateMaterial){
  if(!store.authorized(actor))throw new HTTPError(403,'operations_authorization_revoked');
  if(store.get(target.id).revision!==target.revision)throw new HTTPError(409,'platform_revision_conflict');
  const list=members(target),error=!list.length?'certificate_cluster_empty':list.find(m=>m.error)?.error??(new Set(list.map(m=>m.agent_id)).size!==list.length?'certificate_cluster_agent_binding_conflict':undefined);
  if(error){refresh(target,material);store.patchStatus(target.id,{state:'failed',last_error:error,applied_certificate_version:null,applied_revision:null});throw new HTTPError(409,error);}
  return list;
 }
 const key=(target:PlatformResource,material:DeliveryVersion,m:Member)=>
  ['certificate-target',target.id,target.revision,material.certificate_version,'cluster',target.spec.cluster_id,'machine',m.machine_id,'agent',m.agent_id].join(':');
 function latest(target:PlatformResource,material:DeliveryVersion,m:Member){
  const prefix=key(target,material,m);
  const write=db.get<{id:string;sequence:number}>('SELECT id,rowid sequence FROM ops_platform_runs WHERE resource_id=? AND resource_revision=? AND agent_id=? AND substr(dedupe_key,1,?)=? ORDER BY rowid DESC LIMIT 1',target.id,target.revision,m.agent_id,prefix.length,prefix);
  const inspection=db.get<{id:string;sequence:number}>('SELECT id,rowid sequence FROM ops_platform_runs WHERE resource_id=? AND resource_revision=? AND agent_id=? AND action=? ORDER BY rowid DESC LIMIT 1',target.id,target.revision,m.agent_id,'inspect');
  let row=write;
  if(inspection&&(!write||inspection.sequence>write.sequence)){
   // An inspection of an older certificate version cannot erase a newer desired version.
   const payload=db.get<{payload_cipher:string}>('SELECT payload_cipher FROM ops_platform_runs WHERE id=?',inspection.id)!;
   const config=JSON.parse(deps.decrypt(payload.payload_cipher)).resource.config;
   if(config.certificate_version===material.certificate_version&&config.machine_id===m.machine_id)row=inspection;
  }
  const run=row?store.action(row.id):undefined;
  const applied=run?.state==='succeeded'&&run.result.fingerprint_sha256===material.fingerprint_sha256&&run.result.certificate_version===material.certificate_version;
  const original=write?store.action(write.id):undefined;
  const state=m.error?'failed':applied?'applied':original?.state==='unknown'?'unknown':run?(ACTIVE.has(run.state)?run.state:run.state==='unknown'?'unknown':'failed'):'pending';
  return {run,original,state,applied};
 }
 function refresh(target:PlatformResource,material:DeliveryVersion){
  const list=members(target).map(m=>{const result=latest(target,material,m);return {...m,run_id:result.run?.id,state:result.state,
   desired_certificate_version:material.certificate_version,applied_certificate_version:result.applied?material.certificate_version:null,
   revision:target.revision,...(result.state==='failed'||result.state==='unknown'?{last_error:m.error??result.run?.result.code??result.run?.result.error??'certificate_delivery_not_verified'}:{})};});
  const applied=list.length>0&&list.every(m=>m.state==='applied');
  const state=applied?'applied':!list.length?'failed':list.some(m=>m.state==='unknown')?'unknown':list.some(m=>m.state==='failed')?'failed':list.some(m=>ACTIVE.has(m.state))?'queued':'pending';
  store.patchStatus(target.id,{state,machines:list,desired_revision:target.revision,desired_certificate_version:material.certificate_version,
   applied_revision:applied?target.revision:null,applied_certificate_version:applied?material.certificate_version:null,
   fingerprint_sha256:applied?material.fingerprint_sha256:null,last_error:applied?null:!list.length?'certificate_cluster_empty':list.find(m=>m.last_error)?.last_error??null,observed_at:at()});
 }
 function config(target:PlatformResource,material:CertificateMaterial,m:Member,automatic=false){
  return {...target.spec,agent_id:m.agent_id,machine_id:m.machine_id,automatic,task:'certificate.install',certificate_version:material.certificate_version,
   fingerprint_sha256:material.fingerprint_sha256,certificate_pem:material.certificate_pem,private_key_pem:material.private_key_pem};
 }
 function sync(target:PlatformResource,material:CertificateMaterial,actor:string,retry=false,automatic=false){
  const list=preflight(target,actor,material),states=list.map(m=>({m,...latest(target,material,m)}));
  if(retry&&states.some(s=>s.state==='unknown'))throw new HTTPError(409,'verify_unknown_certificate_target_before_retry');
  const runs:PlatformRun[]=[];
  try{for(const state of states){
   if(state.applied||state.run&&ACTIVE.has(state.run.state)||retry&&state.state!=='failed'||automatic&&state.run&&['failed','unknown'].includes(state.state)){
    if(state.run)runs.push(state.run);continue;
   }
   const dedupe=key(target,material,state.m)+(retry&&state.run?':retry:'+randomUUID():'');
   runs.push(store.queue(target,state.m.agent_id,'sync',config(target,material,state.m,automatic),actor,dedupe));
  }}finally{refresh(target,material);}
  return {runs};
 }
 function inspect(target:PlatformResource,material:CertificateMaterial,actor:string){
  const list=preflight(target,actor,material),runs=list.map(m=>store.queue(target,m.agent_id,'inspect',{
   ...target.spec,agent_id:m.agent_id,machine_id:m.machine_id,task:'certificate.inspect',certificate_version:material.certificate_version,fingerprint_sha256:material.fingerprint_sha256,
  },actor));refresh(target,material);return {runs};
 }
 return {sync,inspect,
  onRun(target:PlatformResource,run:PlatformRun,config:Record<string,any>){
   if(run.resource_revision!==target.revision||config.cluster_id!==target.spec.cluster_id)return;
   const certificate=store.get(target.spec.certificate_id,'certificate');
   if(config.certificate_version!==certificate.status.certificate_version)return;
   // Only safe metadata is needed to aggregate receipts; do not decrypt private material here.
   refresh(target,{certificate_version:certificate.status.certificate_version,fingerprint_sha256:certificate.status.fingerprint_sha256});
  },
  validatePayload(target:PlatformResource,config:Record<string,any>,agentID:string){
   if(target.spec.type!=='directory'||!target.spec.cluster_id)return;
   if(config.certificate_version!==store.get(target.spec.certificate_id,'certificate').status.certificate_version)
    throw new HTTPError(403,'certificate_payload_version_changed');
   if(config.cluster_id!==target.spec.cluster_id||config.agent_id!==agentID||!activeAgent(agentID)||
    !members(target).some(m=>m.machine_id===config.machine_id&&m.agent_id===agentID&&!m.error)||config.automatic&&!target.spec.enabled)
    throw new HTTPError(403,'certificate_cluster_membership_changed');
  },
 };
}
