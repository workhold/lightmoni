import React,{useEffect,useState} from 'react';
import {Alert,Button,Checkbox,Popconfirm,Space,Tag,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {AgentUpdatePlanSummary} from '../../app/MachineAgentUpdateDialog';
import {updatePlanExpired,updateMessageText,updateStatusColor,updateStatusText,type AgentUpdate} from '../../app/agent-update-model';
import {agentUpdateAPIPath,agentUpdateRecord,agentUpdateReviewable} from './agent-update-progress';

export default function AgentUpdateProgress({value,canApprove}:{value:unknown;canApprove:boolean}) {
 const {t,language}=useI18n(),parsed=agentUpdateRecord(value);
 const [record,setRecord]=useState<AgentUpdate|undefined>(parsed),[reviewed,setReviewed]=useState(false),[recoveryReviewed,setRecoveryReviewed]=useState(false),[busy,setBusy]=useState<''|'apply'|'cancel'|'reconcile'|'recover'>(''),[error,setError]=useState('');
 useEffect(()=>{setRecord(parsed);setReviewed(false);setRecoveryReviewed(false);setError('')},[parsed?.id]);
 const recordStatus=record?.status,recordID=record?.id,machineID=record?.machine_id,path=record?agentUpdateAPIPath(record):'';
 useEffect(()=>{
  if(!['running','verifying'].includes(recordStatus??''))return;
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
  timer=setTimeout(poll,1500);
  return()=>{active=false;if(timer)clearTimeout(timer);controller.abort()};
 },[recordStatus,path]);
 if(!record)return null;
 const originalRecord=record;
 const awaiting=agentUpdateReviewable(record),expired=updatePlanExpired(record);
 const failure=(problem:unknown)=>{setError(problem instanceof Error?updateMessageText(problem.message,t):t('操作失败，请重试','Operation failed. Retry.'))};
 async function apply(){
  if(!canApprove||!awaiting||!reviewed||busy||expired)return;
  setBusy('apply');setError('');
  try{
   const current=agentUpdateRecord(await api(path));
   if(!current)throw Error(t('原生更新计划响应无效','Invalid native Agent update response'));
   if(!agentUpdateReviewable(current)){setRecord(current);throw Error(t('计划状态已变化，请让助手重新准备','The plan state changed. Ask the assistant to prepare it again.'))}
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
   setRecord(next);setRecoveryReviewed(false);
  }catch(problem){failure(problem)}finally{setBusy('')}
 }
 async function recoverInterrupted(){
  if(!canApprove||originalRecord.status!=='unknown'||!recoveryReviewed||!originalRecord.recovery_revision||originalRecord.recovery_requires_verification||busy)return;
  const reviewedRevision=originalRecord.recovery_revision;
  setBusy('recover');setRecoveryReviewed(false);setError('');
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
  <AgentUpdatePlanSummary record={record}/>
  <Space wrap><Tag color={updateStatusColor(record.status)}>{updateStatusText(record.status,t)}</Tag>{record.review_url&&<Typography.Link href={record.review_url} target="_blank" rel="noreferrer">{t('打开原更新记录','Open original update record')}</Typography.Link>}</Space>
  {canApprove&&awaiting&&<div className="lm-assistant-code-approval">
   {expired&&<Alert type="warning" showIcon title={t('计划已过期，请让助手重新准备','The plan expired. Ask the assistant to prepare it again.')}/>}
   <Checkbox checked={reviewed} disabled={!!busy||expired} onChange={event=>setReviewed(event.target.checked)}>{t('我已审阅目标主机、当前/目标发行、执行步骤和影响','I have reviewed the host, current/target releases, steps, and impact')}</Checkbox>
   <Space wrap>
    <Button danger type="primary" disabled={!reviewed||!!busy||expired} loading={busy==='apply'} onClick={()=>void apply()}>{record.action==='rollback'?t('确认回退','Confirm rollback'):t('确认升级','Confirm upgrade')}</Button>
    <Popconfirm title={t('取消这个尚未执行的更新计划？','Cancel this unexecuted Agent update plan?')} description={t('取消后不能继续执行；如需更新，请让助手重新准备。','It cannot run after cancellation. Ask the assistant to prepare a new plan.') } okText={t('确认取消','Confirm cancellation')} cancelText={t('返回','Back')} onConfirm={()=>void cancel()}><Button disabled={!!busy} loading={busy==='cancel'}>{t('取消计划','Cancel plan')}</Button></Popconfirm>
   </Space>
   <small>{t('确认后调用原 Agent 更新审批接口，模型不会代替你审批或执行。','Confirmation uses the native Agent update approval API. The model does not approve or execute for you.')}</small>
  </div>}
  {['running','verifying'].includes(record.status)&&<Alert type="info" showIcon title={t('执行请求已接受，正在更新或核验；这不代表升级成功','Execution accepted. Updating or verifying; this is not success yet.')}/>}
  {record.status==='succeeded'&&<Alert type="success" showIcon title={t('Agent 更新成功，已核验目标发行','Agent update succeeded; the target release is verified')}/>}
  {record.status==='rolled_back'&&<Alert type="warning" showIcon title={t('目标更新未通过健康确认，已恢复原程序','The target update failed health verification; the previous runtime was restored')}/>}
  {record.status==='failed'&&<Alert type="error" showIcon title={record.error||t('Agent 更新失败','Agent update failed')}/>}
  {record.status==='unknown'&&<Alert type="warning" showIcon title={t('更新结果未知，请打开原记录只读核对','Update outcome is unknown. Open the original record for read-only verification')}/>}
  {canApprove&&record.status==='unknown'&&<div className="lm-assistant-code-approval lm-assistant-agent-recovery">
   <Alert type="warning" showIcon title={t('先只读核对；不要重复派发维护','Reconcile read-only first; do not dispatch maintenance again')} description={t('恢复只处理这次中断维护：确认维护进程停止后，恢复原审批固定的程序快照，不会自动升级或重新接入。','Recovery handles only this interrupted maintenance. It confirms the maintenance process has stopped and restores the runtime snapshot pinned by the original approval; it does not upgrade or enroll again.')}/>
   {record.recovery_requires_verification&&<Alert type="warning" showIcon title={t('上次恢复结果尚未核对，禁止再次恢复','The previous recovery needs verification; another recovery is blocked')}/>}
   <Checkbox checked={recoveryReviewed} disabled={!!busy||!record.recovery_revision||record.recovery_requires_verification===true} onChange={event=>setRecoveryReviewed(event.target.checked)}>{t('我已核对目标主机、原/目标发行及恢复影响，确认恢复此中断维护','I have reviewed the host, original/target releases and recovery impact, and approve recovery of this interrupted maintenance')}</Checkbox>
   <Space wrap>
    <Button disabled={!!busy} loading={busy==='reconcile'} onClick={()=>void reconcile()}>{t('只读核对结果','Verify outcome read-only')}</Button>
    <Button danger type="primary" disabled={!recoveryReviewed||!record.recovery_revision||record.recovery_requires_verification===true||!!busy} loading={busy==='recover'} onClick={()=>void recoverInterrupted()}>{t('恢复中断维护','Recover interrupted maintenance')}</Button>
   </Space>
   <small>{t('使用原审批 SSH 凭据；需要更换凭据或查看完整证据时，请打开原更新记录。模型不会代替你审批。','The originally approved SSH credential is used. Open the original record to change credentials or inspect full evidence. The model does not approve for you.')}</small>
  </div>}
  {record.status==='cancelled'&&<Alert type="info" showIcon title={t('更新计划已取消，未执行','The update plan was cancelled and did not run')}/>}
  {error&&<Alert type="error" showIcon title={error}/>}
 </div>;
}
