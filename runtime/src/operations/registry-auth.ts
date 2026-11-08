import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {OperationRejectedError} from './errors.js';
import {installCause} from './install-progress.js';
import type {OperationExecutionContext} from './types.js';

export interface RegistryPullCredential {
  registry:string; repository_prefix:string; username:string; password:string;
}
const invalid=():never=>{throw new OperationRejectedError('INVALID_REGISTRY_CREDENTIAL');};
const repository=/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
/** Registry identity has no scheme, path, userinfo, query or fragment. */
export function registryAddress(value:unknown):string {
  if(typeof value!=='string'||!value||value.length>300||/[\s\\?#]/.test(value))return invalid();
  const raw=value.startsWith('https://')?value.slice(8).replace(/\/$/,''):value;
  if(!/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/i.test(raw))return invalid();
  let url:URL;
  try{url=new URL('https://'+raw);}catch{return invalid();}
  if(url.port&&(+url.port<1||+url.port>65535))return invalid();
  return ['docker.io','index.docker.io','registry-1.docker.io'].includes(url.host)?'docker.io':url.host;
}
export function repositoryPrefix(value:unknown):string {
  if(value===undefined||value==='')return '';
  if(typeof value!=='string'||value.length>240||!repository.test(value))return invalid();
  return value;
}
export function imageRegistry(image:string):{registry:string;repository:string}|undefined {
  if(typeof image!=='string'||image.length>512||/[\s\\?#]/.test(image))return invalid();
  if(/^sha256:[a-f0-9]{64}$/.test(image))return;
  let name=image;
  const at=name.indexOf('@');
  if(at>=0){if(!/^@sha256:[a-f0-9]{64}$/.test(name.slice(at)))return invalid();name=name.slice(0,at);}
  if(name.lastIndexOf(':')>name.lastIndexOf('/')){
    if(!/^:[\w][\w.-]{0,127}$/.test(name.slice(name.lastIndexOf(':'))))return invalid();
    name=name.slice(0,name.lastIndexOf(':'));
  }
  const first=name.split('/')[0],explicit=name.includes('/')&&(first.includes('.')||first.includes(':')||first==='localhost');
  const host=explicit?registryAddress(first):'docker.io';
  let repo=explicit?name.slice(first.length+1):name;
  if(!repository.test(repo))return invalid();
  if(host==='docker.io'&&!repo.includes('/'))repo='library/'+repo;
  return {registry:host,repository:repo};
}
export function credentialMatches(credential:Pick<RegistryPullCredential,'registry'|'repository_prefix'>,image:string):boolean {
  const ref=imageRegistry(image),prefix=credential.repository_prefix;
  return !!ref&&ref.registry===credential.registry&&(!prefix||ref.repository===prefix||ref.repository.startsWith(prefix+'/'));
}
/** Only the pull subprocess gets this single-registry file. Never log command output. */
export async function pullAuthenticatedImage(image:string,context:OperationExecutionContext):Promise<void> {
  if(!context.registryCredential||!context.registryAuthDirectory)throw new OperationRejectedError('REGISTRY_AUTH_EXECUTOR_REQUIRED');
  context.signal.throwIfAborted();
  const credential=await context.registryCredential(image);
  if(registryAddress(credential.registry)!==credential.registry||repositoryPrefix(credential.repository_prefix)!==credential.repository_prefix||!credentialMatches(credential,image)
    ||typeof credential.username!=='string'||!credential.username||credential.username.length>256||/[:\x00-\x1f\x7f]/.test(credential.username)
    ||typeof credential.password!=='string'||!credential.password||credential.password.length>8192||/[\x00\r\n]/.test(credential.password))return invalid();
  const directory=await mkdtemp(join(context.registryAuthDirectory,'registry-auth-'));
  try{
    const first=image.split('/')[0],explicit=image.includes('/')&&(first.includes('.')||first.includes(':')||first==='localhost');
    const key=!explicit||['docker.io','index.docker.io'].includes(first)?'https://index.docker.io/v1/':first;
    await writeFile(join(directory,'config.json'),JSON.stringify({auths:{[key]:{auth:Buffer.from(credential.username+':'+credential.password).toString('base64')}}}),{mode:0o600,flag:'wx'});
    context.signal.throwIfAborted();
    await context.command('docker',['image','pull',image],{env:{DOCKER_CONFIG:directory},timeoutMs:300000,signal:context.signal});
    context.signal.throwIfAborted();
  }catch(error){
    if(context.signal.aborted)throw new OperationRejectedError('REGISTRY_AUTH_CANCELLED');
    throw Object.assign(new OperationRejectedError('REGISTRY_IMAGE_PULL_FAILED'),{diagnosticCode:installCause(error)||'image_access_denied'});
  }finally{credential.password='';await rm(directory,{recursive:true,force:true});}
}
