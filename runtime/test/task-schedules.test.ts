import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { normalizeTask } from "../src/server/nodes-model.js";
import { TaskRunStore, registerTaskCenter } from "../src/server/task-center.js";
import { normalizeTaskSchedule, nextTaskDates, normalizeTaskPolicy } from "../src/server/task-schedule.js";
import { SCRIPT_TASK_CAPABILITY } from "../src/shared/task-center.js";

const capabilities = [SCRIPT_TASK_CAPABILITY];
function fixture() {
  const db = new DB(":memory:"), router = new Router(), user = {id:"admin",name:"Admin",role:"admin"};
  let clock = new Date("2026-10-30T00:00:00Z");
  const deps = {db,router,now:()=>clock,auth:{user:()=>user,requireAdmin(c:any){if(c.user.role!=="admin")fail(403,"admin");}},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  router.auth = deps.auth;
  const store = registerTaskCenter(deps);
  for(const id of ["one","two"]) db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)",id,id,id+".example.test","agent-"+id,clock.toISOString(),clock.toISOString());
  const task = (id="task", extra:any={}) => store.nodes.task({name:"Backup",type:"script",enabled:true,target_all:false,host_ids:["one"],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:"console.log('backup')",timeout_seconds:5,max_output_bytes:1024},...extra},id,true);
  const finish = (run:any, extra:any={}) => store.result(run.agent_id,run.id,{lease_token:run.lease_token,state:"succeeded",code:"",summary:"done",stdout:"",stderr:"",exit_code:0,...extra});
  return {db,router,user,store,deps,task,finish,now:()=>clock,advance(s:number){clock=new Date(clock.getTime()+s*1000);},close(){store.close();db.close();}};
}

test("schedule and policy schemas reject ambiguous or irrelevant fields and normalize zoned instants",()=>{
  assert.deepEqual(normalizeTaskSchedule({mode:"at",run_at:"2026-10-31T02:00:00+08:00"},"script"),{mode:"at",run_at:"2026-10-30T18:00:00.000Z"});
  for(const schedule of [{mode:"at",run_at:"2026-02-30T02:00:00Z"},{mode:"at",run_at:"2026-10-31T02:00:00"},{mode:"once",interval_seconds:10},{mode:"cron",cron:"0 0 2 * * *",timezone:"UTC"},{mode:"cron",cron:"0 2 * * *",timezone:"No/Such_Zone"},{mode:"cron",cron:"H 2 * * *",timezone:"UTC"}]) assert.throws(()=>normalizeTaskSchedule(schedule,"script"));
  assert.throws(()=>normalizeTaskSchedule({mode:"interval",interval_seconds:10},"host"));
  assert.throws(()=>normalizeTaskPolicy({retry_count:4}));
  assert.throws(()=>normalizeTaskPolicy({environment:{SECRET:"no"}}));
  assert.deepEqual(normalizeTaskPolicy(undefined),{max_concurrency:10,queue_timeout_seconds:3600,retry_count:0,retry_delay_seconds:60});
  assert.throws(()=>normalizeTask({name:"Metrics",type:"host",enabled:false,execution_policy:{}}),/持续采集/);
});

test("calendar preview uses IANA timezone and fixed parser DST rules without duplicate fall-back slots",()=>{
  const daily=normalizeTaskSchedule({mode:"cron",cron:"0 2 * * *",timezone:"Asia/Shanghai"},"script");
  assert.deepEqual(nextTaskDates(daily,new Date("2026-10-30T00:00:00Z"),2),["2026-10-30T18:00:00.000Z","2026-10-31T18:00:00.000Z"]);
  const spring=normalizeTaskSchedule({mode:"cron",cron:"0 2 * * *",timezone:"America/New_York"},"script");
  assert.deepEqual(nextTaskDates(spring,new Date("2026-03-07T08:00:00Z"),2),["2026-03-08T07:00:00.000Z","2026-03-09T06:00:00.000Z"]);
  const fall=normalizeTaskSchedule({mode:"cron",cron:"30 1 * * *",timezone:"America/New_York"},"script");
  assert.deepEqual(nextTaskDates(fall,new Date("2026-10-31T08:00:00Z"),2),["2026-11-01T05:30:00.000Z","2026-11-02T06:30:00.000Z"]);
  const leap=normalizeTaskSchedule({mode:"cron",cron:"0 0 29 2 *",timezone:"UTC"},"script");
  assert.deepEqual(nextTaskDates(leap,new Date("2026-10-30T00:00:00Z")).map(v=>v.slice(0,10)),["2028-02-29","2032-02-29","2036-02-29","2040-02-29","2044-02-29"]);
});

test("one-time scheduling consumes once across restart, edits and disable/enable",()=>{
  const f=fixture();try{
    const schedule={mode:"at",run_at:"2026-10-30T00:01:00Z"};
    f.task("backup",{schedule});f.store.tick();f.advance(60);f.store.tick();
    assert.equal(f.store.list().length,1);assert.equal(f.store.list()[0].trigger,"schedule");
    f.store.cancel(f.store.list()[0].id,"admin");
    let task=f.store.nodes.getTask("backup");f.store.nodes.task({...task,enabled:false},task.id,false);
    task=f.store.nodes.getTask("backup");f.store.nodes.task({...task,name:"Renamed",enabled:true},task.id,false);
    const restarted=new TaskRunStore(f.deps);f.advance(60);restarted.tick();assert.equal(restarted.list().length,1);
    assert.equal(f.db.get<any>("SELECT outcome FROM task_schedule_consumptions WHERE task_id='backup'")!.outcome,"dispatched");
    assert.throws(()=>f.task("past",{schedule}),/晚于当前/);
    task=f.store.nodes.getTask("backup");assert.throws(()=>f.store.nodes.task({...task,schedule:{mode:"at",run_at:"2026-10-30T00:00:30Z"}},task.id,false),/晚于当前/);
    f.store.nodes.task({...task,schedule:{mode:"at",run_at:"2026-10-30T00:03:00Z"}},task.id,false);restarted.tick();f.advance(60);restarted.tick();assert.equal(restarted.list().length,2);
  }finally{f.close();}
});

test("a near-future at intent is registered at save and executes on the normal next scan",()=>{
  for(const firstScan of [true,false]) {
    const f=fixture();try{
      if(!firstScan)f.store.tick();
      f.task("soon",{schedule:{mode:"at",run_at:"2026-10-30T00:00:02Z"}});f.advance(5);f.store.tick();
      assert.equal(f.store.list({task_id:"soon"}).length,1);
    }finally{f.close();}
  }
});

test("missed one-time and recurring slots are not replayed after restart or a long pause",()=>{
  const f=fixture();try{
    f.task("at",{schedule:{mode:"at",run_at:"2026-10-30T00:01:00Z"}});
    f.task("interval",{schedule:{mode:"interval",interval_seconds:60}});f.store.tick();f.advance(61);
    const restarted=new TaskRunStore(f.deps);restarted.tick();assert.equal(restarted.list().length,0);
    assert.equal(f.db.get<any>("SELECT outcome FROM task_schedule_consumptions WHERE task_id='at'")!.outcome,"missed");
    f.advance(60);restarted.tick();assert.equal(restarted.list({task_id:"interval"}).length,1);
    restarted.cancel(restarted.list()[0].id,"admin");f.advance(600);restarted.tick();assert.equal(restarted.list({task_id:"interval"}).length,1);
  }finally{f.close();}
});

test("cron dispatch follows the previewed slot and does not dispatch after switching to manual",()=>{
  const f=fixture();try{
    const task=f.task("calendar",{schedule:{mode:"cron",cron:"1 8 * * *",timezone:"Asia/Shanghai"}});
    assert.equal(nextTaskDates(task.schedule,f.now(),1)[0],"2026-10-30T00:01:00.000Z");
    f.store.tick();f.advance(60);f.store.tick();assert.equal(f.store.list().length,1);
    f.store.cancel(f.store.list()[0].id,"admin");const current=f.store.nodes.getTask(task.id);
    f.store.nodes.task({...current,schedule:{mode:"once"}},task.id,false);f.advance(86400);f.store.tick();assert.equal(f.store.list().length,1);
  }finally{f.close();}
});

test("policy limits concurrent hosts and expires queued work using its frozen deadline",()=>{
  const f=fixture();try{
    f.task("bounded",{host_ids:["one","two"],execution_policy:{max_concurrency:1,queue_timeout_seconds:10}});
    f.store.dispatch("bounded",{confirm:true},"admin");const first=f.store.claim("agent-one",capabilities)!;
    assert.ok(first);assert.equal(f.store.claim("agent-two",capabilities),null);
    f.advance(11);assert.equal(f.store.list({host_id:"two"})[0].code,"queue_expired");assert.equal(f.store.claim("agent-two",capabilities),null);
    f.finish(first);assert.equal(f.store.list().length,2);
    f.task("parallel",{host_ids:["one","two"],execution_policy:{max_concurrency:1}});f.store.dispatch("parallel",{confirm:true},"admin");
    const a=f.store.claim("agent-one",capabilities)!;assert.equal(f.store.claim("agent-two",capabilities),null);f.finish(a);assert.ok(f.store.claim("agent-two",capabilities));
  }finally{f.close();}
});

test("automatic retries are delayed, bounded, linked and use the original reviewed snapshot",()=>{
  const f=fixture();try{
    f.task("retryable",{execution_policy:{retry_count:1,retry_delay_seconds:10}});f.store.dispatch("retryable",{confirm:true},"admin");
    const first=f.store.claim("agent-one",capabilities)!;f.finish(first,{state:"failed",code:"script_failed",exit_code:1});
    f.store.tick();f.advance(9);f.store.tick();assert.equal(f.store.list().length,1);
    f.advance(1);f.store.tick();const retry=f.store.list().find(r=>r.retry_of===first.id)!;
    assert.ok(retry);assert.equal(retry.automatic_attempt,1);assert.deepEqual(retry.snapshot,first.snapshot);
    assert.equal(f.store.get(first.id).superseded_by,retry.id);
    const second=f.store.claim("agent-one",capabilities)!;f.finish(second,{state:"failed",code:"script_failed",exit_code:2});f.advance(10);f.store.tick();f.store.tick();assert.equal(f.store.list().length,2);
  }finally{f.close();}
});

test("automatic retry stops after edits, target/binding changes, cancellation or uncertain outcomes",()=>{
  for(const change of ["edit","disable","target","binding","unknown","control_lost","cancel"]) {
    const f=fixture();try{
      f.task("retryable",{execution_policy:{retry_count:2,retry_delay_seconds:10}});f.store.dispatch("retryable",{confirm:true},"admin");
      const first=f.store.claim("agent-one",capabilities)!;
      if(change==="cancel")f.store.cancel(first.id,"admin");
      f.finish(first,{state:change==="unknown"?"unknown":change==="cancel"?"cancelled":"failed",code:change==="control_lost"?"control_lost":change==="cancel"?"cancel_requested":"script_failed",exit_code:1});
      const task=f.store.nodes.getTask("retryable");
      if(change==="edit")f.store.nodes.task({...task,script:{...task.script,code:"changed"}},task.id,false);
      if(change==="disable")f.store.nodes.task({...task,enabled:false},task.id,false);
      if(change==="target")f.store.nodes.task({...task,host_ids:["two"]},task.id,false);
      if(change==="binding")f.db.run("UPDATE managed_machines SET agent_id='replacement' WHERE id='one'");
      f.advance(10);f.store.tick();assert.equal(f.store.list().length,1,change);
    }finally{f.close();}
  }
});

test("a queued automatic retry rechecks its approved definition again at Agent claim",()=>{
  const f=fixture();try{
    f.task("retryable",{execution_policy:{retry_count:1,retry_delay_seconds:10}});f.store.dispatch("retryable",{confirm:true},"admin");
    const first=f.store.claim("agent-one",capabilities)!;f.finish(first,{state:"failed",code:"script_failed",exit_code:1});f.advance(10);f.store.tick();
    const retry=f.store.list().find(r=>r.retry_of===first.id)!;assert.ok(retry);
    const task=f.store.nodes.getTask("retryable");f.store.nodes.task({...task,script:{...task.script,code:"new approved definition"}},task.id,false);
    assert.equal(f.store.claim("agent-one",capabilities),null);assert.equal(f.store.get(retry.id).state,"cancelled");assert.equal(f.store.get(retry.id).code,"task_revision_changed");
  }finally{f.close();}
});

test("two hundred long-delay failures do not starve a later short-delay retry",()=>{
  const f=fixture();try{
    const targets=Array.from({length:200},(_,i)=>"slow-"+i);
    for(const id of targets)f.db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)",id,id,id+".example.test","agent-"+id,f.now().toISOString(),f.now().toISOString());
    f.task("slow",{host_ids:targets,execution_policy:{retry_count:1,retry_delay_seconds:3600}});f.store.dispatch("slow",{confirm:true},"admin");
    for(const id of targets){const run=f.store.claim("agent-"+id,capabilities)!;f.finish(run,{state:"failed",code:"script_failed",exit_code:1});}
    f.task("fast",{execution_policy:{retry_count:1,retry_delay_seconds:10,queue_timeout_seconds:10}});f.store.dispatch("fast",{confirm:true},"admin");
    const run=f.store.claim("agent-one",capabilities)!;f.finish(run,{state:"failed",code:"script_failed",exit_code:1});f.advance(10);f.store.tick();
    assert.equal(f.store.list({task_id:"fast"}).length,2);assert.ok(f.store.list({task_id:"fast"}).find(r=>r.retry_of===run.id));
    assert.equal(f.db.get<any>("SELECT count(*) AS n FROM task_runs WHERE task_id='slow'")!.n,200);
  }finally{f.close();}
});

test("script options require v2 at claim instead of silently discarding approved arguments",()=>{
  const f=fixture();try{
    f.task("options",{script:{runtime:"shell",code:"printf '%s' \"$1\"",args:["literal;$(untrusted)"],cwd:"/tmp",timeout_seconds:5,max_output_bytes:1024}});
    const run=f.store.dispatch("options",{confirm:true},"admin").runs[0];
    assert.equal(f.store.claim("agent-one",capabilities),null);assert.equal(f.store.get(run.id).state,"queued");
    const claim=f.store.claim("agent-one",[...capabilities,"task.script.v2"])!;assert.deepEqual(claim.snapshot.script.args,["literal;$(untrusted)"]);assert.equal(claim.snapshot.script.cwd,"/tmp");
  }finally{f.close();}
});

test("a v2-only heartbeat is ready and can claim both base and extended scripts",()=>{
  const f=fixture();try{
    f.db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('agent-one','one','one','fixture','linux','x64',?,?)",f.now().toISOString(),JSON.stringify({task_capabilities:["task.script.v2"]}));
    f.task("base");
    assert.equal(f.store.nodes.effectiveHostTasks("one").find(t=>t.id==="base")?.status,"ready");
    assert.deepEqual(f.store.nodes.hostDirectory().find(h=>h.id==="one").task_capabilities,["task.script.v2"]);
    f.store.dispatch("base",{confirm:true},"admin");const base=f.store.claim("agent-one",["task.script.v2"])!;assert.ok(base);f.finish(base);
    f.task("extended",{script:{runtime:"node",code:"console.log(process.argv[2])",args:["literal"],timeout_seconds:5,max_output_bytes:1024}});
    assert.equal(f.store.nodes.effectiveHostTasks("one").find(t=>t.id==="extended")?.status,"ready");
    f.store.dispatch("extended",{confirm:true},"admin");const extended=f.store.claim("agent-one",["task.script.v2"])!;assert.ok(extended);assert.deepEqual(extended.snapshot.script.args,["literal"]);
  }finally{f.close();}
});

test("external retry authorization is inherited and rechecked, missing authorization guard fails closed",()=>{
  const f=fixture();try{
    f.db.exec("CREATE TABLE capability_run_authorizations(run_id TEXT PRIMARY KEY,grant_id TEXT,user_id TEXT,host_id TEXT)");
    f.task("external",{execution_policy:{retry_count:1,retry_delay_seconds:10}});const first=f.store.dispatch("external",{confirm:true},"admin").runs[0];
    f.db.run("INSERT INTO capability_run_authorizations VALUES(?,'grant','admin','one')",first.id);
    assert.equal(f.store.claim("agent-one",capabilities),null);assert.equal(f.store.get(first.id).code,"authorization_revoked");
    f.task("external-two",{execution_policy:{retry_count:1,retry_delay_seconds:10}});const original=f.store.dispatch("external-two",{confirm:true},"admin").runs[0];
    f.db.run("INSERT INTO capability_run_authorizations VALUES(?,'grant','admin','one')",original.id);let permitted=true;f.store.beforeStart=()=>permitted;
    const claim=f.store.claim("agent-one",capabilities)!;f.finish(claim,{state:"failed",code:"script_failed",exit_code:1});f.advance(10);f.store.tick();
    const retry=f.store.list().find(r=>r.retry_of===original.id)!;assert.ok(f.db.get("SELECT 1 FROM capability_run_authorizations WHERE run_id=?",retry.id));
    permitted=false;assert.equal(f.store.claim("agent-one",capabilities),null);assert.equal(f.store.get(retry.id).code,"authorization_revoked");
  }finally{f.close();}
});

test("preview HTTP API validates administrator, fields and schedule without persisting or dispatching",async t=>{
  const f=fixture(),server=createServer(async(req,res)=>{if(!await f.router.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.close();});
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}/api/v1/task-schedules/preview`;
  const request=(input:any)=>fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  let response=await request({schedule:{mode:"cron",cron:"0 2 * * *",timezone:"Asia/Shanghai"}});assert.equal(response.status,200);
  const value=await response.json() as any;assert.equal(value.next_runs.length,5);assert.equal(value.next_runs[0],"2026-10-30T18:00:00.000Z");assert.equal(f.store.list().length,0);
  response=await request({schedule:{mode:"at",run_at:"2026-10-29T00:00:00Z"}});assert.equal(response.status,200);assert.deepEqual((await response.json() as any).next_runs,[]);
  response=await request({schedule:{mode:"once"},count:100});assert.equal(response.status,400);
  f.user.role="member";response=await request({schedule:{mode:"once"}});assert.equal(response.status,403);
});

function removalFence(f:ReturnType<typeof fixture>, state:string, by:"host"|"agent") {
  f.db.exec("CREATE TABLE machine_uninstallations(id TEXT PRIMARY KEY,machine_id TEXT,agent_id TEXT,status TEXT)");
  f.db.run("INSERT INTO machine_uninstallations VALUES('removal',?,?,?)",by==="host"?"one":"elsewhere",by==="agent"?"agent-one":"unregistered-agent",state);
}

test("uninstall approval, running and unknown fence dispatch, retry and queued claims by host or actual Agent",()=>{
  for(const state of ["awaiting_approval","running","unknown"])for(const by of ["host","agent"] as const){
    const f=fixture();try{
      f.task("queued");const queued=f.store.dispatch("queued",{confirm:true},"admin").runs[0];
      f.task("failed");const prior=f.store.dispatch("failed",{confirm:true},"admin").runs[0];f.store.cancel(prior.id,"admin");
      removalFence(f,state,by);
      f.task("new");assert.throws(()=>f.store.dispatch("new",{confirm:true},"admin"),/Agent 卸载/,state+by);
      assert.throws(()=>f.store.retry(prior.id,"admin"),/Agent 卸载/,state+by);
      const restarted=new TaskRunStore(f.deps);assert.equal(restarted.claim("agent-one",capabilities),null,state+by);
      assert.equal(f.store.get(queued.id).state,"queued");
      f.db.run("UPDATE machine_uninstallations SET status='cancelled'");
      assert.equal(restarted.claim("agent-one",capabilities)!.id,queued.id);
    }finally{f.close();}
  }
});

test("uninstall fence skips scheduled slots without catch-up and pauses consented retries until cancellation",()=>{
  for(const by of ["host","agent"] as const){
    const f=fixture();try{
      f.task("retryable",{execution_policy:{retry_count:1,retry_delay_seconds:10}});
      f.store.dispatch("retryable",{confirm:true},"admin");const first=f.store.claim("agent-one",capabilities)!;
      f.finish(first,{state:"failed",code:"script_failed",exit_code:1});
      f.task("scheduled",{schedule:{mode:"interval",interval_seconds:10}});f.store.tick();
      removalFence(f,"unknown",by);f.advance(10);f.store.tick();
      assert.equal(f.store.list({task_id:"scheduled"}).length,0);
      assert.equal(f.store.list({task_id:"retryable"}).length,1);
      assert.equal(f.db.get<any>("SELECT auto_retry_closed FROM task_runs WHERE id=?",first.id)!.auto_retry_closed,0);
      f.db.run("UPDATE machine_uninstallations SET status='cancelled'");f.store.tick();
      assert.equal(f.store.list({task_id:"scheduled"}).length,0);
      assert.equal(f.store.list({task_id:"retryable"}).length,2);
      f.advance(10);f.store.tick();assert.equal(f.store.list({task_id:"scheduled"}).length,1);
    }finally{f.close();}
  }
});

test("two hundred uninstall-fenced retry candidates cannot starve a later eligible host",()=>{
  const f=fixture();try{
    f.task("blocked",{execution_policy:{retry_count:1,retry_delay_seconds:10}});f.store.dispatch("blocked",{confirm:true},"admin");
    const first=f.store.claim("agent-one",capabilities)!;f.finish(first,{state:"failed",code:"script_failed",exit_code:1});
    for(let i=0;i<200;i++)f.db.run(`INSERT INTO task_runs(id,task_id,host_id,agent_id,snapshot_json,state,trigger,request_id,requested_by,created_at,expires_at,finished_at,code,automatic_attempt,auto_retry_closed)
      SELECT ?,task_id,host_id,agent_id,snapshot_json,state,trigger,?,requested_by,created_at,expires_at,finished_at,code,automatic_attempt,auto_retry_closed FROM task_runs WHERE id=?`,"blocked-"+i,"blocked-"+i,first.id);
    f.task("eligible",{host_ids:["two"],execution_policy:{retry_count:1,retry_delay_seconds:10}});f.store.dispatch("eligible",{confirm:true},"admin");
    const other=f.store.claim("agent-two",capabilities)!;f.finish(other,{state:"failed",code:"script_failed",exit_code:1});
    removalFence(f,"unknown","host");f.advance(10);f.store.tick();
    assert.equal(f.store.list({task_id:"eligible"}).length,2);
    assert.equal(f.db.get<any>("SELECT count(*) n FROM task_runs WHERE task_id='blocked'")!.n,201);
  }finally{f.close();}
});
