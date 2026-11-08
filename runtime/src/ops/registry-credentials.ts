import {id} from '../shared/crypto.js';
import {fail} from '../shared/http.js';
import type {Dependencies,Handler} from '../shared/types.js';
import type {PlatformStore} from './types.js';
import {registryAddress,repositoryPrefix,credentialMatches,type RegistryPullCredential} from '../operations/registry-auth.js';

type Row=Record<string,any>;
export function createRegistryCredentialSchema(store:PlatformStore){
  store.deps.db.exec(`CREATE TABLE IF NOT EXISTS ops_registry_credentials(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,registry TEXT NOT NULL,repository_prefix TEXT NOT NULL,cluster_ids_json TEXT NOT NULL,
    username TEXT NOT NULL,secret_cipher TEXT NOT NULL,revision INTEGER NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT NOT NULL,
    created_by TEXT NOT NULL,updated_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
}
function get(deps:Pick<Dependencies,'db'>,key:string):Row {
  const row=deps.db.get<Row>('SELECT * FROM ops_registry_credentials WHERE id=?',key);
  if(!row)fail(404,'registry_credential_not_found');return row;
}
function active(deps:Pick<Dependencies,'now'>,row:Row){return !row.revoked_at&&!!row.secret_cipher&&(!row.expires_at||Date.parse(row.expires_at)>deps.now().getTime());}
function references(store:PlatformStore,key:string){
  // Published revisions can remain active after a desired-state edit.
  const refs=new Map<string,{id:string;name:string}>();
  for(const app of store.list('application'))if(app.spec.registry_credential_ids?.includes(key))refs.set(app.id,{id:app.id,name:app.name});
  if(store.deps.db.get("SELECT 1 FROM sqlite_master WHERE name='ops_platform_application_deployments'"))
    for(const row of store.deps.db.all<Row>(`SELECT DISTINCT a.id,a.name,r.spec_cipher FROM ops_platform_application_deployments d JOIN ops_platform_resources a ON a.id=d.application_id JOIN ops_platform_revisions r ON r.resource_id=d.application_id AND r.revision=d.desired_revision WHERE d.desired_revision>0`)){
      const spec=JSON.parse(store.deps.decrypt(row.spec_cipher));if(spec.registry_credential_ids?.includes(key))refs.set(row.id,{id:row.id,name:row.name});
    }
  return [...refs.values()];
}
function publicCredential(store:PlatformStore,row:Row){
  const {secret_cipher,cluster_ids_json,...view}=row;
  return {...view,cluster_ids:JSON.parse(cluster_ids_json),has_password:!!secret_cipher,status:row.revoked_at?'revoked':active(store.deps,row)?'active':'expired',references:references(store,row.id)};
}
export function registryCredentialIDs(store:PlatformStore,value:unknown):string[]{
  const ids=value===undefined?[]:value;
  if(!Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||ids.some(v=>typeof v!=='string'||!/^[a-f0-9]{32}$/.test(v)))fail(400,'invalid_registry_credential_ids');
  for(const key of ids)if(!active(store.deps,get(store.deps,key)))fail(409,'registry_credential_unavailable');
  return [...ids];
}
export function registryAuthorizations(store:PlatformStore,config:Row):Row[]|undefined {
  if(!['workload.apply','gateway.apply'].includes(config.task))return;
  const appID=config.application_id??config.openresty_application_id;
  if(!appID)return;
  const current=store.get(appID,'application');
  const applicationRevision=config.application_revision??config.registry_application_revision;
  let app=current;
  if(applicationRevision!==undefined&&applicationRevision!==current.revision){
    const deployed=store.deps.db.get<Row>('SELECT desired_revision FROM ops_platform_application_deployments WHERE application_id=? AND cluster_id=?',appID,config.cluster_id);
    const snapshot=deployed?.desired_revision===applicationRevision&&store.deps.db.get<Row>('SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?',appID,applicationRevision);
    if(!snapshot)fail(409,'registry_authorization_changed');
    app={...current,revision:applicationRevision,spec:JSON.parse(store.deps.decrypt(snapshot.spec_cipher))};
  }
  const ids=app.spec.registry_credential_ids??[];
  if(!ids.length)return;
  if(applicationRevision!==app.revision)fail(409,'registry_authorization_changed');
  const images=[...new Set<string>(config.task==='gateway.apply'?[config.image]:config.application?.mode==='container'?[config.application.image]:Object.values<Row>(config.application?.compose?.services??{}).map(s=>s.image))];
  const rows=ids.map((key:string)=>get(store.deps,key));
  const result:Row[]=[];
  for(const row of rows){
    if(!active(store.deps,row))fail(409,'registry_credential_unavailable');
    const matches=images.filter(image=>credentialMatches(row as RegistryPullCredential,image));
    if(!matches.length)continue;
    const clusters=JSON.parse(row.cluster_ids_json);
    if(clusters.length&&!clusters.includes(config.cluster_id))fail(403,'registry_credential_cluster_denied');
    if(!app.spec.deployments?.some((d:Row)=>d.cluster_id===config.cluster_id))fail(403,'registry_credential_cluster_denied');
    result.push({id:row.id,revision:row.revision,registry:row.registry,repository_prefix:row.repository_prefix,images:matches});
  }
  for(const image of images)if(result.filter(row=>row.images.includes(image)).length>1)fail(409,'registry_credential_ambiguous');
  return result.length?result:undefined;
}
export function validateRegistryAuthorizations(store:PlatformStore,config:Row){
  if(JSON.stringify(registryAuthorizations(store,config))!==JSON.stringify(config.registry_authorizations))fail(409,'registry_authorization_changed');
}
/** Called only after signed executor principal, source approval and current lease validation. */
export function registryCredentialSecret(deps:Pick<Dependencies,'db'|'decrypt'|'now'>,config:Row,image:unknown):RegistryPullCredential {
  if(typeof image!=='string')fail(400,'registry_image_not_authorized');
  const authorizations=(config.registry_authorizations??[]).filter((a:Row)=>a.images.includes(image));
  if(authorizations.length!==1)fail(403,'registry_image_not_authorized');
  const auth=authorizations[0],row=get(deps,auth.id);
  if(!active(deps,row)||row.revision!==auth.revision||row.registry!==auth.registry||row.repository_prefix!==auth.repository_prefix||!credentialMatches(row as RegistryPullCredential,image))fail(409,'registry_authorization_changed');
  return {registry:row.registry,repository_prefix:row.repository_prefix,username:row.username,password:deps.decrypt(row.secret_cipher)};
}
export function registerRegistryCredentials(store:PlatformStore,safe:(fn:Handler)=>Handler){
  const {db}=store.deps,base='/api/v1/ops/registry-credentials';
  const revision=(value:unknown,row:Row)=>{if(!Number.isSafeInteger(value))fail(400,'registry_credential_revision_required');if(value!==row.revision)fail(409,'registry_credential_revision_conflict');};
  const input=(v:Row,prior?:Row)=>{
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['name','registry','repository_prefix','cluster_ids','username','password','expires_at','revision'].includes(k)))fail(400,'invalid_registry_credential');
    const text=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(400,'invalid_registry_credential');return value.trim();};
    const name=text(v.name,128),registry=registryAddress(v.registry),prefix=repositoryPrefix(v.repository_prefix),username=text(v.username,256);
    if(username.includes(':'))fail(400,'invalid_registry_credential');
    const clusters=v.cluster_ids??[];
    if(!Array.isArray(clusters)||clusters.length>100||new Set(clusters).size!==clusters.length||clusters.some((key:unknown)=>typeof key!=='string'||!/^[a-f0-9]{32}$/.test(key)))fail(400,'invalid_registry_credential');
    for(const key of clusters)store.get(key,'cluster');
    const expires=v.expires_at??'';
    if(typeof expires!=='string'||expires&&(!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=store.deps.now().getTime()))fail(400,'invalid_registry_credential_expiry');
    let secret=prior?.secret_cipher??'';
    if(v.password!==undefined&&v.password!==''){
      if(typeof v.password!=='string'||v.password.length>8192||/[\x00\r\n]/.test(v.password))fail(400,'invalid_registry_credential');
      secret=store.deps.encrypt(v.password);
    }else if(!prior||prior.registry!==registry||prior.username!==username)fail(400,'registry_credential_password_required');
    if(!secret)fail(400,'registry_credential_password_required');
    return {name,registry,prefix,username,clusters,secret,expires:expires?new Date(expires).toISOString():''};
  };
  store.deps.router.get(base,safe(ctx=>ctx.json(db.all<Row>('SELECT * FROM ops_registry_credentials ORDER BY created_at,id').map(row=>publicCredential(store,row)))));
  store.deps.router.post(base,safe(async ctx=>{
    const v=input(await ctx.body()),key=id(),at=store.deps.now().toISOString();
    db.run('INSERT INTO ops_registry_credentials VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?)',key,v.name,v.registry,v.prefix,JSON.stringify(v.clusters),v.username,v.secret,v.expires,'',ctx.user.id,ctx.user.id,at,at);
    ctx.json(publicCredential(store,get(store.deps,key)),201);
  }));
  store.deps.router.put(base+'/:id',safe(async ctx=>{
    const body=await ctx.body<Row>();if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_registry_credential');db.transaction(()=>{const row=get(store.deps,ctx.params.id);revision(body.revision,row);if(row.revoked_at)fail(409,'registry_credential_unavailable');const v=input(body,row);
      db.run('UPDATE ops_registry_credentials SET name=?,registry=?,repository_prefix=?,cluster_ids_json=?,username=?,secret_cipher=?,expires_at=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?',v.name,v.registry,v.prefix,JSON.stringify(v.clusters),v.username,v.secret,v.expires,ctx.user.id,store.deps.now().toISOString(),row.id);
    });ctx.json(publicCredential(store,get(store.deps,ctx.params.id)));
  }));
  store.deps.router.post(base+'/:id/revoke',safe(async ctx=>{
    const body=await ctx.body<Row>();if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_registry_credential');db.transaction(()=>{const row=get(store.deps,ctx.params.id);revision(body.revision,row);const at=store.deps.now().toISOString();db.run("UPDATE ops_registry_credentials SET secret_cipher='',revoked_at=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?",at,at,ctx.user.id,row.id);});ctx.json(publicCredential(store,get(store.deps,ctx.params.id)));
  }));
  store.deps.router.delete(base+'/:id',safe(async ctx=>{
    const body=await ctx.body<Row>();if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_registry_credential');db.transaction(()=>{const row=get(store.deps,ctx.params.id);revision(body.revision,row);if(references(store,row.id).length)fail(409,'registry_credential_in_use');db.run('DELETE FROM ops_registry_credentials WHERE id=?',row.id);});ctx.json({deleted:true});
  }));
}
