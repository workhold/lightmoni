/** Isolated real Router/SQLite fixture. Only the ACME and DNS network peers are fake. */
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DB} from '../../src/shared/sqlite.js';
import {Router,fail} from '../../src/shared/http.js';
import {cipher} from '../../src/shared/crypto.js';
import {registerAgentJobs} from '../../src/server/agent-jobs.js';
import {registerOperationsPlatform} from '../../src/ops/index.js';
import {certificateChain} from './certificate-material.js';
const root=mkdtempSync(join(tmpdir(),'lm053-ui-')),db=new DB(join(root,'control.db')),router=new Router();
db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('qa-admin','QA','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,group_id TEXT,heartbeat TEXT);CREATE TABLE services(id TEXT PRIMARY KEY)");
const user={id:'qa-admin',name:'QA',role:'admin'},auth:any={user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user?.role!=='admin')fail(403,'administrator_required')}};router.auth=auth;
const deps:any={db,router,auth,...cipher(Buffer.alloc(32,53)),now:()=>new Date(),logger:{info(){},warn(){},error(){process.stderr.write('QA request failed\n')}}};
let records:any[]=[],serial=0,invalidOrder=false,release:()=>void=()=>{},gate=new Promise<void>(resolve=>{release=resolve});
const json=(body:any)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const fetcher:typeof fetch=async(_url,init)=>{const data=Object.fromEntries(new URLSearchParams(String(init?.body)));switch(data.Action){
 case 'DescribeDomainRecords':return json({TotalCount:records.length,DomainRecords:{Record:records}});
 case 'AddDomainRecord':{const RecordId=String(++serial);records.push({RecordId,RR:data.RR,Type:data.Type,Value:data.Value,TTL:Number(data.TTL),Status:'ENABLE',Line:'default'});return json({RecordId});}
 case 'DeleteDomainRecord':records=records.filter(r=>r.RecordId!==data.RecordId);return json({});
 default:throw Error('unexpected fake DNS action '+data.Action);
}};
const jobs=registerAgentJobs(deps,{agentCredentials:{has:()=>true} as any}),platform=registerOperationsPlatform(deps,{jobs,dataDir:root,intervalMs:0,fetch:fetcher,certificate:{resolveChallenge:async()=>{await gate;return true},acmeClientFactory:(()=>({
 createAccount:async()=>({}),getAccountUrl:()=> 'https://qa-ca.example.test/account/one',
 createOrder:async()=>({url:'https://qa-ca.example.test/order/one',status:'pending'}),getOrder:async()=>({url:'https://qa-ca.example.test/order/one',status:invalidOrder?'invalid':'pending',authorizations:['https://qa-ca.example.test/auth/one']}),
 getAuthorizations:async()=>[{url:'https://qa-ca.example.test/auth/one',identifier:{value:'example.test'},status:invalidOrder?'invalid':'pending',challenges:[{type:'dns-01',status:invalidOrder?'invalid':'pending',token:'qa-hidden-challenge-053',...(invalidOrder?{error:{type:'urn:ietf:params:acme:error:dns',status:400,detail:'DNS problem: SERVFAIL looking up TXT for _acme-challenge.example.test; Incorrect TXT record "qa-hidden-wrong-txt-056" found; token=qa-hidden-challenge-053'}}:{})}]}],getChallengeKeyAuthorization:async()=> 'qa-hidden-txt-053',completeChallenge:async()=>({}),waitForValidStatus:async()=>{throw Object.assign(new Error('DNS problem: NXDOMAIN looking up TXT for _acme-challenge.example.test; token=qa-hidden-challenge-053'),{response:{status:400,data:{type:'urn:ietf:params:acme:error:dns'}}})},
 })) as any}}),store=platform.store;
const cred=store.create('credential','QA DNS',{provider:'aliyun',access_key_id:'qa-hidden-id-053',access_key_secret:'qa-hidden-secret-053'},user.id),zone=store.create('dns_zone','example.test',{domain:'example.test',credential_id:cred.id},user.id),account=store.create('acme_account','QA ACME',{email:'ops@example.test',directory_url:'letsencrypt-staging',terms_agreed:true},user.id);
router.get('/api/v1/auth/me',ctx=>ctx.json(user));router.get('/api/v1/user/preferences',ctx=>ctx.json({default_homepage:'/certificates'}));router.get('/api/v1/assistant/providers',ctx=>ctx.json({providers:[]}));router.get('/api/v1/assistant/sessions',ctx=>ctx.json({sessions:[]}));
router.get('/api/v1/qa/state',ctx=>ctx.json({account:account.id,zone:zone.id,certificates:store.list('certificate').map(c=>store.public(c))}));
router.post('/api/v1/qa/release',ctx=>{release();ctx.json({ok:true})});
router.post('/api/v1/qa/issued',async ctx=>{
 const material=await certificateChain(),cert=store.create('certificate','证书下载验收',{source:'uploaded',domains:['download.example.test'],...material},user.id);
 ctx.json({id:cert.id,revision:cert.revision});
});
router.post('/api/v1/qa/invalid-order',ctx=>{
 invalidOrder=true;
 const cert=store.create('certificate','失效订单验收',{source:'acme',domains:['example.test'],acme_account_id:account.id,dns_zone_ids:[zone.id]},user.id);
 db.run('INSERT INTO ops_acme_orders VALUES(?,?,?,?,?,?,?,?)','qa-cached-invalid',cert.id,cert.revision,account.id,'pending',deps.encrypt(JSON.stringify({private_key_pem:'qa-hidden-cached-key-056',csr:'qa-hidden-cached-csr-056',order:{url:'https://qa-ca.example.test/order/cached'}})),deps.now().toISOString(),deps.now().toISOString());
 ctx.json({id:cert.id,revision:cert.revision});
});
router.post('/api/v1/qa/legacy',async ctx=>{
 const cert=store.create('certificate','旧记录验收',{source:'self_signed',domains:['old.example.test'],auto_renew:false},user.id);
 const run=await store.run(cert,'issue',user.id,async()=>({state:'failed',code:'acme_issuance_failed'}));
 store.patchStatus(cert.id,{state:'failed',initial_issue_pending:false,last_run_id:run.id,last_error:'acme_issuance_failed'});ctx.json({id:cert.id});
});
const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404,{'content-type':'application/json'});res.end('{}')}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
process.stdout.write(JSON.stringify({base:'http://127.0.0.1:'+(server.address() as any).port})+'\n');
async function close(){release();server.close();server.closeAllConnections();await platform.close();jobs.close?.();db.close();rmSync(root,{recursive:true,force:true});process.exit(0)}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
