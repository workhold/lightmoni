import {useEffect,useState} from 'react';
import {Alert,Button,Checkbox,Popconfirm,Space,Tag,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {AgentUpdatePlanSummary} from '../../app/MachineAgentUpdateDialog';
import {updatePlanExpired,updateMessageText,updateStatusColor,updateStatusText,type AgentUpdate} from '../../app/agent-update-model';
import {agentUpdateAPIPath,agentUpdateRecord,agentUpdateReviewable} from './agent-update-progress';

export default function AgentUpdateProgress({value,canApprove}:{value:unknown;canApprove:boolean}) {
 const {t,language}=useI18n(),parsed=agentUpdateRecord(value);
 const [record,setRecord]=useState<AgentUpdate|undefined>(parsed),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState<''|'apply'|'cancel'>(''),[error,setError]=useState('');
 useEffect(()=>{setRecord(parsed);setReviewed(false);setError('')},[parsed?.id]);
 if(!record)return null;
 const awaiting=agentUpdateReviewable(record),expired=updatePlanExpired(record),path=agentUpdateAPIPath(record);
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
  {error&&<Alert type="error" showIcon title={error}/>}
 </div>;
}
