import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { AgentJobRunner, ORDINARY_JOB_CAPABILITIES } from "../src/agent/jobs.js";

test("Agent job runner reports an in-flight marker as unknown after restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-restart-"));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "agent-job-state.json"), JSON.stringify({ id: "job-1", lease_id: "lease-1", started_at: "2026-10-22T00:00:00.000Z" }));
  const calls: any[] = [];
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir }, {
    fetch: (async (url: any, init: any) => {
      calls.push({ url, init: JSON.parse(init.body) });
      return new Response(JSON.stringify({ state: "unknown" }), { status: 200 });
    }) as typeof fetch,
  });
  await runner.recoverUnknown();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.state, "unknown");
  assert.equal(calls[0].init.code, "unknown_execution_result");
  assert.equal(JSON.parse(readFileSync(join(dataDir, "agent-job-state.json"), "utf8")).id, undefined);
  assert.equal(existsSync(join(dataDir, "agent-job-state.json")), true);
});

test("ordinary Agent advertises only fixed read-only job capabilities", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-readonly-caps-"));
  t.after(() => rmSync(dataDir, {recursive:true,force:true}));
  let advertised: any;
  const runner = new AgentJobRunner({endpoint:"https://center",agentID:"agent",controlCredential:"ordinary-control",dataDir}, {
    fetch: (async (_url:any, init:RequestInit) => { advertised=JSON.parse(String(init.body)).capabilities; return Response.json({job:null}); }) as typeof fetch,
  });
  assert.equal(await runner.pollOnce(),null);
  assert.deepEqual(advertised,["health.systemd","health.http","health.tcp","systemd.probe"]);
  assert.equal(Object.isFrozen(ORDINARY_JOB_CAPABILITIES),true);
});

test("ordinary Agent rejects legacy write actions before payload download or host command", async t => {
  const cases = [
    {name:"artifact stage",cap:"artifact.stage",action:{kind:"stage_artifact",release_id:"private-release",sha256:"a".repeat(64),size:32}},
    {name:"artifact activate",cap:"artifact.activate_release",action:{kind:"activate_release",releaseDirectory:"/srv/app",version:"v2",expectedCurrentVersion:"v1"}},
    ...["daemon-reload","enable","disable","start","restart","stop"].map(operation => ({name:"systemd "+operation,cap:"systemd."+operation.replace("-","_"),action:{kind:"systemd",operation,unit:"app.service"}})),
    ...["website","certificate","compose","backup","platform"].map(domain => ({name:"operations "+domain,cap:"operations."+domain,action:{kind:"operations",domain,operation_id:"private-operation"}})),
    ...["start","stop","restart"].map(operation => ({name:"docker "+operation,cap:"docker.control",action:{kind:"docker",operation,container_id:"a".repeat(64)}})),
    {name:"write action spoofing read-only capability",cap:"health.http",action:{kind:"systemd",operation:"restart",unit:"app.service"}},
  ];
  for (const scenario of cases) await t.test(scenario.name,async sub => {
    const dataDir=mkdtempSync(join(tmpdir(),"lightmoni-write-denied-"));sub.after(()=>rmSync(dataDir,{recursive:true,force:true}));
    const requests:any[]=[],commands:any[]=[],payloadDownloads:any[]=[];
    const runner=new AgentJobRunner({endpoint:"https://center",agentID:"agent",controlCredential:"ordinary-control",dataDir},{
      command:async(file,args)=>{commands.push({file,args});throw Error("must not execute");},
      fetch:(async(url:any,init:RequestInit)=>{const path=String(url);requests.push({path,body:JSON.parse(String(init.body))});
        if(path.endsWith("/jobs/claim"))return Response.json({job:{id:"legacy-write",lease_id:"lease",expires_at:new Date(Date.now()+60000).toISOString(),capabilities:[scenario.cap],actions:[scenario.action]}});
        if(!path.endsWith("/result")){payloadDownloads.push(path);throw Error("must not download");}return Response.json({});}) as typeof fetch,
    });
    const receipt=await runner.pollOnce();assert.equal(receipt?.state,"failed");assert.equal(receipt?.code,"privileged_executor_required");assert.deepEqual(commands,[]);assert.deepEqual(payloadDownloads,[]);assert.equal(requests.length,2);assert.equal(requests[1].body.code,"privileged_executor_required");assert.deepEqual(JSON.parse(readFileSync(join(dataDir,"agent-job-state.json"),"utf8")),{});
  });
});

test("ordinary Agent refuses Docker inventory before contacting the privileged daemon",async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),"lightmoni-docker-inventory-"));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));const commands:any[]=[];
 const runner=new AgentJobRunner({endpoint:"https://center",agentID:"agent",controlCredential:"ordinary-control",dataDir},{command:async(file,args)=>{commands.push({file,args});return{stdout:"",stderr:""}},fetch:(async(url:any)=>String(url).endsWith("/jobs/claim")?Response.json({job:{id:"inventory",lease_id:"lease",expires_at:new Date(Date.now()+60000).toISOString(),capabilities:["docker.inventory"],actions:[{kind:"docker",operation:"inventory"}]}}):Response.json({})) as typeof fetch});
 const receipt=await runner.pollOnce();assert.equal(receipt?.state,"failed");assert.equal(receipt?.code,"privileged_executor_required");assert.deepEqual(commands,[]);
});

test("Agent startup never resumes cached legacy website gateway writes",async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),"lightmoni-no-legacy-recovery-"));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 // An unsafe cached website tree would trigger the old automatic recovery path.
 // The ordinary runner must ignore it and preserve it for explicit review.
 mkdirSync(join(dataDir,"operations"));writeFileSync(join(dataDir,"cached-gateway"),"private cached gateway");symlinkSync(join(dataDir,"cached-gateway"),join(dataDir,"operations","websites"));
 writeFileSync(join(dataDir,"agent-job-state.json"),JSON.stringify({id:"interrupted-write",lease_id:"old-lease",started_at:"2026-01-01T00:00:00Z"}));
 const events:any[]=[],requests:any[]=[];const signal=AbortSignal.abort();
 const runner=new AgentJobRunner({endpoint:"https://center",agentID:"agent",controlCredential:"ordinary-control",dataDir},{command:async()=>{throw Error("must not execute")},emit:e=>{events.push(e)},fetch:(async(url:any,init:RequestInit)=>{requests.push({url:String(url),body:JSON.parse(String(init.body))});return Response.json({});}) as typeof fetch});
 await runner.run(signal);assert.equal(requests.length,1);assert.equal(requests[0].body.state,"unknown");assert.deepEqual(events,[]);assert.equal(readFileSync(join(dataDir,"cached-gateway"),"utf8"),"private cached gateway");
});

test("Agent renews the active job lease while a long health check runs", async (t) => {
  let healthRequests = 0;
  const healthServer = createServer((_request, response) => {
    healthRequests++;
    setTimeout(() => { response.writeHead(200); response.end("ok"); }, 160);
  });
  healthServer.listen(0, "127.0.0.1");
  await once(healthServer, "listening");
  t.after(() => healthServer.close());
  const address = healthServer.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-heartbeat-"));
  const events: Array<{ sequence: number; phase: string }> = [];
  let leaseExpiresAt = Date.now() + 45;
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir, leaseHeartbeatIntervalMs: 10 }, {
    fetch: (async (url: any, init: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/jobs/claim")) return new Response(JSON.stringify({ job: {
        id: "job-heartbeat", lease_id: "lease-heartbeat", expires_at: new Date(Date.now() + 60_000).toISOString(),
        capabilities: ["health.http"], actions: [{ kind: "health_check", check: { kind: "http", url: `http://127.0.0.1:${address.port}/health`, timeoutMs: 5000 } }],
        target: { config: { release_directory: "/opt/service", unit: "service.service" } }, next_sequence: 0,
      } }), { status: 200 });
      if (target.endsWith("/events")) {
        const event = JSON.parse(String(init.body));
        assert.ok(Date.now() < leaseExpiresAt, "event arrived before the previous lease expired");
        assert.equal(event.sequence, events.length + 1);
        events.push({ sequence: event.sequence, phase: event.phase });
        leaseExpiresAt = Date.now() + 45;
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/result")) {
        assert.ok(Date.now() < leaseExpiresAt, "final receipt arrived within the renewed lease");
        return new Response("{}", { status: 200 });
      }
      throw Error(`unexpected request ${target}`);
    }) as typeof fetch,
  });
  const receipt = await runner.pollOnce();
  assert.equal(receipt?.state, "succeeded");
  assert.equal(healthRequests, 1);
  assert.ok(events.filter((event) => event.phase === "verifying").length >= 3);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
});

test("Agent stops a running host action when lease renewal fails", async (t) => {
  let healthClosed = false;
  let healthStarted = false;
  const healthServer = createServer((request, response) => {
    healthStarted = true;
    request.on("aborted", () => { healthClosed = true; });
    response.on("close", () => { if (!response.writableEnded) healthClosed = true; });
    // Keep the request active until the Agent aborts it after a failed renewal.
  });
  healthServer.listen(0, "127.0.0.1");
  await once(healthServer, "listening");
  t.after(() => healthServer.close());
  const address = healthServer.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), "lightmoni-job-heartbeat-fail-"));
  let eventCount = 0;
  let resultPosted = false;
  const runner = new AgentJobRunner({ endpoint: "http://center", agentID: "agent-1", controlCredential: "secret", dataDir, leaseHeartbeatIntervalMs: 10 }, {
    fetch: (async (url: any, init: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/jobs/claim")) return new Response(JSON.stringify({ job: {
        id: "job-heartbeat-fail", lease_id: "lease-heartbeat-fail", expires_at: new Date(Date.now() + 60_000).toISOString(),
        capabilities: ["health.http"], actions: [{ kind: "health_check", check: { kind: "http", url: `http://127.0.0.1:${address.port}/health`, timeoutMs: 5000 } }],
        target: { config: { release_directory: "/opt/service", unit: "service.service" } }, next_sequence: 0,
      } }), { status: 200 });
      if (target.endsWith("/events")) {
        eventCount++;
        const event = JSON.parse(String(init.body));
        if (event.phase === "verifying" && eventCount > 2 && healthStarted) return new Response(JSON.stringify({ error: "agent job lease expired" }), { status: 409 });
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/result")) { resultPosted = true; return new Response("{}", { status: 200 }); }
      throw Error(`unexpected request ${target}`);
    }) as typeof fetch,
  });
  await assert.rejects(() => runner.pollOnce());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(healthClosed, true, "the in-flight host health request was aborted");
  assert.equal(resultPosted, false, "a stale lease must not submit a final receipt");
});
