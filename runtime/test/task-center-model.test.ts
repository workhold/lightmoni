import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DB } from "../src/shared/sqlite.js";
import { Router, HTTPError } from "../src/shared/http.js";
import { NodeStore, NodeError, normalizeTask } from "../src/server/nodes-model.js";
import { registerNodes } from "../src/server/nodes.js";
import { hasActiveTaskRuns, replaceableAgentBinding } from "../src/server/agent-hosts.js";
import type { Dependencies } from "../src/shared/types.js";
const at = new Date("2026-10-30T01:00:00.000Z");
const fixture = (t: any) => { const db = new DB(":memory:"); t.after(() => db.close()); return {db, store:new NodeStore(db, () => at)}; };
const machine = (db: DB, id: string, agent = "") => {
  db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)", id, `Host ${id}`, `${id}.invalid`, agent, at.toISOString(), at.toISOString());
  if (agent) db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES(?,?,?,'1','linux','amd64',?,'{}')", agent, id, id, at.toISOString());
};
const script = (more: Record<string,unknown> = {}) => ({ name:"Test script", type:"script", enabled:true, label_ids:[], host_ids:[], target_all:false, schedule:{mode:"once"}, script:{runtime:"node",code:"console.log('ok')",timeout_seconds:10,max_output_bytes:4096}, ...more });
const code = (status: number) => (error: unknown) => error instanceof NodeError && error.status === status;

test("fresh defaults are persisted, enabled for all hosts and cannot be deleted; restart preserves edits", t => {
  const {db,store}=fixture(t); machine(db,"first","agent-first");
  const defaults=store.tasks(); assert.equal(defaults.length,3);
  assert.deepEqual(defaults.map(x=>[x.type,x.enabled,x.target_all,x.origin]).sort(),[["host",true,true,"builtin"],["log",true,true,"builtin"],["probe",true,true,"builtin"]]);
  for (const type of ["probe","log"]) assert.equal(store.effectiveHostTasks("first").find(x=>x.type===type)?.status,"waiting_config");
  assert.equal(store.effective("agent-first").config.host_enabled,true);
  assert.equal(store.effective("agent-first").config.logs_enabled,false);
  const metrics=defaults.find(x=>x.type==="host")!;
  store.task({...metrics,name:"My metrics",enabled:false,host_ids:["first"],target_all:false},metrics.id,false);
  store.setOverride("first",metrics.id,{config:{collect_interval_seconds:30}});
  const reopened=new NodeStore(db,()=>at);
  assert.equal(reopened.getTask(metrics.id).name,"My metrics"); assert.equal(reopened.getTask(metrics.id).enabled,false);
  assert.deepEqual(reopened.getTask(metrics.id).host_ids,["first"]); assert.equal(reopened.getTask(metrics.id).target_all,false);
  assert.throws(()=>reopened.deleteTask(metrics.id),code(409)); assert.equal(reopened.tasks().length,3);
  assert.ok(db.get("SELECT 1 FROM machine_task_overrides WHERE machine_id='first' AND task_id=?",metrics.id));
});

test("labels belong to offline hosts, survive Agent replacement and empty labels stay empty across restart", t => {
  const {db,store}=fixture(t); machine(db,"host"); store.label("Production","production",true);
  store.setHostLabels("host",["production","production"]); assert.deepEqual(store.hostLabels("host"),["production"]);
  assert.equal(store.labels().find(x=>x.id==="production")?.host_count,1);
  assert.throws(()=>store.deleteLabel("production"),code(409));
  machine(db,"other","old"); store.setHostLabels("other",["production"]);
  db.run("UPDATE managed_machines SET agent_id='new' WHERE id='other'");
  assert.deepEqual(store.nodeLabels("new"),["production"]);
  store.setHostLabels("host",[]); const reopened=new NodeStore(db,()=>at);
  assert.deepEqual(reopened.hostLabels("host"),[]); assert.deepEqual(reopened.hostLabels("other"),["production"]);
  assert.equal(reopened.hostDirectory()[0].address,undefined);
  assert.deepEqual(Object.keys(reopened.hostDirectory()[0]).sort(),["agent_id","agent_status","id","label_ids","labels","name","network","task_capabilities"]);
  assert.deepEqual(reopened.hostDirectory()[0].network,{hostname:"",observed_via:"unavailable",addresses:[],private_ips:[],public_ips:[],observed_at:"",source_ip:"",source_observed_at:"",source_kind:"unavailable"});
});

test("script targets are all, any-label or explicit-host union; empty target never broadcasts", t => {
  const {db,store}=fixture(t); machine(db,"a","agent-a"); machine(db,"b","agent-b"); machine(db,"c");
  store.label("Production","production",true); store.setHostLabels("a",["production"]);
  store.task(script({label_ids:["production"],host_ids:["b"]}),"selected",true);
  store.task(script(),"empty",true);
  assert.ok(store.effectiveHostTasks("a").some(x=>x.id==="selected"));
  assert.equal(store.effectiveHostTasks("a").find(x=>x.id==="selected")?.status,"upgrade_required");
  db.run("UPDATE agents SET heartbeat=? WHERE id='agent-a'",JSON.stringify({task_capabilities:["task.script.v1"]}));
  assert.equal(store.effectiveHostTasks("a").find(x=>x.id==="selected")?.status,"ready");
  assert.ok(store.effectiveHostTasks("b").some(x=>x.id==="selected"));
  assert.ok(!store.effectiveHostTasks("c").some(x=>x.id==="selected"));
  assert.ok(!store.effectiveHostTasks("a").some(x=>x.id==="empty"));
  assert.ok(!store.effective("agent-a").task_ids.includes("selected"));
  assert.equal(store.effective("agent-a").config.probes.length,0);
  assert.throws(()=>store.task(script({host_ids:["missing"]}),"bad",true),code(404));
  assert.throws(()=>store.task(script({origin:"builtin"}),"fake-builtin",true),code(400));
});

test("single-host overrides and custom host collection do not change other hosts", t => {
  const {db,store}=fixture(t); machine(db,"a","agent-a"); machine(db,"b","agent-b");
  const metrics=store.tasks().find(x=>x.type==="host")!;
  store.setOverride("a",metrics.id,{enabled:false});
  assert.equal(store.effective("agent-a").config.host_enabled,false); assert.equal(store.effective("agent-b").config.host_enabled,true);
  store.clearOverride("a",metrics.id);
  store.setOverride("a",metrics.id,{config:{collect_interval_seconds:30}});
  assert.equal(store.effective("agent-a").config.collect_interval_seconds,30); assert.equal(store.effective("agent-b").config.collect_interval_seconds,15);
  store.clearOverride("a",metrics.id);
  db.transaction(()=>{store.saveTask(normalizeTask({id:"custom",name:"Custom metrics",type:"host",enabled:true,host_ids:["a"],config:{collect_interval_seconds:45,host_collectors:["memory"]}}));store.validateAll();});
  assert.equal(store.effective("agent-a").config.collect_interval_seconds,45); assert.equal(store.effective("agent-b").config.collect_interval_seconds,15);
  assert.throws(()=>db.transaction(()=>{store.saveTask(normalizeTask({id:"conflict",name:"Conflicting metrics",type:"host",enabled:true,host_ids:["a"],config:{collect_interval_seconds:60}}));store.validateAll();}),code(409));
  assert.throws(()=>store.getTask("conflict"),code(404));
  const own=store.task(script({host_ids:["a"]}),"script",true);
  assert.throws(()=>store.setOverride("a",own.id,{config:{}}),code(400));
  assert.throws(()=>store.setOverride("b",own.id,{enabled:false}),code(409));
});

test("script input limits, schedules, immutable source/type and prepared approval writes", t => {
  const {db,store}=fixture(t); machine(db,"a");
  for (const patch of [
    {script:{runtime:"python",code:"x",timeout_seconds:1,max_output_bytes:1024}},
    {script:{runtime:"node",code:"x\0",timeout_seconds:1,max_output_bytes:1024}},
    {script:{runtime:"node",code:"x".repeat(65537),timeout_seconds:1,max_output_bytes:1024}},
    {script:{runtime:"node",code:"x",timeout_seconds:3601,max_output_bytes:1024}},
    {script:{runtime:"shell",code:"echo x",timeout_seconds:1,max_output_bytes:262145}},
    {schedule:{mode:"continuous"}}, {schedule:{mode:"once",interval_seconds:30}}, {schedule:{mode:"interval",interval_seconds:9}},
  ]) assert.throws(()=>normalizeTask(script(patch)),code(400));
  const accepted=store.prepareTask(script({host_ids:["a"],schedule:{mode:"interval",interval_seconds:10}}),"prepared",true);
  assert.equal(accepted.schedule.interval_seconds,10); assert.throws(()=>store.getTask("prepared"),code(404));
  db.transaction(()=>store.task(accepted,"prepared",true,true)); assert.equal(store.getTask("prepared").script?.code,"console.log('ok')");
  assert.throws(()=>store.task({...accepted,origin:"builtin"},"prepared",false),code(400));
});

test("task lifecycle barriers retain unknown attempts until explicit superseding or human review", t => {
  const {db,store}=fixture(t); machine(db,"a","agent-a");
  store.task(script({host_ids:["a"]}),"script",true);
  db.exec("CREATE TABLE task_runs(id TEXT PRIMARY KEY,host_id TEXT,agent_id TEXT,task_id TEXT,state TEXT,superseded_by TEXT,resolved_at TEXT NOT NULL DEFAULT '')");
  db.run("INSERT INTO task_runs VALUES('run','a','agent-a','script','unknown','','')");
  assert.equal(hasActiveTaskRuns(db,"agent-a"),true); assert.equal(hasActiveTaskRuns(db,"","a"),true);
  assert.equal(replaceableAgentBinding(db,"agent-a",at.toISOString()),false);
  assert.throws(()=>store.deleteTask("script"),code(409));
  db.run("UPDATE task_runs SET resolved_at=?",at.toISOString());
  assert.equal(hasActiveTaskRuns(db,"agent-a"),false); assert.equal(hasActiveTaskRuns(db,"","a"),false);
  store.deleteTask("script"); assert.equal(db.get<any>("SELECT state FROM task_runs WHERE id='run'")?.state,"unknown");
  db.run("UPDATE task_runs SET state='queued'"); assert.equal(hasActiveTaskRuns(db,"agent-a"),true);
  db.run("UPDATE task_runs SET state='running'"); assert.equal(hasActiveTaskRuns(db,"agent-a"),true);
  db.run("UPDATE task_runs SET state='unknown',resolved_at=''"); assert.equal(hasActiveTaskRuns(db,"agent-a"),true);
  db.run("UPDATE task_runs SET superseded_by='retry'"); assert.equal(hasActiveTaskRuns(db,"agent-a"),false);
});

test("host labels and task directory expose read-only host identity; members cannot mutate", async t => {
  const {db,store}=fixture(t); machine(db,"offline");
  const router=new Router(), user={id:"member",name:"Member",role:"member"};
  const deps={db,router,now:()=>at,auth:{user:()=>user},logger:{error(){},info(){},warn(){}}} as unknown as Dependencies;
  router.auth=deps.auth; const module=registerNodes(deps); t.after(()=>module.close?.());
  const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const request=async(path:string,method="GET",body?:unknown)=>{const response=await fetch(url+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};
  const hosts=await request("/task-hosts"); assert.equal(hosts.status,200); assert.equal(hosts.data[0].id,"offline"); assert.equal(hosts.data[0].address,undefined);
  assert.equal((await request("/machines/offline/tasks")).status,200);
  assert.equal((await request("/machines/offline/labels","PUT",{label_ids:[]})).status,403);
  user.role="admin"; const label=await request("/host-labels","POST",{name:"Production"}); assert.equal(label.status,201);
  assert.equal((await request("/machines/offline/labels","PUT",{label_ids:[label.data.id]})).status,200);
  assert.deepEqual(store.hostLabels("offline"),[label.data.id]);
  assert.equal((await fetch(url+"/task-templates")).status,404);
});

test("task revisions bind scripts, schedules and targets while ignoring supplied hashes and view state", t => {
  const {db,store}=fixture(t); machine(db,"a"); machine(db,"b");
  const task=store.task(script({host_ids:["a"]}),"revision",true);
  assert.match(task.revision!,/^[a-f0-9]{64}$/); assert.equal(store.getTask(task.id).revision,task.revision);
  const unchanged=store.task({...task,revision:"attacker supplied"},task.id,false);
  assert.equal(unchanged.revision,task.revision);
  const updated=store.task({...task,script:{...task.script!,code:"console.log('different')"}},task.id,false);
  assert.notEqual(updated.revision,task.revision);
  const moved=store.task({...updated,host_ids:["b"]},task.id,false); assert.notEqual(moved.revision,updated.revision);
  const scheduled=store.task({...moved,schedule:{mode:"interval",interval_seconds:30}},task.id,false); assert.notEqual(scheduled.revision,moved.revision);
});

test("control heartbeats cannot grant host labels on first enrollment or replace central labels", t => {
  const {db,store}=fixture(t); machine(db,"host"); store.label("Production","production",true); store.setHostLabels("host",["production"]);
  db.run("UPDATE managed_machines SET agent_id='new' WHERE id='host'");
  db.exec("CREATE TABLE agent_enrollments(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,machine_id TEXT,created_at TEXT)");
  db.run("INSERT INTO agent_enrollments VALUES('enroll','new','active','host',?)",at.toISOString());
  store.heartbeat("new",{hostname:"reported",group_id:"default"},"control");
  assert.deepEqual(store.hostLabels("host"),["production"]);
  store.heartbeat("new",{hostname:"reported",group_id:"default"},"control");
  assert.deepEqual(store.nodeLabels("new"),["production"]);
});
