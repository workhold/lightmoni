import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Select,Space,Switch,Tag,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {defaultMachineCredential,reusableMachineCredential} from './machine-credentials';
import ExecutorMaintenanceDialog from './ExecutorMaintenanceDialog';
import ManagedContainerDialog from './ManagedContainerDialog';

type Capability='container.managed.v1'|'script.elevated.v1'|'operations.managed.v1';
type Effective='disabled'|'pending'|'ready'|'unavailable'|'blocked'|'disabling'|'unknown';
type CapabilityStatus={requested?:boolean;authorized:boolean;effective:Effective;reason_code?:string;observed_at?:string};
export type HostExecutionStatus={machine_id:string;policy_generation:number;executor?:{id:string;online:boolean;state?:string;last_seen?:string;install_generation?:number};capabilities:Record<Capability,CapabilityStatus>};
type Credential={id:string;name?:string;method:string;retention?:string;expires_at?:string;revoked_at?:string;secret_cleared_at?:string;is_default?:boolean;secret_fingerprint?:string};
type Host={id:string;name:string;agent_id?:string;agent_status?:string;default_credential_id?:string};
type Plan={id:string;status:string;revision:string;expires_at:string;plan?:{machine?:{id:string;name:string;agent_id:string;address:string;username:string};credential_id?:string;capabilities:Capability[];release?:{sha256:string;build_id:string;version?:string;arch?:string};steps?:string[];privilege?:{state:string};policy_generation?:number};executor_id?:string;error?:string;error_code?:string};
type PolicyPlan={id:string;revision:string;expires_at:string;machine_id:string;agent_id:string;generation:number;capabilities:Capability[];applied_at?:string};
const capabilities:Capability[]=['container.managed.v1','script.elevated.v1','operations.managed.v1'];
const hostPath=(id:string)=>`/machines/${encodeURIComponent(id)}`;
const policyRecord=(value:PolicyPlan,machine:Host):Plan=>({id:value.id,status:value.applied_at?'applied':'awaiting_approval',revision:value.revision,expires_at:value.expires_at,plan:{machine:{id:value.machine_id,name:machine.name,agent_id:value.agent_id,address:'',username:''},capabilities:value.capabilities,policy_generation:value.generation}});

/** Switches edit a proposal. Only an exact, explicitly reviewed plan changes permissions. */
export default function HostExecutionPanel({machine,credentials,admin,onChanged}:{machine:Host;credentials:Credential[];admin:boolean;onChanged?:()=>Promise<void>}){
 const {t,language}=useI18n();
 const [status,setStatus]=useState<HostExecutionStatus>(),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [desired,setDesired]=useState<Capability[]>([]),[credential,setCredential]=useState<string>(),[record,setRecord]=useState<Plan>(),[reviewed,setReviewed]=useState(false),[now,setNow]=useState(Date.now());
 const [outcomeUnknown,setOutcomeUnknown]=useState(false),[refreshNeeded,setRefreshNeeded]=useState(false),[maintenance,setMaintenance]=useState(false),[containers,setContainers]=useState(false);
 const [preparationUnknown,setPreparationUnknown]=useState(false),[recoveryCandidates,setRecoveryCandidates]=useState<Plan[]>([]);
 const [absenceReviewed,setAbsenceReviewed]=useState(false),[reconcileCredential,setReconcileCredential]=useState<string>();
 const preparationRecovery=useRef<{prior:Set<string>;capabilities:Capability[];credential:string}|undefined>(undefined);
 const generation=useRef(0),mounted=useRef(true),pending=useRef(false),applyAttempted=useRef(false),route=useRef<'bootstrap'|'policy'>('bootstrap');
 const allowed=useRef(admin);allowed.current=admin;
 const valid=(request:number)=>mounted.current&&generation.current===request&&allowed.current;
 const failure=(e:unknown)=>e instanceof Error?e.message:t('操作失败','Operation failed');
 const stateText=(value:string)=>({disabled:t('已关闭','Disabled'),pending:t('等待应用','Pending'),ready:t('已就绪','Ready'),unavailable:t('依赖不可用','Unavailable'),blocked:t('已阻塞','Blocked'),disabling:t('正在关闭，等待确认','Disabling; confirmation pending'),unknown:t('状态未知','Unknown')})[value]||t('状态未知','Unknown');
 const capabilityText=(value:Capability)=>value==='operations.managed.v1'?t('受管主机运维（整机高信任）','Managed host operations (full host trust)'):value==='container.managed.v1'?t('容器管理','Container management'):t('允许提权脚本','Allow elevated scripts');
 const stamp=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(language):t('尚无验证记录','Not verified yet');
 const keys=credentials.filter(value=>reusableMachineCredential(value));
 const load=async(reset=false,background=false)=>{
  const request=++generation.current;if(!background){setLoading(true);setError('')}
  try{
   const next=await api<HostExecutionStatus>(`${hostPath(machine.id)}/execution-status`);
   const bootstraps=reset&&['pending','bootstrap_unknown'].includes(next.executor?.state||'')?await api<Plan[]>(`${hostPath(machine.id)}/executor-bootstrap/plans`):undefined;
   if(!valid(request))return;
   if(next.machine_id!==machine.id||!next.capabilities||capabilities.some(key=>!next.capabilities[key]))throw Error(t('主机执行状态身份或格式不匹配，请刷新','Host execution status identity or format differs. Refresh the status.'));
   setStatus(next);setRefreshNeeded(false);
   if(reset)setDesired(capabilities.filter(key=>next.capabilities[key].requested??next.capabilities[key].authorized));
   if(reset&&Array.isArray(bootstraps)){const unfinished=bootstraps.filter(value=>['running','verifying','unknown'].includes(value.status)&&value.plan?.machine?.id===machine.id&&value.plan.machine.agent_id===machine.agent_id&&value.executor_id===next.executor?.id);if(unfinished.length===1){route.current='bootstrap';setRecord(unfinished[0]);setReviewed(false);applyAttempted.current=true}}
  }catch(e){if(valid(request)){setStatus(undefined);setRefreshNeeded(true);if(!background)setError(failure(e))}}finally{if(valid(request)&&!background)setLoading(false)}
 };
 useEffect(()=>{mounted.current=true;setMaintenance(false);setContainers(false);setStatus(undefined);setDesired([]);setRecord(undefined);setReviewed(false);setError('');setOutcomeUnknown(false);setPreparationUnknown(false);setRecoveryCandidates([]);preparationRecovery.current=undefined;applyAttempted.current=false;setCredential(defaultMachineCredential(credentials,machine.default_credential_id,reusableMachineCredential));if(admin)void load(true);return()=>{mounted.current=false;generation.current++}},[machine.id,admin]);
 useEffect(()=>{if(!admin)return;const timer=setInterval(()=>{if(!pending.current)void load(false,true)},15000);return()=>clearInterval(timer)},[machine.id,admin]);
 useEffect(()=>{setNow(Date.now());if(!record)return;const expires=Date.parse(record.expires_at);if(!Number.isFinite(expires)||expires<=Date.now())return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2_147_483_647,expires-Date.now()+20));return()=>clearTimeout(timer)},[record?.expires_at]);
 useEffect(()=>{if(credential&&!keys.some(key=>key.id===credential)){setCredential(undefined);if(record?.status==='awaiting_approval'&&!applyAttempted.current)setRecord(undefined);setReviewed(false)}},[credentials,credential]);
 useEffect(()=>{setAbsenceReviewed(false);if(record?.status==='unknown'&&route.current==='bootstrap')setReconcileCredential(keys.some(value=>value.id===record.plan?.credential_id)?record.plan?.credential_id:undefined)},[record?.id,record?.status]);
 useEffect(()=>{if(reconcileCredential&&!keys.some(value=>value.id===reconcileCredential)){setReconcileCredential(undefined);setAbsenceReviewed(false)}},[credentials,reconcileCredential]);
 const changed=!!status&&capabilities.some(key=>desired.includes(key)!==(status.capabilities[key].requested??status.capabilities[key].authorized));
 const bootstrap=!status?.executor?.id||status.executor.state==='revoked';
 const invalidate=()=>{generation.current++;setRecord(undefined);setReviewed(false);setError('');setOutcomeUnknown(false);setPreparationUnknown(false);setRecoveryCandidates([]);preparationRecovery.current=undefined;applyAttempted.current=false};
 const edit=(key:Capability,checked:boolean)=>{invalidate();setDesired(previous=>capabilities.filter(value=>value===key?checked:previous.includes(value)))};
 const planPath=()=>route.current==='bootstrap'?`${hostPath(machine.id)}/executor-bootstrap/plans/${encodeURIComponent(record!.id)}`:`${hostPath(machine.id)}/execution-policy/plans/${encodeURIComponent(record!.id)}`;
 const recoverPreparation=async(request:number)=>{
  const recovery=preparationRecovery.current;if(!recovery)return;
  const records=await api<Plan[]>(`${hostPath(machine.id)}/executor-bootstrap/plans`);if(!valid(request))return;
  if(!Array.isArray(records))throw Error(t('安装计划列表格式无效','Invalid installation plan list'));
  const matches=records.filter(value=>!recovery.prior.has(value.id)&&value.status==='awaiting_approval'&&value.plan?.machine?.id===machine.id&&value.plan.machine.agent_id===machine.agent_id&&value.plan.credential_id===recovery.credential&&value.plan.capabilities.length===recovery.capabilities.length&&recovery.capabilities.every(key=>value.plan!.capabilities.includes(key)));
  if(matches.length===1){setRecord(matches[0]);setPreparationUnknown(false);setError(t('创建响应失联，已找回匹配的安装计划，请审阅后再批准。','The creation response was lost. A matching installation plan was recovered; review it before approval.'))}
  else{setRecoveryCandidates(matches);setPreparationUnknown(true);setError(matches.length?t('发现多个匹配计划，请选择需要审阅的记录；不会自动批准。','Multiple matching plans were found. Choose a record to review; none is approved automatically.'):t('计划创建结果仍未知，请稍后只读查询；本窗口不会重复创建。','Plan creation is still unknown. Query read-only later; this window will not create another plan.'))}
 };
 const queryPreparation=async()=>{if(pending.current)return;pending.current=true;setBusy(true);const request=++generation.current;try{await recoverPreparation(request)}catch(e){if(valid(request))setError(failure(e))}finally{setBusy(false);pending.current=false}};
 const createPlan=async()=>{
  if(pending.current||preparationUnknown||!admin||!status||refreshNeeded||!changed||bootstrap&&!credential)return;
  pending.current=true;setBusy(true);setError('');const request=++generation.current;setRecord(undefined);setReviewed(false);applyAttempted.current=false;
  route.current=bootstrap?'bootstrap':'policy';
  let creating=false;
  try{
   if(bootstrap){const before=await api<Plan[]>(`${hostPath(machine.id)}/executor-bootstrap/plans`);if(!valid(request))return;if(!Array.isArray(before))throw Error(t('安装计划列表格式无效','Invalid installation plan list'));preparationRecovery.current={prior:new Set(before.map(value=>value.id)),capabilities:[...desired],credential:credential!}}
   const path=bootstrap?`${hostPath(machine.id)}/executor-bootstrap/plan`:`${hostPath(machine.id)}/execution-policy/plan`;
   creating=true;
   const response=await api<Plan|PolicyPlan>(path,{method:'POST',body:JSON.stringify(bootstrap?{credential_id:credential,capabilities:desired}:{capabilities:desired})});
   creating=false;
   const next=bootstrap?response as Plan:policyRecord(response as PolicyPlan,machine);
   if(!valid(request))return;
   if(next.status!=='awaiting_approval'||!next.id||!next.revision||!next.plan||next.plan.machine?.id!==machine.id||next.plan.machine?.agent_id!==machine.agent_id||!Array.isArray(next.plan.capabilities)||next.plan.capabilities.length!==desired.length||desired.some(value=>!next.plan!.capabilities.includes(value)))throw Error(t('计划与本次主机或能力选择不匹配，请重新检查','The plan does not match this host or capability selection. Check again.'));
   setRecord(next);
  }catch(e){if(valid(request)){setError(failure(e));if(creating&&bootstrap&&!(e instanceof ApiError&&e.status<500)){setPreparationUnknown(true);try{await recoverPreparation(request)}catch{/* Keep the original error and block duplicate preparation. */}}}}finally{if(valid(request))setBusy(false);pending.current=false}
 };
 const refreshRecord=async()=>{
  if(pending.current||!record)return;pending.current=true;setBusy(true);setError('');const request=++generation.current;
  try{
   const response=await api<Plan|PolicyPlan>(planPath());if(!valid(request))return;
   const next=route.current==='policy'?policyRecord(response as PolicyPlan,machine):response as Plan;
   if(next.id!==record.id||next.revision&&next.revision!==record.revision||next.plan?.machine?.id&&next.plan.machine.id!==machine.id||next.plan?.machine?.agent_id&&next.plan.machine.agent_id!==machine.agent_id)throw Error(t('返回记录与当前主机或原计划不匹配','The returned record does not match this host or original plan'));
   setRecord(previous=>({...previous!,...next}));setOutcomeUnknown(false);
   if(route.current==='policy'&&next.status==='awaiting_approval')applyAttempted.current=false;
   await load(false);
  }catch(e){if(valid(request))setError(failure(e))}finally{setBusy(false);pending.current=false}
 };
 const apply=async()=>{
  if(pending.current||applyAttempted.current||!record||!reviewed||refreshNeeded||!admin||Date.parse(record.expires_at)<=Date.now())return;
  pending.current=true;applyAttempted.current=true;setBusy(true);setError('');const request=++generation.current;
  try{
   const result=await api<Plan|HostExecutionStatus>(`${planPath()}/apply`,{method:'POST',body:JSON.stringify(route.current==='bootstrap'?{confirm:true,expected_revision:record.revision,request_id:crypto.randomUUID()}:{confirm:true,expected_revision:record.revision})});
   if(!valid(request))return;
   if(route.current==='bootstrap'){if(!('id' in result)||result.id!==record.id)throw Error(t('执行回执与当前计划不匹配','Execution receipt does not match the current plan'));setRecord(previous=>({...previous!,...result}))}
   else{if(!('machine_id' in result)||result.machine_id!==machine.id||result.policy_generation!==record.plan?.policy_generation)throw Error(t('权限回执与当前计划不匹配','Policy receipt does not match the current plan'));setRecord(previous=>({...previous!,status:'applied'}))}
   setReviewed(false);await load(false);try{await onChanged?.()}catch{setRefreshNeeded(true)}
  }catch(e){if(valid(request)){setError(failure(e));setReviewed(false);if(!(e instanceof ApiError&&e.status<500))setOutcomeUnknown(true);else setRefreshNeeded(true)}}finally{setBusy(false);pending.current=false}
 };
 const reconcileAbsent=async()=>{
  if(pending.current||record?.status!=='unknown'||route.current!=='bootstrap'||!absenceReviewed||!reconcileCredential)return;
  pending.current=true;setBusy(true);setError('');const request=++generation.current;
  try{const next=await api<Plan>(`${planPath()}/reconcile`,{method:'POST',body:JSON.stringify({confirm:true,credential_id:reconcileCredential})});if(!valid(request))return;if(next.id!==record.id||next.revision!==record.revision||next.executor_id!==record.executor_id||next.plan?.machine?.id!==machine.id||next.plan.machine.agent_id!==machine.agent_id)throw Error(t('核对记录与原安装计划不匹配','Verification record does not match the original installation plan'));setRecord(next);setAbsenceReviewed(false);setOutcomeUnknown(false);await load(false);await onChanged?.()}
  catch(e){if(valid(request)){setError(failure(e));setAbsenceReviewed(false)}}finally{setBusy(false);pending.current=false}
 };
 useEffect(()=>{if(!record||!['running','verifying'].includes(record.status))return;const timer=setInterval(()=>{if(!pending.current)void refreshRecord()},4000);return()=>clearInterval(timer)},[record?.id,record?.status]);
 if(!admin)return null;
 const expired=!record||!Number.isFinite(Date.parse(record.expires_at))||Date.parse(record.expires_at)<=now;
 const canReview=record?.status==='awaiting_approval'&&!outcomeUnknown&&!applyAttempted.current;
 return <section className="lm-machine-form-notice" aria-label={t('主机执行权限','Host execution permissions')}>
  <Space wrap><h3>{t('主机执行权限','Host execution permissions')}</h3><Button size="small" loading={loading} disabled={busy} onClick={()=>void load(!record)}>{t('刷新执行状态','Refresh execution status')}</Button></Space>
  <Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'agent',label:t('普通 Agent','Normal Agent'),children:machine.agent_id?<Tag color={machine.agent_status==='online'?'success':'default'}>{machine.agent_status==='online'?t('在线 · lightmoni-agent 账户','Online · lightmoni-agent account'):t('离线或状态未知','Offline or unknown')}</Tag>:t('尚未部署','Not installed')},{key:'executor',label:t('独立运维执行器','Independent privileged executor'),children:!status?t('状态未知，请刷新','Unknown; refresh status'):status.executor?.id?<Space><Tag color={status.executor.online?'success':'warning'}>{status.executor.online?t('在线','Online'):t('离线','Offline')}</Tag><Typography.Text code>{status.executor.id}</Typography.Text>{status.executor.state&&status.executor.state!=='active'&&<Tag>{({pending:t('等待安装或注册','Installation or enrollment pending'),bootstrap_unknown:t('安装结果未知，待核对','Installation outcome unknown; verification required'),revoked:t('身份已撤销','Identity revoked')})[status.executor.state]||status.executor.state}</Tag>}</Space>:t('尚未安装','Not installed')},{key:'observed',label:t('执行器最近验证','Executor last verified'),children:stamp(status?.executor?.last_seen)},{key:'generation',label:t('当前权限代次','Current policy generation'),children:status?.policy_generation??'—'}]}/>
  <Alert className="lm-machine-form-notice" type="warning" showIcon title={t('受管运维默认关闭。批准的应用、挂载及运维程序可能控制整台主机，请审阅资源与策略。','Managed operations are disabled by default. Approved applications, mounts and programs may control the entire host; review resources and policy.')}/>{capabilities.map(key=>{const actual=status?.capabilities[key];return <div key={key} className="lm-machine-form-notice"><Space wrap><Switch aria-label={capabilityText(key)} checked={desired.includes(key)} disabled={loading||busy||preparationUnknown||!status||!!record&&(outcomeUnknown||applyAttempted.current)} onChange={checked=>edit(key,checked)}/><Typography.Text strong>{capabilityText(key)}</Typography.Text><Tag>{actual?.authorized?t('中心已授权','Authorized by center'):t('中心未授权','Not authorized by center')}</Tag><Tag color={actual?.effective==='ready'?'success':actual?.effective==='disabled'?'default':'warning'}>{stateText(actual?.effective||'unknown')}</Tag></Space>{actual?.reason_code&&<Typography.Paragraph type="secondary">{actual.reason_code}</Typography.Paragraph>}</div>})}
  <Typography.Paragraph type="secondary">{t('开关仅修改待审阅的权限计划。容器管理与提权脚本分别授权；普通 Agent 不获得 root 或 Docker socket 权限。','Switches edit a permission proposal. Container management and elevated scripts are authorized separately; the normal Agent does not gain root or Docker socket access.')}</Typography.Paragraph>
  {bootstrap&&<><Typography.Paragraph>{t('首次启用通过已登记主机的 SSH 安装独立执行器。需要有效 root 或免交互 sudo 引导凭据。','First-time enablement installs an independent executor over this registered host’s SSH connection. An active root or non-interactive sudo credential is required.')}</Typography.Paragraph><Select aria-label={t('执行器安装 SSH 凭据','Executor installation SSH credential')} style={{width:'100%'}} value={credential} disabled={busy||preparationUnknown||outcomeUnknown||applyAttempted.current} placeholder={t('请选择有效 SSH 凭据','Select an active SSH credential')} onChange={value=>{invalidate();setCredential(value)}} options={keys.map(key=>({value:key.id,label:`${key.name||key.id}${key.secret_fingerprint?' · '+key.secret_fingerprint:''}`}))}/></>}
  {error&&<Alert className="lm-machine-form-notice" type="error" showIcon title={error}/>}
  {!record&&<Button className="lm-machine-form-notice" type="primary" disabled={preparationUnknown||!status||!changed||refreshNeeded||bootstrap&&!credential} loading={busy} onClick={()=>void createPlan()}>{bootstrap?t('检查并生成执行器安装计划','Check and create executor installation plan'):t('生成权限变更计划','Create permission change plan')}</Button>}
  {preparationUnknown&&!record&&<Space wrap className="lm-machine-form-notice"><Button loading={busy} onClick={()=>void queryPreparation()}>{t('只读查询安装计划','Query installation plans read-only')}</Button>{recoveryCandidates.map(value=><Button key={value.id} disabled={busy} onClick={()=>{setRecord(value);setPreparationUnknown(false);setReviewed(false)}}>{t('审阅计划','Review plan')} {value.id}</Button>)}</Space>}
  {status?.executor?.id&&<Button className="lm-machine-form-notice" disabled={busy||preparationUnknown||outcomeUnknown||status.executor.state==='pending'} onClick={()=>setMaintenance(true)}>{t('运维执行器维护','Privileged executor maintenance')}</Button>}
  {status?.executor?.id&&<Button className="lm-machine-form-notice" disabled={busy||preparationUnknown||outcomeUnknown} onClick={()=>setContainers(true)}>{t('受管容器操作','Managed container operations')}</Button>}
  {containers&&<ManagedContainerDialog key={machine.id} machine={machine} onClose={()=>setContainers(false)}/>}
  {maintenance&&status?.executor?.id&&<ExecutorMaintenanceDialog key={status.executor.id} machine={machine} executorID={status.executor.id} credentials={credentials} onClose={()=>{setMaintenance(false);void load(true)}} onChanged={async()=>{await load(true);await onChanged?.()}}/>}
  {record&&<div className="lm-machine-form-notice"><Descriptions size="small" column={1} items={[{key:'plan',label:t('计划 ID','Plan ID'),children:record.id},{key:'status',label:t('计划状态','Plan status'),children:({awaiting_approval:t('待审阅','Awaiting review'),running:t('正在安装','Installing'),verifying:t('等待执行器签名验证','Awaiting signed executor verification'),succeeded:t('安装完成并验证','Installed and verified'),applied:t('中心授权已更新，实际状态见上方','Center authorization updated; see effective state above'),unknown:t('执行结果未知','Execution outcome unknown'),failed:t('执行失败','Execution failed')})[record.status]||record.status},{key:'host',label:t('目标主机','Target host'),children:record.plan?.machine?`${record.plan.machine.name} · ${record.plan.machine.id}`:machine.name},{key:'capabilities',label:t('批准后开启的能力','Capabilities enabled after approval'),children:record.plan?.capabilities.length?record.plan.capabilities.map(capabilityText).join('、'):t('全部关闭','All disabled')},{key:'sha',label:t('发行包 SHA256','Release SHA256'),children:record.plan?.release?.sha256?<Typography.Text code copyable>{record.plan.release.sha256}</Typography.Text>:'—'},{key:'build',label:t('构建 ID','Build ID'),children:record.plan?.release?.build_id||'—'},{key:'privilege',label:t('SSH 引导权限','SSH bootstrap privilege'),children:record.plan?.privilege?.state?({root:t('root（实际 UID 为 0）','root (actual UID 0)'),sudo_noninteractive:t('免交互 sudo','Non-interactive sudo')})[record.plan.privilege.state]||t('权限未确认','Privilege unverified'):t('沿用已有可信执行器','Use the existing trusted executor')},{key:'expires',label:t('计划有效至','Plan expires at'),children:stamp(record.expires_at)}]}/>{!!record.plan?.steps?.length&&<ol>{record.plan.steps.map((step,index)=><li key={index}>{step}</li>)}</ol>}
   {record.error&&<Alert className="lm-machine-form-notice" type="warning" showIcon title={record.error}/>}
   {route.current==='bootstrap'&&record.status==='unknown'&&<div className="lm-machine-form-notice"><Alert type="info" showIcon title={t('只读确认远端未安装，结束原安装','Confirm remote absence read-only and end the original installation')} description={t('通过当前有效 SSH 凭据获取原安装互斥锁，检查执行器目录、程序与服务均不存在。发现残留或安装仍在运行时保持未知，不安装、不删除。确认未安装后仅结束原记录并撤销其执行器身份，可另行生成新计划。','Using an active SSH credential, acquire the original installation lock and verify all executor directories, programs, and service are absent. Residual files or an active installation keep the outcome unknown; nothing is installed or deleted. Verified absence ends only this record and revokes its executor identity, allowing a new plan.')}/><Select className="lm-machine-form-notice" aria-label={t('安装结果核对 SSH 凭据','Installation verification SSH credential')} style={{width:'100%'}} value={reconcileCredential} disabled={busy} options={keys.map(value=>({value:value.id,label:value.name||value.id}))} onChange={value=>{setReconcileCredential(value);setAbsenceReviewed(false)}} placeholder={t('选择有效凭据，仅用于只读核对','Select an active credential for read-only verification')}/><Checkbox checked={absenceReviewed} disabled={busy||!reconcileCredential} onChange={event=>setAbsenceReviewed(event.target.checked)}>{t('确认只读核对：仅远端未安装时结束此记录并撤销原身份','Confirm read-only verification: end this record and revoke its identity only if remote absence is verified')}</Checkbox><Button className="lm-machine-form-notice" disabled={!absenceReviewed||!reconcileCredential} loading={busy} onClick={()=>void reconcileAbsent()}>{t('只读核对并结束未安装记录','Verify absence and end uninstalled record')}</Button></div>}
   {outcomeUnknown&&<Alert type="warning" showIcon title={t('提交结果未知，请回读原计划','Submission outcome unknown; read back the original plan')} description={t('请求可能已执行。本窗口禁止再次提交，不会重新安装或自动重放。','The request may have run. This window blocks resubmission and will not reinstall or automatically replay it.')}/>}
   {canReview&&<><Checkbox checked={reviewed} disabled={busy||expired||refreshNeeded} onChange={event=>setReviewed(event.target.checked)}>{t('我已审阅此主机、发行包和精确权限变更','I reviewed this host, release, and exact permission changes')}</Checkbox><Space wrap className="lm-machine-form-notice"><Button danger type="primary" disabled={!reviewed||expired||refreshNeeded} loading={busy} onClick={()=>void apply()}>{t('确认执行此权限计划','Apply this permission plan')}</Button><Button disabled={busy} onClick={()=>{invalidate()}}>{t('返回修改并重新生成计划','Edit and create a new plan')}</Button></Space>{expired&&<Alert type="warning" title={t('计划已过期，请重新检查','Plan expired; check again')}/>}</>}
   {!canReview&&<Space className="lm-machine-form-notice" wrap><Button loading={busy} onClick={()=>void refreshRecord()}>{route.current==='policy'?t('刷新中心授权与执行状态','Refresh center authorization and execution status'):t('回读原计划与执行状态','Read back original plan and execution status')}</Button>{['applied','succeeded','failed'].includes(record.status)&&<Button disabled={busy} onClick={()=>{invalidate();void load(true)}}>{t('准备新的权限变更','Prepare another permission change')}</Button>}</Space>}
  </div>}
 </section>;
}
