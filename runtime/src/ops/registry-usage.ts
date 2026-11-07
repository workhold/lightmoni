import {blockingAgentJobSQL} from '../server/agent-job-fence.js';
import { createHash } from 'node:crypto';
import { fail } from '../shared/http.js';
import type { PlatformStore } from './types.js';
import type { DB } from '../shared/sqlite.js';
import { repositoryName, tagName, type RegistryReference } from '../operations/registry-images.js';

/** This persistent fence survives Center restarts and unknown execution outcomes. */
export function activeRegistryCleanup(db:DB):string|undefined {
  return db.get<{id:string}>(`SELECT r.id FROM ops_platform_runs r LEFT JOIN agent_jobs j ON j.id=r.job_id
    WHERE r.action='registry.cleanup' AND r.state NOT IN ('succeeded','failed','cancelled','expired')
    AND (j.id IS NULL OR (${blockingAgentJobSQL(db,'j')})) ORDER BY r.created_at DESC LIMIT 1`)?.id;
}
export function assertRegistryIdle(db:DB) {
  if(activeRegistryCleanup(db))fail(409,'registry_cleanup_in_progress');
}
export function registryReferences(store:PlatformStore,aliases:string[],strict=true):RegistryReference[] {
  const {db}=store.deps, found=new Map<string,RegistryReference>();
  const add=(spec:Record<string,any>,id:string,name:string)=>{
    const images=spec.mode==='container'?[spec.image]:Object.values<any>(spec.compose?.services??{}).map(s=>s.image);
    for(const image of images){
      if(typeof image!=='string'||image.includes('$')){if(strict)fail(409,'registry_usage_unresolved');continue;}
      const slash=image.indexOf('/');if(slash<0 || !aliases.includes(image.slice(0,slash).toLowerCase()))continue;
      const path=image.slice(slash+1),at=path.indexOf('@'),colon=path.lastIndexOf(':');
      const named=at>=0?path.slice(0,at):path,namedColon=named.lastIndexOf(':');
      const repository=namedColon>named.lastIndexOf('/')?named.slice(0,namedColon):named;
      const reference=at>=0?path.slice(at+1):colon>path.lastIndexOf('/')?path.slice(colon+1):'latest';
      if(!repositoryName(repository)||!(tagName(reference)||/^sha256:[a-f0-9]{64}$/.test(reference))){if(strict)fail(409,'registry_usage_unresolved');continue;}
      const r={repository,reference,id,name};found.set(JSON.stringify(r),r);
    }
  };
  const applications=store.list('application'),apps=new Map(applications.map(a=>[a.id,a]));
  applications.forEach(a=>add(a.spec,a.id,a.name));
  const revision=(id:string,value:any)=>{
    if(!value)return;const r=db.get<{spec_cipher:string}>('SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?',id,Number(value));
    if(!r){if(strict)fail(409,'registry_usage_unresolved');return;}
    const a=apps.get(id);add(JSON.parse(store.deps.decrypt(r.spec_cipher)),id,a?.name??id);
  };
  for(const d of db.all<any>('SELECT application_id,desired_revision FROM ops_platform_application_deployments'))revision(d.application_id,d.desired_revision);
  for(const i of db.all<any>("SELECT owner_id,observed_generation,desired_generation,observed_json FROM ops_cluster_instances WHERE state!='removed'")){
    revision(i.owner_id,i.observed_generation);revision(i.owner_id,i.desired_generation);
    const observed=JSON.parse(i.observed_json??'{}'),a=apps.get(i.owner_id);
    if(Array.isArray(observed.containers))add({mode:'compose',compose:{services:Object.fromEntries(observed.containers.filter((c:any)=>typeof c.image==='string').map((c:any,n:number)=>[String(n),{image:c.image}]))}},i.owner_id,a?.name??i.owner_id);
  }
  for(const run of db.all<any>("SELECT resource_id,payload_cipher FROM ops_platform_runs WHERE state NOT IN ('succeeded','failed','cancelled','expired') AND payload_cipher!=''")){
    const p=JSON.parse(store.deps.decrypt(run.payload_cipher)),a=apps.get(run.resource_id);
    if(p.resource?.config?.task==='workload.apply')add(p.resource.config.application,run.resource_id,a?.name??run.resource_id);
  }
  if(found.size>10000)fail(409,'registry_usage_limit');
  return [...found.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export const usageHash=(refs:RegistryReference[])=>createHash('sha256').update(JSON.stringify(refs)).digest('hex');
