import {fail,HTTPError} from '../shared/http.js';
import {catalogInstallation,catalogTemplate} from './catalog.js';
import {normalizeDomain} from './cloud.js';
import {systemApplicationID} from './system-applications.js';
import {certificateMetadata} from '../operations/certificates.js';
import type {PlatformStore,PlatformResource,DomainController} from './types.js';
type Row=Record<string,any>;
const code=(e:unknown)=>e instanceof HTTPError?e.message.split(':')[0]:'quick_install_failed';

/** Domain-specific orchestration: durable resource references, existing controllers own effects. */
export function createQuickInstall(store:PlatformStore,workloads:DomainController) {
 const {db}=store.deps,at=()=>store.deps.now().toISOString();
 const patch=(id:string,next:Row)=>store.patchStatus(id,{quick_install:{...store.get(id).status.quick_install,...next,updated_at:at()}});
 function automaticPlacement(templateID:string,domain?:string) {
  const template=catalogTemplate(templateID),cpu=template.resources?.cpu??(templateID==='mysql'?1:.25),memory=template.resources?.memory_mb??(templateID==='mysql'?512:128);
  const factor=Math.max(1,Object.keys(template.spec?.compose?.services??{}).length);
  const candidates:Row[]=[];
  for(const cluster of store.list('cluster'))for(const key of cluster.spec.machine_ids??[]) {
   const machine=db.get<Row>('SELECT * FROM managed_machines WHERE id=?',key);
   const agent=machine?.agent_id?db.get<Row>('SELECT * FROM agents WHERE id=?',machine.agent_id):undefined;
   if(!agent||store.deps.now().getTime()-Date.parse(agent.last_seen)>120000)continue;
   if(template.architectures&&!template.architectures.includes(agent.arch==='aarch64'?'arm64':agent.arch==='x86_64'?'amd64':agent.arch))continue;
   const override=cluster.spec.nodes?.find((n:Row)=>n.machine_id===key)??{};
   const observed=db.get<Row>('SELECT node_json FROM ops_platform_nodes WHERE agent_id=?',agent.id);
   let heartbeat:Row={};try{heartbeat=JSON.parse(agent.heartbeat??'{}')}catch{}
   const node={cpu:heartbeat.cpu_count??heartbeat.cpu?.cores??0,memory_mb:heartbeat.memory_total_mb??(heartbeat.memory?.total?heartbeat.memory.total/1048576:0),...(observed?JSON.parse(observed.node_json):{})};
   const used=db.get<Row>("SELECT COALESCE(SUM(cpu),0) cpu,COALESCE(SUM(memory_mb),0) memory_mb FROM ops_cluster_instances WHERE agent_id=? AND state NOT IN ('stopped','removed')",agent.id)!;
   const freeCPU=Number(override.cpu??node.cpu??0)-used.cpu,freeMemory=Number(override.memory_mb??node.memory_mb??0)-used.memory_mb;
   const gatewayCost=domain&&!store.list('application').some(a=>a.spec.role==='openresty'&&a.spec.deployments.some((d:Row)=>d.cluster_id===cluster.id))?{cpu:.25,memory:128}:{cpu:0,memory:0};
   if(freeCPU<cpu*factor+gatewayCost.cpu||freeMemory<memory*factor+gatewayCost.memory)continue;
   candidates.push({cluster_id:cluster.id,machine_ids:[key],cpu,memory_mb:memory,replicas:1,freeMemory});
  }
  candidates.sort((a,b)=>b.freeMemory-a.freeMemory||a.cluster_id.localeCompare(b.cluster_id)||a.machine_ids[0].localeCompare(b.machine_ids[0]));
  if(!candidates.length)fail(409,'quick_install_no_available_machine');
  const {freeMemory,...placement}=candidates[0];return placement;
 }
 async function install(templateID:string,input:Row,actor:string) {
  const b={...input};
  if(b.deployments!==undefined&&!Array.isArray(b.deployments))fail(400,'invalid_catalog_parameters');
  if(b.request_id!==undefined&&(typeof b.request_id!=='string'||! /^[A-Za-z0-9_-]{8,128}$/.test(b.request_id)))fail(400,'invalid_install_request_id');
  if(b.domain!==undefined&&typeof b.domain!=='string')fail(400,'invalid_domain');
  const domain=b.domain?.trim()?normalizeDomain(b.domain):undefined;
  const prior=b.request_id?store.list('application').find(a=>a.created_by===actor&&a.status.install_request?.id===b.request_id):undefined;
  if(prior){if(prior.spec.source.template_id!==templateID||prior.status.quick_install?.domain!==domain)fail(409,'install_request_conflict');return{resource:store.public(prior),reused:true}}
  if(!b.deployments?.length)b.deployments=[automaticPlacement(templateID,domain)];
  if(!b.deployment_mode)b.deployment_mode='manual';
  const installation=catalogInstallation(templateID,b);
  let zone:PlatformResource|undefined,certificate:PlatformResource|undefined,account:PlatformResource|undefined;
  const http=(installation.spec as Row).ports?.find((p:Row)=>p.protocol==='tcp'&&['http','https'].includes(p.app_protocol));
  if(domain) {
   if(b.confirmed!==true)fail(400,'platform_confirmation_required');
   if(templateID==='openresty'||!http)fail(400,'quick_install_http_port_required');
   zone=store.list('dns_zone').filter(z=>domain===z.spec.scope||domain.endsWith('.'+z.spec.scope)).sort((a,b)=>b.spec.scope.length-a.spec.scope.length||a.id.localeCompare(b.id))[0];
   if(!zone)fail(400,'quick_install_domain_not_hosted');
   if(domain===zone.spec.domain)fail(400,'quick_install_cname_subdomain_required');
   if(store.list('website').some(s=>s.spec.bindings.some((v:Row)=>v.domains.includes(domain))))fail(409,'website_domain_conflict');
   certificate=store.list('certificate').find(c=>{
    if(c.spec.source==='self_signed'||!c.spec.domains.some((d:string)=>d===domain||d.startsWith('*.')&&domain.endsWith(d.slice(1))&&domain.split('.').length===d.split('.').length))return false;
    if(c.spec.source==='uploaded')try{certificateMetadata(c.spec.certificate_pem,c.spec.private_key_pem,[domain],store.deps.now());}catch{return false}
    return true;
   });
   account=store.list('acme_account').sort((a,b)=>a.created_at.localeCompare(b.created_at))[0];
   if(!certificate&&!account)fail(400,'quick_install_acme_account_required');
  }
  let app!:PlatformResource,gateway:PlatformResource|undefined,site:PlatformResource|undefined;
  db.transaction(()=>{
   if(domain) {
    const gatewayID=systemApplicationID(store,'openresty');gateway=gatewayID?store.get(gatewayID,'application'):undefined;
    const additions=b.deployments.filter((d:Row)=>!gateway?.spec.deployments.some((v:Row)=>v.cluster_id===d.cluster_id)).map((d:Row)=>({...d,cpu:.25,memory_mb:128,gateway_dns_zone_id:zone!.id}));
    if(!gateway) {const entry=catalogInstallation('openresty',{deployments:additions,deployment_mode:'manual'});gateway=store.create('application',entry.name,entry.spec,actor)}
    else if(additions.length)gateway=store.updateSystemApplication(gateway.id,gateway.revision,gateway.name,{...gateway.spec,deployments:[...gateway.spec.deployments,...additions]},actor);
    if(!certificate)certificate=store.create('certificate',domain+' TLS',{source:'acme',domains:[domain],auto_renew:true,acme_account_id:account!.id,dns_zone_ids:[zone!.id]},actor);
   }
   app=store.create('application',installation.name,installation.spec,actor);
   if(b.request_id)store.patchStatus(app.id,{install_request:{id:b.request_id}});
   if(domain) {
    site=store.create('website',domain,{mode:'proxy',routing_mode:'managed',service_application_id:app.id,service_port_name:http.name,dns_record_mode:'cname',bindings:[{domains:[domain],https:true,certificate_id:certificate!.id,dns_enabled:true,dns_zone_id:zone!.id,locations:[{path:'/'}]}]},actor);
    patch(app.id,{domain,website_id:site.id,certificate_id:certificate!.id,gateway_id:gateway!.id,state:'awaiting_backend',error:''});
   }
  });
  let result:Row={};
  if(b.confirmed===true)try{
   if(gateway)for(const d of b.deployments)if(!gateway.status.deployments?.[d.cluster_id]?.enabled)await workloads.perform(gateway,'deploy',{cluster_id:d.cluster_id},actor);
   result=await workloads.perform(app,'deploy',{},actor);
  }catch(e){const error=code(e);store.patchStatus(app.id,{last_error:error,last_error_at:at()});if(domain)patch(app.id,{state:'failed',error});result={deployment_error:error,runs:store.actions(app.id)}}
  return {resource:store.public(store.get(app.id)),...result};
 }
 async function advance(app:PlatformResource) {
  const q=app.status.quick_install;if(!q||['ready','failed','unknown'].includes(q.state))return;
  const site=store.get(q.website_id,'website'),gateway=store.get(q.gateway_id,'application');
  const clusterIDs=app.spec.deployments.map((d:Row)=>d.cluster_id);
  const states=[...Object.values<Row>(app.status.deployments??{}),...clusterIDs.map((cid:string)=>gateway.status.deployments?.[cid]??{})];
  const instances=[...(app.status.instances??[]),...(gateway.status.instances??[])].filter((i:Row)=>!i.retired&&clusterIDs.includes(i.cluster_id));
  if(instances.some((i:Row)=>i.state==='unknown')||states.some(d=>d.phase==='unknown')){patch(app.id,{state:'unknown',error:'quick_install_execution_unknown'});return}
  const failed=states.find(d=>d.last_error||d.phase==='failed');
  if(failed||instances.some((i:Row)=>i.state==='failed')){patch(app.id,{state:'failed',error:failed?.last_error||'quick_install_deployment_failed'});return}
  const ready=(r:PlatformResource,cid:string)=>{const d=r.status.deployments?.[cid];return d?.enabled&&d.desired_revision>0&&d.applied_revision===d.desired_revision&&d.instances_total>0&&(r.status.instances??[]).some((i:Row)=>i.cluster_id===cid&&!i.retired&&i.state==='running'&&i.healthy)};
  if(!clusterIDs.every((cid:string)=>ready(app,cid)&&ready(gateway,cid)))return;
  if(q.state==='awaiting_backend'||q.state==='publishing'&&!Object.values<Row>(site.status.deployments??{}).some(d=>d.desired_revision>0)) {
   patch(app.id,{state:'publishing',error:''});
   try{await workloads.perform(site,'deploy',{},app.authorized_by)}catch(e){patch(app.id,{state:'failed',error:code(e)});return}
  }
  const current=store.get(site.id),deployments=Object.values<Row>(current.status.deployments??{});
  if(deployments.some(d=>d.last_error||d.phase==='failed'||d.phase==='unknown')){patch(app.id,{state:'failed',error:deployments.find(d=>d.last_error)?.last_error??'quick_install_website_failed'});return}
  if(deployments.length&&deployments.every(d=>d.active&&d.synchronized)) {
   if(current.status.dns_error&&current.status.dns_error!=='dns_verification_pending'){patch(app.id,{state:'failed',error:current.status.dns_error});return}
   if(gateway.status.dns_error&&gateway.status.dns_error!=='dns_verification_pending'){patch(app.id,{state:'failed',error:gateway.status.dns_error});return}
   if(clusterIDs.some((cid:string)=>gateway.status.gateway_dns?.[cid]?.missing_public_machine_ids?.length)){patch(app.id,{state:'failed',error:'machine_public_service_address_required'});return}
   const entryVerified=gateway.status.dns?.every((r:Row)=>r.verified)&&gateway.status.dns?.length;
   const verified=current.status.dns?.length&&current.status.dns.every((r:Row)=>r.verified);
   patch(app.id,{state:verified&&entryVerified?'ready':'verifying_dns',error:''});
  }
 }
 return {install,actions:(r:PlatformResource)=>r.kind==='application'&&r.status.quick_install?['quick-install-retry']:[],
  async perform(app:PlatformResource,_action:string,_input:Row,actor:string) {
   const q=app.status.quick_install;if(q.state==='unknown')fail(409,'quick_install_execution_unknown');
   patch(app.id,{state:'awaiting_backend',error:''});
   try{await workloads.perform(store.get(q.gateway_id),'deploy',{},actor);await workloads.perform(app,'deploy',{},actor)}catch(e){patch(app.id,{state:'failed',error:code(e)});throw e}
   return {resource:store.public(store.get(app.id))};
  },
  async tick(){for(const app of store.list('application'))if(app.status.quick_install&&store.authorized(app.authorized_by))try{await advance(app)}catch(e){patch(app.id,{state:'failed',error:code(e)})}}
 };
}
