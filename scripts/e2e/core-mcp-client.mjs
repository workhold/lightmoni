import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root=resolve(new URL("../..",import.meta.url).pathname),work=process.env.LIGHTMONI_CORE_E2E_DIR??"/tmp/lightmoni-core-e2e";
const stateFile=join(work,"state.json"),secretsFile=join(work,"secrets.json"),state=JSON.parse(readFileSync(stateFile,"utf8")),secrets=JSON.parse(readFileSync(secretsFile,"utf8"));
const save=()=>writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(path,method="GET",body,expected=[])=>{
 const response=await fetch(state.centerURL+path,{method,headers:{"content-type":"application/json",cookie:secrets.cookie,origin:state.externalURL},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let data;try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
 if(!response.ok&&!expected.includes(response.status))throw Error(`${method} ${path}: ${response.status} ${text.slice(0,500)}`);return{status:response.status,data};
};
const native=(action,kind="")=>execFileSync(process.execPath,["scripts/e2e/core-mcp-native-setup.mjs",action,kind],{cwd:root,encoding:"utf8",env:{...process.env,CORE_E2E_STATE_FILE:stateFile,CORE_E2E_SECRETS_FILE:secretsFile}}).trim();
const codex=async(name,prompt,restricted=false)=>{
 mkdirSync(join(work,"client"),{recursive:true,mode:0o700});
 const out=createWriteStream(join(work,name+".jsonl")),last=join(work,name+".txt");
 const args=["exec","--ephemeral","--skip-git-repo-check","-s","read-only","--json","-o",last,
  "-c",`mcp_servers.lightmoni.url="${state.centerURL}/api/v1/mcp"`,"-c",'mcp_servers.lightmoni.bearer_token_env_var="LIGHTMONI_MCP_TOKEN"',prompt];
 const child=spawn("codex",args,{cwd:join(work,"client"),env:{...process.env,LIGHTMONI_MCP_TOKEN:restricted?secrets.restrictedPat:secrets.pat},stdio:["ignore","pipe","pipe"]});
 child.stdout.pipe(out);child.stderr.pipe(out);
 const timeout=setTimeout(()=>child.kill("SIGTERM"),240_000);const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});clearTimeout(timeout);out.end();
 if(code!==0)throw Error(`Codex ${name} exited ${code}; see ${join(work,name+".jsonl")}`);
 const message=existsSync(last)?readFileSync(last,"utf8").trim():"";console.log(`\n[${name}]\n${message}`);return message;
};
const taskIntent=()=>({operation:"task.dispatch",task_id:state.taskID,host_ids:[state.machineID],reason:"Core E2E reviewed task dispatch",idempotency_key:"core-e2e-task-ssh3-"+state.suffix});
const taskPrompt=()=>`只使用 LightMoni MCP 工具，不执行 shell、不读写文件、不审批。请调用 lightmoni_tasks_plan，输入严格为 ${JSON.stringify(taskIntent())}。返回 data.proposal 的 id、status 和 review_url；不要声称任务已经执行。`;
const action=process.argv[2];
if(action==="read"){
 await codex("e2e1-read",`只使用 LightMoni MCP 工具，不执行 shell。先用 lightmoni_telemetry_catalog 查看目录，再用 lightmoni_logs_search 查询真实表 log_app：时间范围 ${new Date(Date.now()-3600000).toISOString()} 到 ${new Date(Date.now()+3600000).toISOString()}，keyword 为 sample payment completed，services 为 ["core-e2e-service"]，limit 5。若目录需要 interval_ms 填 60000，mode 填 filters。报告实际 table_id、返回行数以及一行中的 service/日志内容；不得编造。`);
 await codex("e2e1-denied",`只使用 LightMoni MCP 工具，不执行 shell。即使知道没有权限，也请直接调用 lightmoni_hosts_get，输入 {"id":"${state.machineID}"}，并如实报告服务端拒绝的 detail_code 或错误。不要用其他工具绕过。`,true);
 state.e2e1_completed_at=new Date().toISOString();save();
}else if(action==="silence-propose"){
 const until=new Date(Date.now()+2*3600000).toISOString(),from=new Date(Date.now()-300000).toISOString();state.silenceUntil=until;save();
 await codex("e2e2-propose",`只使用 LightMoni MCP 工具，不执行 shell、不审批。请调用 lightmoni_alerts_plan，输入严格为 ${JSON.stringify({operation:"silence.create",silence:{scope:"all",from,until,reason:"core-e2e maintenance"},reason:"core-e2e silence review",idempotency_key:"core-e2e-silence-"+state.suffix})}。返回 data.proposal.id、status、review_url；不要声称静默已生效。`);
 state.alertProposalID=JSON.parse(native("latest-proposal","alert")).id;save();
}else if(action==="silence-approve"){
 const applied=await api(`/api/v1/assistant/alert-proposals/${state.alertProposalID}/apply`,"POST",{});state.silenceID=applied.data.result?.id??applied.data.result?.silence?.id??"";state.silenceApproval=applied.data.status;save();
 await codex("e2e2-readback",`只使用 LightMoni MCP 工具，不执行 shell、不审批。用 lightmoni_alert_silences_list 查询当前静默，再用 lightmoni_alert_silences_get 精确读取 ${state.silenceID?`{"id":"${state.silenceID}"}`:"上一条返回的 ID"}。报告真实 ID、scope、until、version；若没有记录必须明确失败。`);
 state.e2e2_completed_at=new Date().toISOString();save();
}else if(action==="task-propose"){
 await codex("e2e3-propose",taskPrompt());state.taskProposalID=JSON.parse(native("latest-proposal","task")).id;save();
}else if(action==="task-replay"){
 await codex("e2e3-replay",taskPrompt());
 const latest=JSON.parse(native("latest-proposal","task")).id;if(latest!==state.taskProposalID)throw Error(`disconnect replay created ${latest}, expected ${state.taskProposalID}`);state.disconnect_replay_same_id=true;save();
}else if(action==="task-approve"){
 const applied=await api(`/api/v1/assistant/task-proposals/${state.taskProposalID}/apply`,"POST",{confirm:true});state.runID=applied.data.result.runs[0].id;state.taskApproval=applied.data.status;save();console.log(JSON.stringify({proposal_id:state.taskProposalID,run_id:state.runID,status:state.taskApproval}));
}else if(action==="task-verify"){
 const started=Date.now();let run;for(;;){run=JSON.parse(native("run"));if(["succeeded","failed","unknown","cancelled"].includes(run.state))break;if(Date.now()-started>90_000)throw Error("task result timeout");await sleep(1000);}
 if(run.state!=="succeeded"||!run.stdout.includes(state.marker))throw Error(`unexpected native run result ${JSON.stringify(run)}`);state.nativeRunSucceeded=true;save();
 await codex("e2e3-readback",`只使用 LightMoni MCP 工具，不执行 shell、不审批。请调用 lightmoni_executions_get，输入 {"id":"task:${state.runID}"}，并如实报告 native_state、run ID 与 review_url；queued/running/unknown 不能报告成功。`);
 state.e2e3_completed_at=new Date().toISOString();save();
}else if(action==="revoke-check"){
 const intent={...taskIntent(),idempotency_key:"core-e2e-revoked-"+state.suffix};
 state.revocationBeforeRunIDs=JSON.parse(native("runs")).map(run=>run.id);save();
 await codex("e2e-recovery-propose",`只使用 LightMoni MCP 工具，不执行 shell、不审批。请调用 lightmoni_tasks_plan，输入严格为 ${JSON.stringify(intent)}，只返回 proposal id。`);
 state.revokedProposalID=JSON.parse(native("latest-proposal","task")).id;save();
 await api("/api/v1/mcp-access/grants/"+state.grantID,"DELETE");
 const denied=await api(`/api/v1/assistant/task-proposals/${state.revokedProposalID}/apply`,"POST",{confirm:true},[403]);
 if(denied.status!==403||denied.data.error!=="authorization_revoked")throw Error(`unexpected revocation result ${JSON.stringify(denied)}`);
 const runs=JSON.parse(native("runs"));const before=state.revocationBeforeRunIDs??[];if(runs.length!==before.length||runs.some((run,index)=>run.id!==before[index]))throw Error(`unexpected replacement run ${JSON.stringify(runs)}`);state.revocation_blocked=true;save();
}else throw Error("unknown E2E action");
