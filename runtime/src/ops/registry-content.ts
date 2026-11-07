import { fail, HTTPError } from '../shared/http.js';
import { operationExecutionCapabilities } from '../server/managed-executor-status.js';
import { requireSystemRegistry } from './system-applications.js';
import { registeredRegistryEndpoint } from './registry-runtime.js';
import { assertRegistryIdle, registryReferences, usageHash } from './registry-usage.js';
import { repositoryName, tagName } from '../operations/registry-images.js';
import type { PlatformStore } from './types.js';
type Row=Record<string,any>;
function target(store:PlatformStore,cid:string) {
  const app=requireSystemRegistry(store),d=app.spec.deployments.find((d:Row)=>d.cluster_id===cid);
  if(!d)fail(400,'registry_deployment_required');
  const machine=store.deps.db.get<Row>('SELECT id,agent_id FROM managed_machines WHERE id=?',d.machine_ids[0]);
  const endpoint=registeredRegistryEndpoint(store,cid);
  if(!machine?.agent_id||!endpoint)fail(409,'registry_deployment_not_started');
  const url=new URL(endpoint),aliases=new Set([url.host.toLowerCase()]);
  if(!url.port)aliases.add(url.hostname.toLowerCase()+':80');
  if(['127.0.0.1','[::1]'].includes(url.hostname))for(const host of ['localhost','127.0.0.1','[::1]'])aliases.add(host+':'+(url.port||'80'));
  const cfg=store.deps.db.get<Row>('SELECT * FROM ops_private_registry_settings WHERE id=1');
  if(cfg?.website_id){const site=store.get(cfg.website_id,'website');for(const b of site.spec.bindings??[])for(const domain of b.domains??[]){aliases.add(domain.toLowerCase());aliases.add(domain.toLowerCase()+':443');}}
  return {app,machine,endpoint,aliases:[...aliases].sort()};
}
export function queueRegistryContent(store:PlatformStore,b:Row,actor:string,cleanup=false) {
  return store.deps.db.transaction(()=>{
    const {app,machine,endpoint,aliases}=target(store,b.cluster_id);
    if(cleanup){
      if(b.confirmed!==true)fail(400,'platform_confirmation_required');
      if(b.revision!==app.revision)fail(409,'platform_revision_conflict');
    }
    assertRegistryIdle(store.deps.db);
    if(!operationExecutionCapabilities(store.deps,machine.agent_id).includes('operations.platform.registry.v1'))fail(409,'registry_executor_upgrade_required');
    if(!cleanup && (b.repository!==undefined&&!repositoryName(b.repository) || b.after!==undefined&&(!b.repository||!tagName(b.after))))fail(400,'invalid_registry_query');
    let references,usage_complete=true;
    try{references=registryReferences(store,aliases);}catch(e){
      if(cleanup||!(e instanceof HTTPError)||e.message!=='registry_usage_unresolved')throw e;
      references=registryReferences(store,aliases,false);usage_complete=false;
    }
    return store.queue(app,machine.agent_id,cleanup?'registry.cleanup':'registry.inspect',{
      task:cleanup?'registry.cleanup':'registry.inspect',cluster_id:b.cluster_id,machine_id:machine.id,
      endpoint,aliases,references,usage_complete,usage_hash:usageHash(references),
      ...(!cleanup&&b.repository?{repository:b.repository,...(b.after?{after:b.after}:{})}:{}),
    },actor);
  });
}
export function validateRegistryPayload(store:PlatformStore,c:Row,agentID:string,resourceID:string) {
  if(!['registry.inspect','registry.cleanup'].includes(c.task))return;
  const {app,machine,endpoint,aliases}=target(store,c.cluster_id);
  if(resourceID!==app.id||c.machine_id!==machine.id||agentID!==machine.agent_id||endpoint!==c.endpoint||JSON.stringify(aliases)!==JSON.stringify(c.aliases)||!operationExecutionCapabilities(store.deps,agentID).includes('operations.platform.registry.v1'))fail(403,'registry_target_changed');
  if(c.task==='registry.cleanup'){
    if(c.usage_hash!==usageHash(c.references))fail(403,'registry_usage_changed');
    const snapshot=new Set(c.references.map((r:Row)=>JSON.stringify(r)));
    if(registryReferences(store,aliases).some(r=>!snapshot.has(JSON.stringify(r))))fail(403,'registry_usage_changed');
    if(!store.deps.db.get("SELECT id FROM ops_platform_runs WHERE resource_id=? AND action='registry.cleanup' AND state NOT IN ('succeeded','failed','cancelled','expired')",app.id))fail(403,'registry_cleanup_fence_required');
  }
}
