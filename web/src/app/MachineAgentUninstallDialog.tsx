import {reusableMachineCredential,defaultMachineCredential} from './machine-credentials';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Form,Input,Modal,Popconfirm,Radio,Select,Space,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {useI18n} from '../shared/i18n';
import SSHCheckSummary,{type SSHCheckResult} from '../shared/SSHCheckSummary';
import {sshEndpoint} from './host-request-guard';
import AgentUninstallManual from './AgentUninstallManual';

type RemovalMode='standard'|'recovery';
type RevocationScope={eligible:boolean;agent_id:string;audiences:string[];reason:string};
type Observation={agent_id:string;identity_state:'valid'|'missing'|'invalid'|'unsafe';identity_sha256:string;program_sha256:string;installation:'present'|'absent';program_complete:boolean;unit_managed:boolean;service_running:boolean;lifecycle_locked:boolean;operation_lock:boolean;paths_safe:boolean;config_present:boolean;data_present:boolean};
export type AgentUninstallation={
 id:string;machine_id:string;agent_id:string;credential_id:string;
 status:'awaiting_approval'|'running'|'succeeded'|'failed'|'unknown'|'cancelled';
 plan?:{machine:{id:string;name:string;address:string;port:number;username:string;agent_id:string};agent_id:string;credential:{id:string;method:string;retention:string;expires_at:string};check_id:string;expires_at:string;mode?:RemovalMode;reason?:string;purge?:boolean;observation?:Observation;credential_revocation_scope?:RevocationScope;steps:string[];retained_paths:string[];removed_paths:string[];warnings:string[]};
 receipt?:{agent_id?:string;mode?:RemovalMode;purge?:boolean;remote_removed?:boolean;data_retained?:boolean;data_removed?:boolean;credential_revocation_scope?:RevocationScope;credentials_revoked?:boolean;revoked_credentials?:number;verified_at?:string;stages?:string[];service_stopped?:boolean;remote_unchanged?:boolean};
 error?:string;created_at?:string;finished_at?:string;
};
type Credential={name?:string;is_default?:boolean;id:string;method:string;retention?:string;expires_at:string;secret_fingerprint:string;revoked_at?:string;secret_cleared_at?:string};
type Props={machine:{default_credential_id?:string;id:string;name:string;capabilities?:{uninstall_agent?:{available:boolean};recovery_uninstall_agent?:{available:boolean}}};credentials:Credential[];existing?:AgentUninstallation;initialMode?:RemovalMode;onClose:()=>void;onRefresh:()=>Promise<void>};
type PlanRecovery={checkID:string;credentialID:string;mode:RemovalMode;purge:boolean;reason:string;priorIDs:Set<string>};

export default function MachineAgentUninstallDialog({machine,credentials,existing,initialMode='standard',onClose,onRefresh}:Props){
 const {t,language}=useI18n();
 const [record,setRecord]=useState(existing),[check,setCheck]=useState<SSHCheckResult>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now()),[refreshNeeded,setRefreshNeeded]=useState(false),[planUncertain,setPlanUncertain]=useState(false),[applyAttempted,setApplyAttempted]=useState(false);
 const [mode,setMode]=useState<RemovalMode|'manual'>(initialMode),[reason,setReason]=useState(''),[purge,setPurge]=useState(false),[credential,setCredential]=useState<string|undefined>(()=>defaultMachineCredential(credentials,machine.default_credential_id,reusableMachineCredential));
 const pending=useRef(false),mounted=useRef(true),recordRef=useRef(record),recovery=useRef<PlanRecovery|undefined>(undefined);
 recordRef.current=record;
 const prefix=`/machines/${encodeURIComponent(machine.id)}/uninstallations`;
 const keys=credentials.filter(c=>reusableMachineCredential(c));
 const standardAllowed=machine.capabilities?.uninstall_agent?.available!==false;
 const recoveryAllowed=machine.capabilities?.recovery_uninstall_agent?.available===true;
 const localizeMessage=(value:string)=>({
  '远端 Agent 不是本平台已登记的独立凭据节点，可审阅 SSH 恢复卸载':t('远端 Agent 不是本平台已登记的独立凭据节点，可审阅 SSH 恢复卸载','The remote Agent has no independent credential registration on this platform. Review an SSH recovery uninstall.'),
  '主机或实际 Agent 有未结束任务，请先完成或核对':t('主机或实际 Agent 有未结束任务，请先完成或核对','The host or observed Agent has unfinished tasks. Complete or verify them first.'),
  '远端 Agent 路径不安全，请人工核对':t('远端 Agent 路径不安全，请人工核对','The remote Agent paths are unsafe. Verify them manually.'),
  '远端 Agent 存在生命周期锁或未完成操作，请先核对':t('远端 Agent 存在生命周期锁或未完成操作，请先核对','A lifecycle lock or unfinished operation exists on the host. Verify it first.'),
  '远端身份、配置或状态目录缺失，请使用 SSH 恢复卸载':t('远端身份、配置或状态目录缺失，请使用 SSH 恢复卸载','Remote identity, configuration, or state is missing. Review an SSH recovery uninstall.'),
  '主机名称、连接或节点关联已变化，请重新核对':t('主机名称、连接或节点关联已变化，请重新核对','The host name, connection, or Agent binding changed. Verify it again.'),
  '尚未确认 Agent 服务和固定程序已安全移除':t('尚未确认 Agent 服务和固定程序已安全移除','Safe removal of the Agent service and fixed runtime paths is not confirmed.'),
  'Agent 数据保留或清除策略尚未核实':t('Agent 数据保留或清除策略尚未核实','The Agent data retention or purge policy has not been verified.'),
  '远端 Agent 已移除，没有待卸载内容':t('远端 Agent 已移除，没有待卸载内容','The remote Agent has been removed. There is nothing to uninstall.'),
  '主机在检查期间变化，请重新计划':t('主机在检查期间变化，请重新计划','The host changed during verification. Create a new plan.'),
  '旧卸载计划没有审批快照，请取消并重新生成计划':t('旧卸载计划没有审批快照，请取消并重新生成计划','This old uninstall plan has no approved snapshot. Cancel it and create a new plan.'),
  '远端 Agent 证据与审核计划不一致，请重新计划':t('远端 Agent 证据与审核计划不一致，请重新计划','Remote Agent evidence differs from the reviewed plan. Create a new plan.'),
  '核对确认原程序完整未移除，请重新审阅':t('核对确认原程序完整未移除，请重新审阅','Verification confirmed the original runtime remains complete. Prepare a new plan for review.'),
  '当前主机绑定、远端身份及安装预约归属一致':t('当前主机绑定、远端身份及安装预约归属一致','The host binding, observed identity, and installation reservation establish ownership by this host.'),
  '未证明实际身份归属当前主机，不撤销任何平台身份':t('未证明实际身份归属当前主机，不撤销任何平台身份','The observed identity is not proven to belong to this host. No platform identity will be revoked.'),
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
  '核对固定 SSH 目标和已审阅的远端证据':t('核对固定 SSH 目标和已审阅的远端证据','Verify the pinned SSH target and approved remote evidence'),
  '停止并禁用受管 Agent 服务':t('停止并禁用受管 Agent 服务','Stop and disable the managed Agent service'),
  '复验任务标记后移除固定程序':t('复验任务标记后移除固定程序','Recheck task markers, then remove the fixed runtime paths'),
  '明确清除 Agent 配置、身份和缓存':t('明确清除 Agent 配置、身份和缓存','Explicitly purge Agent configuration, identity, and cache'),
  '保留 Agent 配置、身份和缓存':t('保留 Agent 配置、身份和缓存','Retain Agent configuration, identity, and cache'),
  '核验结果并仅撤销确属本主机的凭据':t('核验结果并仅撤销确属本主机的凭据','Verify the result and revoke only credentials proven to belong to this host'),
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
  '不会删除业务数据、系统账户或平台主机记录。':t('不会删除业务数据、系统账户或平台主机记录。','Business data, the system account, and the platform host record are retained.'),
  'Agent 配置、身份及缓存将清除；完成后可进行全新接入。':t('Agent 配置、身份及缓存将清除；完成后可进行全新接入。','Agent configuration, identity, and cache will be purged. A fresh installation can follow after completion.'),
  '保留数据会继续触发 fresh 保护，重新接入前需明确清除。':t('保留配置与身份后，重新安装前仍需明确清除旧数据。','Retained configuration and identity continue to block a fresh installation until the old data is explicitly purged.'),
  '派发后中断进入未知结果，仅可只读核对，不自动重放。':t('派发后中断进入未知结果，仅可只读核对，不自动重放。','An interruption after dispatch leaves an unknown outcome. Verify it read-only; it will not be replayed automatically.'),
  '采集和节点任务将停止；业务服务、制品、容器和卷保持不变。':t('采集和节点任务将停止；业务服务、制品、容器和卷保持不变。','Collection and node tasks stop. Business services, artifacts, containers, and volumes are retained.'),
  '默认保留配置和缓存，但旧节点凭据将撤销，重装需重新接入。':t('默认保留配置和缓存，但旧节点凭据将撤销，重装需先核查旧身份再重新接入。','Configuration and cache are retained, but old node credentials are revoked. Review the old identity before enrolling again.'),
  'SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。':t('SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。','An interrupted SSH connection may leave an unknown outcome. Use verification instead of retrying blindly.'),
 }[warning]||warning);
 const identityError=()=>Error(t('卸载记录与目标主机或原计划不匹配，请只读核对','The uninstall record does not match this host or original plan. Verify it read-only.'));
 const validate=(next:AgentUninstallation,id?:string)=>{if(!next?.id||next.machine_id!==machine.id||id&&next.id!==id||next.plan?.machine.id&&next.plan.machine.id!==machine.id)throw identityError();return next};
 const save=(next:AgentUninstallation)=>{if(mounted.current){recordRef.current=next;setRecord(next)}};
 const begin=()=>{if(pending.current)return false;pending.current=true;setBusy(true);setError('');return true};
 const finish=()=>{pending.current=false;if(mounted.current)setBusy(false)};
 const refreshParent=async()=>{try{await onRefresh()}catch{if(mounted.current)setError(previous=>[previous,t('主机列表刷新失败，请稍后刷新。','The host list could not refresh. Refresh it later.')].filter(Boolean).join(' '))}};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
 useEffect(()=>{setCredential(previous=>keys.some(key=>key.id===previous)?previous:defaultMachineCredential(keys,machine.default_credential_id,reusableMachineCredential))},[credentials,machine.default_credential_id]);
 useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[record?.plan?.expires_at]);
 const expired=!Number.isFinite(Date.parse(record?.plan?.expires_at||''))||Date.parse(record?.plan?.expires_at||'')<=now;
 const reasonValid=!!reason.trim()&&new TextEncoder().encode(reason.trim()).length<=1000&&!/[\u0000-\u001f\u007f]/u.test(reason.trim());
 const readRecord=async()=>{const saved=recordRef.current;if(!saved)throw identityError();const next=validate(await api<AgentUninstallation>(`${prefix}/${encodeURIComponent(saved.id)}`),saved.id);save(next);setRefreshNeeded(false);return next};
 const recoverPlan=async()=>{
  const attempt=recovery.current;if(!attempt)throw identityError();
  const history=await api<AgentUninstallation[]>(prefix);
  const matches=history.filter(saved=>saved.machine_id===machine.id&&!attempt.priorIDs.has(saved.id)&&saved.plan?.check_id===attempt.checkID&&saved.plan?.credential?.id===attempt.credentialID&&(saved.plan?.mode||'standard')===attempt.mode&&!!saved.plan?.purge===attempt.purge&&(saved.plan?.reason||'')===attempt.reason);
  if(matches.length!==1)throw Error(t('无法确认原卸载记录，请刷新并核对主机卸载历史；不要重复创建计划。','The original uninstall record could not be confirmed. Refresh and check host uninstall history; do not create another plan.'));
  const saved=validate(await api<AgentUninstallation>(`${prefix}/${encodeURIComponent(matches[0].id)}`),matches[0].id);
  if(saved.plan?.check_id!==attempt.checkID||saved.plan?.credential.id!==attempt.credentialID||(saved.plan?.mode||'standard')!==attempt.mode||!!saved.plan?.purge!==attempt.purge||(saved.plan?.reason||'')!==attempt.reason)throw identityError();
  save(saved);setPlanUncertain(false);setRefreshNeeded(false);return saved;
 };
 const refresh=async()=>{if(!begin())return;try{if(recordRef.current)await readRecord();else await recoverPlan();await refreshParent()}catch(e){if(mounted.current){setError(errorText(e));setRefreshNeeded(true)}}finally{finish()}};
 const makePlan=async()=>{
  if(mode==='manual'||!credential||!keys.some(key=>key.id===credential)||planUncertain||mode==='standard'&&!standardAllowed||mode==='recovery'&&(!recoveryAllowed||!reasonValid)||!begin())return;
  let creating=false;
  try{
   const history=await api<AgentUninstallation[]>(prefix);if(!mounted.current)return;if(!Array.isArray(history)||history.some(item=>item.machine_id!==machine.id))throw identityError();
   const result=await api<SSHCheckResult>(`/machines/${encodeURIComponent(machine.id)}/ssh-check`,{method:'POST',body:JSON.stringify({credential_id:credential})});
   if(!mounted.current)return;if(result.machine_id!==machine.id||result.credential_id!==credential)throw identityError();if(mounted.current)setCheck(result);if(!result.ready)return;
   recovery.current={checkID:result.id,credentialID:credential,mode,purge,reason:mode==='recovery'?reason.trim():'',priorIDs:new Set(history.map(item=>item.id))};creating=true;
   const next=validate(await api<AgentUninstallation>(`${prefix}/plan`,{method:'POST',body:JSON.stringify({check_id:result.id,credential_id:credential,mode,purge,...(mode==='recovery'?{reason:reason.trim()}:{})})}));
   if(next.plan?.check_id!==result.id||next.plan?.credential.id!==credential||(next.plan?.mode||'standard')!==mode||!!next.plan?.purge!==purge||(next.plan?.reason||'')!==(mode==='recovery'?reason.trim():''))throw identityError();save(next);
  }catch(e){if(mounted.current){setError(errorText(e));if(creating&&!(e instanceof ApiError&&e.status<500)){setPlanUncertain(true);setRefreshNeeded(true);try{await recoverPlan();if(mounted.current)setError('')}catch(recoveryError){if(mounted.current)setError(errorText(recoveryError))}}}}finally{await refreshParent();finish()}
 };
 const action=async(operation:'apply'|'cancel'|'reconcile')=>{
  const saved=recordRef.current;
  if(!saved||saved.machine_id!==machine.id||refreshNeeded||operation==='apply'&&(saved.status!=='awaiting_approval'||expired||applyAttempted)||operation==='reconcile'&&(saved.status!=='unknown'||!credential||!keys.some(key=>key.id===credential))||!begin())return;
  if(operation==='apply')setApplyAttempted(true);
  try{const next=validate(await api<AgentUninstallation>(`${prefix}/${encodeURIComponent(saved.id)}/${operation}`,{method:'POST',body:JSON.stringify(operation==='apply'?{confirm:true}:operation==='reconcile'?{credential_id:credential}:{})}),saved.id);save(next)}
  catch(e){if(mounted.current)setError(errorText(e))}
  finally{try{await readRecord()}catch{if(mounted.current){setRefreshNeeded(true);setError(previous=>[previous,t('暂时无法刷新已保存的操作，请刷新状态后再继续；不要重复执行卸载。','The saved operation could not be refreshed. Refresh its status before continuing; do not repeat removal.')].filter(Boolean).join(' '))}}await refreshParent();finish()}
 };
 useEffect(()=>{if(record?.status!=='running')return;let active=true;const timer=setInterval(()=>{if(!pending.current&&active)void refresh()},4000);return()=>{active=false;clearInterval(timer)}},[record?.id,record?.status]);
 const succeeded=record?.status==='succeeded',scope=record?.plan?.credential_revocation_scope,observation=record?.plan?.observation;
 const dataPolicy=(remove:boolean)=>remove?t('清除 Agent 配置、身份与缓存','Purge Agent configuration, identity, and cache'):t('保留 Agent 配置、身份与缓存','Retain Agent configuration, identity, and cache');
 const scopeText=(value?:RevocationScope)=>!value?t('仅按远端身份与本主机关联核验后处理','Only after verifying remote identity and ownership by this host'):value.eligible?t(`仅撤销 ${value.agent_id} 的 ${value.audiences.join(' / ')} 凭据`,`Revoke only ${value.agent_id} ${value.audiences.join(' / ')} credentials`):t('无已证明属于本主机的可撤销身份；不撤销其他凭据','No revocable identity is proven to belong to this host; other credentials will not be revoked');
 const credentialSelect=<Select aria-label={t('卸载 SSH 凭据','Uninstall SSH credential')} value={credential} disabled={busy||planUncertain} style={{width:'100%'}} onChange={setCredential} options={keys.map(c=>({value:c.id,label:`${c.name||(c.method==='password'?t('密码','Password'):t('SSH 私钥','SSH private key'))} · ${c.secret_fingerprint||c.id} · ${c.retention==='permanent'?t('永久','Permanent'):time(c.expires_at)}`}))}/>;
 return <Modal title={t(`卸载 LightMoni Agent · ${machine.name}`,`Uninstall LightMoni Agent · ${machine.name}`)} open style={{top:24}} onCancel={()=>{if(!busy)onClose()}} closable={!busy} maskClosable={false} footer={null} width={820} destroyOnHidden>
  {!record&&<>
   <Radio.Group aria-label={t('卸载方式','Uninstall method')} value={mode} disabled={busy||planUncertain} onChange={event=>{setMode(event.target.value);setError('');setCheck(undefined)}} className="lm-machine-form-notice">
    <Radio.Button value="standard" disabled={!standardAllowed}>{t('标准卸载','Standard uninstall')}</Radio.Button><Radio.Button value="recovery" disabled={!recoveryAllowed}>{t('SSH 恢复卸载（强制）','SSH recovery uninstall (forced)')}</Radio.Button><Radio.Button value="manual">{t('离线脚本','Offline script')}</Radio.Button>
   </Radio.Group>
   {mode==='manual'?<AgentUninstallManual/>:<>
    <Alert type={mode==='recovery'?'warning':'info'} showIcon title={mode==='recovery'?t('恢复处理残留或登记不完整的 Agent','Recover a partial or incompletely registered Agent'):t('标准卸载先严格核对 Agent 归属','Standard uninstall strictly verifies Agent ownership')} description={mode==='recovery'?t('恢复模式允许缺失或损坏身份，但仍校验 SSH 指纹、远端实际状态、服务归属、固定路径、未完成任务和生命周期锁；不会越过其他主机的身份或强行杀任务。','Recovery allows missing or invalid identity, while still checking the SSH fingerprint, actual remote state, service ownership, fixed paths, unfinished tasks, and lifecycle locks. It cannot take another host’s identity or force-kill tasks.'):t('通过只读 SSH 检查生成持久计划，审阅实际远端状态后再确认。此步骤不会卸载 Agent。','Create a persistent plan through read-only SSH checks, then review the actual remote state before confirming. This step does not uninstall Agent.')}/>
    <Form layout="vertical" onFinish={()=>void makePlan()} disabled={busy||planUncertain}>
     <Form.Item label={t('可复用 SSH 凭据','Reusable SSH credential')}>{credentialSelect}</Form.Item>
     {mode==='recovery'&&<Form.Item label={t('恢复原因（必填，最多 1000 字节）','Recovery reason (required, up to 1000 bytes)')}><Input.TextArea aria-label={t('恢复原因','Recovery reason')} rows={3} value={reason} onChange={event=>setReason(event.target.value)}/></Form.Item>}
     <Form.Item><Checkbox checked={purge} onChange={event=>setPurge(event.target.checked)}>{t('同时清除 Agent 配置、身份与缓存','Also purge Agent configuration, identity, and cache')}</Checkbox><Typography.Paragraph type="secondary">{dataPolicy(purge)}{t('；业务服务、业务数据与系统用户保留。生成计划后不可更改此选项。','; business services, business data, and the system user are retained. This choice is fixed when the plan is created.')}</Typography.Paragraph></Form.Item>
     <Button aria-label={t('核对身份并生成卸载计划','Verify identity and create uninstall plan')} type="primary" htmlType="submit" loading={busy} block disabled={!credential||!keys.some(key=>key.id===credential)||mode==='standard'&&!standardAllowed||mode==='recovery'&&(!recoveryAllowed||!reasonValid)||planUncertain}>{t('核对身份并生成卸载计划','Verify identity and create uninstall plan')}</Button>
    </Form>
    {!keys.length&&<Alert type="info" showIcon title={t('请先添加有效私钥或可复用密码，或使用离线脚本','Add an active key or reusable password, or use the offline script')}/>}
    {check&&<SSHCheckSummary result={check}/>}
   </>}
   {planUncertain&&<Alert showIcon type="warning" title={t('计划创建结果未确认，已禁止重复创建','Plan creation is uncertain; duplicate creation is blocked')} description={t('仅刷新并恢复与本次检查、凭据、模式和数据策略完全一致的原计划。','Refresh only to recover the original plan with the same check, credential, mode, and data policy.')}/>}
   {(planUncertain||refreshNeeded)&&<Button disabled={busy} onClick={()=>void refresh()}>{t('刷新并恢复原计划','Refresh and recover original plan')}</Button>}
  </>}
  {record&&<>
   <Alert className="lm-machine-form-notice" showIcon type={succeeded?'success':record.status==='unknown'?'warning':record.status==='failed'?'error':'info'} title={statusLabel(record.status)} description={record.status==='unknown'?t('远端可能已经改变。只读核对检查原操作，不会重放卸载；可选择当前有效 SSH 凭据。','The host may already have changed. Read-only verification checks the original operation without replaying removal. Select a currently active SSH credential.'):record.error?localizeMessage(record.error):undefined}/>
   {record.plan&&<>
    <Descriptions size="small" layout="vertical" column={1} items={[
     {key:'target',label:t('目标主机','Target host'),children:sshEndpoint(record.plan.machine.address,record.plan.machine.port,record.plan.machine.username)},
     {key:'mode',label:t('卸载方式','Uninstall method'),children:record.plan.mode==='recovery'?t('SSH 恢复卸载（强制）','SSH recovery uninstall (forced)'):t('标准卸载','Standard uninstall')},
     ...(record.plan.reason?[{key:'reason',label:t('恢复原因','Recovery reason'),children:record.plan.reason}]:[]),
     {key:'policy',label:t('已固定的数据策略','Pinned data policy'),children:dataPolicy(!!record.plan.purge)},
     {key:'agent',label:t('已核对的节点身份','Verified Agent identity'),children:record.plan.agent_id?<Typography.Text code>{record.plan.agent_id}</Typography.Text>:t('未取得有效身份','No valid identity observed')},
     {key:'scope',label:t('平台凭据撤销范围','Platform credential revocation scope'),children:scopeText(scope)},
     ...(scope?.reason?[{key:'ownership',label:t('归属核验说明','Ownership evidence'),children:localizeMessage(scope.reason)}]:[]),
     {key:'credential',label:t('SSH 凭据 ID','SSH credential ID'),children:record.plan.credential.id},
     {key:'expiry',label:t('计划有效期','Plan expires at'),children:time(record.plan.expires_at)},
    ]}/>
    {observation&&<><h3>{t('实际远端快照（执行前会再次核验）','Actual remote snapshot (rechecked before execution)')}</h3><Descriptions size="small" layout="vertical" column={{xs:1,sm:2}} items={[
     {key:'identity-state',label:t('身份文件','Identity file'),children:({valid:t('有效','Valid'),missing:t('缺失','Missing'),invalid:t('损坏','Invalid'),unsafe:t('路径不安全','Unsafe path')})[observation.identity_state]},
     {key:'runtime',label:t('运行程序','Runtime'),children:observation.installation==='absent'?t('已缺失','Absent'):observation.program_complete?t('完整','Complete'):t('部分残留','Partial runtime')},
     {key:'unit',label:t('受管服务文件','Managed service file'),children:observation.unit_managed?t('已核验','Verified'):t('不存在或未归属','Absent or unowned')},
     {key:'running',label:t('服务运行状态','Service running state'),children:observation.service_running?t('运行中','Running'):t('已停止','Stopped')},
     {key:'config',label:t('配置目录','Configuration directory'),children:observation.config_present?t('存在','Present'):t('不存在','Absent')},
     {key:'data',label:t('缓存目录','Cache directory'),children:observation.data_present?t('存在','Present'):t('不存在','Absent')},
     {key:'paths',label:t('固定路径检查','Fixed path checks'),children:observation.paths_safe?t('通过','Passed'):t('未通过','Failed')},
     {key:'locks',label:t('生命周期锁 / 操作标记','Lifecycle lock / operation marker'),children:observation.lifecycle_locked||observation.operation_lock?t('存在，执行将受阻','Present; execution is blocked'):t('未发现','None observed')},
     {key:'identity-sha',label:t('身份文件 SHA256','Identity file SHA256'),span:2,children:<Typography.Text code className="lm-machine-path">{observation.identity_sha256}</Typography.Text>},
     {key:'runtime-sha',label:t('程序快照 SHA256','Runtime snapshot SHA256'),span:2,children:<Typography.Text code className="lm-machine-path">{observation.program_sha256}</Typography.Text>},
    ]}/></>}
    {!!record.plan.steps?.length&&<ol className="lm-machine-uninstall-steps">{record.plan.steps.map((step,index)=><li key={index}>{stepLabel(step)}</li>)}</ol>}
    {!!record.plan.warnings?.length&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('计划影响','Plan impact')} description={<ul className="lm-machine-uninstall-steps">{record.plan.warnings.map((warning,index)=><li key={index}>{warningLabel(warning)}</li>)}</ul>}/>}
    <Descriptions size="small" layout="vertical" column={1} items={[
     {key:'removed',label:t('移除内容','Removed paths'),children:record.plan.removed_paths?.map(path=><Typography.Text code key={path} className="lm-machine-path">{path}</Typography.Text>)},
     {key:'retained',label:t('保留内容','Retained paths'),children:record.plan.retained_paths?.map(path=><Typography.Text code key={path} className="lm-machine-path">{path}</Typography.Text>)},
    ]}/>
   </>}
   {record.receipt&&<Descriptions className="lm-machine-form-notice" size="small" layout="vertical" column={1} items={[
    {key:'removed',label:t('远端移除核验','Remote removal verification'),children:record.receipt.remote_removed===true?t('已确认移除','Removal confirmed'):t('尚未确认','Not confirmed')},
    ...(typeof record.receipt.service_stopped==='boolean'?[{key:'service',label:t('Agent 服务状态','Agent service state'),children:record.receipt.service_stopped?t('已停止，请在重新执行前核对服务状态','Stopped. Check the service state before another reviewed operation.'):t('仍在运行','Still running')}]:[]),
    {key:'data',label:t('配置与缓存','Configuration and cache'),children:record.receipt.data_removed===true?t('已清除 Agent 配置、身份与缓存','Agent configuration, identity, and cache purged'):record.receipt.data_retained===true?t('已保留','Retained'):t('尚未确认','Not confirmed')},
    {key:'scope',label:t('平台凭据撤销范围','Platform credential revocation scope'),children:scopeText(record.receipt.credential_revocation_scope||scope)},
    {key:'revoked',label:t('节点凭据撤销','Agent credential revocation'),children:record.receipt.credentials_revoked===true?t(`已撤销（${record.receipt.revoked_credentials??0} 条）`,`Revoked (${record.receipt.revoked_credentials??0})`):(record.receipt.credential_revocation_scope||scope)?.eligible===false?t('不适用：没有已证明属于本主机的可撤销凭据','Not applicable: no revocable credentials are proven to belong to this host'):t('尚未完成','Not completed')},
    {key:'verified',label:t('核验时间','Verified at'),children:time(record.receipt.verified_at)},
   ]}/>}
   <Typography.Paragraph type="secondary">{t('卸载计划 ID：','Uninstall plan ID: ')}<Typography.Text code>{record.id}</Typography.Text></Typography.Paragraph>
   {record.status==='awaiting_approval'&&expired&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('卸载计划已过期，请先取消再重新检查','Uninstall plan expired. Cancel it before running a new check.')}/>}
   {record.status==='awaiting_approval'&&applyAttempted&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('原计划执行请求已发送，请只读刷新确认结果','The original execution request was sent. Refresh read-only to confirm its outcome')}/>}
   {record.status==='unknown'&&<div className="lm-machine-form-notice"><Typography.Paragraph>{t('核对使用当前有效 SSH 凭据','Use a currently active SSH credential for verification')}</Typography.Paragraph>{credentialSelect}{!keys.length&&<Typography.Paragraph>{t('请先为此主机添加有效 SSH 凭据，再打开原记录核对。','Add an active SSH credential to this host, then reopen the original record for verification.')}</Typography.Paragraph>}</div>}
   <Space wrap className="lm-machine-uninstall-actions">
    {record.status==='awaiting_approval'&&!refreshNeeded&&<><Popconfirm title={t('确认按此固定计划卸载 Agent？','Uninstall Agent using this fixed plan?')} description={<>{dataPolicy(!!record.plan?.purge)}。{scopeText(scope)}。</>} okText={t('确认卸载','Confirm uninstall')} cancelText={t('返回审阅','Back to review')} okButtonProps={{danger:true}} onConfirm={()=>action('apply')} disabled={busy||expired||applyAttempted}><Button type="primary" danger disabled={busy||expired||applyAttempted}>{t('我已审阅，卸载 Agent','I have reviewed the plan; uninstall Agent')}</Button></Popconfirm><Button disabled={busy||applyAttempted} onClick={()=>void action('cancel')}>{t('取消卸载计划','Cancel uninstall plan')}</Button></>}
    {record.status==='unknown'&&!refreshNeeded&&<Button type="primary" aria-label={t('只读核对远端状态','Verify remote state (read-only)')} loading={busy} disabled={!credential||!keys.some(key=>key.id===credential)} onClick={()=>void action('reconcile')}>{t('只读核对远端状态','Verify remote state (read-only)')}</Button>}
    <Button aria-label={t('刷新操作状态','Refresh operation status')} disabled={busy} onClick={()=>void refresh()}>{t('刷新操作状态','Refresh operation status')}</Button>
   </Space>
  </>}
  {error&&<Alert role="alert" className="lm-machine-form-notice" type="error" showIcon title={error}/>}
 </Modal>;
}
