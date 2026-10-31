import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { NodeStore, normalizeTask, taskRevision } from "../src/server/nodes-model.js";
import { registerNodes } from "../src/server/nodes.js";
import { TaskRunStore } from "../src/server/task-center.js";

const at = new Date("2026-10-30T01:00:00Z");
const script = (id:string,extra:any={}) => ({id,name:id,type:"script",enabled:true,host_ids:["one"],schedule:{mode:"once"},script:{runtime:"shell",code:"echo reviewed",timeout_seconds:30,max_output_bytes:1024},...extra});
function fixture(t:any) {
  const db=new DB(":memory:"), router=new Router(); let now=at;
  const deps={db,router,now:()=>now,auth:{user:()=>({id:"admin",name:"Admin",role:"admin"})},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  router.auth=deps.auth; const store=new NodeStore(db,deps.now);
  for(const id of ["one","two","three"]) {
    db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)",id,id,id+".invalid","agent-"+id,at.toISOString(),at.toISOString());
    db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES(?,?,?,'1','linux','x64',?,?,'default')","agent-"+id,id,id,at.toISOString(),JSON.stringify({task_capabilities:["task.script.v2"]}));
  }
  t.after(()=>db.close()); return {db,store,deps,advance(seconds:number){now=new Date(now.getTime()+seconds*1000);}};
}
const allowMigration=(db:DB)=>db.run("DELETE FROM agent_task_migrations WHERE version='platform-default-tasks-v1'");

test("upgrade preserves defaults, user definitions and host overrides and fills missing defaults only once",t=>{
  const {db,store,deps}=fixture(t);db.run("DELETE FROM agent_tasks");
  store.saveTask(normalizeTask({id:"legacy:default:host",name:"User tuned default",type:"host",origin:"builtin",enabled:false,target_all:false,host_ids:["one"],config:{collect_interval_seconds:45,host_collectors:["memory"]}}));
  store.saveTask(normalizeTask({id:"existing-probe",name:"Existing user task",type:"probe",enabled:false,target_all:true,config:{probe_table:"my_checks"}}));
  store.setOverride("one","legacy:default:host",{config:{collect_interval_seconds:60}});
  db.run("UPDATE agent_tasks SET metadata_json=json_set(metadata_json,'$.template_id','metrics') WHERE id='legacy:default:host'");
  const before=store.getTask("legacy:default:host"), override=db.get("SELECT * FROM machine_task_overrides");
  allowMigration(db);const migrated=new NodeStore(db,deps.now);
  assert.deepEqual(migrated.getTask(before.id),before);assert.deepEqual(db.get("SELECT * FROM machine_task_overrides"),override);
  assert.equal(migrated.getTask("existing-probe").origin,"custom");
  assert.deepEqual(migrated.tasks().filter(task=>task.origin==="builtin").map(task=>task.type).sort(),["host","log","probe"]);
  assert.equal(db.get<any>("SELECT count(*) n FROM agent_tasks WHERE json_type(metadata_json,'$.template_id') IS NOT NULL")!.n,0);
  const log=migrated.tasks().find(task=>task.type==="log"&&task.origin==="builtin")!;migrated.task({enabled:false},log.id,false);
  assert.equal(new NodeStore(db,deps.now).getTask(log.id).enabled,false);
  // The marker prevents recreation even if a row was removed outside the API.
  db.run("DELETE FROM agent_tasks WHERE id=?",log.id);const reopened=new NodeStore(db,deps.now);
  assert.equal(reopened.tasks().length,3);assert.equal(reopened.getTask(before.id).enabled,false);
});

test("custom IDs and a builtin whose type changed never get overwritten by new default identities",t=>{
  const {db,store,deps}=fixture(t);db.run("DELETE FROM agent_tasks");
  store.saveTask(normalizeTask(script("platform-default:host",{origin:"builtin"})));
  store.saveTask(normalizeTask(script("platform-default:probe")));
  store.saveTask(normalizeTask({id:"platform-default:log",name:"User logs",type:"log",enabled:true,host_ids:["one"],config:{log_table:"custom_files",log_sources:[{directory:"/var/log/custom",pattern:"*.log"}]}}));
  store.saveTask(normalizeTask(script("platform-default:host:1")));store.setOverride("one","platform-default:log",{enabled:false});
  const before=store.tasks(), overrides=db.all("SELECT * FROM machine_task_overrides");allowMigration(db);const migrated=new NodeStore(db,deps.now);
  for(const task of before)assert.deepEqual(migrated.getTask(task.id),task);
  assert.deepEqual(db.all("SELECT * FROM machine_task_overrides"),overrides);
  assert.equal(migrated.getTask("platform-default:host:2").type,"host");assert.equal(migrated.getTask("platform-default:probe:1").type,"probe");assert.equal(migrated.getTask("platform-default:log:1").type,"log");
  assert.equal(new NodeStore(db,deps.now).tasks().length,7);
});

test("empty default probes and logs do not enable handlers while configured user definitions still execute",t=>{
  const {store}=fixture(t);
  store.saveTask(normalizeTask({id:"retained-log",name:"User logs",type:"log",enabled:true,target_all:true,config:{log_table:"my_files",log_sources:[{directory:"/var/log/app",pattern:"*.log"}]}}));
  store.saveTask(normalizeTask({id:"retained-probe",name:"User probes",type:"probe",enabled:true,target_all:true,config:{probe_table:"my_checks",probes:[{id:"health",kind:"tcp",target:"127.0.0.1:80",interval_seconds:30,timeout_ms:1000}]}}));
  store.validateAll();const compiled=store.effective("agent-one").config;
  assert.equal(compiled.log_table,"files");assert.equal(compiled.logs_enabled,true);assert.equal(compiled.log_sources.length,1);assert.equal(compiled.probe_table,"probe");assert.equal(compiled.probes.length,1);
  for(const task of store.effectiveHostTasks("two").filter(task=>task.origin==="builtin"&&task.type!=="host"))assert.equal(task.status,"waiting_config");
  store.task({enabled:false},"retained-log",false);store.task({enabled:false},"retained-probe",false);
  assert.equal(store.effective("agent-one").config.logs_enabled,false);assert.deepEqual(store.effective("agent-one").config.probes,[]);
});

test("replacement Agents inherit current platform defaults without copied task definitions",t=>{
  const {db,store}=fixture(t), original=store.tasks().map(task=>task.id), metrics=store.tasks().find(task=>task.type==="host")!;
  store.task({config:{collect_interval_seconds:25}},metrics.id,false);
  db.run("UPDATE managed_machines SET agent_id='replacement' WHERE id='three'");
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES('replacement','three','new','1','linux','x64',?,'{}','default')",at.toISOString());
  assert.deepEqual(store.effectiveHostTasks("three").map(task=>task.id),original);assert.equal(store.effective("replacement").config.collect_interval_seconds,25);assert.equal(store.tasks().length,3);
});

test("HTTP task authoring locks server-owned source and type and rejects native creation or retired fields",async t=>{
  const {db,store,deps}=fixture(t), module=registerNodes(deps);t.after(()=>module.close?.());
  const server=createServer(async(req,res)=>{if(!await deps.router.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const request=(path:string,method="GET",body?:any)=>fetch(url+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  for(const type of ["host","probe","log"])assert.equal((await request("/agent-tasks","POST",{name:"forged",type,enabled:true})).status,400);
  for(const extra of [{origin:"builtin"},{template_id:""}])assert.equal((await request("/agent-tasks","POST",script("forged",extra))).status,400);
  const created=await request("/agent-tasks","POST",script("ok"));assert.equal(created.status,201);const custom=await created.json() as any;
  assert.equal(custom.origin,"custom");assert.equal("template_id" in custom,false);
  for(const change of [{origin:"builtin"},{type:"host"},{template_id:""}])assert.equal((await request("/agent-tasks/"+custom.id,"PUT",change)).status,400);
  const metrics=store.tasks().find(task=>task.type==="host")!;
  assert.equal((await request("/agent-tasks/"+metrics.id,"PUT",{type:"script",script:script("x").script})).status,400);
  assert.equal((await request("/agent-tasks/"+metrics.id,"PUT",{enabled:false})).status,200);assert.equal((await request("/agent-tasks/"+metrics.id,"DELETE")).status,409);
  store.saveTask(normalizeTask({id:"retained",name:"Old probe",type:"probe",enabled:false}));
  assert.equal((await request("/agent-tasks/retained","PUT",{name:"Updated native",target_all:true,enabled:true})).status,200);
  assert.equal((await request("/task-templates")).status,404);
  assert.equal((await request("/agent-groups","POST",{name:"Bypass",config:{}})).status,410);assert.equal((await request("/agent-groups/default","PUT",{name:"Bypass",config:{}})).status,410);
  assert.equal((await request("/agent-tasks/"+custom.id,"DELETE")).status,200);assert.equal(db.get<any>("SELECT name FROM agent_tasks WHERE id='retained'")!.name,"Updated native");
});

// Represent the definition reviewed by the previous release, including the
// removed metadata in its digest; execution snapshots remain immutable.
function oldSnapshot(db:DB,task:any,runID:string){
  const revision=taskRevision({...task,template_id:""} as any), row=db.get<any>("SELECT snapshot_json FROM task_runs WHERE id=?",runID)!;
  const snapshot=JSON.stringify({...JSON.parse(row.snapshot_json),task_revision:revision});db.run("UPDATE task_runs SET snapshot_json=? WHERE id=?",snapshot,runID);
  db.run("UPDATE agent_tasks SET metadata_json=json_set(metadata_json,'$.template_id','') WHERE id=?",task.id);return {revision,snapshot};
}

test("metadata migration retains queued and running snapshots and consumed once schedules without replay",t=>{
  const {db,deps,advance}=fixture(t), runs=new TaskRunStore(deps);
  const manual=runs.nodes.task(script("manual"),"manual",true), queued=runs.dispatch(manual.id,{confirm:true},"admin").runs[0], oldQueued=oldSnapshot(db,manual,queued.id);
  const runningTask=runs.nodes.task(script("running",{host_ids:["two"]}),"running",true);runs.dispatch(runningTask.id,{confirm:true},"admin");
  const running=runs.claim("agent-two",["task.script.v2"])!, oldRunning=oldSnapshot(db,runningTask,running.id);
  const scheduled=runs.nodes.task(script("once-at",{host_ids:["three"],schedule:{mode:"at",run_at:"2026-10-30T01:00:10Z"}}),"once-at",true);
  runs.tick();advance(10);runs.tick();const scheduledRun=runs.list({task_id:scheduled.id})[0];runs.cancel(scheduledRun.id,"admin");oldSnapshot(db,scheduled,scheduledRun.id);
  const consumed=db.all("SELECT * FROM task_schedule_consumptions");allowMigration(db);const restarted=new TaskRunStore(deps);restarted.tick();
  for(const [id,snapshot,state] of [[queued.id,oldQueued.snapshot,"queued"],[running.id,oldRunning.snapshot,"running"]]){const row=db.get<any>("SELECT snapshot_json,state FROM task_runs WHERE id=?",id)!;assert.equal(row.snapshot_json,snapshot);assert.equal(row.state,state);}
  assert.notEqual(restarted.nodes.getTask(manual.id).revision,oldQueued.revision);
  assert.throws(()=>restarted.dispatch(manual.id,{confirm:true,expected_task_revision:oldQueued.revision},"admin"),/changed since review/);
  const claimed=restarted.claim("agent-one",["task.script.v2"])!;assert.equal(claimed.id,queued.id);assert.equal(claimed.snapshot.task_revision,oldQueued.revision);
  assert.equal(restarted.claim("agent-two",["task.script.v2"]),null);assert.equal(restarted.get(running.id).state,"running");assert.equal(restarted.get(queued.id).state,"running");
  assert.deepEqual(db.all("SELECT * FROM task_schedule_consumptions"),consumed);assert.equal(restarted.list().length,3);assert.equal(restarted.list().filter(run=>run.state==="succeeded").length,0);
});

test("old queued automatic retry is cancelled after metadata changes the task revision",t=>{
  const {db,deps}=fixture(t), runs=new TaskRunStore(deps);
  const task=runs.nodes.task(script("retry"),"retry",true), run=runs.dispatch(task.id,{confirm:true},"admin").runs[0], before=oldSnapshot(db,task,run.id);
  db.run("UPDATE task_runs SET automatic_attempt=1,trigger='retry' WHERE id=?",run.id);allowMigration(db);const restarted=new TaskRunStore(deps);
  assert.equal(restarted.claim("agent-one",["task.script.v2"]),null);assert.equal(restarted.get(run.id).state,"cancelled");assert.equal(restarted.get(run.id).code,"task_revision_changed");
  assert.equal(db.get<any>("SELECT snapshot_json FROM task_runs WHERE id=?",run.id)!.snapshot_json,before.snapshot);assert.equal(restarted.list().length,1);
});
