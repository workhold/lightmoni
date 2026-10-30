/** Disposable real Docker -> Agent queue -> OTLP HTTP -> ClickHouse -> Query
 * acceptance harness. Uses synthetic admin/Agent auth on loopback only. */
import {createServer,request as httpRequest} from 'node:http';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DB} from '../../src/shared/sqlite.js';
import {Router,fail} from '../../src/shared/http.js';
import {cipher} from '../../src/shared/crypto.js';
import {ClickHouse} from '../../src/shared/clickhouse.js';
import {Catalog} from '../../src/server/catalog.js';
import {Executor} from '../../src/server/query.js';
import {Ingest} from '../../src/server/ingest.js';
import {registerAgentJobs} from '../../src/server/agent-jobs.js';
import {registerOperationsPlatform} from '../../src/ops/index.js';
import {SystemLogs} from '../../src/server/system-logs.js';
import {defaultConfig} from '../../src/agent/config.js';
import {createAgent} from '../../src/agent/agent.js';
import {operationCommand} from '../../src/agent/operations.js';
import {applicationTargets} from '../../src/shared/application-observation.js';
import {renderGateway} from '../../src/operations/platform.js';
const root=mkdtempSync(join(tmpdir(),'lm044-live-')),db=new DB(join(root,'qa.db')),router=new Router();
const port=19946,base='http://127.0.0.1:'+port;
const ch=new ClickHouse(process.env.LIGHTMONI_QA_CH_URL??'http://127.0.0.1:59865','lightmoni','observation_test','');
await ch.exec('CREATE DATABASE IF NOT EXISTS lightmoni');ch.database='lightmoni';await ch.exec("CREATE USER IF NOT EXISTS lightmoni_reader IDENTIFIED BY 'qa_reader'");await ch.exec('ALTER USER lightmoni_reader SETTINGS readonly=2');
const reader=new ClickHouse(ch.endpoint,'lightmoni_reader','qa_reader'),cat=new Catalog(db,ch,reader);await cat.migrate();const executor=new Executor(reader,cat);
db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('qa-admin','QA Administrator','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);CREATE TABLE services(id TEXT PRIMARY KEY);CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines VALUES('qa-host-a','QA 应用主机','127.0.0.1','qa-agent'),('qa-host-b','QA 备用主机','127.0.0.2','qa-agent-b');`);
db.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)','qa-agent','qa-host','QA 应用主机','qa','linux','amd64',new Date().toISOString(),'default','{}');
db.run("INSERT INTO agents SELECT 'qa-agent-b','qa-host-b','QA 备用主机',version,platform,arch,last_seen,group_id,heartbeat FROM agents WHERE id='qa-agent'");
const user={id:'qa-admin',name:'QA Administrator',role:'admin',preferences:{default_homepage:'/applications'}};
const auth:any={router,user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user?.role!=='admin')fail(403,'admin_required');},validateKey:()=>({id:'business-key',name:'QA',allowed_tables:[],allow_all_tables:true}),recordKey:()=>{}};
router.auth=auth;const encryption=cipher(randomBytes(32));Object.assign(auth,encryption);
const deps:any={db,router,...encryption,auth,cat,ch,reader,query:executor.execute.bind(executor),now:()=>new Date(),externalURL:base,logger:{info(){},warn(){},error(){process.stderr.write('QA request failed\n')}}};
const credentials:any={authenticate(req:any,id:string,audience:string){if(id!=='qa-agent'||audience!=='data'||req.headers.authorization!=='Bearer qa-data')fail(401,'qa_data_credential_required');return{credential_id:'qa-data-id'};}};
const jobs=registerAgentJobs(deps,{agentCredentials:credentials}),platform=registerOperationsPlatform(deps,{jobs,dataDir:root,intervalMs:0}),store=platform.store;
const cluster=store.create('cluster','上海集群',{machine_ids:['qa-host-a'],node_config:{'qa-host-a':{address:'127.0.0.1'},'qa-host-b':{address:'127.0.0.2'}}},user.id);
const cluster2=store.create('cluster','备用集群',{machine_ids:['qa-host-b'],node_config:{'qa-host-b':{address:'127.0.0.2'}}},user.id);
const app=store.create('application','订单服务',{service_name:'orders-qa',mode:'container',image:'node:24.15.0-bookworm-slim',deployment_mode:'manual',deployments:[{cluster_id:cluster.id,machine_ids:['qa-host-a'],cpu:.25,memory_mb:128},{cluster_id:cluster2.id,machine_ids:['qa-host-b'],cpu:.25,memory_mb:128}],ports:[{name:'http',container_port:8080,host_port:0,protocol:'tcp',app_protocol:'http'}],mounts:[]},user.id);
const app2=store.create('application','库存服务',{service_name:'inventory-qa',mode:'container',image:'node:24.15.0-bookworm-slim',deployment_mode:'manual',deployments:[{cluster_id:cluster.id,machine_ids:['qa-host-a'],cpu:.25,memory_mb:128}],ports:[],mounts:[]},user.id);
const gateway=store.create('application','网站入口',{service_name:'gateway-qa',mode:'container',image:'openresty/openresty:1.27.1.2-0-alpine',role:'openresty',network_mode:'host',deployment_mode:'manual',deployments:[{cluster_id:cluster.id,machine_ids:['qa-host-a'],cpu:.25,memory_mb:128}],ports:[{name:'http',container_port:80,host_port:80,protocol:'tcp',app_protocol:'http'},{name:'https',container_port:443,host_port:443,protocol:'tcp',app_protocol:'https'}],mounts:[]},user.id);
// The route contract uses saved website bindings for the application website list.
const site=store.create('website','订单网站',{cluster_ids:[cluster.id],mode:'proxy',bindings:[{domains:['orders.example.test'],locations:[{path:'/',cluster_targets:[{cluster_id:cluster.id,target:'application',application_id:app.id,port_name:'http'}]}]}]},user.id);
const names:string[]=[];const timestamp=new Date().toISOString();
function instance(owner:string,id:string){db.run(`INSERT INTO ops_cluster_instances(id,owner_id,machine_id,agent_id,slot,cluster_id,state,healthy,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,id,owner,'qa-host-a','qa-agent',id,cluster.id,'running',1,timestamp,timestamp,timestamp);}
const ids=['044a'+randomBytes(14).toString('hex'),'044b'+randomBytes(14).toString('hex'),'044c'+randomBytes(14).toString('hex')];instance(app.id,ids[0]);instance(app2.id,ids[1]);instance(gateway.id,ids[2]);
const agent=createAgent({...defaultConfig(),data_dir:join(root,'agent'),endpoint:base,listen:'127.0.0.1:0',control_credential:'qa-control',data_credential:'qa-data',min_free_bytes:0,collect_interval_seconds:3600});
// Agent's stable local identity is replaced before any batch is collected.
(agent.identity as any).agent_id='qa-agent';
db.run('UPDATE agents SET host_id=? WHERE id=?',agent.identity.host_id,'qa-agent');
const ingest=new Ingest(cat,auth,undefined,credentials);ingest.register();const logs=new SystemLogs(deps,ingest);logs.start();
router.get('/api/v1/machines',ctx=>ctx.json(db.all<any>('SELECT * FROM managed_machines').map(m=>({...m,port:22,username:'deploy',agent_status:m.agent_id==='qa-agent'?'online':'offline',connection_method:'direct_ssh',created_at:timestamp,updated_at:timestamp,capabilities:{terminal:{available:false},ssh_check:{available:false},deploy_agent:{available:false}},credential_count:0,active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0}))));
router.get('/api/v1/agents',ctx=>ctx.json(db.all<any>('SELECT * FROM agents').map(a=>({...a,heartbeat:JSON.parse(a.heartbeat||'{}'),machine_id:a.id==='qa-agent'?'qa-host-a':'qa-host-b',online:a.id==='qa-agent'}))));
router.get('/api/v1/agent-task-labels',ctx=>ctx.json([]));router.get('/api/v1/host-labels',ctx=>ctx.json([]));
router.get('/api/v1/auth/me',ctx=>ctx.json(user));router.get('/api/v1/user/preferences',ctx=>ctx.json({default_homepage:'/applications'}));router.get('/api/v1/assistant/providers',ctx=>ctx.json({providers:[]}));router.get('/api/v1/assistant/sessions',ctx=>ctx.json({sessions:[]}));
router.get('/api/v1/qa/state',ctx=>ctx.json({app:app.id,app2:app2.id,gateway:gateway.id,site:site.id,cluster:cluster.id,cluster2:cluster2.id,machine:'qa-host-a'}));
router.get('/api/v1/qa/collect',async ctx=>{await collect();ctx.json({ok:true});});
const server=createServer(async(req,res)=>{if(!(await router.handle(req,res))){res.writeHead(404,{'content-type':'application/json'});res.end('{}');}});await new Promise<void>(r=>server.listen(port,'127.0.0.1',r));
async function run(args:string[]){return operationCommand('docker',['--context','default',...args],{timeoutMs:60000});}
async function start(name:string,args:string[]){await run(['run','--detach','--name',name,...args]);names.push(name);}
async function collect(){agent.applications.targets=applicationTargets(db,'qa-agent');await agent.applications.collect();await agent.sdk.flush({timeoutMs:5000});
 let batch;while((batch=agent.queue.next())){const response=await fetch(base+'/v1/'+batch.signal,{method:'POST',headers:{authorization:'Bearer qa-data','X-Lightmoni-Agent-ID':'qa-agent','X-Lightmoni-Table':batch.table,'X-Lightmoni-Batch-ID':batch.id,'X-Lightmoni-Batch-Created-At':batch.created_at,'Content-Type':batch.content_type},body:batch.payload as any});if(!response.ok)throw Error('ingest '+response.status+': '+await response.text());await response.text();agent.queue.complete(batch.id);}
 db.run('UPDATE agents SET heartbeat=?,last_seen=? WHERE id=?',JSON.stringify({docker_inventory:agent.applications.inventory,collectors_status:{applications:'ok'}}),new Date().toISOString(),'qa-agent');
 for(const owner of [app.id,app2.id,gateway.id]){const r=store.get(owner),i=db.all<any>('SELECT * FROM ops_cluster_instances WHERE owner_id=?',owner);db.run('UPDATE ops_platform_resources SET status_json=? WHERE id=?',JSON.stringify({...r.status,instances:i}),owner);}
}
try{
 for(let i=0;i<2;i++)await start('lm044-app-'+i,['--label','io.lightmoni.platform.instance='+ids[i],'-p','127.0.0.1::8080','node:24.15.0-bookworm-slim','node','-e',`require('http').createServer((q,s)=>{console.log('request accepted');s.end('ok')}).listen(8080);setInterval(()=>console.log('application heartbeat'),800);console.error('diagnostic startup');`]);
 const conf=renderGateway({http_port:8080,sites:[{id:site.id,domains:['orders.example.test'],mode:'static',nginx:{},locations:[{path:'/',action:'return',return_status:200,return_value:'ok'}]}]},'qa',true);
 const configPath=join(root,'nginx.conf');writeFileSync(configPath,conf);
 await start('lm044-gateway',['--label','io.lightmoni.platform.instance='+ids[2],'-p','127.0.0.1::8080','--mount','type=bind,source='+configPath+',target=/usr/local/openresty/nginx/conf/nginx.conf,readonly','openresty/openresty:1.27.1.2-0-alpine']);
 const entry=(await run(['port','lm044-gateway','8080'])).stdout.trim();
 for(let i=0;i<24;i++){try{await new Promise<void>((resolve,reject)=>{const req=httpRequest('http://'+entry,{headers:{host:'orders.example.test'}},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('gateway status '+res.statusCode)));});req.on('error',reject);req.end();});}catch{await new Promise(r=>setTimeout(r,250));}}
 await collect();
 // A second sample verifies container counters and cursor replay against real Docker.
 await collect();await store.run(app,'inspect',user.id,async()=>({state:'succeeded',cluster_id:cluster.id,verified:true}));logs.record('info','QA center started');await logs.publish();
 const appURL=base+'/api/v1/ops/resources/'+app.id+'/telemetry';const telemetry:any=await(await fetch(appURL)).json();
 if(Object.values(telemetry.results??{}).some((r:any)=>r.status==='error'))throw Error(JSON.stringify(telemetry));
 const physical=await ch.query("SELECT name FROM system.tables WHERE database='lightmoni' AND engine='ReplacingMergeTree' AND name LIKE '%lightmoni_application%'");
 const evidence=resolve(import.meta.dirname,'../../../specs/044-operations-observability/evidence');mkdirSync(evidence,{recursive:true});
 const tables=physical.data.map(r=>r.name);if(tables.length!==2)throw Error('application physical table count '+tables.length);
 const qps=(telemetry.results?.web?.rows??[]).length;if(!qps)throw Error('missing website request data');
 writeFileSync(join(evidence,'live-result.json'),JSON.stringify({mode:'real Docker, real Agent queue, real HTTP ingest, real ClickHouse and unified Query',applications:3,tables,metricRows:telemetry.results.load.rows.length,logRows:telemetry.results.logs.rows.length,websiteBuckets:qps,containerCount:agent.applications.inventory?.containers.length,app:app.id,cluster:cluster.id},null,2));
 process.stdout.write('Live QA ready '+base+' app='+app.id+'\n');
 const timer=setInterval(()=>{void collect().catch(()=>process.stderr.write('QA collect failed\n'));},15000);
 async function close(){clearInterval(timer);server.closeAllConnections();server.close();await logs.close();await agent.close();await platform.close();for(const name of names)await run(['rm','--force',name]).catch(()=>{});db.close();rmSync(root,{recursive:true,force:true});process.exit();}process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
}catch(error){process.stderr.write(String(error)+'\n');server.closeAllConnections();server.close();await logs.close();await agent.close();await platform.close();for(const name of names)await run(['rm','--force',name]).catch(()=>{});db.close();rmSync(root,{recursive:true,force:true});process.exitCode=1;}
