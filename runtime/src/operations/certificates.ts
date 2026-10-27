import { readFile, unlink, realpath, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createPrivateKey, createPublicKey, X509Certificate, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { OperationConfig, OperationDefinition, OperationPayload, OperationExecutionContext, OperationExecutionResult } from './types.js';
import { domains } from './websites.js';
import { atomicFile, directory, privateRoot, publicRoot, readJSON, reloadGateway, running, safeFile, safeID, probeHTTP, nginxPaths } from './website-files.js';

export function certificateMetadata(certificatePEM:string,privateKeyPEM:string,names:string[],now=new Date(),requireCurrent=true):OperationConfig{
 let certificate:X509Certificate;let chain:X509Certificate[];
 try {
   const blocks=certificatePEM.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
   if(!blocks?.length||blocks.length>12||certificatePEM.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'').trim())throw new Error();
   chain=blocks.map(pem=>new X509Certificate(pem));certificate=chain[0];
   const key=createPrivateKey(privateKeyPEM);const publicKey=createPublicKey(key).export({type:'spki',format:'der'});
   if(!certificate.publicKey.export({type:'spki',format:'der'}).equals(publicKey))throw new Error('CERTIFICATE_KEY_MISMATCH');
 }catch(e:any){if(e.message==='CERTIFICATE_KEY_MISMATCH')throw e;throw new Error('INVALID_CERTIFICATE_MATERIAL');}
 for(let index=0;index<chain.length;index++){const item=chain[index];if(requireCurrent&&(new Date(item.validFrom)>now||new Date(item.validTo)<=now))throw new Error('CERTIFICATE_NOT_CURRENTLY_VALID');if(index+1<chain.length&&(!chain[index+1].ca||!item.verify(chain[index+1].publicKey)))throw new Error('INVALID_CERTIFICATE_CHAIN');}
 for(const name of names)if(!(isIP(name)?certificate.checkIP(name):certificate.checkHost(name)))throw new Error('CERTIFICATE_DOMAIN_MISMATCH');
 return {domains:names,not_before:new Date(certificate.validFrom).toISOString(),expires_at:new Date(certificate.validTo).toISOString(),days_remaining:Math.max(0,Math.floor((new Date(certificate.validTo).getTime()-now.getTime())/86400000)),fingerprint_sha256:certificate.fingerprint256,issuer:certificate.issuer.slice(0,2048),subject:certificate.subject.slice(0,2048),self_signed:certificate.issuer===certificate.subject&&certificate.verify(certificate.publicKey),chain_length:chain.length};
}
function validate(config:unknown):OperationConfig{
 if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('INVALID_CERTIFICATE_CONFIG');const c=config as OperationConfig;const result:OperationConfig={domains:domains(c.domains)};
 if(c.email!==undefined&&c.email!==''){if(typeof c.email!=='string'||c.email.length>254||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(c.email))throw new Error('INVALID_ACME_EMAIL');result.email=c.email;}
 if(c.certificate_pem!==undefined&&c.certificate_pem!=='') {if(typeof c.certificate_pem!=='string'||Buffer.byteLength(c.certificate_pem)>128*1024||typeof c.private_key_pem!=='string'||Buffer.byteLength(c.private_key_pem)>64*1024)throw new Error('INVALID_CERTIFICATE_MATERIAL');certificateMetadata(c.certificate_pem,c.private_key_pem,result.domains,new Date(),false);result.certificate_pem=c.certificate_pem;result.private_key_pem=c.private_key_pem;}
 else if(c.private_key_pem)throw new Error('CERTIFICATE_PAIR_REQUIRED');return result;
}
export const certificateDefinition:OperationDefinition={kind:'certificate',operations:['inspect','install','issue','renew'],readOnly:['inspect'],validate,publicConfig:c=>({domains:c.domains,...(c.email?{email:c.email}:{}),has_certificate:Boolean(c.certificate_pem),has_private_key:Boolean(c.private_key_pem)}),validateInput(operation,_input,config){if(!this.operations.includes(operation))throw new Error('INVALID_CERTIFICATE_OPERATION');if(operation==='install'&&(!config.certificate_pem||!config.private_key_pem))throw new Error('CERTIFICATE_PAIR_REQUIRED');if(['issue','renew'].includes(operation)){if(!config.email)throw new Error('ACME_EMAIL_REQUIRED');if(config.domains.some((name:string)=>!name.includes('.')||isIP(name)))throw new Error('ACME_PUBLIC_DNS_DOMAIN_REQUIRED');}return{};}};
async function boundWebsites(id:string,context:OperationExecutionContext):Promise<OperationConfig[]>{
 const gateway=await nginxPaths(context),bound:OperationConfig[]=[];
 for(const name of await readdir(join(gateway.root,'active'))){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]*\.conf$/.test(name))continue;
  const siteID=name.slice(0,-5),base=join(gateway.root,'versions',siteID),state=await readJSON<any>(join(base,'state.json'),null);
  if(!state?.active_version)throw new Error('WEBSITE_BINDING_STATE_UNVERIFIABLE');
  const versionRoot=join(base,safeID(state.active_version)),version=await readJSON<any>(join(versionRoot,'metadata.json'),null),config=version?.config;
  if(!config)throw new Error('WEBSITE_BINDING_STATE_UNVERIFIABLE');
  if(config.certificate_id!==id)continue;
  const active=join(gateway.root,'active',name),verified=join(versionRoot,'site.conf');await safeFile(active);await safeFile(verified);
  if((await readFile(active,'utf8'))!==(await readFile(verified,'utf8')))throw new Error('WEBSITE_BINDING_STATE_UNVERIFIABLE');
  bound.push({...config,domains:domains(config.domains)});
 }
 return bound;
}
async function verifyBoundCertificate(id:string,fingerprint:string,context:OperationExecutionContext):Promise<void>{
 for(const config of await boundWebsites(id,context)){
  let matched=false;for(let attempt=0;attempt<20;attempt++){try{const response=await probeHTTP(config.https_port,config.domains[0],'/.well-known/lightmoni-health',true,context.signal);if(response.status===200&&response.peer_fingerprint_sha256===fingerprint){matched=true;break;}}catch{}if(context.signal.aborted)break;await new Promise<void>(resolve=>setTimeout(resolve,100));}if(!matched)throw new Error('CERTIFICATE_TLS_ACTIVATION_NOT_VERIFIED');
 }
}
async function install(payload:OperationPayload,context:OperationExecutionContext,certificate:string,key:string,source:string):Promise<OperationExecutionResult>{
 const bound=await boundWebsites(payload.resource.id,context);const requiredNames=[...new Set<string>([...payload.resource.config.domains,...bound.flatMap(site=>site.domains)])];const metadata=certificateMetadata(certificate,key,requiredNames,context.now());const root=await privateRoot(context,'certificates');const dir=join(root,safeID(payload.resource.id));await directory(dir);
 const state=await readJSON<any>(join(dir,'state.json'),null);if(state&&payload.resource.revision<state.revision)throw new Error('STALE_CERTIFICATE_REVISION');
 const certificatePath=join(dir,'certificate.pem'),keyPath=join(dir,'private.key');let previousCert:Buffer|undefined,previousKey:Buffer|undefined;
 for(const file of [certificatePath,keyPath])await safeFile(file);
 try{previousCert=await readFile(certificatePath);previousKey=await readFile(keyPath);}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const backup=join(dir,'versions',`${payload.resource.revision}-${safeID(payload.operation_id)}`);await directory(backup);await atomicFile(join(backup,'certificate.pem'),certificate);await atomicFile(join(backup,'private.key'),key);await atomicFile(join(backup,'metadata.json'),JSON.stringify({...metadata,source,installed_at:context.now().toISOString()}));
 try {await atomicFile(certificatePath,certificate);await atomicFile(keyPath,key);if(await running(context)){await reloadGateway(context);await verifyBoundCertificate(payload.resource.id,metadata.fingerprint_sha256,context);}}
 catch {if(previousCert&&previousKey){await atomicFile(certificatePath,previousCert);await atomicFile(keyPath,previousKey);try{if(await running(context)){await reloadGateway(context);await verifyBoundCertificate(payload.resource.id,new X509Certificate(previousCert).fingerprint256,context);}else if(bound.length)throw new Error('CERTIFICATE_GATEWAY_NOT_RUNNING');}catch{throw new Error('CERTIFICATE_ACTIVATION_FAILED_RECOVERY_FAILED');}}else{await unlink(certificatePath).catch(()=>{});await unlink(keyPath).catch(()=>{});}throw new Error('CERTIFICATE_ACTIVATION_FAILED');}
 await atomicFile(join(dir,'state.json'),JSON.stringify({revision:payload.resource.revision,source,...metadata,installed_at:context.now().toISOString()}));
 return{verified:true,data:{installed:true,source,...metadata}};
}
async function verifyACMEWebroot(config:OperationConfig,context:OperationExecutionContext):Promise<string>{
 if(!await running(context))throw new Error('ACME_GATEWAY_REQUIRED');
 const gateway=await nginxPaths(context);const activeDomains=new Set<string>();
 for(const name of await readdir(join(gateway.root,'active'))){if(!/^[A-Za-z0-9][A-Za-z0-9_-]*\.conf$/.test(name))continue;const id=name.slice(0,-5);const state=await readJSON<any>(join(gateway.root,'versions',id,'state.json'),null);if(!state?.active_version)continue;const version=await readJSON<any>(join(gateway.root,'versions',id,safeID(state.active_version),'metadata.json'),null);if(version?.config?.listen_port===80)for(const domain of version.config.domains)activeDomains.add(domain);}
 if(config.domains.some((name:string)=>!activeDomains.has(name)))throw new Error('ACME_GATEWAY_DOMAIN_NOT_MANAGED');
 const root=await publicRoot(context);const webroot=join(root,'acme');const challengeDir=join(webroot,'.well-known','acme-challenge');await directory(challengeDir,0o755);const token=randomBytes(24).toString('hex');const file=join(challengeDir,token);await atomicFile(file,token,0o644);
 try {for(const domain of config.domains){let response;try{response=await probeHTTP(80,domain,`/.well-known/acme-challenge/${token}`,false,context.signal);}catch{throw new Error('ACME_GATEWAY_PORT_80_REQUIRED');}if(response.status!==200||response.text!==token)throw new Error('ACME_GATEWAY_DOMAIN_NOT_MANAGED');}}finally{await unlink(file).catch(()=>{});}return webroot;
}
export async function executeCertificate(payload:OperationPayload,context:OperationExecutionContext):Promise<OperationExecutionResult>{
 const config=validate(payload.resource.config);payload={...payload,resource:{...payload.resource,config}};certificateDefinition.validateInput(payload.operation,payload.input,config);
 const root=await privateRoot(context,'certificates');const dir=join(root,safeID(payload.resource.id));await directory(dir);
 if(payload.operation==='inspect'){const state=await readJSON<any>(join(dir,'state.json'),null);if(!state)return{verified:true,data:{installed:false,domains:config.domains}};try{await safeFile(join(dir,'certificate.pem'));const certificate=await readFile(join(dir,'certificate.pem'),'utf8');const x509=new X509Certificate(certificate);return{verified:true,data:{...state,installed:true,fingerprint_sha256:x509.fingerprint256,state_consistent:state.fingerprint_sha256===x509.fingerprint256,expires_at:new Date(x509.validTo).toISOString(),days_remaining:Math.floor((new Date(x509.validTo).getTime()-context.now().getTime())/86400000),expired:new Date(x509.validTo)<=context.now()}};}catch{throw new Error('INSTALLED_CERTIFICATE_UNREADABLE');}}
 if(payload.operation==='install')return install(payload,context,config.certificate_pem,config.private_key_pem,'uploaded');
 const state=await readJSON<any>(join(dir,'state.json'),null);if(state&&payload.resource.revision<state.revision)throw new Error('STALE_CERTIFICATE_REVISION');if(payload.operation==='renew'&&state?.source!=='acme')throw new Error('ACME_CERTIFICATE_NOT_ISSUED');
 const webroot=await verifyACMEWebroot(config,context);const acmeRoot=join(dir,'acme');const configDir=join(acmeRoot,'config');const workDir=join(acmeRoot,'work');const logsDir=join(acmeRoot,'logs');for(const path of [configDir,workDir,logsDir])await directory(path);
 const args=['certonly','--webroot','--webroot-path',webroot,'--non-interactive','--agree-tos','--email',config.email,'--cert-name',safeID(payload.resource.id),'--config-dir',configDir,'--work-dir',workDir,'--logs-dir',logsDir,'--keep-until-expiring'];for(const domain of config.domains)args.push('-d',domain);
 try{await context.command('certbot',args,{timeoutMs:120000});}catch{throw new Error('ACME_ISSUANCE_OR_RENEWAL_FAILED');}
 const files=[];for(const name of ['fullchain.pem','privkey.pem']){let actual:string;try{actual=await realpath(join(configDir,'live',safeID(payload.resource.id),name));}catch{throw new Error('ACME_CERTIFICATE_MISSING');}if(!actual.startsWith(resolve(configDir,'archive')+sep))throw new Error('UNSAFE_ACME_CERTIFICATE_PATH');await safeFile(actual);files.push(await readFile(actual,'utf8'));}
 return install(payload,context,files[0],files[1],'acme');
}
