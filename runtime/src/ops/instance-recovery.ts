import {blockingAgentJobSQL} from '../server/agent-job-fence.js';
import { operationExecutionCapabilities } from "../server/managed-executor-status.js";
import { hash } from "../operations/website-files.js";
import { fail } from "../shared/http.js";
import { hasActiveTaskRuns } from "../server/agent-hosts.js";
import type { PlatformStore, PlatformRun } from "./types.js";
import type {Handler} from '../shared/types.js';
import {id} from '../shared/crypto.js';
type Row = Record<string, any>;
const active = [
  "queued",
  "leased",
  "accepted",
  "preflighting",
  "staging",
  "activating",
  "verifying",
  "running",
  "unknown",
];
export const INSTANCE_RECOVERY_CAPABILITY =
  "operations.platform.instance-recovery.v1";
export const INSTANCE_RECOVERY_REVIEW_CAPABILITY='operations.platform.instance-recovery-review.v1';
export function createInstanceRecoverySchema(store: PlatformStore) {
  store.deps.db.exec(
    `CREATE TABLE IF NOT EXISTS ops_instance_recoveries(instance_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);`,
  );
  store.deps.db.exec(`CREATE TABLE IF NOT EXISTS ops_workload_recoveries(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL DEFAULT '',revision TEXT NOT NULL DEFAULT '',proof_json TEXT NOT NULL DEFAULT '{}',
    run_id TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',receipt_json TEXT NOT NULL DEFAULT '{}',approved_by TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS ops_workload_recovery_lane ON ops_workload_recoveries(machine_id) WHERE status IN ('preparing','awaiting_approval','verifying','unknown');`);
}
function online(store: PlatformStore, id: string) {
  const a = store.deps.db.get<Row>(
    "SELECT * FROM agents WHERE id=? AND NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed')",
    id,
  );
  return !!a && store.deps.now().getTime() - Date.parse(a.last_seen) < 120000;
}
function snapshot(store: PlatformStore, i: Row) {
  const m = store.deps.db.get<Row>(
    "SELECT * FROM managed_machines WHERE id=?",
    i.machine_id,
  );
  if (!m) return;
  return {
    instance_id: i.id,
    owner_id: i.owner_id,
    machine_id: i.machine_id,
    old_agent_id: i.agent_id,
    current_agent_id: m.agent_id,
    current_run_id: i.current_run_id,
    desired_generation: i.desired_generation,
    desired_state: i.desired_state,
    state: i.state,
    retired: i.retired,
    target: hash(
      JSON.stringify([
        m.address,
        m.port,
        m.username,
        m.ssh_target_generation,
        m.host_key_fingerprint,
      ]),
    ),
  };
}
function unresolved(store: PlatformStore, i: Row) {
  const audited=`NOT (state='unknown' AND EXISTS (SELECT 1 FROM agent_jobs recovered_job WHERE recovered_job.id=ops_platform_runs.job_id AND recovered_job.agent_id=ops_platform_runs.agent_id AND recovered_job.state='unknown' AND NOT (${blockingAgentJobSQL(store.deps.db,'recovered_job')})))`;
  const current=i.state==='unknown'&&store.deps.db.get('SELECT id FROM ops_platform_runs WHERE id=? AND agent_id=? AND NOT ('+audited+')',i.current_run_id,i.agent_id);
  return (
    i.state === "unknown" && !current ||
    !!store.deps.db.get(
      "SELECT id FROM ops_platform_runs WHERE agent_id=? AND state IN (" +
        active.map(() => "?").join(",") +
        ") AND "+audited+" LIMIT 1",
      i.agent_id,
      ...active,
    ) ||
    !!store.deps.db.get(
      `SELECT id FROM agent_jobs WHERE agent_id=? AND ${blockingAgentJobSQL(store.deps.db)} LIMIT 1`,
      i.agent_id,
    ) ||
    hasActiveTaskRuns(store.deps.db, i.agent_id)
  );
}
function dataReviewRequired(store: PlatformStore, i: Row) {
  const specs = [
    store.get(i.owner_id).spec,
    ...store.deps.db
      .all<Row>(
        "SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision IN (?,?)",
        i.owner_id,
        Number(i.observed_generation) || 0,
        Number(i.desired_generation) || 0,
      )
      .map((r) => JSON.parse(store.deps.decrypt(r.spec_cipher))),
  ];
  return specs.some(
    (s) =>
      s.stateful === true ||
      s.mounts?.some((m: Row) => ["data", "volume", "init"].includes(m.type)) ||
      Object.values<Row>(s.compose?.services ?? {}).some(
        (service) => service.volumes?.length,
      ),
  );
}
export function validateInstanceRecoveryPayload(
  store: PlatformStore,
  config: Row,
  agentID: string,
) {
  if (config.task !== "instance.recovery.inspect") return;
  if(config.recovery_review){validateReview(store,config,agentID);return;}
  const i = store.deps.db.get<Row>(
    "SELECT * FROM ops_cluster_instances WHERE id=?",
    config.instance_id,
  );
  const current = i && snapshot(store, i);
  if (
    !i ||
    !current ||
    current.current_agent_id !== agentID ||
    current.old_agent_id === agentID ||
    JSON.stringify(current) !== JSON.stringify(config.recovery) ||
    online(store, i.agent_id) ||
    unresolved(store, i)
  )
    fail(409, "instance_recovery_target_changed");
}
/** Only the current authenticated Agent can attest absence on its stable machine binding. */
export function recoverReinstalledInstances(
  store: PlatformStore,
  machineIDs: string[],
  actor: string,
) {
  const { db } = store.deps,
    runs: PlatformRun[] = [],
    blockedMachines = new Set<string>();
  let pending = "";
  for (const machineID of machineIDs) {
    const m = db.get<Row>(
      "SELECT * FROM managed_machines WHERE id=?",
      machineID,
    );
    if (!m?.agent_id || !online(store, m.agent_id)) continue;
    const old = db.all<Row>(
      "SELECT * FROM ops_cluster_instances WHERE machine_id=? AND agent_id!=? AND (retired=0 OR state NOT IN ('stopped','removed')) ORDER BY created_at,id",
      machineID,
      m.agent_id,
    );
    if (old.length) blockedMachines.add(machineID);
    for (const i of old) {
      if (dataReviewRequired(store, i)) {
        pending = "agent_reinstall_stateful_review_required";
        continue;
      }
      if (online(store, i.agent_id) || unresolved(store, i)) {
        pending = "agent_reinstall_execution_unresolved";
        continue;
      }
      const caps=operationExecutionCapabilities(store.deps,m.agent_id);
      if (
        !Array.isArray(caps) ||
        !caps.includes(INSTANCE_RECOVERY_CAPABILITY)
      ) {
        pending = "agent_reinstall_upgrade_required";
        continue;
      }
      const previous = db.get<Row>(
          "SELECT * FROM ops_instance_recoveries WHERE instance_id=?",
          i.id,
        ),
        target = snapshot(store, i)!;
      const run =
        previous &&
        db.get<Row>(
          "SELECT state FROM ops_platform_runs WHERE id=?",
          previous.run_id,
        );
      if (previous && previous.snapshot_json === JSON.stringify(target)) {
        if (run && active.includes(run.state) && run.state !== "unknown") {
          pending = "agent_reinstall_inspecting";
          continue;
        }
        if (
          store.deps.now().getTime() - Date.parse(previous.updated_at) <
          30000
        ) {
          pending = previous.status;
          continue;
        }
      }
      const owner = store.get(i.owner_id),
        by = store.authorized(owner.authorized_by)
          ? owner.authorized_by
          : actor;
      const queued = store.queue(
        owner,
        m.agent_id,
        "inspect",
        {
          task: "instance.recovery.inspect",
          instance_id: i.id,
          cluster_id: i.cluster_id,
          recovery: target,
        },
        by,
      );
      db.run(
        "INSERT INTO ops_instance_recoveries VALUES(?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET run_id=excluded.run_id,snapshot_json=excluded.snapshot_json,status=excluded.status,updated_at=excluded.updated_at",
        i.id,
        queued.id,
        JSON.stringify(target),
        "agent_reinstall_inspecting",
        store.deps.now().toISOString(),
      );
      runs.push(queued);
      pending = "agent_reinstall_inspecting";
    }
  }
  return { runs, pending, blockedMachines };
}
export function recordInstanceRecovery(
  store: PlatformStore,
  run: PlatformRun,
  config: Row,
) {
  if (config.task !== "instance.recovery.inspect") return false;
  if(config.recovery_review)return recordReview(store,run,config);
  if (!["succeeded", "failed", "unknown", "cancelled"].includes(run.state))
    return true;
  const { db } = store.deps,
    at = store.deps.now().toISOString();
  // AgentJob result notifications execute inside the existing receipt transaction.
  const previous = db.get<Row>(
    "SELECT * FROM ops_instance_recoveries WHERE instance_id=? AND run_id=?",
    config.instance_id,
    run.id,
  );
  if (!previous) return true;
  let status = "agent_reinstall_inspection_failed",
    valid = false;
  const result = run.result;
  try {
    validateInstanceRecoveryPayload(store, config, run.agent_id);
    valid =
      run.state === "succeeded" &&
      result.instance_id === config.instance_id &&
      Number.isSafeInteger(result.container_count) &&
      result.container_count >= 0 &&
      result.container_count <= 300 &&
      result.absent === (result.container_count === 0) &&
      Date.parse(result.observed_at) >= Date.parse(run.created_at) &&
      Date.parse(result.observed_at) <= store.deps.now().getTime() + 30000;
  } catch {
    /* A stale binding or unresolved old execution cannot release reservations. */
  }
  if (valid) {
    status = "agent_reinstall_containers_remain";
    if (result.absent) {
      const i = db.get<Row>(
        "SELECT * FROM ops_cluster_instances WHERE id=?",
        config.instance_id,
      )!;
      const observed = JSON.parse(i.observed_json);
      observed.agent_recovery = {
        run_id: run.id,
        previous_agent_id: i.agent_id,
        current_agent_id: run.agent_id,
        verified_at: at,
        container_count: 0,
        scope: "current_machine_binding",
      };
      // Do not catch storage errors: the outer receipt transaction must roll back every mutation.
      db.run(
        "UPDATE ops_cluster_instances SET retired=1,state='removed',desired_state='removed',healthy=0,serving=0,current_run_id='',observed_json=?,updated_at=? WHERE id=?",
        JSON.stringify(observed),
        at,
        i.id,
      );
      db.run("DELETE FROM ops_platform_ports WHERE instance_id=?", i.id);
      status = "completed";
    }
  }
  db.run(
    "UPDATE ops_instance_recoveries SET status=?,updated_at=? WHERE instance_id=? AND run_id=?",
    status,
    at,
    config.instance_id,
    run.id,
  );
  return true;
}

/** Accept older retired/stopped rows only with the original authenticated absence receipt. */
export function instanceRemovalConfirmed(store: PlatformStore, i: Row): boolean {
  if (i.state === 'removed') return true;
  if (!i.retired || i.state !== 'stopped' || i.desired_state !== 'removed' || i.current_run_id
    || online(store, i.agent_id) || unresolved(store, i)) return false;
  try {
    const audit = JSON.parse(i.observed_json).agent_recovery;
    if (audit?.scope !== 'current_machine_binding' || audit.container_count !== 0
      || audit.previous_agent_id !== i.agent_id || !audit.run_id) return false;
    const machine = store.deps.db.get<Row>('SELECT agent_id FROM managed_machines WHERE id=?', i.machine_id);
    if (!machine?.agent_id || machine.agent_id !== audit.current_agent_id || machine.agent_id === i.agent_id) return false;
    const proof = store.deps.db.get<Row>(`SELECT recovery.snapshot_json,run.result_json FROM ops_instance_recoveries recovery
      JOIN ops_platform_runs run ON run.id=recovery.run_id
      WHERE recovery.instance_id=? AND recovery.run_id=? AND recovery.status='completed'
        AND run.resource_id=? AND run.agent_id=? AND run.state='succeeded'`,
      i.id, audit.run_id, i.owner_id, machine.agent_id);
    if (!proof) return false;
    const target = JSON.parse(proof.snapshot_json), result = JSON.parse(proof.result_json);
    return target.instance_id === i.id && target.owner_id === i.owner_id && target.machine_id === i.machine_id
      && target.old_agent_id === i.agent_id && target.current_agent_id === machine.agent_id
      && result.instance_id === i.id && result.absent === true && result.container_count === 0;
  } catch { return false; }
}

function reviewSnapshot(store:PlatformStore,machineID:string){
 const {db}=store.deps,m=db.get<Row>('SELECT * FROM managed_machines WHERE id=?',machineID);
 if(!m?.agent_id||!online(store,m.agent_id))fail(409,'workload_recovery_agent_offline');
 if(!operationExecutionCapabilities(store.deps,m.agent_id).includes(INSTANCE_RECOVERY_REVIEW_CAPABILITY))fail(409,'workload_recovery_agent_upgrade_required');
 const instances=db.all<Row>("SELECT * FROM ops_cluster_instances WHERE machine_id=? AND agent_id!=? AND (retired=0 OR state NOT IN ('stopped','removed')) ORDER BY id",machineID,m.agent_id);
 if(!instances.length||instances.length>50)fail(409,'workload_recovery_instance_count');
 const entries=instances.map(i=>{
  if(online(store,i.agent_id)||unresolved(store,i))fail(409,'agent_reinstall_execution_unresolved');
  const owner=store.get(i.owner_id,'application');
  if(db.get('SELECT 1 FROM ops_platform_ports WHERE instance_id=? AND agent_id!=?',i.id,i.agent_id))fail(409,'workload_recovery_port_conflict');
  return {...snapshot(store,i),cluster_id:i.cluster_id,name:owner.name,role:owner.spec.role,
   stateful:dataReviewRequired(store,i),last_ready_at:i.last_ready_at||'',resource_revision:owner.revision,
   resource_hash:hash(JSON.stringify(owner.spec)),ports:db.all<Row>('SELECT * FROM ops_platform_ports WHERE instance_id=? ORDER BY protocol,port',i.id),
   mappings:db.all<Row>('SELECT * FROM ops_platform_instance_ports WHERE instance_id=? ORDER BY name',i.id)};
 });
 const runtime=db.get("SELECT 1 FROM sqlite_master WHERE name='machine_agent_runtime'")?db.get('SELECT * FROM machine_agent_runtime WHERE machine_id=?',machineID):undefined;
 return {machine:{id:m.id,name:m.name,agent_id:m.agent_id,target:hash(JSON.stringify([m.address,m.port,m.username,m.ssh_target_generation,m.host_key_fingerprint])),runtime:runtime??null},instances:entries};
}
function reviewRow(store:PlatformStore,planID:string,machineID?:string){
 const row=store.deps.db.get<Row>('SELECT * FROM ops_workload_recoveries WHERE id=?',planID);
 if(!row||machineID&&row.machine_id!==machineID)fail(404,'workload_recovery_not_found');return row;
}
function reviewView(row:Row){const proof=JSON.parse(row.proof_json);return {id:row.id,machine_id:row.machine_id,status:row.status,reason:row.reason,created_by:row.created_by,approved_by:row.approved_by,created_at:row.created_at,expires_at:row.expires_at,revision:row.revision,error:row.error,run_id:row.run_id,
 snapshot:JSON.parse(row.snapshot_json),proof:Array.isArray(proof)?proof:[],receipt:JSON.parse(row.receipt_json)};}
function reviewInput(row:Row,stage:'plan'|'apply'){
 const value=JSON.parse(row.snapshot_json);
 return {task:'instance.recovery.inspect',storage_layout:2,instance_id:value.instances[0].instance_id,cluster_id:value.instances[0].cluster_id,
  recovery_review:{plan_id:row.id,stage,instances:value.instances.map((i:Row)=>({instance_id:i.instance_id,owner_id:i.owner_id,kind:i.role==='openresty'?'gateway':'workload'}))}};
}
function validateReview(store:PlatformStore,config:Row,agentID:string){
 const row=reviewRow(store,config.recovery_review?.plan_id),stage=config.recovery_review?.stage;
 if(!['plan','apply'].includes(stage)||row.agent_id!==agentID||row.status!==(stage==='plan'?'preparing':'verifying')||!store.authorized(row.created_by)||stage==='apply'&&!store.authorized(row.approved_by)
  ||JSON.stringify(reviewInput(row,stage as 'plan'|'apply'))!==JSON.stringify(config)
  ||JSON.stringify(reviewSnapshot(store,row.machine_id))!==row.snapshot_json
  ||stage==='apply'&&Date.parse(row.expires_at)<=store.deps.now().getTime())fail(409,'workload_recovery_target_changed');
 return row;
}
function proofFor(store:PlatformStore,row:Row,run:PlatformRun,config:Row){
 const result=run.result,entries=JSON.parse(row.snapshot_json).instances;
 if(result.recovery_plan_id!==row.id||result.stage!==config.recovery_review.stage||!Array.isArray(result.instances)||result.instances.length!==entries.length
  ||!Number.isFinite(Date.parse(result.observed_at))||Date.parse(result.observed_at)<Date.parse(run.created_at)||Date.parse(result.observed_at)<store.deps.now().getTime()-90000||Date.parse(result.observed_at)>store.deps.now().getTime()+30000)fail(409,'workload_recovery_invalid_proof');
 return entries.map((entry:Row,index:number)=>{
  const p=result.instances[index];
  if(p?.instance_id!==entry.instance_id||p.owned!==true||!Array.isArray(p.containers)||p.containers.length>100||p.containers.some((v:any)=>typeof v!=='string'||!/^[a-f0-9]{12,64}$/.test(v))
   ||new Set(p.containers).size!==p.containers.length||!Array.isArray(p.mounts)||p.mounts.length>1000||p.mounts.some((m:any)=>!m||!p.containers.includes(m.container_id)||!['bind','volume'].includes(m.type)||typeof m.read_only!=='boolean'||![m.source,m.target].every((v:any)=>typeof v==='string'&&v.startsWith('/')&&v.length<=1024&&!/[\u0000-\u001f\u007f]/.test(v)))||typeof p.managed_state!=='boolean'||typeof p.data_present!=='boolean'
   ||typeof p.data_path!=='string'||p.data_path.length>1024||!p.data_path.endsWith(entry.role==='openresty'?'/gateways/'+entry.instance_id:'/applications/'+entry.owner_id+'/instances/'+entry.instance_id)
   ||!/^[a-f0-9]{64}$/.test(p.inventory_sha256)||!(p.state_sha256===''&&!p.managed_state||p.managed_state&&/^[a-f0-9]{64}$/.test(p.state_sha256)))fail(409,'workload_recovery_invalid_proof');
  const retire=!p.containers.length&&!p.data_present&&!p.managed_state&&(!entry.last_ready_at||entry.desired_state==='removed');
  const retained=entry.desired_state==='removed'&&!p.containers.length&&p.data_present;
  if(!retire&&!retained&&(!p.managed_state||!p.data_present))fail(409,'workload_recovery_managed_state_required');
  return {...p,action:retire?'retire_absent':retained?'retire_retained':'restore_binding'};
 });
}
function recordReview(store:PlatformStore,run:PlatformRun,config:Row){
 if(!['succeeded','failed','unknown','cancelled'].includes(run.state))return true;
 const row=store.deps.db.get<Row>('SELECT * FROM ops_workload_recoveries WHERE id=? AND run_id=?',config.recovery_review.plan_id,run.id);
 if(!row||!['preparing','verifying'].includes(row.status))return true;
 const {db}=store.deps;let proof:Row[];
 try{validateReview(store,config,run.agent_id);if(run.state!=='succeeded')fail(409,run.result.code==='instance_recovery_ownership_unverified'?'workload_recovery_ownership_unverified':'workload_recovery_inspection_failed');proof=proofFor(store,row,run,config);
  if(row.status==='verifying'&&JSON.stringify(proof)!==row.proof_json)fail(409,'workload_recovery_inventory_changed');
  if(row.status==='verifying')for(const p of proof.filter(p=>p.action==='restore_binding')){
   const ports=db.all<Row>('SELECT protocol,port FROM ops_platform_ports WHERE instance_id=?',p.instance_id);
   for(const port of ports)if(db.get('SELECT 1 FROM ops_platform_ports WHERE agent_id=? AND protocol=? AND port=? AND instance_id!=?',row.agent_id,port.protocol,port.port,p.instance_id))fail(409,'workload_recovery_port_conflict');
  }
 }catch(e:any){db.run("UPDATE ops_workload_recoveries SET status=?,error=? WHERE id=?",run.state==='unknown'?'unknown':'failed',/^workload_recovery_|^agent_reinstall_/.test(e.message)?e.message:'workload_recovery_inspection_failed',row.id);return true;}
 const at=store.deps.now().toISOString();
 if(row.status==='preparing'){
  const expires=new Date(store.deps.now().getTime()+300000).toISOString(),text=JSON.stringify(proof);
  db.run("UPDATE ops_workload_recoveries SET status='awaiting_approval',proof_json=?,expires_at=?,revision=? WHERE id=?",text,expires,hash(JSON.stringify([row.snapshot_json,text,expires,row.reason])),row.id);return true;
 }
 // The existing Agent result transaction rolls back all transfers on any storage failure.
 const original=JSON.parse(row.snapshot_json);
 for(const p of proof){
  const old=original.instances.find((i:Row)=>i.instance_id===p.instance_id),i=db.get<Row>('SELECT * FROM ops_cluster_instances WHERE id=?',p.instance_id)!;
  const audit={plan_id:row.id,previous_agent_id:i.agent_id,current_agent_id:row.agent_id,actor:row.approved_by,reason:row.reason,verified_at:at,inventory_sha256:p.inventory_sha256,data_path:p.data_path,action:p.action};
  if(p.action==='retire_absent'||p.action==='retire_retained'){
   db.run("UPDATE ops_cluster_instances SET retired=1,state='removed',healthy=0,serving=0,current_run_id='',observed_json=?,updated_at=? WHERE id=?",JSON.stringify({...JSON.parse(i.observed_json),agent_recovery:audit}),at,i.id);
   db.run('DELETE FROM ops_platform_ports WHERE instance_id=?',i.id);
  }else{
   db.run("UPDATE ops_cluster_instances SET agent_id=?,state=?,healthy=0,last_seen='',observed_generation='',current_run_id='',last_bundle_sig='',observed_json=?,updated_at=? WHERE id=?",row.agent_id,old.desired_state==='running'?'running':old.desired_state,JSON.stringify({agent_recovery:audit}),at,i.id);
   db.run('UPDATE ops_platform_ports SET agent_id=? WHERE instance_id=?',row.agent_id,i.id);
  }
 }
 db.run("UPDATE ops_workload_recoveries SET status='succeeded',receipt_json=? WHERE id=?",JSON.stringify({finished_at:at,agent_id:row.agent_id,instances:proof.map(p=>({instance_id:p.instance_id,action:p.action,data_path:p.data_path})),data_retained:true,remote_writes:false}),row.id);
 return true;
}
export function registerInstanceRecoveryReview(store:PlatformStore,safe:(fn:Handler)=>Handler){
 const {db,router}=store.deps,base='/api/v1/machines/:id/workload-recoveries';
 const read=(ctx:any)=>reviewRow(store,ctx.params.operation,ctx.params.id);
 const input=async(ctx:any,keys:string[])=>{const b=await ctx.body();if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))fail(400,'invalid_workload_recovery_input');return b;};
 router.get(base,safe(ctx=>ctx.json(db.all<Row>('SELECT * FROM ops_workload_recoveries WHERE machine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20',ctx.params.id).map(reviewView))));
 router.get(base+'/:operation',safe(ctx=>ctx.json(reviewView(read(ctx)))));
 router.post(base+'/plan',safe(async ctx=>{
  const b=await input(ctx,['reason']);if(typeof b.reason!=='string'||!b.reason.trim()||Buffer.byteLength(b.reason)>1000||/[\u0000-\u001f\u007f]/.test(b.reason))fail(400,'workload_recovery_reason_required');
  const rowID=id(),at=store.deps.now().toISOString();
  db.transaction(()=>{
   db.run("UPDATE ops_workload_recoveries SET status='expired' WHERE machine_id=? AND status='awaiting_approval' AND expires_at<=?",ctx.params.id,at);
   if(db.get("SELECT 1 FROM ops_workload_recoveries WHERE machine_id=? AND status IN ('preparing','awaiting_approval','verifying','unknown')",ctx.params.id))fail(409,'workload_recovery_pending');
   const target=reviewSnapshot(store,ctx.params.id);
   db.run("INSERT INTO ops_workload_recoveries(id,machine_id,agent_id,status,snapshot_json,reason,created_by,created_at) VALUES(?,?,?,'preparing',?,?,?,?)",rowID,ctx.params.id,target.machine.agent_id,JSON.stringify(target),b.reason.trim(),ctx.user.id,at);
   const row=reviewRow(store,rowID),owner=store.get(target.instances[0].owner_id);
   const run=store.queue(owner,row.agent_id,'inspect',reviewInput(row,'plan'),ctx.user.id,'workload-recovery:'+rowID+':plan');
   db.run('UPDATE ops_workload_recoveries SET run_id=? WHERE id=?',run.id,rowID);
  });ctx.json(reviewView(reviewRow(store,rowID)),201);
 }));
 router.post(base+'/:operation/apply',safe(async ctx=>{
  const b=await input(ctx,['revision','confirm']);
  db.transaction(()=>{
   const row=read(ctx);if(b.confirm!==true||b.revision!==row.revision||!row.revision)fail(409,'workload_recovery_review_required');
   if(['verifying','succeeded'].includes(row.status))return;
   if(row.status!=='awaiting_approval'||Date.parse(row.expires_at)<=store.deps.now().getTime())fail(409,'workload_recovery_plan_expired');
   if(JSON.stringify(reviewSnapshot(store,row.machine_id))!==row.snapshot_json)fail(409,'workload_recovery_target_changed');
   db.run("UPDATE ops_workload_recoveries SET status='verifying',approved_by=? WHERE id=?",ctx.user.id,row.id);
   const current=reviewRow(store,row.id),owner=store.get(JSON.parse(row.snapshot_json).instances[0].owner_id);
   const run=store.queue(owner,row.agent_id,'inspect',reviewInput(current,'apply'),ctx.user.id,'workload-recovery:'+row.id+':apply');
   db.run('UPDATE ops_workload_recoveries SET run_id=? WHERE id=?',run.id,row.id);
  });ctx.json(reviewView(read(ctx)));
 }));
 router.post(base+'/:operation/cancel',safe(async ctx=>{
  await input(ctx,[]);const row=read(ctx);if(!['preparing','awaiting_approval','cancelled','expired','failed'].includes(row.status))fail(409,'workload_recovery_cancel_not_available');
  if(['preparing','awaiting_approval'].includes(row.status))db.run("UPDATE ops_workload_recoveries SET status='cancelled' WHERE id=?",row.id);ctx.json(reviewView(read(ctx)));
 }));
}
