import type { Dependencies, Handler } from '../shared/types.js';
import { fail } from '../shared/http.js';
import { APPLICATION_METRICS, APPLICATION_LOGS, applicationTargets } from '../shared/application-observation.js';
import type { OperationsPlatformStore } from './store.js';
import type { AgentJobStore } from '../server/agent-jobs.js';
import { dockerObservation, registerDockerJobs } from './docker.js';
const literal=(v:string)=>"'"+v.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const exists=(deps:Dependencies,name:string)=>deps.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name);
export function inventory(deps: Dependencies, store: OperationsPlatformStore, machineID='',clusterID='') {
  const machines=exists(deps,'managed_machines')?deps.db.all<any>('SELECT m.id,m.name,m.agent_id,c.cluster_id FROM managed_machines m LEFT JOIN ops_platform_cluster_members c ON c.machine_id=m.id').filter(m=>(!machineID||m.id===machineID)&&(!clusterID||m.cluster_id===clusterID)):[];
  if(machineID&&!machines.length)fail(404,'machine_not_found');
  const hosts=machines.map(m=>{
    const agent=m.agent_id?deps.db.get<any>('SELECT heartbeat,last_seen FROM agents WHERE id=?',m.agent_id):undefined;
    let snapshot,activeID='';try{const heartbeat=JSON.parse(agent?.heartbeat??'{}');({snapshot,activeID}=dockerObservation(deps.db,m.agent_id??'',heartbeat));}catch{}
    const online=!!agent&&Number.isFinite(Date.parse(agent.last_seen))&&deps.now().getTime()-Date.parse(agent.last_seen)<=120000;
    const targets=new Map(applicationTargets(deps.db,m.agent_id??'').map(t=>[t.deployment_id,t]));
    return {...m,online,docker_capabilities:[],active_job:'',historical_job:activeID,historical:!!snapshot,management_blocker:'privileged_executor_required',state:!m.agent_id?'not_connected':snapshot?'stale':'waiting',error:snapshot?.error??'',attempted_at:snapshot?.attempted_at??'',observed_at:snapshot?.observed_at??'',truncated:snapshot?.truncated??false,
      containers:(snapshot?.containers??[]).map(c=>({...c,application_id:targets.get(c.deployment_id)?.application_id??'',cluster_id:m.cluster_id??''}))};
  });
  const instanceRows=deps.db.all<any>('SELECT id,owner_id,machine_id,agent_id,cluster_id,state,healthy,retired FROM ops_cluster_instances WHERE retired=0').filter(i=>(!machineID||i.machine_id===machineID)&&(!clusterID||i.cluster_id===clusterID));
  const applications=store.list('application').filter(a=>{
    if(clusterID&&!a.spec.deployments?.some((d:any)=>d.cluster_id===clusterID))return false;
    if(!machineID)return true;
    return instanceRows.some(i=>i.owner_id===a.id)||a.spec.deployments?.some((d:any)=>d.machine_ids?.includes(machineID));
  }).map(a=>{const r=store.public(a);return {...r,status:{...r.status,instances:instanceRows.filter(i=>i.owner_id===r.id)}};});
  return {hosts,applications};
}
function range(deps:Dependencies, params:URLSearchParams) {
  const to=params.get('to')??deps.now().toISOString(),from=params.get('from')??new Date(Date.parse(to)-3600000).toISOString();
  if(!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>86400000)fail(400,'invalid_observation_range');
  return {from:new Date(from).toISOString(),to:new Date(to).toISOString()};
}
const frameRows=(response:any)=>Object.fromEntries((response.results??[]).map((r:any)=>[r.refId,{...r,rows:(r.frames??[]).flatMap((f:any)=>f.rows.map((row:any[])=>Object.fromEntries(f.columns.map((c:any,i:number)=>[c.name,row[i]]))))}]));
export function registerObservability(deps:Dependencies,store:OperationsPlatformStore,safe:(fn:Handler)=>Handler,jobs:AgentJobStore) {
  const router=deps.router;
  registerDockerJobs(deps,jobs,safe,id=>inventory(deps,store,id).hosts[0]);
  router.get('/api/v1/ops/inventory',safe(ctx=>ctx.json(inventory(deps,store,ctx.url.searchParams.get('machine_id')??'',ctx.url.searchParams.get('cluster_id')??''))));
  router.get('/api/v1/ops/resources/:id/monitoring',safe(ctx=>{
    const application=store.get(ctx.params.id,'application');
    const data=inventory(deps,store);
    const publicApplication=data.applications.find(a=>a.id===application.id)??store.public(application);
    ctx.json({application:publicApplication,deployments:(application.spec.deployments??[]).map((d:any)=>({...d,cluster_name:store.get(d.cluster_id,'cluster').name})),hosts:data.hosts.map(h=>({...h,containers:h.containers.filter((c:any)=>c.application_id===application.id)})).filter(h=>h.containers.length||publicApplication.status.instances?.some((i:any)=>i.machine_id===h.id)),tables:{metrics:APPLICATION_METRICS,logs:APPLICATION_LOGS},websites:store.list('website').filter(w=>(w.spec.bindings??[]).some((b:any)=>(b.locations??[]).some((l:any)=>(l.cluster_targets??[]).some((t:any)=>t.application_id===application.id)))).map(w=>({id:w.id,name:w.name,cluster_ids:w.spec.cluster_ids??[]}))});
  }));
  router.get('/api/v1/ops/resources/:id/telemetry',safe(async ctx=>{
    const app=store.get(ctx.params.id,'application'),p=ctx.url.searchParams,r=range(deps,p),tables=await deps.cat.list(ctx.signal);
    const machine=p.get('machine_id')??'',cluster=p.get('cluster_id')??'',deployment=p.get('deployment_id')??'',container=p.get('container_id')??'';
    const scope=`attributes['application_id']=${literal(app.id)}`+[['machine_id',machine],['cluster_id',cluster],['deployment_id',deployment],['container_id',container]].filter(([,v])=>v).map(([k,v])=>` AND attributes['${k}']=${literal(v)}`).join('');
    const time=`event_time>=parseDateTime64BestEffort(${literal(r.from)}) AND event_time<parseDateTime64BestEffort(${literal(r.to)})`;
    const queries=[];
    if(tables.some(t=>t.name===APPLICATION_METRICS))queries.push({refId:'load',sql:`SELECT toStartOfMinute(event_time) AS time, name, attributes['cluster_id'] AS cluster_id,attributes['deployment_id'] AS deployment_id,attributes['container_id'] AS container_id,attributes['container_name'] AS container_name,avg(value) AS value FROM ${APPLICATION_METRICS} WHERE ${time} AND ${scope} GROUP BY time,name,cluster_id,deployment_id,container_id,container_name ORDER BY time LIMIT 5000`});
    if(tables.some(t=>t.name===APPLICATION_LOGS)){
      queries.push({refId:'logs',sql:`SELECT event_id,event_time,severity,body,attributes['cluster_id'] AS cluster_id,attributes['deployment_id'] AS deployment_id,attributes['container_id'] AS container_id,attributes['container_name'] AS container_name,attributes['stream'] AS stream FROM ${APPLICATION_LOGS} WHERE ${time} AND ${scope} ORDER BY event_time DESC LIMIT 200`});
      // Site IDs are derived from current saved bindings, never supplied by the browser.
      const sites=store.list('website').flatMap(w=>{
        const clusters=[...new Set((w.spec.bindings??[]).flatMap((b:any)=>(b.locations??[]).flatMap((l:any)=>(l.cluster_targets??[]).filter((t:any)=>t.application_id===app.id&&(!cluster||t.cluster_id===cluster)).map((t:any)=>t.cluster_id))))] as string[];
        return clusters.length?[`(attributes['website_id']=${literal(w.id)} AND attributes['cluster_id'] IN (${clusters.map(literal).join(',')}))`]:[];
      });
      const siteScope=`(${scope}${sites.length?' OR '+sites.join(' OR '):''})`;
      queries.push({refId:'web',sql:`SELECT toStartOfMinute(event_time) AS time,attributes['website_id'] AS website_id,attributes['cluster_id'] AS cluster_id,count() / 60.0 AS qps,avg(toFloat64OrZero(attributes['request_duration'])) AS duration FROM ${APPLICATION_LOGS} WHERE ${time} AND ${siteScope} AND attributes['website_id']!='' GROUP BY time,website_id,cluster_id ORDER BY time LIMIT 1500`});
    }
    ctx.json({range:r,waiting:!queries.length,results:queries.length?frameRows(await deps.query({source:'application-monitoring',range:r,interval_ms:60000,queries},ctx.signal)):{}});
  }));
  router.get('/api/v1/ops/system-logs',safe(async ctx=>{
    const p=ctx.url.searchParams,r=range(deps,p),tables=await deps.cat.list(ctx.signal);
    if(!tables.some(t=>t.name==='lightmoni_log')){ctx.json({rows:[],waiting:true});return;}
    const clauses:string[]=[];const clusterID=p.get('cluster_id');const resource=p.get('resource_id'),machine=p.get('machine_id'),kind=p.get('kind');
    if(resource)clauses.push(`attributes['resource_id']=${literal(resource)}`);
    else if(kind){const ids=store.list(kind as any).map(r=>r.id);if(kind==='certificate')ids.push(...store.list('certificate_target').map(r=>r.id));if(kind==='dns_zone')ids.push(...store.list('credential').map(r=>r.id));const kinds=kind==='certificate'?['certificate','certificate_target']:kind==='dns_zone'?['dns_zone','credential']:kind==='acme_account'?['acme_account']: [kind];clauses.push(`(attributes['resource_kind'] IN (${kinds.map(literal).join(',')})${ids.length?` OR attributes['resource_id'] IN (${ids.map(literal).join(',')})`:''})`);}
    if(clusterID)clauses.push(`attributes['cluster_id']=${literal(clusterID)}`);
    if(machine)clauses.push(`attributes['machine_id']=${literal(machine)}`);
    if(!resource&&!kind&&!machine)clauses.push("component='operations'");
    const response=await deps.query({source:'operations-logs',range:r,interval_ms:60000,queries:[{refId:'logs',sql:`SELECT event_id,event_time,severity,body,attributes FROM lightmoni_log WHERE event_time>=parseDateTime64BestEffort(${literal(r.from)}) AND event_time<parseDateTime64BestEffort(${literal(r.to)}) AND ${clauses.join(' AND ')} ORDER BY event_time DESC LIMIT 200`}]},ctx.signal);
    ctx.json(frameRows(response).logs??{rows:[],waiting:false});
  }));
}
