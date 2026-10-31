import {createServer, request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile, writeFile, mkdir,rename,stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join, resolve, extname} from 'node:path';
import {randomBytes, X509Certificate, generateKeyPairSync} from 'node:crypto';
import assert from 'node:assert/strict';
import {DB} from '../../../runtime/dist/shared/sqlite.js';
import {Router} from '../../../runtime/dist/shared/http.js';
import {cipher, masterKey, hash} from '../../../runtime/dist/shared/crypto.js';
import {Auth} from '../../../runtime/dist/server/auth.js';
import {registerAgentJobs} from '../../../runtime/dist/server/agent-jobs.js';
import {registerAgentCredentials} from '../../../runtime/dist/server/agent-credentials.js';
import {createAgentHostSchema} from '../../../runtime/dist/server/agent-hosts.js';
import {registerOperationsPlatform} from '../../../runtime/dist/ops/index.js';
import {registerOperations} from '../../../runtime/dist/server/operations.js';
import {executeOperation, operationCommand} from '../../../runtime/dist/agent/operations.js';
import {createMockDNS} from './mock-dns.mjs';

// This bootstrap owns an isolated SQLite and one trusted QA machine identity.
// All cluster/application/website changes below go through the real HTTP API.
// No Docker commands are substituted: production executeOperation executes each
// immutable job payload and its actual receipt completes the current Agent lease.
if(process.platform!=='linux')throw Error('Run the demo in its Linux QA container');
const root=resolve(process.env.DEMO_STATE || '.local-dev/042-cluster-demo');
await mkdir(root,{recursive:true,mode:0o700});
let token;
try{token=(await readFile(join(root,'qa.token'),'utf8')).trim();}
catch{token=randomBytes(32).toString('base64url');await writeFile(join(root,'qa.token'),token,{mode:0o600,flag:'wx'});}
const db=new DB(join(root,'control.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL DEFAULT '',role TEXT NOT NULL,active INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);
  `);
const userColumns=new Set(db.all('PRAGMA table_info(users)').map(row=>row.name));
for(const column of ['name','password_hash','created_at'])if(!userColumns.has(column))db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
db.run("INSERT OR IGNORE INTO users(id,name,role,active,created_at) VALUES('demo-admin','Demo administrator','admin',1,?)",new Date().toISOString());
db.run("UPDATE users SET name='Demo administrator' WHERE id='demo-admin'");
createAgentHostSchema(db);
const machine='demo-machine', actor={id:'demo-admin',name:'Demo administrator',role:'admin'};
let agent='',controlCredential='';
const at=()=>new Date().toISOString();
db.run(`INSERT OR IGNORE INTO managed_machines(id,name,address,port,username,connection_method,platform,arch,agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,machine,'Demo Linux Docker host','127.0.0.1',22,'qa','ssh','linux',process.arch,'',at(),at());
const router=new Router(()=>console.error('QA HTTP handler failed'));
const auth=new Auth(db,root,'http://127.0.0.1:19043',router);
auth.register();
db.run('INSERT OR REPLACE INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hash(token),actor.id,Math.floor(Date.now()/1000)+604800);
router.auth=auth;
const deps={db,router,...cipher(masterKey(root)),now:()=>new Date(),auth,logger:{info(){},warn(){},error(){console.error('Operations platform request failed');}}};
const credentials=registerAgentCredentials(deps);
const jobs=registerAgentJobs(deps,{agentCredentials:credentials});
const mockDNS=await createMockDNS(root);
const platform=registerOperationsPlatform(deps,{jobs,dataDir:join(root,'center'),fetch:mockDNS.fetch});
const operations=registerOperations(deps,{jobs,credentials,definitions:[],resolvePayload:job=>platform.resolvePayload(job)});
const dataDir=join(root,'agent');
await mkdir(dataDir,{recursive:true,mode:0o700});
const state={ready:false,phase:'starting',resource_ids:{},receipts:[],verification:null,rebuild_proof:null,error:null,nodes:[],local_enabled:true,entryAddress:'127.0.0.1',failover:null};
try{const previous=JSON.parse(await readFile(join(root,'report.json'),'utf8'));state.failover=previous.failover??null;state.rebuild_proof=previous.rebuild??null;}catch{}
let busy=false,workQueue=Promise.resolve();
const withWork=fn=>{
  const next=workQueue.then(async()=>{busy=true;try{return await fn();}finally{busy=false;}});
  workQueue=next.catch(()=>{});
  return next;
};
const api=async(path,method='GET',body)=>{
  const response=await fetch('http://127.0.0.1:19042/api/v1/ops'+path,{method,headers:{cookie:'lm_session='+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw Error(`API ${method} ${path}: ${data.error || response.status}`);
  return data;
};
async function agentHTTP(path,body,bearer=controlCredential){
  const response=await fetch('http://127.0.0.1:19042/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw Error(`Agent API ${path}: ${data.error || response.status}`);
  return data;
}
async function ensureIdentity(){
  agent=db.get('SELECT agent_id FROM managed_machines WHERE id=?',machine).agent_id;
  if(agent && credentials.has(agent,'control')){
    controlCredential=deps.decrypt(await readFile(join(root,'agent-control.enc'),'utf8'));
  }else{
    if(agent && db.get("SELECT id FROM agent_jobs WHERE agent_id=? LIMIT 1",agent))throw Error('Existing Agent jobs require manual identity review');
    db.run("UPDATE managed_machines SET agent_id='' WHERE id=?",machine);
    const issue=credentials.issueEnrollment({machine_id:machine,endpoint_origin:'http://127.0.0.1:19042',created_by:actor.id,version:'0.1.0'});
    const nonce=randomBytes(24).toString('base64url');
    const publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
    const enrolled=await agentHTTP('/agents/enroll',{enrollment_token:issue.token_display_once,install_nonce:nonce,agent_public_key:publicKey,version:'0.1.0',arch:process.arch==='arm64'?'arm64':'amd64'},'');
    const activated=await agentHTTP('/agents/'+enrolled.agent_id+'/activate',{install_nonce:nonce,health:{service:'ready',config_checked:true}},enrolled.bootstrap_credential);
    agent=activated.agent_id;controlCredential=activated.control_credential;
    await writeFile(join(root,'agent-control.enc'),deps.encrypt(controlCredential),{mode:0o600});
  }
  db.run(`INSERT OR IGNORE INTO agents VALUES(?,?,?,?,?,?,?,?,?)`,agent,'demo-host','Isolated Linux Docker QA','0.1.0','linux',process.arch,at(),'default','{}');
}
async function ensureNode(node,center){
  const directory=join(root,'nodes',node.name);
  await mkdir(directory,{recursive:true,mode:0o700});
  db.run(`INSERT OR IGNORE INTO managed_machines(id,name,address,port,username,connection_method,platform,arch,agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,node.machine_id,'Demo isolated '+node.name,node.address,22,'qa','ssh','linux',process.arch,'',at(),at());
  db.run('UPDATE managed_machines SET address=? WHERE id=?',node.address,node.machine_id);
  let nodeAgent=db.get('SELECT agent_id FROM managed_machines WHERE id=?',node.machine_id).agent_id,credential;
  if(nodeAgent && credentials.has(nodeAgent,'control')){
    const old=JSON.parse(deps.decrypt(await readFile(join(directory,'identity.enc'),'utf8')));credential=old.control_credential;
  }else{
    const issue=credentials.issueEnrollment({machine_id:node.machine_id,endpoint_origin:center,created_by:actor.id,version:'0.1.0'}),nonce=randomBytes(24).toString('base64url');
    const publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
    const enrolled=await agentHTTP('/agents/enroll',{enrollment_token:issue.token_display_once,install_nonce:nonce,agent_public_key:publicKey,version:'0.1.0',arch:process.arch==='arm64'?'arm64':'amd64'},'');
    const activated=await agentHTTP('/agents/'+enrolled.agent_id+'/activate',{install_nonce:nonce,health:{service:'ready',config_checked:true}},enrolled.bootstrap_credential);
    nodeAgent=activated.agent_id;credential=activated.control_credential;
  }
  db.run(`INSERT OR IGNORE INTO agents VALUES(?,?,?,?,?,?,?,?,?)`,nodeAgent,node.machine_id,'Isolated '+node.name,'0.1.0','linux',process.arch,at(),'default','{}');
  node.agent_id=nodeAgent;
  await writeFile(join(directory,'identity.enc'),deps.encrypt(JSON.stringify({agent_id:nodeAgent,control_credential:credential,machine_id:node.machine_id,center})),{mode:0o600});
}
router.post('/api/v1/qa/agents/:id/heartbeat',ctx=>{
  credentials.authenticate(ctx.req,ctx.params.id,'control');
  db.run('UPDATE agents SET last_seen=? WHERE id=?',at(),ctx.params.id);ctx.json({ok:true});
},{public:true});
async function pump(){
  const began=at();
  if(state.local_enabled)db.run('UPDATE agents SET last_seen=? WHERE id=?',at(),agent);
  for(let count=0;count<50;count++){
    if(!state.local_enabled)break;
    const {job}=await agentHTTP('/agents/'+agent+'/jobs/claim',{capabilities:['operations.platform']});if(!job)break;
    const payloadResponse=await fetch('http://127.0.0.1:19042/api/v1/agents/'+agent+'/jobs/'+job.id+'/operations',{headers:{authorization:'Bearer '+controlCredential,'x-lightmoni-job-lease':job.lease_id}});
    if(!payloadResponse.ok)throw Error('Private Agent payload authorization failed');
    const {payload}=await payloadResponse.json();
    let sequence=0,phase='accepted',leaseError,eventQueue=Promise.resolve();
    const emit=event=>{
      phase=event.phase;
      eventQueue=eventQueue.then(()=>agentHTTP('/agents/'+agent+'/jobs/'+job.id+'/events',{lease_id:job.lease_id,sequence:++sequence,...event}));
      return eventQueue;
    };
    const heartbeat=setInterval(()=>{
      db.run('UPDATE agents SET last_seen=? WHERE id=?',at(),agent);
      void emit({phase,summary:'QA Agent is executing the approved operation'}).catch(error=>{leaseError=error;});
    },10000);
    let receipt;
    try{receipt=await executeOperation(payload,{dataDir,signal:new AbortController().signal,now:()=>new Date(),command:operationCommand},emit);}
    finally{clearInterval(heartbeat);}
    await eventQueue;
    if(leaseError)throw Error('Agent lease renewal failed');
    await agentHTTP('/agents/'+agent+'/jobs/'+job.id+'/result',{lease_id:job.lease_id,...receipt});
    const evidence={job_id:job.id,operation_id:payload.operation_id,resource_id:payload.resource.id,task:payload.resource.config.task,state:receipt.state,code:receipt.code,finished_at:receipt.finished_at};
    state.receipts.push(evidence);
    state.receipts=state.receipts.slice(-150);
    console.info(JSON.stringify(evidence));
    if(receipt.state!=='succeeded')throw Error(`Agent ${payload.resource.config.task}: ${receipt.state}/${receipt.code}`);
  }
  const targetAgents=[...(state.local_enabled?[agent]:[]),...state.nodes.map(node=>node.agent_id)].filter(Boolean);
  const deadline=Date.now()+180000;
  while(targetAgents.length && db.get("SELECT id FROM agent_jobs WHERE agent_id IN ("+targetAgents.map(()=>'?').join(',')+") AND state IN ('queued','leased','accepted','staging','activating','verifying') LIMIT 1",...targetAgents)){
    if(Date.now()>deadline)throw Error('Remote QA Agent job timed out');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const failed=db.get("SELECT state,receipt_json FROM agent_jobs WHERE updated_at>=? AND state IN ('failed','unknown') ORDER BY updated_at DESC LIMIT 1",began);
  if(failed)throw Error('QA Agent returned '+failed.state+': '+JSON.parse(failed.receipt_json).code);
}
async function action(id,name,input={}){
  const {resource}=await api('/resources/'+id);
  const result=await api('/resources/'+id+'/actions','POST',{revision:resource.revision,confirmed:true,action:name,input});
  await pump();return result;
}
async function ensure(kind,name,spec){
  const found=(await api('/resources?kind='+kind)).resources.find(resource=>resource.name===name);
  return found || (await api('/resources','POST',{kind,name,spec})).resource;
}
const request=(domain,path='/',{tls=false,method='GET',body,host=state.entryAddress}={})=>new Promise((resolve,reject)=>{
  const req=(tls?httpsRequest:httpRequest)({host,port:tls?443:80,servername:domain,rejectUnauthorized:false,agent:false,path,method,headers:{host:domain,...(body?{'content-type':'application/json'}:{})}},res=>{
    const certificate=tls?res.socket.getPeerCertificate():undefined;
    let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text,certificate}));
  });
  req.setTimeout(10000,()=>req.destroy(Error('request_timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});
async function syncEntry(){
  if(!state.resource_ids.openresty||!state.resource_ids.cluster)return;
  const {endpoints}=await api('/resources/'+state.resource_ids.openresty+'/endpoints?cluster_id='+state.resource_ids.cluster);
  const entry=endpoints.find(endpoint=>endpoint.port_name==='http');if(!entry)return;
  state.entryAddress=entry.ip;
  await writeFile(join(root,'entry.next'),JSON.stringify({address:entry.ip,instance_id:entry.instance_id,cluster_id:entry.cluster_id,updated_at:at()})+'\n',{mode:0o600});
  await rename(join(root,'entry.next'),join(root,'entry.json'));
}
async function verify({rebuild=false}={}){
  await action(state.resource_ids.web,'inspect');
  await syncEntry();
  const clusterQuery='?cluster_id='+state.resource_ids.cluster;
  let endpoints=(await api('/resources/'+state.resource_ids.web+'/endpoints'+clusterQuery)).endpoints;
  assert.deepEqual([...new Set(endpoints.map(endpoint=>endpoint.port_name))].sort(),['admin','http']);
  const marker='持久化验证 '+randomBytes(5).toString('hex');
  const written=await request('demo.example.test','/api/messages',{method:'POST',body:{message:marker}});
  assert.equal(written.status,201);
  const id=JSON.parse(written.text).id;
  const before=JSON.parse((await request('demo.example.test','/api/messages')).text);
  assert.ok(before.messages.some(message=>message.id===id && message.message===marker));
  const admin=await request('admin.example.test','/');
  assert.equal(admin.status,200);assert.equal(JSON.parse(admin.text).port,'admin');
  let rebuilt=state.rebuild_proof;
  if(rebuild){
    const {resource}=await api('/resources/'+state.resource_ids.web);
    const spec={...resource.spec,environment:{...resource.spec.environment,DEMO_REBUILD:randomBytes(5).toString('hex')}};
    await api('/resources/'+resource.id,'PUT',{revision:resource.revision,name:resource.name,spec});
    await action(resource.id,'deploy');
    await action(state.resource_ids.website,'deploy');
    const after=JSON.parse((await request('demo.example.test','/api/messages')).text);
    assert.ok(after.messages.some(message=>message.id===id && message.message===marker));
    assert.notEqual(before.instance,after.instance,'Web container must actually be recreated');
    rebuilt={before_instance:before.instance,after_instance:after.instance,data_preserved:true};
    state.rebuild_proof=rebuilt;
    endpoints=(await api('/resources/'+state.resource_ids.web+'/endpoints'+clusterQuery)).endpoints;
  }
  const tls=await request('demo.example.test','/api/messages',{tls:true});
  assert.equal(tls.status,200);
  const certificate=new X509Certificate(tls.certificate.raw);
  assert.ok(certificate.checkHost('demo.example.test'));
  let crossCluster;
  if(state.resource_ids.cluster_secondary){
    const secondary=state.nodes.find(node=>node.name==='secondary');
    const secondaryEndpoints=(await api('/resources/'+state.resource_ids.web+'/endpoints?cluster_id='+state.resource_ids.cluster_secondary)).endpoints;
    assert.ok(secondaryEndpoints.length===2 && secondaryEndpoints.every(endpoint=>endpoint.cluster_id===state.resource_ids.cluster_secondary && endpoint.machine_id===secondary.machine_id));
    assert.ok(endpoints.every(endpoint=>endpoint.cluster_id===state.resource_ids.cluster));
    const remote=await request('demo.example.test','/api/messages',{host:secondary.address,tls:true});
    assert.equal(remote.status,200);
    const data=JSON.parse(remote.text);assert.ok(data.messages.some(message=>message.id===id));
    const remoteAdmin=await request('admin.example.test','/',{host:secondary.address});
    assert.equal(remoteAdmin.status,200);assert.equal(JSON.parse(remoteAdmin.text).port,'admin');
    crossCluster={global_application_id:state.resource_ids.web,global_service_name:'demo-web',clusters:[state.resource_ids.cluster,state.resource_ids.cluster_secondary],first_endpoints:endpoints,second_endpoints:secondaryEndpoints,second_website_tls:remote.status,shared_database_read_back:true,second_container:data.instance,isolation:'Independent nested Docker engines and network namespaces on the same physical Docker host'};
  }
  const apps=[],containers=[];
  for(const key of ['mysql','web','openresty']){
    const {resource}=await api('/resources/'+state.resource_ids[key]);
    apps.push({id:resource.id,name:resource.name,service_name:resource.spec.service_name,mode:resource.spec.deployment_mode,source:resource.spec.source,revision:resource.revision,status:resource.status});
    for(const instance of resource.status.instances ?? []){
      const remote=state.nodes.find(node=>node.machine_id===instance.machine_id);
      const args=['ps','-a','--filter','label=io.lightmoni.platform.instance='+instance.id,'--format','{{json .}}'];
      const records=(await operationCommand('docker',remote?['exec',remote.container,'docker',...args]:args)).stdout.trim();
      if(records)containers.push(...records.split('\n').map(line=>{const item=JSON.parse(line);return {application_id:resource.id,instance_id:instance.id,id:item.ID,name:item.Names,image:item.Image,state:item.State,ports:item.Ports};}));
    }
  }
  const controllerFile=resolve(import.meta.dirname,'../../../runtime/dist/ops/cluster-workloads.js');
  const runtimeBuild={compiled_at:(await stat(controllerFile)).mtime.toISOString(),controller_sha256:hash(await readFile(controllerFile))};
  let migration;
  try{
    const old=new DatabaseSync(join(root,'before-global-migration.sqlite'),{readOnly:true});
    const oldApps=old.prepare("SELECT id,name FROM ops_platform_resources WHERE kind='application'").all(),oldInstances=old.prepare('SELECT id,owner_id,machine_id FROM ops_cluster_instances').all();old.close();
    migration={applications:oldApps.map(item=>({...item,preserved:!!db.get('SELECT id FROM ops_platform_resources WHERE id=?',item.id)})),instances:oldInstances.map(item=>({...item,preserved:!!db.get('SELECT id FROM ops_cluster_instances WHERE id=?',item.id)}))};
  }catch{}
  const report={verified_at:at(),method:'Real platform HTTP CRUD/actions, authenticated Agent private-payload HTTP, actual lease and Docker receipts',mocked:['local Host routing and explicit provider DNS mock','self-signed certificate instead of public ACME'],website:{http_status:written.status,read_back:true,mysql_message_id:id,admin_port_status:admin.status},tls:{status:tls.status,subject:certificate.subject,subject_alt_name:certificate.subjectAltName,fingerprint256:certificate.fingerprint256,valid_to:certificate.validTo},rebuild:rebuilt,endpoints,cross_cluster:crossCluster,dns_records:mockDNS.records(),failover:state.failover,applications:apps,containers,agent_receipts:state.receipts,access:{website:'http://127.0.0.1:18080',admin:'http://127.0.0.1:18081',tls_port:18443,workbench:"http://127.0.0.1:19043/qa/workbench"}};
  report.runtime_build=runtimeBuild;report.migration=migration;
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  state.verification={verified_at:report.verified_at,read_back:true,tls:true,rebuild:rebuilt,endpoints,cross_cluster:crossCluster,failover:state.failover};
  return state.verification;
}
async function verifyFailover(){
  const standby=state.nodes.find(node=>node.name==='standby');
  if(!standby)throw Error('Run nodes-up before the fault scenario');
  await action(state.resource_ids.openresty,'inspect');
  const path='/resources/'+state.resource_ids.openresty+'/endpoints?cluster_id='+state.resource_ids.cluster;
  const before=(await api(path)).endpoints.find(endpoint=>endpoint.port_name==='http');
  const localFault=before.machine_id===machine;
  if(!localFault && before.machine_id!==standby.machine_id)throw Error('Unsupported ingress node in QA fault scenario');
  const recordsBefore=mockDNS.records(),began=at();
  let pausedContainer=standby.container;
  if(localFault){
    pausedContainer=(await operationCommand('docker',['ps','-q','--filter','label=io.lightmoni.platform.instance='+before.instance_id])).stdout.trim();
    assert.ok(pausedContainer && !pausedContainer.includes('\n'));
    state.local_enabled=false;
  }
  await operationCommand('docker',['pause',pausedContainer]);
  let after;
  try{
    // Keep healthy peer observations fresh while the genuinely paused Agent's
    // heartbeat ages out. Do not create a never-claimed probe on that node.
    const expireAt=Date.now()+125000;
    while(Date.now()<expireAt){
      await action(state.resource_ids.web,'inspect',{cluster_id:state.resource_ids.cluster_secondary});
      if(state.resource_ids.cluster_secondary)await action(state.resource_ids.openresty,'inspect',{cluster_id:state.resource_ids.cluster_secondary});
      await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(1,expireAt-Date.now()))));
    }
    const deadline=Date.now()+210000;
    while(Date.now()<deadline){
      if(state.local_enabled)db.run('UPDATE agents SET last_seen=? WHERE id=?',at(),agent);
      await platform.tick();
      // The paused node cannot claim new jobs; only wait for the live peers.
      const oldNodes=state.nodes;if(!localFault)state.nodes=oldNodes.filter(node=>node!==standby);
      try{await pump();}finally{state.nodes=oldNodes;}
      after=(await api(path)).endpoints.find(endpoint=>endpoint.port_name==='http' && endpoint.machine_id!==before.machine_id);
      if(after){await syncEntry();break;}
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
    assert.ok(after,'Managed OpenResty must reschedule after the real Agent heartbeat expires');
    let response;
    const convergeAt=Date.now()+45000;
    do{
      await platform.tick();
      const oldNodes=state.nodes;if(!localFault)state.nodes=oldNodes.filter(node=>node!==standby);
      try{await pump();}finally{state.nodes=oldNodes;}
      await syncEntry();
      response=await request('demo.example.test','/api/messages',{tls:true});
      if(response.status===200)break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }while(Date.now()<convergeAt);
    assert.equal(response.status,200);
    await platform.tick();await new Promise(resolve=>setTimeout(resolve,500));
    const recordsAfter=mockDNS.records(),addresses=recordsAfter.filter(record=>record.RR==='demo'&&record.Type==='A').map(record=>record.Value);
    const oldAddress=localFault?'192.0.2.10':'192.0.2.11',newAddress=localFault?'192.0.2.11':'192.0.2.10';
    assert.ok(addresses.includes(newAddress)&&addresses.includes('192.0.2.20'));
    assert.ok(!addresses.includes(oldAddress));
    assert.ok(recordsAfter.some(record=>record.RecordId==='1'&&record.Type==='MX'));
    state.failover={started_at:began,verified_at:at(),fault:localFault?'Paused only the owned gateway container and disabled its actual local QA Agent claim/heartbeat loop; MySQL remained on its manually selected host':'Paused the isolated standby Docker node and its actual Agent/containers',before,after,actual_tls_status:response.status,dns_before:recordsBefore,dns_after:recordsAfter,unmanaged_record_preserved:true,physical_host_count:1};
  }finally{await operationCommand('docker',['unpause',pausedContainer]);state.local_enabled=true;}
  await new Promise(resolve=>setTimeout(resolve,1500));
  await platform.tick();await pump();await syncEntry();
  return verify();
}
async function deployDemo(){
  await ensureIdentity();
  const gateway=JSON.parse((await operationCommand('docker',['network','inspect','bridge','--format','{{json .IPAM.Config}}'])).stdout)[0].Gateway;
  try{state.nodes=JSON.parse(await readFile(join(root,'nodes.json'),'utf8'));}catch{state.nodes=[];}
  for(const node of state.nodes)await ensureNode(node,'http://'+gateway+':19042');
  const standby=state.nodes.find(node=>node.name==='standby'),secondary=state.nodes.find(node=>node.name==='secondary');
  state.phase='creating_cluster';
  let cluster=await ensure('cluster','Demo 集群',{machine_ids:[machine],port_start:24000,port_end:24999,nodes:[{machine_id:machine,address:gateway,public_address:'192.0.2.10',cpu:4,memory_mb:4096}]});
  const clusterSpec={...cluster.spec,machine_ids:[machine,...(standby?[standby.machine_id]:[])],nodes:[{machine_id:machine,address:gateway,public_address:'192.0.2.10',cpu:4,memory_mb:4096},...(standby?[{machine_id:standby.machine_id,address:standby.address,public_address:standby.public_address,cpu:4,memory_mb:2048}]:[])]};
  if(JSON.stringify(cluster.spec)!==JSON.stringify(clusterSpec))cluster=(await api('/resources/'+cluster.id,'PUT',{revision:cluster.revision,name:cluster.name,spec:clusterSpec})).resource;
  state.resource_ids.cluster=cluster.id;
  let secondaryCluster;
  if(secondary){
    secondaryCluster=await ensure('cluster','Demo 第二集群',{machine_ids:[secondary.machine_id],port_start:25000,port_end:25999,nodes:[{machine_id:secondary.machine_id,address:secondary.address,public_address:secondary.public_address,cpu:4,memory_mb:2048}]});
    const secondarySpec={...secondaryCluster.spec,nodes:[{machine_id:secondary.machine_id,address:secondary.address,public_address:secondary.public_address,cpu:4,memory_mb:2048}]};
    if(JSON.stringify(secondaryCluster.spec)!==JSON.stringify(secondarySpec))secondaryCluster=(await api('/resources/'+secondaryCluster.id,'PUT',{revision:secondaryCluster.revision,name:secondaryCluster.name,spec:secondarySpec})).resource;
    state.resource_ids.cluster_secondary=secondaryCluster.id;
  }
  const managedDeployments=[{cluster_id:cluster.id,replicas:1,cpu:.25,memory_mb:128},...(secondaryCluster?[{cluster_id:secondaryCluster.id,replicas:1,cpu:.25,memory_mb:128}]:[])];
  state.phase='installing_mysql';
  let mysql=(await api('/resources?kind=application')).resources.find(resource=>resource.spec.service_name==='demo-mysql');
  if(!mysql){
    const password=randomBytes(24).toString('base64url'),userPassword=randomBytes(24).toString('base64url');
    mysql=(await api('/catalog/mysql/install','POST',{name:'Demo MySQL',service_name:'demo-mysql',deployment_mode:'manual',deployments:[{cluster_id:cluster.id,machine_ids:[machine],cpu:.25,memory_mb:512}],parameters:{password,database:'cluster_demo',user:'demo',user_password:userPassword,port:23306},confirmed:false})).resource;
    // Application dependencies remain encrypted at rest. Only public API redacted
    // placeholders are read during future edits/rebuilds.
    await writeFile(join(root,'db-password.enc'),deps.encrypt(userPassword),{mode:0o600});
  }
  state.resource_ids.mysql=mysql.id;
  await action(mysql.id,'deploy');
  state.phase='deploying_custom_program';
  const dbPassword=deps.decrypt(await readFile(join(root,'db-password.enc'),'utf8'));
  let web=await ensure('application','Demo 留言程序',{service_name:'demo-web',source:{type:'custom'},role:'generic',deployment_mode:'managed',deployments:managedDeployments,stateful:false,mode:'container',image:process.env.DEMO_IMAGE || 'lightmoni-cluster-demo-web:1.0.0',ports:[{name:'http',container_port:8080,protocol:'tcp',app_protocol:'http'},{name:'admin',container_port:9090,protocol:'tcp',app_protocol:'http'}],environment:{DB_HOST:gateway,DB_PORT:'23306',DB_USER:'demo',DB_PASSWORD:dbPassword,DB_NAME:'cluster_demo'},health:{type:'http',port_name:'http',path:'/healthz'}});
  if(secondaryCluster && !web.spec.deployments.some(deployment=>deployment.cluster_id===secondaryCluster.id))web=(await api('/resources/'+web.id,'PUT',{revision:web.revision,name:web.name,spec:{...web.spec,deployments:managedDeployments}})).resource;
  state.resource_ids.web=web.id;
  await action(web.id,'deploy');
  state.phase='installing_openresty';
  let openresty=(await api('/resources?kind=application')).resources.find(resource=>resource.spec.service_name==='demo-openresty');
  if(!openresty)openresty=(await api('/catalog/openresty/install','POST',{name:'Demo OpenResty',service_name:'demo-openresty',deployment_mode:'managed',deployments:managedDeployments,confirmed:false})).resource;
  else if(openresty.spec.deployment_mode!=='managed' || (secondaryCluster && !openresty.spec.deployments.some(deployment=>deployment.cluster_id===secondaryCluster.id))){
    if(openresty.spec.deployment_mode!=='managed')await action(openresty.id,'stop');
    openresty=(await api('/resources/'+openresty.id,'PUT',{revision:openresty.revision,name:openresty.name,spec:{...openresty.spec,deployment_mode:'managed',deployments:managedDeployments}})).resource;
  }
  state.resource_ids.openresty=openresty.id;
  await action(openresty.id,'deploy');
  const certificate=await ensure('certificate','Demo 自签测试证书',{source:'self_signed',domains:['demo.example.test','admin.example.test'],validity_days:30,auto_renew:false});
  state.resource_ids.certificate=certificate.id;
  await action(certificate.id,'issue');
  const dnsCredential=await ensure('credential','Demo DNS mock',{provider:'aliyun',access_key_id:randomBytes(12).toString('hex'),access_key_secret:randomBytes(24).toString('base64url')});
  const zone=await ensure('dns_zone','Demo 测试域名',{domain:'example.test',credential_id:dnsCredential.id});
  const clusterIDs=[cluster.id,...(secondaryCluster?[secondaryCluster.id]:[])];
  const websiteSpec={cluster_ids:clusterIDs,bindings:[
    {domains:['demo.example.test'],https:true,certificate_id:certificate.id,dns_enabled:true,dns_zone_id:zone.id,locations:[{path:'/',cluster_targets:clusterIDs.map(cluster_id=>({cluster_id,target:'application',application_id:web.id,port_name:'http'}))}]},
    {domains:['admin.example.test'],https:true,certificate_id:certificate.id,dns_enabled:true,dns_zone_id:zone.id,locations:[{path:'/',cluster_targets:clusterIDs.map(cluster_id=>({cluster_id,target:'application',application_id:web.id,port_name:'admin'}))}]},
  ]};
  let site=await ensure('website','Demo 留言网站',websiteSpec);
  if(JSON.stringify(site.spec.cluster_ids)!==JSON.stringify(clusterIDs) || !site.spec.bindings.every(binding=>binding.dns_enabled))site=(await api('/resources/'+site.id,'PUT',{revision:site.revision,name:site.name,spec:websiteSpec})).resource;
  state.resource_ids.website=site.id;
  state.phase='publishing_website';await action(site.id,'deploy');
  await syncEntry();
  await platform.tick();await pump();
  state.phase='verifying_real_traffic';await verify({rebuild:true});
  state.ready=true;state.phase='ready';state.error=null;
  await writeFile(join(root,'ready.json'),JSON.stringify({resource_ids:state.resource_ids,verification:state.verification},null,2)+'\n',{mode:0o600});
}
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/qa/')){
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end('{}');}
    if(req.url==='/qa/workbench' && req.method==='GET'){
      auth.session({req,res},actor.id);
      res.writeHead(302,{location:'/applications'+(state.resource_ids.cluster?'?cluster='+state.resource_ids.cluster:'')});res.end();return;
    }
    try{
      const command=req.url.slice(4);
      let result;
      if(command==='status' && req.method==='GET')result={ready:state.ready,phase:state.phase,error:state.error,resource_ids:state.resource_ids,verification:state.verification};
      else if(req.method==='POST')result=await withWork(async()=>{
        if(command==='verify'||command==='rebuild')return verify({rebuild:command==='rebuild'});
        if(command==='failover')return verifyFailover();
        if(command==='stop'){
          for(const key of ['web','openresty','mysql'])if(state.resource_ids[key])await action(state.resource_ids[key],'stop');
          state.ready=false;state.phase='stopped';return {stopped:true,data_preserved:true};
        }
        if(command==='start'){await deployDemo();return {ready:true,verification:state.verification};}
        throw Error('unknown_demo_command');
      });
      else throw Error('unknown_demo_command');
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
    return;
  }
  if(await router.handle(req,res))return;
  if(req.url?.startsWith('/api/')){res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"Not available in the isolated application demo"}');return;}
  const dist=resolve(import.meta.dirname,'../../../runtime/public');
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=resolve(dist,'.'+pathname);
  if(file!==dist && !file.startsWith(dist+'/')){res.writeHead(403);res.end();return;}
  try{
    const source=await readFile(extname(file)?file:join(dist,'index.html'));
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
    res.writeHead(200,{'content-type':types[extname(file)] || (extname(file)?'application/octet-stream':'text/html; charset=utf-8')});res.end(source);
  }catch{res.writeHead(404);res.end('Build the web production bundle before opening the QA workbench');}
});
await new Promise(resolve=>server.listen(19042,'0.0.0.0',resolve));
void withWork(deployDemo).catch(error=>{state.error=error.message;state.phase='failed';console.error('Demo startup failed: '+error.message);});
setInterval(()=>{
  if(busy||!state.ready)return;
  void withWork(async()=>{if(state.local_enabled)db.run('UPDATE agents SET last_seen=? WHERE id=?',at(),agent);await platform.tick();await pump();await syncEntry();}).catch(error=>{state.error=error.message;console.error('Demo reconcile needs attention: '+error.message);});
},15000);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close();void platform.close().finally(()=>{db.close();process.exit(0);});});
