import SSHAccountsDialog from './SSHAccountsDialog';
import InstallationAccountRecovery,{installationRecovery,missingInstallationAccount,type InstallationRecovery} from './InstallationAccountRecovery';
import {type SSHAccount} from './machine-credentials';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Modal,Select,Space,Table,Tag,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {sshEndpoint} from './host-request-guard';
import {useI18n} from '../shared/i18n';
import {defaultMachineCredential,reusableMachineCredential} from './machine-credentials';
import {agentOperationReadSignal} from './agent-operation-progress';
import {installedRelease,releaseIdentity,shortIdentity,updateIsActive,updateMessageText,updatePath,updatePlanExpired,updateStatusColor,updateStatusText,type AgentRelease,type AgentUpdate,type AgentUpdateCredential} from './agent-update-model';

type Machine={id:string;name:string;arch?:string;agent_id?:string;default_account_id?:string;accounts?:SSHAccount[]};
type Props={machine:Machine;credentials:AgentUpdateCredential[];existing?:AgentUpdate;initialAction?:'upgrade'|'rollback';onClose:()=>void;onRefresh:()=>Promise<void>};

async function readUpdate<T>(path:string,parent:AbortSignal):Promise<T>{
 const request=agentOperationReadSignal(parent);
 try{return await api<T>(path,{signal:request.signal})}
 catch(error){if(request.signal.aborted&&!parent.aborted)throw Error('agent_update_read_timeout');throw error}
 finally{request.dispose()}
}

export function AgentUpdatePlanSummary({record}:{record:AgentUpdate}){
 const {t,language}=useI18n(),plan=record.plan,current=installedRelease(plan?.current);
 if(!plan)return null;
 const stepText=(value:string)=>({
  '核对主机、Agent 身份与当前程序指纹':t('核对主机、Agent 身份与当前程序指纹','Verify the host, Agent identity, and current runtime fingerprint'),
  '下载并校验审批固定的维护器和发行包':t('下载并校验审批固定的维护器和发行包','Download and verify the maintainer and release pinned by this plan'),
  '通过独立 systemd 维护器切换程序':t('通过独立 systemd 维护器切换程序','Switch runtime through an independent systemd maintainer'),
  '保留已审批的运行账户、权限代次和内部执行身份':t('保留已审批的运行账户、权限代次和内部执行身份','Retain the approved runtime account, permission generation, and internal execution identity'),
  '通过独立 systemd 维护器切换同一 Agent 程序':t('通过独立 systemd 维护器切换同一 Agent 程序','Switch the same Agent runtime through an independent systemd maintainer'),
  '确认目标构建的新进程已同步平台配置':t('确认目标构建的新进程已同步平台配置','Confirm the target build runs in a new process and has applied platform configuration'),
  '确认成功；启动或健康失败则恢复原程序':t('确认成功；维护进程正常运行时，启动或健康失败会尝试恢复原程序','Confirm success; while the maintenance process is running, startup or health failures trigger an attempt to restore the previous runtime'),
  '维护期间暂停该主机的新任务派发和领取。':t('维护期间暂停该主机的新任务派发和领取。','Pause new task dispatch and claims on this host during maintenance.'),
  '保留主机 ID、Agent 身份、配置、队列和游标；不会重新接入。':t('保留主机 ID、Agent 身份、配置、队列和游标；不会重新接入。','Retain the host ID, Agent identity, configuration, queue, and cursors without enrolling again.'),
  '结果未知时只读核对；远端确认期限到达后自动回退，不自动重试。':t('结果未知时先只读核对；维护进程正常运行时会在确认超时后尝试回退，进程中断需审阅恢复，不自动重试。','Verify uncertain outcomes read-only first. A running maintainer attempts rollback after confirmation times out; an interrupted process requires reviewed recovery. Maintenance is not retried automatically.'),
  '结果未知时先只读核对；维护进程中断后可审阅恢复，不自动重试。':t('结果未知时先只读核对；维护进程中断后可审阅恢复，不自动重试。','Verify uncertain outcomes read-only first; review recovery after a maintenance process is interrupted. Maintenance is not retried automatically.'),
  '确认成功；失败时仅恢复已验证的同账户程序':t('确认成功；维护进程正常运行时，失败会尝试恢复已验证的同账户程序','Confirm success; while the maintainer is running, failures trigger an attempt to restore the verified runtime under the same account'),
  '升级不会提升运行权限；账户切换需要独立审阅。':t('升级不会提升运行权限；账户切换需要独立审阅。','Upgrades do not increase runtime privileges. Account changes require a separate review.'),
  '结果未知时只读核对；确认超时仅回退到已验证的同账户程序，不自动重试。':t('结果未知时先只读核对；正常运行的维护进程会在确认超时后尝试恢复已验证的同账户程序，进程中断需审阅恢复，不自动重试。','Verify uncertain outcomes read-only first. A running maintainer attempts to restore the verified runtime under the same account after confirmation times out. An interrupted process requires reviewed recovery; maintenance is not retried automatically.'),
 }[value]||value);
 const identity=(value?:string)=>value?<Typography.Text code copyable={{text:value}} className="lm-machine-path">{value}</Typography.Text>:'—';
 return <>
  <Descriptions size="small" column={{xs:1,sm:2}} items={[
   {key:'action',label:t('操作','Action'),span:2,children:record.action==='rollback'?t('回退到保留的上一发行','Roll back to the retained previous release'):t('升级到指定发行','Upgrade to a selected release')},
   {key:'host',label:t('目标主机','Target host'),span:2,children:`${plan.machine.name} · ${sshEndpoint(plan.machine.address,plan.machine.port,plan.ssh_account.username)}`},
   {key:'agent',label:t('Agent 身份','Agent identity'),span:2,children:identity(record.agent_id||plan.current?.agent_id)},
   {key:'current',label:t('当前发行','Current release'),children:`${current?.version||t('未知','Unknown')} · ${shortIdentity(current?.source_revision)}`},
   {key:'target',label:t('目标发行','Target release'),children:`${plan.target?.version||'—'} · ${shortIdentity(plan.target?.source_revision)} · ${plan.target?.arch||'—'}`},
   {key:'current-build',label:t('当前构建','Current build'),children:current?.build_id||'—'},
   {key:'target-build',label:t('目标构建','Target build'),children:plan.target?.build_id||'—'},
   {key:'current-sha',label:t('当前包 SHA256','Current artifact SHA256'),span:2,children:identity(releaseIdentity(current))},
   {key:'target-sha',label:t('目标包 SHA256','Target artifact SHA256'),span:2,children:identity(releaseIdentity(plan.target))},
   {key:'fingerprint',label:t('已核对的安装指纹','Verified installation fingerprint'),span:2,children:identity(plan.current?.fingerprint)},
   {key:'credential',label:t('SSH 凭据 ID','SSH credential ID'),children:plan.credential?.id||'—'},
   {key:'expiry',label:t('计划有效期','Plan expires at'),children:new Date(plan.expires_at).toLocaleString(language)},
  ]}/>
  {!!plan.steps?.length&&<ol className="lm-machine-uninstall-steps">{plan.steps.map((step,index)=><li key={index}>{stepText(step)}</li>)}</ol>}
  {!!plan.warnings?.length&&<Alert showIcon type="info" className="lm-machine-form-notice" title={t('执行影响','Execution impact')} description={<ul className="lm-machine-uninstall-steps">{plan.warnings.map((warning,index)=><li key={index}>{stepText(warning)}</li>)}</ul>}/>}
 </>;
}

export function AgentUpdateHistory({machineID,onOpen}:{machineID:string;onOpen:(record:AgentUpdate)=>void}){
 const {t,language}=useI18n(),[records,setRecords]=useState<AgentUpdate[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const request=useRef(0),controller=useRef<AbortController|undefined>(undefined);
 const load=async()=>{controller.current?.abort();const current=new AbortController();controller.current=current;const generation=++request.current;setLoading(true);try{const next=await readUpdate<AgentUpdate[]>(updatePath(machineID),current.signal);if(next.some(record=>record.machine_id!==machineID))throw Error(t('更新历史与目标主机不匹配，请刷新','The update history does not match this host. Refresh it.'));if(generation===request.current){setRecords(next);setError('')}}catch(e){if(generation===request.current&&!current.signal.aborted)setError(e instanceof Error?updateMessageText(e.message,t):t('读取失败','Could not load records'))}finally{if(generation===request.current)setLoading(false)}};
 useEffect(()=>{setRecords([]);void load();return()=>{request.current++;controller.current?.abort()}},[machineID]);
 return <div className="lm-machine-form-notice"><Space wrap><h3>{t('Agent 更新历史','Agent update history')}</h3><Button size="small" loading={loading} onClick={()=>void load()}>{t('刷新记录','Refresh records')}</Button></Space>{error&&<Alert showIcon type="error" title={error}/>}<Table<AgentUpdate> size="small" rowKey="id" dataSource={records} loading={loading} scroll={{x:700}} pagination={{pageSize:5}} columns={[
  {title:t('操作','Action'),dataIndex:'action',render:(value:string)=>value==='rollback'?t('回退','Rollback'):t('升级','Upgrade')},
  {title:t('状态','Status'),dataIndex:'status',render:(value:string)=><Tag color={updateStatusColor(value)}>{updateStatusText(value,t)}</Tag>},
  {title:t('目标发行','Target release'),render:(_,record)=>`${record.plan?.target?.version||'—'} · ${shortIdentity(record.plan?.target?.source_revision)}`},
  {title:t('创建时间','Created at'),dataIndex:'created_at',render:(value:string)=>new Date(value).toLocaleString(language)},
  {title:t('操作','Actions'),render:(_,record)=><Button size="small" onClick={()=>onOpen(record)}>{record.status==='unknown'?t('核对结果','Verify outcome'):record.status==='awaiting_approval'?t('审阅计划','Review plan'):t('查看记录','View record')}</Button>},
 ]}/></div>;
}

export default function MachineAgentUpdateDialog({machine,credentials,existing,initialAction='upgrade',onClose,onRefresh}:Props){
 const {t,language}=useI18n(),[record,setRecord]=useState(existing),[action,setAction]=useState<'upgrade'|'rollback'>(existing?.action??initialAction);
 const [releases,setReleases]=useState<AgentRelease[]>([]),[target,setTarget]=useState<string>(),[credential,setCredential]=useState<string|undefined>(()=>defaultMachineCredential(credentials,machine,reusableMachineCredential));
 const [busy,setBusy]=useState(''),[refreshing,setRefreshing]=useState(false),[catalogBusy,setCatalogBusy]=useState(false),[catalogAttempt,setCatalogAttempt]=useState(0),[error,setError]=useState(''),[reviewed,setReviewed]=useState(false),[refreshNeeded,setRefreshNeeded]=useState(false),[planUncertain,setPlanUncertain]=useState(false),[recoveryUncertain,setRecoveryUncertain]=useState(false),[recoveryReview,setRecoveryReview]=useState(''),[accountRecovery,setAccountRecovery]=useState<InstallationRecovery>(),[now,setNow]=useState(Date.now());
 const pending=useRef(false),reading=useRef(false),mounted=useRef(true),recordRef=useRef(record),request=useRef(0),lifetime=useRef(new AbortController()),appliedID=useRef('');
 recordRef.current=record;
 const [accountEditor,setAccountEditor]=useState<'add'|'manage'>();
 const keys=credentials.filter(c=>reusableMachineCredential(c,now)),credentialReady=!!credential&&keys.some(key=>key.id===credential);
 const options=releases.filter(release=>!machine.arch||release.arch===machine.arch);
 const err=(value:unknown)=>value instanceof Error?updateMessageText(value.message,t):t('操作失败','Operation failed');
 // Parent projections refresh independently; a stuck parent GET must not trap this dialog.
 const refreshParent=()=>{void onRefresh().catch(e=>{if(mounted.current)setError(previous=>[previous,t('主机列表刷新失败，已保留本窗口记录：','The host list could not refresh; this dialog retains its record: ')+err(e)].filter(Boolean).join(' '))})};
 const currentPlanExpired=updatePlanExpired(record,now);
 const recoveryKey=record?.status==='unknown'&&record.recovery_revision&&credentialReady?`${record.id}:${record.recovery_revision}:${credential}`:'';
 const recoveryReviewed=!!recoveryKey&&recoveryReview===recoveryKey;
 const recoveryNeedsVerification=recoveryUncertain||record?.recovery_requires_verification===true;
 useEffect(()=>{mounted.current=true;if(lifetime.current.signal.aborted)lifetime.current=new AbortController();return()=>{mounted.current=false;request.current++;lifetime.current.abort()}},[]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 useEffect(()=>{setCredential(previous=>credentials.some(key=>key.id===previous&&reusableMachineCredential(key,now))?previous:undefined)},[credentials,machine,now]);
 useEffect(()=>{
  if(record)return;const controller=new AbortController();let alive=true;setCatalogBusy(true);
  readUpdate<{releases:AgentRelease[]}>('/agent-releases',controller.signal).then(result=>{if(alive){setReleases(result.releases);setError('')}}).catch(e=>{if(alive&&!controller.signal.aborted)setError(err(e))}).finally(()=>{if(alive)setCatalogBusy(false)});
  return()=>{alive=false;controller.abort()};
 },[machine.id,record?.id,catalogAttempt]);
 const exact=(next:AgentUpdate,id?:string)=>{if(!next?.id||next.machine_id!==machine.id||id&&next.id!==id||next.plan?.machine?.id&&next.plan.machine.id!==machine.id)throw Error(t('更新记录与目标主机或原事务不匹配，请刷新后重试','The update record does not match this host or original transaction. Refresh and retry.'));return next};
 const refreshRecord=async(signal=lifetime.current.signal)=>{
  const saved=recordRef.current;if(!saved)return;const generation=++request.current;
  const next=exact(await readUpdate<AgentUpdate>(updatePath(machine.id,saved.id),signal),saved.id);
  if(mounted.current&&!signal.aborted&&generation===request.current&&recordRef.current?.id===saved.id){recordRef.current=next;setRecord(next);setRefreshNeeded(false);return next}
 };
 useEffect(()=>{
  if(!record||!updateIsActive(record.status))return;
  const controller=new AbortController();let disposed=false,inFlight=false;
  const poll=async()=>{if(disposed||inFlight||pending.current||reading.current)return;inFlight=true;const generation=request.current+1;try{const next=await refreshRecord(controller.signal);if(next&&!updateIsActive(next.status))refreshParent()}catch{if(!disposed&&mounted.current&&generation===request.current)setRefreshNeeded(true)}finally{inFlight=false}};
  const timer=setInterval(()=>void poll(),4000);return()=>{disposed=true;clearInterval(timer);controller.abort()};
 },[record?.id,record?.status]);
 const begin=(operation:string)=>{if(pending.current||reading.current)return false;pending.current=true;request.current++;setBusy(operation);setError('');return true};
 const finish=()=>{pending.current=false;if(mounted.current)setBusy('')};
 const rejectMissingCredential=()=>{if(credential&&credentials.some(key=>key.id===credential&&reusableMachineCredential(key)))return false;setCredential(undefined);setError(t('请选择有效 SSH 凭据；到期后可添加新凭据并重新检查权限。','Select an active SSH credential. If it expired, add a new credential and check privileges again.'));return true};
 const plan=async()=>{
  if(rejectMissingCredential()||action==='upgrade'&&!target||planUncertain||!begin('plan'))return;
  try{const next=exact(await api<AgentUpdate>(`${updatePath(machine.id)}/plan`,{method:'POST',body:JSON.stringify({action,credential_id:credential,...(action==='upgrade'?{target_sha256:target}:{})})}));if(mounted.current){recordRef.current=next;setRecord(next);setReviewed(false);setAccountRecovery(undefined)}refreshParent()}
  catch(e){if(mounted.current){setError(err(e));if(e instanceof ApiError)setAccountRecovery(installationRecovery(e.details.installation_recovery,machine.id));if(!(e instanceof ApiError&&e.status<500))setPlanUncertain(true)}}finally{finish()}
 };
 const mutate=async(operation:'apply'|'cancel'|'reconcile'|'recover')=>{
  const saved=recordRef.current;
  if(!saved||saved.rollout_id&&(operation==='apply'||operation==='cancel')||operation==='apply'&&(!reviewed||currentPlanExpired||refreshNeeded||appliedID.current===saved.id)||operation==='recover'&&(!recoveryReviewed||!saved.recovery_revision||refreshNeeded||recoveryNeedsVerification))return;
  if((operation==='reconcile'||operation==='recover')&&(saved.status!=='unknown'||rejectMissingCredential()))return;
  if(!begin(operation))return;
  if(operation==='apply')appliedID.current=saved.id;
  if(operation==='recover')setRecoveryReview('');
  const body=operation==='apply'?{confirm:true}:operation==='recover'?{confirm:true,expected_revision:saved.recovery_revision,credential_id:credential}:operation==='reconcile'?{credential_id:credential}:{};
  try{
   const next=exact(await api<AgentUpdate>(`${updatePath(machine.id,saved.id)}/${operation}`,{method:'POST',body:JSON.stringify(body)}),saved.id);
   if(mounted.current){recordRef.current=next;setRecord(next);setReviewed(false);setRefreshNeeded(false);setAccountRecovery(undefined);if(operation==='reconcile')setRecoveryUncertain(false);if(operation==='recover')setRecoveryUncertain(next.status==='unknown')}
  }catch(e){if(mounted.current){setError(err(e));setRefreshNeeded(true);if(e instanceof ApiError)setAccountRecovery(installationRecovery(e.details.installation_recovery,machine.id));if(operation==='recover'&&!(e instanceof ApiError&&e.status<500))setRecoveryUncertain(true)}}
  finally{finish();refreshParent()}
 };
 const refresh=async()=>{
  if(pending.current||reading.current)return;reading.current=true;setRefreshing(true);setError('');const generation=request.current+1;
  try{await refreshRecord();refreshParent()}catch(e){if(mounted.current&&generation===request.current){setRefreshNeeded(true);setError(err(e))}}finally{reading.current=false;if(mounted.current)setRefreshing(false)}
 };
 const changing=!!busy||refreshing;
 const credentialSelect=<Select aria-label={t('更新 SSH 凭据','Update SSH credential')} value={credential} style={{width:'100%'}} placeholder={t('请选择有效 SSH 凭据','Select an active SSH credential')} disabled={changing} options={keys.map(key=>({value:key.id,label:`${key.username} · ${key.name||(key.method==='password'?t('密码','Password'):t('SSH 私钥','SSH private key'))} · ${key.secret_fingerprint||key.id} · ${key.retention==='permanent'?t('永久','Permanent'):new Date(key.expires_at).toLocaleString(language)}`}))} onChange={id=>{setCredential(id);setRecoveryReview('');setAccountRecovery(undefined)}}/>;
 const accountHelp=!keys.length||accountRecovery?<InstallationAccountRecovery recovery={accountRecovery||missingInstallationAccount(credentials)} busy={changing||planUncertain} onAddAccount={()=>setAccountEditor('add')} onManageAccounts={()=>setAccountEditor('manage')}/>:<Button className="lm-machine-form-notice" disabled={changing||planUncertain} onClick={()=>setAccountEditor('manage')}>{t('管理账号与凭据','Manage accounts and credentials')}</Button>;
 return <><Modal open className="lm-agent-update-dialog" style={{top:24}} styles={{body:{maxHeight:'calc(100dvh - 220px)',overflowY:'auto',paddingRight:8}}} title={t(`Agent 版本管理 · ${machine.name}`,`Agent releases · ${machine.name}`)} width={840} onCancel={()=>{if(!busy)onClose()}} closable={!busy} maskClosable={false} destroyOnHidden footer={<Space wrap>
  {!record&&<Button type="primary" loading={busy==='plan'} disabled={changing||!credentialReady||action==='upgrade'&&!target||catalogBusy||planUncertain} onClick={()=>void plan()}>{t('检查并生成计划','Check and create plan')}</Button>}
  {record?.status==='awaiting_approval'&&!record.rollout_id&&<><Button aria-label={t('执行已审阅计划','Execute reviewed plan')} danger type="primary" loading={busy==='apply'} disabled={changing||!reviewed||currentPlanExpired||refreshNeeded||appliedID.current===record.id} onClick={()=>void mutate('apply')}>{t('执行已审阅计划','Execute reviewed plan')}</Button><Button disabled={changing} onClick={()=>void mutate('cancel')}>{t('取消计划','Cancel plan')}</Button></>}
  {record?.status==='unknown'&&<><Button type="primary" loading={busy==='reconcile'} disabled={changing||!credentialReady} onClick={()=>void mutate('reconcile')}>{t('只读核对结果','Verify outcome (read-only)')}</Button><Button danger loading={busy==='recover'} disabled={changing||!credentialReady||!recoveryReviewed||refreshNeeded||recoveryNeedsVerification} onClick={()=>void mutate('recover')}>{t('恢复中断维护','Recover interrupted maintenance')}</Button></>}
  {record&&<Button loading={refreshing} disabled={changing} onClick={()=>void refresh()}>{t('刷新状态','Refresh status')}</Button>}
  <Button disabled={!!busy} onClick={onClose}>{t('关闭','Close')}</Button>
 </Space>}>
  {error&&<Alert role="alert" type="error" showIcon title={error} className="lm-machine-form-notice"/>}
  {!record&&<>
   <p>{t('通过 SSH 执行固定维护步骤，保留 Agent 身份、配置和缓存。目标包使用 SHA256 固定。维护进程正常运行时，健康确认超时会尝试回退；若进程中断，请先只读核对，再审阅恢复。','Run fixed maintenance over SSH while retaining the Agent identity, configuration, and cache. The target artifact is pinned by SHA256. A running maintainer attempts rollback if health confirmation times out. If it is interrupted, verify the outcome read-only before reviewing recovery.')}</p>
   <Space wrap className="lm-machine-form-notice"><Typography.Text>{t('更新方式','Action')}</Typography.Text><Select aria-label={t('Agent 更新方式','Agent update action')} value={action} disabled={changing} onChange={value=>{setAction(value);setReviewed(false)}} options={[{value:'upgrade',label:t('升级到指定发行','Upgrade to a selected release')},{value:'rollback',label:t('回退到保留的上一发行','Roll back to the retained previous release')}]}/></Space>
   {action==='upgrade'&&<div className="lm-machine-form-notice"><Typography.Paragraph>{t('目标发行（版本 · 提交 · 架构 · 包摘要）','Target release (version · revision · architecture · artifact digest)')}</Typography.Paragraph><Select aria-label={t('目标 Agent 发行','Target Agent release')} value={target} loading={catalogBusy} disabled={changing} onChange={setTarget} style={{width:'100%'}} placeholder={t('选择固定发行包','Select a fixed release artifact')} options={options.map(release=>({value:release.sha256,label:`${release.version} · ${shortIdentity(release.source_revision)} · ${release.arch} · ${shortIdentity(release.sha256)}`}))}/>{!catalogBusy&&!options.length&&<Typography.Text type="secondary">{t('没有匹配架构的发行包。请先在平台发布可用 Agent 包。','No release matches this architecture. Publish an Agent artifact on the platform first.')}</Typography.Text>}<Button size="small" className="lm-machine-form-notice" disabled={changing||catalogBusy} onClick={()=>setCatalogAttempt(value=>value+1)}>{t('重新读取发行','Reload releases')}</Button></div>}
   {action==='rollback'&&<Alert type="info" showIcon title={t('先核对上一发行，再审阅回退','Verify the previous release before reviewing rollback')} description={t('检查从主机读取保留的上一发行并固定其指纹。回退不会重新接入或更换 Agent 身份。','The check reads the retained previous release on the host and pins its fingerprint. Rollback keeps the existing Agent identity.')}/>}
   <Typography.Paragraph style={{marginTop:16}}>{t('可复用 SSH 凭据','Reusable SSH credential')}</Typography.Paragraph>{credentialSelect}{accountHelp}
   {planUncertain&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('计划创建结果未确认','Plan creation was not confirmed')} description={t('请关闭窗口并从主机的更新历史核对已保存计划；不要重复创建。','Close this dialog and check saved plans in the host update history before creating another plan.')}/>}
  </>}
  {record&&<>
   <Alert className="lm-machine-form-notice" showIcon type={record.status==='succeeded'?'success':record.status==='failed'?'error':record.status==='unknown'||record.status==='rolled_back'?'warning':'info'} title={updateStatusText(record.status,t)} description={(record.error?updateMessageText(record.error,t):undefined)||(record.status==='unknown'?t('维护结果待核对；进程已停止时可审阅恢复。只读核对不会执行恢复，也不会重新派发更新。','The maintenance outcome needs verification. Review recovery once its process has stopped. Read-only verification neither performs recovery nor dispatches another update.'):record.status==='rolled_back'?t('已保留原身份并恢复原程序。请查看本次记录后再生成新计划。','The previous runtime was restored with its identity retained. Review this record before creating another plan.'):undefined)}/>
   <AgentUpdatePlanSummary record={record}/>
   {record.rollout_id&&<Alert className="lm-machine-form-notice" showIcon type="info" title={t('此操作属于升级批次','This operation belongs to an upgrade rollout')} description={<Typography.Link href={`/machines?agent_rollout=${encodeURIComponent(record.rollout_id)}`}>{t('打开批次审阅和控制后续主机','Open the rollout to review and control subsequent hosts')}</Typography.Link>}/>}
   <Typography.Paragraph type="secondary">{t('操作 ID：','Operation ID: ')}<Typography.Text code copyable>{record.id}</Typography.Text></Typography.Paragraph>
   {record.status==='awaiting_approval'&&!record.rollout_id&&<>{currentPlanExpired&&<Alert className="lm-machine-form-notice" type="warning" showIcon title={t('计划已过期，请取消后重新检查','This plan expired. Cancel it and run a new check')}/>}<Checkbox checked={reviewed} disabled={changing||currentPlanExpired} onChange={event=>setReviewed(event.target.checked)}>{t('我已审阅主机、当前/目标发行、步骤和影响','I have reviewed the host, current/target releases, steps, and impact')}</Checkbox>{appliedID.current===record.id&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('已提交执行请求，请只读核对原记录，不会重复提交。','An execution request was sent. Read the original record; it will not be submitted again.')}/>}</>}
   {record.status==='unknown'&&<div className="lm-machine-form-notice">
    <Typography.Paragraph>{t('核对与恢复使用的 SSH 凭据','SSH credential for verification and recovery')}</Typography.Paragraph>{credentialSelect}{accountHelp}
    <Alert className="lm-machine-form-notice" type="warning" showIcon title={t('恢复影响','Recovery impact')} description={t('恢复会先验证原事务并确认维护进程已经停止。原程序尚未切换时，以失败结束本次维护；已经切换时，只恢复本次审批固定的原程序快照。进程仍在运行、指纹或快照无法核实时拒绝恢复并保留未知状态。恢复不会重放更新或重新接入 Agent。','Recovery verifies the original transaction and confirms that its maintenance process has stopped. If the runtime was not switched, it ends this maintenance as failed. If it was switched, it restores only the previous runtime snapshot pinned by this approval. Running processes or unverifiable fingerprints or snapshots cause recovery to be refused and the outcome to remain unknown. Recovery never replays the update or enrolls Agent again.')}/>
    {!record.recovery_revision&&<Alert type="info" showIcon className="lm-machine-form-notice" title={t('请刷新原记录获取当前恢复条件','Refresh the original record to obtain current recovery conditions')}/>}
    <Checkbox checked={recoveryReviewed} disabled={changing||!recoveryKey||refreshNeeded||recoveryNeedsVerification} onChange={event=>setRecoveryReview(event.target.checked?recoveryKey:'')}>{t('我已核对目标主机、原/目标发行及恢复影响，确认恢复此中断维护','I have checked the host, original/target releases, and recovery impact, and approve recovery of this interrupted maintenance')}</Checkbox>
    {recoveryNeedsVerification&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('恢复响应未确认，请先只读核对结果','Recovery response was not confirmed. Verify the outcome read-only first')} description={t('远端可能已处理，不能重复提交恢复。刷新平台记录不会重新开放恢复；请使用“只读核对结果”核验原事务。','The host may already have handled recovery; do not submit it again. Refreshing platform records does not re-enable recovery. Use Verify outcome (read-only) to verify the original transaction.')}/>}
   </div>}
   {refreshNeeded&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('最后状态已保留，请重新读取原记录或关闭窗口。','The last state is retained. Read the original record again or close this dialog.')}/>}
  </>}
 </Modal>{accountEditor&&<SSHAccountsDialog machineID={machine.id} initialAction={accountEditor} onClose={()=>setAccountEditor(undefined)} onChanged={async()=>refreshParent()} onVerified={result=>{refreshParent();setCredential(result.credential_id);setRecoveryReview('');setAccountRecovery(undefined);setAccountEditor(undefined);setError('')}}/>}</>;
}
