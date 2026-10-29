import {reusableMachineCredential} from './machine-credentials';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Descriptions,Form,Modal,Popconfirm,Select,Space,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import SSHCheckSummary,{type SSHCheckResult} from '../shared/SSHCheckSummary';

export type AgentUninstallation={
 id:string;machine_id:string;agent_id:string;credential_id:string;
 status:'awaiting_approval'|'running'|'succeeded'|'failed'|'unknown'|'cancelled';
 plan?:{machine:{id:string;name:string;address:string;port:number;username:string;agent_id:string};agent_id:string;credential:{id:string;method:string;retention:string;expires_at:string};check_id:string;expires_at:string;steps:string[];retained_paths:string[];removed_paths:string[];warnings:string[]};
 receipt?:{agent_id?:string;remote_removed?:boolean;data_retained?:boolean;credentials_revoked?:boolean;revoked_credentials?:number;verified_at?:string;stages?:string[];service_stopped?:boolean;remote_unchanged?:boolean};
 error?:string;created_at?:string;finished_at?:string;
};
type Credential={id:string;method:string;retention?:string;expires_at:string;secret_fingerprint:string;revoked_at?:string;secret_cleared_at?:string};
type Props={machine:{id:string;name:string};credentials:Credential[];existing?:AgentUninstallation;onClose:()=>void;onRefresh:()=>Promise<void>};

export default function MachineAgentUninstallDialog({machine,credentials,existing,onClose,onRefresh}:Props){
 const {t,language}=useI18n();
 const [record,setRecord]=useState(existing),[check,setCheck]=useState<SSHCheckResult>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now()),[refreshNeeded,setRefreshNeeded]=useState(false);
 const controller=useRef<AbortController|null>(null);
 const prefix=`/machines/${encodeURIComponent(machine.id)}/uninstallations`;
 const keys=credentials.filter(c=>reusableMachineCredential(c));
 const localizeMessage=(value:string)=>({
  '此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对':t('此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对','This host has a pending, running, or uncertain Agent removal. Cancel or verify it first.'),
  '远端 Agent 身份与主机关联不一致':t('远端 Agent 身份与主机关联不一致','The remote Agent identity does not match this host binding.'),
  '远端 Agent 不是本平台已登记的独立凭据节点，不能自动卸载':t('远端 Agent 不是本平台已登记的独立凭据节点，不能自动卸载','The remote Agent is not registered with independent credentials on this platform; automatic removal is unavailable.'),
  '此 Agent 已关联另一主机，请先核对身份':t('此 Agent 已关联另一主机，请先核对身份','This Agent is linked to another host. Verify its identity first.'),
  'Agent 有待执行、运行中或结果未知的任务，请先完成或核对':t('Agent 有待执行、运行中或结果未知的任务，请先完成或核对','The Agent has queued, running, or uncertain tasks. Complete or verify them first.'),
  '远端 Agent 身份与审核计划不一致':t('远端 Agent 身份与审核计划不一致','The remote Agent identity no longer matches the reviewed plan.'),
  '远端 Agent 存在未完成操作标记，请先核对':t('远端 Agent 存在未完成操作标记，请先核对','An unfinished operation marker exists on the host. Verify its state first.'),
  '远端 Agent 配置或状态目录缺失，不能自动卸载':t('远端 Agent 配置或状态目录缺失，不能自动卸载','The remote Agent configuration or state directory is missing; automatic removal is unavailable.'),
  '尚未确认 Agent 服务和程序已移除且数据已保留':t('尚未确认 Agent 服务和程序已移除且数据已保留','Service/runtime removal and data retention have not been confirmed.'),
  '主机连接或节点关联已变化，请重新核对':t('主机连接或节点关联已变化，请重新核对','The host connection or Agent binding has changed. Verify it again.'),
  '请先完成或取消 Agent 安装计划':t('请先完成或取消 Agent 安装计划','Complete or cancel the Agent installation plan first.'),
  '远端 Agent 程序已移除，请核对既有卸载记录':t('远端 Agent 程序已移除，请核对既有卸载记录','The Agent runtime is already removed. Verify the existing uninstall record.'),
  '只能取消尚未执行的卸载计划':t('只能取消尚未执行的卸载计划','Only an unexecuted uninstall plan can be cancelled.'),
  '卸载计划已执行或结果待核对，不能重复执行':t('卸载计划已执行或结果待核对，不能重复执行','This uninstall plan has run or needs verification. It cannot run again.'),
  '卸载计划已过期，请取消并重新检查':t('卸载计划已过期，请取消并重新检查','The uninstall plan has expired. Cancel it and run a new check.'),
  '远端程序状态已变化，请核对后重新生成计划':t('远端程序状态已变化，请核对后重新生成计划','The remote runtime state has changed. Verify it before preparing another plan.'),
  '平台在卸载期间重启，请核对远端结果':t('平台在卸载期间重启，请核对远端结果','The platform restarted during removal. Verify the remote outcome.'),
  '远端 Agent 使用非受管服务文件，请人工核对':t('远端 Agent 使用非受管服务文件，请人工核对','The remote Agent uses an unmanaged service file. Verify it manually.'),
  '远端 Agent 生命周期操作尚未结束，请稍后核对':t('远端 Agent 生命周期操作尚未结束，请稍后核对','An Agent lifecycle operation is still in progress. Verify it after the operation ends.'),
  '此 Agent 已有其他主机的卸载流程，请先核对':t('此 Agent 已有其他主机的卸载流程，请先核对','Another host record already has a removal workflow for this Agent. Verify that workflow first.'),
  '卸载结果未知，请使用只读核对确认远端状态':t('卸载结果未知，请使用只读核对确认远端状态','The uninstall outcome is unknown. Use read-only verification to check the remote state.'),
  '卸载前检查失败，未执行移除':t('卸载前检查失败，未执行移除','Pre-removal checks failed; removal was not executed.'),
  '核对确认 Agent 程序完整，卸载未完成；请重新审阅计划':t('核对确认 Agent 程序完整，卸载未完成；请重新审阅计划','Verification found the Agent runtime still present. Removal is incomplete; prepare and review a new plan.'),
 }[value]||value);
 const errorText=(value:unknown)=>value instanceof Error?localizeMessage(value.message):t('操作失败','Operation failed');
 const time=(value?:string)=>value?new Date(value).toLocaleString(language):t('尚无记录','No records yet');
 const statusLabel=(status:string)=>({awaiting_approval:t('待确认','Awaiting approval'),running:t('正在卸载','Uninstalling'),succeeded:t('卸载完成','Uninstalled'),failed:t('卸载失败','Uninstall failed'),unknown:t('结果未知，需核对','Outcome unknown; verification needed'),cancelled:t('已取消','Cancelled')}[status]||status);
 const stepLabel=(step:string)=>({
  '核对远端 Agent 身份':t('核对远端 Agent 身份','Verify the remote Agent identity'),
  '停止并禁用 Agent 服务':t('停止并禁用 Agent 服务','Stop and disable the Agent service'),
  '移除 Agent 程序和服务文件':t('移除 Agent 程序和服务文件','Remove Agent runtime and service files'),
  '确认服务停止后移除 Agent 程序':t('确认服务停止后移除 Agent 程序','Verify the service has stopped, then remove Agent runtime'),
  '保留配置、身份与缓存':t('保留配置、身份与缓存','Retain configuration, identity, and cached telemetry'),
  '核验移除结果并撤销节点凭据':t('核验移除结果并撤销节点凭据','Verify removal and revoke Agent credentials'),
  '核验远端移除结果':t('核验远端移除结果','Verify removal on the host'),
  '撤销节点 control/data 凭据':t('撤销节点 control/data 凭据','Revoke the node control/data credentials'),
 }[step]||step);
 const warningLabel=(warning:string)=>({
  '采集和节点任务将停止；业务服务、制品、容器和卷保持不变。':t('采集和节点任务将停止；业务服务、制品、容器和卷保持不变。','Collection and node tasks stop. Business services, artifacts, containers, and volumes are retained.'),
  '默认保留配置和缓存，但旧节点凭据将撤销，重装需重新接入。':t('默认保留配置和缓存，但旧节点凭据将撤销，重装需先核查旧身份再重新接入。','Configuration and cache are retained, but old node credentials are revoked. Review the old identity before enrolling again.'),
  'SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。':t('SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。','An interrupted SSH connection may leave an unknown outcome. Use verification instead of retrying blindly.'),
 }[warning]||warning);
 useEffect(()=>()=>controller.current?.abort(),[]);
 useEffect(()=>{
  setNow(Date.now());const expires=Date.parse(record?.plan?.expires_at||'');
  if(!Number.isFinite(expires)||expires<=Date.now())return;
  const timer=setTimeout(()=>setNow(Date.now()),Math.min(2_147_483_647,expires-Date.now()+50));return()=>clearTimeout(timer);
 },[record?.plan?.expires_at]);
 const expired=!Number.isFinite(Date.parse(record?.plan?.expires_at||''))||Date.parse(record?.plan?.expires_at||'')<=now;
 const refresh=async()=>{
  if(!record)return;
  setBusy(true);setError('');
  try{setRecord(await api<AgentUninstallation>(`${prefix}/${encodeURIComponent(record.id)}`));setRefreshNeeded(false);await onRefresh()}catch(e){setError(errorText(e))}finally{setBusy(false)}
 };
 const makePlan=async(values:{credential_id:string})=>{
  const current=new AbortController();controller.current=current;setBusy(true);setError('');setCheck(undefined);
  try{
   const result=await api<SSHCheckResult>(`/machines/${encodeURIComponent(machine.id)}/ssh-check`,{method:'POST',body:JSON.stringify(values),signal:current.signal});setCheck(result);
   if(!result.ready)return;
   setRecord(await api<AgentUninstallation>(`${prefix}/plan`,{method:'POST',body:JSON.stringify({check_id:result.id,credential_id:values.credential_id}),signal:current.signal}));
   await onRefresh();
  }catch(e){if(!current.signal.aborted)setError(errorText(e))}finally{if(controller.current===current){controller.current=null;setBusy(false)}}
 };
 const action=async(operation:'apply'|'cancel'|'reconcile')=>{
  if(!record)return;
  setBusy(true);setError('');
  try{
   const result=await api<AgentUninstallation>(`${prefix}/${encodeURIComponent(record.id)}/${operation}`,{method:'POST',body:JSON.stringify(operation==='apply'?{confirm:true}:{})});
   setRecord(previous=>({...previous!,...result}));
  }catch(e){
   setError(errorText(e));
  }finally{
   // An interrupted request may have changed the host. Re-read the saved operation;
   // never treat a transport error as permission to repeat removal.
   try{setRecord(await api<AgentUninstallation>(`${prefix}/${encodeURIComponent(record.id)}`));setRefreshNeeded(false)}catch{setRefreshNeeded(true);setError(previous=>[previous,t('暂时无法刷新已保存的操作，请刷新状态后再继续；不要重复执行卸载。','The saved operation could not be refreshed. Refresh its status before continuing; do not repeat removal.')].filter(Boolean).join(' '))}
   await onRefresh();setBusy(false);
  }
 };
 const succeeded=record?.status==='succeeded';
 return <Modal title={t(`卸载 LightMoni Agent · ${machine.name}`,`Uninstall LightMoni Agent · ${machine.name}`)} open onCancel={()=>{if(!busy)onClose()}} closable={!busy} maskClosable={!busy} footer={null} width={780} destroyOnHidden>
  <Alert type="warning" showIcon className="lm-machine-form-notice" title={t('仅卸载 Agent，保留数据','Remove the Agent and retain data')} description={t('停止并移除独立 Agent 服务和运行程序，保留配置、身份、缓存、服务用户及业务服务。远端移除经核实后撤销该节点 control/data 凭据；保留的旧凭据将失效，重装须先人工核查保留的旧身份，再重新 enrollment。网页不提供彻底清除数据。','Stop and remove the independent Agent service and runtime. Retain configuration, identity, cached telemetry, service user, and business services. Revoke the node control/data credentials after verified removal. Retained old credentials become invalid; reinstalling requires manual review of the retained old identity and a new enrollment. Data purging is not available here.')}/>
  {!record&&<>
   <p>{t('先使用固定只读检查核对远端身份与中心绑定，生成计划后再确认；此步骤不会卸载 Agent。','Run fixed read-only checks to match the remote identity to the platform binding, then review the saved plan. This step does not uninstall the Agent.')}</p>
   {keys.length?<Form layout="vertical" onFinish={makePlan} disabled={busy} initialValues={{credential_id:keys.length===1?keys[0].id:undefined}}>
    <Form.Item label={t('可复用 SSH 凭据','Reusable SSH credential')} name="credential_id" rules={[{required:true,message:t('请选择有效私钥或可复用密码','Select an active key or reusable password')}]}><Select options={keys.map(c=>({value:c.id,label:`${c.method==='password'?(c.retention==='permanent'?t('永久密码','Permanent password'):c.retention==='managed'?t('托管密码','Managed password'):t('临时密码','Temporary password')):t('SSH 私钥','SSH private key')} · ${c.secret_fingerprint||c.id} · ${c.retention==='permanent'?t('永久','Permanent'):time(c.expires_at)}`}))}/></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy} block>{t('核对身份并生成卸载计划','Verify identity and create uninstall plan')}</Button>
   </Form>:<Alert type="info" showIcon title={t('卸载需要有效私钥或可复用密码','An active key or reusable password is required to uninstall')} description={t('请先添加有效私钥或临时、托管、永久密码；主机公钥由平台自动记录和校验。一次性密码不能用于自动卸载。','Add an active key or temporary, managed, or permanent password. The platform records and verifies the host public key automatically. Single-use passwords cannot be used for automatic removal.')}/>}
   {check&&<SSHCheckSummary result={check}/>}
  </>}
  {record&&<>
   <Alert className="lm-machine-form-notice" showIcon type={succeeded?'success':record.status==='unknown'?'warning':record.status==='failed'?'error':'info'} title={statusLabel(record.status)} description={record.status==='unknown'?t('SSH 连接中断或执行结果无法确定，远端可能已变更。只读核对不会再次执行卸载；只有确认程序和服务已移除且身份匹配后才撤销中心凭据。','The SSH connection or outcome is uncertain; the host may already have changed. Read-only verification does not repeat removal. Platform credentials are revoked only after service/runtime removal and matching identity are confirmed.'):record.error?localizeMessage(record.error):undefined}/>
   {record.plan&&<>
    <Descriptions size="small" column={1} items={[
     {key:'target',label:t('目标主机','Target host'),children:`${record.plan.machine.username}@${record.plan.machine.address}:${record.plan.machine.port}`},
     {key:'agent',label:t('已核对的节点身份','Verified Agent identity'),children:<Typography.Text code>{record.plan.agent_id}</Typography.Text>},
     {key:'credential',label:t('SSH 凭据 ID','SSH credential ID'),children:record.plan.credential.id},
     {key:'expiry',label:t('计划有效期','Plan expires at'),children:time(record.plan.expires_at)},
    ]}/>
    {!!record.plan.steps?.length&&<ol className="lm-machine-uninstall-steps">{record.plan.steps.map((step,index)=><li key={index}>{stepLabel(step)}</li>)}</ol>}
    {!!record.plan.warnings?.length&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('计划影响','Plan impact')} description={<ul className="lm-machine-uninstall-steps">{record.plan.warnings.map((warning,index)=><li key={index}>{warningLabel(warning)}</li>)}</ul>}/>}
    <Descriptions size="small" column={1} items={[
     {key:'removed',label:t('移除内容','Removed paths'),children:record.plan.removed_paths?.map(path=><Typography.Text code key={path} className="lm-machine-path">{path}</Typography.Text>)},
     {key:'retained',label:t('保留内容','Retained paths'),children:record.plan.retained_paths?.map(path=><Typography.Text code key={path} className="lm-machine-path">{path}</Typography.Text>)},
    ]}/>
   </>}
   {record.receipt&&<Descriptions className="lm-machine-form-notice" size="small" column={1} items={[
    {key:'removed',label:t('远端移除核验','Remote removal verification'),children:record.receipt.remote_removed===true?t('已确认移除','Removal confirmed'):t('尚未确认','Not confirmed')},
    ...((typeof record.receipt.service_stopped==='boolean')?[{key:'service',label:t('Agent 服务状态','Agent service state'),children:record.receipt.service_stopped?t('已停止，请在重新执行前核对服务状态','Stopped. Check the service state before another reviewed operation.'):t('仍在运行','Still running')}]:[]),
    {key:'retained',label:t('配置与缓存','Configuration and cache'),children:record.receipt.data_retained===true?t('已保留','Retained'):t('尚未确认','Not confirmed')},
    {key:'revoked',label:t('节点凭据撤销','Agent credential revocation'),children:record.receipt.credentials_revoked===true?t(`已撤销（${record.receipt.revoked_credentials??0} 条）`,`Revoked (${record.receipt.revoked_credentials??0})`):t('尚未完成','Not completed')},
    {key:'verified',label:t('核验时间','Verified at'),children:time(record.receipt.verified_at)},
   ]}/>}
   <Typography.Paragraph type="secondary">{t('卸载计划 ID：','Uninstall plan ID: ')}<Typography.Text code>{record.id}</Typography.Text></Typography.Paragraph>
   {record.status==='awaiting_approval'&&expired&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('卸载计划已过期，请先取消再重新检查','Uninstall plan expired. Cancel it before running a new check.')}/>}
   <Space wrap className="lm-machine-uninstall-actions">
    {record.status==='awaiting_approval'&&!refreshNeeded&&<><Popconfirm title={t('确认卸载这个已核对的 Agent？','Uninstall this verified Agent?')} description={t('会停止采集与节点任务，保留数据并撤销节点凭据。业务服务不受此流程管理。','Collection and node tasks stop. Data is retained and node credentials are revoked. Business services are outside this workflow.')} okText={t('确认卸载','Confirm uninstall')} cancelText={t('返回审阅','Back to review')} okButtonProps={{danger:true}} onConfirm={()=>action('apply')} disabled={busy||expired}><Button type="primary" danger disabled={busy||expired}>{t('我已审阅，卸载 Agent','I have reviewed the plan; uninstall Agent')}</Button></Popconfirm><Button disabled={busy} onClick={()=>void action('cancel')}>{t('取消卸载计划','Cancel uninstall plan')}</Button></>}
    {record.status==='unknown'&&!refreshNeeded&&<Button type="primary" aria-label={t('只读核对远端状态','Verify remote state (read-only)')} loading={busy} onClick={()=>void action('reconcile')}>{t('只读核对远端状态','Verify remote state (read-only)')}</Button>}
    {(refreshNeeded||['running','unknown'].includes(record.status))&&<Button aria-label={t('刷新操作状态','Refresh operation status')} disabled={busy} onClick={()=>void refresh()}>{t('刷新操作状态','Refresh operation status')}</Button>}
   </Space>
  </>}
  {error&&<Alert role="alert" className="lm-machine-form-notice" type="error" showIcon title={error}/>}
 </Modal>;
}
