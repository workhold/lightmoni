import {useCallback,useEffect,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Drawer,Empty,Input,Modal,Space,Table,Tabs,Tag} from '../../shared/ui';
import {api,post,ApiError} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,time,type Spec} from './model';

const terminal=(state:string)=>['succeeded','failed','cancelled','unknown'].includes(state);
export default function HostInventory({machine,onClose}:{machine?:{id:string;name:string};onClose:()=>void}){
 const {t}=useI18n(),navigate=useNavigate(),[modal,contextHolder]=Modal.useModal();
 const [activeTab,setActiveTab]=useState('applications'),[data,setData]=useState<Spec>({hosts:[],applications:[]});
 const [loading,setLoading]=useState(false),[submitting,setSubmitting]=useState(false),[error,setError]=useState(''),[search,setSearch]=useState('');
 const [job,setJob]=useState<Spec>(),[retry,setRetry]=useState<Spec>();
 const request=useRef(0),scope=useRef(0),confirm=useRef<{destroy:()=>void}|null>(null);
 const load=useCallback(async()=>{
  if(!machine)return;
  const current=++request.current;setLoading(true);
  try{const result=await api<Spec>('/ops/inventory?machine_id='+encodeURIComponent(machine.id));if(current===request.current)setData(result)}
  catch(e){if(current===request.current)setError(errorText(e))}
  finally{if(current===request.current)setLoading(false)}
 },[machine?.id]);
 useEffect(()=>{
  scope.current++;setActiveTab('applications');setData({hosts:[],applications:[]});setSearch('');setJob(undefined);setRetry(undefined);setError('');setSubmitting(false);
  if(!machine)return;
  void load();const timer=setInterval(()=>void load(),10000);
  return()=>{request.current++;scope.current++;clearInterval(timer);confirm.current?.destroy()};
 },[machine?.id,load]);
 const host=data.hosts?.[0],active=!!job&&!terminal(job.state),busy=submitting||active;
 useEffect(()=>{if(host?.active_job&&(!job||terminal(job.state))&&host.active_job!==job?.id)setJob({id:host.active_job,state:'queued'})},[host?.active_job]);
 useEffect(()=>{
  if(!machine||!job?.id||terminal(job.state))return;
  let cancelled=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   try{
    const result=await api<Spec>('/ops/machines/'+encodeURIComponent(machine.id)+'/docker-jobs/'+encodeURIComponent(job.id));
    if(cancelled)return;
    setJob(result);setError('');
    if(terminal(result.state)){void load();return;}
   }catch(e){if(!cancelled)setError(errorText(e))}
   if(!cancelled)timer=setTimeout(()=>void poll(),1000);
  };
  void poll();return()=>{cancelled=true;clearTimeout(timer)};
 },[machine?.id,job?.id,job?.state,load]);
 const diagnostics:Record<string,string>={
  docker_cli_missing:t('Agent 环境缺少 Docker 命令，请在 Agent 所在主机安装 Docker CLI','Docker CLI is missing from the Agent environment'),
  docker_permission_denied:t('Agent 无权访问 Docker，请检查本机 Docker socket 权限','Agent cannot access Docker; check local socket permissions'),
  docker_daemon_unavailable:t('Agent 无法连接本机 Docker daemon，请检查 Docker 服务','Agent cannot connect to the local Docker daemon'),
  docker_command_timeout:t('Docker 查询或操作超时，请检查 daemon 状态','Docker command timed out; check the daemon'),
  docker_agent_offline:t('Agent 离线，无法立即采集或操作','Agent is offline'),
  docker_agent_upgrade_required:t('请升级此主机 Agent 以支持立即采集和 Docker 操作','Upgrade this Agent for immediate collection and Docker actions'),
  docker_fresh_inventory_required:t('请先立即采集，获取此主机的最新容器清单','Collect a fresh inventory before changing a container'),
  docker_job_in_progress:t('此主机已有 Docker 任务正在执行','A Docker task is already running on this host'),
  operations_node_locked:t('主机有未结束或结果未知的操作，请检查后恢复','Host has an active or unresolved operation; inspect before recovery'),
  job_expired:t('Agent 未及时领取任务，任务已过期','The task expired before the Agent claimed it'),
  invalid_docker_receipt:t('Agent 回执未通过核对，请重新采集并检查','Agent receipt could not be verified; refresh and inspect'),
  docker_collection_unavailable:t('Docker 采集失败，请检查 Agent 和本机 Docker','Docker collection failed; inspect the Agent and local Docker'),
  unknown_execution_result:t('执行结果未知，请重新采集并检查容器后再操作','Execution result is unknown; collect and inspect before another action'),
 };
 const explain=(code:string)=>diagnostics[code]??code;
 const send=async(body:Spec)=>{
  if(!machine)return;
  const generation=scope.current;setSubmitting(true);setError('');
  try{
   const result=await post<Spec>('/ops/machines/'+encodeURIComponent(machine.id)+'/docker-jobs',body);
   if(generation===scope.current){setJob(result);setRetry(undefined)}
  }catch(e){if(generation===scope.current){setError(explain(errorText(e)));setRetry(!(e instanceof ApiError)||e.status>=500||e.status===429?body:undefined)}}
  finally{if(generation===scope.current)setSubmitting(false)}
 };
 const refresh=()=>void send({operation:'inventory',request_id:crypto.randomUUID()});
 const actionNames:Record<string,string>={start:t('启动','Start'),stop:t('停止','Stop'),restart:t('重启','Restart')};
 const operate=(container:Spec,operation:string)=>{
  const generation=scope.current;
  confirm.current=modal.confirm({title:actionNames[operation]+' · '+container.name,okText:t('确认执行','Confirm'),cancelText:t('取消','Cancel'),okButtonProps:{danger:operation!=='start'},
   content:<><p>{machine?.name} · {container.id}</p><p>{operation==='start'?t('启动此容器。','Start this container.'):t('此操作会中断容器服务。','This action interrupts the container service.')}</p>{container.application_id&&<p>{t('平台调度器可能按应用的期望状态恢复容器。','The platform scheduler may restore the application’s desired state.')}</p>}</>,
   onOk:async()=>{if(generation===scope.current)await send({operation,container_id:container.id,confirmed:true,request_id:crypto.randomUUID()})},
  });
 };
 const containers=(host?.containers??[]).filter((c:Spec)=>!search||[c.name,c.image,c.id].some(v=>String(v).toLowerCase().includes(search.toLowerCase())));
 const labels:Record<string,string>={not_connected:t('主机尚未接入 Agent','Host has no Agent'),waiting:t('等待 Agent 采集 Docker','Waiting for Docker collection'),stale:t('观测已过期，下面保留最近一次清单','Observation is stale; showing the last inventory'),degraded:t('应用指标或日志采集失败；Docker 清单可单独刷新','Application telemetry failed; Docker inventory can be refreshed separately'),unavailable:explain(host?.error||'docker_collection_unavailable')};
 const jobStates:Record<string,string>={queued:t('等待 Agent 领取','Waiting for Agent'),leased:t('Agent 已领取','Claimed by Agent'),accepted:t('Agent 已接受','Accepted'),staging:t('检查 Docker','Checking Docker'),activating:t('正在执行','Executing'),verifying:t('正在核对结果','Verifying'),succeeded:t('已完成，清单已更新','Completed; inventory updated'),failed:t('任务失败','Task failed'),cancelled:t('任务已取消或过期','Task cancelled or expired'),unknown:t('结果未知，请立即采集并检查，勿直接重试操作','Result unknown; collect and inspect before retrying')};
 const capabilities=host?.docker_capabilities??[],canControl=host?.online&&capabilities.includes('docker.control')&&['ready','degraded'].includes(host?.state);
 return <Drawer title={t('主机应用与 Docker','Host applications & Docker')+' · '+(machine?.name??'')} open={!!machine} size={1100} onClose={onClose} destroyOnHidden>
  {contextHolder}
  <div className="lm-ops-section-heading"><span className="lm-ops-note">{host?.observed_at&&Date.parse(host.observed_at)>0?t('最近清单','Last inventory')+' · '+time(host.observed_at):t('尚无成功采集的清单','No successful inventory yet')}{host?.attempted_at&&host?.state==='unavailable'?' · '+t('最近尝试','Last attempt')+' '+time(host.attempted_at):''}</span><Button loading={busy} disabled={!host?.online||!capabilities.includes('docker.inventory')||!!retry} icon={<ReloadOutlined/>} onClick={refresh}>{t('立即采集','Collect now')}</Button></div>
  {error&&<Alert showIcon type="error" title={error}/>}
  {retry&&<Alert showIcon type="warning" title={t('请求未确认，重试将复用同一任务，避免重复操作','Request unconfirmed; retry reuses the same task')} action={<Button loading={submitting} onClick={()=>void send(retry)}>{t('重试请求','Retry request')}</Button>}/>}
  {host&&!capabilities.includes('docker.inventory')&&<Alert showIcon type="info" title={diagnostics.docker_agent_upgrade_required}/>}
  {host&&!host.online&&<Alert showIcon type="warning" title={diagnostics.docker_agent_offline}/>}
  {host&&host.state!=='ready'&&<Alert showIcon type="warning" title={labels[host.state]??host.state}/>}
  {job&&<Alert showIcon type={job.state==='succeeded'?'success':['failed','unknown','cancelled'].includes(job.state)?'warning':'info'} title={(job.operation?actionNames[job.operation]??t('采集清单','Collect inventory'):'Docker')+' · '+(jobStates[job.state]??job.state)} description={job.code?explain(job.code):undefined}/>}
  {host?.truncated&&<Alert showIcon type="warning" title={t('清单达到容器数量或大小上限，部分容器未显示','Inventory reached its count or size limit; some containers are omitted')}/>}
  <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
   {key:'applications',label:t('平台应用','Platform applications')+` (${data.applications?.length??0})`,children:<Table<Spec> loading={loading} size="small" rowKey="id" dataSource={data.applications??[]} pagination={{pageSize:10}} locale={{emptyText:<Empty description={<>{t('此主机暂无平台应用','No platform applications on this host')}{host?.containers?.length>0&&<p><Button type="link" onClick={()=>setActiveTab('docker')}>{t('查看此主机的 Docker 容器','View Docker containers on this host')}</Button></p>}</>}/>}} columns={[
    {title:t('应用','Application'),render:(_,a)=><><strong>{a.name}</strong><small>{a.spec.service_name}</small></>},
    {title:t('部署','Deployments'),render:(_,a)=>(a.status.instances??[]).map((i:Spec)=><div key={i.id}>{i.state} · {i.id.slice(0,12)}</div>)},
    {title:t('操作','Actions'),render:(_,a)=><Button onClick={()=>{onClose();navigate('/applications/'+a.id+'/monitoring?machine_id='+encodeURIComponent(machine!.id))}}>{t('监控与日志','Monitoring & logs')}</Button>},
   ]}/>},
   {key:'docker',label:`Docker (${host?.containers?.length??0})`,children:<>
    <Input.Search allowClear aria-label={t('搜索容器','Search containers')} placeholder={t('搜索容器名称、镜像或 ID','Search container name, image or ID')} value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:380,marginBottom:16}}/>
    <Table<Spec> rowKey="id" loading={loading} size="small" dataSource={containers} pagination={{pageSize:15}} scroll={{x:1100}} locale={{emptyText:<Empty description={['ready','degraded'].includes(host?.state)?t('没有匹配的 Docker 容器','No matching Docker containers'):t('暂无可用的容器观测','No container observation available')}/>}} columns={[
     {title:t('容器','Container'),render:(_,c)=><><strong>{c.name}</strong><small>{c.id.slice(0,12)}</small></>},
     {title:t('镜像','Image'),dataIndex:'image'},
     {title:t('状态','State'),dataIndex:'state',render:v=><Tag color={v==='running'?'success':'default'}>{v}</Tag>},
     {title:t('端口','Ports'),dataIndex:'ports'},
     {title:t('归属','Ownership'),render:(_,c)=>c.application_id?<Button type="link" onClick={()=>{onClose();navigate('/applications/'+c.application_id+'/monitoring?container_id='+c.id)}}>{data.applications.find((a:Spec)=>a.id===c.application_id)?.name??t('平台应用','Platform application')}</Button>:<Tag>{c.deployment_id?t('未关联平台应用','Unlinked platform application'):t('非平台创建','External container')}</Tag>},
     {title:t('操作','Actions'),fixed:'right',render:(_,c)=><Space size="small">{(c.state==='running'?['stop','restart']:['start']).map(operation=><Button key={operation} size="small" danger={operation==='stop'} disabled={!canControl||busy||!!retry} onClick={()=>operate(c,operation)}>{actionNames[operation]}</Button>)}</Space>},
    ]}/>
   </>},
  ]}/>
 </Drawer>;
}
