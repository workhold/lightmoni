import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../shared/api';
import {canonicalHostAction,hostContainerTerminal,type HostAction,type HostContainerJob} from './host-container-model';

export function useHostContainerJobs(machineID:string){
 const [jobs,setJobs]=useState<HostContainerJob[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState<{requestID:string;action:HostAction;jobID?:string}>();
 const alive=useRef(true),pending=useRef(false),controller=useRef<AbortController|null>(null),sequence=useRef(0);
 const path=`/ops/machines/${encodeURIComponent(machineID)}/container-jobs`;
 const merge=(j:HostContainerJob)=>{setJobs(old=>[j,...old.filter(row=>row.id!==j.id)]);sequence.current++};
 const refresh=async()=>{const seq=sequence.current;try{const r=await api<{jobs:HostContainerJob[]}>(path);if(alive.current&&seq===sequence.current)setJobs(r.jobs)}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}};
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;controller.current?.abort()}},[machineID]);
 useEffect(()=>{if(!jobs.some(j=>j.blocking&&!hostContainerTerminal(j.state)))return;const timer=setTimeout(()=>void refresh(),2000);return()=>clearTimeout(timer)},[jobs]);
 const poll=async(j:HostContainerJob,signal:AbortSignal)=>{
  const original=j;
  const deadline=Date.now()+125000;
  while(!hostContainerTerminal(j.state)&&Date.now()<deadline){
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()},timer=setTimeout(done,750);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done()});
   signal.throwIfAborted();j=await api<HostContainerJob>(path+'/'+encodeURIComponent(j.id),{signal});
   if(j.id!==original.id||j.request_id!==original.request_id||canonicalHostAction(j.action)!==canonicalHostAction(original.action))throw Error('host_docker_receipt_mismatch');if(alive.current)merge(j);
  }
  if(!hostContainerTerminal(j.state))throw Error('host_docker_result_pending');return j;
 };
 const run=async(action:HostAction):Promise<HostContainerJob|undefined>=>{
  if(pending.current||uncertain)return;pending.current=true;setBusy(true);setError('');const abort=new AbortController();controller.current=abort;
  const intent={requestID:crypto.randomUUID(),action,jobID:undefined as string|undefined};let submitted=false;
  try{
   submitted=true;let job=await api<HostContainerJob>(path,{method:'POST',signal:abort.signal,body:JSON.stringify({request_id:intent.requestID,confirmed:!['inspect','images'].includes(action.operation),action})});
   if(typeof job.id!=='string'||!job.id||job.request_id!==intent.requestID||canonicalHostAction(job.action)!==canonicalHostAction(action))throw Error('host_docker_receipt_mismatch');intent.jobID=job.id;if(alive.current)merge(job);
   job=await poll(job,abort.signal);if(job.state!=='succeeded')throw Object.assign(Error(job.code||job.state),{completed:true});return job;
  }catch(e){if(alive.current&&!abort.signal.aborted){setError(e instanceof Error?e.message:String(e));if(submitted&&!(e instanceof ApiError&&e.status<500)&&!(e as {completed?:boolean})?.completed)setUncertain(intent)}}
  finally{pending.current=false;if(alive.current)setBusy(false)}
 };
 const recover=async()=>{
  if(pending.current||!uncertain)return;pending.current=true;setBusy(true);setError('');const abort=new AbortController();controller.current=abort;
  try{
   const list=uncertain.jobID?[await api<HostContainerJob>(path+'/'+encodeURIComponent(uncertain.jobID),{signal:abort.signal})]:(await api<{jobs:HostContainerJob[]}>(path,{signal:abort.signal})).jobs;
   const found=list.filter(j=>j.request_id===uncertain.requestID&&canonicalHostAction(j.action)===canonicalHostAction(uncertain.action));if(found.length!==1)throw Error('host_docker_result_not_found');
   let job=found[0];merge(job);job=await poll(job,abort.signal);if(alive.current){setUncertain(undefined);if(job.state!=='succeeded')setError(job.code||job.state)}return job;
  }catch(e){if(alive.current&&!abort.signal.aborted)setError(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;if(alive.current)setBusy(false)}
 };
 return {jobs,busy,error,uncertain,run,recover,refresh,clearError:()=>setError(''),blocked:jobs.some(j=>j.blocking)};
}
