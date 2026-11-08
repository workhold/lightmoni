import type {TestContext} from 'node:test';
import {hostFilesFixture} from './host-files-fixture.js';
const cleanups:Array<()=>unknown>=[];
const fixture=await hostFilesFixture({after:(fn:()=>unknown)=>cleanups.push(fn)} as TestContext);
const now=new Date().toISOString();
for(const [path,value] of Object.entries({'/api/v1/catalog/tables':[],'/api/v1/dashboards':[],'/api/v1/agents':[],'/api/v1/host-labels':[],'/api/v1/assistant/config':{enabled:false,has_key:false}}))fixture.router.get(path,ctx=>ctx.json(value));
fixture.router.get('/api/v1/ops/inventory',ctx=>ctx.json({hosts:[{id:fixture.machine.id,online:true,state:'ready',error:'',observed_at:now,truncated:false,active_job:'',docker_capabilities:[],containers:[{id:'a'.repeat(64),name:'production-web',image:'nginx:1.28',state:'running',ports:'0.0.0.0:8080->80/tcp',application_id:'app'},{id:'b'.repeat(64),name:'external-stopped',image:'redis:7.4',state:'exited',ports:'',application_id:''}]}],applications:[]}));
fixture.router.post('/api/v1/fixtures/remote-change',async ctx=>{const {writeFile}=await import('node:fs/promises');await writeFile(fixture.directory+'/配置 文件.txt','远端已变更\n');ctx.json({ok:true})});
console.log(JSON.stringify({origin:fixture.origin,machineID:fixture.machine.id,directory:fixture.directory}));
let stopped=false;
async function close(){if(stopped)return;stopped=true;for(const fn of cleanups.reverse())await fn();process.exit(0)}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
