import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DB } from "../../runtime/dist/shared/sqlite.js";
import { Router } from "../../runtime/dist/shared/http.js";
import { cipher, masterKey } from "../../runtime/dist/shared/crypto.js";
import { registerAgentCredentials } from "../../runtime/dist/server/agent-credentials.js";
import { defaultConfig } from "../../runtime/dist/agent/config.js";
import { PrivilegedExecutorStore } from "../../runtime/dist/server/privileged-executors.js";

const stateFile=process.env.CORE_E2E_STATE_FILE,secretsFile=process.env.CORE_E2E_SECRETS_FILE;
const state=JSON.parse(readFileSync(stateFile,"utf8")),secrets=JSON.parse(readFileSync(secretsFile,"utf8"));
const save=()=>{writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});writeFileSync(secretsFile,JSON.stringify(secrets,null,2),{mode:0o600});};
const db=new DB(state.dbPath),crypto=cipher(masterKey(state.dataDir));
const deps={db,router:new Router(),externalURL:state.externalURL,now:()=>new Date(),...crypto,logger:{info(){},warn(){},error(){}}};
const api=async(path,method="POST",body={},authorization="")=>{
 const response=await fetch(state.centerURL+path,{method,headers:{"content-type":"application/json",...(authorization?{authorization:"Bearer "+authorization}:{})},body:JSON.stringify(body)});
 const text=await response.text();if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${text.slice(0,300)}`);return text?JSON.parse(text):{};
};
try{
 if(process.argv[2]==="setup"){
  const credentials=registerAgentCredentials(deps);
  const enrollment=credentials.issueEnrollment({endpoint_origin:state.externalURL,version:"0.1.0",allowed_arch:[state.arch],created_by:state.adminID,machine_id:state.machineID});
  const deploymentID=randomBytes(16).toString("hex"),at=new Date().toISOString();
  db.run("INSERT INTO machine_deployments(id,machine_id,credential_id,status,version,arch,plan_json,created_at,created_by,enrollment_id,execution_stage) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
   deploymentID,state.machineID,"core-e2e-setup","running","0.1.0",state.arch,JSON.stringify({runtime_mode:"root"}),at,state.adminID,enrollment.enrollment_id,"bootstrap_dispatched");
  const nonce=randomBytes(24).toString("base64url"),publicKey=randomBytes(32).toString("base64");
  const exchanged=await api("/api/v1/agents/enroll","POST",{enrollment_token:enrollment.token_display_once,install_nonce:nonce,agent_public_key:publicKey,version:"0.1.0",arch:state.arch});
  const activated=await api(`/api/v1/agents/${exchanged.agent_id}/activate`,"POST",{install_nonce:nonce,health:{service:"ready",config_checked:true}},exchanged.bootstrap_credential);
  const bootstrap=activated.managed_bootstrap;
  state.agentID=exchanged.agent_id;state.executorID=bootstrap.executor_id;state.setupDeploymentID=deploymentID;
  secrets.agent={control_credential:activated.control_credential,data_credential:activated.data_credential};
  secrets.bootstrap=bootstrap;
  secrets.agentConfig={...defaultConfig(),runtime_mode:"root",permission_generation:1,endpoint:state.externalURL,
    control_credential:activated.control_credential,data_credential:activated.data_credential,data_dir:"/var/lib/lightmoni-agent",listen:"127.0.0.1:4318"};
  save();console.log(JSON.stringify({machine_id:state.machineID,agent_id:state.agentID,executor_id:state.executorID}));
 }else if(process.argv[2]==="status"){
  const machine=db.get("SELECT id,agent_id,agent_last_seen FROM managed_machines WHERE id=?",state.machineID);
  const executor=db.get("SELECT id,state,last_seen FROM privileged_executors WHERE id=?",state.executorID);
  console.log(JSON.stringify({machine,executor}));
 }else if(process.argv[2]==="rebootstrap"){
  const executors=new PrivilegedExecutorStore(deps,{dataDir:state.dataDir});
  // Setup-only cleanup for the pending executor left by the failed container, never a business uninstall.
  db.run("UPDATE privileged_executors SET state='revoked' WHERE machine_id=? AND state='pending'",state.machineID);
  db.run("UPDATE privileged_enrollments SET state='revoked' WHERE executor_id IN (SELECT id FROM privileged_executors WHERE machine_id=?) AND state='issued'",state.machineID);
  const bootstrap=executors.issueUnifiedBootstrap(state.machineID,state.adminID,{deployment_id:state.setupDeploymentID});
  state.executorID=bootstrap.executor_id;secrets.bootstrap=bootstrap;save();console.log(JSON.stringify({executor_id:state.executorID}));
 }else if(process.argv[2]==="run"){
  const run=db.get("SELECT id,state,code,stdout,stderr,exit_code,started_at,finished_at FROM task_runs WHERE id=?",state.runID);
  console.log(JSON.stringify(run));
 }else if(process.argv[2]==="runs"){
  console.log(JSON.stringify(db.all("SELECT id,state,code,retry_of,request_id FROM task_runs ORDER BY created_at,rowid")));
 }else if(process.argv[2]==="finish-setup"){
  const machine=db.get("SELECT agent_id,agent_last_seen FROM managed_machines WHERE id=?",state.machineID),executor=db.get("SELECT last_seen FROM privileged_executors WHERE id=? AND state='active'",state.executorID);
  if(machine?.agent_id!==state.agentID||!machine?.agent_last_seen||!executor?.last_seen)throw Error("setup heartbeat is not ready");
  const at=new Date().toISOString();db.run("UPDATE machine_deployments SET status='succeeded',execution_stage='succeeded',finished_at=?,receipt_json=? WHERE id=? AND status='running'",at,JSON.stringify({setup_activation_observed:true}),state.setupDeploymentID);
  console.log(JSON.stringify({setup_deployment_id:state.setupDeploymentID,status:"succeeded"}));
 }else if(process.argv[2]==="latest-proposal"){
  const kind=process.argv[3],table=kind==="alert"?"assistant_alert_proposals":"assistant_task_proposals";
  const row=db.get(`SELECT id,owner_id,session_id FROM ${table} ORDER BY rowid DESC LIMIT 1`);console.log(JSON.stringify(row));
 }else throw Error("unknown native setup action");
}finally{db.close();}
