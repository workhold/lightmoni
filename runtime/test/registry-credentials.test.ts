import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DB} from '../src/shared/sqlite.js';
import {Router,fail} from '../src/shared/http.js';
import {cipher} from '../src/shared/crypto.js';
import {registerAgentJobs} from './helpers/domain-jobs.js';
import {registerOperationsPlatform} from '../src/ops/index.js';
import {registryCredentialSecret} from '../src/ops/registry-credentials.js';
async function fixture(t:any){
 const db=new DB(':memory:'),router=new Router();
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1),('member','member',1);
 CREATE TABLE agents(id TEXT PRIMARY KEY,host_id TEXT,hostname TEXT,version TEXT,platform TEXT,arch TEXT,last_seen TEXT,heartbeat TEXT);
 CREATE TABLE managed_machines(id TEXT PRIMARY KEY,name TEXT,address TEXT,agent_id TEXT);INSERT INTO managed_machines VALUES('machine','Node','127.0.0.1','agent');`);
 db.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?)','agent','host','Node','test','linux','amd64',new Date().toISOString(),JSON.stringify({operations_capabilities:['operations.platform','operations.platform.registry-auth.v1']}));
 const deps:any={db,router,...cipher(Buffer.alloc(32,91)),now:()=>new Date(),logger:{info(){},warn(){},error(){}},auth:{requireAdmin(c:any){if(c.user.role!=='admin')fail(403,'administrator_required');},user(req:any){const role=req.headers['x-role']??'admin';return {id:role,name:role,role};}}};router.auth=deps.auth;
 const jobs=registerAgentJobs(deps,{agentCredentials:{has:()=>true} as any}),platform=registerOperationsPlatform(deps,{jobs,dataDir:'/tmp/lm-registry-test'});
 const cluster=platform.store.create('cluster','Test cluster',{machine_ids:['machine'],nodes:[{machine_id:'machine',address:'127.0.0.1',cpu:4,memory_mb:4096}]},'admin');
 const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await platform.close();jobs.close();db.close();});
 const request=async(path='',method='GET',body?:any,role='admin')=>{const r=await fetch('http://127.0.0.1:'+(server.address() as any).port+'/api/v1/ops/registry-credentials'+path,{method,headers:{'content-type':'application/json','x-role':role},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any,cache:r.headers.get('cache-control')};};
 const values={name:'Team registry',registry:'registry.test',repository_prefix:'team',username:'robot',password:'fixture-only-secret',cluster_ids:[cluster.id]};
 const create=async(overrides:any={})=>{const r=await request('','POST',{...values,...overrides});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;};
 const app=(ids:string[],image='registry.test/team/app:1')=>platform.store.create('application','Private app',{mode:'container',image,ports:[],mounts:[],deployments:[{cluster_id:cluster.id,machine_ids:['machine']}],registry_credential_ids:ids},'admin');
 const queue=(a:any)=>{const run=platform.store.queue(a,'agent','deploy',{task:'workload.apply',application_id:a.id,application_revision:a.revision,cluster_id:cluster.id,application:a.spec},'admin');const job=jobs.get(run.job_id);return {run,job,payload:()=>platform.store.resolvePayload(job)};};
 return {db,deps,request,create,values,cluster,platform,jobs,app,queue};
}

test('registry CRUD is admin-only, encrypted and write-only; empty password preserves same identity',async t=>{
 const f=await fixture(t);assert.equal((await f.request('','GET',undefined,'member')).status,403);
 const created=await f.create({registry:'https://registry.test:443/'});assert.equal(created.registry,'registry.test');assert.equal(created.has_password,true);assert.equal(created.revision,1);
 assert.doesNotMatch(JSON.stringify(await f.request()),/fixture-only-secret|secret_cipher/);
 const row=f.db.get<any>('SELECT * FROM ops_registry_credentials WHERE id=?',created.id)!;assert(!JSON.stringify(row).includes(f.values.password));assert.equal(f.deps.decrypt(row.secret_cipher),f.values.password);
 const edit=await f.request('/'+created.id,'PUT',{...f.values,name:'Renamed',password:'',revision:1});assert.equal(edit.status,200);assert.equal(edit.body.revision,2);assert.equal(f.db.get<any>('SELECT secret_cipher FROM ops_registry_credentials WHERE id=?',created.id)?.secret_cipher,row.secret_cipher);
 assert.equal((await f.request('/'+created.id,'PUT',{...f.values,password:'',username:'another',revision:2})).status,400);
 assert.equal((await f.request('/'+created.id,'PUT',{...f.values,revision:1})).status,409);
 assert.equal((await f.request()).cache,'no-store');
});
test('application references freeze authorization, secret is fetched only for the exact image, rotation invalidates pending work',async t=>{
 const f=await fixture(t),c=await f.create(),a=f.app([c.id]),x=f.queue(a),p=x.payload();
 assert.equal(p.resource.config.registry_authorizations[0].revision,1);
 const secret=registryCredentialSecret(f.deps,p.resource.config,'registry.test/team/app:1');assert.equal(secret.password,f.values.password);
 assert.throws(()=>registryCredentialSecret(f.deps,p.resource.config,'registry.test/other/app:1'),/not_authorized/);
 assert.doesNotMatch(JSON.stringify(p),/fixture-only-secret|password/);
 assert.doesNotMatch(JSON.stringify(f.jobs.get(x.job.id)),/fixture-only-secret|robot/);
 assert.equal((await f.request()).body[0].references[0].id,a.id);
 assert.equal((await f.request('/'+c.id,'DELETE',{revision:1})).status,409);
 assert.equal((await f.request('/'+c.id,'PUT',{...f.values,password:'rotated-fixture-secret',revision:1})).status,200);
 assert.throws(x.payload,/authorization_changed/);
 assert.throws(()=>registryCredentialSecret(f.deps,p.resource.config,'registry.test/team/app:1'),/authorization_changed/);
 const fresh=f.queue(a).payload();assert.equal(registryCredentialSecret(f.deps,fresh.resource.config,'registry.test/team/app:1').password,'rotated-fixture-secret');
});
test('revocation clears the encrypted secret and blocks pending credentials without restarting containers',async t=>{
 const f=await fixture(t),c=await f.create(),a=f.app([c.id]),x=f.queue(a);
 const revoked=await f.request('/'+c.id+'/revoke','POST',{revision:1});assert.equal(revoked.status,200);assert.equal(revoked.body.status,'revoked');assert.equal(revoked.body.has_password,false);
 assert.equal(f.db.get<any>('SELECT secret_cipher FROM ops_registry_credentials WHERE id=?',c.id)?.secret_cipher,'');
 assert.throws(x.payload,/unavailable/);assert.throws(()=>f.queue(a),/unavailable/);
});
test('authentication is scoped to registry, repository and cluster; ambiguous accounts and old executors are rejected',async t=>{
 const f=await fixture(t),c=await f.create();
 const unmatched=f.app([c.id],'registry.test/other/app:1');assert.equal(f.queue(unmatched).payload().resource.config.registry_authorizations,undefined);
 const other=await f.create({name:'Other',cluster_ids:[]}),a=f.app([c.id,other.id]);assert.throws(()=>f.queue(a),/ambiguous/);
 const scoped=await f.create({name:'Wrong cluster',cluster_ids:[]});
 f.db.run('UPDATE ops_registry_credentials SET cluster_ids_json=? WHERE id=?',JSON.stringify(['other']),scoped.id);const b=f.app([scoped.id]);assert.throws(()=>f.queue(b),/cluster_denied/);
 f.db.run('UPDATE agents SET heartbeat=? WHERE id=?',JSON.stringify({operations_capabilities:['operations.platform']}),'agent');const old=f.app([c.id]);assert.throws(()=>f.queue(old),/agent_upgrade_required/);
});
test('expired and invalid credentials fail safely; unreferenced credentials can be deleted',async t=>{
 const f=await fixture(t);for(const registry of ['http://registry.test','https://u:p@registry.test','registry.test/path'])assert.equal((await f.request('','POST',{...f.values,registry})).status,400);
 assert.equal((await f.request('','POST',{...f.values,expires_at:'2000-01-01T00:00:00Z'})).status,400);
 const c=await f.create();f.db.run('UPDATE ops_registry_credentials SET expires_at=? WHERE id=?','2000-01-01T00:00:00Z',c.id);assert.throws(()=>f.app([c.id]),/unavailable/);
 assert.equal((await f.request('/'+c.id,'DELETE',{revision:1})).status,200);assert.deepEqual((await f.request()).body,[]);
});

test('published application references survive unsubmitted edits and prevent deletion',async t=>{
 const f=await fixture(t),c=await f.create(),app=f.app([c.id]);
 f.db.run('UPDATE ops_platform_application_deployments SET desired_revision=? WHERE application_id=?',app.revision,app.id);
 const updated=f.platform.store.update(app.id,app.revision,app.name,{...app.spec,registry_credential_ids:[]},'admin');
 assert.equal(updated.revision,2);
 const run=f.platform.store.queue(updated,'agent','deploy',{task:'workload.apply',application_id:app.id,application_revision:app.revision,cluster_id:f.cluster.id,application:app.spec},'admin');
 const p=f.platform.store.resolvePayload(f.jobs.get(run.job_id));assert.equal(p.resource.config.registry_authorizations[0].id,c.id);
 assert.equal((await f.request('/'+c.id,'DELETE',{revision:1})).status,409);
});
