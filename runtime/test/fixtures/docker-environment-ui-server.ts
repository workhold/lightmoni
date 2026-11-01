/** Loopback QA: real HTTP/SQLite/host routes; controlled SSH and Agent receipts. */
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DB} from '../../src/shared/sqlite.js';
import {Router,fail} from '../../src/shared/http.js';
import {cipher} from '../../src/shared/crypto.js';
import {registerManagedMachines} from '../../src/server/managed-machines.js';
import {registerAgentJobs} from '../../src/server/agent-jobs.js';
import {registerOperationsPlatform} from '../../src/ops/index.js';
const root=await mkdtemp(join(tmpdir(),'lm069-ui-')),db=new DB(join(root,'qa.db')),router=new Router();
db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('qa-admin','QA','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);CREATE TABLE services(id TEXT PRIMARY KEY)");
const user={id:'qa-admin',name:'QA',role:'admin'},auth:any={user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user.role!=='admin')fail(403,'administrator_required')}};router.auth=auth;
const deps:any={db,router,auth,...cipher(Buffer.alloc(32,69)),now:()=>new Date(),logger:{info(){},warn(){},error(){}},externalURL:'https://qa.example.com'};
const credentials:any={has:()=>true,authenticate:()=>{},enrollmentStatus:()=>({status:'active'}),cancelEnrollment:()=>{}};
const machines=registerManagedMachines(deps,{agentCredentials:credentials,sshRunner:async input=>({stdout:JSON.stringify({state:input.command.includes('systemd-run')?'running':'succeeded',phase:input.command.includes('systemd-run')?'installing_packages':'verified',code:''}),stderr:'',stages:[]})});
const jobs=registerAgentJobs(deps,{agentCredentials:credentials}),platform=registerOperationsPlatform(deps,{jobs,dataDir:root,intervalMs:0});
router.get('/api/v1/auth/me',ctx=>ctx.json(user));router.get('/api/v1/user/preferences',ctx=>ctx.json({default_homepage:'/machines'}));router.get('/api/v1/assistant/providers',ctx=>ctx.json({providers:[]}));router.get('/api/v1/assistant/sessions',ctx=>ctx.json({sessions:[]}));router.get('/api/v1/host-labels',ctx=>ctx.json([]));
router.get('/api/v1/agents',ctx=>ctx.json(db.all<any>('SELECT * FROM agents').map(a=>({...a,heartbeat:JSON.parse(a.heartbeat)}))));
let app:any,run:any;
router.get('/api/v1/qa/state',ctx=>ctx.json({app,run}));
router.post('/api/v1/qa/agent-ready',ctx=>{const at=new Date().toISOString();db.run('UPDATE agents SET heartbeat=? WHERE id=?',JSON.stringify({docker_capabilities:['docker.inventory','docker.control'],docker_inventory:{observed_at:at,attempted_at:at,state:'ready',compose_available:true,truncated:false,containers:[]}}),'qa-node-0');ctx.json({ok:true});});
const server=createServer(async(req,res)=>{if(!(await router.handle(req,res))){res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"not_found"}');}});server.listen(19969,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:19969';
async function post(path:string,body:any){const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data:any=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;}
const names=['缺少 Docker','Docker 可用','Docker 权限不足','Docker 服务异常','Docker 待检测','Docker 观测过期'],codes=['docker_cli_missing','','docker_permission_denied','docker_daemon_unavailable','','docker_cli_missing'];
const ids:string[]=[];
for(let i=0;i<names.length;i++){
 const m=await post('/machines',{name:names[i],address:'127.0.0.'+(i+1),username:'root',connection_method:'direct_ssh'});ids.push(m.id);
 await post('/machines/'+m.id+'/credentials',{method:'password',secret:'isolated-qa-password',retention:'temporary'});
 const at=(i===5?new Date(0):new Date()).toISOString(),heartbeat=i===4?{}:{docker_capabilities:['docker.inventory','docker.control'],docker_inventory:{observed_at:at,attempted_at:at,state:i===1?'ready':'unavailable',error:codes[i],compose_available:i===1?true:undefined,containers:[],truncated:false}};
 db.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)','qa-node-'+i,'qa-host-'+i,names[i],'qa-069','linux','amd64',new Date().toISOString(),'default',JSON.stringify(heartbeat));
 db.run('UPDATE managed_machines SET agent_id=?,host_key_fingerprint=? WHERE id=?','qa-node-'+i,'SHA256:fixtureDockerHostIdentity',m.id);
}
const cluster=platform.store.create('cluster','Docker 环境验收',{machine_ids:[ids[0]],nodes:[{machine_id:ids[0],address:'127.0.0.1',cpu:8,memory_mb:8192}]},user.id);
const install=await post('/ops/catalog/openresty/install',{name:'OpenResty 缺少 Docker',deployment_mode:'manual',deployments:[{cluster_id:cluster.id,machine_ids:[ids[0]],cpu:.25,memory_mb:128}],parameters:{},confirmed:true});app=install.resource;run=install.runs[0];
const lease=jobs.claim('qa-node-0',['operations.platform','operations.platform.image-cache.v1','operations.platform.oneshot.v1'])!;
for(const [index,phase] of ['accepted','staging','activating'].entries())jobs.event('qa-node-0',lease.id,{lease_id:lease.lease_id,sequence:index+1,phase,summary:'QA bounded phase'});
jobs.result('qa-node-0',lease.id,{lease_id:lease.lease_id,state:'failed',code:'docker_prerequisite_failed',summary:'QA missing Docker',snapshot:{health:{healthy:false},operations:{data:{phase:'checking_docker',cause_code:'docker_cli_missing'}}}});
const timer=setInterval(()=>{const at=new Date().toISOString();db.run('UPDATE agents SET last_seen=?',at);for(const a of db.all<any>("SELECT id,heartbeat FROM agents WHERE id!='qa-node-5'")){const h=JSON.parse(a.heartbeat);if(h.docker_inventory){h.docker_inventory.observed_at=at;h.docker_inventory.attempted_at=at;db.run('UPDATE agents SET heartbeat=? WHERE id=?',JSON.stringify(h),a.id);}}},10000);
process.stdout.write(JSON.stringify({base,machine_id:ids[0],application_id:app.id})+'\n');
async function close(){clearInterval(timer);server.closeAllConnections();server.close();await machines.close?.();await platform.close();jobs.close?.();db.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
