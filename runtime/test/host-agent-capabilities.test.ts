import test from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import { accountSchema } from "../src/server/accounts.js";
import { TaskRunStore } from "../src/server/task-center.js";
import { CapabilityAccess } from "../src/capabilities/access.js";
import { CapabilityDispatcher } from "../src/capabilities/index.js";
import { CAPABILITY_SCOPES, type Principal } from "../src/capabilities/types.js";
import { registerAssistant } from "../src/assistant/index.js";
import type { Dependencies, User } from "../src/shared/types.js";

const admin: User = {id:"admin",name:"Admin",role:"admin"}, member: User = {id:"member",name:"Member",role:"member"};
function fixture() {
  const db=new DB(":memory:");accountSchema(db);db.run("INSERT INTO users(id,name,role,active,created_at) VALUES('admin','Admin','admin',1,'2026-11-14'),('member','Member','member',1,'2026-11-14')");
  const deps={db,router:new Router(),now:()=>new Date("2026-11-14T00:00:00Z"),externalURL:"https://moni.example.test",...cipher(Buffer.alloc(32,21)),cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const runs=new TaskRunStore(deps);for(const id of ["one","two"])db.run("INSERT INTO managed_machines(id,name,address,port,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'direct_ssh',?,?,?)",id,"Host "+id,id+".test","agent-"+id,deps.now().toISOString(),deps.now().toISOString());
  const machines={
    assistantList:()=>["one","two"].map(id=>({id,name:"Host "+id,host_key_fingerprint:"",host_key_public_key:"",host_key_observed_at:""})),
    assistantGet:(id:string)=>({id,name:"Host "+id,host_key_fingerprint:"",ssh_credentials:[{id:"credential-metadata",username:"deploy"}]}),
    assistantDeployment:(id:string)=>({id,machine_id:"one",status:"unknown",receipt:{stages:["verified"]}}),
    agentUpdates:{listReleases:()=>[{version:"1.2.3",sha256:"a".repeat(64)}],assistantGet:(machine_id:string,id:string)=>({id,machine_id,status:"rolled_back"})},
  } as any;
  const principal:Principal={user:admin,scopes:[...CAPABILITY_SCOPES],host_ids:null,credential_id:"token",grant_id:"grant",source:"mcp"};
  const access=new CapabilityAccess(deps,{validate(){},validateGrant:()=>structuredClone(principal)});
  const dispatcher=new CapabilityDispatcher(deps,access,{taskCenter:runs,machines});
  const invoke=(name:string,input:any,p=structuredClone(principal))=>dispatcher.invoke(p,name,input,{signal:new AbortController().signal});
  return{db,deps,machines,access,dispatcher,principal,invoke,close:()=>db.close()};
}

test("detailed hosts and Agent receipts use safe domain views without changing legacy hosts",async()=>{
 const f=fixture();try{
  const inventory=await f.invoke("lightmoni_hosts_inventory",{});assert.equal(inventory.data.machines.length,2);
  const detail=await f.invoke("lightmoni_hosts_details_get",{id:"one"});assert.equal(detail.data.machine.ssh_credentials[0].username,"deploy");
  const legacy=await f.invoke("lightmoni_hosts_get",{id:"one"});assert.equal(Object.hasOwn(legacy.data.host,"ssh_credentials"),false);
  assert.equal((await f.invoke("lightmoni_agent_releases_list",{})).data.releases[0].version,"1.2.3");
  assert.equal((await f.invoke("lightmoni_agent_installations_get",{deployment_id:"install-one"})).data.installation.status,"unknown");
  assert.equal((await f.invoke("lightmoni_agent_updates_get",{machine_id:"one",update_id:"update-one"})).data.update.status,"rolled_back");
  const execution=await f.invoke("lightmoni_domain_executions_get",{id:"agent_update:one/update-one"});assert.equal(execution.data.execution.native_state,"rolled_back");
  assert.equal(f.dispatcher.definitions.some(d=>/propose|approve|apply|execute/.test(d.name)),false);
 }finally{f.close();}
});

test("host and Agent resource grants are rechecked and members remain excluded",async()=>{
 const f=fixture();try{
  const scoped={...structuredClone(f.principal),host_ids:["one"]};
  assert.deepEqual((await f.invoke("lightmoni_hosts_inventory",{},scoped)).data.machines.map((m:any)=>m.id),["one"]);
  await assert.rejects(f.invoke("lightmoni_hosts_details_get",{id:"two"},scoped),/resource_not_found/);
  await assert.rejects(f.invoke("lightmoni_agent_updates_get",{machine_id:"two",update_id:"update-two"},scoped),/resource_not_found/);
  await assert.rejects(f.invoke("lightmoni_agent_releases_list",{},scoped),/capability_forbidden/);
  assert.equal((await f.invoke("lightmoni_agent_installations_get",{deployment_id:"install-one"},scoped)).data.installation.machine_id,"one");
  const session=f.access.sessionPrincipal(member,"assistant");assert.equal(f.dispatcher.list(session).some(d=>d.id.startsWith("hosts.")||d.id.startsWith("agents.")),false);
 }finally{f.close();}
});

test("legacy assistant host and Agent read names use dispatcher with compatible shapes",async()=>{
 const f=fixture();try{
  const module=registerAssistant(f.deps,{capabilities:f.dispatcher,machines:f.machines,runtime:async()=>{}});await module.close?.();
  const tools=f.dispatcher.assistantTools();assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  const list=await tools.find(t=>t.name==="list_managed_machines")!.execute({},new AbortController().signal,admin);assert.equal(list.machines.length,2);
  const detail=await tools.find(t=>t.name==="get_managed_machine")!.execute({machine_id:"one"},new AbortController().signal,admin);assert.equal(detail.id,"one");
  assert.equal((await tools.find(t=>t.name==="get_agent_update")!.execute({machine_id:"one",update_id:"update-one"},new AbortController().signal,admin)).status,"rolled_back");
  assert.equal((await tools.find(t=>t.name==="get_agent_installation")!.execute({deployment_id:"install-one"},new AbortController().signal,admin)).status,"unknown");
  assert.ok(f.db.get("SELECT 1 FROM capability_invocations WHERE source='assistant' AND capability='lightmoni_agent_updates_get'"));
 }finally{f.close();}
});
