// Disposable full HTTP/WebSocket/SSH fixture for the browser acceptance script.
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {once} from 'node:events';
import {DB} from '../../src/shared/sqlite.js';
import {Router} from '../../src/shared/http.js';
import {hash} from '../../src/shared/crypto.js';
import {Auth} from '../../src/server/auth.js';
import {registerManagedMachines} from '../../src/server/managed-machines.js';
import {registerMachineTerminal} from '../../src/server/machine-terminal.js';
import {isolatedSSHD} from './isolated-sshd.js';
import {passwordSSHServer} from './password-ssh-server.js';
import type {Dependencies} from '../../src/shared/types.js';
import type {TestContext} from 'node:test';

const cleanups:(()=>unknown)[]=[],passwordMode=process.env.LIGHTMONI_TERMINAL_AUTH==='password';
const cleanupContext={after:(fn:()=>unknown)=>cleanups.push(fn)} as TestContext;
const ssh=passwordMode?await passwordSSHServer(cleanupContext):await isolatedSSHD(cleanupContext);
const dir=await mkdtemp(join(tmpdir(),'lightmoni-terminal-browser-')),db=new DB(':memory:'),router=new Router();
const auth=new Auth(db,dir,'',router);auth.register();router.auth=auth;
db.run("INSERT INTO users(id,name,role,created_at) VALUES('qa-admin','QA Admin','admin',?)",new Date().toISOString());
db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hash('fixture-browser-login'),'qa-admin',Math.floor(Date.now()/1000)+3600);
db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
const deps={db,router,auth,encrypt:auth.encrypt,decrypt:auth.decrypt,now:()=>new Date(),externalURL:'',logger:{info(){},warn(){},error(){console.error('Fixture operation failed')}}} as Dependencies;
const machines=registerManagedMachines(deps),publicDir=resolve('public');
await machines.start?.();
for(const [path,value] of Object.entries({'/api/v1/catalog/tables':[],'/api/v1/dashboards':[],'/api/v1/assistant/config':{enabled:false,has_key:false}}))router.get(path,ctx=>ctx.json(value));
const server=createServer(async(req,res)=>{
 if(await router.handle(req,res))return;
 const path=new URL(req.url??'/','http://localhost').pathname;
 if(path.startsWith('/api/')){res.writeHead(404);res.end('{}');return;}
 const file=path.startsWith('/assets/')?resolve(publicDir,'.'+path):join(publicDir,'index.html');
 try{res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(file)]??'application/octet-stream');res.end(await readFile(file))}catch{res.writeHead(404);res.end()}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${(server.address() as any).port}`;deps.externalURL=router.externalURL=origin;
const terminal=registerMachineTerminal(deps,machines,server);
const request=async(path:string,body:unknown)=>{const res=await fetch(origin+'/api/v1'+path,{method:'POST',headers:{cookie:'lm_session=fixture-browser-login','content-type':'application/json',origin},body:JSON.stringify(body)});if(!res.ok)throw Error('Fixture setup failed');return res.json() as any};
const machine=await request('/machines',{name:'Terminal fixture',address:ssh.address,port:ssh.port,username:ssh.username,connection_method:'direct_ssh'});
await request(`/machines/${machine.id}/credentials`,passwordMode?{method:'password',secret:(ssh as Awaited<ReturnType<typeof passwordSSHServer>>).password,retention:'one_time'}:{method:'ssh_key',secret:(ssh as Awaited<ReturnType<typeof isolatedSSHD>>).privateKey,retention:'temporary'});
// A test-only seed route avoids sending generated fixture passwords through
// browser script arguments or reports. It never returns the secret.
if(passwordMode)router.post('/api/v1/fixtures/password-credential',async ctx=>{deps.auth.requireAdmin(ctx);ctx.json(await request(`/machines/${machine.id}/credentials`,{method:'password',secret:(ssh as Awaited<ReturnType<typeof passwordSSHServer>>).password,retention:'one_time'}));});
console.log(JSON.stringify({origin,machineID:machine.id}));
let stopped=false;
const close=async()=>{if(stopped)return;stopped=true;await terminal.close?.();await machines.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();await rm(dir,{recursive:true,force:true});for(const fn of [...cleanups].reverse())await fn();process.exit(0)};
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
