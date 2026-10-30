import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Modal,Select,Space,Table,Tag,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {reusableMachineCredential} from './machine-credentials';
import {AgentUpdatePlanSummary} from './MachineAgentUpdateDialog';
import {shortIdentity,updateIsActive,updateMessageText,updatePlanExpired,updateStatusColor,updateStatusText,type AgentRelease,type AgentRollout,type AgentUpdate,type AgentUpdateCredential} from './agent-update-model';

export type AgentRolloutTarget={id:string;name:string;arch?:string};
type HostDetail={machine:AgentRolloutTarget;credentials:AgentUpdateCredential[]};
type Props={targets?:AgentRolloutTarget[];existingID?:string;onClose:()=>void;onRefresh:()=>Promise<void>};
const rolloutPath=(id?:string)=>`/agent-rollouts${id?`/${encodeURIComponent(id)}`:''}`;

export default function MachineAgentRolloutDialog({targets=[],existingID,onClose,onRefresh}:Props){
 const {t,language}=useI18n(),[snapshot]=useState(()=>targets.map(target=>({...target})));
 const [records,setRecords]=useState<AgentRollout[]>([]),[record,setRecord]=useState<AgentRollout>(),[releases,setReleases]=useState<AgentRelease[]>([]),[hosts,setHosts]=useState<Record<string,HostDetail>>({}),[credentials,setCredentials]=useState<Record<string,string>>({}),[target,setTarget]=useState<string>();
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[reviewed,setReviewed]=useState(false),[error,setError]=useState(''),[refreshNeeded,setRefreshNeeded]=useState(false),[uncertain,setUncertain]=useState(false),[historyMode,setHistoryMode]=useState(!targets.length),[itemRecords,setItemRecords]=useState<Record<string,AgentUpdate>>({}),[now,setNow]=useState(Date.now());
 const mounted=useRef(true),pending=useRef(false),recordRef=useRef(record);recordRef.current=record;
 const err=(value:unknown)=>value instanceof Error?updateMessageText(value.message,t):t('操作失败','Operation failed');
 const refreshParent=async()=>{try{await onRefresh()}catch(e){if(mounted.current)setError(previous=>[previous,t('批次已保存，但主机列表刷新失败：','The rollout was saved, but the host list could not refresh: ')+err(e)].filter(Boolean).join(' '))}};
 const status=(value:string)=>({awaiting_approval:t('待审阅','Awaiting review'),running:t('正在逐台更新','Updating hosts in sequence'),paused:t('已暂停','Paused'),succeeded:t('升级完成','Rollout complete'),failed:t('升级失败','Rollout failed'),cancelled:t('已取消','Cancelled')}[value]||value);
 const color=(value:string)=>value==='succeeded'?'success':value==='failed'?'error':value==='paused'?'warning':value==='running'?'processing':'default';
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
 useEffect(()=>{if(!record||!['awaiting_approval','paused'].includes(record.status))return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[record?.id,record?.status]);
 const loadItems=async(next:AgentRollout)=>{
  const results=await Promise.allSettled(next.items.filter(item=>item.update_id&&!item.update).map(async item=>[item.update_id!,await api<AgentUpdate>(`/machines/${encodeURIComponent(item.machine_id)}/agent-updates/${encodeURIComponent(item.update_id!)}`)] as const));
  if(mounted.current&&recordRef.current?.id===next.id){const saved:Record<string,AgentUpdate>={};for(const result of results)if(result.status==='fulfilled')saved[result.value[0]]=result.value[1];setItemRecords(saved)}
 };
 const accept=async(next:AgentRollout)=>{if(!mounted.current)return;recordRef.current=next;setRecord(next);setReviewed(false);setRefreshNeeded(false);await loadItems(next)};
 const loadHistory=async()=>{const saved=await api<AgentRollout[]>(rolloutPath());if(mounted.current)setRecords(saved)};
 useEffect(()=>{
  let alive=true;setLoading(true);
  const initialize=async()=>{
   try{
    if(existingID){const next=await api<AgentRollout>(rolloutPath(existingID));if(alive)await accept(next)}
    else if(!snapshot.length){await loadHistory()}
    else{
     const result=await api<{releases:AgentRelease[]}>('/agent-releases');if(alive)setReleases(result.releases);
     const detailResults=await Promise.allSettled(snapshot.map(async host=>[host.id,await api<HostDetail>(`/machines/${encodeURIComponent(host.id)}`)] as const));
     if(alive){const details:Record<string,HostDetail>={},chosen:Record<string,string>={},failures:string[]=[];for(let i=0;i<detailResults.length;i++){const entry=detailResults[i];if(entry.status==='fulfilled'){details[entry.value[0]]=entry.value[1];const keys=entry.value[1].credentials.filter(reusableMachineCredential);if(keys.length===1)chosen[entry.value[0]]=keys[0].id}else failures.push(`${snapshot[i].name}: ${err(entry.reason)}`)}setHosts(details);setCredentials(chosen);if(failures.length)setError(failures.join(' · '))}
    }
   }catch(e){if(alive)setError(err(e))}finally{if(alive)setLoading(false)}
  };void initialize();return()=>{alive=false};
 },[existingID]);
 const begin=()=>{if(pending.current)return false;pending.current=true;setBusy(true);setError('');return true};
 const finish=()=>{pending.current=false;if(mounted.current)setBusy(false)};
 const refreshRecord=async()=>{const saved=recordRef.current;if(!saved)return;const next=await api<AgentRollout>(rolloutPath(saved.id));if(mounted.current&&recordRef.current?.id===saved.id)await accept(next);return next};
 const hasActiveItems=record?.items.some(item=>updateIsActive(item.update?.status||item.status))??false;
 useEffect(()=>{
  if(record?.status!=='running'&&!hasActiveItems)return;let stopped=false,inFlight=false;
  const poll=async()=>{if(stopped||inFlight||pending.current)return;inFlight=true;try{const next=await refreshRecord();if(next&&next.status!=='running'&&!next.items.some(item=>updateIsActive(item.update?.status||item.status)))await refreshParent()}catch{if(!stopped&&mounted.current)setRefreshNeeded(true)}finally{inFlight=false}};
  const timer=setInterval(()=>void poll(),4000);return()=>{stopped=true;clearInterval(timer)};
 },[record?.id,record?.status,hasActiveItems]);
 const selectRecord=async(id:string)=>{if(!begin())return;try{await accept(await api<AgentRollout>(rolloutPath(id)));setReviewed(false)}catch(e){if(mounted.current)setError(err(e))}finally{finish()}};
 const allCredentials=snapshot.length>0&&snapshot.every(host=>!!credentials[host.id]&&hosts[host.id]?.credentials.some(key=>key.id===credentials[host.id]&&reusableMachineCredential(key)));
 const architectures=[...new Set(snapshot.map(host=>host.arch).filter((arch):arch is string=>!!arch))],mixedArchitectures=architectures.length>1;
 const matchingReleases=releases.filter(release=>architectures.length!==1||release.arch===architectures[0]);
 const plansReady=!!record?.items.length&&record.items.every(item=>!!(item.update||(item.update_id?itemRecords[item.update_id]:undefined))?.plan);
 const expiredPlans=record?.items.some(item=>{const saved=item.update||(item.update_id?itemRecords[item.update_id]:undefined);return saved?.status==='awaiting_approval'&&updatePlanExpired(saved,now)})??false;
 const unresolvedItems=record?.items.some(item=>{const state=item.update?.status||item.status;return state==='unknown'||updateIsActive(state)})??false;
 const plan=async()=>{
  if(!target||!allCredentials||snapshot.length>20||mixedArchitectures||!begin())return;
  try{await accept(await api<AgentRollout>(`${rolloutPath()}/plan`,{method:'POST',body:JSON.stringify({machine_ids:snapshot.map(host=>host.id),target_sha256:target,credential_ids:credentials})}));if(mounted.current)setReviewed(false);await refreshParent()}
  catch(e){if(mounted.current){setError(err(e));if(!(e instanceof ApiError&&e.status<500))setUncertain(true)}}finally{finish()}
 };
 const mutate=async(operation:'apply'|'pause'|'resume'|'cancel')=>{
  if(!record||['apply','resume'].includes(operation)&&(!reviewed||!plansReady||expiredPlans||unresolvedItems)||!begin())return;
  try{await accept(await api<AgentRollout>(`${rolloutPath(record.id)}/${operation}`,{method:'POST',body:JSON.stringify(['apply','resume'].includes(operation)?{confirm:true}:{})}));if(mounted.current)setReviewed(false)}
  catch(e){if(mounted.current)setError(err(e))}
  finally{try{try{await refreshRecord()}catch{if(mounted.current)setRefreshNeeded(true)}await refreshParent()}finally{finish()}}
 };
 const refresh=async()=>{if(!begin())return;try{if(record)await refreshRecord();else await loadHistory();await refreshParent()}catch(e){if(mounted.current)setError(err(e))}finally{finish()}};
 const showHistory=async()=>{if(!begin())return;try{await loadHistory();if(mounted.current){setHistoryMode(true);setRecord(undefined);recordRef.current=undefined;setReviewed(false)}}catch(e){if(mounted.current)setError(err(e))}finally{finish()}};
 return <Modal open className="lm-agent-rollout-dialog" style={{top:24}} title={t('Agent 升级批次','Agent upgrade rollouts')} width={1000} onCancel={()=>{if(!busy)onClose()}} closable={!busy} maskClosable={false} destroyOnHidden footer={<Space wrap>
  {!record&&!historyMode&&<Button type="primary" loading={busy||loading} disabled={!target||!allCredentials||snapshot.length>20||mixedArchitectures||uncertain} onClick={()=>void plan()}>{t('检查并生成升级批次','Check and create rollout')}</Button>}
  {record?.status==='awaiting_approval'&&<Button aria-label={t('执行已审阅批次','Execute reviewed rollout')} type="primary" loading={busy} disabled={!reviewed||refreshNeeded||!plansReady||expiredPlans} onClick={()=>void mutate('apply')}>{t('执行已审阅批次','Execute reviewed rollout')}</Button>}
  {record?.status==='running'&&<Button aria-label={t('暂停后续主机','Pause subsequent hosts')} loading={busy} onClick={()=>void mutate('pause')}>{t('暂停后续主机','Pause subsequent hosts')}</Button>}
  {record?.status==='paused'&&<Button aria-label={t('继续已审阅批次','Resume reviewed rollout')} type="primary" loading={busy} disabled={!reviewed||refreshNeeded||!plansReady||expiredPlans||unresolvedItems} onClick={()=>void mutate('resume')}>{t('继续已审阅批次','Resume reviewed rollout')}</Button>}
  {record&&['awaiting_approval','running','paused'].includes(record.status)&&<Button disabled={busy} danger onClick={()=>void mutate('cancel')}>{t('取消未开始的主机','Cancel hosts not yet started')}</Button>}
  <Button disabled={busy||loading} onClick={()=>void refresh()}>{t('刷新状态','Refresh status')}</Button>
  <Button disabled={busy||loading} onClick={()=>void showHistory()}>{t('批次历史','Rollout history')}</Button>
  <Button disabled={busy} onClick={onClose}>{t('关闭','Close')}</Button>
 </Space>}>
  {error&&<Alert role="alert" type="error" showIcon title={error} className="lm-machine-form-notice"/>}
  <Alert showIcon type="info" className="lm-machine-form-notice" title={t('最多 20 台主机，逐台升级','Up to 20 hosts, updated one at a time')} description={t('每台主机都有固定发行、独立审阅计划和持久记录。失败、自动回退或结果未知会暂停后续主机；暂停和取消不打断正在执行的主机。','Each host has a pinned release, an individual review plan, and a durable record. Failure, automatic rollback, or an unknown outcome pauses subsequent hosts. Pausing or cancellation does not interrupt the host currently running.')}/>
  {!record&&historyMode&&<Table<AgentRollout> loading={loading} size="small" rowKey="id" dataSource={records} scroll={{x:680}} pagination={{pageSize:8}} columns={[
   {title:t('批次','Rollout'),dataIndex:'id',render:(value:string)=><Typography.Text code>{shortIdentity(value)}</Typography.Text>},
   {title:t('状态','Status'),dataIndex:'status',render:(value:string)=><Tag color={color(value)}>{status(value)}</Tag>},
   {title:t('主机数','Hosts'),render:(_,row)=>row.items.length},
   {title:t('创建时间','Created at'),dataIndex:'created_at',render:(value:string)=>new Date(value).toLocaleString(language)},
   {title:t('操作','Actions'),render:(_,row)=><Button size="small" disabled={busy} onClick={()=>void selectRecord(row.id)}>{row.status==='awaiting_approval'?t('审阅批次','Review rollout'):t('查看批次','View rollout')}</Button>},
  ]}/>}
  {!record&&!historyMode&&<>
   {snapshot.length>20&&<Alert showIcon type="warning" title={t('升级批次最多 20 台，请重新选择','Select no more than 20 hosts for an upgrade rollout')}/>}
   {mixedArchitectures&&<Alert showIcon type="info" className="lm-machine-form-notice" title={t('请按主机架构分批升级','Create separate rollouts for each host architecture')} description={t('每个批次固定一个发行包，不能混合 amd64 和 arm64。','Each rollout pins one artifact and cannot mix amd64 and arm64 hosts.')}/>}
   <Typography.Paragraph>{t('目标发行（版本 · 提交 · 架构 · 包摘要）','Target release (version · revision · architecture · artifact digest)')}</Typography.Paragraph><Select aria-label={t('批次目标 Agent 发行','Rollout target Agent release')} style={{width:'100%'}} loading={loading} value={target} disabled={busy||mixedArchitectures} onChange={setTarget} placeholder={t('选择固定发行包','Select a fixed release artifact')} options={matchingReleases.map(release=>({value:release.sha256,label:`${release.version} · ${shortIdentity(release.source_revision)} · ${release.arch} · ${shortIdentity(release.sha256)}`}))}/>
   <div style={{marginTop:16,maxHeight:'45vh',overflowY:'auto'}}>{snapshot.map(host=><section key={host.id} className="lm-machine-rollout-target"><Typography.Paragraph strong>{host.name} · {host.arch||t('架构待检查','Architecture pending verification')}</Typography.Paragraph><Select aria-label={t(`升级 SSH 凭据 · ${host.name}`,`Upgrade SSH credential · ${host.name}`)} style={{width:'100%'}} disabled={busy||loading} value={credentials[host.id]} placeholder={t('选择此主机的可复用 SSH 凭据','Select this host’s reusable SSH credential')} onChange={value=>setCredentials(previous=>({...previous,[host.id]:value}))} options={hosts[host.id]?.credentials.filter(reusableMachineCredential).map(key=>({value:key.id,label:`${key.method==='password'?t('密码','Password'):t('SSH 私钥','SSH private key')} · ${key.secret_fingerprint||key.id}`}))||[]}/>{!loading&&!hosts[host.id]?.credentials.some(reusableMachineCredential)&&<Typography.Text type="warning">{t('此主机没有有效的可复用 SSH 凭据，请先添加。','Add a reusable SSH credential to this host first.')}</Typography.Text>}</section>)}</div>
   {uncertain&&<Alert showIcon type="warning" title={t('批次创建结果未确认，请从批次历史核对','Rollout creation was not confirmed. Verify it in rollout history')}/>}
  </>}
  {record&&<>
   <Alert showIcon className="lm-machine-form-notice" type={record.status==='succeeded'?'success':record.status==='failed'?'error':record.status==='paused'?'warning':'info'} title={status(record.status)} description={record.error?updateMessageText(record.error,t):undefined}/>
   <Descriptions column={1} size="small" items={[{key:'id',label:t('批次 ID','Rollout ID'),children:<Typography.Text code copyable>{record.id}</Typography.Text>},{key:'sha',label:t('固定目标包 SHA256','Pinned target artifact SHA256'),children:<Typography.Text code className="lm-machine-path">{record.target_sha256||record.target?.sha256||'—'}</Typography.Text>}]}/>
   <div style={{maxHeight:'52vh',overflowY:'auto'}}>{record.items.map(item=>{
    const saved=item.update||(item.update_id?itemRecords[item.update_id]:undefined),state=saved?.status||item.status||'pending';
    return <section className="lm-machine-rollout-target" key={item.machine_id} data-rollout-host={item.machine_id}><Space wrap><Typography.Text strong>{item.machine_name||snapshot.find(host=>host.id===item.machine_id)?.name||item.machine_id}</Typography.Text><Tag color={updateStatusColor(state)}>{updateStatusText(state,t)}</Tag></Space>{(saved?.error||item.error)&&<Alert type={state==='unknown'?'warning':'error'} showIcon title={updateMessageText(saved?.error||item.error||'',t)}/>} {saved?.plan&&<details style={{marginTop:8}} open={record.status==='awaiting_approval'}><summary>{t('查看固定主机计划','View pinned host plan')}</summary><AgentUpdatePlanSummary record={saved}/></details>}{item.update_id&&<Typography.Link href={`/machines?machine=${encodeURIComponent(item.machine_id)}&update=${encodeURIComponent(item.update_id)}`} target="_blank" rel="noopener noreferrer">{state==='unknown'?t('打开单机记录核对','Open host record to verify'):t('打开单机更新记录','Open host update record')}</Typography.Link>}</section>;
   })}</div>
   {['awaiting_approval','paused'].includes(record.status)&&<><Checkbox checked={reviewed} disabled={busy||!plansReady||expiredPlans||unresolvedItems} onChange={event=>setReviewed(event.target.checked)}>{t('我已审阅全部主机计划及现有结果，确认执行尚未开始的主机','I reviewed every host plan and current outcome, and approve hosts not yet started')}</Checkbox>{!plansReady&&<Alert className="lm-machine-form-notice" showIcon type="warning" title={t('尚未读取全部主机计划，请刷新后审阅','Some host plans are not loaded. Refresh before reviewing')}/>} {expiredPlans&&<Alert className="lm-machine-form-notice" showIcon type="warning" title={t('有主机计划已过期，请取消未执行项后重新检查','A host plan expired. Cancel unexecuted items and run a new check')}/>}</>}
   {record.status==='paused'&&<Typography.Paragraph type="secondary">{t('先核对失败或未知结果；继续操作只推进尚未开始的主机，不会重试已执行操作。','Verify failed or unknown outcomes first. Resuming advances only hosts not yet started and does not retry executed operations.')}</Typography.Paragraph>}
   {record.status==='paused'&&unresolvedItems&&<Alert className="lm-machine-form-notice" showIcon type="info" title={t('先等待运行中的主机结束，或打开单机记录核对未知结果','Wait for running hosts to finish, or open host records to verify unknown outcomes')}/>}
   {refreshNeeded&&<Alert className="lm-machine-form-notice" showIcon type="warning" title={t('保存状态尚未刷新，请先刷新','The saved status could not be refreshed. Refresh it first')}/>}
  </>}
 </Modal>;
}
