import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLightMoni, type FrozenBatch } from '../src/index.js';
import { copyMetricWindows, metricWindow } from '../src/windows.js';

test('period policies select one effective window per table with a 30 second default', () => {
  const before=1800000000n*1000000000n;
  const policies=copyMetricWindows({fast:[{seconds:10,effective_at:0},{seconds:60,effective_at:1800000000}],slow:[{seconds:300,effective_at:0}]});
  assert.equal(metricWindow(policies,'fast',before-1n).seconds,10);
  assert.equal(metricWindow(policies,'fast',before).seconds,60);
  assert.equal(metricWindow(policies,'slow',before).seconds,300);
  assert.equal(metricWindow(policies,'default',before).seconds,30);
});

test('remote seven-period configuration drives exported windows and invalid updates retain the last snapshot', async () => {
  let windows:unknown=Object.fromEntries([10,30,60,300,600,1800,3600].map(seconds=>['table_'+seconds,[{seconds,effective_at:0}]]));
  const server=createServer((req,res)=>{
    assert.equal(req.url,'/v1/sdk-config?metric_windows=1');
    assert.equal(req.headers.authorization,'Bearer windows');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({revision:'windows',log_sampling:{},disable_rules:[],metric_windows:windows}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const batches:FrozenBatch[]=[];
  const client=createLightMoni({service:'periods',env:'test',key:'windows',selfTelemetry:false,intervalMs:3600000,configEndpoint:`http://127.0.0.1:${address.port}`,configIntervalMs:3600000,exporter:{async deliver(batch){batches.push(batch);}}});
  try {
    await client.refreshConfig();
    for(const seconds of [10,30,60,300,600,1800,3600]) {
      client.record('table_'+seconds,'duration',{},10,1);
      client.record('table_'+seconds,'second_metric',{},20,1);
    }
    windows={table_10:[{seconds:20,effective_at:0}]};
    await assert.rejects(client.refreshConfig());
    client.record('table_10','duration',{},30,1);
    client.record('default_table','duration',{},40,1);
    await client.flush();
    let samples=0;
    for(const batch of batches) {
      const expected=batch.table==='default_table'?30:Number(batch.table.slice(6));
      const payload=JSON.parse(new TextDecoder().decode(batch.payload));
      for(const scope of payload.resourceMetrics[0].scopeMetrics)for(const metric of scope.metrics)for(const point of metric.exponentialHistogram.dataPoints) {
        assert.equal(point.attributes.find((a:{key:string})=>a.key==='lightmoni.window_seconds').value.intValue,String(expected));
        assert.equal(BigInt(point.startTimeUnixNano)%(BigInt(expected)*1000000000n),0n);
        samples+=Number(point.count);
      }
    }
    assert.equal(samples,16);assert.equal(client.stats().invalidRecords,0);
  } finally {await client.shutdown();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
