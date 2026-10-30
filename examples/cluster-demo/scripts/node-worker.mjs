import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {cipher,masterKey} from '../../../runtime/dist/shared/crypto.js';
import {executeOperation,operationCommand} from '../../../runtime/dist/agent/operations.js';
const root=process.env.DEMO_STATE,node=process.env.DEMO_NODE;
if(!root||!node)throw Error('DEMO_STATE and DEMO_NODE are required');
const directory=join(root,'nodes',node);
await mkdir(directory,{recursive:true,mode:0o700});
const {decrypt}=cipher(masterKey(root));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let identity;
while(!identity){try{identity=JSON.parse(decrypt(await readFile(join(directory,'identity.enc'),'utf8')));}catch{await pause(1000);}}
const {agent_id:agent,control_credential:credential,center}=identity;
async function call(path,body,headers={}){
  const response=await fetch(center+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Node HTTP '+response.status+' '+path);
  return response.json();
}
let lastHeartbeat=0;
while(true){
  try{
    if(Date.now()-lastHeartbeat>10000){await call('/qa/agents/'+agent+'/heartbeat',{machine_id:identity.machine_id});lastHeartbeat=Date.now();}
    const {job}=await call('/agents/'+agent+'/jobs/claim',{capabilities:['operations.platform']});
    if(!job){await pause(300);continue;}
    const {payload}=await call('/agents/'+agent+'/jobs/'+job.id+'/operations',undefined,{'x-lightmoni-job-lease':job.lease_id});
    let sequence=0,phase='accepted',events=Promise.resolve();
    const emit=event=>{phase=event.phase;events=events.then(()=>call('/agents/'+agent+'/jobs/'+job.id+'/events',{lease_id:job.lease_id,sequence:++sequence,...event}));return events;};
    const timer=setInterval(()=>{void emit({phase,summary:'Isolated Docker node is executing the approved operation'}).catch(()=>{});void call('/qa/agents/'+agent+'/heartbeat',{machine_id:identity.machine_id}).catch(()=>{});},10000);
    let receipt;
    try{receipt=await executeOperation(payload,{dataDir:join(directory,'agent'),signal:new AbortController().signal,now:()=>new Date(),command:operationCommand},emit);}
    finally{clearInterval(timer);}
    await events;
    await call('/agents/'+agent+'/jobs/'+job.id+'/result',{lease_id:job.lease_id,...receipt});
    const record={job_id:job.id,operation_id:payload.operation_id,resource_id:payload.resource.id,task:payload.resource.config.task,state:receipt.state,code:receipt.code,finished_at:receipt.finished_at};
    console.info(JSON.stringify(record));
    await writeFile(join(directory,'last-receipt.json'),JSON.stringify(record)+'\n',{mode:0o600});
  }catch(error){console.error(error.message);await pause(1000);}
}
