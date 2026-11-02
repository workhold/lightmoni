import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createDemoServer} from './server.mjs';
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
