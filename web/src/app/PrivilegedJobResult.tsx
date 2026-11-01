import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Form,Input,Space,Spin,Tag,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {useI18n} from '../shared/i18n';

export type PrivilegedCapability='script.elevated.v1'|'container.managed.v1';
export type PrivilegedExecutionJob={
 id:string;task_run_id:string;plan_id:string;plan_revision:string;request_id:string;
 machine_id:string;machine_name?:string;executor_id:string;install_generation:number;policy_generation:number;
 execution_principal:'privileged_executor';capability:PrivilegedCapability;state:string;
 created_at:string;started_at?:string;finished_at?:string;phase?:string;cancel_requested?:boolean;
 resolved_at?:string;resolved_by?:string;resolution_reason?:string;has_output?:boolean;code?:string;
};
type Props={jobID:string;capability:PrivilegedCapability;hostID?:string;hostName?:string;onChanged?:(job:PrivilegedExecutionJob)=>void};
type JobAction='cancel'|'reconcile';
const prefix='/privileged-execution/jobs/';
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const terminal=(state:string)=>['succeeded','failed','cancelled','unknown'].includes(state);
export const isPrivilegedJob=(value:PrivilegedExecutionJob,capability:PrivilegedCapability)=>!!value&&typeof value.id==='string'&&!!value.id&&value.execution_principal==='privileged_executor'&&value.capability===capability&&typeof value.machine_id==='string'&&!!value.machine_id&&typeof value.task_run_id==='string'&&!!value.task_run_id&&typeof value.executor_id==='string'&&!!value.executor_id&&Number.isSafeInteger(value.install_generation)&&value.install_generation>0&&Number.isSafeInteger(value.policy_generation)&&value.policy_generation>=0&&['queued','running','succeeded','failed','cancelled','unknown'].includes(value.state);
const sameIdentity=(a:PrivilegedExecutionJob,b:PrivilegedExecutionJob)=>a.id===b.id&&a.task_run_id===b.task_run_id&&a.machine_id===b.machine_id&&a.executor_id===b.executor_id&&a.install_generation===b.install_generation&&a.policy_generation===b.policy_generation&&a.plan_id===b.plan_id&&a.plan_revision===b.plan_revision&&a.request_id===b.request_id;

export default function PrivilegedJobResult(props:Props){return <PrivilegedJobResultContent key={props.capability+':'+props.jobID+':'+(props.hostID??'')} {...props}/>;}

function PrivilegedJobResultContent({jobID,capability,hostID,hostName,onChanged}:Props){
 const {t,language}=useI18n(),script=capability==='script.elevated.v1';
 const [job,setJob]=useState<PrivilegedExecutionJob>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [output,setOutput]=useState<{stdout:string;stderr:string;exit_code:number|null}>(),[outputBusy,setOutputBusy]=useState(false);
 const [action,setAction]=useState<JobAction>(),[checked,setChecked]=useState(false),[reason,setReason]=useState(''),[actionBusy,setActionBusy]=useState(false),[needsRefresh,setNeedsRefresh]=useState(false);
 const mounted=useRef(false),generation=useRef(0),outputGeneration=useRef(0),outputPending=useRef(false),actionPending=useRef(false),identity=useRef<PrivilegedExecutionJob|undefined>(undefined);
 const changed=useRef(onChanged);changed.current=onChanged;
 const title=script?t('提权执行结果','Elevated run result'):t('容器执行结果','Container run result');
 const stateText=(value:PrivilegedExecutionJob)=>value.state==='unknown'&&value.resolved_at?t('结果未知，已人工核对','Outcome unknown; manually reconciled'):({queued:t('待领取','Queued'),running:t('执行中','Running'),succeeded:t('成功','Succeeded'),failed:t('失败','Failed'),cancelled:t('已取消','Cancelled'),unknown:t('结果未知，需核对','Outcome unknown; verification needed')}[value.state]||value.state);
 const stateColor=(state:string)=>({queued:'processing',running:'processing',succeeded:'success',failed:'error',unknown:'warning'}[state]);
 const time=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(language):'—';
 const describeError=(value:unknown)=>value instanceof ApiError?String(value.details.code||value.details.error||value.message):value instanceof Error?value.message:String(value);
 const resetAction=()=>{setAction(undefined);setChecked(false);setReason('')};
 const hideOutput=()=>{outputGeneration.current++;outputPending.current=false;setOutputBusy(false);setOutput(undefined)};
 const validate=(next:PrivilegedExecutionJob)=>{
  if(!isPrivilegedJob(next,capability)||next.id!==jobID||hostID&&next.machine_id!==hostID||identity.current&&!sameIdentity(identity.current,next))throw Error(t('执行记录身份不匹配','The execution record identity does not match'));
  return next;
 };
 const accept=(next:PrivilegedExecutionJob)=>{identity.current=next;setJob(next);setNeedsRefresh(false);changed.current?.(next)};
 const readJob=async(clearOutput=true)=>{
  const current=++generation.current;if(clearOutput){hideOutput();resetAction()}setLoading(true);
  try{const result=await api<{job:PrivilegedExecutionJob}>(prefix+encodeURIComponent(jobID));if(mounted.current&&current===generation.current){accept(validate(result.job));setError('')}}
  catch(e){if(mounted.current&&current===generation.current){setError(describeError(e));setNeedsRefresh(true)}}
  finally{if(mounted.current&&current===generation.current)setLoading(false)}
 };
 useEffect(()=>{
  mounted.current=true;identity.current=undefined;setJob(undefined);setError('');setActionBusy(actionPending.current);void readJob();
  return()=>{mounted.current=false;generation.current++;outputGeneration.current++};
 },[jobID,capability,hostID]);
 useEffect(()=>{if(!job||terminal(job.state)||needsRefresh)return;const timer=setInterval(()=>{if(!actionPending.current)void readJob(false)},4000);return()=>clearInterval(timer)},[job?.id,job?.state,needsRefresh]);
 const readOutput=async()=>{
  if(!job||needsRefresh||outputPending.current)return;const current=++outputGeneration.current;outputPending.current=true;setOutputBusy(true);setError('');
  try{const next=await api<{stdout:string;stderr:string;exit_code:number|null}>(prefix+encodeURIComponent(job.id)+'/output');if(typeof next.stdout!=='string'||typeof next.stderr!=='string'||bytes(next.stdout)+bytes(next.stderr)>262144||!(next.exit_code===null||Number.isInteger(next.exit_code)&&Math.abs(next.exit_code)<=255))throw Error(t('输出格式无效','Invalid output response'));if(mounted.current&&current===outputGeneration.current)setOutput(next)}
  catch(e){if(mounted.current&&current===outputGeneration.current)setError(describeError(e))}
  finally{if(current===outputGeneration.current){outputPending.current=false;if(mounted.current)setOutputBusy(false)}}
 };
 const openAction=(kind:JobAction)=>{if(actionPending.current||needsRefresh)return;resetAction();setAction(kind);setError('')};
 const submitAction=async()=>{
  if(!job||!action||!checked||needsRefresh||actionPending.current)return;const target=job,kind=action,why=reason.trim();
  if(kind==='cancel'&&(!['queued','running'].includes(job.state)||job.cancel_requested)||kind==='reconcile'&&(job.state!=='unknown'||job.resolved_at||!why||bytes(why)>512))return;
  actionPending.current=true;setActionBusy(true);setLoading(false);setError('');const current=++generation.current;
  try{
   const response=await api<{job:PrivilegedExecutionJob}>(prefix+encodeURIComponent(target.id)+'/'+kind,{method:'POST',body:JSON.stringify(kind==='cancel'?{confirm:true}:{confirm:true,reason:why})});
   if(mounted.current&&current===generation.current){const next=validate(response.job);if(!sameIdentity(next,target)||kind==='reconcile'&&(next.state!=='unknown'||!next.resolved_at))throw Error(t('操作响应身份或状态不匹配，请刷新原执行记录核对','The action response identity or state does not match. Refresh the original run to verify'));accept(next);resetAction()}
  }catch(e){if(mounted.current&&current===generation.current){setChecked(false);setNeedsRefresh(true);setError(describeError(e)+' '+t('请先刷新本条执行记录核对，再决定后续操作。','Refresh this run to verify before taking another action.'))}}
  finally{actionPending.current=false;if(mounted.current)setActionBusy(false)}
 };
 return <section aria-label={title}>
  <h3>{title}</h3>{error&&<Alert type="error" title={error}/>}{loading&&!job&&<Spin/>}
  {!job?<Button loading={loading} onClick={()=>void readJob()}>{script?t('刷新提权结果','Refresh elevated result'):t('刷新容器结果','Refresh container result')}</Button>:<>
   <Descriptions column={{xs:1,sm:2}} size="small" items={[
    {key:'id',label:t('执行 ID','Run ID'),children:job.id},{key:'trace',label:t('任务追踪 ID','Task trace ID'),children:job.task_run_id},
    {key:'state',label:t('状态','State'),children:<Tag color={stateColor(job.state)}>{stateText(job)}</Tag>},{key:'plan',label:t('计划 ID','Plan ID'),children:job.plan_id||'—'},
    {key:'host',label:t('主机','Host'),children:job.machine_name||hostName||job.machine_id},{key:'end',label:t('结束时间','Finished at'),children:time(job.finished_at)},
    {key:'cancel',label:t('取消请求','Cancellation request'),children:!job.cancel_requested?'—':job.state==='queued'||job.state==='running'?t('已请求取消，最终结果以执行器回执为准','Requested; the final outcome depends on the executor receipt'):job.state==='cancelled'?t('已取消','Cancelled'):t('曾请求取消；最终结果见执行状态','Cancellation was requested; see the execution state for the outcome')},
    ...(job.resolved_at?[{key:'resolved_at',label:t('人工核对时间','Reconciled at'),children:time(job.resolved_at)},{key:'resolved_by',label:t('核对人','Reconciled by'),children:job.resolved_by||'—'},{key:'reason',label:t('核对原因','Reconciliation reason'),span:2,children:job.resolution_reason||'—'}]:[]),
    {key:'exit',label:t('退出码（读取输出后显示）','Exit code (after reading output)'),children:output?.exit_code??'—'},{key:'result',label:t('安全结果码','Result code'),children:job.code||'—'},
   ]}/>
   {job.state==='unknown'&&<Alert type="warning" showIcon title={job.resolved_at?t('结果未知，已记录人工核对','Outcome unknown; human reconciliation recorded'):t('结果未知，需先核对现场','Outcome unknown; verify the host first')} description={t('任务可能已经产生副作用，本页不提供重试或把未知状态改为成功。','The task may already have caused effects. This view does not retry it or mark an unknown outcome as successful.')}/>}
   <Space wrap style={{marginTop:12}}>
    <Button disabled={actionBusy} onClick={()=>void readJob()}>{script?t('刷新提权结果','Refresh elevated result'):t('刷新容器结果','Refresh container result')}</Button>
    <Button loading={outputBusy} disabled={needsRefresh} onClick={()=>void readOutput()}>{t('查看敏感输出','View sensitive output')}</Button>
    {output&&<Button onClick={hideOutput}>{t('隐藏输出','Hide output')}</Button>}
    {['queued','running'].includes(job.state)&&!job.cancel_requested&&<Button danger disabled={actionBusy||needsRefresh} onClick={()=>openAction('cancel')}>{script?t('取消提权执行','Cancel elevated run'):t('取消容器执行','Cancel container run')}</Button>}
    {job.state==='unknown'&&!job.resolved_at&&<Button disabled={actionBusy||needsRefresh} onClick={()=>openAction('reconcile')}>{t('人工核对结束','Reconcile ended execution')}</Button>}
   </Space>
   {action&&<section aria-label={script?t('提权执行操作确认','Elevated run action confirmation'):t('容器执行操作确认','Container run action confirmation')} style={{marginTop:16}}>
    <h4>{action==='cancel'?t('确认取消执行','Confirm cancellation'):t('人工核对未知执行','Reconcile unknown execution')}</h4>
    <Typography.Paragraph>{action==='cancel'?t('未领取的任务会取消；执行中的任务会请求执行器终止，需等待回执。已发生的副作用不会撤销。','An unclaimed run is cancelled. A running execution is asked to stop and must await its executor receipt. Effects that have already occurred cannot be undone.'):t('先在主机上核对本条执行与现场影响，确认执行动作已结束。此操作仅记录人工核对并解除互斥，执行结果仍为未知，不会终止主机上的进程、停止容器或把结果改为成功。','First verify this execution and its effects on the host, and confirm the execution action has ended. This records human reconciliation and releases the block. The outcome stays unknown; it does not terminate host processes, stop containers, or mark success.')}</Typography.Paragraph>
    {action==='reconcile'&&<Form layout="vertical"><Form.Item label={t('核对原因','Reconciliation reason')} extra={t('填写 1–512 UTF-8 字节的现场核对记录','Enter 1–512 UTF-8 bytes describing the host verification')} validateStatus={bytes(reason.trim())>512?'error':undefined}><Input.TextArea aria-label={script?t('提权人工核对原因','Elevated reconciliation reason'):t('容器人工核对原因','Container reconciliation reason')} value={reason} disabled={actionBusy||needsRefresh} rows={3} onChange={event=>setReason(event.target.value)}/></Form.Item></Form>}
    <Checkbox aria-label={script?t('确认提权执行后续操作','Confirm elevated run action'):t('确认容器执行后续操作','Confirm container run action')} checked={checked} disabled={actionBusy||needsRefresh} onChange={event=>setChecked(event.target.checked)}>{action==='cancel'?t('我确认取消本条执行，并理解取消不能撤销副作用','I confirm cancellation of this run and understand that it cannot undo effects'):t('我已核对本条执行与现场影响，确认执行动作已结束','I verified this execution and its effects and confirmed the execution action ended')}</Checkbox>
    <Space wrap style={{marginTop:12}}><Button danger type="primary" aria-label={action==='cancel'?t('提交取消请求','Submit cancellation request'):t('记录人工核对','Record reconciliation')} loading={actionBusy} disabled={actionBusy||needsRefresh||!checked||action==='reconcile'&&(!reason.trim()||bytes(reason.trim())>512)} onClick={()=>void submitAction()}>{action==='cancel'?t('提交取消请求','Submit cancellation request'):t('记录人工核对','Record reconciliation')}</Button><Button disabled={actionBusy} onClick={resetAction}>{t('返回执行结果','Back to run result')}</Button></Space>
   </section>}
   {output&&<><Typography.Paragraph type="secondary" style={{marginTop:12}}>{t('输出可能包含秘密，仅在此显式读取，不自动发送给 AI 或遥测。','Output may contain secrets. It is read only on request and is not automatically sent to AI or telemetry.')}</Typography.Paragraph><h4>stdout</h4><pre className="lm-task-output">{output.stdout||t('无输出','No output')}</pre><h4>stderr</h4><pre className="lm-task-output">{output.stderr||t('无输出','No output')}</pre></>}
  </>}
 </section>;
}
