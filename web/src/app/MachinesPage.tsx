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
import MachineCredentialForm from './MachineCredentialForm';
import MachineRegistrationDialog from './MachineRegistrationDialog';
import {activeMachineCredential,reusableMachineCredential} from './machine-credentials';
import MachineEditDialog from './MachineEditDialog';
import MachineAgentUninstallDialog,{type AgentUninstallation} from './MachineAgentUninstallDialog';
import {agentIsOnline,type AgentItem,type AgentTaskLabel} from './agent-model';
import {NodeDetails} from './AgentsPage';
import NodeLabelsDialog from './NodeLabelsDialog';
import MachineBatchDialog,{type BatchAction,type BatchTarget} from './MachineBatchDialog';

type Capability={available:boolean;reason:string};
type Machine={observed_hostname?:string;id:string;name:string;address:string;port:number;username:string;connection_method:string;host_key_fingerprint:string;host_key_public_key?:string;host_key_observed_at?:string;host_key_status:string;platform:string;arch:string;agent_id:string;agent_status:string;credential_count:number;active_credential_count:number;active_ssh_credential_count:number;active_ssh_key_count:number;active_reusable_ssh_credential_count?:number;ssh_recovery_available:boolean;capabilities:{terminal:Capability;ssh_check:Capability;deploy_agent:Capability;uninstall_agent?:Capability};last_deployment_status:string;last_uninstallation_status?:string;updated_at:string;created_at:string};
type FleetRow=Machine&{node?:AgentItem};
type Credential={id:string;method:string;secret_fingerprint:string;retention:string;policy_source:string;secret_cleared_at?:string;clear_reason?:string;created_at:string;expires_at:string;revoked_at?:string;last_used_at:string;created_by:string};
type Deployment={id:string;machine_id:string;credential_id:string;status:string;version:string;arch:string;initial_label_id:string;plan:any;receipt:any;error:string;created_at:string;approved_at:string;started_at:string;finished_at:string};
type Detail={machine:Machine;credentials:Credential[];deployments:Deployment[];uninstallations?:AgentUninstallation[]};

export default function MachinesPage({user,embedded=false}:{user:User;embedded?:boolean}){
 const {t,language:uiLanguage}=useI18n();
const errorText=(e:unknown)=>e instanceof Error?e.message:t("操作失败","Operation failed");
const lifecycleErrorText=(e:unknown)=>({
 "此主机有终端、检查或部署正在进行，请先结束后重试":t("此主机有终端、检查或部署正在进行，请先结束后重试","This host has an active terminal, check, or deployment. Finish it and retry."),
 "请先撤销或等待所有有效连接凭据失效后再删除主机":t("请先撤销或等待所有有效连接凭据失效后再删除主机","Revoke all active connection credentials or wait for them to expire before deleting the host."),
 "请先移除关联 Agent 或核验卸载完成并撤销身份，再删除主机":t("请先移除关联 Agent 或核验卸载完成并撤销身份，再删除主机","Remove the linked Agent identity, or verify uninstallation and revoke its identity, before deleting this host."),
 "该主机有未结束的部署任务，请先完成或取消后再删除":t("该主机有未结束的部署任务，请先完成或取消后再删除","This host has an unfinished deployment. Finish or cancel it before deleting the host."),
 "此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对":t("此主机有待审批、运行中或结果未知的 Agent 卸载，请先取消或核对","This host has a pending, running, or uncertain Agent removal. Cancel or verify it first."),
 "只能取消尚未执行的部署计划":t("只能取消尚未执行的部署计划","Only an unexecuted deployment plan can be cancelled."),
}[errorText(e)]||errorText(e));
const time=(value:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(uiLanguage):t("尚无记录","No records yet");
const activeCredential=(c:Credential)=>activeMachineCredential(c);
const reusableCredential=(c:Credential)=>reusableMachineCredential(c);
const credentialExpiry=(c:Credential)=>c.retention==='permanent'?t('永久','Permanent'):time(c.expires_at);
const credentialName=(c:Credential)=>c.method==='password'?(c.retention==='one_time'||!c.retention?t('一次性密码','One-time password'):c.retention==='permanent'?t('永久密码','Permanent password'):c.retention==='managed'?t('托管密码','Managed password'):t('临时密码（可复用）','Temporary password (reusable)')):t('SSH 私钥','SSH private key');
const capabilityReason=(reason:string)=>({host_busy:t('此主机有终端、检查或部署正在进行，请结束后重试','This host has an active terminal, check, or deployment. Finish it and retry.'),direct_ssh_required:t('尚未配置直接 SSH，可在“编辑主机”中补充连接信息','Direct SSH is not configured. Add connection details in Edit host.'),ssh_credential_required:t('连接凭据已过期、撤销或清除，请添加新的 SSH 凭据','SSH credentials have expired, been revoked, or been cleared. Add a new SSH credential.'),ssh_key_required:t('自动安装或卸载需要有效 SSH 私钥或可复用密码；一次性密码不能用于操作','Automatic installation and removal need an active SSH private key or reusable password. Single-use passwords cannot be used.'),reusable_ssh_credential_required:t('请添加有效 SSH 私钥或临时/按期限托管的密码；一次性密码不能用于安装或卸载','Add an active SSH private key or a temporary/managed password. Single-use passwords cannot install or uninstall Agent.'),agent_not_linked:t('此主机尚未绑定可核对的 Agent，无法自动卸载','This host has no linked Agent identity to verify for automatic removal.'),agent_task_busy:t('节点有运行中、已派发或结果未知的任务，请先完成或核对','The Agent has running, dispatched, or uncertain tasks. Finish or verify them first.'),uninstallation_pending:t('此主机有待确认的卸载计划，请在详情的卸载历史中审阅或取消','This host has a pending uninstall plan. Review or cancel it in Uninstall history.'),uninstallation_unknown:t('上次卸载结果未知，请在详情的卸载历史中只读核对','The previous removal outcome is unknown. Use read-only verification in Uninstall history.'),agent_already_installed:t('已有 Agent，不能覆盖安装；请先核对现有节点','An Agent already exists. Verify the existing node before proceeding.')}[reason]||t('暂不可用，请刷新主机状态','Unavailable. Refresh the host status.'));
const clearReason=(reason:string)=>({expired:t('已到期','Expired'),revoked:t('已撤销','Revoked'),consumed:t('一次性使用结束','Single use completed'),agent_activated:t('Agent 已激活','Agent activated')}[reason]||reason);
const retentionName=(value:string)=>({permanent:t('永久','Permanent'),temporary:t('临时接入','Temporary enrollment'),managed:t('按期限托管','Managed storage'),one_time:t('一次性','One-time'),none:t('不保存秘密','No secret stored')}[value]||value);
const statusName=(value:string)=>({unknown:t("未接入","Not enrolled"),removed:t('节点已移除','Node removed'),uninstalled:t('Agent 已卸载','Agent uninstalled'),online:t("Agent 在线","Agent online"),offline:t("Agent 离线","Agent offline"),installing:t("部署中","Deploying"),error:t("需要处理","Needs attention")}[value]??value);

 const admin=user.role==='admin';
 const [searchParams,setSearchParams]=useSearchParams();
 const linkedMachine=searchParams.get('machine'),linkedDeployment=searchParams.get('deployment'),linkedUninstallation=searchParams.get('uninstallation');
 const [checkDetail,setCheckDetail]=useState<Detail>(),[checkBusy,setCheckBusy]=useState(false),[checkError,setCheckError]=useState(''),[checkResult,setCheckResult]=useState<SSHCheckResult>();
 const checkController=useRef<AbortController|null>(null);
 const [planCheck,setPlanCheck]=useState<SSHCheckResult>();
 useEffect(()=>()=>checkController.current?.abort(),[]);
 const {message}=App.useApp();
 const [machines,setMachines]=useState<Machine[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [agents,setAgents]=useState<AgentItem[]>([]),[labels,setLabels]=useState<AgentTaskLabel[]>([]),[includeRemoved,setIncludeRemoved]=useState(false);
 const [nodeDetail,setNodeDetail]=useState<AgentItem>(),[nodeLabels,setNodeLabels]=useState<AgentItem>();
 const [uninstallGuide,setUninstallGuide]=useState<AgentItem>();
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
 const [detail,setDetail]=useState<Detail>(),[detailBusy,setDetailBusy]=useState(false),[detailError,setDetailError]=useState('');
 const removedMachineIDs=useRef(new Set<string>());
 const [planMachine,setPlanMachine]=useState<Machine>(),[planDetail,setPlanDetail]=useState<Detail>(),[planBusy,setPlanBusy]=useState(false),[planError,setPlanError]=useState(''),[planResult,setPlanResult]=useState<any>();
 const [planNow,setPlanNow]=useState(Date.now());
 useEffect(()=>{
  setPlanNow(Date.now());const expires=Date.parse(planResult?.plan?.expires_at||'');
  if(!Number.isFinite(expires)||expires<=Date.now())return;
  const timer=setTimeout(()=>setPlanNow(Date.now()),Math.min(2_147_483_647,expires-Date.now()+50));return()=>clearTimeout(timer);
 },[planResult?.plan?.expires_at]);
 const planExpired=Date.parse(planResult?.plan?.expires_at||'')<=planNow;
 const load=useCallback(async(silent=false)=>{
  const request=++loadRequest.current;if(!silent)setLoading(true);
  const results=await Promise.allSettled([admin?api<Machine[]>('/machines'):Promise.resolve([] as Machine[]),api<AgentItem[]>(admin&&includeRemoved?'/agents?include_removed=true':'/agents'),api<AgentTaskLabel[]>('/agent-task-labels')]);
  if(request!==loadRequest.current)return;
  const [hosts,nodes,nextLabels]=results;
  if(hosts.status==='fulfilled')setMachines(hosts.value.filter(machine=>!removedMachineIDs.current.has(machine.id)));
  if(nodes.status==='fulfilled')setAgents(nodes.value.map(node=>archivedNodes.current.get(node.id)||node).filter(node=>includeRemoved||node.lifecycle_state!=='removed'));
  if(nextLabels.status==='fulfilled')setLabels(nextLabels.value);
  const failures=results.filter(result=>result.status==='rejected');setError(failures.map(result=>result.status==='rejected'?errorText(result.reason):'').join(' · '));setLoading(false);
 },[admin,includeRemoved]);
 useEffect(()=>{void load();return()=>{loadRequest.current++}},[load]);
 const refreshMachine=useCallback(async(machineID:string,refreshList=true)=>{
  try{const fresh=await api<Detail>(`/machines/${encodeURIComponent(machineID)}`);setDetail(previous=>previous?.machine.id===machineID?fresh:previous);setCheckDetail(previous=>previous?.machine.id===machineID?fresh:previous);setPlanDetail(previous=>previous?.machine.id===machineID?fresh:previous);setUninstallDetail(previous=>previous?.machine.id===machineID?fresh:previous)}catch{/* The host may have been deleted in another tab. */}
  if(refreshList)await load(true);
 },[load]);
 useEffect(()=>{
  const refresh=()=>{void load(true);if(admin)for(const id of new Set([detail?.machine.id,checkDetail?.machine.id,planMachine?.id,uninstallDetail?.machine.id].filter((id):id is string=>!!id)))void refreshMachine(id,false)};
  const timer=setInterval(refresh,15_000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh)};
 },[admin,load,refreshMachine,detail?.machine.id,checkDetail?.machine.id,planMachine?.id,uninstallDetail?.machine.id]);
 useEffect(()=>{
  if(!admin||!linkedMachine||!linkedDeployment)return;
  let active=true;
  Promise.all([api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`),api<Deployment>(`/machines/${encodeURIComponent(linkedMachine)}/deployments/${encodeURIComponent(linkedDeployment)}`)])
   .then(([host,existing])=>{if(active&&!removedMachineIDs.current.has(linkedMachine)){setPlanMachine(host.machine);setPlanDetail(host);setPlanResult(existing);setPlanError('')}})
   .catch(e=>{if(active)setError(errorText(e))});
  return()=>{active=false};
 },[admin,linkedMachine,linkedDeployment]);
 useEffect(()=>{
  if(!admin||!linkedMachine||!linkedUninstallation)return;let active=true;
  Promise.all([api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`),api<AgentUninstallation>(`/machines/${encodeURIComponent(linkedMachine)}/uninstallations/${encodeURIComponent(linkedUninstallation)}`)])
   .then(([host,record])=>{if(active&&!removedMachineIDs.current.has(linkedMachine)){setUninstallDetail(host);setUninstallRecord(record)}}).catch(e=>{if(active)setError(errorText(e))});
  return()=>{active=false};
 },[admin,linkedMachine,linkedUninstallation]);
 useEffect(()=>{
  if(!admin||!linkedMachine||linkedDeployment||linkedUninstallation)return;
  let active=true;
  api<Detail>(`/machines/${encodeURIComponent(linkedMachine)}`)
   .then(host=>{if(active&&!removedMachineIDs.current.has(linkedMachine)){setDetail(host);setDetailError('')}})
   .catch(e=>{if(active)setError(errorText(e))});
  return()=>{active=false};
 },[admin,linkedMachine,linkedDeployment,linkedUninstallation]);
 const openUninstall=async(machine:Machine,existing?:AgentUninstallation)=>{try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);const record=existing?await api<AgentUninstallation>(`/machines/${encodeURIComponent(machine.id)}/uninstallations/${encodeURIComponent(existing.id)}`):undefined;if(!removedMachineIDs.current.has(machine.id)){setUninstallRecord(record);setUninstallDetail(host)}}catch(e){void message.error(errorText(e))}};
 const openCheck=async(machine:Machine)=>{setCheckError('');setCheckResult(undefined);try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(!removedMachineIDs.current.has(machine.id))setCheckDetail(host)}catch(e){void message.error(errorText(e))}};
 const runCheck=async(values:any)=>{
  if(!checkDetail)return;
  const controller=new AbortController();checkController.current=controller;setCheckBusy(true);setCheckError('');setCheckResult(undefined);
  try{const result=await api<SSHCheckResult>(`/machines/${encodeURIComponent(checkDetail.machine.id)}/ssh-check`,{method:'POST',body:JSON.stringify(values),signal:controller.signal});if(checkController.current===controller)setCheckResult(result)}
  catch(e){if(!controller.signal.aborted)setCheckError(errorText(e))}
  finally{if(checkController.current===controller){setCheckBusy(false);checkController.current=null}await refreshMachine(checkDetail.machine.id)}
 };
 const closeCheck=()=>{checkController.current?.abort();checkController.current=null;setCheckBusy(false);setCheckDetail(undefined)};
 const openTerminal=async(machine:Machine)=>{try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(!removedMachineIDs.current.has(machine.id))setTerminalDetail(host)}catch(e){void message.error(errorText(e))}};
 const openDetail=async(machine:Machine)=>{setDetailError('');setDetailBusy(true);try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(!removedMachineIDs.current.has(machine.id))setDetail(host)}catch(e){void message.error(errorText(e))}finally{setDetailBusy(false)}};
 const forgetMachine=(machineID:string)=>{
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
  setPlanMachine(previous=>previous?.id===machineID?undefined:previous);
  setPlanDetail(previous=>previous?.machine.id===machineID?undefined:previous);
  if(planMachine?.id===machineID){setPlanResult(undefined);setPlanCheck(undefined);setPlanError('')}
 };
 const addCredential=async(values:any)=>{
  const target=credentialMachine;if(!target||credentialPending.current)return;
  credentialPending.current=true;setCredentialBusy(true);setCredentialError('');
  try{
   await api(`/machines/${encodeURIComponent(target.id)}/credentials`,{method:'POST',body:JSON.stringify(values)});credentialForm.resetFields();
   setCredentialMachine(undefined);
   await refreshMachine(target.id);
   void message.success(values.retention==='permanent'?t('SSH 凭据已永久保存，请按需轮换或撤销','SSH credential stored permanently; rotate or revoke it when needed'):values.method==='manual_script'?t('主机已登记，可稍后添加凭据','Host registered; add credentials later'):values.method==='password'&&values.retention==='one_time'?t('一次性密码已保存，使用结束后自动清除','One-time password saved; it will be cleared after use'):values.retention==='managed'?t('SSH 凭据已按期限托管，请按需轮换或撤销','SSH credential stored for the selected period; rotate or revoke it when needed'):t('临时 SSH 凭据已保存，到期或 Agent 激活后清除','Temporary SSH credential saved; cleared on expiry or Agent activation'));
  }catch(e){setCredentialError(errorText(e))}finally{credentialPending.current=false;setCredentialBusy(false)}
 };
 const revokeCredential=async(machineID:string,credentialID:string)=>{try{await api(`/machines/${encodeURIComponent(machineID)}/credentials/${encodeURIComponent(credentialID)}`,{method:'DELETE'});void message.success(t("连接凭据已撤销","Connection credential revoked"));if(detail?.machine.id===machineID)await openDetail(detail.machine);await load()}catch(e){void message.error(errorText(e))}};
 const cancelDeployment=async(machineID:string,deploymentID:string)=>{try{await api(`/machines/${encodeURIComponent(machineID)}/deployments/${encodeURIComponent(deploymentID)}/cancel`,{method:'POST',body:'{}'});if(detail?.machine.id===machineID)await openDetail(detail.machine);await load();void message.success(t("部署计划已取消","Deployment plan cancelled"))}catch(e){const error=lifecycleErrorText(e);setDetailError(error);void message.error(error)}};
 const openPlan=async(machine:Machine)=>{setPlanMachine(machine);setPlanDetail(undefined);setPlanResult(undefined);setPlanCheck(undefined);setPlanError('');try{const host=await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`);if(!removedMachineIDs.current.has(machine.id))setPlanDetail(host)}catch(e){setPlanError(errorText(e))}};
 const makePlan=async(values:any)=>{if(!planMachine)return;setPlanBusy(true);setPlanError('');setPlanCheck(undefined);try{
  const checked=await api<SSHCheckResult>(`/machines/${encodeURIComponent(planMachine.id)}/ssh-check`,{method:'POST',body:JSON.stringify({credential_id:values.credential_id})});
  setPlanCheck(checked);if(!checked.ready||checked.agent_installation&&checked.agent_installation.state!=='absent')return;
  const arch=values.arch==='auto'?checked.arch:values.arch;
  setPlanResult(await api<any>(`/machines/${encodeURIComponent(planMachine.id)}/deployments/plan`,{method:'POST',body:JSON.stringify({...values,arch,check_id:checked.id})}));
 }catch(e){setPlanError(errorText(e))}finally{setPlanBusy(false);await refreshMachine(planMachine.id)}};
 const applyPlan=async()=>{if(!planMachine||!planResult)return;setPlanBusy(true);setPlanError('');try{const result=await api<any>(`/machines/${encodeURIComponent(planMachine.id)}/deployments/${encodeURIComponent(planResult.id)}/apply`,{method:'POST',body:JSON.stringify({confirm:true})});setPlanResult(result);await load();void message.success(t("Agent 部署已完成","Agent deployment completed"))}catch(e){setPlanError(errorText(e));try{setPlanResult(await api<any>(`/machines/${encodeURIComponent(planMachine.id)}/deployments/${encodeURIComponent(planResult.id)}`))}catch{/* Keep the reviewed plan if refreshing fails. */}}finally{setPlanBusy(false);await refreshMachine(planMachine.id)}};
 const nodeFor=(machine:Machine)=>agents.find(agent=>agent.id===machine.agent_id)||archivedNodes.current.get(machine.agent_id);
 // Every row has a persisted platform host ID. Agent data only enriches its channel.
 const visibleMachines:Machine[]=admin?machines:agents.filter(agent=>!!agent.machine_id).map(agent=>({id:agent.machine_id!,name:agent.machine_name||agent.hostname||agent.id,address:'',port:0,username:'',connection_method:'',host_key_fingerprint:'',host_key_status:'',platform:agent.platform,arch:agent.arch,agent_id:agent.id,agent_status:agent.lifecycle_state==='removed'?'removed':agentIsOnline(agent)?'online':'offline',credential_count:0,active_credential_count:0,active_ssh_credential_count:0,active_ssh_key_count:0,ssh_recovery_available:false,capabilities:{} as Machine['capabilities'],last_deployment_status:'',updated_at:agent.last_seen,created_at:''}));
 const group=searchParams.get('group');
 const rows:FleetRow[]=visibleMachines.map(machine=>({...machine,node:nodeFor(machine)})).filter(row=>!group||row.node?.label_ids?.includes(group));
 const selectionScope=rows.map(row=>row.id).join('\0');
 useEffect(()=>{
  const allowed=new Set(selectionScope.split('\0'));
  setSelectedIDs(previous=>{const next=admin?previous.filter(id=>allowed.has(id)):[];return next.length===previous.length?previous:next});
 },[admin,selectionScope]);
 const selectedRows=rows.filter(row=>selectedIDs.includes(row.id));
 const openBatch=(action:BatchAction)=>{
  if(!admin||loading||batch||!selectedRows.length)return;
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
    setNodeDetail(previous=>previous?.id===existing.id?undefined:previous);setNodeLabels(previous=>previous?.id===existing.id?undefined:previous);
   }
  }
 };
 const nodeActions=(node:AgentItem,machine?:Machine)=><Space wrap>
  <Button size="small" onClick={()=>setNodeDetail(node)}>{t('节点详情','Node details')}</Button>
  {admin&&node.lifecycle_state!=='removed'&&<><Button size="small" onClick={()=>setNodeLabels(node)}>{t('设置任务标签','Set task labels')}</Button>{(!machine||!machine.capabilities?.uninstall_agent?.available)&&<Button size="small" onClick={()=>setUninstallGuide(node)}>{t('卸载指引','Uninstall guidance')}</Button>}</>}
 </Space>;
 return <div className={embedded?"lm-machines-page":"lm-page lm-machines-page"}>
  <div className="lm-page-heading"><div>{!embedded&&<h1>{t('主机','Hosts')}</h1>}<p>{t('先登记主机，再由平台部署 Agent。SSH 凭据可按期限保存，日常通过 Agent。','Register a host, then deploy Agent through the platform. Store SSH credentials for a chosen period and use Agent for routine operations.')}</p></div><Space wrap><Select allowClear aria-label={t('按任务标签筛选','Filter by task label')} style={{minWidth:160}} placeholder={t('全部任务标签','All task labels')} value={group||undefined} onChange={value=>setSearchParams(previous=>{const next=new URLSearchParams(previous);if(value)next.set('group',value);else next.delete('group');return next})} options={labels.map(label=>({value:label.id,label:label.name}))}/><Button aria-label={t('刷新','Refresh')} icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>{t('刷新','Refresh')}</Button>{admin&&<><Checkbox checked={includeRemoved} onChange={event=>setIncludeRemoved(event.target.checked)}>{t('包含已移除节点','Include removed nodes')}</Checkbox><Button type="primary" aria-label={t('登记主机','Register host')} icon={<PlusOutlined/>} onClick={startRegistration}>{t('登记主机','Register host')}</Button></>}</Space></div>
  {!admin&&<Alert type="info" showIcon className="lm-machine-notice" title={t('只读主机视图','Read-only host view')} description={t('可查看主机的 Agent 通道和监控任务；SSH 连接、凭据和生命周期管理仅管理员可用。','View host Agent channels and monitoring tasks. SSH connections, credentials, and lifecycle management are available only to administrators.')}/>}
  {error&&<Alert type="error" showIcon title={error} className="lm-machine-notice"/>}
  {admin&&<div className="lm-machine-batch-toolbar" role="region" aria-label={t('批量操作','Bulk actions')}>
   <Space wrap><Typography.Text strong>{t(`已选择 ${selectedRows.length} 项`,`Selected ${selectedRows.length}`)}</Typography.Text><Button size="small" disabled={!selectedRows.length||!!batch} onClick={()=>setSelectedIDs([])}>{t('清除选择','Clear selection')}</Button></Space>
   <Space wrap>{([
    ['ssh_check',t('批量 SSH 安装检查','Bulk SSH preflight')],['install',t('批量部署 Agent','Bulk deploy Agent')],['uninstall',t('卸载 Agent','Uninstall Agent')],['remove_node',t('移除节点','Remove nodes')],['delete_host',t('删除主机','Delete hosts')],
   ] as [BatchAction,string][]).map(([action,label])=><Button key={action} size="small" aria-label={label} danger={['uninstall','remove_node','delete_host'].includes(action)} disabled={loading||!selectedRows.length||!!batch} onClick={()=>openBatch(action)}>{label}</Button>)}</Space>
   <Typography.Text type="secondary">{t('勾选后按主机逐台执行；安装和卸载会先生成计划供统一审阅。每批最多 50 项。','Select rows to act on each host in sequence. Review installation and uninstall plans before execution. Up to 50 targets per batch.')}</Typography.Text>
  </div>}
  <div className="lm-surface"><Table<FleetRow> rowKey="id" dataSource={rows} loading={loading} rowSelection={admin?{selectedRowKeys:selectedIDs,preserveSelectedRowKeys:true,columnWidth:48,onChange:keys=>{if(keys.length>50){void message.warning(t('每批最多选择 50 项','Select up to 50 targets per batch'));return}setSelectedIDs(keys.map(String))},getCheckboxProps:row=>({'aria-label':t(`选择 ${row.name}`,`Select ${row.name}`),disabled:!!batch})}:undefined} scroll={{x:1328}} pagination={{pageSize:10,hideOnSinglePage:true}} locale={{emptyText:<Empty description={t("尚无主机","No hosts yet")}/>}} columns={[
   {title:t("主机","Host"),width:240,render:(_:unknown,m:FleetRow)=><div><strong>{m.name}</strong><Typography.Text type="secondary" copyable={{text:m.id}}>{t('主机 ID：','Host ID: ')}{m.id}</Typography.Text>{admin&&(m.address?<Typography.Text type="secondary" copyable={{text:`${m.address}:${m.port}`}}>{m.address}:{m.port}</Typography.Text>:<Typography.Text type="secondary">{t('SSH 未配置','SSH not configured')}</Typography.Text>)}{m.observed_hostname&&<Typography.Text type="secondary">{t('观测主机名：','Reported hostname: ')}{m.observed_hostname}</Typography.Text>}{m.node&&<Typography.Text type="secondary">Agent ID: {m.node.id}</Typography.Text>}</div>},
   {title:t("管理通道","Management channels"),width:180,render:(_:unknown,m:FleetRow)=><><Tag color={m.node?.lifecycle_state==='removed'?'default':m.node?agentIsOnline(m.node)?'success':'warning':'default'}>{m.node?.lifecycle_state==='removed'?t('节点已移除','Node removed'):m.node?agentIsOnline(m.node)?t('Agent 在线','Agent online'):t('Agent 离线','Agent offline'):m.agent_status==='removed'?t('节点已移除','Node removed'):m.agent_id?t('Agent 关联待核对','Agent link needs verification'):statusName(m.agent_status)}</Tag>{admin&&<Typography.Text type="secondary">{m.ssh_recovery_available?t('SSH 恢复通道可用','SSH recovery available'):!m.address?t('SSH 未配置','SSH not configured'):t('SSH 恢复通道不可用','SSH recovery unavailable')}</Typography.Text>}</>},
   {title:t('监控任务','Monitoring tasks'),width:210,render:(_:unknown,m:FleetRow)=>m.node?<><Typography.Text>{m.node.tasks?.length||0} {t('个匹配任务','matched tasks')}</Typography.Text><Space wrap>{m.node.label_ids?.map(id=><Tag key={id}>{labels.find(label=>label.id===id)?.name||id}</Tag>)}</Space></>:<Typography.Text type="secondary">{t('未接入 Agent','Agent not enrolled')}</Typography.Text>},
   {title:t("最近更新","Last updated"),dataIndex:'updated_at',width:180,render:time},
   {title:t("操作","Actions"),width:440,render:(_:unknown,m:FleetRow)=>{
    if(!admin)return m.node?nodeActions(m.node,m):null;
    const capabilities=[['terminal',t('登录终端','Open terminal')],['ssh_check',t('SSH 安装检查','SSH preflight')],['deploy_agent',t('部署 Agent','Deploy Agent')],['uninstall_agent',t('卸载 Agent','Uninstall Agent')]] as const;
    const blocked=capabilities.filter(([key])=>!m.capabilities?.[key]?.available);
    return <div className="lm-machine-actions">{m.node&&<div className="lm-node-actions">{nodeActions(m.node,m)}</div>}<Space wrap><Button size="small" disabled={!m.capabilities?.terminal?.available} onClick={()=>void openTerminal(m)}>{t("登录终端","Open terminal")}</Button><Button size="small" onClick={()=>void openDetail(m)}>{t("详情","Details")}</Button><Button size="small" onClick={()=>setEditMachine(m)}>{t("编辑主机","Edit host")}</Button><Button size="small" onClick={()=>{credentialForm.resetFields();setCredentialError('');setCredentialMachine(m)}}>{t("添加凭据","Add credential")}</Button><Button size="small" disabled={!m.capabilities?.ssh_check?.available} onClick={()=>void openCheck(m)}>{t("SSH 安装检查","SSH preflight")}</Button><Button size="small" type="primary" disabled={!m.capabilities?.deploy_agent?.available} onClick={()=>void openPlan(m)}>{t("部署 Agent","Deploy Agent")}</Button><Button size="small" danger disabled={!m.capabilities?.uninstall_agent?.available} onClick={()=>void openUninstall(m)}>{t('卸载 Agent','Uninstall Agent')}</Button></Space>
     {!!blocked.length&&<div className="lm-machine-blocked" role="note">{[...new Set(blocked.map(([key])=>m.capabilities?.[key]?.reason||''))].map(reason=><div key={reason}>{blocked.filter(([key])=>(m.capabilities?.[key]?.reason||'')===reason).map(([,label])=>label).join(t('、',', '))}：{capabilityReason(reason)}</div>)}{blocked.some(([key])=>['ssh_credential_required','ssh_key_required','reusable_ssh_credential_required'].includes(m.capabilities?.[key]?.reason||''))&&<Button type="link" size="small" onClick={()=>{credentialForm.resetFields();setCredentialError('');setCredentialMachine(m)}}>{t('添加新的 SSH 凭据','Add a new SSH credential')}</Button>}</div>}
    </div>;
   }},
  ]}/></div>
  {admin&&batch&&<MachineBatchDialog key={batch.action+':'+batch.targets.map(target=>target.id).join(',')} action={batch.action} targets={batch.targets} onClose={()=>{setBatch(undefined);setSelectedIDs([])}} onRefresh={()=>load(true)} onSuccess={batchSuccess}/>}
  {admin&&nodeLabels&&<NodeLabelsDialog key={nodeLabels.id} agent={nodeLabels} labels={labels} onClose={()=>setNodeLabels(undefined)} onSaved={()=>load(true)}/>}
  <Modal title={t('节点详情','Node details')} open={!!nodeDetail} onCancel={()=>setNodeDetail(undefined)} footer={null} width={760} destroyOnHidden>{nodeDetail&&<><NodeDetails agent={nodeDetail}/>{nodeDetail.lifecycle_state==='removed'&&<Alert type="warning" showIcon title={t('此节点已归档，旧凭据不能继续接入','This node is archived; old credentials can no longer enroll')} description={<>{time(nodeDetail.removed_at||'')} · {nodeDetail.removal_reason||t('未填写原因','No reason provided')}</>}/>}</>}</Modal>
  <Modal title={t('卸载 Agent 指引','Agent uninstall guidance')} open={!!uninstallGuide} onCancel={()=>setUninstallGuide(undefined)} footer={null}><p>{t('自动卸载需要关联主机和有效 SSH 私钥或可复用密码。配置 SSH 连接并添加凭据后，即可检查并审阅卸载计划；主机公钥在首次连接时自动记录，后续自动校验。','Automatic uninstall requires a host record and an active SSH private key or reusable password. Configure SSH and add credentials, then run checks and review the uninstall plan. The host public key is recorded on first connection and verified automatically afterward.')}</p><Alert type="info" showIcon title={t('没有 SSH 时可手动卸载','Manual uninstall without SSH')} description={t('在目标机器核对 Agent ID 和标准安装路径，使用对应版本安装包中的 deploy/agent/uninstall.sh；默认保留配置与待上报数据，不使用 --purge。远端卸载后在平台移除节点以撤销独立凭据。平台不会把显示此指引当作卸载成功。','Verify the Agent ID and managed installation paths on the target machine, then use deploy/agent/uninstall.sh from the matching release. Keep configuration and queued data by default; do not use --purge. Remove the node in the platform afterward to revoke independent credentials. Displaying this guidance does not report uninstall success.')}/></Modal>
  {admin&&uninstallDetail&&<MachineAgentUninstallDialog key={`${uninstallDetail.machine.id}:${uninstallRecord?.id||'new'}`} machine={uninstallDetail.machine} credentials={uninstallDetail.credentials} existing={uninstallRecord} onRefresh={()=>refreshMachine(uninstallDetail.machine.id)} onClose={()=>{setUninstallDetail(undefined);setUninstallRecord(undefined)}}/>}
  {admin&&editMachine&&<MachineEditDialog key={editMachine.id} machine={editMachine} onClose={()=>setEditMachine(undefined)} onSaved={()=>refreshMachine(editMachine.id)}/>}
  {admin&&terminalDetail&&<MachineTerminalDialog key={terminalDetail.machine.id} machine={terminalDetail.machine} credentials={terminalDetail.credentials} onReleased={()=>refreshMachine(terminalDetail.machine.id)} onClose={()=>setTerminalDetail(undefined)}/>}
  {admin&&newOpen&&<MachineRegistrationDialog onClose={()=>setNewOpen(false)} onChanged={()=>load(true)} onCheck={id=>void api<Detail>(`/machines/${encodeURIComponent(id)}`).then(host=>openCheck(host.machine)).catch(e=>message.error(errorText(e)))} onPlan={id=>void api<Detail>(`/machines/${encodeURIComponent(id)}`).then(host=>openPlan(host.machine)).catch(e=>message.error(errorText(e)))}/>}
  <Modal className="lm-machine-credential-dialog" style={{top:24}} title={t(`添加连接凭据 · ${credentialMachine?.name??''}`,`Add connection credential · ${credentialMachine?.name??''}`)} open={admin&&!!credentialMachine} onCancel={()=>{if(!credentialBusy){credentialForm.resetFields();setCredentialMachine(undefined)}}} footer={null} destroyOnHidden>
   <MachineCredentialForm form={credentialForm} busy={credentialBusy} error={credentialError} onFinish={addCredential}/>
  </Modal>
  <Modal title={t(`SSH 安装检查 · ${checkDetail?.machine.name??''}`,`SSH preflight · ${checkDetail?.machine.name??''}`)} open={admin&&!!checkDetail} onCancel={closeCheck} footer={null} width={680} destroyOnHidden>
   <p>{t('使用已保存的私钥或密码执行固定只读检查，最长约 60 秒，可以取消。一次性密码在检查后清除；临时、托管或永久密码在有效期内可继续用于安装。检查不会安装或修改主机配置。','Run fixed read-only checks with a saved key or password, up to 60 seconds, with cancellation. Single-use passwords are cleared afterward. Temporary, managed, or permanent passwords can install Agent within their validity. Preflight does not install or change host configuration.')}</p>
   {checkDetail&&<Form key={checkDetail.credentials.filter(activeCredential).map(c=>c.id).join(',')} layout="vertical" onFinish={runCheck} disabled={checkBusy} initialValues={{credential_id:checkDetail.credentials.filter(c=>(c.method==='ssh_key'||c.method==='password')&&activeCredential(c)).length===1?checkDetail.credentials.find(c=>(c.method==='ssh_key'||c.method==='password')&&activeCredential(c))?.id:undefined}}>
    <Form.Item label={t('SSH 凭据','SSH credential')} name="credential_id" rules={[{required:true,message:t('请选择有效的 SSH 凭据','Select an active SSH credential')}]}><Select options={checkDetail.credentials.filter(c=>(c.method==='ssh_key'||c.method==='password')&&activeCredential(c)).map(c=>({value:c.id,label:`${credentialName(c)} · ${c.secret_fingerprint||c.id}`}))}/></Form.Item>
    <Space><Button aria-label={t("开始 SSH 检查","Run SSH preflight")} type="primary" htmlType="submit" loading={checkBusy} disabled={!checkDetail?.credentials.some(c=>activeCredential(c)&&(c.method==='ssh_key'||c.method==='password'))}>{t('开始 SSH 检查','Run SSH preflight')}</Button>{checkBusy&&<Button disabled={false} onClick={closeCheck}>{t('取消检查','Cancel check')}</Button>}</Space>
   </Form>}
   {checkError&&<Alert type="error" showIcon title={checkError}/>}{checkResult&&<SSHCheckSummary result={checkResult}/>}
  </Modal>
  <Modal title={t(`主机详情 · ${detail?.machine.name??''}`,`Host details · ${detail?.machine.name??''}`)} open={admin&&!!detail} onCancel={()=>setDetail(undefined)} footer={null} width={1060} destroyOnHidden>
   {detailError&&<Alert type="error" showIcon title={detailError} className="lm-machine-form-notice"/>}
   {detail&&<><Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'name',label:t('主机名称','Host name'),children:detail.machine.name},{key:'id',label:t('主机 ID（平台生成，不可修改）','Host ID (platform-generated, immutable)'),children:<Typography.Text code copyable={{text:detail.machine.id}}>{detail.machine.id}</Typography.Text>},{key:'agent',label:'agent_id',children:detail.machine.agent_id||t("尚未绑定","Not linked yet")},{key:'address',label:t("连接地址","Connection address"),children:detail.machine.address?`${detail.machine.username}@${detail.machine.address}:${detail.machine.port}`:t('尚未配置 SSH','SSH not configured')},{key:'status',label:t("Agent 状态","Agent status"),children:statusName(detail.machine.agent_status)},{key:'recovery',label:t('SSH 恢复通道','SSH recovery channel'),children:detail.machine.ssh_recovery_available?t('可用','Available'):t('不可用，请按需添加凭据','Unavailable. Add credentials when needed')},{key:'fingerprint',label:t("主机指纹","Host fingerprint"),span:2,children:detail.machine.host_key_fingerprint?<Typography.Text code copyable={{text:detail.machine.host_key_fingerprint}}>{detail.machine.host_key_fingerprint}</Typography.Text>:t("首次 SSH 连接后自动记录","Recorded automatically on first SSH connection")},{key:'host-public-key',label:t("主机公钥","Host public key"),span:2,children:detail.machine.host_key_public_key?<Typography.Text code className="lm-machine-path" copyable={{text:detail.machine.host_key_public_key}}>{detail.machine.host_key_public_key}</Typography.Text>:t("首次 SSH 连接后自动记录","Recorded automatically on first SSH connection")},{key:'host-key-observed',label:t("公钥记录时间","Public key recorded at"),span:2,children:time(detail.machine.host_key_observed_at||'')}]}/><h3>{t("连接凭据","Connection credentials")}</h3><Table<Credential> size="small" rowKey="id" dataSource={detail.credentials} scroll={{x:980}} pagination={false} columns={[{title:t("类型","Type"),dataIndex:'method',render:(v:string,c:Credential)=>v==='manual_script'?t('不保存凭据','No credential'):credentialName(c)},{title:t("指纹","Fingerprint"),dataIndex:'secret_fingerprint'},{title:t("保留策略","Retention policy"),render:(_:unknown,c:Credential)=><><Tag color={['managed','permanent'].includes(c.retention)?'warning':'default'}>{retentionName(c.retention)}</Tag>{c.policy_source==='legacy'&&<Tag>{c.retention==='managed'?t('历史托管','Legacy managed'):t('历史策略','Legacy policy')}</Tag>}</>},{title:t("有效期","Expires at"),render:(_:unknown,c:Credential)=>credentialExpiry(c)},{title:t("最近使用","Last used"),dataIndex:'last_used_at',render:time},{title:t('秘密状态','Secret status'),render:(_:unknown,c:Credential)=>c.secret_cleared_at?<><Tag>{t('已清除','Cleared')}</Tag><Typography.Text type="secondary">{clearReason(c.clear_reason||'')} · {time(c.secret_cleared_at)}</Typography.Text></>:c.method==='manual_script'?t('不保存秘密','No secret stored'):t('已加密保存','Stored encrypted')},{title:t("状态","Status"),render:(_:unknown,c:Credential)=>c.revoked_at?<Tag>{t("已撤销","Revoked")}</Tag>:!activeCredential(c)?<Tag>{t("已过期","Expired")}</Tag>:<Tag color="success">{t("有效","Active")}</Tag>},{title:t("操作","Actions"),render:(_:unknown,c:Credential)=>!activeCredential(c)?null:<Popconfirm title={t("撤销此连接凭据？","Revoke this connection credential?")} description={t("撤销会清除当前保存的秘密并立即断开使用此凭据的终端，且不能再用于部署。","Revocation clears the stored secret, immediately closes terminals using this credential, and prevents further deployment.")} okText={t("撤销","Revoke")} cancelText={t("取消","Cancel")} onConfirm={()=>void revokeCredential(detail.machine.id,c.id)}><Button size="small" danger>{t("撤销","Revoke")}</Button></Popconfirm>}]}/><h3>{t("部署历史","Deployment history")}</h3><Table<Deployment> size="small" rowKey="id" dataSource={detail.deployments} pagination={{pageSize:5}} columns={[{title:t("状态","Status"),dataIndex:'status'},{title:t("版本","Version"),dataIndex:'version'},{title:t("创建时间","Created at"),dataIndex:'created_at',render:time},{title:t("错误","Error"),dataIndex:'error'},{title:t("操作","Actions"),render:(_:unknown,d:Deployment)=>d.status==='awaiting_approval'?<Popconfirm title={t("取消这个尚未执行的部署计划？","Cancel this unexecuted deployment plan?")} description={t("取消后不能继续执行；如需部署，请重新检查并生成计划。","The plan cannot run after cancellation. Run preflight and create a new plan to deploy later.")} okText={t("确认取消","Confirm cancellation")} cancelText={t("返回","Back")} onConfirm={()=>void cancelDeployment(detail.machine.id,d.id)}><Button size="small" danger>{t("取消计划","Cancel plan")}</Button></Popconfirm>:null}]}/><h3>{t('卸载历史','Uninstall history')}</h3><Table<AgentUninstallation> size="small" rowKey="id" dataSource={detail.uninstallations||[]} pagination={{pageSize:5}} columns={[{title:t('状态','Status'),dataIndex:'status',render:(status:string)=>({awaiting_approval:t('待确认','Awaiting approval'),running:t('正在卸载','Uninstalling'),succeeded:t('卸载完成','Uninstalled'),failed:t('卸载失败','Uninstall failed'),unknown:t('结果未知，需核对','Outcome unknown; verification needed'),cancelled:t('已取消','Cancelled')}[status]||status)},{title:t('节点身份','Agent identity'),dataIndex:'agent_id'},{title:t('创建时间','Created at'),dataIndex:'created_at',render:time},{title:t('错误','Error'),dataIndex:'error'},{title:t('操作','Actions'),render:(_:unknown,record:AgentUninstallation)=><Button size="small" onClick={()=>{setDetail(undefined);void openUninstall(detail.machine,record)}}>{record.status==='unknown'?t('核对结果','Verify outcome'):record.status==='awaiting_approval'?t('审阅卸载计划','Review uninstall plan'):t('查看卸载记录','View uninstall record')}</Button>}]}/></>}
  </Modal>
  <Modal title={t(`部署 LightMoni Agent · ${planMachine?.name??''}`,`Deploy LightMoni Agent · ${planMachine?.name??''}`)} open={admin&&!!planMachine} onCancel={()=>{if(!planBusy)setPlanMachine(undefined)}} footer={null} width={760} destroyOnHidden>
   {!planResult&&planDetail&&(()=>{const keys=planDetail.credentials.filter(reusableCredential);return keys.length?<Form layout="vertical" onFinish={makePlan} disabled={planBusy} initialValues={{version:'0.1.0',arch:'auto',credential_id:keys.length===1?keys[0].id:undefined}}><Form.Item label={t("连接凭据","Connection credentials")} name="credential_id" rules={[{required:true,message:t("请选择可复用的 SSH 凭据","Select a reusable SSH credential")}]}><Select options={keys.map(c=>({value:c.id,label:`${credentialName(c)} · ${c.secret_fingerprint||c.id} · ${credentialExpiry(c)}`}))}/></Form.Item><Space.Compact block><Form.Item label={t("Agent 版本","Agent version")} name="version" rules={[{required:true}]} style={{width:'50%'}}><Input/></Form.Item><Form.Item label={t("架构","Architecture")} name="arch" rules={[{required:true}]} style={{width:'50%'}}><Select options={[{value:'auto',label:t('自动检查识别','Detect with SSH preflight')},{value:'amd64',label:'amd64'},{value:'arm64',label:'arm64'}]}/></Form.Item></Space.Compact><Form.Item label={t("初始任务标签","Initial task label")} name="initial_label_id"><Input placeholder={t("可留空，接入后在主机的任务标签中设置","Optional. Configure later in the host’s task labels")}/></Form.Item>{planError&&<Alert type="error" showIcon title={planError} className="lm-machine-form-notice"/>}<Button type="primary" htmlType="submit" loading={planBusy} block>{t("检查并生成部署计划","Check and create deployment plan")}</Button></Form>:<Alert type="warning" showIcon title={t("暂无可用于自动部署的可复用 SSH 凭据","No reusable SSH credential available for automatic deployment")} description={t("自动部署需要有效私钥或临时、托管、永久密码。主机公钥在首次连接时自动记录；一次性密码在检查后清除，不能用于部署。","Automatic deployment needs an active key or temporary, managed, or permanent password. The host public key is recorded on first connection. Single-use passwords are cleared after preflight and cannot deploy Agent.")}/>})()}
   {planCheck&&!planResult&&<SSHCheckSummary result={planCheck}/>}
   {planError&&!planDetail&&<Alert type="error" showIcon title={planError}/>}
   {planResult&&<><Alert type={planResult.status==='succeeded'?'success':'info'} showIcon title={planResult.status==='succeeded'?t("Agent 已部署并收到激活回执","Agent deployed and activation confirmed"):planResult.status==='awaiting_approval'&&planExpired?t("部署计划已过期，请重新检查","Deployment plan expired. Run preflight again."):planResult.status==='awaiting_approval'?t("请审阅固定部署步骤后确认","Review the deployment steps before confirming"):t(`部署状态：${planResult.status}`,`Deployment status: ${planResult.status}`)} description={planResult.error||(planResult.plan?t("确认后执行固定部署。Agent 激活后清除此主机的临时凭据，保留按期限托管或永久凭据；后续优先使用 Agent 通道。","Confirmation runs the fixed installation workflow. Agent activation clears temporary credentials for this host and keeps managed or permanent credentials. Prefer the Agent channel afterward."):planResult.receipt?.error)}/>{planResult.plan&&<Descriptions column={1} size="small" items={[{key:'target',label:t('目标主机','Target host'),children:`${planResult.plan.machine?.username}@${planResult.plan.machine?.address}:${planResult.plan.machine?.port}`},{key:'version',label:t('版本 / 架构','Version / architecture'),children:`${planResult.plan.version} / ${planResult.plan.arch}`},{key:'expires',label:t('计划有效期','Plan expires at'),children:time(planResult.plan.expires_at)}]}/>}{planResult.plan?.preflight&&<SSHCheckSummary result={planResult.plan.preflight}/>}<Descriptions size="small" column={1} items={(planResult.plan?.steps||planResult.receipt?.stages||[]).map((step:string,index:number)=>({key:index,label:t(`步骤 ${index+1}`,`Step ${index+1}`),children:({"确认主机公钥指纹":t("自动校验主机公钥","Automatically verify the host public key"),"自动校验主机公钥":t("自动校验主机公钥","Automatically verify the host public key"),"建立受限 SSH 连接":t("建立受限 SSH 连接","Connect through restricted SSH"),"下载固定版本 Agent 并校验 SHA256":t("下载固定版本 Agent 并校验 SHA256","Download the fixed Agent release and verify SHA256"),"通过 stdin 注入一次性 enrollment token":t("通过 stdin 注入一次性 enrollment token","Pass the one-time enrollment token through stdin"),"安装独立 systemd Agent":t("安装独立 systemd Agent","Install the independent systemd Agent service"),"等待 Agent 激活回执":t("等待 Agent 激活回执","Wait for Agent activation confirmation")} as Record<string,string>)[step]||step}))}/><Typography.Paragraph type="secondary">{t("部署计划 ID：","Deployment plan ID: ")}<Typography.Text code>{planResult.id}</Typography.Text></Typography.Paragraph>{planError&&<Alert type="error" showIcon title={planError} className="lm-machine-form-notice"/>}{(planExpired||planError||['failed','cancelled'].includes(planResult.status))&&<Button disabled={planBusy} onClick={()=>planMachine&&void openPlan(planMachine)} block>{t('重新检查并生成计划','Run preflight and create a new plan')}</Button>}{planResult.status==='awaiting_approval'&&<Button type="primary" danger loading={planBusy} disabled={planExpired} onClick={()=>void applyPlan()} block>{t("我已审阅，确认执行 SSH 部署","I have reviewed the steps; run SSH deployment")}</Button>}</>}
  </Modal>
 </div>;
}
