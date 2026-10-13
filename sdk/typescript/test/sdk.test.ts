import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLightMoni, withTrace, type FrozenBatch, type Exporter } from "../src/index.js";
import { extractTrace, injectTrace, type TraceContext } from "../src/core.js";
import { createLightMoni as createBrowserClient } from "../src/browser.js";

const decode = (batch: FrozenBatch) => JSON.parse(new TextDecoder().decode(batch.payload));
function captured() {
  const batches: FrozenBatch[] = [];
  const exporter: Exporter = { async deliver(batch) { batches.push({ ...batch, payload: batch.payload.slice() }); } };
  return { batches, exporter };
}

test("complete dimensions, attribute types, Gauge, Histogram and trace context", async () => {
  const { batches, exporter } = captured(); const mon = createLightMoni({ selfTelemetry: false, service: "test", table: "http", exporter, intervalMs: 60_000 });
  try {
    const requests = mon.counter("requests"), gauge = mon.gauge("active"), hist = mon.histogram("duration", { boundaries: [1, 2], unit: "ms" });
    const attrs = { route: "/pay", status: 200, method: "POST" }; requests.add(3, attrs); attrs.route = "/mutated";
    requests.add(2, { method: "POST", status: 200, route: "/pay" }); requests.add(1, { method: "POST", status: "200", route: "/pay" });
    gauge.record(1); gauge.record(3); for (const value of [-1, 1, 1.5, 3]) hist.record(value);
    const span = mon.withTable("app").startSpan("pay"); await withTrace(span.context, async () => { await Promise.resolve(); mon.withTable("app").log("info", "complete"); }); span.end(); span.end();
    assert.deepEqual(extractTrace(injectTrace(span.context)), { ...span.context, traceState: undefined });
    await mon.flush();
    const metrics = batches.filter(b => b.signal === "metrics").flatMap(b => decode(b).resourceMetrics[0].scopeMetrics[0].metrics);
    const count = metrics.find(m => m.name === "requests").sum; assert.equal(count.aggregationTemporality, 1); assert.equal(count.dataPoints.length, 2); assert.equal(count.dataPoints.reduce((n: bigint, p: { asInt: string }) => n + BigInt(p.asInt), 0n), 6n);
    assert.equal(metrics.find(m => m.name === "active").gauge.dataPoints[0].asDouble, 3);
    const histogram = metrics.find(m => m.name === "duration").histogram.dataPoints[0]; assert.deepEqual(histogram.bucketCounts, ["2", "1", "1"]); assert.equal(histogram.count, "4"); assert.equal(histogram.sum, 4.5);
    const log = decode(batches.find(b => b.signal === "logs")!).resourceLogs[0].scopeLogs[0].logRecords[0]; assert.equal(log.traceId, span.context.traceId); assert.equal(log.spanId, span.context.spanId);
    assert.equal(batches.filter(b => b.signal === "traces").length, 1);
  } finally { await mon.shutdown(); }
});

test("optional log trace metadata follows scoped context and explicit overrides", async () => {
  const { batches, exporter } = captured();
  const mon = createLightMoni({ selfTelemetry: false, service: "test", table: "http", exporter, intervalMs: 60_000 });
  const trace: TraceContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), flags: 0 };
  const explicit: TraceContext = { traceId: "c".repeat(32), spanId: "d".repeat(16), flags: 1 };
  try {
    const app = mon.withTable("app");
    app.log("info", "without trace", { trace_id: "attribute-only" });
    await withTrace(trace, async () => {
      await Promise.resolve();
      app.log("info", "with trace");
      app.log("info", "explicit trace", {}, explicit);
    });
    app.log("info", "after trace");
    await mon.flush();
    assert.ok(batches.every(b => b.signal === "logs" && b.table === "app"));
    const logs = batches.flatMap(b => decode(b).resourceLogs[0].scopeLogs[0].logRecords);
    assert.equal(logs.length, 4);
    const byBody = new Map(logs.map(log => [log.body.stringValue, log]));
    for (const body of ["without trace", "after trace"]) {
      const log = byBody.get(body)!;
      assert.equal(log.traceId, undefined); assert.equal(log.spanId, undefined); assert.equal(log.flags, undefined);
    }
    assert.deepEqual(byBody.get("without trace")!.attributes.find((a: { key: string }) => a.key === "trace_id"), { key: "trace_id", value: { stringValue: "attribute-only" } });
    for (const [body, expected] of [["with trace", trace], ["explicit trace", explicit]] as const) {
      const log = byBody.get(body)!;
      assert.equal(log.traceId, expected.traceId); assert.equal(log.spanId, expected.spanId); assert.equal(log.flags, expected.flags);
    }
    assert.equal(mon.stats().invalidRecords, 0);
  } finally { await mon.shutdown(); }
});

test("browser contextProvider captures optional trace metadata before export", async () => {
  const { batches, exporter } = captured();
  let current: TraceContext | undefined;
  const mon = createBrowserClient({ selfTelemetry: false, service: "web", table: "web", exporter, intervalMs: 60_000, contextProvider: () => current });
  const trace: TraceContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), flags: 1 };
  try {
    mon.log("info", "without trace");
    current = trace;
    mon.withTable("app").log("info", "with trace");
    current = undefined;
    mon.withTable("app").log("info", "after trace");
    await mon.flush();
    const logs = batches.flatMap(b => decode(b).resourceLogs[0].scopeLogs[0].logRecords);
    assert.equal(logs.length, 3);
    for (const log of logs) {
      assert.equal(log.traceId, log.body.stringValue === "with trace" ? trace.traceId : undefined);
      assert.equal(log.spanId, log.body.stringValue === "with trace" ? trace.spanId : undefined);
    }
    assert.ok(batches.every(b => b.signal === "logs"));
  } finally { await mon.shutdown(); }
});

test("ACK loss retries identical frozen batch while new window remains independent", async () => {
  const calls: FrozenBatch[] = []; const unique = new Map<string, FrozenBatch>(); let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => began = resolve), accepted = new Promise<void>(resolve => release = resolve);
  const exporter: Exporter = { async deliver(batch) { calls.push(batch); unique.set(batch.id, batch); if (calls.length === 1) { began(); await accepted; throw new Error("ACK lost"); } } };
  const mon = createLightMoni({ selfTelemetry: false, service: "test", table: "http", exporter, intervalMs: 60_000, retryMinMs: 1, retryMaxMs: 2 });
  try {
    const count = mon.counter("requests"); count.add(7); const firstFlush = mon.flush(); await started; count.add(3); release(); await firstFlush; await mon.flush();
    assert.equal(calls.length, 3); assert.equal(calls[0].id, calls[1].id); assert.equal(calls[0].createdAt, calls[1].createdAt); assert.deepEqual(calls[0].payload, calls[1].payload); assert.notEqual(calls[0].id, calls[2].id);
    const total = [...unique.values()].reduce((sum, b) => sum + BigInt(decode(b).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt), 0n); assert.equal(total, 10n);
  } finally { await mon.shutdown(); }
});

test("cardinality overflow preserves total; SDK queue loss is visible", async () => {
  const { batches, exporter } = captured(); const mon = createLightMoni({ selfTelemetry: false, service: "test", table: "http", exporter, cardinalityLimit: 2 });
  try { const count = mon.counter("requests"); for (let i = 0; i < 5; i++) count.add(2, { route: i }); await mon.flush(); const points = decode(batches[0]).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints; assert.equal(points.reduce((n: bigint, p: { asInt: string }) => n + BigInt(p.asInt), 0n), 10n); assert.equal(mon.stats().overflowRecords, 3); } finally { await mon.shutdown(); }
  let release!: () => void; const waiting = new Promise<void>(resolve => release = resolve);
  const limited = createLightMoni({ selfTelemetry: false, service: "test", table: "http", queueBatches: 1, exporter: { async deliver() { await waiting; } } });
  const count = limited.counter("requests"); count.add(1); await assert.rejects(limited.flush({ timeoutMs: 5 }), /timeout/); limited.withTable("app").log("info", "full"); await assert.rejects(limited.flush({ timeoutMs: 5 }), /timeout/); assert.equal(limited.stats().pendingBatches, 1); assert.equal(limited.stats().droppedRecords, 1); release(); await assert.rejects(limited.shutdown(), /capacity/);
});

test("HTTP authentication can rotate global Key without losing frozen data", async () => {
  const ids: string[] = [];
  const server = createServer((req, res) => { ids.push(String(req.headers["x-lightmoni-batch-id"])); req.resume(); if (req.headers.authorization !== "Bearer new-global-key") { res.writeHead(401); res.end(); return; } assert.equal(req.headers["x-lightmoni-table"], "http"); assert.ok(req.headers["x-lightmoni-batch-created-at"]); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const mon = createLightMoni({ selfTelemetry: false, service: "test", table: "http", endpoint: `http://127.0.0.1:${address.port}`, key: "old-global-key" });
  try { mon.counter("requests").add(1); await assert.rejects(mon.flush({ timeoutMs: 40 }), /timeout/); mon.updateKey("new-global-key"); await mon.flush({ timeoutMs: 1000 }); assert.ok(ids.length >= 2); assert.equal(ids[0], ids[ids.length - 1]); } finally { await mon.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("OTLP partial success is not retried or silently reported delivered", async () => {
  let calls = 0; const server = createServer((req, res) => { calls++; req.resume(); res.setHeader("Content-Type", "application/json"); res.end('{"partialSuccess":{"rejectedDataPoints":"1"}}'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const mon = createLightMoni({ selfTelemetry: false, service: "test", table: "http", endpoint: `http://127.0.0.1:${address.port}` });
  try { mon.counter("requests").add(1); await assert.rejects(mon.flush(), /partial/); assert.equal(calls, 1); assert.equal(mon.stats().rejectedRecords, 1); assert.equal(mon.stats().retriedBatches, 0); } finally { await assert.rejects(mon.shutdown(), /partial/); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('idle SDK emits a heartbeat without business records or flush', async () => {
  const {batches,exporter}=captured();
  const mon=createLightMoni({service:'idle',table:'business',exporter,intervalMs:3_600_000});
  try {
    await new Promise(resolve=>setTimeout(resolve,31_000));
    const metrics=batches.filter(b=>b.signal==='metrics').flatMap(b=>JSON.parse(new TextDecoder().decode(b.payload)).resourceMetrics.flatMap((r:any)=>r.scopeMetrics.flatMap((s:any)=>s.metrics)));
    const heartbeat=metrics.find((m:any)=>m.name==='lightmoni.sdk.heartbeat');
    assert.equal(heartbeat?.gauge.dataPoints[0].asDouble,1);
    assert.ok(batches.every(b=>b.table==='business'));
    assert.equal(batches.filter(b=>b.signal==='logs').length,1);
  } finally { await mon.shutdown(); }
});

test('log whitelist, explicit UID exclusion, typed VIP and metrics stay complete',async()=>{
 const {batches,exporter}=captured();
 const policy={key:'attr:user_id',rules:[{name:'click',rate:0.1,conditions:[{field:'attr:event',operator:'in' as const,values:['click']}]},{name:'QA',rate:1,conditions:[{field:'attr:user_id',operator:'in' as const,values:['qa']}]},{name:'VIP',rate:1,conditions:[{field:'attr:is_vip',operator:'in' as const,values:[true]}]}],exclude:[{name:'blocked',conditions:[{field:'attr:user_id',operator:'in' as const,values:['blocked']}]}]};
 const mon=createLightMoni({service:'rules',table:'web',exporter,selfTelemetry:false,logSampling:{web:policy}});
 try{
  const counter=mon.counter('requests');counter.add(20,{user_id:'blocked'});const span=mon.startSpan('request',{user_id:'blocked'});span.end();
  mon.log('info','qa',{user_id:'qa',event:'click'});mon.log('info','vip',{is_vip:true});mon.log('error','blocked VIP',{user_id:'blocked',is_vip:true});mon.log('info','string VIP',{is_vip:'true'});mon.log('error','unmatched');
  policy.rules[1].rate=0; // caller mutation must not change the copied rules.
  mon.log('info','still QA',{user_id:'qa'});await mon.flush();
  const logs=batches.filter(b=>b.signal==='logs').flatMap(b=>decode(b).resourceLogs[0].scopeLogs[0].logRecords);
  assert.deepEqual(logs.map(r=>r.body.stringValue),['qa','vip','still QA']);assert.equal(mon.stats().excludedLogs,1);assert.equal(mon.stats().unmatchedLogs,2);assert.equal(mon.stats().droppedRecords,0);
  assert.equal(decode(batches.find(b=>b.signal==='metrics')!).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt,'20');assert.equal(batches.filter(b=>b.signal==='traces').length,1);
  mon.updateLogSampling({web:{rules:[]}});mon.log('info','no matching rule',{user_id:'qa'});await mon.flush();assert.equal(mon.stats().unmatchedLogs,3);
 }finally{await mon.shutdown();}
});

test('dynamic SDK shutdown clears buffered data, stops all signals and resumes through config polling',async()=>{
 const {batches,exporter}=captured();let revision='v1',disable=false,invalid=false;
 const server=createServer((req,res)=>{assert.equal(req.url,'/v1/sdk-config');assert.equal(req.headers.authorization,'Bearer key');res.setHeader('Content-Type','application/json');res.end(invalid?'{}':JSON.stringify({revision,log_sampling:{},disable_rules:disable?[{name:'instance',conditions:[{field:'instance_id',operator:'in',values:['one']}]}]:[]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const mon=createLightMoni({service:'stop',table:'web',instanceId:'one',selfTelemetry:false,exporter,key:'key',configEndpoint:`http://127.0.0.1:${address.port}`,configIntervalMs:1000});
 try{
  const counter=mon.counter('requests');counter.add(10);mon.log('info','buffered');disable=true;revision='v2';await mon.refreshConfig();
  counter.add(100);mon.log('info','disabled');mon.startSpan('disabled').end();await mon.flush();assert.equal(batches.length,0);assert.equal(mon.stats().bufferBytes,0);assert.equal(mon.stats().reportingDisabled,true);
  invalid=true;await assert.rejects(mon.refreshConfig());assert.equal(mon.stats().reportingDisabled,true);
  invalid=false;disable=false;revision='v3';const until=Date.now()+4000;while(mon.stats().configRevision!=='v3'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(mon.stats().reportingDisabled,false);
  counter.add(3);mon.log('info','resumed');await mon.flush();assert.equal(batches.length,2);assert.equal(decode(batches.find(b=>b.signal==='metrics')!).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt,'3');
 }finally{await mon.shutdown();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('stable UID cohorts agree across event changes and frozen retries survive rule updates',async()=>{
 const {sampleLog,copyLogSampling}=await import('../src/sampling.js');
 const policy=copyLogSampling({key:'attr:user_id',rules:[{name:'all',rate:0.1,conditions:[]}]});let kept=0;
 for(let i=0;i<10000;i++){const base={record:{event_id:'a'},attributes:{user_id:String(i)},resource:{}};const a=sampleLog(policy,'web',base);base.record.event_id='b';assert.equal(sampleLog(policy,'web',base).keep,a.keep);if(a.keep)kept++;}assert.ok(kept>700&&kept<1300);
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),waiting=new Promise<void>(r=>release=r),calls:FrozenBatch[]=[];
 const mon=createLightMoni({service:'retry',table:'web',selfTelemetry:false,retryMinMs:1,retryMaxMs:2,exporter:{async deliver(b){calls.push({...b,payload:b.payload.slice()});if(calls.length===1){began();await waiting;throw new Error('ACK lost');}}}});
 try{mon.log('info','before policy');const flush=mon.flush();await started;mon.updateLogSampling({web:{rules:[]}});mon.log('info','ignored new event');release();await flush;await mon.flush();assert.equal(calls.length,2);assert.equal(calls[0].id,calls[1].id);assert.deepEqual(calls[0].payload,calls[1].payload);}finally{await mon.shutdown();}
});

test('whole SDK stop cancels frozen sends and suppresses spans that cross a stopped period',async()=>{
 let began!:()=>void;const started=new Promise<void>(r=>began=r),delivered:FrozenBatch[]=[];let calls=0;
 const mon=createLightMoni({service:'cancel',table:'web',selfTelemetry:false,exporter:{async deliver(b,signal){calls++;if(calls===1){began();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw new Error('cancelled');}delivered.push(b);}}});
 try{const old=mon.startSpan('before');mon.log('info','frozen');const flush=mon.flush();await started;mon.setReportingEnabled(false);await flush;const stopped=mon.startSpan('during');mon.setReportingEnabled(true);old.end();stopped.end();mon.log('info','new');await mon.flush();assert.equal(delivered.length,1);assert.equal(delivered[0].signal,'logs');assert.equal(mon.stats().pendingBatches,0);}finally{await mon.shutdown();}
});
