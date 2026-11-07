import {blockingAgentJobSQL} from '../server/agent-job-fence.js';
import {hash} from '../operations/website-files.js';
import {fail} from '../shared/http.js';
import {canonicalJSON} from '../shared/privileged-executor.js';
import type {LegacyGatewayScope} from '../operations/website-legacy-cleanup.js';
import type {OperationsPlatformStore} from './store.js';

/** Source identities and health digests from immutable authorized payloads,
 * never from domain names or caller-supplied filesystem paths. */
export function legacyWebsiteScopes(store:Pick<OperationsPlatformStore,'deps'|'get'>,machineID:string,agentID:string,websiteID:string):LegacyGatewayScope[] {
 const db=store.deps.db,fragments=new Set(Array.from({length:50},(_,n)=>hash(websiteID+':'+n).slice(0,32)));
 const rows=db.all<any>('SELECT * FROM ops_cluster_instances WHERE machine_id=? ORDER BY id',machineID);
 const runs=db.all<any>("SELECT payload_cipher FROM ops_platform_runs WHERE action='apply' ORDER BY created_at,id LIMIT 10001");
 if(runs.length>10000)fail(409,'legacy_website_evidence_limit');
 const configurations=runs.map(run=>JSON.parse(store.deps.decrypt(run.payload_cipher)).resource.config).filter(c=>c.task==='gateway.apply');
 const scopes:LegacyGatewayScope[]=[];
 for(const i of rows){
  if(!db.get('SELECT id FROM ops_platform_resources WHERE id=?',i.owner_id)||store.get(i.owner_id).spec.role!=='openresty')continue;
  if(i.agent_id!==agentID&&db.get(`SELECT id FROM agent_jobs j WHERE agent_id=? AND ${blockingAgentJobSQL(db,'j')} LIMIT 1`,i.agent_id))fail(409,'legacy_website_execution_unknown');
  if(scopes.length>=100)fail(409,'legacy_website_evidence_limit');
  const proofs=new Map<string,LegacyGatewayScope['site_proofs'][number]>();
  for(const config of configurations){
   if(config.instance_id!==i.id||config.openresty_application_id!==i.owner_id)continue;
   for(const site of config.sites??[]){
    const target=site.website_id===websiteID||fragments.has(site.id);
    // Signed executor envelopes sort object keys. Preserve both proven wire
    // representations used by the original Agent and the signed helper.
    for(const digest of new Set([hash(JSON.stringify(site)),hash(canonicalJSON(site))]))proofs.set(digest,{digest,fragment_id:site.id,target});
   }
  }
  if(proofs.size>2048)fail(409,'legacy_website_evidence_limit');
  scopes.push({instance_id:i.id,application_id:i.owner_id,historical_only:!i.retired&&i.agent_id===agentID,site_proofs:[...proofs.values()].sort((a,b)=>a.digest.localeCompare(b.digest))});
 }
 return scopes;
}
