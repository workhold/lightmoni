import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { Logs, type LogSpec } from "../src/domains/logs.js";
import { LogReadService } from "../src/domains/log-read.js";
import { TraceReadService } from "../src/domains/trace-read.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, QueryRequest, QueryResponse, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
const range = {from:"2026-11-13T00:00:00Z",to:"2026-11-14T00:00:00Z"};
const logTable = {id:"log_app",name:"log_app",logical_name:"app",kind:"log",columns:["event_id","event_time","service","body","severity"].map(name=>({name,type:"String"})),services:["api"],system:false,retention_days:null,effective_retention_days:7};
const traceTable = {id:"trace_app",name:"trace_app",logical_name:"trace",kind:"trace",columns:["event_id","event_time","service","trace_id","span_id","parent_span_id","name","start_time","end_time","duration_ns","status","attributes_json","events_json"].map(name=>({name,type:"String"})),services:["api"],system:false,retention_days:null,effective_retention_days:7};
function fixture(logBodies=["zero","one","two","three"], missingParent=false) {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const requests:QueryRequest[]=[];
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,18)),
    cat:{list:async()=>[logTable,traceTable]},query:async(request:QueryRequest):Promise<QueryResponse>=>{
      requests.push(request);
      if(request.source==="logs")return{request_id:"logs",results:request.queries.map(q=>({refId:q.refId,status:"success",complete:true,truncated:false,elapsed_ms:1,
        frames:[q.refId==="rows"?{columns:logTable.columns.slice(0,4),rows:logBodies.map((body,i)=>["e"+i,"2026-11-13T00:00:00Z","api",body])}:{columns:[{name:"time",type:"String"},{name:"severity",type:"String"},{name:"count",type:"UInt64"}],rows:[["2026-11-13T00:00:00Z","ERROR",String(logBodies.length)]]}]}))};
      const spans=[["root","","api","root","root","root","2026-11-13T00:00:00Z","2026-11-13T00:00:01Z","1","OK","{}"],["child",missingParent?"missing":"root","api","child","child","child","2026-11-13T00:00:00Z","2026-11-13T00:00:01Z","1","OK","{}"]];
      const columns=["span_id","parent_span_id","service","trace_id","name","kind","start_time","end_time","duration_ns","status","attributes_json"].map(name=>({name,type:"String"}));
      return{request_id:"trace",results:[{refId:"trace",status:"success",complete:true,truncated:false,elapsed_ms:1,frames:[{columns,rows:spans.map(row=>row.map(String))}]}]};
    },logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const logs=new Logs(deps),logReads=new LogReadService(logs),traceReads=new TraceReadService(deps),runs=new TaskRunStore(deps);
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,logs:logReads,traces:traceReads});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  const spec:LogSpec={table_id:"log_app",range,services:["api"]};
  return{db,deps,logs,access,dispatcher,requests,principal,invoke,spec,close:async()=>{logs.close();db.close();}};
}

test("log capabilities reuse frozen pages, owner and cursor without rerunning subsequent reads",async()=>{
 const f=await fixture();try{
  const first=await f.invoke("lightmoni_logs_search",{spec:f.spec,limit:2});assert.deepEqual(first.data.frame.rows.map((r:any)=>r[0]),["e0","e1"]);assert.equal(first.data.next_cursor,"2");assert.equal(first.data.offset,0);
  const calls=f.requests.length;
  const second=await f.invoke("lightmoni_logs_search",{session_id:first.data.session_id,cursor:"2",limit:2});assert.deepEqual(second.data.frame.rows.map((r:any)=>r[0]),["e2","e3"]);assert.equal(f.requests.length,calls);
  await assert.rejects(f.invoke("lightmoni_logs_search",{session_id:first.data.session_id,cursor:"0"},{...structuredClone(f.principal),user:member}),/查询会话已过期/);
  const logsOnly={...structuredClone(f.principal),scopes:["logs.read"]};await assert.rejects(f.invoke("lightmoni_traces_get",{trace_id:"trace",tables:["trace_app"],...range},logsOnly),/capability_forbidden/);
  const tracesOnly={...structuredClone(f.principal),scopes:["traces.read"]};await assert.rejects(f.invoke("lightmoni_logs_search",{spec:f.spec},tracesOnly),/capability_forbidden/);
  const scoped={...structuredClone(f.principal),host_ids:["one"]};assert.equal(f.dispatcher.list(scoped).some(d=>["logs.search","traces.get"].includes(d.id)),false);
 }finally{await f.close();}
});

test("log projection advances through trimmed rows without losing frozen content",async()=>{
 const f=await fixture(["a".repeat(40_000),"b".repeat(40_000),"c".repeat(40_000)]);try{
  const first=await f.invoke("lightmoni_logs_search",{spec:f.spec,limit:3});assert.equal(first.data.frame.rows.length,1);assert.equal(first.data.capability_truncated,true);assert.equal(first.data.next_cursor,"1");
  const calls=f.requests.length;
  const second=await f.invoke("lightmoni_logs_search",{session_id:first.data.session_id,cursor:first.data.next_cursor,limit:3});assert.equal(second.data.frame.rows[0][3][0],"b");assert.equal(second.data.next_cursor,"2");assert.equal(f.requests.length,calls);
  const third=await f.invoke("lightmoni_logs_search",{session_id:first.data.session_id,cursor:"2",limit:3});assert.equal(third.data.frame.rows[0][3][0],"c");assert.equal(third.data.next_cursor,"");
 }finally{await f.close();}
});

test("single oversized log rows fail explicitly instead of producing a repeating cursor",async()=>{
 const f=await fixture(["x".repeat(70_000)]);try{
  await assert.rejects(f.invoke("lightmoni_logs_search",{spec:f.spec,limit:1}),/result_too_large/);
 }finally{await f.close();}
});

test("trace reads preserve real spans, missing parents and table validation",async()=>{
 const f=await fixture(undefined,true);try{
  const result=await f.invoke("lightmoni_traces_get",{trace_id:"trace-one",tables:["trace_app"],...range});
  assert.equal(result.data.spans.length,2);assert.equal(result.data.incomplete,true);assert.equal(result.data.missing_parents,1);
  await assert.rejects(f.invoke("lightmoni_traces_get",{trace_id:"trace-one",tables:["log_app"],...range}),/Trace表/);
 }finally{await f.close();}
});

test("internal search_logs and get_trace use the same dispatcher without duplicate registration",async()=>{
 const f=await fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();
  const logs=await tools.find(t=>t.name==="search_logs")!.execute({spec:f.spec,limit:1},new AbortController().signal,admin,{session_id:"session-one"});assert.equal(logs.frame.rows.length,1);
  const trace=await tools.find(t=>t.name==="get_trace")!.execute({trace_id:"trace-one",tables:["trace_app"],...range},new AbortController().signal,admin,{session_id:"session-one"});assert.equal(trace.spans.length,2);
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_logs_search'"));
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_traces_get'"));
 }finally{await f.close();}
});
