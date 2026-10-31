import HostInventory from "./ops/HostInventory";
import SystemLogDrawer from "./ops/SystemLogDrawer";
import {useI18n} from '../shared/i18n';
import {useCallback,useEffect,useRef,useState} from 'react';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Descriptions,Empty,Form,Input,InputNumber,Modal,Popconfirm,Select,Space,Table,Tag,Typography,App,Checkbox} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import {useSearchParams} from 'react-router-dom';
import SSHCheckSummary,{type SSHCheckResult} from '../shared/SSHCheckSummary';
import './machines.css';
import MachineTerminalDialog from './MachineTerminalDialog';
import {createHostRequestGuard,sshEndpoint,type HostRequestToken,type HostRequestScope} from './host-request-guard';
import MachineCredentialForm from './MachineCredentialForm';
import MachineRegistrationDialog from './MachineRegistrationDialog';
import {activeMachineCredential,reusableMachineCredential,defaultMachineCredential} from './machine-credentials';
import HostNetworkSummary,{type HostNetwork} from './HostNetworkSummary';
import MachineEditDialog from './MachineEditDialog';
import MachineAgentUninstallDialog,{type AgentUninstallation} from './MachineAgentUninstallDialog';
import {agentIsOnline,type AgentItem,type AgentTaskLabel,type TaskHost} from './agent-model';
import {NodeDetails} from './AgentsPage';
import NodeLabelsDialog from './NodeLabelsDialog';
import HostTasksPanel from './HostTasksPanel';
import MachineBatchDialog,{type BatchAction,type BatchTarget} from './MachineBatchDialog';
import MachineAgentUpdateDialog,{AgentUpdateHistory} from './MachineAgentUpdateDialog';
import MachineAgentRolloutDialog,{type AgentRolloutTarget} from './MachineAgentRolloutDialog';
import {shortIdentity,type AgentInstalledRelease,type AgentUpdate} from './agent-update-model';

type Capability={available:boolean;reason:string};
type Machine={agent_release?:AgentInstalledRelease;agent_update?:{state:'current'|'update_available'|'unknown'|'not_installed'|'in_progress';target_sha256?:string;target_version?:string;last_status?:string;last_operation_id?:string};default_credential_id?:string;network?:HostNetwork;label_ids?:string[];labels?:{id:string;name:string}[];observed_hostname?:string;id:string;name:string;address:string;port:number;username:string;connection_method:string;host_key_fingerprint:string;host_key_public_key?:string;host_key_observed_at?:string;host_key_status:string;platform:string;arch:string;agent_id:string;agent_status:string;credential_count:number;active_credential_count:number;active_ssh_credential_count:number;active_ssh_key_count:number;active_reusable_ssh_credential_count?:number;ssh_recovery_available:boolean;capabilities:{terminal:Capability;ssh_check:Capability;deploy_agent:Capability;uninstall_agent?:Capability;update_agent?:Capability;rollback_agent?:Capability};last_deployment_status:string;last_uninstallation_status?:string;updated_at:string;created_at:string};
type FleetRow=Machine&{node?:AgentItem};
type Credential={id:string;name?:string;is_default?:boolean;connection_credential_id?:string;reused?:boolean;method:string;secret_fingerprint:string;retention:string;policy_source:string;secret_cleared_at?:string;clear_reason?:string;created_at:string;expires_at:string;revoked_at?:string;last_used_at:string;created_by:string};
type Deployment={id:string;machine_id:string;credential_id:string;status:string;version:string;arch:string;initial_label_id:string;plan:any;receipt:any;error:string;created_at:string;approved_at:string;started_at:string;finished_at:string};
type Detail={machine:Machine;credentials:Credential[];deployments:Deployment[];uninstallations?:AgentUninstallation[]};

export default function MachinesPage({user,embedded=false}:{user:User;embedded?:boolean}){
 const {t,language:uiLanguage}=useI18n();
const errorText=(e:unknown)=>e instanceof Error?e.message:t("操作失败","Operation failed");
const lifecycleErrorText=(e:unknown)=>({
 "此主机有终端、检查或部署正在进行，请先结束后重试":t("此主机有终端、检查或部署正在进行，请先结束后重试","This host has an active terminal, check, or deployment. Finish it and retry."),
 "请先解绑本主机的有效连接凭据后再删除主机":t("请先解绑本主机的有效连接凭据后再删除主机","Unlink this host’s active connection credentials before deleting the host."),
 "请先移除关联 Agent 或核验卸载完成并撤销身份，再删除主机":t("请先移除关联 Agent 或核验卸载完成并撤销身份，再删除主机","Remove the linked Agent identity, or verify uninstallation and revoke its identity, before deleting this host."),
 "该主机有未结束的部署任务，请先完成或取消后再删除":t("该主机有未结束的部署任务，请先完成或取消后再删除","This host has an unfinished deployment. Finish or cancel it before deleting the host."),
 "此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对":t("此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对","This host has a pending, running, or uncertain Agent removal. Cancel or verify it first."),
 "只能取消尚未执行的部署计划":t("只能取消尚未执行的部署计划","Only an unexecuted deployment plan can be cancelled."),
}[errorText(e)]||errorText(e));
const time=(value:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(uiLanguage):t("尚无记录","No records yet");
const activeCredential=(c:Credential)=>activeMachineCredential(c);
const reusableCredential=(c:Credential)=>reusableMachineCredential(c);
const credentialExpiry=(c:Credential)=>c.retention==='permanent'?t('永久','Permanent'):time(c.expires_at);
const credentialTypeName=(c:Credential)=>c.method==='password'?(c.retention==='one_time'||!c.retention?t('一次性密码','One-time password'):c.retention==='permanent'?t('永久密码','Permanent password'):c.retention==='managed'?t('托管密码','Managed password'):t('临时密码（可复用）','Temporary password (reusable)')):t('SSH 私钥','SSH private key');
const credentialName=(c:Credential)=>c.name||credentialTypeName(c);
const capabilityReason=(reason:string)=>({host_busy:t('此主机有终端、检查或部署正在进行，请结束后重试','This host has an active terminal, check, or deployment. Finish it and retry.'),direct_ssh_required:t('尚未配置直接 SSH，可在“编辑主机”中补充连接信息','Direct SSH is not configured. Add connection details in Edit host.'),ssh_credential_required:t('连接凭据已过期、撤销或清除，请添加新的 SSH 凭据','SSH credentials have expired, been revoked, or been cleared. Add a new SSH credential.'),ssh_key_required:t('自动安装或卸载需要有效 SSH 私钥或可复用密码；一次性密码不能用于操作','Automatic installation and removal need an active SSH private key or reusable password. Single-use passwords cannot be used.'),reusable_ssh_credential_required:t('请添加有效 SSH 私钥或临时/按期限托管的密码；一次性密码不能用于安装或卸载','Add an active SSH private key or a temporary/managed password. Single-use passwords cannot install or uninstall Agent.'),agent_not_linked:t('此主机尚未绑定可核对的 Agent，无法自动卸载','This host has no linked Agent identity to verify for automatic removal.'),agent_task_busy:t('节点有运行中、已派发或结果未知的任务，请先完成或核对','The Agent has running, dispatched, or uncertain tasks. Finish or verify them first.'),uninstallation_pending:t('此主机有待确认的卸载计划，请在详情的卸载历史中审阅或取消','This host has a pending uninstall plan. Review or cancel it in Uninstall history.'),uninstallation_unknown:t('上次卸载结果未知，请在详情的卸载历史中只读核对','The previous removal outcome is unknown. Use read-only verification in Uninstall history.'),agent_already_installed:t('已有 Agent，不能覆盖安装；请先核对现有节点','An Agent already exists. Verify the existing node before proceeding.')}[reason]||t('暂不可用，请刷新主机状态','Unavailable. Refresh the host status.'));
const updateCapabilityReason=(reason:string)=>({agent_not_linked:t('主机尚未部署可核对的 Agent，请先部署','Deploy an Agent with a verifiable identity on this host first.'),reusable_ssh_credential_required:t('此操作需要有效 SSH 私钥或可复用密码，请先添加凭据','This operation requires an active SSH private key or reusable password. Add a credential first.'),update_pending:t('已有待审阅或执行中的更新，请从更新历史继续','An update awaits review or is running. Continue from update history.'),update_unknown:t('上次更新结果未知，请在更新历史中核对','The last update outcome is unknown. Verify it in update history.'),agent_update_pending:t('已有待审阅或执行中的更新，请从更新历史继续','An update awaits review or is running. Continue from update history.'),agent_update_unknown:t('上次更新结果未知，请在更新历史中核对','The last update outcome is unknown. Verify it in update history.'),previous_release_unavailable:t('主机没有可回退的上一发行','No previous release is retained on this host.')}[reason]||capabilityReason(reason));
const clearReason=(reason:string)=>({invalid:t('凭据不可用，请重新添加','Credential unavailable; add it again'),expired:t('已到期','Expired'),revoked:t('已撤销','Revoked'),consumed:t('一次性使用结束','Single use completed'),agent_activated:t('Agent 已激活','Agent activated')}[reason]||reason);
const retentionName=(value:string)=>({permanent:t('永久','Permanent'),temporary:t('临时接入','Temporary enrollment'),managed:t('按期限托管','Managed storage'),one_time:t('一次性','One-time'),none:t('不保存秘密','No secret stored')}[value]||value);
const statusName=(value:string)=>({unknown:t("未接入","Not enrolled"),removed:t('节点已移除','Node removed'),uninstalled:t('Agent 已卸载','Agent uninstalled'),online:t("Agent 在线","Agent online"),offline:t("Agent 离线","Agent offline"),installing:t("部署中","Deploying"),error:t("需要处理","Needs attention")}[value]??value);

 const admin=user.role==='admin';
 const requests=useRef(createHostRequestGuard()),allowed=useRef(admin),mounted=useRef(true);allowed.current=admin;
 const hostRevisions=useRef(new Map<string,number>()),refreshRequests=useRef(new Map<string,number>()),planOperation=useRef<HostRequestToken|null>(null);
 const current=(token:HostRequestToken|undefined)=>mounted.current&&allowed.current&&requests.current.current(token)&&!removedMachineIDs.current.has(token!.target);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requests.current.clear()}},[]);
 const [searchParams,setSearchParams]=useSearchParams();
 const linkedMachine=searchParams.get('machine'),linkedDeployment=searchParams.get('deployment'),linkedUninstallation=searchParams.get('uninstallation'),linkedUpdate=searchParams.get('agent_update')||searchParams.get('update'),linkedRollout=searchParams.get('agent_rollout')||searchParams.get('rollout');
 const [checkDetail,setCheckDetail]=useState<Detail>(),[checkBusy,setCheckBusy]=useState(false),[checkError,setCheckError]=useState(''),[checkResult,setCheckResult]=useState<SSHCheckResult>();
 const checkController=useRef<AbortController|null>(null);
 const [planCheck,setPlanCheck]=useState<SSHCheckResult>();
 useEffect(()=>()=>checkController.current?.abort(),[]);
 const {message}=App.useApp();
 const [machines,setMachines]=useState<Machine[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [agents,setAgents]=useState<AgentItem[]>([]),[labels,setLabels]=useState<AgentTaskLabel[]>([]),[includeRemoved,setIncludeRemoved]=useState(false);
 const [nodeDetail,setNodeDetail]=useState<AgentItem>(),[nodeLabels,setNodeLabels]=useState<TaskHost>();
 const [taskHost,setTaskHost]=useState<TaskHost>();
 const [uninstallGuide,setUninstallGuide]=useState<AgentItem>();
 const [inventoryMachine,setInventoryMachine]=useState<{id:string;name:string}>();
 const [selectedIDs,setSelectedIDs]=useState<string[]>([]),[batch,setBatch]=useState<{action:BatchAction;targets:BatchTarget[]}>();
 useEffect(()=>{if(!admin){setSelectedIDs([]);setBatch(undefined)}},[admin]);
 const archivedNodes=useRef(new Map<string,AgentItem>()),loadRequest=useRef(0);
 const [newOpen,setNewOpen]=useState(false);
 const [credentialMachine,setCredentialMachine]=useState<Machine>(),[credentialBusy,setCredentialBusy]=useState(false),[credentialError,setCredentialError]=useState('');
 const [credentialForm]=Form.useForm();
 const credentialPending=useRef(false);
 const startRegistration=()=>{credentialForm.resetFields();setCredentialMachine(undefined);setCredentialError('');setNewOpen(true)};
 useEffect(()=>{if(!admin){credentialForm.resetFields();setCredentialMachine(undefined);setNewOpen(false)}},[admin,credentialForm]);
 const [editMachine,setEditMachine]=useState<Machine>();
 const [terminalDetail,setTerminalDetail]=useState<Detail>();
 const [uninstallDetail,setUninstallDetail]=useState<Detail>(),[uninstallRecord,setUninstallRecord]=useState<AgentUninstallation>();
 const [updateDetail,setUpdateDetail]=useState<Detail>(),[updateRecord,setUpdateRecord]=useState<AgentUpdate>(),[updateAction,setUpdateAction]=useState<'upgrade'|'rollback'>('upgrade');
 const [rollout,setRollout]=useState<{targets?:AgentRolloutTarget[];existingID?:string}>();
 useEffect(()=>{if(!admin){setUpdateDetail(undefined);setUpdateRecord(undefined);setRollout(undefined)}},[admin]);
 const [detail,setDetail]=useState<Detail>(),[detailBusy,setDetailBusy]=useState(false),[detailError,setDetailError]=useState('');
 const removedMachineIDs=useRef(new Set<string>());
 const [planMachine,setPlanMachine]=useState<Pick<Machine,'id'|'name'>>(),[planDetail,setPlanDetail]=useState<Detail>(),[planBusy,setPlanBusy]=useState(false),[planError,setPlanError]=useState(''),[planResult,setPlanResult]=useState<any>();
 const [planNow,setPlanNow]=useState(Date.now());
 useEffect(()=>{
  setPlanNow(Date.now());const expires=Date.parse(planResult?.plan?.expires_at||'');
  if(!Number.isFinite(expires)||expires<=Date.now())return;
  const timer=setTimeout(()=>setPlanNow(Date.now()),Math.min(2_147_483_647,expires-Date.now()+50));return()=>clearTimeout(timer);
 },[planResult?.plan?.expires_at]);
 const planExpired=Date.parse(planResult?.plan?.expires_at||'')<=planNow;
 const load=useCallback(async(silent=false)=>{
  const request=++loadRequest.current;if(!silent)setLoading(true);
  const results=await Promise.allSettled([admin?api<Machine[]>('/machines'):api<Machine[]>('/task-hosts'),api<AgentItem[]>(admin&&includeRemoved?'/agents?include_removed=true':'/agents'),api<AgentTaskLabel[]>('/host-labels')]);
  if(request!==loadRequest.current)return;
  const [hosts,nodes,nextLabels]=results;
  if(hosts.status==='fulfilled')setMachines(hosts.value.filter(machine=>!removedMachineIDs.current.has(machine.id)));
  if(nodes.status==='fulfilled')setAgents(nodes.value.map(node=>archivedNodes.current.get(node.id)||node).filter(node=>includeRemoved||node.lifecycle_state!=='removed'));
  if(nextLabels.status==='fulfilled')setLabels(nextLabels.value);
  const failures=results.filter(result=>result.status==='rejected');setError(failures.map(result=>result.status==='rejected'?errorText(result.reason):'').join(' · '));setLoading(false);
 },[admin,includeRemoved]);
 useEffect(()=>{void load();return()=>{loadRequest.current++}},[load]);
 const invalidateRefresh=(machineID:string)=>{hostRevisions.current.set(machineID,(hostRevisions.current.get(machineID)??0)+1);loadRequest.current++};
 const invalidateHost=(machineID:string)=>{
  invalidateRefresh(machineID);requests.current.invalidateHost(machineID);
  if(requests.current.capture('check')?.target===machineID){checkController.current?.abort();checkController.current=null;setCheckBusy(false);setCheckResult(undefined);setCheckError('')}
  if(requests.current.capture('plan')?.target===machineID){planOperation.current=null;setPlanBusy(false);setPlanCheck(undefined)}
 };
 const closeDetail=()=>{requests.current.close('detail');setDetail(undefined);setDetailBusy(false)};
 const closeTerminal=()=>{requests.current.close('terminal');setTerminalDetail(undefined)};
 const closeUninstall=()=>{requests.current.close('uninstall');setUninstallDetail(undefined);setUninstallRecord(undefined)};
 const closeUpdate=()=>{requests.current.close('update');setUpdateDetail(undefined);setUpdateRecord(undefined)};
 const closePlan=()=>{requests.current.close('plan');setPlanMachine(undefined);setPlanDetail(undefined);setPlanResult(undefined);setPlanCheck(undefined);setPlanError('');setPlanBusy(false)};
 const closeCheck=()=>{requests.current.close('check');checkController.current?.abort();checkController.current=null;setCheckBusy(false);setCheckDetail(undefined);setCheckResult(undefined);setCheckError('')};
 useEffect(()=>{
  if(!admin){requests.current.clear();checkController.current?.abort();checkController.current=null;setCheckBusy(false);setCheckDetail(undefined);setCheckResult(undefined);setTerminalDetail(undefined);setUninstallDetail(undefined);setUninstallRecord(undefined);setDetail(undefined);setEditMachine(undefined);setPlanMachine(undefined);setPlanDetail(undefined);setPlanResult(undefined);setPlanCheck(undefined);setPlanBusy(false)}
 },[admin]);
 const refreshMachine=useCallback(async(machineID:string,refreshList=true)=>{
  const revision=hostRevisions.current.get(machineID)??0,request=(refreshRequests.current.get(machineID)??0)+1;
  refreshRequests.current.set(machineID,request);
  const scopes=(['detail','check','plan','uninstall','update'] as HostRequestScope[]).map(scope=>requests.current.capture(scope));
  try{
   const fresh=await api<Detail>(`/machines/${encodeURIComponent(machineID)}`);
   if(mounted.current&&allowed.current&&!removedMachineIDs.current.has(machineID)&&fresh.machine.id===machineID&&revision===(hostRevisions.current.get(machineID)??0)&&request===refreshRequests.current.get(machineID)){
    const setters=[setDetail,setCheckDetail,setPlanDetail,setUninstallDetail,setUpdateDetail];
    scopes.forEach((token,index)=>{if(token?.target===machineID&&current(token)){
     setters[index](previous=>previous?.machine.id===machineID?fresh:previous);
     if(token.scope==='plan'){setPlanMachine(previous=>previous?.id===machineID?{id:machineID,name:fresh.machine.name}:previous);setPlanResult((previous:any)=>previous?.machine_id===machineID?fresh.deployments.find(item=>item.id===previous.id)??previous:previous)}
    }});
   }
  }catch{/* The host may have been deleted in another tab. */}
  if(refreshList&&mounted.current&&allowed.current&&!removedMachineIDs.current.has(machineID)&&revision===(hostRevisions.current.get(machineID)??0))await load(true);
 },[load]);
 const hostSaved=async(machineID:string)=>{invalidateHost(machineID);await refreshMachine(machineID)};
 useEffect(()=>{
  const refresh=()=>{void load(true);if(admin)for(const id of new Set([detail?.machine.id,checkDetail?.machine.id,planMachine?.id,uninstallDetail?.machine.id,updateDetail?.machine.id].filter((id):id is string=>!!id)))void refreshMachine(id,false)};
  const timer=setInterval(refresh,15_000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh)};
 },[admin,load,refreshMachine,detail?.machine.id,checkDetail?.machine.id,planMachine?.id,uninstallDetail?.machine.id,updateDetail?.machine.id]);
 useEffect(()=>{
  if(!admin||!linkedMachine||!linkedDeployment)return;
  const token=requests.current.begin('plan',linkedMachine);
  Promise.all([api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`),api<Deployment>(`/machines/${encodeURIComponent(linkedMachine)}/deployments/${encodeURIComponent(linkedDeployment)}`)])
   .then(([host,existing])=>{if(current(token)&&host.machine.id===linkedMachine&&existing.machine_id===linkedMachine){setPlanMachine(host.machine);setPlanDetail(host);setPlanResult(existing);setPlanError('')}})
   .catch(e=>{if(current(token))setError(errorText(e))});
  return()=>{if(requests.current.current(token))requests.current.close('plan')};
 },[admin,linkedMachine,linkedDeployment]);
 useEffect(()=>{
  if(!admin||!linkedMachine||!linkedUninstallation)return;
  const token=requests.current.begin('uninstall',linkedMachine);
  Promise.all([api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`),api<AgentUninstallation>(`/machines/${encodeURIComponent(linkedMachine)}/uninstallations/${encodeURIComponent(linkedUninstallation)}`)])
   .then(([host,record])=>{if(current(token)&&host.machine.id===linkedMachine&&record.machine_id===linkedMachine){setUninstallDetail(host);setUninstallRecord(record)}}).catch(e=>{if(current(token))setError(errorText(e))});
  return()=>{if(requests.current.current(token))requests.current.close('uninstall')};
 },[admin,linkedMachine,linkedUninstallation]);
 useEffect(()=>{
  if(!admin||!linkedMachine||linkedDeployment||linkedUninstallation||linkedUpdate)return;
  const token=requests.current.begin('detail',linkedMachine);
  api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`)
   .then(host=>{if(current(token)&&host.machine.id===linkedMachine){setDetail(host);setDetailError('')}})
   .catch(e=>{if(current(token))setError(errorText(e))});
  return()=>{if(requests.current.current(token))requests.current.close('detail')};
 },[admin,linkedMachine,linkedDeployment,linkedUninstallation,linkedUpdate]);
 useEffect(()=>{
  if(!admin||!linkedMachine||!linkedUpdate)return;
  const token=requests.current.begin('update',linkedMachine);
  Promise.all([api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`),api<AgentUpdate>(`/machines/${encodeURIComponent(linkedMachine)}/agent-updates/${encodeURIComponent(linkedUpdate)}`)])
   .then(([host,record])=>{if(current(token)&&host.machine.id===linkedMachine&&record.machine_id===linkedMachine){setUpdateDetail(host);setUpdateRecord(record);setUpdateAction(record.action)}})
   .catch(e=>{if(current(token))setError(errorText(e))});
  return()=>{if(requests.current.current(token))requests.current.close('update')};
 },[admin,linkedMachine,linkedUpdate]);
 useEffect(()=>{if(admin&&linkedRollout)setRollout({existingID:linkedRollout})},[admin,linkedRollout]);
 const openUpdate=async(machine:Machine,action:'upgrade'|'rollback'='upgrade',existing?:AgentUpdate)=>{
  const token=requests.current.begin('update',machine.id);
  try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(!current(token)||host.machine.id!==machine.id)return;
   const record=existing?await api<AgentUpdate>(`/machines/${encodeURIComponent(machine.id)}/agent-updates/${encodeURIComponent(existing.id)}`):undefined;
   if(current(token)&&(!record||record.machine_id===machine.id)){setUpdateRecord(record);setUpdateAction(record?.action??action);setUpdateDetail(host)}
  }catch(e){if(current(token))void message.error(errorText(e))}
 };
 const openUninstall=async(machine:Machine,existing?:AgentUninstallation)=>{
  const token=requests.current.begin('uninstall',machine.id);
  try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(!current(token)||host.machine.id!==machine.id)return;
   const record=existing?await api<AgentUninstallation>(`/machines/${encodeURIComponent(machine.id)}/uninstallations/${encodeURIComponent(existing.id)}`):undefined;
   if(current(token)&&(!record||record.machine_id===machine.id)){setUninstallRecord(record);setUninstallDetail(host)}
  }catch(e){if(current(token))void message.error(errorText(e))}
 };
 const openCheck=async(machine:Pick<Machine,'id'>)=>{
  closeCheck();const token=requests.current.begin('check',machine.id);
  try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(current(token)&&host.machine.id===machine.id)setCheckDetail(host)}catch(e){if(current(token))void message.error(errorText(e))}
 };
 const runCheck=async(values:any)=>{
  const token=requests.current.capture('check'),machineID=checkDetail?.machine.id;if(!machineID||!current(token)||token?.target!==machineID||checkController.current)return;
  const controller=new AbortController();checkController.current=controller;setCheckBusy(true);setCheckError('');setCheckResult(undefined);
  try{const result=await api<SSHCheckResult>(`/machines/${encodeURIComponent(machineID)}/ssh-check`,{method:'POST',body:JSON.stringify(values),signal:controller.signal});if(current(token)&&checkController.current===controller&&result.machine_id===machineID)setCheckResult(result)}
  catch(e){if(current(token)&&!controller.signal.aborted)setCheckError(errorText(e))}
  finally{if(current(token)&&checkController.current===controller){setCheckBusy(false);checkController.current=null;await refreshMachine(machineID)}}
 };
 const openTerminal=async(machine:Machine)=>{
  const token=requests.current.begin('terminal',machine.id);
  try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(current(token)&&host.machine.id===machine.id)setTerminalDetail(host)}catch(e){if(current(token))void message.error(errorText(e))}
 };
 const openDetail=async(machine:Machine)=>{
  const token=requests.current.begin('detail',machine.id);setDetailError('');setDetailBusy(true);
  try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(current(token)&&host.machine.id===machine.id)setDetail(host)}catch(e){if(current(token))void message.error(errorText(e))}finally{if(current(token))setDetailBusy(false)}
 };
 const forgetMachine=(machineID:string)=>{
  invalidateHost(machineID);requests.current.forget(machineID);
  removedMachineIDs.current.add(machineID);setMachines(previous=>previous.filter(machine=>machine.id!==machineID));
  setDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  setEditMachine(previous=>previous?.id===machineID?undefined:previous);
  setCredentialMachine(previous=>previous?.id===machineID?undefined:previous);
  if(credentialMachine?.id===machineID){credentialForm.resetFields();setCredentialError('')}
  if(checkDetail?.machine.id===machineID){checkController.current?.abort();checkController.current=null;setCheckBusy(false);setCheckError('');setCheckResult(undefined)}
  setCheckDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  setTerminalDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  setUninstallDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  setUninstallRecord(previous=>previous?.machine_id===machineID?undefined:previous);
  setUpdateDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  setUpdateRecord(previous=>previous?.machine_id===machineID?undefined:previous);
  setPlanMachine(previous=>previous?.id===machineID?undefined:previous);
  setPlanDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  if(planMachine?.id===machineID){setPlanResult(undefined);setPlanCheck(undefined);setPlanError('');setPlanBusy(false)}
 };
 const addCredential=async(values:any)=>{
  const target=credentialMachine;if(!target||credentialPending.current)return;
  credentialPending.current=true;setCredentialBusy(true);setCredentialError('');
  try{
   const saved=await api<Credential>(`/machines/${encodeURIComponent(target.id)}/credentials`,{method:'POST',body:JSON.stringify(values)});
   if(!mounted.current||!allowed.current||removedMachineIDs.current.has(target.id))return;
   credentialForm.resetFields();setCredentialMachine(undefined);await hostSaved(target.id);
   void message.success((saved.reused?t('已复用已有私钥并绑定主机','Existing private key reused and linked to the host'):t('连接凭据已保存并绑定主机','Connection credential saved and linked to the host'))+' · '+(saved.retention==='permanent'?t('本主机授权：永久','Host authorization: permanent'):t('本主机授权有效至：','Host authorization expires at: ')+time(saved.expires_at)));
  }catch(e){if(mounted.current&&allowed.current)setCredentialError(errorText(e))}finally{credentialPending.current=false;setCredentialBusy(false)}
 };
 const unlinkCredential=async(machineID:string,credentialID:string)=>{try{await api(`/machines/${encodeURIComponent(machineID)}/credentials/${encodeURIComponent(credentialID)}`,{method:'DELETE'});if(!mounted.current||!allowed.current||removedMachineIDs.current.has(machineID))return;void message.success(t("连接凭据已解绑","Connection credential unlinked"));await hostSaved(machineID)}catch(e){if(mounted.current&&allowed.current)void message.error(errorText(e))}};
 const setDefaultCredential=async(machineID:string,credentialID:string)=>{try{await api(`/machines/${encodeURIComponent(machineID)}/default-credential`,{method:'PUT',body:JSON.stringify({credential_id:credentialID})});if(!mounted.current||!allowed.current||removedMachineIDs.current.has(machineID))return;await hostSaved(machineID);void message.success(t('默认连接凭据已更新','Default connection credential updated'))}catch(e){if(mounted.current&&allowed.current)void message.error(errorText(e))}};
 const cancelDeployment=async(machineID:string,deploymentID:string)=>{const token=requests.current.capture('detail');try{await api(`/machines/${encodeURIComponent(machineID)}/deployments/${encodeURIComponent(deploymentID)}/cancel`,{method:'POST',body:'{}'});if(!mounted.current||!allowed.current||removedMachineIDs.current.has(machineID))return;await hostSaved(machineID);void message.success(t("部署计划已取消","Deployment plan cancelled"))}catch(e){if(current(token)){const error=lifecycleErrorText(e);setDetailError(error);void message.error(error)}}};
 const openPlan=async(machine:Pick<Machine,'id'|'name'>)=>{
  const token=requests.current.begin('plan',machine.id);setPlanMachine(machine);setPlanDetail(undefined);setPlanResult(undefined);setPlanCheck(undefined);setPlanError('');setPlanBusy(false);
  try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(current(token)&&host.machine.id===machine.id)setPlanDetail(host)}catch(e){if(current(token))setPlanError(errorText(e))}
 };
 const makePlan=async(values:any)=>{
  const token=requests.current.capture('plan'),machineID=planMachine?.id;if(!machineID||!current(token)||token?.target!==machineID||planDetail?.machine.id!==machineID||planBusy||planOperation.current===token)return;
  planOperation.current=token!;invalidateRefresh(machineID);setPlanBusy(true);setPlanError('');setPlanCheck(undefined);
  try{
   const checked=await api<SSHCheckResult>(`/machines/${encodeURIComponent(machineID)}/ssh-check`,{method:'POST',body:JSON.stringify({credential_id:values.credential_id})});
   if(!current(token)||checked.machine_id!==machineID)return;
   setPlanCheck(checked);if(!checked.ready||checked.agent_installation&&checked.agent_installation.state!=='absent')return;
   const arch=values.arch==='auto'?checked.arch:values.arch;
   const result=await api<any>(`/machines/${encodeURIComponent(machineID)}/deployments/plan`,{method:'POST',body:JSON.stringify({...values,arch,check_id:checked.id})});
   if(current(token)&&result.machine_id===machineID){invalidateRefresh(machineID);setPlanResult(result)};
  }catch(e){if(current(token))setPlanError(errorText(e))}finally{if(planOperation.current===token)planOperation.current=null;if(current(token)){setPlanBusy(false);await refreshMachine(machineID)}}
 };
 const applyPlan=async()=>{
  const token=requests.current.capture('plan'),machineID=planMachine?.id,result=planResult;
  if(!machineID||!result||result.machine_id!==machineID||token?.target!==machineID||!current(token)||planBusy||planOperation.current===token)return;
  planOperation.current=token;invalidateRefresh(machineID);setPlanBusy(true);setPlanError('');
  try{const applied=await api<any>(`/machines/${encodeURIComponent(machineID)}/deployments/${encodeURIComponent(result.id)}/apply`,{method:'POST',body:JSON.stringify({confirm:true})});if(current(token)&&applied.id===result.id&&(applied.machine_id===undefined||applied.machine_id===machineID)){invalidateRefresh(machineID);setPlanResult({...result,...applied,machine_id:machineID});await load();if(current(token))void message.success(t("Agent 部署已完成","Agent deployment completed"))}}
  catch(e){if(current(token)){setPlanError(errorText(e));try{const fresh=await api<any>(`/machines/${encodeURIComponent(machineID)}/deployments/${encodeURIComponent(result.id)}`);if(current(token)&&fresh.machine_id===machineID){invalidateRefresh(machineID);setPlanResult(fresh)}}catch{/* Keep the reviewed plan if refreshing fails. */}}}
  finally{if(planOperation.current===token)planOperation.current=null;if(current(token)){setPlanBusy(false);await refreshMachine(machineID)}}
 };
 const agentReleaseFor=(machine:FleetRow):AgentInstalledRelease|undefined=>machine.agent_release??machine.node?.release??(machine.node?.heartbeat?.release as AgentInstalledRelease|undefined);
 const nodeFor=(machine:Machine)=>agents.find(agent=>agent.id===machine.agent_id)||archivedNodes.current.get(machine.agent_id);
 // Every row has a persisted platform host ID. Agent data only enriches its channel.
 const visibleMachines:Machine[]=machines;
 const group=searchParams.get('group');
 const rows:FleetRow[]=visibleMachines.map(machine=>({...machine,node:nodeFor(machine)})).filter(row=>!group||(row.label_ids??row.node?.label_ids)?.includes(group));
 const selectionScope=rows.map(row=>row.id).join('\0');
 useEffect(()=>{
  const allowed=new Set(selectionScope.split('\0'));
  setSelectedIDs(previous=>{const next=admin?previous.filter(id=>allowed.has(id)):[];return next.length===previous.length?previous:next});
 },[admin,selectionScope]);
 const selectedRows=rows.filter(row=>selectedIDs.includes(row.id));
 const openBatch=(action:BatchAction)=>{
  if(!admin||loading||batch||rollout||!selectedRows.length)return;
  const targets:BatchTarget[]=selectedRows.map(row=>({id:row.id,name:row.name,address:row.address||undefined,port:row.port||undefined,
   machine:{id:row.id,name:row.name,address:row.address,port:row.port,agent_id:row.agent_id,agent_status:row.agent_status,connection_method:row.connection_method,host_key_status:row.host_key_status,capabilities:{...row.capabilities}},
   agent:row.node?{id:row.node.id,hostname:row.node.hostname,lifecycle_state:row.node.lifecycle_state}:undefined}));
  setBatch({action,targets});
 };
 const batchSuccess=(target:BatchTarget,action:BatchAction,result:any)=>{
  loadRequest.current++;
  if(action==='delete_host'&&target.machine){
   forgetMachine(target.machine.id);
  }
  if(action==='remove_node'&&target.agent){
   const existing=agents.find(agent=>agent.id===target.agent!.id);
   if(existing){
    const archived={...existing,lifecycle_state:'removed' as const,removed_at:result.removed_at,removal_reason:result.removal_reason||''};
    archivedNodes.current.set(existing.id,archived);setAgents(previous=>previous.map(agent=>agent.id===existing.id?archived:agent).filter(agent=>includeRemoved||agent.lifecycle_state!=='removed'));
    setMachines(previous=>previous.map(machine=>machine.agent_id===existing.id?{...machine,agent_status:'removed'}:machine));
    setNodeDetail(previous=>previous?.id===existing.id?undefined:previous);
   }
  }
 };
 const nodeActions=(node:AgentItem,machine?:Machine)=><Space wrap>
  <Button size="small" onClick={()=>setNodeDetail(node)}>{t('节点详情','Node details')}</Button>
  {admin&&node.lifecycle_state!=='removed'&&<>{(!machine||!machine.capabilities?.uninstall_agent?.available)&&<Button size="small" onClick={()=>setUninstallGuide(node)}>{t('卸载指引','Uninstall guidance')}</Button>}</>}
 </Space>;
 return <div className={embedded?"lm-machines-page":"lm-page lm-machines-page"}>
  <div className="lm-page-heading"><div>{!embedded&&<h1>{t('主机','Hosts')}</h1>}<p>{t('先登记主机，再由平台部署 Agent。SSH 凭据可按期限保存，日常通过 Agent。','Register a host, then deploy Agent through the platform. Store SSH credentials for a chosen period and use Agent for routine operations.')}</p></div><Space wrap>{admin&&<SystemLogDrawer/>}<Select allowClear aria-label={t('按主机标签筛选','Filter by host label')} style={{minWidth:160}} placeholder={t('全部主机标签','All host labels')} value={group||undefined} onChange={value=>setSearchParams(previous=>{const next=new URLSearchParams(previous);if(value)next.set('group',value);else next.delete('group');return next})} options={labels.map(label=>({value:label.id,label:label.name}))}/><Button aria-label={t('刷新','Refresh')} icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>{t('刷新','Refresh')}</Button>{admin&&<><Checkbox checked={includeRemoved} onChange={event=>setIncludeRemoved(event.target.checked)}>{t('包含已移除节点','Include removed nodes')}</Checkbox><Button type="primary" aria-label={t('登记主机','Register host')} icon={<PlusOutlined/>} onClick={startRegistration}>{t('登记主机','Register host')}</Button></>}</Space></div>
  {!admin&&<Alert type="info" showIcon className="lm-machine-notice" title={t('只读主机视图','Read-only host view')} description={t('可查看主机、标签和任务；SSH 连接、凭据和生命周期管理仅管理员可用。','View hosts, labels, and tasks. SSH connections, credentials, and lifecycle management are available only to administrators.')}/>}
  {error&&<Alert type="error" showIcon title={error} className="lm-machine-notice"/>}
  {admin&&<div className="lm-machine-batch-toolbar" role="region" aria-label={t('批量操作','Bulk actions')}>
   <Space wrap><Typography.Text strong>{t(`已选择 ${selectedRows.length} 项`,`Selected ${selectedRows.length}`)}</Typography.Text><Button size="small" disabled={!selectedRows.length||!!batch} onClick={()=>setSelectedIDs([])}>{t('清除选择','Clear selection')}</Button></Space>
   <Space wrap>{([
    ['ssh_check',t('批量 SSH 安装检查','Bulk SSH preflight')],['install',t('批量部署 Agent','Bulk deploy Agent')],['uninstall',t('卸载 Agent','Uninstall Agent')],['remove_node',t('移除节点','Remove nodes')],['delete_host',t('删除主机','Delete hosts')],
   ] as [BatchAction,string][]).map(([action,label])=><Button key={action} size="small" aria-label={label} danger={['uninstall','remove_node','delete_host'].includes(action)} disabled={loading||!selectedRows.length||!!batch||!!rollout} onClick={()=>openBatch(action)}>{label}</Button>)}<Button size="small" disabled={loading||!selectedRows.length||selectedRows.length>20||!!batch||!!rollout} onClick={()=>setRollout({targets:selectedRows.map(row=>({id:row.id,name:row.name,arch:row.arch}))})}>{t('升级 Agent','Upgrade Agent')}</Button><Button size="small" disabled={!!batch||!!rollout} onClick={()=>setRollout({})}>{t('Agent 升级记录','Agent upgrade history')}</Button></Space>
   <Typography.Text type="secondary">{t('勾选后按主机逐台执行；安装和卸载会先生成计划供统一审阅。每批最多 50 项。','Select rows to act on each host in sequence. Review installation and uninstall plans before execution. Up to 50 targets per batch.')}</Typography.Text>
  </div>}
  <div className="lm-surface"><Table<FleetRow> rowKey="id" dataSource={rows} loading={loading} rowSelection={admin?{selectedRowKeys:selectedIDs,preserveSelectedRowKeys:true,columnWidth:48,onChange:keys=>{if(keys.length>50){void message.warning(t('每批最多选择 50 项','Select up to 50 targets per batch'));return}setSelectedIDs(keys.map(String))},getCheckboxProps:row=>({'aria-label':t(`选择 ${row.name}`,`Select ${row.name}`),disabled:!!batch||!!rollout})}:undefined} scroll={{x:1548}} pagination={{pageSize:10,hideOnSinglePage:true}} locale={{emptyText:<Empty description={t("尚无主机","No hosts yet")}/>}} columns={[
   {title:t("主机","Host"),width:320,render:(_:unknown,m:FleetRow)=><div><strong>{m.name}</strong><Typography.Text type="secondary" copyable={{text:m.id}}>{t('主机 ID：','Host ID: ')}{m.id}</Typography.Text>{admin&&(m.address?<Typography.Text type="secondary" copyable={{text:sshEndpoint(m.address,m.port)}}>{t('SSH 连接地址：','SSH connection address: ')}{sshEndpoint(m.address,m.port)}</Typography.Text>:<Typography.Text type="secondary">{t('SSH 未配置','SSH not configured')}</Typography.Text>)}{m.observed_hostname&&!m.network?.hostname&&<Typography.Text type="secondary">{t('系统主机名（Agent）：','System hostname (Agent): ')}{m.observed_hostname}</Typography.Text>}{m.node&&<Typography.Text type="secondary">Agent ID: {m.node.id}</Typography.Text>}<HostNetworkSummary network={m.network}/></div>},
   {title:t("管理通道","Management channels"),width:180,render:(_:unknown,m:FleetRow)=><><Tag color={m.node?.lifecycle_state==='removed'?'default':m.node?agentIsOnline(m.node)?'success':'warning':'default'}>{m.node?.lifecycle_state==='removed'?t('节点已移除','Node removed'):m.node?agentIsOnline(m.node)?t('Agent 在线','Agent online'):t('Agent 离线','Agent offline'):m.agent_status==='removed'?t('节点已移除','Node removed'):m.agent_id?t('Agent 关联待核对','Agent link needs verification'):statusName(m.agent_status)}</Tag>{admin&&<Typography.Text type="secondary">{m.ssh_recovery_available?t('SSH 恢复通道可用','SSH recovery available'):!m.address?t('SSH 未配置','SSH not configured'):t('SSH 恢复通道不可用','SSH recovery unavailable')}</Typography.Text>}</>},
   {title:t('Agent 发行','Agent release'),width:220,render:(_:unknown,m:FleetRow)=>{const release=agentReleaseFor(m);return <div className="lm-machine-release">{m.agent_id?<><Typography.Text>{release?.version||m.node?.version||t('版本未知','Version unknown')}</Typography.Text><Typography.Text type="secondary">{t('提交：','Revision: ')}{shortIdentity(release?.source_revision)}</Typography.Text><Typography.Text type="secondary" title={release?.artifact_sha256}>{t('包：','Artifact: ')}{shortIdentity(release?.artifact_sha256)}</Typography.Text><Tag color={m.agent_update?.state==='update_available'?'blue':m.agent_update?.state==='current'?'success':m.agent_update?.state==='in_progress'?'processing':'default'}>{({current:t('当前发行','Current release'),update_available:t('有可用更新','Update available'),unknown:t('发行待核对','Release needs verification'),not_installed:t('未安装','Not installed'),in_progress:t('更新中','Update in progress')} as Record<string,string>)[m.agent_update?.state||'unknown']}</Tag></>:<Typography.Text type="secondary">{t('未安装 Agent','Agent not installed')}</Typography.Text>}</div>}},
   {title:t('主机标签','Host labels'),width:210,render:(_:unknown,m:FleetRow)=><Space wrap>{(m.label_ids??m.node?.label_ids??[]).map(id=><Tag key={id}>{labels.find(label=>label.id===id)?.name||id}</Tag>)}{!(m.label_ids??m.node?.label_ids??[]).length&&<Typography.Text type="secondary">{t('暂无标签','No labels')}</Typography.Text>}</Space>},
   {title:t("最近更新","Last updated"),dataIndex:'updated_at',width:180,render:time},
   {title:t("操作","Actions"),width:440,render:(_:unknown,m:FleetRow)=>{
    if(!admin)return <Space wrap>{m.node&&nodeActions(m.node,m)}<Button size="small" onClick={()=>setTaskHost({id:m.id,name:m.name,label_ids:m.label_ids??[],agent_id:m.agent_id})}>{t('主机任务','Host tasks')}</Button></Space>;
    const capabilities=[['terminal',t('登录终端','Open terminal')],['ssh_check',t('SSH 安装检查','SSH preflight')],['deploy_agent',t('部署 Agent','Deploy Agent')],['uninstall_agent',t('卸载 Agent','Uninstall Agent')],['update_agent',t('升级 Agent','Upgrade Agent')],['rollback_agent',t('回退 Agent','Roll back Agent')]] as const;
    const blocked=capabilities.filter(([key])=>!m.capabilities?.[key]?.available);
    return <div className="lm-machine-actions">{m.node&&<div className="lm-node-actions">{nodeActions(m.node,m)}</div>}<Space wrap><Button size="small" onClick={()=>setNodeLabels({id:m.id,name:m.name,label_ids:m.label_ids??m.node?.label_ids??[],agent_id:m.agent_id})}>{t('设置主机标签','Set host labels')}</Button><Button size="small" onClick={()=>setTaskHost({id:m.id,name:m.name,label_ids:m.label_ids??[],agent_id:m.agent_id})}>{t('主机任务','Host tasks')}</Button><Button size="small" disabled={!m.capabilities?.terminal?.available} onClick={()=>void openTerminal(m)}>{t("登录终端","Open terminal")}</Button><Button size="small" className="lm-machine-inventory" data-machine-id={m.id} onClick={()=>setInventoryMachine(m)}>{t("应用与 Docker","Applications & Docker")}</Button><Button size="small" onClick={()=>void openDetail(m)}>{t("详情","Details")}</Button><Button size="small" onClick={()=>setEditMachine(m)}>{t("编辑主机","Edit host")}</Button><Button size="small" onClick={()=>{credentialForm.resetFields();setCredentialError('');setCredentialMachine(m)}}>{t("添加凭据","Add credential")}</Button><Button size="small" disabled={!m.capabilities?.ssh_check?.available} onClick={()=>void openCheck(m)}>{t("SSH 安装检查","SSH preflight")}</Button><Button size="small" type="primary" disabled={!m.capabilities?.deploy_agent?.available} onClick={()=>void openPlan(m)}>{t("部署 Agent","Deploy Agent")}</Button><Button size="small" danger disabled={!m.capabilities?.uninstall_agent?.available} onClick={()=>void openUninstall(m)}>{t('卸载 Agent','Uninstall Agent')}</Button></Space>
     {!!blocked.length&&<div className="lm-machine-blocked" role="note">{[...new Set(blocked.map(([key])=>m.capabilities?.[key]?.reason||''))].map(reason=><div key={reason}>{blocked.filter(([key])=>(m.capabilities?.[key]?.reason||'')===reason).map(([,label])=>label).join(t('、',', '))}：{updateCapabilityReason(reason)}</div>)}{blocked.some(([key])=>['ssh_credential_required','ssh_key_required','reusable_ssh_credential_required'].includes(m.capabilities?.[key]?.reason||''))&&<Button type="link" size="small" onClick={()=>{credentialForm.resetFields();setCredentialError('');setCredentialMachine(m)}}>{t('添加新的 SSH 凭据','Add a new SSH credential')}</Button>}</div>}
     <Space wrap style={{marginTop:8}}><Button size="small" disabled={!m.capabilities?.update_agent?.available} onClick={()=>void openUpdate(m)}>{t('升级 Agent','Upgrade Agent')}</Button><Button size="small" disabled={!m.capabilities?.rollback_agent?.available} onClick={()=>void openUpdate(m,'rollback')}>{t('回退 Agent','Roll back Agent')}</Button></Space>
    </div>;
   }},
  ]}/></div>
  {admin&&updateDetail&&<MachineAgentUpdateDialog key={`${updateDetail.machine.id}:${updateRecord?.id||updateAction}`} machine={updateDetail.machine} credentials={updateDetail.credentials} existing={updateRecord} initialAction={updateAction} onRefresh={()=>refreshMachine(updateDetail.machine.id)} onClose={closeUpdate}/>}
  {admin&&rollout&&<MachineAgentRolloutDialog key={rollout.existingID||rollout.targets?.map(target=>target.id).join(',')||'history'} targets={rollout.targets} existingID={rollout.existingID} onClose={()=>{setRollout(undefined);setSelectedIDs([])}} onRefresh={()=>load(true)}/>}
  {admin&&batch&&<MachineBatchDialog key={batch.action+':'+batch.targets.map(target=>target.id).join(',')} action={batch.action} targets={batch.targets} onClose={()=>{setBatch(undefined);setSelectedIDs([])}} onRefresh={()=>load(true)} onSuccess={batchSuccess}/>}
  {admin&&nodeLabels&&<NodeLabelsDialog key={nodeLabels.id} host={nodeLabels} labels={labels} onClose={()=>setNodeLabels(undefined)} onSaved={()=>load(true)}/>}
  {taskHost&&<Modal open title={t(`主机任务 · ${taskHost.name}`,`Host tasks · ${taskHost.name}`)} footer={null} width={1000} onCancel={()=>setTaskHost(undefined)} destroyOnHidden><HostTasksPanel hostID={taskHost.id} admin={admin} labels={labels}/></Modal>}
  <HostInventory machine={inventoryMachine} onClose={()=>setInventoryMachine(undefined)}/>
  <Modal title={t('节点详情','Node details')} open={!!nodeDetail} onCancel={()=>setNodeDetail(undefined)} footer={null} width={760} destroyOnHidden>{nodeDetail&&<><NodeDetails agent={nodeDetail}/>{nodeDetail.lifecycle_state==='removed'&&<Alert type="warning" showIcon title={t('此节点已归档，旧凭据不能继续接入','This node is archived; old credentials can no longer enroll')} description={<>{time(nodeDetail.removed_at||'')} · {nodeDetail.removal_reason||t('未填写原因','No reason provided')}</>}/>}</>}</Modal>
  <Modal title={t('卸载 Agent 指引','Agent uninstall guidance')} open={!!uninstallGuide} onCancel={()=>setUninstallGuide(undefined)} footer={null}><p>{t('自动卸载需要关联主机和有效 SSH 私钥或可复用密码。配置 SSH 连接并添加凭据后，即可检查并审阅卸载计划；主机公钥在首次连接时自动记录，后续自动校验。','Automatic uninstall requires a host record and an active SSH private key or reusable password. Configure SSH and add credentials, then run checks and review the uninstall plan. The host public key is recorded on first connection and verified automatically afterward.')}</p><Alert type="info" showIcon title={t('没有 SSH 时可手动卸载','Manual uninstall without SSH')} description={t('在目标机器核对 Agent ID 和标准安装路径，使用对应版本安装包中的 deploy/agent/uninstall.sh；默认保留配置与待上报数据，不使用 --purge。远端卸载后在平台移除节点以撤销独立凭据。平台不会把显示此指引当作卸载成功。','Verify the Agent ID and managed installation paths on the target machine, then use deploy/agent/uninstall.sh from the matching release. Keep configuration and queued data by default; do not use --purge. Remove the node in the platform afterward to revoke independent credentials. Displaying this guidance does not report uninstall success.')}/></Modal>
  {admin&&uninstallDetail&&<MachineAgentUninstallDialog key={`${uninstallDetail.machine.id}:${uninstallRecord?.id||'new'}`} machine={uninstallDetail.machine} credentials={uninstallDetail.credentials} existing={uninstallRecord} onRefresh={()=>refreshMachine(uninstallDetail.machine.id)} onClose={closeUninstall}/>}
  {admin&&editMachine&&<MachineEditDialog key={editMachine.id} machine={editMachine} onClose={()=>setEditMachine(undefined)} onSaved={()=>hostSaved(editMachine.id)}/>}
  {admin&&terminalDetail&&<MachineTerminalDialog key={terminalDetail.machine.id} machine={terminalDetail.machine} credentials={terminalDetail.credentials} onReleased={()=>refreshMachine(terminalDetail.machine.id)} onClose={closeTerminal}/>}
  {admin&&newOpen&&<MachineRegistrationDialog onClose={()=>setNewOpen(false)} onChanged={()=>load(true)} onCheck={id=>void openCheck({id})} onPlan={(id,name)=>void openPlan({id,name})}/>}
  <Modal className="lm-machine-credential-dialog" style={{top:24}} title={t(`添加连接凭据 · ${credentialMachine?.name??''}`,`Add connection credential · ${credentialMachine?.name??''}`)} open={admin&&!!credentialMachine} onCancel={()=>{if(!credentialBusy){credentialForm.resetFields();setCredentialMachine(undefined)}}} footer={null} destroyOnHidden>
   <MachineCredentialForm form={credentialForm} busy={credentialBusy} error={credentialError} onFinish={addCredential}/>
  </Modal>
  <Modal title={t(`SSH 安装检查 · ${checkDetail?.machine.name??''}`,`SSH preflight · ${checkDetail?.machine.name??''}`)} open={admin&&!!checkDetail} onCancel={closeCheck} footer={null} width={680} destroyOnHidden>
   <p>{t('使用已保存的私钥或密码执行固定只读检查，最长约 60 秒，可以取消。一次性密码在检查后清除；临时、托管或永久密码在有效期内可继续用于安装。检查不会安装或修改主机配置。','Run fixed read-only checks with a saved key or password, up to 60 seconds, with cancellation. Single-use passwords are cleared afterward. Temporary, managed, or permanent passwords can install Agent within their validity. Preflight does not install or change host configuration.')}</p>
   {checkDetail&&<Form key={checkDetail.credentials.filter(activeCredential).map(c=>c.id).join(',')} layout="vertical" onFinish={runCheck} disabled={checkBusy} initialValues={{credential_id:defaultMachineCredential(checkDetail.credentials,checkDetail.machine.default_credential_id)}}>
    <Form.Item label={t('SSH 凭据','SSH credential')} name="credential_id" rules={[{required:true,message:t('请选择有效的 SSH 凭据','Select an active SSH credential')}]}><Select options={checkDetail.credentials.filter(c=>(c.method==='ssh_key'||c.method==='password')&&activeCredential(c)).map(c=>({value:c.id,label:`${credentialName(c)} · ${c.secret_fingerprint||c.id}`}))}/></Form.Item>
    <Space><Button aria-label={t("开始 SSH 检查","Run SSH preflight")} type="primary" htmlType="submit" loading={checkBusy} disabled={!checkDetail?.credentials.some(c=>activeCredential(c)&&(c.method==='ssh_key'||c.method==='password'))}>{t('开始 SSH 检查','Run SSH preflight')}</Button>{checkBusy&&<Button disabled={false} onClick={closeCheck}>{t('取消检查','Cancel check')}</Button>}</Space>
   </Form>}
   {checkError&&<Alert type="error" showIcon title={checkError}/>}{checkResult&&<SSHCheckSummary result={checkResult}/>}
  </Modal>
  <Modal title={t(`主机详情 · ${detail?.machine.name??''}`,`Host details · ${detail?.machine.name??''}`)} open={admin&&!!detail} onCancel={closeDetail} footer={null} width={1060} destroyOnHidden>
   {detailError&&<Alert type="error" showIcon title={detailError} className="lm-machine-form-notice"/>}
   {detail&&<><HostTasksPanel hostID={detail.machine.id} admin={admin} labels={labels}/><Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'name',label:t('主机名称（用户自定义）','Host name (user-defined)'),children:detail.machine.name},{key:'id',label:t('主机 ID（平台生成，不可修改）','Host ID (platform-generated, immutable)'),children:<Typography.Text code copyable={{text:detail.machine.id}}>{detail.machine.id}</Typography.Text>},{key:'agent',label:'agent_id',children:detail.machine.agent_id||t("尚未绑定","Not linked yet")},{key:'address',label:t("SSH 连接地址","SSH connection address"),children:detail.machine.address?sshEndpoint(detail.machine.address,detail.machine.port,detail.machine.username):t('尚未配置 SSH','SSH not configured')},{key:'status',label:t("Agent 状态","Agent status"),children:statusName(detail.machine.agent_status)},{key:'recovery',label:t('SSH 恢复通道','SSH recovery channel'),children:detail.machine.ssh_recovery_available?t('可用','Available'):t('不可用，请按需添加凭据','Unavailable. Add credentials when needed')},{key:'fingerprint',label:t("主机指纹","Host fingerprint"),span:2,children:detail.machine.host_key_fingerprint?<Typography.Text code copyable={{text:detail.machine.host_key_fingerprint}}>{detail.machine.host_key_fingerprint}</Typography.Text>:t("首次 SSH 连接后自动记录","Recorded automatically on first SSH connection")},{key:'host-public-key',label:t("主机公钥","Host public key"),span:2,children:detail.machine.host_key_public_key?<Typography.Text code className="lm-machine-path" copyable={{text:detail.machine.host_key_public_key}}>{detail.machine.host_key_public_key}</Typography.Text>:t("首次 SSH 连接后自动记录","Recorded automatically on first SSH connection")},{key:'host-key-observed',label:t("公钥记录时间","Public key recorded at"),span:2,children:time(detail.machine.host_key_observed_at||'')}]}/><h3>{t('网络地址','Network addresses')}</h3><HostNetworkSummary network={detail.machine.network} details/><AgentUpdateHistory key={detail.machine.id} machineID={detail.machine.id} onOpen={record=>{closeDetail();void openUpdate(detail.machine,record.action,record)}}/><h3>{t("连接凭据","Connection credentials")}</h3><Table<Credential> size="small" rowKey="id" dataSource={detail.credentials} scroll={{x:980}} pagination={false} columns={[{title:t('名称','Name'),render:(_:unknown,c:Credential)=><>{c.name||credentialTypeName(c)}{(c.is_default||c.id===detail.machine.default_credential_id)&&<Tag color="blue">{t('默认','Default')}</Tag>}</>},{title:t("类型","Type"),dataIndex:'method',render:(v:string,c:Credential)=>v==='manual_script'?t('不保存凭据','No credential'):credentialTypeName(c)},{title:t("指纹","Fingerprint"),dataIndex:'secret_fingerprint'},{title:t("保留策略","Retention policy"),render:(_:unknown,c:Credential)=><><Tag color={['managed','permanent'].includes(c.retention)?'warning':'default'}>{retentionName(c.retention)}</Tag>{c.policy_source==='legacy'&&<Tag>{c.retention==='managed'?t('历史托管','Legacy managed'):t('历史策略','Legacy policy')}</Tag>}</>},{title:t("有效期","Expires at"),render:(_:unknown,c:Credential)=>credentialExpiry(c)},{title:t("最近使用","Last used"),dataIndex:'last_used_at',render:time},{title:t('秘密状态','Secret status'),render:(_:unknown,c:Credential)=>c.secret_cleared_at?<><Tag>{t('已清除','Cleared')}</Tag><Typography.Text type="secondary">{clearReason(c.clear_reason||'')} · {time(c.secret_cleared_at)}</Typography.Text></>:c.method==='manual_script'?t('不保存秘密','No secret stored'):t('已加密保存','Stored encrypted')},{title:t("状态","Status"),render:(_:unknown,c:Credential)=>c.clear_reason==='invalid'?<Tag>{t('不可用，请重新添加','Unavailable; add again')}</Tag>:c.revoked_at?<Tag>{t("已撤销","Revoked")}</Tag>:!activeCredential(c)?<Tag>{t("已过期","Expired")}</Tag>:<Tag color="success">{t("有效","Active")}</Tag>},{title:t("操作","Actions"),render:(_:unknown,c:Credential)=>!activeCredential(c)?null:<Space>{!(c.is_default||c.id===detail.machine.default_credential_id)&&<Button size="small" onClick={()=>void setDefaultCredential(detail.machine.id,c.id)}>{t("设为默认","Set as default")}</Button>}<Popconfirm title={t("解绑此连接凭据？","Unlink this connection credential?")} description={t("仅停止此主机使用，断开使用它的终端并取消待审批计划；凭据库和其他主机不受影响。","Stop using this credential on this host, close its terminals, and cancel pending plans. The credential library and other hosts are unaffected.")} okText={t("解绑","Unlink")} cancelText={t("取消","Cancel")} okButtonProps={{'aria-label':t("解绑","Unlink")}} onConfirm={()=>void unlinkCredential(detail.machine.id,c.id)}><Button aria-label={t("解绑","Unlink")} size="small" danger>{t("解绑","Unlink")}</Button></Popconfirm></Space>}]}/><h3>{t("部署历史","Deployment history")}</h3><Table<Deployment> size="small" rowKey="id" dataSource={detail.deployments} pagination={{pageSize:5}} columns={[{title:t("状态","Status"),dataIndex:'status'},{title:t("版本","Version"),dataIndex:'version'},{title:t("创建时间","Created at"),dataIndex:'created_at',render:time},{title:t("错误","Error"),dataIndex:'error'},{title:t("操作","Actions"),render:(_:unknown,d:Deployment)=>d.status==='awaiting_approval'?<Popconfirm title={t("取消这个尚未执行的部署计划？","Cancel this unexecuted deployment plan?")} description={t("取消后不能继续执行；如需部署，请重新检查并生成计划。","The plan cannot run after cancellation. Run preflight and create a new plan to deploy later.")} okText={t("确认取消","Confirm cancellation")} cancelText={t("返回","Back")} onConfirm={()=>void cancelDeployment(detail.machine.id,d.id)}><Button size="small" danger>{t("取消计划","Cancel plan")}</Button></Popconfirm>:null}]}/><h3>{t('卸载历史','Uninstall history')}</h3><Table<AgentUninstallation> size="small" rowKey="id" dataSource={detail.uninstallations||[]} pagination={{pageSize:5}} columns={[{title:t('状态','Status'),dataIndex:'status',render:(status:string)=>({awaiting_approval:t('待确认','Awaiting approval'),running:t('正在卸载','Uninstalling'),succeeded:t('卸载完成','Uninstalled'),failed:t('卸载失败','Uninstall failed'),unknown:t('结果未知，需核对','Outcome unknown; verification needed'),cancelled:t('已取消','Cancelled')}[status]||status)},{title:t('节点身份','Agent identity'),dataIndex:'agent_id'},{title:t('创建时间','Created at'),dataIndex:'created_at',render:time},{title:t('错误','Error'),dataIndex:'error'},{title:t('操作','Actions'),render:(_:unknown,record:AgentUninstallation)=><Button size="small" onClick={()=>{closeDetail();void openUninstall(detail.machine,record)}}>{record.status==='unknown'?t('核对结果','Verify outcome'):record.status==='awaiting_approval'?t('审阅卸载计划','Review uninstall plan'):t('查看卸载记录','View uninstall record')}</Button>}]}/></>}
  </Modal>
  <Modal title={t(`部署 LightMoni Agent · ${planMachine?.name??''}`,`Deploy LightMoni Agent · ${planMachine?.name??''}`)} open={admin&&!!planMachine} onCancel={()=>{if(!planBusy)closePlan()}} footer={null} width={760} destroyOnHidden>
   {!planResult&&planDetail&&(()=>{const keys=planDetail.credentials.filter(reusableCredential);return keys.length?<Form layout="vertical" onFinish={makePlan} disabled={planBusy} initialValues={{version:'0.1.0',arch:'auto',credential_id:defaultMachineCredential(keys,planDetail.machine.default_credential_id,reusableCredential)}}><Form.Item label={t("连接凭据","Connection credentials")} name="credential_id" rules={[{required:true,message:t("请选择可复用的 SSH 凭据","Select a reusable SSH credential")}]}><Select options={keys.map(c=>({value:c.id,label:`${credentialName(c)} · ${c.secret_fingerprint||c.id} · ${credentialExpiry(c)}`}))}/></Form.Item><Space.Compact block><Form.Item label={t("Agent 版本","Agent version")} name="version" rules={[{required:true}]} style={{width:'50%'}}><Input/></Form.Item><Form.Item label={t("架构","Architecture")} name="arch" rules={[{required:true}]} style={{width:'50%'}}><Select options={[{value:'auto',label:t('自动检查识别','Detect with SSH preflight')},{value:'amd64',label:'amd64'},{value:'arm64',label:'arm64'}]}/></Form.Item></Space.Compact><Form.Item label={t("初始任务标签","Initial task label")} name="initial_label_id"><Input placeholder={t("可留空，接入后在主机的任务标签中设置","Optional. Configure later in the host’s task labels")}/></Form.Item>{planError&&<Alert type="error" showIcon title={planError} className="lm-machine-form-notice"/>}<Button type="primary" htmlType="submit" loading={planBusy} block>{t("检查并生成部署计划","Check and create deployment plan")}</Button></Form>:<Alert type="warning" showIcon title={t("暂无可用于自动部署的可复用 SSH 凭据","No reusable SSH credential available for automatic deployment")} description={t("自动部署需要有效私钥或临时、托管、永久密码。主机公钥在首次连接时自动记录；一次性密码在检查后清除，不能用于部署。","Automatic deployment needs an active key or temporary, managed, or permanent password. The host public key is recorded on first connection. Single-use passwords are cleared after preflight and cannot deploy Agent.")}/>})()}
   {planCheck&&!planResult&&<SSHCheckSummary result={planCheck}/>}
   {planError&&!planDetail&&<Alert type="error" showIcon title={planError}/>}
   {planResult&&<><Alert type={planResult.status==='succeeded'?'success':'info'} showIcon title={planResult.status==='succeeded'?t("Agent 已部署并收到激活回执","Agent deployed and activation confirmed"):planResult.status==='awaiting_approval'&&planExpired?t("部署计划已过期，请重新检查","Deployment plan expired. Run preflight again."):planResult.status==='awaiting_approval'?t("请审阅固定部署步骤后确认","Review the deployment steps before confirming"):t(`部署状态：${planResult.status}`,`Deployment status: ${planResult.status}`)} description={planResult.error||(planResult.plan?t("确认后执行固定部署。Agent 激活后清除此主机的临时凭据，保留按期限托管或永久凭据；后续优先使用 Agent 通道。","Confirmation runs the fixed installation workflow. Agent activation clears temporary credentials for this host and keeps managed or permanent credentials. Prefer the Agent channel afterward."):planResult.receipt?.error)}/>{planResult.plan&&<Descriptions column={1} size="small" items={[{key:'target',label:t('目标主机','Target host'),children:sshEndpoint(planResult.plan.machine?.address||'',planResult.plan.machine?.port,planResult.plan.machine?.username)},{key:'version',label:t('版本 / 架构','Version / architecture'),children:`${planResult.plan.version} / ${planResult.plan.arch}`},{key:'expires',label:t('计划有效期','Plan expires at'),children:time(planResult.plan.expires_at)}]}/>}{planResult.plan?.preflight&&<SSHCheckSummary result={planResult.plan.preflight}/>}<Descriptions size="small" column={1} items={(planResult.plan?.steps||planResult.receipt?.stages||[]).map((step:string,index:number)=>({key:index,label:t(`步骤 ${index+1}`,`Step ${index+1}`),children:({"确认主机公钥指纹":t("自动校验主机公钥","Automatically verify the host public key"),"自动校验主机公钥":t("自动校验主机公钥","Automatically verify the host public key"),"建立受限 SSH 连接":t("建立受限 SSH 连接","Connect through restricted SSH"),"下载固定版本 Agent 并校验 SHA256":t("下载固定版本 Agent 并校验 SHA256","Download the fixed Agent release and verify SHA256"),"通过 stdin 注入一次性 enrollment token":t("通过 stdin 注入一次性 enrollment token","Pass the one-time enrollment token through stdin"),"安装独立 systemd Agent":t("安装独立 systemd Agent","Install the independent systemd Agent service"),"等待 Agent 激活回执":t("等待 Agent 激活回执","Wait for Agent activation confirmation")} as Record<string,string>)[step]||step}))}/><Typography.Paragraph type="secondary">{t("部署计划 ID：","Deployment plan ID: ")}<Typography.Text code>{planResult.id}</Typography.Text></Typography.Paragraph>{planError&&<Alert type="error" showIcon title={planError} className="lm-machine-form-notice"/>}{(planExpired||planError||['failed','cancelled'].includes(planResult.status))&&<Button disabled={planBusy} onClick={()=>planMachine&&void openPlan(planMachine)} block>{t('重新检查并生成计划','Run preflight and create a new plan')}</Button>}{planResult.status==='awaiting_approval'&&<Button type="primary" danger loading={planBusy} disabled={planExpired} onClick={()=>void applyPlan()} block>{t("我已审阅，确认执行 SSH 部署","I have reviewed the steps; run SSH deployment")}</Button>}</>}
  </Modal>
 </div>;
}
