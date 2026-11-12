import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {TestContext} from 'node:test';
import {DB} from '../../src/shared/sqlite.js';
import {Router} from '../../src/shared/http.js';
import {hash} from '../../src/shared/crypto.js';
import {Auth} from '../../src/server/auth.js';
import {registerManagedMachines} from '../../src/server/managed-machines.js';
import {registerMachineFiles} from '../../src/server/machine-files.js';
import {isolatedSSHD} from './isolated-sshd.js';
import type {Dependencies} from '../../src/shared/types.js';
import {Client} from 'ssh2';

export async function hostFilesFixture(t:TestContext,limits:{idleMs?:number;maxMs?:number}={}){
 const ssh=await isolatedSSHD(t,{sftp:true}),directory=await realpath(await mkdtemp(join(tmpdir(),'lightmoni-files-')));
 await writeFile(join(directory,'配置 文件.txt'),'原始内容\n');
 const authDirectory=await mkdtemp(join(tmpdir(),'lightmoni-file-auth-'));
 const db=new DB(':memory:'),router=new Router(),auth=new Auth(db,authDirectory,'',router);auth.register();router.auth=auth;
 for(const role of ['admin','member']){db.run('INSERT INTO users(id,name,role,created_at) VALUES(?,?,?,?)',role,role,role,new Date().toISOString());db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hash(role),role,Math.floor(Date.now()/1000)+3600)}
 db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
 const deps={db,router,auth,encrypt:auth.encrypt,decrypt:auth.decrypt,now:()=>new Date(),externalURL:'',logger:{info(){},warn(){},error(){}}} as Dependencies;
 let sshConnections=0;
 const machines=registerManagedMachines(deps),files=registerMachineFiles(deps,machines,{...limits,createClient:()=>{sshConnections++;return new Client()}});
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end('{}')}});server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;deps.externalURL=router.externalURL=origin;
 const request=async(path:string,method='GET',body?:unknown,login='admin',extra:Record<string,string>={})=>{
  const raw=Buffer.isBuffer(body);const res=await fetch(origin+'/api/v1'+path,{method,headers:{cookie:'lm_session='+login,origin,'content-type':raw?'application/octet-stream':'application/json',...extra},body:body===undefined?undefined:raw?body:JSON.stringify(body)});const response=await res.text();return {status:res.status,data:response?JSON.parse(response) as any:{}};
 };
 const machine=(await request('/machines','POST',{name:'面板验收主机',address:ssh.address,port:ssh.port,connection_method:'direct_ssh'})).data;
 const account=(await request(`/machines/${machine.id}/accounts`,'POST',{username:ssh.username,make_default:true})).data;
 const credential=(await request(`/machines/${machine.id}/accounts/${account.id}/credentials`,'POST',{method:'ssh_key',secret:ssh.privateKey,retention:'temporary'})).data;
 const addCredential=()=>request(`/machines/${machine.id}/accounts/${account.id}/credentials`,'POST',{method:'password',secret:'unused alternate',retention:'temporary',make_default:false});
 const path=(operation:string,file=directory)=>`/machines/${machine.id}/${operation}?`+new URLSearchParams({path:file});
 t.after(async()=>{await files.close?.();await machines.close?.();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();await rm(directory,{recursive:true,force:true});await rm(authDirectory,{recursive:true,force:true})});
 return {directory,db,router,request,machine,account,credential,addCredential,path,origin,server,sshConnections:()=>sshConnections,closeFiles:()=>files.close?.()};
}
