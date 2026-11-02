import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DB} from '../../src/shared/sqlite.js';
import {Router,fail} from '../../src/shared/http.js';
import {cipher} from '../../src/shared/crypto.js';
import {registerAgentJobs} from '../helpers/domain-jobs.js';
import {registerOperationsPlatform} from '../../src/ops/index.js';
import {AgentJobRunner} from '../../src/agent/jobs.js';
import type {OperationExecutionContext} from '../../src/operations/types.js';

export const containerID='a'.repeat(64),secondID='b'.repeat(64);
export async function dockerFixture(){
 const root=mkdtempSync(join(tmpdir(),'lm057-')),db=new DB(join(root,'control.db')),router=new Router();
 let now=new Date();
 db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','QA','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);CREATE TABLE services(id TEXT PRIMARY KEY)");
 const heartbeat={docker_capabilities:['docker.inventory','docker.control'],docker_inventory:{observed_at:new Date(0).toISOString(),attempted_at:now.toISOString(),state:'unavailable',error:'docker_cli_missing',containers:[],truncated:false}};
 db.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)','node-a','host-a','Docker QA','test','linux','amd64',now.toISOString(),'default',JSON.stringify(heartbeat));
 const user={id:'admin',name:'QA',role:'admin'};
 const auth:any={user:(req:any)=>req.headers['x-role']==='member'?{...user,role:'member'}:user,requireAdmin:(ctx:any)=>{if(ctx.user.role!=='admin')fail(403,'administrator_required')}};router.auth=auth;
 const deps:any={db,router,auth,...cipher(Buffer.alloc(32,57)),now:()=>now,logger:{info(){},warn(){},error(){}}};
 const credentials:any={has:()=>true,authenticate:(req:any,id:string)=>{if(id!=='node-a'||req.headers.authorization!=='Bearer fixture-control')fail(403,'invalid_agent_credential')}};
 const jobs=registerAgentJobs(deps,{agentCredentials:credentials,expirySweepIntervalMs:10}),platform=registerOperationsPlatform(deps,{jobs,dataDir:root,intervalMs:0});
 db.exec("CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines VALUES('machine-a','Docker QA','127.0.0.1','node-a'),('machine-b','Other host','127.0.0.2','')");
 const calls:string[][]=[];let state='running';
 const command:OperationExecutionContext['command']=async(file,args)=>{
  if(file!=='docker')throw Error('unexpected executable');calls.push(args);
  if(args.includes('ps'))return {stdout:[{ID:containerID,Names:'qa-orders',Image:'orders:1',State:state,Ports:'8080/tcp',Labels:''},{ID:secondID,Names:'qa-stopped',Image:'busybox:1',State:'exited',Ports:'',Labels:''}].map(c=>JSON.stringify(c)).join('\n'),stderr:''};
  if(args.includes('inspect'))return {stdout:args.at(-1)+' '+state+'\n',stderr:''};
  if(args[2]==='stop')state='exited';else if(['start','restart'].includes(args[2]))state='running';else throw Error('unexpected Docker command');
  return {stdout:containerID,stderr:''};
 };
 router.get('/api/v1/auth/me',ctx=>ctx.json(user));router.get('/api/v1/user/preferences',ctx=>ctx.json({default_homepage:'/machines'}));router.get('/api/v1/assistant/providers',ctx=>ctx.json({providers:[]}));router.get('/api/v1/assistant/sessions',ctx=>ctx.json({sessions:[]}));
 // Minimal host page fixture; Docker APIs, SQLite, Agent authentication and lease runner are real.
 router.get('/api/v1/nodes',ctx=>ctx.json({agents:[],groups:[],tasks:[]}));
 router.get('/api/v1/machines',ctx=>ctx.json([{id:'machine-a',name:'Docker QA',address:'127.0.0.1',port:22,username:'root',connection_method:'ssh',capabilities:{terminal:{available:false},ssh_check:{available:false},deploy_agent:{available:false}},active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,ssh_recovery_available:false,agent_id:'node-a',agent_status:'online',created_at:now.toISOString(),updated_at:now.toISOString(),credential_count:0,has_credential:false}]));
 router.get('/api/v1/agents',ctx=>ctx.json([{id:'node-a',host_id:'host-a',hostname:'Docker QA',version:'test',platform:'linux',arch:'amd64',last_seen:now.toISOString(),group_id:'default',heartbeat:{collectors_status:{}}}]));
 router.get('/api/v1/host-labels',ctx=>ctx.json([]));
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404,{'content-type':'application/json'});res.end('{}')}});
 await new Promise<void>(resolve=>server.listen(Number(process.env.LIGHTMONI_DOCKER_QA_PORT??0),'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 const runner=new AgentJobRunner({endpoint:base,agentID:'node-a',controlCredential:'fixture-control',dataDir:root},{command});
 const req=async(path:string,method='GET',body?:any,headers:any={})=>{
  const response=await fetch(base+'/api/v1'+path,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
 };
 return {root,db,deps,jobs,platform,base,runner,command,calls,heartbeat,req,
  advance(ms:number){now=new Date(now.getTime()+ms)},
  async close(){server.close();server.closeAllConnections();await platform.close();jobs.close?.();db.close();rmSync(root,{recursive:true,force:true})},
 };
}
