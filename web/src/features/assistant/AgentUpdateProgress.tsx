import React,{useEffect,useState} from 'react';
import {Button,Checkbox,Popconfirm,Progress,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {AgentUpdatePlanSummary} from '../../app/MachineAgentUpdateDialog';
import {installedRelease,updatePlanExpired,updateMessageText,updateStatusText,updateIsActive,type AgentUpdate} from '../../app/agent-update-model';
import {agentUpdateAPIPath,agentUpdateRecord,agentUpdateReviewable,agentUpdateStageProgress} from './agent-update-progress';

export default function AgentUpdateProgress({value,canApprove}:{value:unknown;canApprove:boolean}) {
 const {t}=useI18n(),parsed=agentUpdateRecord(value);
 const [record,setRecord]=useState<AgentUpdate|undefined>(parsed),[reviewed,setReviewed]=useState(false),[recoveryReview,setRecoveryReview]=useState(''),[busy,setBusy]=useState<''|'apply'|'cancel'|'reconcile'|'recover'>(''),[error,setError]=useState('');
 useEffect(()=>{setRecord(parsed);setReviewed(false);setRecoveryReview('');setError('')},[parsed?.id]);
 const recordStatus=record?.status,recordID=record?.id,machineID=record?.machine_id,path=record?agentUpdateAPIPath(record):'';
 useEffect(()=>{
  if(busy||!['awaiting_approval','running','verifying','unknown'].includes(recordStatus??''))return;
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController();
  const poll=async()=>{
   try{
    const next=agentUpdateRecord(await api(path,{signal:controller.signal}));
    if(!active)return;
    if(!next||next.id!==recordID||next.machine_id!==machineID){setError(t('原更新记录响应无效，保留最后状态并稍后重试','Invalid original update response. Retaining the last state and retrying.'));timer=setTimeout(poll,5000);return;}
    setRecord(next);setError('');
    if(['running','verifying'].includes(next.status))timer=setTimeout(poll,2500);
   }catch(problem){if(active){setError(t('暂时无法刷新更新状态，保留最后记录，稍后重试','Unable to refresh update status. Retaining the last record and retrying.'));timer=setTimeout(poll,5000)}}
  };
  timer=setTimeout(poll,['running','verifying'].includes(recordStatus??'')?1500:0);
  return()=>{active=false;if(timer)clearTimeout(timer);controller.abort()};
 },[recordStatus,path,busy]);
 if(!record)return null;
 const originalRecord=record;
 const awaiting=agentUpdateReviewable(record),expired=updatePlanExpired(record);
 const recoveryReady=!!record.recovery_revision&&!record.recovery_requires_verification;
 const recoveryReviewed=recoveryReady&&recoveryReview===record.recovery_revision;
 const progress=agentUpdateStageProgress(record),stageText=(stage:string)=>({ready:t('已核对发行与主机','Release and host verified'),starting:t('正在启动维护','Starting maintenance'),accepted:t('维护器已接收','Maintainer accepted'),preparing:t('正在准备发行包','Preparing release'),switching:t('正在切换程序','Switching runtime'),verifying:t('正在核验目标发行','Verifying target release'),waiting_confirmation:t('等待新进程健康确认','Waiting for health confirmation'),succeeded:t('更新成功','Update succeeded'),rolled_back:t('已恢复原程序','Previous runtime restored'),failed:t('更新失败','Update failed'),unknown:t('结果待核对','Outcome needs verification'),cancelled:t('已取消','Cancelled'),rollback_failed:t('自动恢复未确认','Automatic recovery unconfirmed')} as Record<string,string>)[stage]||stage;
 const progressStage=awaiting?(expired?t('计划已过期','Plan expired'):t('等待管理员审批','Waiting for administrator approval')):stageText(progress.stage);
 const progressHint=awaiting?(expired?t(' · 请让助手重新准备',' · Ask the assistant to prepare a new plan'):t(' · 确认后开始执行',' · Execution starts after confirmation')):t(' · 等待服务端阶段记录',' · Waiting for a server stage record');
 const failure=(problem:unknown)=>{setError(problem instanceof Error?updateMessageText(problem.message,t):t('操作失败，请重试','Operation failed. Retry.'))};
 async function apply(){
  if(!canApprove||!awaiting||!reviewed||busy||expired)return;
  setBusy('apply');setError('');
  try{
   const current=await readOriginal();
   if(!agentUpdateReviewable(current)||updatePlanExpired(current)){setRecord(current);throw Error(t('计划状态已变化，请让助手重新准备','The plan state changed. Ask the assistant to prepare it again.'))}
   const next=agentUpdateRecord(await api(path+'/apply',{method:'POST',body:JSON.stringify({confirm:true})}));
   if(!next)throw Error(t('审批后的原生更新记录无效','Invalid native Agent update after approval'));
   setRecord(next);
  }catch(problem){failure(problem)}finally{setBusy('')}
 }
 async function cancel(){
  if(!canApprove||!awaiting||busy)return;
  setBusy('cancel');setError('');
  try{
   const next=agentUpdateRecord(await api(path+'/cancel',{method:'POST',body:'{}'}));
   if(!next)throw Error(t('取消后的原生更新记录无效','Invalid native Agent update after cancellation'));
   setRecord(next);
  }catch(problem){failure(problem)}finally{setBusy('')}
 }
 async function readOriginal(){
  const next=agentUpdateRecord(await api(path));
  if(!next||next.id!==originalRecord.id||next.machine_id!==originalRecord.machine_id)throw Error(t('原更新记录响应无效，请刷新后重试','Invalid original update response. Refresh and retry.'));
  return next;
 }
 async function reconcile(){
  if(!canApprove||originalRecord.status!=='unknown'||busy)return;
  setBusy('reconcile');setError('');
  try{
   const current=await readOriginal();setRecord(current);
   if(current.status!=='unknown')return;
   const next=agentUpdateRecord(await api(path+'/reconcile',{method:'POST',body:'{}'}));
   if(!next||next.id!==originalRecord.id||next.machine_id!==originalRecord.machine_id)throw Error(t('核对后的原生更新记录无效','Invalid native Agent update after reconciliation'));
   setRecord(next);setRecoveryReview('');
  }catch(problem){failure(problem)}finally{setBusy('')}
 }
 async function recoverInterrupted(){
  if(!canApprove||originalRecord.status!=='unknown'||!recoveryReviewed||!originalRecord.recovery_revision||originalRecord.recovery_requires_verification||busy)return;
  const reviewedRevision=originalRecord.recovery_revision;
  setBusy('recover');setRecoveryReview('');setError('');
  try{
   const current=await readOriginal();setRecord(current);
   if(current.status!=='unknown'||current.recovery_revision!==reviewedRevision||current.recovery_requires_verification)
    throw Error(t('恢复条件已变化或上次恢复尚未核对，请重新只读核对','Recovery conditions changed or the previous recovery needs verification. Reconcile again.'));
   const next=agentUpdateRecord(await api(path+'/recover',{method:'POST',body:JSON.stringify({confirm:true,expected_revision:reviewedRevision})}));
   if(!next||next.id!==originalRecord.id||next.machine_id!==originalRecord.machine_id)throw Error(t('恢复后的原生更新记录无效','Invalid native Agent update after recovery'));
   setRecord(next);
  }catch(problem){failure(problem)}finally{setBusy('')}
 }
 return <div className="lm-assistant-agent-update">
  <div className="lm-update-card">
    <div className="lm-update-card-head">
      <span className={`lm-update-status ${record.status}`}>{updateStatusText(record.status,t)}</span>
      <span className="lm-update-title">{record.action==='rollback'?t('回退 Agent','Roll back Agent'):t('升级 Agent','Upgrade Agent')}</span>
      {record.review_url&&<Typography.Link className="lm-update-link" href={record.review_url} target="_blank" rel="noreferrer">{t('原更新记录','Original update record')}</Typography.Link>}
    </div>
    <div className="lm-update-facts">
      <div><small>{t('主机','Host')}</small><strong>{record.plan?.machine?.name||record.machine_id}</strong></div>
      <div><small>{t('当前','Current')}</small><strong>{installedRelease(record.plan?.current)?.version||t('未知','Unknown')}</strong></div>
      <div><small>{t('目标','Target')}</small><strong>{installedRelease(record.plan?.target)?.version||t('未知','Unknown')}</strong></div>
    </div>
    <div className="lm-update-progress">
      <Progress percent={progress.percent} status={record.status==='succeeded'?'success':['failed','unknown','rolled_back'].includes(record.status)?'exception':updateIsActive(record.status)?'active':'normal'} showInfo={false}/>
      <span role="status">{progressStage}{awaiting&&progressHint}</span>
    </div>
    {canApprove&&record.status==='unknown'&&<div className="lm-update-review">
      <Checkbox checked={recoveryReviewed} disabled={!recoveryReady||!!busy} onChange={event=>setRecoveryReview(event.target.checked?record.recovery_revision??'':'')}>{t('我已核对目标主机、原发行和恢复影响','I have reviewed the host, original release, and recovery impact')}</Checkbox>
      <div className="lm-update-actions">
        <Button size="small" disabled={!!busy} loading={busy==='reconcile'} onClick={()=>void reconcile()}>{t('只读核对结果','Verify outcome read-only')}</Button>
        <Button size="small" danger type="primary" disabled={!recoveryReviewed||!!busy} loading={busy==='recover'} onClick={()=>void recoverInterrupted()}>{t('恢复中断维护','Recover interrupted maintenance')}</Button>
        {record.recovery_requires_verification&&<span className="lm-update-note">{t('先核对，再恢复','Verify first, then recover')}</span>}
      </div>
    </div>}
    {canApprove&&awaiting&&<div className="lm-update-review">
      <Checkbox checked={reviewed} disabled={expired||!!busy} onChange={event=>setReviewed(event.target.checked)}>{t('我已审阅主机、当前与目标发行、步骤和影响','I have reviewed the host, current and target releases, steps, and impact')}</Checkbox>
      <div className="lm-update-actions">
        <Button size="small" type="primary" danger={record.action==='rollback'} disabled={expired||!reviewed||!!busy} loading={busy==='apply'} onClick={()=>void apply()}>{record.action==='rollback'?t('确认回退','Confirm rollback'):t('确认升级','Confirm upgrade')}</Button>
        <Popconfirm title={t('取消这个尚未执行的更新计划？','Cancel this unexecuted Agent update plan?')} description={t('取消后需要重新准备。','A new plan is required afterwards.')} okText={t('确认取消','Confirm cancellation')} cancelText={t('返回','Back')} onConfirm={()=>void cancel()}><Button size="small" disabled={!!busy} loading={busy==='cancel'}>{t('取消计划','Cancel plan')}</Button></Popconfirm>
      </div>
    </div>}
    {(error||record.error)&&<div className="lm-update-error">{error||record.error}</div>}
    {record.status==='failed'&&<span className="lm-update-note">{t('请打开原更新记录核对最后阶段和主机状态。','Open the original update record to check the last stage and host state.')}</span>}
    <details className="lm-update-details">
      <summary>{t('技术详情','Technical details')}</summary>
      <AgentUpdatePlanSummary record={record}/>
      {record.recovery_requires_verification&&<small>{t('上次恢复响应未确认；核对通过后才会开放恢复。','The last recovery response was unconfirmed. Recovery opens after verification passes.')}</small>}
    </details>
  </div>
 </div>;
}
