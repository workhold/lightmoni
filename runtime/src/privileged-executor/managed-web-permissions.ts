import {existsSync,lstatSync,mkdirSync,chmodSync,chownSync} from 'node:fs';
import {join} from 'node:path';
import {boundedFile,durableWrite,rootPath,refuse,sha256} from './security.js';
import type {OperationExecutionContext} from '../operations/types.js';
const NAME='lightmoni-web';
/** A dedicated unprivileged worker owns only HTTP temporary data. Private
 * executor keys, approved configurations and certificate keys stay root-only. */
export async function prepareManagedWeb(dataRoot:string,command:OperationExecutionContext['command']) {
 const marker=join(dataRoot,'.web-account.json');
 if(!existsSync(marker)) {
   let present=false;
   try{await command('id',['-u',NAME],{timeoutMs:5000});present=true;}
   catch(error){if((error as any)?.code!=='operation_command_failed')throw error;}
   if(present)refuse('managed_web_account_requires_review');
   await command('useradd',['--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',NAME],{timeoutMs:15000});
 }
 const uid=Number((await command('id',['-u',NAME],{timeoutMs:5000})).stdout.trim()),gid=Number((await command('id',['-g',NAME],{timeoutMs:5000})).stdout.trim());
 const groups=(await command('id',['-G',NAME],{timeoutMs:5000})).stdout.trim().split(/\s+/).map(Number);
 if(!Number.isSafeInteger(uid)||uid<100||uid>=1000||!Number.isSafeInteger(gid)||gid<1||groups.some(group=>group!==gid))refuse('managed_web_account_changed');
 if(existsSync('/var/run/docker.sock')&&lstatSync('/var/run/docker.sock').gid===gid)refuse('managed_web_account_has_docker_access');
 const expected={name:NAME,uid,gid};
 if(existsSync(marker)){if(boundedFile(marker,1024,true).toString()!==JSON.stringify(expected))refuse('managed_web_account_changed');}
 else durableWrite(marker,JSON.stringify(expected));
 const base='/var/lib/lightmoni-web-tmp';rootPath('/var/lib','directory');
 if(!existsSync(base)){mkdirSync(base,{mode:0o755});chmodSync(base,0o755);}rootPath(base,'directory');
 const temp=join(base,sha256(dataRoot).slice(0,20));
 for(const path of [temp,...['client-body','proxy','fastcgi','uwsgi','scgi'].map(name=>join(temp,name))]) {
   if(!existsSync(path)){mkdirSync(path,{mode:0o700});chownSync(path,uid,gid);chmodSync(path,0o700);}
   const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||stat.gid!==gid||stat.mode&0o077)refuse('unsafe_managed_web_temp');
 }
 return{nginxTempDir:temp,nginxWorker:{name:NAME,group:NAME}};
}
