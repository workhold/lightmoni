import {operationExecutionCapabilities} from '../server/managed-executor-status.js';
import { id } from '../shared/crypto.js';
import { fail } from '../shared/http.js';
import { blockingAgentJobSQL } from '../server/agent-job-fence.js';
import type { OperationsPlatformStore } from './store.js';
import type { DomainController, PlatformResource } from './types.js';
type Row=Record<string,any>;
export function createWebsiteDeletionSchema(store:Pick<OperationsPlatformStore,'deps'>) {
  store.deps.db.exec(`CREATE TABLE IF NOT EXISTS ops_website_hosts(website_id TEXT NOT NULL,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,instance_id TEXT NOT NULL,cluster_id TEXT NOT NULL,application_id TEXT NOT NULL,PRIMARY KEY(website_id,machine_id));
    CREATE TABLE IF NOT EXISTS ops_website_deletions(website_id TEXT PRIMARY KEY,id TEXT NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,state TEXT NOT NULL,targets_json TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
}
export function websiteDeleting(store:Pick<OperationsPlatformStore,'deps'>,websiteID:string) {
  if(!store.deps.db.get("SELECT 1 FROM sqlite_master WHERE name='ops_website_deletions'"))return false;
  return !!store.deps.db.get("SELECT website_id FROM ops_website_deletions WHERE website_id=? AND state!='succeeded'",websiteID);
}
export function createWebsiteDeletions(store:OperationsPlatformStore,workloads:DomainController) {
  createWebsiteDeletionSchema(store);const {db}=store.deps,at=()=>store.deps.now().toISOString();let pending:Promise<void>|undefined;
  const view=(row:Row)=>({id:row.id,state:row.state,error:row.error,targets:JSON.parse(row.targets_json),updated_at:row.updated_at});
  const save=(row:Row,targets:Row[],state='pending',error='')=>{
    db.run('UPDATE ops_website_deletions SET targets_json=?,state=?,error=?,updated_at=? WHERE website_id=?',JSON.stringify(targets),state,error,at(),row.website_id);
    if(db.get('SELECT id FROM ops_platform_resources WHERE id=?',row.website_id))store.patchStatus(row.website_id,{deletion:view({...row,state,error,targets_json:JSON.stringify(targets),updated_at:at()})});
  };
  async function advance() {
    for(const row of db.all<Row>("SELECT * FROM ops_website_deletions WHERE state!='succeeded'")) {
      if(!store.authorized(row.actor)){save(row,JSON.parse(row.targets_json),'blocked','platform_authorization_required');continue;}
      if(!db.get('SELECT id FROM ops_platform_resources WHERE id=?',row.website_id))continue;
      const site=store.get(row.website_id,'website'),targets:Row[]=JSON.parse(row.targets_json);
      if(site.revision!==row.revision){save(row,targets,'blocked','platform_revision_conflict');continue;}
      // Withdrawal is durable desired state, including gateways currently offline.
      const enabled=db.get("SELECT website_id FROM ops_platform_website_deployments WHERE website_id=? AND enabled=1",site.id);
      if(enabled) {try{await workloads.perform(site,'disable',{},row.actor);}catch(e){save(row,targets,'pending',e instanceof Error?e.message:'website_disable_pending');continue;}}
      for(const target of targets) {
        if(target.state==='done')continue;
        const host=db.get<Row>('SELECT id,agent_id FROM managed_machines WHERE id=?',target.machine_id);
        if(!host?.agent_id){target.state='waiting';target.error='website_cleanup_host_unavailable';continue;}
        if(target.run_id) {
          const run=store.action(target.run_id);
          if(!['succeeded','failed','cancelled','unknown'].includes(run.state))continue;
          if(run.state==='succeeded'&&run.result.website_id===site.id&&run.result.absent===true) {target.state='done';target.error='';target.finished_at=at();continue;}
          if(run.state==='unknown') {
            const blocked=db.get(`SELECT id FROM agent_jobs j WHERE id=? AND (${blockingAgentJobSQL(db,'j')})`,run.job_id);
            if(blocked){target.state='unknown';target.error='website_cleanup_result_unknown';continue;}
            target.inspect=true;
          } else {target.state='failed';target.error=String(run.result.code??'website_cleanup_failed');}
          target.run_id='';target.retry_at=new Date(store.deps.now().getTime()+5000).toISOString();
        }
        const agent=db.get<Row>("SELECT * FROM agents WHERE id=? AND NOT EXISTS(SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed')",host.agent_id);
        if(!agent||store.deps.now().getTime()-Date.parse(agent.last_seen)>120000){target.state='waiting';target.error='website_cleanup_host_offline';continue;}
        if(!operationExecutionCapabilities(store.deps,host.agent_id).includes('operations.platform.storage.v2')){target.state='waiting';target.error='storage_agent_upgrade_required';continue;}
        if(target.retry_at&&Date.parse(target.retry_at)>store.deps.now().getTime())continue;
        if(db.get("SELECT r.id FROM ops_cluster_instances i JOIN ops_platform_runs r ON r.id=i.current_run_id WHERE i.machine_id=? AND r.state IN ('queued','leased','accepted','preflighting','staging','activating','verifying','running','unknown')",host.id))continue;
        try {
          db.transaction(()=>{
            const attempt=(target.attempt??0)+1;
            const run=store.queue(site,host.agent_id,target.inspect?'inspect':'remove',{task:target.inspect?'website.inspect':'website.remove',storage_layout:2,website_id:site.id,deletion_id:row.id,cleanup_machine_id:host.id,cleanup_attempt:attempt},row.actor,'website-cleanup:'+row.id+':'+host.id+':'+attempt);
            Object.assign(target,{run_id:run.id,agent_id:host.agent_id,attempt,state:'queued',error:'',inspect:false});save(row,targets);
          });
        } catch(e) {target.state='waiting';target.error=e instanceof Error?e.message:'website_cleanup_pending';}
      }
      save(row,targets,targets.some(t=>t.state==='unknown')?'unknown':targets.some(t=>t.state==='failed')?'failed':'pending');
      if(targets.every(t=>t.state==='done')) {
        try {db.transaction(()=>{save(row,targets,'cleaned');store.remove(site.id,site.revision);db.run("UPDATE ops_website_deletions SET state='succeeded',error='',updated_at=? WHERE website_id=?",at(),site.id);});}
        catch(e){save(row,targets,'pending',e instanceof Error?e.message:'website_cleanup_finalize_pending');}
      }
    }
  }
  const tick=()=>pending??(pending=advance().finally(()=>{pending=undefined;}));
  async function begin(site:PlatformResource,revision:number,actor:string) {
    if(site.revision!==revision)fail(409,'platform_revision_conflict');
    if(db.get<Row>('SELECT website_id FROM ops_private_registry_settings WHERE id=1')?.website_id===site.id)fail(409,'registry_website_in_use');
    let row=db.get<Row>('SELECT * FROM ops_website_deletions WHERE website_id=?',site.id);
    if(!row) {
      const targets=db.all<Row>('SELECT machine_id FROM ops_website_hosts WHERE website_id=? ORDER BY machine_id',site.id).map(h=>({...h,state:'waiting',run_id:'',attempt:0}));
      db.run('INSERT INTO ops_website_deletions VALUES(?,?,?,?,?,?,?,?,?)',site.id,id(),revision,actor,'pending',JSON.stringify(targets),'',at(),at());
    }else if(row.revision!==revision)fail(409,'platform_revision_conflict');
    await tick();row=db.get<Row>('SELECT * FROM ops_website_deletions WHERE website_id=?',site.id)!;
    return {deleted:row.state==='succeeded',remote_data_deleted:row.state==='succeeded',deletion:view(row)};
  }
  return {begin,tick};
}
