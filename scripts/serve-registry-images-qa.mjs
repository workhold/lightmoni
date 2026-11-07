/** Disposable frontend contract fixture. Never connects to a real registry or machine. */
import {createServer} from '../web/node_modules/vite/dist/node/index.js';
const now=new Date().toISOString(),cluster='qa-cluster';
const app={id:'qa-registry',kind:'application',name:'系统镜像仓库',revision:1,spec:{role:'registry',mode:'compose',deployments:[{cluster_id:cluster,machine_ids:['qa-machine']}],ports:[]},status:{},created_at:now,updated_at:now};
const resources=[app,{id:cluster,kind:'cluster',name:'北京集群',revision:1,spec:{machine_ids:['qa-machine']},status:{}}];
const deployment={cluster_id:cluster,machine_id:'qa-machine',address:'10.0.0.8',endpoint:'http://10.0.0.8:21000',host_ports:{registry:21000},status:{applied_revision:1,desired_revision:1}};
let runs=new Map(),calls=[],cleaned=false,failNext=false,active=null,slow=false,partial=false,serial=0;
const digest='sha256:'+'a'.repeat(64);
const view=()=>({revision:1,application:app,deployments:[deployment],external:{revision:0,carrier_cluster_id:'',website:null},cleanup_run:active?runs.get(active):null});
const server=await createServer({root:new URL('../web',import.meta.url).pathname,configFile:false,server:{host:'127.0.0.1',port:19992,strictPort:true},plugins:[{name:'registry-images-qa',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 const json=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(path==='/__qa/reset'){runs=new Map();calls=[];cleaned=false;failNext=false;active=null;slow=false;return json({ok:true});}
 if(path==='/__qa/partial'){partial=true;return json({ok:true});}if(path==='/__qa/fail'){failNext=true;return json({ok:true});}if(path==='/__qa/slow'){slow=true;return json({ok:true});}if(path==='/__qa/calls')return json(calls);
 if(!path.startsWith('/api/'))return next();const p=path.replace('/api/v1','');
 if(req.method==='GET'){
  if(p==='/auth/me')return json({id:'qa-admin',name:'管理员',nickname:'运维管理员',role:'admin'});
  if(p==='/ops/overview')return json({resources,machines:[{id:'qa-machine',name:'北京主机',agent_id:'qa-agent'}],agents:[],runs:[...runs.values()]});
  if(p==='/ops/private-registry')return json(view());
  if(p.startsWith('/ops/runs/')){const run=runs.get(p.split('/').at(-1));return run?json(run):json({error:'run_not_found'},404);}
  if(p==='/ops/runs')return json({runs:[...runs.values()]});
  if(p==='/setup')return json({required:false});
  if(p==='/auth/providers'||p==='/dashboards')return json([]);
  return json({error:'qa_route_not_found'},404);
 }
 let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};calls.push({path:p,method:req.method,body});
 if(failNext){failNext=false;return json({error:'registry_request_failed'},503);}
 if(p==='/ops/private-registry/images/query'||p==='/ops/private-registry/images/cleanup'){
  if(active&&p.endsWith('/query'))return json({error:'registry_cleanup_in_progress'},409);
  const cleanup=p.endsWith('/cleanup'),id='qa-run-'+(++serial);
  const run={id,resource_id:app.id,resource_revision:1,agent_id:'qa-agent',action:cleanup?'registry.cleanup':'registry.inspect',state:'queued',result:{},created_at:now,updated_at:now};runs.set(id,run);
  if(cleanup)active=id;
  const isPartial=cleanup&&partial;if(cleanup)partial=false;
  const complete=()=>{run.state=isPartial?'failed':'succeeded';if(cleanup){cleaned=true;active=null;run.result=isPartial?{deleted:1,deleted_tags:1,retained:1,failed:1,scanned:3,failures:[{code:'registry_delete_rejected'}]}:{deleted:2,deleted_tags:2,retained:1,failed:0,scanned:3};}else if(!body.repository)run.result={repositories:['lightmoni/api','lightmoni/worker']};else if(body.repository==='lightmoni/worker')run.result={repository:body.repository,versions:[],next:null};else run.result={repository:body.repository,versions:body.after?[{tag:'v0.1',digest:'sha256:'+'c'.repeat(64),used_by:[]}]:[{tag:'v1.0',digest,used_by:[{id:'qa-api',name:'监控 API'}]},...(!cleaned?[{tag:'v0.9',digest:'sha256:'+'b'.repeat(64),used_by:[]}]:[])],next:!body.after&&!cleaned?'v0.9':null};};
  setTimeout(complete,slow?1800:120);slow=false;return json(run,202);
 }
 return json({error:'qa_route_not_found'},404);
});}}]});
await server.listen();console.log('Registry UI QA: http://127.0.0.1:19992/private-images');
