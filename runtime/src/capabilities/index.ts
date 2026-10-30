import { createHash, randomUUID } from "node:crypto";
import type { Dependencies, User } from "../shared/types.js";
import { fail, HTTPError } from "../shared/http.js";
import { TaskProposalService, runMetadata, taskMetadata, taskTools, type ProposalSource } from "../assistant/task-tools.js";
import type { TaskRunStore } from "../server/task-center.js";
import { NodeError, taskTemplates, type Task } from "../server/nodes-model.js";
import type { AlertCapabilities } from "../domains/alert-capabilities.js";
import type { AccessAuthority, CapabilityDispatcherContract, InvocationContext, Principal } from "./types.js";

const string = { type: "string", minLength: 1, maxLength: 128 };
const schema = (properties: Record<string, any> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
function validate(value: any, s: any, depth = 0): void {
  if (depth > 12) fail(400, "invalid_input");
  if (s.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !(k in s.properties))
      || (s.required ?? []).some((k: string) => value[k] === undefined)) fail(400, "invalid_input");
    for (const [k, v] of Object.entries(value)) validate(v, s.properties[k], depth + 1);
  } else if (s.type === "string") {
    if (typeof value !== "string" || value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? 1024)
      || /[\u0000-\u001f\u007f]/u.test(value)) fail(400, "invalid_input");
  } else if (s.type === "integer") {
    if (!Number.isSafeInteger(value) || value < (s.minimum ?? 0) || value > (s.maximum ?? 100)) fail(400, "invalid_input");
  } else if (s.type === "boolean") { if (typeof value !== "boolean") fail(400, "invalid_input"); }
  else if (s.type === "array") {
    if (!Array.isArray(value) || value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? 100)
      || new Set(value).size !== value.length) fail(400, "invalid_input");
    for (const v of value) validate(v, s.items, depth + 1);
  } else fail(400, "invalid_input");
  if (s.enum && !s.enum.includes(value)) fail(400, "invalid_input");
}
interface Definition {
  name: string; description: string; inputSchema: Record<string,any>; effect: "read" | "propose";
  scope: string; allHosts?: boolean; execute: (p: Principal, input: any, context: InvocationContext) => unknown | Promise<unknown>;
}
export class CapabilityDispatcher implements CapabilityDispatcherContract {
  readonly proposals: TaskProposalService;
  readonly definitions: Definition[];
  readonly installationID: string;
  constructor(readonly deps: Dependencies, readonly authority: AccessAuthority, readonly options: {taskCenter: TaskRunStore; alerts?: AlertCapabilities}) {
    deps.db.exec(`CREATE TABLE IF NOT EXISTS capability_installation(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS capability_invocations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,credential_id TEXT NOT NULL,source TEXT NOT NULL,capability TEXT NOT NULL,input_hash TEXT NOT NULL,decision TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT '',proposal_id TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS capability_invocations_owner ON capability_invocations(user_id,created_at);
      CREATE TABLE IF NOT EXISTS capability_idempotency(installation_id TEXT NOT NULL,user_id TEXT NOT NULL,capability TEXT NOT NULL,key_hash TEXT NOT NULL,input_hash TEXT NOT NULL,proposal_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(installation_id,user_id,capability,key_hash));
      CREATE TABLE IF NOT EXISTS capability_run_authorizations(run_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,user_id TEXT NOT NULL,host_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_index(id TEXT PRIMARY KEY,domain TEXT NOT NULL,native_id TEXT NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(domain,native_id));`);
    const existing = deps.db.get<{id:string}>("SELECT id FROM capability_installation LIMIT 1");
    this.installationID = existing?.id ?? randomUUID();
    if (!existing) deps.db.run("INSERT INTO capability_installation(id) VALUES(?)", this.installationID);
    this.proposals = new TaskProposalService(deps, options.taskCenter, {
      beforeApply: (actor, source, intent) => {
        if (source.source !== "mcp") return;
        const current = this.grant(source, actor.id);
        this.authorize(current, "tasks.propose");
        if (intent.operation === "task.dispatch") for (const id of intent.host_ids ?? []) this.host(current, id);
        else if (["run.cancel", "run.retry"].includes(intent.operation)) this.host(current, options.taskCenter.get(intent.run_id!).host_id);
        else fail(403, "unsupported_external_proposal");
      },
      afterApply: (actor, source, _intent, proposal) => {
        if (source.source !== "mcp") return;
        const result = proposal.result as any;
        const runs = result?.runs ?? (result?.host_id ? [result] : []);
        for (const run of runs) {
          deps.db.run("INSERT OR IGNORE INTO capability_run_authorizations(run_id,grant_id,user_id,host_id) VALUES(?,?,?,?)", run.id, source.grant_id, actor.id, run.host_id);
          this.index(run);
        }
      },
    });
    options.taskCenter.beforeStart = run => {
      const binding = deps.db.get<{grant_id:string;user_id:string;host_id:string}>("SELECT * FROM capability_run_authorizations WHERE run_id=?", run.id);
      if (!binding) return true;
      try {
        const p = this.grant({source:"mcp",grant_id:binding.grant_id}, binding.user_id);
        this.authorize(p,"tasks.propose"); this.host(p,binding.host_id); return true;
      } catch { return false; }
    };
    const nodes = options.taskCenter.nodes;
    this.definitions = [
      {name:"lightmoni_hosts_list",description:"List authorized registered hosts and observed Agent state. No SSH secrets or raw output.",scope:"hosts.read",effect:"read",inputSchema:schema({limit:{type:"integer",minimum:1,maximum:100},offset:{type:"integer",minimum:0,maximum:10000}}),execute:(p,i)=>{
        const rows = deps.db.all<any>("SELECT id,name,address,port,platform,arch,agent_id,agent_last_seen,observed_hostname FROM managed_machines ORDER BY id").filter(h=>this.allowedHost(p,h.id));
        const offset=i.offset??0,limit=i.limit??50; return {hosts:rows.slice(offset,offset+limit).map(h=>this.hostView(h)),total:rows.length,truncated:offset+limit<rows.length,next_offset:offset+limit<rows.length?offset+limit:null};
      }},
      {name:"lightmoni_hosts_get",description:"Read one authorized host and observed management state.",scope:"hosts.read",effect:"read",inputSchema:schema({id:string},["id"]),execute:(p,i)=>({host:this.hostView(this.host(p,i.id))})},
      {name:"lightmoni_tasks_templates",description:"Read built-in task template metadata. These are templates, not execution receipts.",scope:"tasks.read",effect:"read",inputSchema:schema(),execute:()=>({templates:taskTemplates().map(t=>this.taskView(t,false))})},
      {name:"lightmoni_tasks_list",description:"List safe task metadata. A host-scoped grant must specify host_id; script bodies, collector settings and unrelated targets are omitted.",scope:"tasks.read",effect:"read",inputSchema:schema({host_id:string,type:{...string,enum:["host","probe","log","script"]}}),execute:(p,i)=>{
        if(p.host_ids!==null&&!i.host_id)fail(403,"host_id_required");
        if(i.host_id)this.host(p,i.host_id);
        const tasks=(i.host_id?nodes.effectiveHostTasks(i.host_id):nodes.tasks()).filter(t=>!i.type||t.type===i.type);
        return {tasks:tasks.slice(0,100).map(t=>this.taskView(t,p.host_ids===null)),total:tasks.length,truncated:tasks.length>100};
      }},
      {name:"lightmoni_tasks_get",description:"Read safe task metadata. Source code requires tasks.source.read and include_source=true; a scoped grant also requires host_id.",scope:"tasks.read",effect:"read",inputSchema:schema({id:string,host_id:string,include_source:{type:"boolean"}},["id"]),execute:(p,i)=>{
        const task=this.task(p,i.id,i.host_id);
        if(i.include_source&&!p.scopes.includes("tasks.source.read"))fail(403,"scope_required");
        return {task:{...this.taskView(task,p.host_ids===null),...(i.include_source&&task.script?{script:task.script}: {})}};
      }},
      {name:"lightmoni_tasks_plan",description:"Save a reviewable proposal to dispatch an existing task, cancel a run or retry a completed run. Never executes or approves. Return review_url to the user. An external call must supply a stable idempotency_key. unknown is never automatically retried.",scope:"tasks.propose",effect:"propose",inputSchema:schema({operation:{...string,enum:["task.dispatch","run.cancel","run.retry"]},task_id:string,run_id:string,host_ids:{type:"array",items:string,minItems:1,maxItems:200},reason:{type:"string",minLength:1,maxLength:1000},idempotency_key:{type:"string",minLength:1,maxLength:128}},["operation","reason","idempotency_key"]),execute:(p,i,c)=>this.plan(p,i,c)},
      {name:"lightmoni_proposals_get",description:"Read proposal status and queued run references without script bodies or raw host output.",scope:"tasks.read",effect:"read",inputSchema:schema({id:string},["id"]),execute:(p,i)=>this.proposalView(p,i.id)},
      {name:"lightmoni_executions_list",description:"List actual finite task execution receipts; state unknown is not success. Source, leases and output are omitted.",scope:"executions.read",effect:"read",inputSchema:schema({host_id:string,task_id:string,state:{...string,enum:["queued","running","succeeded","failed","cancelled","unknown"]},limit:{type:"integer",minimum:1,maximum:100}}),execute:(p,i)=>{
        if(p.host_ids!==null&&!i.host_id)fail(403,"host_id_required");if(i.host_id)this.host(p,i.host_id);
        return {executions:options.taskCenter.list({...i,limit:i.limit??30}).map(r=>this.execution(p,r)),output_omitted:true};
      }},
      {name:"lightmoni_executions_get",description:"Read one real task execution and native state. Poll this ID after disconnect; no raw output is returned.",scope:"executions.read",effect:"read",inputSchema:schema({id:string},["id"]),execute:(p,i)=>({execution:this.execution(p,options.taskCenter.get(i.id.startsWith("task:")?i.id.slice(5):i.id)),output_omitted:true})},
      {name:"lightmoni_telemetry_catalog",description:"List telemetry table schema metadata. No telemetry rows or arbitrary SQL. Requires an installation-wide grant because tables are not isolated by host.",scope:"telemetry.catalog.read",allHosts:true,effect:"read",inputSchema:schema(),execute:async(_p,_i,c)=>{const tables=await deps.cat.list(c.signal);return {tables:tables.slice(0,100).map(t=>({id:t.id,name:t.name,kind:t.kind,columns:t.columns})),limit:100,truncated:tables.length>100};}},
    ];
    if(options.alerts)this.definitions.push({name:"lightmoni_alerts_list",description:"List safe alert rule metadata without SQL or evidence. Host-scoped grants cannot access installation-wide rules.",scope:"alerts.read",allHosts:true,effect:"read",inputSchema:schema(),execute:async p=>({rules:(await options.alerts!.listRules(p.user)).slice(0,100).map(r=>({id:r.id,name:r.name,enabled:r.enabled,severity:r.severity,kind:r.kind,silence_until:r.silence_until})),limit:100})});
  }
  private grant(source:ProposalSource,userID:string):Principal {
    if(!source.grant_id||!this.authority.validateGrant)fail(403,"authorization_unavailable");
    return this.authority.validateGrant(source.grant_id,userID);
  }
  private authorize(p:Principal,scope:string,allHosts=false) {
    if(p.user.role!=="admin"||!p.scopes.includes(scope)||allHosts&&p.host_ids!==null)fail(403,"capability_forbidden");
  }
  private allowedHost(p:Principal,id:string) { return p.host_ids===null||p.host_ids.includes(id); }
  private host(p:Principal,id:string):any {
    if(!this.allowedHost(p,id))fail(404,"resource_not_found");
    const h=this.deps.db.get<any>("SELECT id,name,address,port,platform,arch,agent_id,agent_last_seen,observed_hostname FROM managed_machines WHERE id=?",id);
    if(!h)fail(404,"resource_not_found");return h;
  }
  private hostView(h:any) {
    const removed=h.agent_id&&this.deps.db.get("SELECT 1 FROM agent_lifecycle WHERE agent_id=? AND state='removed'",h.agent_id);
    const seen=this.deps.db.get<{last_seen:string}>("SELECT last_seen FROM agents WHERE id=?",h.agent_id)?.last_seen||h.agent_last_seen;
    return {...h,agent_last_seen:seen,agent_state:!h.agent_id?"not_installed":removed?"removed":seen&&this.deps.now().getTime()-Date.parse(seen)<=90000?"online":"offline"};
  }
  private taskView(task:Task,allHosts:boolean):any {
    const v=taskMetadata(task);return allHosts?v:Object.fromEntries(Object.entries(v).filter(([k])=>!["host_ids","label_ids","target_all"].includes(k)));
  }
  private task(p:Principal,id:string,hostID?:string):Task {
    if(p.host_ids!==null&&!hostID)fail(403,"host_id_required");
    if(hostID){this.host(p,hostID);const task=this.options.taskCenter.nodes.effectiveHostTasks(hostID).find(t=>t.id===id);if(!task)fail(404,"resource_not_found");return task;}
    return this.options.taskCenter.nodes.getTask(id);
  }
  private index(run:any) {
    this.deps.db.run("INSERT INTO execution_index(id,domain,native_id,host_id,state,updated_at) VALUES(?,'task',?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at", "task:"+run.id,run.id,run.host_id,run.state,this.deps.now().toISOString());
  }
  private execution(p:Principal,run:any) {
    this.authorize(p,"executions.read");
    this.host(p,run.host_id);this.index(run);
    return {...runMetadata(run),execution_id:"task:"+run.id,native_ref:{domain:"task",id:run.id},native_state:run.state,review_url:this.review("/machines?tab=tasks&run="+encodeURIComponent(run.id))};
  }
  private review(path:string) {return new URL(path,this.deps.externalURL).href;}
  private proposalView(p:Principal,id:string):any {
    const origin=this.proposals.source(p.user,id);
    if(p.host_ids!==null&&(origin?.source!=="mcp"||origin.grant_id!==p.grant_id))fail(404,"resource_not_found");
    const v=this.proposals.get(p.user,id),result=v.result as any;
    if(p.host_ids!==null) {
      const preview=v.preview as any;
      const targets=Array.isArray(preview?.hosts)?preview.hosts.map((h:any)=>h.id):preview?.run?.host_id?[preview.run.host_id]:[];
      if(!targets.length||targets.some((hostID:string)=>!this.allowedHost(p,hostID)))fail(404,"resource_not_found");
    }
    // A task proposal grants visibility of the proposal and its references, not
    // execution receipts. This projection is shared by reads and idempotent plan replies.
    const runView=(r:any)=>p.scopes.includes("executions.read")
      ?this.execution(p,this.options.taskCenter.get(r.id)):{id:r.id,execution_id:"task:"+r.id};
    const safeResult=result?.runs?{runs:result.runs.map(runView)}:result?.host_id?runView(result):undefined;
    return {proposal:{id:v.id,operation:v.operation,task_id:v.task_id,run_id:v.run_id,status:v.status,expires_at:v.expires_at,applied_at:v.applied_at,review_url:this.review(v.review_url),...(safeResult?{result:safeResult}:{})}};
  }
  private plan(p:Principal,i:any,c:InvocationContext):any {
    if(i.operation==="task.dispatch") {
      if(!i.task_id||i.run_id)fail(400,"invalid_input");
      if(p.host_ids!==null&&!i.host_ids)fail(403,"explicit_hosts_required");
      if(i.host_ids)for(const id of i.host_ids)this.host(p,id);
      this.task(p,i.task_id,p.host_ids!==null?i.host_ids[0]:undefined);
      if(p.host_ids!==null)for(const id of i.host_ids)this.task(p,i.task_id,id);
    } else {
      if(!i.run_id||i.task_id||i.host_ids)fail(400,"invalid_input");
      this.host(p,this.options.taskCenter.get(i.run_id).host_id);
    }
    const {idempotency_key,...intent}=i;
    if(intent.host_ids)intent.host_ids=[...intent.host_ids].sort();
    const keyHash=digest(idempotency_key),inputHash=digest(intent);
    return this.deps.db.transaction(()=>{
      const old=this.deps.db.get<{input_hash:string;proposal_id:string}>("SELECT input_hash,proposal_id FROM capability_idempotency WHERE installation_id=? AND user_id=? AND capability='lightmoni_tasks_plan' AND key_hash=?",this.installationID,p.user.id,keyHash);
      if(old){if(old.input_hash!==inputHash)fail(409,"idempotency_conflict");return {...this.proposalView(p,old.proposal_id),idempotency_replayed:true};}
      const source:ProposalSource={source:p.source,grant_id:p.grant_id,credential_id:p.credential_id,...(c.session_id?{session_id:c.session_id}:{})};
      if(p.source==="assistant"&&!source.session_id)fail(400,"assistant_session_required");
      const v=this.proposals.createFrom(p.user,source,intent);
      this.deps.db.run("INSERT INTO capability_idempotency(installation_id,user_id,capability,key_hash,input_hash,proposal_id,created_at) VALUES(?,?,'lightmoni_tasks_plan',?,?,?,?)",this.installationID,p.user.id,keyHash,inputHash,v.id,this.deps.now().toISOString());
      return this.proposalView(p,v.id);
    });
  }
  list(principal:Principal) {
    this.authority.validate(principal);
    return this.definitions.filter(d=>principal.user.role==="admin"&&principal.scopes.includes(d.scope)&&(!d.allHosts||principal.host_ids===null)).map(({name,description,inputSchema,effect})=>({name,description,inputSchema,effect}));
  }
  async invoke(principal:Principal,name:string,input:unknown,context:InvocationContext):Promise<Record<string,any>> {
    const invocationID=randomUUID(),at=this.deps.now().toISOString();
    // Audit stores a digest, never scripts, output, secrets or supplied identity fields.
    let inputHash="invalid";try{inputHash=digest(input);}catch{}
    this.deps.db.run("INSERT INTO capability_invocations(id,user_id,credential_id,source,capability,input_hash,decision,created_at) VALUES(?,?,?,?,?,?,'started',?)",invocationID,principal.user.id,principal.credential_id,principal.source,/^[a-z0-9_]{1,80}$/.test(name)?name:"invalid",inputHash,at);
    try {
      this.authority.validate(principal);context.signal.throwIfAborted();
      const d=this.definitions.find(d=>d.name===name);if(!d)fail(404,"capability_not_found");
      this.authorize(principal,d.scope,d.allHosts);
      if(Buffer.byteLength(JSON.stringify(input)??"")>16<<10)fail(413,"input_too_large");validate(input,d.inputSchema);
      const data=await d.execute(principal,input,context);
      const response={schema_version:1,invocation_id:invocationID,kind:d.effect==="propose"?"proposal":"read",status:d.effect==="propose"?(data as any)?.proposal?.status??"awaiting_approval":"completed",data};
      if(Buffer.byteLength(JSON.stringify(response))>64<<10)fail(413,"result_too_large");
      const proposalID=(data as any)?.proposal?.id??"";
      this.deps.db.run("UPDATE capability_invocations SET decision=?,finished_at=?,proposal_id=? WHERE id=?",(data as any)?.idempotency_replayed?"idempotency_hit":"allowed",this.deps.now().toISOString(),proposalID,invocationID);
      return response;
    } catch(error) {
      const status=error&&typeof error==="object"&&"status" in error?Number(error.status):500;
      const code=status===403?"forbidden":status===404?"not_found":status===409?"conflict":status===400?"invalid_input":context.signal.aborted?"cancelled":"unavailable";
      this.deps.db.run("UPDATE capability_invocations SET decision='denied',code=?,finished_at=? WHERE id=?",code,this.deps.now().toISOString(),invocationID);
      if(error instanceof HTTPError||error instanceof NodeError)throw error;
      if(error&&typeof error==="object"&&"status" in error)fail(status,status>=500?"capability_unavailable":String((error as {message?:unknown}).message??"capability_failed"));
      throw error;
    }
  }
  /** Existing internal task tools retain their names but share the capability policy and receipts. */
  assistantTools() {
    const map:Record<string,string>={list_tasks:"lightmoni_tasks_list",get_task:"lightmoni_tasks_get",list_task_runs:"lightmoni_executions_list",get_task_run:"lightmoni_executions_get",get_task_proposal:"lightmoni_proposals_get"};
    const shared = Object.entries(map).map(([name,target])=>{
      const d=this.definitions.find(x=>x.name===target)!;
      return {name,description:d.description,schema:d.inputSchema,effect:"read" as const,execute:async(input:any,signal:AbortSignal,user?:{id:string;role:string},scope?:{session_id:string})=>{
        if(!user)fail(401,"login_required");const p=this.authority.sessionPrincipal(user as User,"assistant");
        const v=await this.invoke(p,target,{...input,...(name==="get_task"?{include_source:true}:{})},{signal,session_id:scope?.session_id});return v.data;
      }};
    });
    const old=taskTools(this.proposals).find(t=>t.name==="propose_task_action")!;
    return [...shared,{...old,execute:async(input:any,signal:AbortSignal,user?:{id:string;role:string},scope?:{session_id:string})=>{
      if(!["task.dispatch","run.cancel","run.retry"].includes(input?.operation))return old.execute(input,signal,user,scope);
      if(!user)fail(401,"login_required");
      const p=this.authority.sessionPrincipal(user as User,"assistant");
      const result=await this.invoke(p,"lightmoni_tasks_plan",{...input,idempotency_key:randomUUID()},{signal,session_id:scope?.session_id});
      return result.data;
    }}];
  }
}
export function registerCapabilities(deps:Dependencies,dispatcher:CapabilityDispatcher,authority:AccessAuthority) {
  deps.router.get("/api/v1/capabilities",c=>c.json(dispatcher.list(authority.sessionPrincipal(c.user,"web"))));
  deps.router.post("/api/v1/capabilities/:name/invoke",async c=>{
    let input:unknown;
    try {input=JSON.parse((await c.raw(16<<10)).toString());}
    catch(error){if(error instanceof HTTPError)throw error;fail(400,"invalid_input");}
    c.json(await dispatcher.invoke(authority.sessionPrincipal(c.user,"web"),c.params.name,input,{signal:c.signal}));
  });
}
