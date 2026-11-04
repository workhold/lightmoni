import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createDemoServer} from './server.mjs';
import {createLightMoni} from '../../sdk/typescript/dist/src/index.js';
test('live demo health, requests, assets and errors reflect the running process',async t=>{
 const server=createDemoServer({version:'test-build'});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>server.close(done)));
 const base='http://127.0.0.1:'+server.address().port;
 assert.deepEqual(await(await fetch(base+'/healthz')).json(),{status:'ok',service:'abc-demo'});
 const before=await(await fetch(base+'/api/status')).json();assert.equal(before.version,'test-build');
 const ping=await fetch(base+'/api/ping',{method:'POST'});assert.equal(ping.status,200);assert.match((await ping.json()).id,/^[a-f0-9-]{36}$/);
 const after=await(await fetch(base+'/api/status')).json();assert.equal(after.pings,1);assert.ok(after.requests>before.requests);
 const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await page.text(),/\/app.js/);
 for(const asset of ['/app.js','/style.css'])assert.equal((await fetch(base+asset)).status,200);
 assert.equal((await fetch(base+'/missing')).status,404);
 assert.equal((await fetch(base+'/api/ping',{method:'POST',body:'x'.repeat(1025)})).status,413);
});
test('real SDK receives request metrics and logs without request secrets',async t=>{
 const batches=[],telemetry=createLightMoni({service:'abc-test',table:'abc',endpoint:'http://127.0.0.1:1',selfTelemetry:false,remoteConfig:false,intervalMs:60000,exporter:{deliver:async b=>{batches.push({signal:b.signal,message:JSON.parse(new TextDecoder().decode(b.payload))})}}});
 const server=createDemoServer({telemetry});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(done=>server.close(done));await telemetry.shutdown({timeoutMs:1000})});
 await fetch('http://127.0.0.1:'+server.address().port+'/missing?secret=never-copy',{headers:{Authorization:'Bearer never-copy'}});
 await telemetry.flush({timeoutMs:1000});
 assert(batches.some(b=>b.signal==='logs'));assert(batches.some(b=>b.signal==='metrics'));
 const raw=JSON.stringify(batches);assert.match(raw,/http.server.requests/);assert.match(raw,/http.server.duration/);assert.match(raw,/http_request/);assert.doesNotMatch(raw,/never-copy/);
});
