import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {checkReadiness} from '../src/operations/platform.js';
import {workloadContainersReady} from '../src/operations/workload-readiness.js';
import type {OperationExecutionContext} from '../src/operations/types.js';

test('HTTP readiness checks explicit statuses, does not follow redirects, and bounds a stalled service',async t=>{
 let status=200,requests=0,stall=false;
 const server=createServer((_req,res)=>{requests++;if(stall)return;res.writeHead(status,{location:'/ready'});res.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.close();server.closeAllConnections();});
 const context={signal:new AbortController().signal} as OperationExecutionContext;
 const config={health:{type:'http',host:'127.0.0.1',port:(server.address() as any).port,path:'/ready',timeout_seconds:1,expected_statuses:[200,204]}};
 assert.equal(await checkReadiness(config,context),true);
 status=204;assert.equal(await checkReadiness(config,context),true);
 status=503;assert.equal(await checkReadiness(config,context),false);
 status=302;const before=requests;assert.equal(await checkReadiness(config,context),false);assert.equal(requests,before+1);
 stall=true;const start=Date.now();assert.equal(await checkReadiness(config,context),false);assert.ok(Date.now()-start<2500);
 await assert.rejects(()=>checkReadiness({health:{...config.health,path:'//other/ready'}},context),/INVALID_HEALTH_PATH/);
});

test('HTTP readiness defaults to any 2xx/3xx so redirecting services stay healthy',async t=>{
 let status=302;
 const server=createServer((_req,res)=>{res.writeHead(status,{location:'https://service.test/ready'});res.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.close();server.closeAllConnections();});
 const context={signal:new AbortController().signal} as OperationExecutionContext;
 const health={type:'http',host:'127.0.0.1',port:(server.address() as any).port,path:'/ready',timeout_seconds:1};
 assert.equal(await checkReadiness({health},context),true,'302 redirect proves the service lives');
 status=204;assert.equal(await checkReadiness({health},context),true);
 status=404;assert.equal(await checkReadiness({health},context),false);
 status=500;assert.equal(await checkReadiness({health},context),false);
 status=302;assert.equal(await checkReadiness({health:{...health,expected_statuses:[302]}},context),true,'explicit lists still win');
 assert.equal(await checkReadiness({health:{...health,expected_statuses:[200]}},context),false);
 await assert.rejects(()=>checkReadiness({health:{...health,expected_statuses:[200,200]}},context),/INVALID_HEALTH_STATUSES/);
});

test('custom readiness overrides Docker HEALTHCHECK but still requires running services and successful init',()=>{
 const running={State:{Running:true,Health:{Status:'unhealthy'}},Config:{Labels:{'com.docker.compose.service':'web'}}};
 assert.equal(workloadContainersReady([running],1,{web:{}}),false);
 assert.equal(workloadContainersReady([running],1,{web:{}},false),true);
 assert.equal(workloadContainersReady([{...running,State:{Running:false}}],1,{web:{}},false),false);
 assert.equal(workloadContainersReady([],1,{web:{}},false),false);
 assert.equal(workloadContainersReady([{State:{Running:true}}],1),true);
});
