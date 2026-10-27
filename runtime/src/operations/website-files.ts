import { lstat, mkdir, readFile, writeFile, rename, chmod, readdir, unlink, realpath } from 'node:fs/promises';
import { resolve, join, dirname, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { OperationExecutionContext } from './types.js';

export const safeID=(value:unknown):string=> {if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))throw new Error('INVALID_RESOURCE_ID');return value;};
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function directory(path:string,mode=0o700):Promise<void>{
  const parent=dirname(path);if(parent!==path)await directory(parent,mode);
  try { const s=await lstat(path);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('UNSAFE_MANAGED_PATH'); }
  catch(error:any){if(error.code!=='ENOENT')throw error;await directory(dirname(path),mode);try{await mkdir(path,{mode});}catch(e:any){if(e.code!=='EEXIST')throw e;}const s=await lstat(path);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('UNSAFE_MANAGED_PATH');}
}
export async function safeFile(path:string):Promise<void>{try{const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile())throw new Error('UNSAFE_MANAGED_PATH');}catch(error:any){if(error.code!=='ENOENT')throw error;}}
export async function atomicFile(path:string,body:string|Buffer,mode=0o600):Promise<void>{await directory(dirname(path));await safeFile(path);const tmp=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;try{await writeFile(tmp,body,{flag:'wx',mode});await rename(tmp,path);await chmod(path,mode);}finally{await unlink(tmp).catch(()=>{});}}
export async function readJSON<T>(path:string,fallback:T):Promise<T>{await safeFile(path);try{return JSON.parse(await readFile(path,'utf8')) as T;}catch(e:any){if(e.code==='ENOENT')return fallback;throw new Error('INVALID_MANAGED_STATE');}}
export async function privateRoot(context:OperationExecutionContext,domain:string):Promise<string>{
  const requested=resolve(context.dataDir);const root=join(await realpath(dirname(requested)),basename(requested));await directory(root);const operations=join(root,'operations');await directory(operations);const target=join(operations,safeID(domain));await directory(target);
  const marker=join(target,'.lightmoni-owner.json');const expected={version:1,domain,root};
  const owner=await readJSON<any>(marker,null);if(owner){if(JSON.stringify(owner)!==JSON.stringify(expected))throw new Error('MANAGED_DIRECTORY_OWNERSHIP_MISMATCH');}
  else {const entries=await readdir(target);if(entries.length)throw new Error('MANAGED_DIRECTORY_UNOWNED');await atomicFile(marker,JSON.stringify(expected));}
  return target;
}
export async function publicRoot(context:OperationExecutionContext):Promise<string>{
  const identity=hash(resolve(context.dataDir)).slice(0,20);
  const root=resolve(context.publicDir?join(await realpath(dirname(resolve(context.publicDir))),basename(context.publicDir)):(process.getuid?.()===0?join('/var/lib/lightmoni-web',identity):join(await realpath(dirname(resolve(context.dataDir))),`lightmoni-web-public-${identity}`)));
  const privatePath=resolve(context.dataDir);if(root===privatePath||root.startsWith(privatePath+sep))throw new Error('PUBLIC_ROOT_MUST_BE_SEPARATE');
  await directory(root,0o755);const marker=join(root,'.lightmoni-web-owner.json');const owner=await readJSON<any>(marker,null);
  if(owner){if(owner.dataDir!==privatePath||owner.version!==1)throw new Error('PUBLIC_DIRECTORY_OWNERSHIP_MISMATCH');}
  else {if((await readdir(root)).length)throw new Error('PUBLIC_DIRECTORY_UNOWNED');await atomicFile(marker,JSON.stringify({version:1,dataDir:privatePath}));}
  await chmod(root,0o755);return root;
}
export const quote=(text:string)=>{if(/[\r\n\0]/.test(text))throw new Error('UNSAFE_NGINX_VALUE');return '"'+text.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\$/g,'\\$')+'"';};
export async function nginxPaths(context:OperationExecutionContext){const root=await privateRoot(context,'websites');for(const dir of ['active','versions','logs'])await directory(join(root,dir));return{root,config:join(root,'nginx.conf'),pid:join(root,'nginx.pid')};}
export async function running(context:OperationExecutionContext):Promise<boolean>{
 const{pid,root,config}=await nginxPaths(context);await safeFile(pid);let value:string;
 try{value=(await readFile(pid,'utf8')).trim();}catch(e:any){if(e.code==='ENOENT')return false;throw e;}
 if(!value)return false;
 if(!/^\d+$/.test(value)||Number(value)<2)throw new Error('INVALID_GATEWAY_PID');
 try{process.kill(Number(value),0);}catch(e:any){if(e.code==='ESRCH')return false;throw new Error('GATEWAY_PROCESS_UNVERIFIABLE');}
 let command:string;try{command=(await context.command('ps',['-p',value,'-o','command='],{timeoutMs:5000})).stdout.trim();}catch{throw new Error('GATEWAY_PROCESS_UNVERIFIABLE');}
 if(!command.startsWith('nginx: master process ')||!command.includes(` -p ${root+sep} -c ${config}`))throw new Error('GATEWAY_PROCESS_OWNERSHIP_MISMATCH');
 return true;
}
export async function preflight(context:OperationExecutionContext,config:string){const{root}=await nginxPaths(context);try{await context.command('nginx',['-t','-p',root+sep,'-c',config],{timeoutMs:20000});}catch{throw new Error('NGINX_PREFLIGHT_FAILED');}}
export async function reloadGateway(context:OperationExecutionContext){const{root,config}=await nginxPaths(context);await preflight(context,config);try{if(await running(context))await context.command('nginx',['-p',root+sep,'-c',config,'-s','reload'],{timeoutMs:20000});else await context.command('nginx',['-p',root+sep,'-c',config],{timeoutMs:20000});}catch{throw new Error('NGINX_ACTIVATION_FAILED');}if(!await running(context))throw new Error('NGINX_PROCESS_NOT_RUNNING');}
export async function workerDirective(context:OperationExecutionContext):Promise<string>{
 if(process.getuid?.()===0){let group:string;try{group=(await context.command('id',['-gn','nobody'],{timeoutMs:5000})).stdout.trim();}catch{throw new Error('UNPRIVILEGED_NGINX_WORKER_REQUIRED');}if(!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(group))throw new Error('UNPRIVILEGED_NGINX_WORKER_REQUIRED');return `user nobody ${group};\n`;}
 const name=userInfo().username;if(!/^[A-Za-z_][A-Za-z0-9_-]*\$?$/.test(name))throw new Error('UNSUPPORTED_WORKER_ACCOUNT');return '';
}
export async function probeHTTP(port:number,domain:string,path='/',tls=false,signal?:AbortSignal):Promise<{status:number,text:string,peer_fingerprint_sha256?:string}>{
 return new Promise((resolve,reject)=>{const req=(tls?httpsRequest:request)({hostname:'127.0.0.1',port,path,method:'GET',agent:false,headers:{Host:domain},signal,timeout:5000,...(tls?{servername:domain,rejectUnauthorized:false}:{})},res=>{const fingerprint=tls?(res.socket as TLSSocket).getPeerX509Certificate()?.fingerprint256:undefined;const data:Buffer[]=[];let size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){req.destroy(new Error('RESPONSE_LIMIT'));return;}data.push(chunk);});res.on('end',()=>resolve({status:res.statusCode??0,text:Buffer.concat(data).toString('utf8'),...(fingerprint?{peer_fingerprint_sha256:fingerprint}:{})}));res.on('error',()=>reject(new Error('GATEWAY_PROBE_FAILED')));});req.on('timeout',()=>req.destroy(new Error('TIMEOUT')));req.on('error',()=>reject(new Error('GATEWAY_PROBE_FAILED')));req.end();});
}
