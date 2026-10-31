import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Modal,Select,Space,Table,Tag,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {sshEndpoint} from './host-request-guard';
import {useI18n} from '../shared/i18n';
import {defaultMachineCredential,reusableMachineCredential} from './machine-credentials';
import {installedRelease,releaseIdentity,shortIdentity,updateIsActive,updateMessageText,updatePath,updatePlanExpired,updateStatusColor,updateStatusText,type AgentRelease,type AgentUpdate,type AgentUpdateCredential} from './agent-update-model';

type Machine={id:string;name:string;arch?:string;agent_id?:string;default_credential_id?:string};
type Props={machine:Machine;credentials:AgentUpdateCredential[];existing?:AgentUpdate;initialAction?:'upgrade'|'rollback';onClose:()=>void;onRefresh:()=>Promise<void>};

export function AgentUpdatePlanSummary({record}:{record:AgentUpdate}){
 const {t,language}=useI18n(),plan=record.plan,current=installedRelease(plan?.current);
 if(!plan)return null;
 const stepText=(value:string)=>({
  '核对主机、Agent 身份与当前程序指纹':t('核对主机、Agent 身份与当前程序指纹','Verify the host, Agent identity, and current runtime fingerprint'),
  '下载并校验审批固定的维护器和发行包':t('下载并校验审批固定的维护器和发行包','Download and verify the maintainer and release pinned by this plan'),
  '通过独立 systemd 维护器切换程序':t('通过独立 systemd 维护器切换程序','Switch runtime through an independent systemd maintainer'),
  '确认目标构建的新进程已同步平台配置':t('确认目标构建的新进程已同步平台配置','Confirm the target build runs in a new process and has applied platform configuration'),
  '确认成功；启动或健康失败则恢复原程序':t('确认成功；启动或健康失败则恢复原程序','Confirm success, or restore the previous runtime if startup or health checks fail'),
  '维护期间暂停该主机的新任务派发和领取。':t('维护期间暂停该主机的新任务派发和领取。','Pause new task dispatch and claims on this host during maintenance.'),
  '保留主机 ID、Agent 身份、配置、队列和游标；不会重新接入。':t('保留主机 ID、Agent 身份、配置、队列和游标；不会重新接入。','Retain the host ID, Agent identity, configuration, queue, and cursors without enrolling again.'),
  '结果未知时只读核对；远端确认期限到达后自动回退，不自动重试。':t('结果未知时只读核对；远端确认期限到达后自动回退，不自动重试。','Verify uncertain outcomes read-only. The host rolls back when the confirmation deadline expires and does not retry automatically.'),
 }[value]||value);
 const identity=(value?:string)=>value?<Typography.Text code copyable={{text:value}} className="lm-machine-path">{value}</Typography.Text>:'—';
 return <>
  <Descriptions size="small" column={{xs:1,sm:2}} items={[
   {key:'action',label:t('操作','Action'),span:2,children:record.action==='rollback'?t('回退到保留的上一发行','Roll back to the retained previous release'):t('升级到指定发行','Upgrade to a selected release')},
   {key:'host',label:t('目标主机','Target host'),span:2,children:`${plan.machine.name} · ${sshEndpoint(plan.machine.address,plan.machine.port,plan.machine.username)}`},
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
 const request=useRef(0);
 const load=async()=>{const generation=++request.current;setLoading(true);try{const next=await api<AgentUpdate[]>(updatePath(machineID));if(generation===request.current){setRecords(next);setError('')}}catch(e){if(generation===request.current)setError(e instanceof Error?updateMessageText(e.message,t):t('读取失败','Could not load records'))}finally{if(generation===request.current)setLoading(false)}};
 useEffect(()=>{setRecords([]);void load();return()=>{request.current++}},[machineID]);
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
 const [releases,setReleases]=useState<AgentRelease[]>([]),[target,setTarget]=useState<string>(),[credential,setCredential]=useState<string|undefined>(()=>defaultMachineCredential(credentials,machine.default_credential_id,reusableMachineCredential));
 const [busy,setBusy]=useState(false),[catalogBusy,setCatalogBusy]=useState(false),[error,setError]=useState(''),[reviewed,setReviewed]=useState(false),[refreshNeeded,setRefreshNeeded]=useState(false),[planUncertain,setPlanUncertain]=useState(false),[now,setNow]=useState(Date.now());
 const pending=useRef(false),mounted=useRef(true),recordRef=useRef(record),request=useRef(0);
 recordRef.current=record;
 const keys=credentials.filter(c=>reusableMachineCredential(c));
 const options=releases.filter(release=>!machine.arch||release.arch===machine.arch);
 const err=(value:unknown)=>value instanceof Error?updateMessageText(value.message,t):t('操作失败','Operation failed');
 const refreshParent=async()=>{try{await onRefresh()}catch(e){if(mounted.current)setError(previous=>[previous,t('操作已保存，但主机列表刷新失败：','The operation was saved, but the host list could not refresh: ')+err(e)].filter(Boolean).join(' '))}};
 const currentPlanExpired=updatePlanExpired(record,now);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current++}},[]);
 useEffect(()=>{setCredential(previous=>credentials.some(key=>key.id===previous&&reusableMachineCredential(key))?previous:defaultMachineCredential(credentials,machine.default_credential_id,reusableMachineCredential))},[credentials,machine.default_credential_id]);
 useEffect(()=>{let alive=true;if(record)return;setCatalogBusy(true);api<{releases:AgentRelease[]}>('/agent-releases').then(result=>{if(alive){setReleases(result.releases);setError('')}}).catch(e=>{if(alive)setError(err(e))}).finally(()=>{if(alive)setCatalogBusy(false)});return()=>{alive=false}},[machine.id,record?.id]);
 useEffect(()=>{if(!record?.plan)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[record?.id,record?.plan?.expires_at]);
 const refreshRecord=async()=>{
  const saved=recordRef.current;if(!saved)return;const generation=++request.current;
  const next=await api<AgentUpdate>(updatePath(machine.id,saved.id));
  if(next.id!==saved.id||next.machine_id!==machine.id)throw Error(t('更新记录与目标主机不匹配，请刷新后重试','The update record does not match the selected host. Refresh and retry.'));
  if(mounted.current&&generation===request.current&&recordRef.current?.id===saved.id){recordRef.current=next;setRecord(next);setRefreshNeeded(false);return next}
 };
 useEffect(()=>{
  if(!record||!updateIsActive(record.status))return;
  let disposed=false,inFlight=false;
  const poll=async()=>{if(disposed||inFlight||pending.current)return;inFlight=true;try{const next=await refreshRecord();if(next&&!updateIsActive(next.status))await refreshParent()}catch{if(!disposed&&mounted.current)setRefreshNeeded(true)}finally{inFlight=false}};
  const timer=setInterval(()=>void poll(),4000);return()=>{disposed=true;clearInterval(timer)};
 },[record?.id,record?.status]);
 const begin=()=>{if(pending.current)return false;pending.current=true;request.current++;setBusy(true);setError('');return true};
 const finish=()=>{pending.current=false;if(mounted.current)setBusy(false)};
 const plan=async()=>{
  if(!credential||!keys.some(key=>key.id===credential)||action==='upgrade'&&!target||!begin())return;
  try{const next=await api<AgentUpdate>(`${updatePath(machine.id)}/plan`,{method:'POST',body:JSON.stringify({action,credential_id:credential,...(action==='upgrade'?{target_sha256:target}:{})})});if(next.machine_id!==machine.id)throw Error(t('更新记录与目标主机不匹配，请刷新后重试','The update record does not match the selected host. Refresh and retry.'));if(mounted.current){recordRef.current=next;setRecord(next);setReviewed(false)}await refreshParent()}
  catch(e){if(mounted.current){setError(err(e));if(!(e instanceof ApiError&&e.status<500))setPlanUncertain(true)}}finally{finish()}
 };
 const mutate=async(operation:'apply'|'cancel'|'reconcile')=>{
  if(!record||record.rollout_id&&(operation==='apply'||operation==='cancel')||operation==='apply'&&(!reviewed||currentPlanExpired)||!begin())return;
  try{const next=await api<AgentUpdate>(`${updatePath(machine.id,record.id)}/${operation}`,{method:'POST',body:JSON.stringify(operation==='apply'?{confirm:true}:operation==='reconcile'&&credential?{credential_id:credential}:{})});if(next.id!==record.id||next.machine_id!==machine.id)throw Error(t('更新记录与目标主机不匹配，请刷新后重试','The update record does not match the selected host. Refresh and retry.'));if(mounted.current){recordRef.current=next;setRecord(next);setReviewed(false)}}
  catch(e){if(mounted.current)setError(err(e))}
  finally{try{try{await refreshRecord()}catch{if(mounted.current)setRefreshNeeded(true)}await refreshParent()}finally{finish()}}
 };
 const refresh=async()=>{if(!begin())return;try{await refreshRecord();await refreshParent()}catch(e){if(mounted.current)setError(err(e))}finally{finish()}};
 const credentialSelect=<Select aria-label={t('更新 SSH 凭据','Update SSH credential')} value={credential} style={{width:'100%'}} placeholder={t('请选择有效 SSH 凭据','Select an active SSH credential')} disabled={busy} options={keys.map(key=>({value:key.id,label:`${key.name||(key.method==='password'?t('密码','Password'):t('SSH 私钥','SSH private key'))} · ${key.secret_fingerprint||key.id} · ${key.retention==='permanent'?t('永久','Permanent'):new Date(key.expires_at).toLocaleString(language)}`}))} onChange={setCredential}/>;
 return <Modal open className="lm-agent-update-dialog" style={{top:24}} title={t(`Agent 版本管理 · ${machine.name}`,`Agent releases · ${machine.name}`)} width={840} onCancel={()=>{if(!busy)onClose()}} closable={!busy} maskClosable={false} destroyOnHidden footer={<Space wrap>
  {!record&&<Button type="primary" loading={busy} disabled={!credential||action==='upgrade'&&!target||catalogBusy||planUncertain} onClick={()=>void plan()}>{t('检查并生成计划','Check and create plan')}</Button>}
  {record?.status==='awaiting_approval'&&!record.rollout_id&&<><Button aria-label={t('执行已审阅计划','Execute reviewed plan')} danger type="primary" loading={busy} disabled={!reviewed||currentPlanExpired||refreshNeeded} onClick={()=>void mutate('apply')}>{t('执行已审阅计划','Execute reviewed plan')}</Button><Button disabled={busy} onClick={()=>void mutate('cancel')}>{t('取消计划','Cancel plan')}</Button></>}
  {record?.status==='unknown'&&<Button type="primary" loading={busy} onClick={()=>void mutate('reconcile')}>{t('只读核对结果','Verify outcome (read-only)')}</Button>}
  {record&&<Button disabled={busy} onClick={()=>void refresh()}>{t('刷新状态','Refresh status')}</Button>}
  <Button disabled={busy} onClick={onClose}>{t('关闭','Close')}</Button>
 </Space>}>
  {error&&<Alert role="alert" type="error" showIcon title={error} className="lm-machine-form-notice"/>}
  {!record&&<>
   <p>{t('通过 SSH 执行固定维护步骤，保留 Agent 身份、配置和缓存。目标包使用 SHA256 固定；更新后核验新进程心跳和配置，未确认健康时自动回退。','Run fixed maintenance over SSH while retaining the Agent identity, configuration, and cache. Pin the artifact by SHA256. Verify the new process heartbeat and configuration, and automatically roll back when health is not confirmed.')}</p>
   <Space wrap className="lm-machine-form-notice"><Typography.Text>{t('更新方式','Action')}</Typography.Text><Select aria-label={t('Agent 更新方式','Agent update action')} value={action} disabled={busy} onChange={value=>{setAction(value);setReviewed(false)}} options={[{value:'upgrade',label:t('升级到指定发行','Upgrade to a selected release')},{value:'rollback',label:t('回退到保留的上一发行','Roll back to the retained previous release')}]}/></Space>
   {action==='upgrade'&&<div className="lm-machine-form-notice"><Typography.Paragraph>{t('目标发行（版本 · 提交 · 架构 · 包摘要）','Target release (version · revision · architecture · artifact digest)')}</Typography.Paragraph><Select aria-label={t('目标 Agent 发行','Target Agent release')} value={target} loading={catalogBusy} disabled={busy} onChange={setTarget} style={{width:'100%'}} placeholder={t('选择固定发行包','Select a fixed release artifact')} options={options.map(release=>({value:release.sha256,label:`${release.version} · ${shortIdentity(release.source_revision)} · ${release.arch} · ${shortIdentity(release.sha256)}`}))}/>{!catalogBusy&&!options.length&&<Typography.Text type="secondary">{t('没有匹配架构的发行包。请先在平台发布可用 Agent 包。','No release matches this architecture. Publish an Agent artifact on the platform first.')}</Typography.Text>}</div>}
   {action==='rollback'&&<Alert type="info" showIcon title={t('先核对上一发行，再审阅回退','Verify the previous release before reviewing rollback')} description={t('检查从主机读取保留的上一发行并固定其指纹。回退不会重新接入或更换 Agent 身份。','The check reads the retained previous release on the host and pins its fingerprint. Rollback keeps the existing Agent identity.')}/>}
   <Typography.Paragraph style={{marginTop:16}}>{t('可复用 SSH 凭据','Reusable SSH credential')}</Typography.Paragraph>{credentialSelect}
   {!keys.length&&<Alert className="lm-machine-form-notice" type="info" showIcon title={t('请先为主机添加有效私钥或可复用密码','Add an active private key or reusable password to the host first')}/>}
   {planUncertain&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('计划创建结果未确认','Plan creation was not confirmed')} description={t('请关闭窗口并从主机的更新历史核对已保存计划；不要重复创建。','Close this dialog and check saved plans in the host update history before creating another plan.')}/>}
  </>}
  {record&&<>
   <Alert className="lm-machine-form-notice" showIcon type={record.status==='succeeded'?'success':record.status==='failed'?'error':record.status==='unknown'||record.status==='rolled_back'?'warning':'info'} title={updateStatusText(record.status,t)} description={(record.error?updateMessageText(record.error,t):undefined)||(record.status==='unknown'?t('执行结果尚未确定。只读核对会检查原事务和心跳，不会再次执行更新。','The outcome is uncertain. Read-only verification checks the original transaction and heartbeat without running another update.'):record.status==='rolled_back'?t('目标发行未通过健康确认，已保留原身份并回退。请查看记录后再生成新计划。','The target release did not pass health confirmation and was rolled back with its identity retained. Review this record before creating another plan.'):undefined)}/>
   <AgentUpdatePlanSummary record={record}/>
   {record.rollout_id&&<Alert className="lm-machine-form-notice" showIcon type="info" title={t('此操作属于升级批次','This operation belongs to an upgrade rollout')} description={<Typography.Link href={`/machines?agent_rollout=${encodeURIComponent(record.rollout_id)}`}>{t('打开批次审阅和控制后续主机','Open the rollout to review and control subsequent hosts')}</Typography.Link>}/>}
   <Typography.Paragraph type="secondary">{t('操作 ID：','Operation ID: ')}<Typography.Text code copyable>{record.id}</Typography.Text></Typography.Paragraph>
   {record.status==='awaiting_approval'&&!record.rollout_id&&<>{currentPlanExpired&&<Alert className="lm-machine-form-notice" type="warning" showIcon title={t('计划已过期，请取消后重新检查','This plan expired. Cancel it and run a new check')}/>}<Checkbox checked={reviewed} disabled={busy||currentPlanExpired} onChange={event=>setReviewed(event.target.checked)}>{t('我已审阅主机、当前/目标发行、步骤和影响','I have reviewed the host, current/target releases, steps, and impact')}</Checkbox></>}
   {record.status==='unknown'&&keys.length>0&&<div className="lm-machine-form-notice"><Typography.Paragraph>{t('核对使用的 SSH 凭据','SSH credential for verification')}</Typography.Paragraph>{credentialSelect}</div>}
   {refreshNeeded&&<Alert type="warning" showIcon className="lm-machine-form-notice" title={t('保存状态尚未刷新，请刷新后再继续','The saved status could not be refreshed. Refresh it before continuing')}/>}
  </>}
 </Modal>;
}
