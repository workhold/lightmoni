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
    db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES(?,?,?,'1','linux','x64',?,?)","agent-"+id,id,id,at.toISOString(),JSON.stringify({task_capabilities:["task.script.v2"]}));
  }
  t.after(()=>db.close()); return {db,store,deps,advance(seconds:number){now=new Date(now.getTime()+seconds*1000);}};
}

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
  db.run("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('replacement','three','new','1','linux','x64',?,'{}')",at.toISOString());
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
  assert.equal((await request("/agent-groups","POST",{name:"Bypass",config:{}})).status,404);assert.equal((await request("/agent-groups/default","PUT",{name:"Bypass",config:{}})).status,404);
  assert.equal((await request("/agent-tasks/"+custom.id,"DELETE")).status,200);assert.equal(db.get<any>("SELECT name FROM agent_tasks WHERE id='retained'")!.name,"Updated native");
});

// Represent the definition reviewed by the previous release, including the
// removed metadata in its digest; execution snapshots remain immutable.
function oldSnapshot(db:DB,task:any,runID:string){
  const revision=taskRevision({...task,template_id:""} as any), row=db.get<any>("SELECT snapshot_json FROM task_runs WHERE id=?",runID)!;
  const snapshot=JSON.stringify({...JSON.parse(row.snapshot_json),task_revision:revision});db.run("UPDATE task_runs SET snapshot_json=? WHERE id=?",snapshot,runID);
  db.run("UPDATE agent_tasks SET metadata_json=json_set(metadata_json,'$.template_id','') WHERE id=?",task.id);return {revision,snapshot};
}
