// Loopback-only UI fixture. No SSH, Docker, cloud calls or production credentials.
import {createServer} from 'vite';
const now='2026-11-03T02:00:00.000Z',cluster='qa-cluster',machine='qa-host';
const resource=(id,kind,name,spec,status={},revision=1)=>({id,kind,name,spec,status,revision,created_at:now,updated_at:now});
const deployment={cluster_id:cluster,machine_ids:[machine],replicas:1,cpu:.25,memory_mb:128};
const app=(id,name,service,image,hostPort,extra={})=>resource(id,'application',name,{source:{type:'custom'},role:'generic',mode:'container',deployment_mode:'manual',service_name:service,image,read_only:true,restart:'unless-stopped',ports:[{name:'http',container_port:8080,host_ip:'172.21.0.16',host_port:0,protocol:'tcp',app_protocol:'http'}],deployments:[deployment],...extra},{state:'running',instances:[{id:id+'-instance',cluster_id:cluster,machine_id:machine,agent_id:'qa-agent',state:'running',healthy:true,ports:[{name:'http',host_ip:'172.21.0.16',host_port:hostPort,container_port:8080,protocol:'tcp'}]}],deployments:{[cluster]:{enabled:true,desired_revision:1,applied_revision:1}}});
const binding=(domain,appID)=>({domains:[domain],https:true,certificate_id:'qa-cert',dns_enabled:true,dns_zone_id:'qa-zone',locations:[{path:'/',match:'prefix',action:'proxy',cluster_targets:[{cluster_id:cluster,target:'application',application_id:appID,port_name:'http'}]}]});
const published={state:'active',actual_cluster_ids:[cluster],deployments:{[cluster]:{enabled:true,desired_revision:1,active:true,synchronized:true,phase:'active',instances:{'qa-gateway':{machine_id:machine,state:'running',applied_revision:1}}}},cluster_traffic:{[cluster]:{eligible:true}},dns_signature:'qa-dns-readback',dns_updated_at:now,dns:[{verified:true}]};
const seed=[
 resource(cluster,'cluster','北京 · 生产集群',{machine_ids:[machine],port_range:{start:20000,end:29999},image_cache:{enabled:false},capacity:{cpu:2,memory_mb:2048}}),
 app('qa-demo','ABC Demo','abc-demo','registry-demo.heyphp.com/lightmoni/abc-demo@sha256:c3fae4a7ce6af19b368ecef562446e251ed57c6b32386f96e91893b819cf1187',20003),
 app('qa-gateway','OpenResty','sys-openresty','openresty/openresty:1.27.1.2-0-alpine',80,{source:{type:'store',template_id:'openresty',template_version:'1.27.1.2-0-alpine'},role:'openresty',deployment_mode:'managed',ports:[],deployments:[{...deployment,gateway_domain:'edge.heyphp.com'}]}),
 app('qa-registry','私有镜像仓库','sys-docker-registry','registry:3.0.0',20000,{role:'registry'}),
 resource('qa-web','website','ABC Demo',{routing_mode:'managed',service_application_id:'qa-demo',service_port_name:'http',mode:'proxy',cluster_ids:[cluster],dns_record_mode:'address',nginx:{redirect_https:true},bindings:[binding('abc.heyphp.com','qa-demo')]},published),
 resource('qa-registry-web','website','私有镜像仓库入口',{routing_mode:'manual',mode:'proxy',cluster_ids:[cluster],dns_record_mode:'address',bindings:[binding('registry-demo.heyphp.com','qa-registry')]},published),
 resource('qa-draft','website','内部服务预览',{routing_mode:'manual',mode:'proxy',cluster_ids:[cluster],bindings:[{domains:['preview.heyphp.com'],https:false,dns_enabled:false,locations:[]}]},{}),
 resource('qa-cert','certificate','abc.heyphp.com',{source:'acme',domains:['abc.heyphp.com'],auto_renew:true,renew_before_days:30,acme_account_id:'qa-acme',dns_zone_id:'qa-zone'},{state:'issued',expires_at:'2027-01-31T23:56:54Z',days_remaining:89,version:'qa-cert-version'}),
 resource('qa-cert-registry','certificate','registry-demo.heyphp.com',{source:'acme',domains:['registry-demo.heyphp.com'],auto_renew:true,renew_before_days:30,acme_account_id:'qa-acme',dns_zone_id:'qa-zone'},{state:'issued',expires_at:'2027-02-01T00:01:00Z',days_remaining:89}),
 resource('qa-acme','acme_account','Let’s Encrypt 生产账号',{email:'admin@heyphp.com',directory_url:'https://acme-v02.api.letsencrypt.org/directory'},{state:'registered'}),
 resource('qa-zone','dns_zone','heyphp.com',{domain:'heyphp.com',scope:'heyphp.com',credential_id:'qa-dns'},{state:'synced',record_count:5}),
 resource('qa-dns','credential','阿里云 DNS',{provider:'alibyun'},{state:'verified'})
];
const host={id:machine,name:'zz-bj-1',address:'49.232.14.169',port:22,agent_id:'qa-agent',agent_status:'online',status:'active',created_at:now,updated_at:now,accounts:[],network:{private:{address:'172.21.0.16'},public:{address:'49.232.14.169'}},docker_environment:{state:'ready',source:'executor',observed_at:now}};
let resources=structuredClone(seed),failNext=false,qaRole='admin',qaJob=null,qaRuns=[];const calls=[];
const server=await createServer({root:new URL('../..',import.meta.url).pathname,configFile:false,server:{host:'127.0.0.1',port:19887,strictPort:true},plugins:[{name:'isolated-panel-ui',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;const json=(d,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(d))};
 if(path==='/__qa/reset'){resources=structuredClone(seed);failNext=false;qaRole='admin';qaJob=null;qaRuns=[];calls.length=0;return json({reset:true})}
 if(path==='/__qa/fail-next'){failNext=true;return json({armed:true})}
 if(path==='/__qa/calls')return json(calls);
 if(path==='/__qa/scenario/unknown'){const a=resources.find(r=>r.id==='qa-demo');a.status.instances[0].state='unknown';a.status.instances[0].healthy=false;return json({scenario:'unknown'})}
 if(path==='/__qa/scenario/stopped'){const a=resources.find(r=>r.id==='qa-demo');a.status.state='stopped';a.status.instances[0].state='stopped';a.status.instances[0].healthy=false;a.status.deployments[cluster].enabled=false;return json({scenario:'stopped'})}
 if(path.startsWith('/__qa/managed/')){const mode=path.split('/').at(-1);qaRole=mode==='viewer'?'user':'admin';qaRuns=[{id:'qa-run',resource_id:'qa-demo',resource_revision:1,agent_id:'qa-agent',action:'inspect',state:'unknown',result:{code:'executor_http_502'},job_id:'qa-job',created_at:now,updated_at:now}];qaJob=mode==='legacy'?null:{id:'qa-job',task_run_id:'qa-task',machine_id:mode==='wrong-host'?'other-host':machine,executor_id:'qa-executor',install_generation:1,policy_generation:1,execution_principal:'privileged_executor',capability:mode==='wrong-capability'?'container.managed.v1':'operations.managed.v1',state:'unknown',phase:'unknown',code:'executor_http_502',created_at:now,finished_at:now,plan_id:'qa-plan',plan_revision:'qa-revision',request_id:'qa-request',resolved_at:'',has_output:true};return json({mode})}
 if(!path.startsWith('/api/'))return next();
 const p=path.replace('/api/v1','');
 if(req.method==='GET'){
  if(p==='/auth/me')return json({id:'qa-admin',name:'admin',nickname:'运维管理员',role:qaRole,default_homepage:'/applications'});
  if(p==='/ops/overview')return json({resources,agents:[{id:'qa-agent',hostname:'zz-bj-1',host_id:'qa-host',last_seen:new Date().toISOString(),platform:'linux',arch:'amd64',heartbeat:{}}],machines:[host],runs:qaRuns});
  if(p==='/machines'||p==='/task-hosts')return json([host]);
  if(p==='/agents')return json([{id:'qa-agent',host_id:'qa-host',hostname:'zz-bj-1',last_seen:new Date().toISOString(),status:'online',version:'0.1.0',platform:'linux',arch:'amd64',heartbeat:{}}]);
  if(p==='/host-labels')return json([]);
  if(p==='/ops/runs')return json({runs:qaRuns});
  if(p==='/ops/system-logs')return json({rows:qaRuns.map(r=>({event_id:r.id,event_time:now,severity:'warn',attributes:{source:'ops_platform_runs',run_id:r.id,action:r.action,state:r.state,resource_id:r.resource_id},body:'fixture execution record'}))});
  if(p==='/ops/runs/qa-run')return json(qaRuns[0]);
  if(p==='/ops/runs/qa-run/events')return json({run:qaRuns[0],events:[],next_after:0});
  if(p==='/privileged-execution/jobs/qa-job'){calls.push({path:p,method:'GET'});return qaJob?json({job:qaJob}):json({error:'job_not_found'},404)}
  if(p.endsWith('/output')){calls.push({path:p,method:'GET'});return json({error:'output_requires_explicit_request'},403)}
  if(p==='/ops/resources/qa-zone/dns-lines')return json({provider:'aliyun',lines:[{id:'default',name:'默认'}],weight:{min:1,max:100},verification:'provider_required'});
  const match=p.match(/^\/ops\/resources\/([^/]+)$/);if(match){const r=resources.find(r=>r.id===match[1]);return json({resource:r})}
  if(p.endsWith('/runs'))return json({runs:[]});
  if(p==='/ops/catalog')return json({applications:[]});
  if(p==='/ops/inventory')return json({applications:resources.filter(r=>r.kind==='application')});
  return json({error:'fixture_route_not_found'},404);
 }
 let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};calls.push({path:p,method:req.method,body});
 if(req.method==='PUT'&&p.startsWith('/ops/resources/')){
  if(failNext){failNext=false;return json({error:'platform_revision_conflict'},409)}
  const id=p.split('/')[3],r=resources.find(r=>r.id===id);if(!r)return json({error:'not_found'},404);
  Object.assign(r,{name:body.name,spec:body.spec,revision:r.revision+1,updated_at:new Date().toISOString()});return json({resource:r});
 }
 if(req.method==='POST'&&p==='/privileged-execution/jobs/qa-job/reconcile'){
  if(qaRole!=='admin'||!qaJob||qaJob.machine_id!==machine)return json({error:'not_allowed'},403);
  if(body.confirm!==true||!body.reason?.trim()||Buffer.byteLength(body.reason)>512)return json({error:'confirmation_required'},400);
  qaJob={...qaJob,resolved_at:new Date().toISOString(),resolved_by:'qa-admin',resolution_reason:body.reason};return json({job:qaJob});
 }
 if(req.method==='POST'&&p.endsWith('/actions'))return json({error:'fixture_does_not_execute_operations'},409);
 if(req.method==='DELETE')return json({error:'fixture_does_not_delete'},409);
 return json({error:'fixture_write_not_supported'},400);
})}}]});
await server.listen();console.log('Isolated UI: http://127.0.0.1:19887/applications');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await server.close();process.exit(0)});
