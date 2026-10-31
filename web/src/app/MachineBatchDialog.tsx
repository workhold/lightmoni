import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Input,Modal,Select,Space,Tag,Typography} from '../shared/ui';
import {sshEndpoint} from './host-request-guard';
import {api,ApiError} from '../shared/api';
import {defaultMachineCredential} from './machine-credentials';
import {useI18n} from '../shared/i18n';
import SSHCheckSummary,{type SSHCheckResult} from '../shared/SSHCheckSummary';
import {MAX_BATCH_TARGETS,batchCredentials,batchHistoryURL,batchPlanExpired,batchPlanPath,batchPlanStatus,batchUnavailableReason,machineBatchPath,needsBatchPlan,type BatchAction,type BatchCredential,type BatchDetail,type BatchPlan,type BatchStatus,type BatchTarget} from './machine-batch';

export type {BatchAction,BatchTarget} from './machine-batch';
type Row={target:BatchTarget;status:BatchStatus;reason?:string;detail?:BatchDetail;credentialID?:string;check?:SSHCheckResult;record?:BatchPlan;unresolvedPlan?:boolean;attempted?:boolean;note?:string};
type Props={action:BatchAction;targets:BatchTarget[];onClose:()=>void;onRefresh:()=>Promise<void>;onSuccess?:(target:BatchTarget,action:BatchAction,result:unknown)=>void};
type Phase='configure'|'review'|'results';

export default function MachineBatchDialog({action,targets,onClose,onRefresh,onSuccess}:Props){
 const {t,language}=useI18n();
 // Selection outside this dialog cannot change a batch that is under review.
 const [snapshot]=useState(()=>structuredClone(targets));
 const [rows,setRows]=useState<Row[]>(()=>{const seen=new Set<string>();return snapshot.map(target=>{const id=action==='remove_node'?target.agent?.id:target.machine?.id;if(id&&seen.has(id))return {target,status:'not_applicable',reason:'duplicate_target'};if(id)seen.add(id);return {target,status:'pending'}})});
 const rowsRef=useRef(rows),pending=useRef(false),stop=useRef(false),initialized=useRef(false),mounted=useRef(true);
 const [busy,setBusy]=useState(false),[stopping,setStopping]=useState(false),[phase,setPhase]=useState<Phase>('configure');
 const [version,setVersion]=useState('0.1.0'),[reason,setReason]=useState(''),[reviewed,setReviewed]=useState(false),[notice,setNotice]=useState(''),[now,setNow]=useState(Date.now());
 const isPlan=needsBatchPlan(action),limitExceeded=snapshot.length>MAX_BATCH_TARGETS;
 const title=({ssh_check:t('批量 SSH 安装检查','Batch SSH installation checks'),install:t('批量部署 LightMoni Agent','Batch deploy LightMoni Agent'),uninstall:t('卸载 Agent','Uninstall Agent'),remove_node:t('移除节点','Remove nodes'),delete_host:t('删除主机','Delete hosts')})[action];
 const errorText=(error:unknown)=>error instanceof Error?error.message:t('请求失败','Request failed');
 const time=(value?:string)=>value?new Date(value).toLocaleString(language):t('未知','Unknown');
 const update=(id:string,patch:Partial<Row>)=>{const next=rowsRef.current.map(row=>row.target.id===id?{...row,...patch}:row);rowsRef.current=next;if(mounted.current)setRows(next)};
 const reasonText=(code:string)=>({
  host_required:t('没有关联主机，无法通过 SSH 操作；请先登记主机并核验关联。','No linked host is available for SSH. Register a host and verify the link first.'),
  node_required:t('尚无节点身份；删除主机记录请使用“删除主机”。','No node identity exists. Use Delete hosts to remove the host record.'),
  node_removed:t('节点已移除，不能重复移除。','This node is already removed.'),
  duplicate_target:t('相同目标已在本批次中，仅执行一次。','The same target already appears in this batch and will run once.'),
  host_busy:t('主机有正在进行的操作，请先完成。','The host has an operation in progress. Finish it first.'),
  direct_ssh_required:t('当前连接方式不支持直接 SSH。','The connection method does not support direct SSH.'),
  ssh_credential_required:t('没有有效的 SSH 私钥或密码。','No active SSH private key or password is available.'),
  ssh_key_required:t('安装和卸载需要有效私钥或可复用密码；一次性密码不能用于此操作。','Installation and removal need an active key or reusable password. Single-use passwords cannot be used.'),
  reusable_ssh_credential_required:t('请添加有效私钥或临时/托管密码；一次性密码不能用于安装或卸载。','Add an active key or temporary/managed password. Single-use passwords cannot install or uninstall Agent.'),
  agent_already_installed:t('主机已关联 Agent，不能覆盖安装；请核对现有节点。','The host already has an Agent link. Verify the existing node before installation.'),
  agent_not_linked:t('主机尚未关联 Agent，无法确认要卸载的节点身份。','The host has no Agent link to identify the node to uninstall.'),
  agent_task_busy:t('节点有未结束或结果未知的任务，请先核对。','The node has unfinished or uncertain tasks. Verify them first.'),
  deployment_pending:t('存在待确认、执行中或结果未知的安装计划，请在主机历史中处理。','A pending, running, or uncertain installation plan exists. Resolve it in host history.'),
  installation_pending:t('存在待确认或执行中的安装，请从部署历史继续。','A pending or running installation exists. Continue from deployment history.'),
  installation_unknown:t('上次首装结果未知，请在部署历史中核对或人工结束。','The previous installation outcome is unknown. Verify or resolve it in deployment history.'),
  uninstallation_pending:t('存在待确认、执行中或结果未知的卸载流程，请在主机历史中处理。','A pending, running, or uncertain uninstall workflow exists. Resolve it in host history.'),
  uninstallation_unknown:t('上次卸载结果未知，请在历史中只读核对。','The previous uninstall outcome is unknown. Verify it read-only in host history.'),
  active_agent:t('主机仍有有效 Agent 身份，请先移除身份，再删除主机。','Remove the active Agent identity before deleting the host.'),
  active_credentials:t('请先解绑本主机的有效连接凭据，再删除主机记录；中央凭据和其他主机不受影响。','Unlink this host’s active connection credentials before deleting its record. Central credentials and other hosts are unaffected.'),
  choose_credential:t('请选择有效的 SSH 凭据。多条凭据时需要明确选择。','Select an active SSH credential. An explicit selection is required when multiple credentials exist.'),
  plan_expired:t('计划已过期，未执行。请取消后重新检查。','The plan expired and was not executed. Cancel it before running new checks.'),
  stopped:t('已停止后续，此目标尚未执行。','Subsequent operations were stopped. This target was not executed.'),
  check_failed:t('SSH 未连接或安装检查未通过，没有生成计划。','SSH did not connect or installation checks failed. No plan was created.'),
  existing_remote_agent:t('预检发现已有 Agent 或无法确认不存在；不会覆盖安装。','Preflight found an existing Agent or could not rule one out. Installation will not overwrite it.'),
  invalid_arch:t('预检未返回受支持的 amd64/arm64 架构，没有生成计划。','Preflight did not report a supported amd64/arm64 architecture. No plan was created.'),
  unavailable:t('当前不可执行，请刷新主机详情并处理前置条件。','Unavailable. Refresh host details and resolve prerequisites.'),
 }[code]||code);
 const stepText=(step:string)=>({
  '确认主机公钥指纹':t('自动校验主机公钥','Automatically verify the host public key'),
  '自动校验主机公钥':t('自动校验主机公钥','Automatically verify the host public key'),
  '建立受限 SSH 连接':t('建立受限 SSH 连接','Establish a restricted SSH connection'),
  '下载固定版本 Agent 并校验 SHA256':t('下载固定版本 Agent 并校验 SHA256','Download the fixed Agent release and verify SHA256'),
  '通过 stdin 注入一次性 enrollment token':t('通过 stdin 注入一次性 enrollment token','Pass a one-time enrollment token through stdin'),
  '安装独立 systemd Agent':t('安装独立 systemd Agent','Install the independent systemd Agent service'),
  '等待 Agent 激活回执':t('等待 Agent 激活回执','Wait for Agent activation confirmation'),
  '核对远端 Agent 身份':t('核对远端 Agent 身份','Verify the remote Agent identity'),
  '停止并禁用 Agent 服务':t('停止并禁用 Agent 服务','Stop and disable the Agent service'),
  '确认服务停止后移除 Agent 程序':t('确认服务停止后移除 Agent 程序','Confirm the service has stopped and remove the Agent runtime'),
  '保留配置、身份与缓存':t('保留配置、身份与缓存','Retain configuration, identity, and cache'),
  '核验移除结果并撤销节点凭据':t('核验移除结果并撤销节点凭据','Verify removal and revoke node credentials'),
 }[step]||step);
 const warningText=(warning:string)=>({
  'AI 不会读取或发送 SSH 秘密。':t('AI 不会读取或发送 SSH 秘密。','The AI does not read or send SSH secrets.'),
  '用户确认后才执行固定部署流程。':t('用户确认后才执行固定部署流程。','The fixed deployment workflow runs after confirmation.'),
  'SSH 密码建议只使用一次，不要长期保存。':t('SSH 密码建议只使用一次，不要长期保存。','Use SSH passwords once and avoid long-term storage.'),
  'Agent 激活后日常操作优先使用 Agent 通道。':t('Agent 激活后日常操作优先使用 Agent 通道。','Prefer the Agent channel for routine operations after activation.'),
  '采集和节点任务将停止；业务服务、制品、容器和卷保持不变。':t('采集和节点任务将停止；业务服务、制品、容器和卷保持不变。','Collection and node tasks stop. Business services, artifacts, containers, and volumes are retained.'),
  '默认保留配置和缓存，但旧节点凭据将撤销，重装需重新接入。':t('默认保留配置和缓存，但旧节点凭据将撤销，重装需重新接入。','Configuration and cache are retained. Old node credentials are revoked; reinstalling requires enrollment again.'),
  'SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。':t('SSH 中断可能产生未知结果，请使用核对功能，不要盲目重试。','Interrupted SSH may leave an unknown outcome. Verify it instead of retrying blindly.'),
 }[warning]||warning);
 const statusText=(row:Row)=>row.record?.status==='cancelled'?t('计划已取消','Plan cancelled'):row.status==='pending'&&row.record?.status==='awaiting_approval'&&!row.attempted?t('计划已准备，待审阅','Plan ready for review'):({pending:t('待处理','Pending'),processing:t('处理中','In progress'),success:t('成功','Succeeded'),failed:t('失败','Failed'),not_applicable:t('不适用','Not applicable'),unknown:t('结果未知，需核对','Outcome unknown; verification needed')})[row.status];
 const refresh=async()=>{if(!mounted.current)return;try{await onRefresh()}catch{if(mounted.current)setNotice(t('列表刷新失败；各项操作结果已保留，请稍后刷新。','The list could not be refreshed. Individual operation results are retained; refresh later.'))}};
 const start=()=>{if(pending.current||limitExceeded)return false;pending.current=true;stop.current=false;setStopping(false);setBusy(true);setNotice('');return true};
 const finish=()=>{pending.current=false;if(mounted.current){setBusy(false);setStopping(false)}};
 const stopRemaining=()=>{stop.current=true;setStopping(true)};
 const markStopped=()=>{for(const row of rowsRef.current)if(row.status==='pending'&&!row.record)update(row.target.id,{reason:'stopped'})};
 const history=(row:Row)=>row.target.machine?batchHistoryURL(action,row.target.machine.id,row.record?.id):undefined;
 const notifySuccess=(row:Row,result:unknown)=>{try{onSuccess?.(row.target,action,result)}catch{/* A parent refresh cannot change an already completed remote result. */}};

 useEffect(()=>{
  mounted.current=true;stop.current=false;
  const cleanup=()=>{mounted.current=false;stop.current=true};
  if(initialized.current)return cleanup;initialized.current=true;
  if(limitExceeded){setNotice(t('每批最多 50 个目标，请缩小选择范围。','A batch supports up to 50 targets. Reduce the selection.'));return cleanup}
  const initialize=async()=>{
   if(!start())return;
   try{for(const row of rowsRef.current){
    if(stop.current||!mounted.current)break;if(row.reason)continue;
    if(action==='remove_node'){const why=batchUnavailableReason(action,row.target);if(why)update(row.target.id,{status:'not_applicable',reason:why});continue}
    const preliminary=batchUnavailableReason(action,row.target);
    if(preliminary){update(row.target.id,{status:'not_applicable',reason:preliminary});continue}
    update(row.target.id,{status:'processing'});
    try{const detail=await api<BatchDetail>(machineBatchPath(row.target.machine!.id));const why=batchUnavailableReason(action,row.target,detail);const credentials=batchCredentials(action,detail.credentials);update(row.target.id,{detail,status:why?'not_applicable':'pending',reason:why||undefined,credentialID:defaultMachineCredential(credentials,detail.machine.default_credential_id)})}
    catch(error){update(row.target.id,{status:'failed',reason:errorText(error)})}
   }if(stop.current&&mounted.current)markStopped()}finally{finish()}
  };void initialize();
  return cleanup;
 },[]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);

 const credentialsFor=(row:Row)=>batchCredentials(action,row.detail?.credentials||[],now);
 const configurable=rows.filter(row=>row.status==='pending'&&!row.record&&!row.reason);
 const credentialsReady=action==='remove_node'||action==='delete_host'||configurable.every(row=>credentialsFor(row).some(credential=>credential.id===row.credentialID));
 const validVersion=/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version);
 const validReason=new TextEncoder().encode(reason.trim()).length<=512;
 const pendingPlans=rows.filter(row=>row.record?.status==='awaiting_approval');
 const hasUnknown=rows.some(row=>row.status==='unknown'||row.unresolvedPlan);
 const executablePlans=pendingPlans.filter(row=>!row.attempted&&!batchPlanExpired(row.record!,now));

 // If the plan POST response is lost, recover that exact preflight's new plan
 // from durable history. Never create another plan or repeat an apply request.
 const recoverPlan=async(row:Row,check:SSHCheckResult,priorIDs:Set<string>)=>{
  const detail=await api<BatchDetail>(machineBatchPath(row.target.machine!.id));
  const candidates=(action==='install'?detail.deployments:detail.uninstallations)?.filter(record=>!priorIDs.has(record.id)&&record.plan?.check_id===check.id&&record.plan?.credential?.id===row.credentialID)||[];
  if(candidates.length!==1)throw Error(t('无法确定是否已保存计划，请在主机历史中核对；不要重复创建或执行。','It is unclear whether a plan was saved. Check host history; do not create or execute it again.'));
  return candidates[0];
 };
 const prepare=async()=>{
  if(!credentialsReady||!configurable.length||(action==='install'&&!validVersion)||!start())return;
  try{
   for(const original of rowsRef.current){
    if(stop.current)break;
    const row=rowsRef.current.find(item=>item.target.id===original.target.id)!;
    if(row.status!=='pending'||row.record||row.reason)continue;
    const credential=credentialsFor(row).find(item=>item.id===row.credentialID);
    if(!credential){update(row.target.id,{status:'failed',reason:'choose_credential'});continue}
    update(row.target.id,{status:'processing'});
    let check:SSHCheckResult|undefined,creating=false;
    const previousIDs=new Set((action==='install'?row.detail?.deployments:row.detail?.uninstallations)?.map(record=>record.id));
    try{
     check=await api<SSHCheckResult>(`${machineBatchPath(row.target.machine!.id)}/ssh-check`,{method:'POST',body:JSON.stringify({credential_id:credential.id})});
     update(row.target.id,{check});
     if(!check.connected||!check.ready){update(row.target.id,{status:'failed',reason:'check_failed'});continue}
     if(!isPlan){update(row.target.id,{status:'success',reason:undefined});notifySuccess(row,check);continue}
     if(stop.current||!mounted.current){update(row.target.id,{status:'pending',reason:'stopped'});continue}
     if(action==='install'&&check.agent_installation?.state!=='absent'){update(row.target.id,{status:'not_applicable',reason:'existing_remote_agent'});continue}
     if(action==='install'&&!['amd64','arm64'].includes(check.arch)){update(row.target.id,{status:'failed',reason:'invalid_arch'});continue}
     creating=true;
     const body={credential_id:credential.id,check_id:check.id,...(action==='install'?{version,arch:check.arch}:{})};
     const record=await api<BatchPlan>(`${batchPlanPath(action,row.target.machine!.id)}/plan`,{method:'POST',body:JSON.stringify(body)});
     update(row.target.id,{record,status:batchPlanStatus(record),reason:undefined});
    }catch(error){
     if(creating&&check&&!(error instanceof ApiError&&error.status<500)){
      try{const record=await recoverPlan(row,check,previousIDs);update(row.target.id,{record,status:batchPlanStatus(record),reason:undefined,note:t('已从持久化历史恢复计划，请审阅后继续。','The plan was recovered from durable history. Review it before continuing.')})}
      catch{update(row.target.id,{status:'unknown',unresolvedPlan:true,reason:t('计划创建响应未确认。请打开主机历史核对，不会自动重复创建。','Plan creation was not confirmed. Open host history to verify it. No automatic retry will occur.')})}
     }else update(row.target.id,{status:'failed',reason:errorText(error)});
    }
   }
   markStopped();if(mounted.current){setPhase(isPlan?'review':'results');setReviewed(false)}await refresh();
  }finally{finish()}
 };
 const readRecord=async(row:Row)=>api<BatchPlan>(batchPlanPath(action,row.target.machine!.id,row.record!.id));
 const applyPlans=async()=>{
  if(!reviewed||!executablePlans.length||!start())return;
  try{
   for(const original of rowsRef.current){
    if(stop.current)break;
    const row=rowsRef.current.find(item=>item.target.id===original.target.id)!;
    if(row.record?.status!=='awaiting_approval'||row.attempted)continue;
    if(batchPlanExpired(row.record)){update(row.target.id,{status:'failed',reason:'plan_expired'});continue}
    update(row.target.id,{status:'processing',attempted:true,reason:undefined});
    try{
     const response=await api<BatchPlan>(`${batchPlanPath(action,row.target.machine!.id,row.record.id)}/apply`,{method:'POST',body:JSON.stringify({confirm:true})});
     const record={...row.record,...response};update(row.target.id,{record,status:batchPlanStatus(record),reason:record.error});
     if(record.status==='succeeded')notifySuccess(row,record);
    }catch(error){
     try{const response=await readRecord(row),record={...row.record,...response};
      update(row.target.id,{record,status:record.status==='awaiting_approval'?'failed':batchPlanStatus(record),reason:record.error||errorText(error)});
      if(record.status==='succeeded')notifySuccess(row,record);
     }catch{update(row.target.id,{status:'unknown',reason:t('请求中断，且无法读取原计划状态；请打开此计划历史核对，不要重复执行。','The request was interrupted and the original plan could not be read. Check this plan in host history; do not execute it again.')})}
    }
   }
   if(mounted.current){setPhase('results');setReviewed(false)}await refresh();
  }finally{finish()}
 };
 const executeSimple=async()=>{
  if(!reviewed||!validReason||!configurable.length||!start())return;
  try{for(const row of rowsRef.current){
   if(stop.current)break;if(row.status!=='pending'||row.reason)continue;
   update(row.target.id,{status:'processing',attempted:true});
   try{const result=action==='delete_host'?await api(machineBatchPath(row.target.machine!.id),{method:'DELETE'}):await api(`/agents/${encodeURIComponent(row.target.agent!.id)}/remove`,{method:'POST',body:JSON.stringify({confirm:true,...(reason.trim()?{reason:reason.trim()}:{})})});update(row.target.id,{status:'success'});notifySuccess(row,result)}
   catch(error){update(row.target.id,{status:error instanceof ApiError&&error.status<500?'failed':'unknown',reason:errorText(error)})}
  }markStopped();if(mounted.current)setPhase('results');await refresh()}finally{finish()}
 };
 const cancelPlans=async(closeAfter=false)=>{
  if(!start())return;
  try{
   for(const row of rowsRef.current){
    if(!mounted.current||stop.current)break;if(row.record?.status!=='awaiting_approval')continue;
    update(row.target.id,{status:'processing'});
    try{const response=await api<BatchPlan>(`${batchPlanPath(action,row.target.machine!.id,row.record.id)}/cancel`,{method:'POST',body:'{}'});update(row.target.id,{record:{...row.record,...response},status:'failed',reason:t('未执行计划已取消。','The unexecuted plan was cancelled.')})}
    catch(error){try{const response=await readRecord(row),record={...row.record,...response};update(row.target.id,{record,status:record.status==='awaiting_approval'?'failed':batchPlanStatus(record),reason:record.status==='cancelled'?t('未执行计划已取消。','The unexecuted plan was cancelled.'):errorText(error)})}catch{update(row.target.id,{status:'unknown',reason:t('计划取消未确认，请在历史中核对；该计划仍保留在本窗口。','Plan cancellation was not confirmed. Verify it in history; it remains visible in this dialog.')})}}
   }
   if(mounted.current)setReviewed(false);await refresh();
   if(closeAfter&&mounted.current&&!rowsRef.current.some(row=>row.record?.status==='awaiting_approval'))onClose();
  }finally{finish()}
 };
 const close=()=>{if(pending.current)return;if(rowsRef.current.some(row=>row.record?.status==='awaiting_approval')){setNotice(t('仍有未执行计划。请先取消这些计划再关闭；取消失败的计划会保留供核对。','Unexecuted plans remain. Cancel them before closing. Failed cancellations remain visible for verification.'));return}onClose()};
 const refreshSaved=async()=>{
  if(!start())return;
  try{for(const row of rowsRef.current){if(!mounted.current||stop.current)break;
   if(row.unresolvedPlan&&!row.record&&row.check){
    try{const previousIDs=new Set((action==='install'?row.detail?.deployments:row.detail?.uninstallations)?.map(record=>record.id));const record=await recoverPlan(row,row.check,previousIDs);update(row.target.id,{record,unresolvedPlan:false,status:batchPlanStatus(record),reason:record.error,note:t('已从持久化历史恢复计划。待执行计划请审阅或取消。','The plan was recovered from durable history. Review or cancel any unexecuted plan.')})}catch(error){update(row.target.id,{status:'unknown',reason:errorText(error)})}
    continue;
   }
   if(!row.record||!['unknown','running'].includes(row.record.status)&&row.status!=='unknown')continue;
   try{const response=await readRecord(row),record={...row.record,...response};update(row.target.id,{record,status:batchPlanStatus(record),reason:record.error});if(record.status==='succeeded')notifySuccess(row,record)}catch(error){update(row.target.id,{status:'unknown',reason:errorText(error)})}
  }await refresh()}finally{finish()}
 };
 const verifyPlatformRecords=async()=>{
  if(!start())return;
  try{for(const row of rowsRef.current){
   if(!mounted.current||stop.current)break;if(row.status!=='unknown')continue;
   try{
    if(action==='remove_node'){
     const agents=await api<{id:string;lifecycle_state?:string}[]>('/agents?include_removed=true');
     const agent=agents.find(item=>item.id===row.target.agent?.id);
     if(agent?.lifecycle_state==='removed'){update(row.target.id,{status:'success',reason:undefined});notifySuccess(row,agent)}
     else update(row.target.id,{reason:t('尚未从平台记录确认移除，保留未知状态；不会重复执行。','Removal has not been confirmed in platform records. The outcome remains unknown and is not retried.')});
    }else{
     await api(machineBatchPath(row.target.machine!.id));
     update(row.target.id,{reason:t('主机记录仍存在，尚不能确认删除结果；不会重复执行。','The host record still exists. Deletion is not confirmed and is not retried.')});
    }
   }catch(error){
    if(action==='delete_host'&&error instanceof ApiError&&error.status===404){update(row.target.id,{status:'success',reason:undefined});notifySuccess(row,{deleted:true})}
    else update(row.target.id,{reason:errorText(error)});
   }
  }await refresh()}finally{finish()}
 };
 const credentialLabel=(credential:BatchCredential)=>`${credential.method==='password'?(credential.retention==='permanent'?t('永久密码','Permanent password'):credential.retention==='managed'?t('托管密码','Managed password'):credential.retention==='temporary'?t('临时密码（可复用）','Temporary password (reusable)'):t('一次性密码','One-time password')):t('SSH 私钥','SSH private key')} · ${credential.secret_fingerprint||credential.id} · ${credential.retention==='permanent'?t('永久','Permanent'):time(credential.expires_at)}`;
 const impact=({ssh_check:t('逐台执行固定只读预检。一次性密码在本次检查结束后会被消耗，不能再用于下一次操作；安装和卸载支持有效私钥或可复用密码。','Run fixed read-only preflight on each host. A one-time password is consumed after this check and cannot be reused. Installation and removal support active keys or reusable passwords.'),install:t('默认安装为宿主机独立 systemd 服务；不随业务启停，不注入业务容器。每台主机使用自己的预检架构。激活后清除临时凭据，保留按期限托管或永久凭据。','Install an independent systemd service on each host. It runs separately from the business service and is not injected into business containers. Use each host’s detected architecture. Activation clears temporary credentials and retains managed or permanent credentials.'),uninstall:t('停止并移除 Agent 服务和程序，保留配置、身份与缓存；核验后撤销节点凭据。业务服务不在此卸载范围，重装需要核查保留身份后重新接入。','Stop and remove Agent services and runtime while retaining configuration, identity, and cache. Revoke node credentials after verification. Business services are outside this removal workflow. Review retained identity and enroll again before reinstalling.'),remove_node:t('仅撤销节点 control/data 身份并归档，保留历史，不会卸载远端程序。未结束或结果未知的任务可能阻止移除，旧版共享 Key 节点须先迁移独立凭据。','Revoke control/data credentials and archive node identities while retaining history. Remote programs remain installed. Unfinished or uncertain tasks may block removal. Legacy shared-key nodes must migrate to independent credentials first.'),delete_host:t('永久删除平台中的主机记录、本主机的凭据绑定及部署/卸载历史；中央凭据库和其他主机的共享凭据不受影响，不会卸载远端 Agent 或停止业务。请先解绑本主机的有效连接凭据，并完成或取消未结束计划。','Permanently delete platform host records, their credential bindings, and installation/removal history. The central credential library and other hosts’ shared credentials are unaffected. Remote Agents and business services remain running. Unlink these hosts’ active connection credentials and resolve pending plans first.')})[action];
 const canClose=!busy&&!pendingPlans.length;
 return <Modal title={title} open width={900} onCancel={close} closable={!busy} maskClosable={false} keyboard={!busy} destroyOnHidden footer={<Space wrap>
  {busy?<Button onClick={stopRemaining} disabled={stopping}>{stopping?t('等待当前操作完成…','Waiting for the current operation…'):t('停止后续','Stop subsequent operations')}</Button>:<>
   {phase==='configure'&&action==='ssh_check'&&<Button type="primary" disabled={!credentialsReady||!configurable.length||limitExceeded} onClick={()=>void prepare()}>{t('开始批量 SSH 检查','Run batch SSH checks')}</Button>}
   {phase==='configure'&&isPlan&&<Button type="primary" disabled={!credentialsReady||!configurable.length||action==='install'&&!validVersion||limitExceeded} onClick={()=>void prepare()}>{t('检查并生成批量计划','Check and create batch plans')}</Button>}
   {phase==='configure'&&!isPlan&&action!=='ssh_check'&&<Button type="primary" danger disabled={!reviewed||!validReason||!configurable.length||limitExceeded} onClick={()=>void executeSimple()}>{action==='remove_node'?t('确认移除节点','Confirm node removal'):t('确认删除主机','Confirm host deletion')}</Button>}
   {phase!=='configure'&&isPlan&&executablePlans.length>0&&<Button type="primary" danger disabled={!reviewed} onClick={()=>void applyPlans()}>{t('确认执行已审阅计划','Execute reviewed plans')}</Button>}
   {pendingPlans.length>0&&<Button onClick={()=>void cancelPlans()}>{t('取消未执行计划','Cancel unexecuted plans')}</Button>}
   {isPlan&&hasUnknown&&<Button onClick={()=>void refreshSaved()}>{t('刷新原计划状态','Refresh original plan status')}</Button>}
   {!isPlan&&hasUnknown&&action!=='ssh_check'&&<Button onClick={()=>void verifyPlatformRecords()}>{t('只读核对平台记录','Verify platform records (read-only)')}</Button>}
   {pendingPlans.length>0?<Button onClick={()=>void cancelPlans(true)}>{t('取消未执行计划并关闭','Cancel unexecuted plans and close')}</Button>:<Button disabled={!canClose} onClick={close}>{t('关闭','Close')}</Button>}
  </>}
 </Space>}>
  <Alert showIcon type={action==='ssh_check'?'info':'warning'} title={t(`本批次固定 ${snapshot.length} 个目标，逐台执行`,`This batch has ${snapshot.length} fixed targets and runs one host at a time`)} description={<>{impact}<br/>{t('单台失败不影响后续目标，不自动重试。“停止后续”仅停止未开始的目标，当前请求会继续完成。关闭页面后请从各主机历史核对已保存计划。','One failure does not block other targets, and operations are not retried automatically. Stopping affects only targets not started; the current request continues. After leaving the page, check saved plans in each host’s history.')}</>}/>
  {notice&&<Alert role="alert" style={{marginTop:12}} type="warning" showIcon title={notice}/>}
  {phase==='configure'&&action==='install'&&<div style={{marginTop:16}}><Typography.Text>{t('Agent 版本','Agent version')}</Typography.Text><Input aria-label={t('批量 Agent 版本','Batch Agent version')} value={version} maxLength={64} disabled={busy} onChange={event=>setVersion(event.target.value)} status={validVersion?undefined:'error'}/><Typography.Text type="secondary">{t('架构由每台主机的 SSH 预检自动识别，不统一指定。','Architecture is detected separately by each host’s SSH preflight.')}</Typography.Text></div>}
  {phase==='configure'&&action==='remove_node'&&<div style={{marginTop:16}}><Input.TextArea aria-label={t('移除原因（可选）','Removal reason (optional)')} placeholder={t('移除原因（可选，最多 512 字节）','Removal reason (optional, up to 512 bytes)')} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)} status={validReason?undefined:'error'}/>{!validReason&&<Typography.Text type="danger">{t('原因超过 512 字节，请缩短。','The reason exceeds 512 bytes. Shorten it.')}</Typography.Text>}</div>}
  <div style={{marginTop:16,maxHeight:'52vh',overflowY:'auto',paddingRight:4}} aria-label={t('批量操作目标与结果','Batch targets and results')}>
   {rows.map(row=><section key={row.target.id} data-batch-target={row.target.id} data-batch-status={row.status} style={{border:'1px solid var(--lm-border-color, #d9d9d9)',borderRadius:8,padding:12,marginBottom:12,overflowWrap:'anywhere'}}>
    <Space wrap><Typography.Text strong>{row.target.name}</Typography.Text><Tag color={row.record?.status==='cancelled'?'default':row.status==='success'?'success':row.status==='failed'?'error':row.status==='unknown'?'warning':row.status==='processing'?'processing':'default'}>{statusText(row)}</Tag></Space>
    <Typography.Paragraph type="secondary" style={{marginBottom:8}}>{row.target.machine?sshEndpoint(row.target.machine.address,row.target.machine.port):t('独立节点，无 SSH 主机记录','Independent node without an SSH host record')} · {row.target.agent?t(`节点 ${row.target.agent.id}`,`Node ${row.target.agent.id}`):t('仅主机','Host only')}</Typography.Paragraph>
    {row.reason&&<Alert showIcon type={row.status==='unknown'?'warning':row.status==='failed'?'error':'info'} title={reasonText(row.reason)}/>}
    {row.note&&<Typography.Paragraph type="secondary">{row.note}</Typography.Paragraph>}
    {phase==='configure'&&!busy&&row.status==='pending'&&!row.reason&&action!=='delete_host'&&action!=='remove_node'&&<div style={{marginTop:8}}><Select aria-label={t(`SSH 凭据 · ${row.target.name}`,`SSH credential · ${row.target.name}`)} style={{width:'100%'}} value={row.credentialID} placeholder={t('请选择 SSH 凭据','Select an SSH credential')} options={credentialsFor(row).map(credential=>({value:credential.id,label:credentialLabel(credential)}))} onChange={value=>update(row.target.id,{credentialID:value})}/>{credentialsFor(row).length>1&&!row.credentialID&&<Typography.Text type="warning">{t('存在多条有效凭据，请明确选择。','Multiple active credentials exist. Select one explicitly.')}</Typography.Text>}</div>}
    {row.check&&<details style={{marginTop:8}}><summary>{t('SSH 检查结果','SSH check result')}</summary><SSHCheckSummary result={row.check}/></details>}
    {row.record&&<div style={{marginTop:8}}>
     <Descriptions size="small" column={1} items={[
      {key:'plan',label:t('计划 ID','Plan ID'),children:row.record.id},
      {key:'target',label:t('审核目标','Reviewed target'),children:row.record.plan?.machine?sshEndpoint(row.record.plan.machine.address,row.record.plan.machine.port,row.record.plan.machine.username):row.target.name},
      {key:'agent',label:t('节点身份','Node identity'),children:row.record.plan?.agent_id||row.record.plan?.machine?.agent_id||t('安装激活后生成','Created after installation activation')},
      ...(action==='install'?[{key:'version',label:t('版本 / 架构','Version / architecture'),children:`${row.record.plan?.version||version} / ${row.record.plan?.arch||row.check?.arch||''}`}]:[]),
      {key:'credential',label:t('SSH 凭据 ID','SSH credential ID'),children:row.record.plan?.credential?.id||row.credentialID},
      {key:'expires',label:t('计划有效期','Plan expires at'),children:time(row.record.plan?.expires_at)},
     ]}/>
     {!!row.record.plan?.steps?.length&&<ol style={{paddingLeft:20}}>{row.record.plan.steps.map((step,index)=><li key={index}>{stepText(step)}</li>)}</ol>}
     {!!row.record.plan?.warnings?.length&&<ul style={{paddingLeft:20}}>{row.record.plan.warnings.map((warning,index)=><li key={index}>{warningText(warning)}</li>)}</ul>}
     {!!row.record.plan?.removed_paths?.length&&<Typography.Paragraph>{t('移除：','Remove: ')}{row.record.plan.removed_paths.join(', ')}</Typography.Paragraph>}
     {!!row.record.plan?.retained_paths?.length&&<Typography.Paragraph>{t('保留：','Retain: ')}{row.record.plan.retained_paths.join(', ')}</Typography.Paragraph>}
     {row.record.status==='awaiting_approval'&&batchPlanExpired(row.record,now)&&<Alert type="warning" showIcon title={reasonText('plan_expired')}/>}
    </div>}
    {row.target.machine&&<Typography.Link href={history(row)} target="_blank" rel="noopener noreferrer">{row.record?t('打开此计划历史','Open this plan in history'):t('打开主机详情与历史','Open host details and history')}</Typography.Link>}
   </section>)}
  </div>
  {!busy&&((phase==='configure'&&!isPlan&&action!=='ssh_check')||(phase!=='configure'&&isPlan&&executablePlans.length>0))&&<Checkbox checked={reviewed} onChange={event=>setReviewed(event.target.checked)}>{t('我已逐项审阅目标、步骤和影响','I have reviewed each target, step, and impact')}</Checkbox>}
  {!credentialsReady&&phase==='configure'&&!busy&&<Typography.Paragraph type="warning">{t('请为每个可执行目标选择有效凭据。','Select an active credential for each eligible target.')}</Typography.Paragraph>}
  {hasUnknown&&<Alert style={{marginTop:12}} type="warning" showIcon title={t('未知结果需要核对，不能当作成功或直接重试','Unknown outcomes require verification; do not assume success or retry')} description={t('已显示每个相关主机的持久化历史入口。卸载结果未知时，在对应历史中使用只读核对。','Durable history links are shown for each affected host. For an uncertain uninstall outcome, use read-only verification in that history.')}/>}
 </Modal>;
}
