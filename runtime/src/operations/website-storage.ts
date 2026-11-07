import { chmod, lstat, readFile, readlink, readdir, rename, rm, symlink, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashSync, compareSync } from 'bcryptjs';
import { atomicFile, directory, privateRoot, readJSON, safeFile, safeID, hash } from './website-files.js';
import { websiteGroups, websiteDigest, websiteStoragePaths } from './storage.js';
import { authScopes } from './basic-auth.js';
import { OperationRejectedError } from './errors.js';
import type { OperationExecutionContext } from './types.js';

type Row = Record<string, any>;
const reject = (code: string): never => { throw new OperationRejectedError(code); };
const digestPattern = /^[a-f0-9]{64}$/;
export type WebsiteRenderer = (config: Row, websiteID: string, sites: Row[], preview?: boolean) => string;
export function gatewayIdentity(config: Row, versions: Record<string,string>) {
  const gateway = { image: config.image ?? 'openresty/openresty:1.27.1.2-0-alpine', http_port: config.http_port ?? 80, https_port: config.https_port ?? 443,
    instance_id: config.instance_id, openresty_application_id: config.openresty_application_id, cluster_id: config.cluster_id };
  return { config: gateway, website_versions: versions, digest: hash(JSON.stringify({ image:gateway.image,http_port:gateway.http_port,https_port:gateway.https_port,website_versions:versions })) };
}
export async function ownedGateway(platform:string,instanceID:string,create=false) {
  const root=join(platform,'gateways',safeID(instanceID));
  if(create)await directory(root);
  else {const info=await lstat(root);if(info.isSymbolicLink()||!info.isDirectory())reject('GATEWAY_DIRECTORY_OWNERSHIP_REQUIRED');}
  const expected={layout_version:2,instance_id:instanceID},owner=await readJSON<Row|null>(join(root,'owner.json'),null);
  if(owner){if(JSON.stringify(owner)!==JSON.stringify(expected))reject('GATEWAY_DIRECTORY_OWNERSHIP_REQUIRED');}
  else if(create&&!(await readdir(root)).length)await atomicFile(join(root,'owner.json'),JSON.stringify(expected));
  else reject('GATEWAY_DIRECTORY_OWNERSHIP_REQUIRED');
  return root;
}
export async function ownedWebsite(platform: string, websiteID: string, create = false) {
  const paths = websiteStoragePaths(platform, websiteID), marker = join(paths.root, 'owner.json');
  if (create) {
    await directory(join(platform, 'websites'), 0o755); await chmod(join(platform, 'websites'), 0o755);
    await directory(paths.root, 0o755); await chmod(paths.root, 0o755);
  } else {
    try {const parent=await lstat(dirname(paths.root));if(parent.isSymbolicLink()||!parent.isDirectory())reject('WEBSITE_DIRECTORY_OWNERSHIP_REQUIRED');}catch(e:any){if(e.code==='ENOENT')return null;throw e;}
    try { const info=await lstat(paths.root); if(info.isSymbolicLink()||!info.isDirectory())reject('WEBSITE_DIRECTORY_OWNERSHIP_REQUIRED'); }
    catch(e:any) { if(e.code==='ENOENT')return null;throw e; }
  }
  const expected = { layout_version: 2, website_id: websiteID }, owner = await readJSON<Row|null>(marker,null);
  if (owner) { if(JSON.stringify(owner)!==JSON.stringify(expected))reject('WEBSITE_DIRECTORY_OWNERSHIP_REQUIRED'); }
  else if(create && !(await readdir(paths.root)).length) await atomicFile(marker,JSON.stringify(expected));
  else reject('WEBSITE_DIRECTORY_OWNERSHIP_REQUIRED');
  return paths;
}
async function writeChanged(path:string, body:string, mode=0o600) {
  await safeFile(path);
  try { if(await readFile(path,'utf8')===body && ((await lstat(path)).mode&0o777)===mode)return; }
  catch(e:any) { if(e.code!=='ENOENT')throw e; }
  await atomicFile(path,body,mode);
}
export async function stageWebsites(context:OperationExecutionContext, config:Row, render:WebsiteRenderer, normalizeFiles:(v:any)=>Record<string,string>) {
  const platform=await privateRoot(context,'platform'), versions:Record<string,string>={};
  for(const [websiteID,sites] of websiteGroups(config)) {
    const digest=websiteDigest(config,sites), paths=websiteStoragePaths(platform,websiteID,digest), rendered=render(config,websiteID,sites);
    await ownedWebsite(platform,websiteID,true);
    await directory(join(paths.root,'versions'),0o755);await directory(paths.version_root!,0o755);
    await chmod(join(paths.root,'versions'),0o755);await chmod(paths.version_root!,0o755);
    let probe=await readJSON<Row|null>(join(paths.version_root!,'auth-probe.json'),null);
    if(sites.some(s=>authScopes(s).length)) {
      if(!probe||typeof probe.username!=='string'||typeof probe.password!=='string'||typeof probe.password_hash!=='string'||!compareSync(probe.password,probe.password_hash)) {
        const password=randomBytes(32).toString('hex');probe={username:'lm-probe-'+randomBytes(8).toString('hex'),password,password_hash:hashSync(password,10)};
        await atomicFile(join(paths.version_root!,'auth-probe.json'),JSON.stringify(probe));
      }
    }
    for(const site of sites) {
      const fragment=safeID(site.id);
      for(const scope of authScopes(site)) {
        const auth=join(paths.version_root!,'auth',fragment);await directory(auth,0o755);await chmod(dirname(auth),0o755);await chmod(auth,0o755);
        await writeChanged(join(auth,scope.key+'.htpasswd'),scope.auth.users.map(u=>u.username+':'+u.password_hash).concat(probe!.username+':'+probe!.password_hash).join('\n')+'\n',0o644);
        await writeChanged(join(auth,'proof.txt'),digest,0o644);
      }
      if(site.mode==='static')for(const [name,body] of Object.entries(normalizeFiles(site.static_files??{'index.html':'<!doctype html><h1>LightMoni</h1>'}))) {
        const publicRoot=join(paths.version_root!,'public'),path=join(publicRoot,fragment,name);await directory(dirname(path),0o755);
        for(let parent=dirname(path);parent.startsWith(publicRoot);parent=dirname(parent))await chmod(parent,0o755);
        await writeChanged(path,body,0o644);
      }
      if(site.certificate) {
        const ssl=join(paths.version_root!,'ssl',fragment);await directory(ssl);
        await writeChanged(join(ssl,'fullchain.pem'),site.certificate.certificate_pem);
        await writeChanged(join(ssl,'privkey.pem'),site.certificate.private_key_pem);
      }
    }
    await writeChanged(paths.config_file!,rendered);
    await writeChanged(join(paths.version_root!,'metadata.json'),JSON.stringify({layout_version:2,website_id:websiteID,http_port:config.http_port??80,https_port:config.https_port??443,sites}));
    versions[websiteID]=digest;
  }
  return versions;
}
export async function loadGatewayState(platform:string, raw:Row|null, fallback?:Row): Promise<Row|null> {
  if(!raw)return null;
  if(raw.version!==2||!raw.website_versions||typeof raw.website_versions!=='object')reject('GATEWAY_STORAGE_LAYOUT_MISMATCH');
  const sites:Row[]=[];
  for(const [websiteID,digest] of Object.entries<string>(raw.website_versions)) {
    if(!digestPattern.test(digest))reject('INVALID_WEBSITE_VERSION');
    const paths=await ownedWebsite(platform,safeID(websiteID));if(!paths)reject('WEBSITE_VERSION_MISSING');
    const version=websiteStoragePaths(platform,websiteID,digest).version_root!;
    let meta:Row|null=null;
    try {meta=await readJSON<Row|null>(join(version,'metadata.json'),null);}catch{}
    if(!meta||meta.layout_version!==2||meta.website_id!==websiteID||!Array.isArray(meta.sites)||websiteDigest(meta,meta.sites)!==digest) {
      const desired= fallback && websiteGroups(fallback).get(websiteID);
      if(!desired || websiteDigest(fallback!,desired)!==digest)reject('WEBSITE_VERSION_METADATA_INVALID');
      meta={sites:desired};
    }
    if(meta.sites.some((s:Row)=>(s.website_id??s.id)!==websiteID))reject('WEBSITE_VERSION_METADATA_INVALID');
    sites.push(...meta.sites);
  }
  return {...raw,config:{...raw.config,sites}};
}
export async function websitePointer(path:string,target:string|null) {
  let old:string|null=null;
  try { if(!(await lstat(path)).isSymbolicLink())reject('UNSAFE_WEBSITE_POINTER');old=await readlink(path);if(!/^versions\/[a-f0-9]{64}$/.test(old))reject('UNSAFE_WEBSITE_POINTER'); }
  catch(e:any) {if(e.code!=='ENOENT')throw e;}
  if(target===null){await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});return old;}
  if(!/^versions\/[a-f0-9]{64}$/.test(target))reject('UNSAFE_WEBSITE_POINTER');
  const temp=path+'.'+crypto.randomUUID();try{await symlink(target,temp);await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}return old;
}
export async function restoreWebsitePointers(platform:string, previous:Record<string,string|null>) {
  for(const [id,target] of Object.entries(previous))await websitePointer(websiteStoragePaths(platform,id).current,target);
}
export async function activateWebsitePointers(platform:string, versions:Record<string,string>) {
  const previous:Record<string,string|null>={};
  try {for(const [id,digest] of Object.entries(versions))previous[id]=await websitePointer(websiteStoragePaths(platform,id).current,'versions/'+digest);}
  catch(error){await restoreWebsitePointers(platform,previous);throw error;}
  return previous;
}
export async function websiteFilesMatch(platform:string,config:Row,versions:Record<string,string>,render:WebsiteRenderer,normalizeFiles:(v:any)=>Record<string,string>) {
  for(const [websiteID,sites] of websiteGroups(config)) {
    const digest=websiteDigest(config,sites);if(versions[websiteID]!==digest)return false;
    const paths=await ownedWebsite(platform,websiteID);if(!paths||await readlink(paths.current)!=='versions/'+digest)return false;
    const version=websiteStoragePaths(platform,websiteID,digest).version_root!;
    const verify=async(path:string,body:string,mode:number)=>{await safeFile(path);return ((await lstat(path)).mode&0o777)===mode&&await readFile(path,'utf8')===body;};
    if(!await verify(join(version,'nginx.conf'),render(config,websiteID,sites),0o600))return false;
    if(!await verify(join(version,'metadata.json'),JSON.stringify({layout_version:2,website_id:websiteID,http_port:config.http_port??80,https_port:config.https_port??443,sites}),0o600))return false;
    const probe=await readJSON<Row|null>(join(version,'auth-probe.json'),null);
    for(const site of sites) {
      const id=safeID(site.id);
      if(site.mode==='static')for(const [name,body] of Object.entries(normalizeFiles(site.static_files??{'index.html':'<!doctype html><h1>LightMoni</h1>'})))if(!await verify(join(version,'public',id,name),body,0o644))return false;
      if(site.certificate)for(const [name,body] of [['fullchain.pem',site.certificate.certificate_pem],['privkey.pem',site.certificate.private_key_pem]])if(!await verify(join(version,'ssl',id,name),body,0o600))return false;
      for(const scope of authScopes(site)) {
        if(!probe||!compareSync(probe.password,probe.password_hash))return false;
        const body=scope.auth.users.map(u=>u.username+':'+u.password_hash).concat(probe.username+':'+probe.password_hash).join('\n')+'\n';
        if(!await verify(join(version,'auth',id,scope.key+'.htpasswd'),body,0o644)||!await verify(join(version,'auth',id,'proof.txt'),digest,0o644))return false;
      }
    }
  }
  return Object.keys(versions).length===websiteGroups(config).size;
}
/** Remove only this website's owned tree and obsolete gateway include indexes.
 * Running gateways must first acknowledge the site's withdrawal. */
export async function removeWebsite(context:OperationExecutionContext,websiteID:string,renderIndex:(c:Row,digest:string)=>string) {
  websiteID=safeID(websiteID);const platform=await privateRoot(context,'platform'),family=join(platform,'gateways');
  let entries:string[]=[];
  try {const info=await lstat(family);if(info.isSymbolicLink()||!info.isDirectory())reject('UNSAFE_MANAGED_PATH');entries=await readdir(family);}
  catch(e:any){if(e.code!=='ENOENT')throw e;}
  for(const entry of entries) {
    safeID(entry);const root=await ownedGateway(platform,entry);
    let raw=await readJSON<Row|null>(join(root,'state.json'),null);
    if(raw && raw.version!==2)reject('GATEWAY_STORAGE_LAYOUT_MISMATCH');
    if(raw?.website_versions?.[websiteID]) {
      const result=await context.command('docker',['ps','-aq','--filter','name=^lm-gateway-'+entry+'$'],{timeoutMs:15000});
      const ids=result.stdout.trim().split(/\s+/).filter(Boolean);
      if(ids.length>1||ids.some(id=>!/^[a-f0-9]{12,64}$/.test(id)))reject('GATEWAY_OWNERSHIP_REQUIRED');
      if(ids.length) {
        const containers=JSON.parse((await context.command('docker',['inspect',...ids],{timeoutMs:15000})).stdout);
        if(!Array.isArray(containers)||containers.length!==1||containers[0].Config?.Labels?.['io.lightmoni.platform.instance']!==entry||containers[0].Config?.Labels?.['io.lightmoni.platform.owner']!=='lightmoni')reject('GATEWAY_OWNERSHIP_REQUIRED');
        if(containers[0].State?.Running===true)reject('WEBSITE_STILL_ACTIVE');
      }
      const versions={...raw.website_versions};delete versions[websiteID];
      const identity=gatewayIdentity(raw.config,versions),version=join(root,'versions',identity.digest);await directory(version);
      await atomicFile(join(version,'nginx.conf'),renderIndex({...identity.config,website_versions:versions},identity.digest));
      await atomicFile(join(version,'websites.json'),JSON.stringify(versions));
      await websitePointer(join(root,'current'),'versions/'+identity.digest);
      raw={...raw,...identity,updated_at:context.now().toISOString()};await atomicFile(join(root,'state.json'),JSON.stringify(raw));
    }
    if(raw?.retained_website_versions?.[websiteID]){const retained={...raw.retained_website_versions};delete retained[websiteID];raw={...raw,retained_website_versions:retained};await atomicFile(join(root,'state.json'),JSON.stringify(raw));}
    const versionsRoot=join(root,'versions');let versions:string[]=[];
    try {const info=await lstat(versionsRoot);if(info.isSymbolicLink()||!info.isDirectory())reject('UNSAFE_MANAGED_PATH');versions=await readdir(versionsRoot);}
    catch(e:any){if(e.code!=='ENOENT')throw e;}
    for(const digest of versions) {
      if(!digestPattern.test(digest))reject('INVALID_GATEWAY_VERSION');const version=join(versionsRoot,digest);await directory(version);
      const references=await readJSON<Row|null>(join(version,'websites.json'),null);
      if(references?.[websiteID]) {
        if(raw?.digest===digest)reject('WEBSITE_STILL_ACTIVE');
        await rm(version,{recursive:true});
      }
    }
  }
  const paths=await ownedWebsite(platform,websiteID);
  if(paths)await rm(paths.root,{recursive:true});
  return {website_id:websiteID,removed:true,absent:true};
}
export async function inspectWebsiteRemoval(context:OperationExecutionContext,websiteID:string) {
  websiteID=safeID(websiteID);const platform=await privateRoot(context,'platform'),owned=await ownedWebsite(platform,websiteID);
  let referenced=false;
  const family=join(platform,'gateways');let entries:string[]=[];
  try{const info=await lstat(family);if(info.isSymbolicLink()||!info.isDirectory())reject('UNSAFE_MANAGED_PATH');entries=await readdir(family);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  for(const entry of entries) {
    const root=await ownedGateway(platform,safeID(entry));
    const raw=await readJSON<Row|null>(join(root,'state.json'),null);
    if(raw&&raw.version!==2)reject('GATEWAY_STORAGE_LAYOUT_MISMATCH');
    if(raw?.website_versions?.[websiteID]||raw?.retained_website_versions?.[websiteID])referenced=true;
    const versions=join(root,'versions');let names:string[]=[];
    try{const info=await lstat(versions);if(info.isSymbolicLink()||!info.isDirectory())reject('UNSAFE_MANAGED_PATH');names=await readdir(versions);}catch(e:any){if(e.code!=='ENOENT')throw e;}
    for(const digest of names) {
      if(!digestPattern.test(digest))reject('INVALID_GATEWAY_VERSION');const info=await lstat(join(versions,digest));if(info.isSymbolicLink()||!info.isDirectory())reject('UNSAFE_MANAGED_PATH');
      if((await readJSON<Row|null>(join(versions,digest,'websites.json'),null))?.[websiteID])referenced=true;
    }
  }
  return {website_id:websiteID,absent:!owned&&!referenced};
}
