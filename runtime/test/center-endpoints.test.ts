import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DB} from '../src/shared/sqlite.js';
import {Router} from '../src/shared/http.js';
import {Auth} from '../src/server/auth.js';
import {Catalog} from '../src/server/catalog.js';
import {registerSettings} from '../src/server/settings.js';
import {registerAgentCredentials} from '../src/server/agent-credentials.js';
import {issueHostEnrollment} from './helpers/host-enrollment.js';
import {createAgent} from '../src/agent/agent.js';
import {defaultConfig,normalizeRemote} from '../src/agent/config.js';

test('address book publishes scoped revisions with SDK/Agent auth and stable center identity',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'lm-endpoints-')),db=new DB(':memory:'),router=new Router();
 t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
 const auth=new Auth(db,directory,'http://127.0.0.1',router);router.auth=auth;auth.register();
 const ch={user:'test',async exec(){},async query(){return {meta:[],data:[],rows:0};},async insert(){}};
 const cat=new Catalog(db,ch,ch),deps:any={db,router,auth,cat,ch,reader:ch,now:()=>new Date(),externalURL:'http://127.0.0.1'};
 const credentials=registerAgentCredentials(deps);registerSettings(deps,credentials);
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;deps.externalURL=router.externalURL=base;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 let cookie='';const request=async(path:string,method='GET',body?:any,headers:Record<string,string>={})=>{
  const response=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];return {status:response.status,data:await response.json() as any};
 };
 const admin=await request('/api/v1/setup','POST',{name:'admin',password:'fixture-password'});assert.equal(admin.status,201);
 const key=await request('/api/v1/keys','POST',{name:'SDK'}),sdk={Authorization:'Bearer '+key.data.key};
 assert.equal((await request('/v1/center-endpoints')).status,401);
 const book={endpoints:[{id:'public',name:'Public',url:base,scope:'public'},{id:'internal',name:'Internal',url:'http://10.0.0.8:8080',scope:'internal'}],default_endpoint_id:'public'};
 assert.equal((await request('/api/v1/settings/reporting','PUT',book)).status,200);
 const first=await request('/v1/center-endpoints','GET',undefined,sdk);assert.equal(first.status,200);assert.equal(first.data.endpoints[1].scope,'internal');
 assert.equal((await request('/v1/center-identity')).data.center_id,first.data.center_id);
 book.endpoints[1].url='http://10.0.0.9:8081';await request('/api/v1/settings/reporting','PUT',book);
 const next=await request('/v1/center-endpoints','GET',undefined,sdk);assert.notEqual(next.data.revision,first.data.revision);assert.equal(next.data.center_id,first.data.center_id);assert.equal(next.data.endpoints[1].url,book.endpoints[1].url);
 assert.equal((await request('/api/v1/settings/reporting','PUT',{...book,endpoints:[book.endpoints[1]],default_endpoint_id:'internal'})).status,400);
 const issued=issueHostEnrollment(db,credentials,{endpoint_origin:base,version:'0.1.0',created_by:admin.data.id,expires_in_seconds:3600});
 const enrollment=await request('/api/v1/agents/enroll','POST',{enrollment_token:issued.token_display_once,install_nonce:'nonce',agent_public_key:'public-key',version:'0.1.0',arch:'amd64'});
 const activated=await request(`/api/v1/agents/${enrollment.data.agent_id}/activate`,'POST',{install_nonce:'nonce',health:{service:'ready',config_checked:true}},{Authorization:'Bearer '+enrollment.data.bootstrap_credential});
 const agentHeaders={'X-Lightmoni-Agent-ID':enrollment.data.agent_id,Authorization:'Bearer '+activated.data.control_credential};
 assert.equal((await request('/v1/center-endpoints','GET',undefined,agentHeaders)).status,200);
 assert.equal((await request('/v1/center-endpoints','GET',undefined,{...agentHeaders,Authorization:'Bearer '+activated.data.data_credential})).status,401);
 assert.equal((await request('/api/v1/sdk-exempt-tables','POST',{name:'anonymous_business',description:'test'})).status,201);
 // Existing anonymous SDK access follows the enabled exemption catalogue.
 assert.equal((await request('/v1/center-endpoints')).status,200);
});

test('Agent uses one selected internal entrance for control, telemetry, jobs and task channels',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'lm-agent-endpoints-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let publicURL='',internalURL='',revision='one';const seen:{name:string;path:string;authorization:string}[]=[];
 const handler=(name:string)=>async(req:any,res:any)=>{
  if(req.url==='/v1/center-identity'){assert.equal(req.headers.authorization,undefined);res.end('{"center_id":"same"}');return;}
  if(req.url==='/v1/center-endpoints'){res.end(JSON.stringify({version:1,center_id:'same',revision,endpoints:[{url:internalURL,scope:'internal'},{url:publicURL,scope:'public'}]}));return;}
  seen.push({name,path:req.url,authorization:req.headers.authorization});for await(const _ of req){}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url.endsWith('/config')?normalizeRemote({revision:'remote',collect_interval_seconds:15,host_enabled:false}):{}));
 };
 const entrance=async(name:string)=>{const server=createServer(handler(name));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});return {server,url:`http://127.0.0.1:${(server.address() as any).port}`};};
 const pub=await entrance('public');publicURL=pub.url;const internal=await entrance('internal');internalURL=internal.url;
 const agent=createAgent({...defaultConfig(),endpoint:publicURL,data_dir:directory,min_free_bytes:0,control_credential:'control',data_credential:'data'});t.after(()=>agent.close());
 await agent.refreshEndpoints();await agent.controlOnce(false);
 await agent.endpoints.fetch(publicURL+'/api/v1/agents/'+agent.identity.agent_id+'/jobs/claim',{method:'POST',body:'{}'});
 await agent.endpoints.fetch(publicURL+'/api/v1/agents/'+agent.identity.agent_id+'/task-runs/claim',{method:'POST',body:'{}'});
 await agent.send({id:'batch',signal:'logs',table:'business',created_at:new Date().toISOString(),content_type:'application/json',payload:Buffer.from('{"resourceLogs":[]}')} as any);
 assert.ok(seen.length>=5);assert.ok(seen.every(e=>e.name==='internal'));assert.ok(seen.some(e=>e.authorization==='Bearer data'));assert.ok(seen.some(e=>e.authorization==='Bearer control'));
 internal.server.closeAllConnections();await new Promise<void>(r=>internal.server.close(()=>r()));
 await assert.rejects(agent.controlOnce(false));await agent.controlOnce(false);assert.equal(seen.at(-1)?.name,'public');
 const next=await entrance('new-internal');internalURL=next.url;revision='two';await agent.refreshEndpoints();await agent.controlOnce(false);assert.equal(seen.at(-1)?.name,'new-internal');
});
