import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Dropdown,Input,Modal,Select,Space,Table,Tag,Typography} from '../shared/ui';
import {ReloadOutlined,SearchOutlined} from '@ant-design/icons';
import {api} from '../shared/api';
import './host-resources.css';
import {useI18n} from '../shared/i18n';
import ExternalComposeManagement from './ExternalComposeManagement';
import HostContainerManagement,{type ContainerSelection} from './HostContainerManagement';

type Container={id:string;name:string;image:string;state:string;ports:string;application_id:string;compose_project?:string};
type Inventory={id:string;agent_id:string;online:boolean;state:string;error:string;observed_at:string;truncated:boolean;active_job:string;docker_capabilities:string[];containers:Container[]};
const cachedInventories=new Map<string,Inventory>();
type Job={id:string;state:string;code?:string};
export default function HostContainersDialog({machine,onClose}:{machine:{id:string;name:string};onClose:()=>void}){
 const {t,language}=useI18n(),[host,setHost]=useState<Inventory|undefined>(()=>{const cached=cachedInventories.get(machine.id);return cached&&Date.now()-Date.parse(cached.observed_at)>120000?{...cached,state:'stale'}:cached}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[state,setState]=useState('all');
 const alive=useRef(true),pending=useRef(false),controller=useRef<AbortController|null>(null);
 const [selection,setSelection]=useState<ContainerSelection>(),[selected,setSelected]=useState<string[]>([]),[batchSelection,setBatchSelection]=useState<{ids:string[];stoppedOnly:boolean}>(),[composeOpen,setComposeOpen]=useState(false);
 const load=async(signal:AbortSignal)=>{
  const result=await api<{hosts:Inventory[]}>('/ops/inventory?machine_id='+encodeURIComponent(machine.id),{signal});
  const found=result.hosts.find(h=>h.id===machine.id);if(!found)throw Error(t('未找到目标主机清单','The host inventory was not found'));
  if(alive.current&&!signal.aborted){cachedInventories.delete(machine.id);cachedInventories.set(machine.id,found);if(cachedInventories.size>20)cachedInventories.delete(cachedInventories.keys().next().value!);setHost(found);setSelected(old=>old.filter(id=>found.containers.some(c=>c.id===id)))}return found;
 };
 const refresh=async(collect=false)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');const abort=new AbortController();controller.current=abort;
  try{
   const current=await load(abort.signal);
   if(collect&&current.online&&current.docker_capabilities.includes('docker.inventory')){
    let job=await api<Job>(`/ops/machines/${encodeURIComponent(machine.id)}/docker-jobs`,{method:'POST',signal:abort.signal,body:JSON.stringify({operation:'inventory',request_id:crypto.randomUUID()})});
    const deadline=Date.now()+125000;
    while(!['succeeded','failed','cancelled','unknown'].includes(job.state)&&Date.now()<deadline){
     await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',finish);resolve()},timer=setTimeout(finish,1500);abort.signal.addEventListener('abort',finish,{once:true});if(abort.signal.aborted)finish()});
     abort.signal.throwIfAborted();job=await api<Job>(`/ops/machines/${encodeURIComponent(machine.id)}/docker-jobs/${encodeURIComponent(job.id)}`,{signal:abort.signal});
    }
    await load(abort.signal);
    if(job.state!=='succeeded')throw Error(t('容器清单刷新未完成，请稍后重试','Container refresh did not complete. Retry shortly.'));
   }
  }catch(e){if(alive.current&&!abort.signal.aborted)setError(e instanceof Error?e.message:t('读取容器失败','Unable to read containers'))}
  finally{if(controller.current===abort){pending.current=false;if(alive.current)setBusy(false)}}
 };
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;controller.current?.abort();pending.current=false}},[machine.id]);
 const names:Record<string,string>={running:t('运行中','Running'),exited:t('已停止','Stopped'),created:t('已创建','Created'),paused:t('已暂停','Paused'),restarting:t('重启中','Restarting'),dead:t('异常退出','Dead'),removing:t('删除中','Removing')};
 const states:Record<string,string>={not_connected:t('尚未安装 Agent，请先部署 Agent 以采集容器清单','Install Agent to collect this host’s container inventory'),waiting:t('等待首次容器观测，请检查 Agent 的 Docker 权限','Waiting for the first observation. Check Agent Docker permissions.'),unavailable:t('Docker 清单暂不可用，请检查 Docker 服务与 Agent 权限','Docker inventory is unavailable. Check Docker and Agent permissions.'),stale:t('当前为历史清单，主机离线或观测已过期','Showing the last inventory; the host is offline or the observation has expired.'),degraded:t('容器采集状态异常，显示最近一次清单','Container collection is degraded; showing the last inventory.')};
 const rows=(host?.containers??[]).filter(c=>(state==='all'||c.state===state)&&(!query.trim()||[c.name,c.image,c.id,c.ports].some(s=>s.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))));
 return <Modal open title={t('全部容器','All containers')+' · '+machine.name} width={1120} style={{top:24}} footer={null} onCancel={onClose} className="lm-host-resource-dialog">
  <Space wrap className="lm-host-resource-toolbar"><Input aria-label={t('搜索容器','Search containers')} prefix={<SearchOutlined/>} allowClear value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('名称、镜像、端口或 ID','Name, image, port or ID')}/><Select aria-label={t('容器状态','Container state')} value={state} onChange={setState} options={[{value:'all',label:t('全部状态','All states')},...[...new Set((host?.containers??[]).map(c=>c.state))].map(value=>({value,label:names[value]??value}))]}/><Button icon={<ReloadOutlined/>} loading={busy} onClick={()=>void refresh(true)}>{t('刷新清单','Refresh inventory')}</Button></Space>
  {busy&&host&&<Typography.Paragraph type="secondary">{t('正在刷新；显示最近一次容器清单…','Refreshing; showing the last container inventory…')}</Typography.Paragraph>}
  {error&&<Alert type="error" showIcon title={error}/>}
  {host&&host.state!=='ready'&&<Alert type="warning" showIcon title={states[host.state]??host.state}/>}
  {host?.truncated&&<Alert type="warning" showIcon title={t('容器数量超过采集上限，当前清单不完整','The collection limit was exceeded; this inventory is incomplete')}/>}
  <Space wrap style={{marginBottom:12}}><Button danger disabled={busy||!host?.docker_capabilities.includes('docker.host.batch')||!selected.length||host?.state!=='ready'||host?.truncated} onClick={()=>setBatchSelection({ids:selected,stoppedOnly:false})}>{t('审阅批量删除','Review selected deletion')} ({selected.length}/50)</Button><Button danger disabled={busy||!host?.docker_capabilities.includes('docker.host.batch')||host?.state!=='ready'||host?.truncated||!host?.containers.some(c=>['exited','created','dead'].includes(c.state))} onClick={()=>{const ids=host!.containers.filter(c=>['exited','created','dead'].includes(c.state)).slice(0,50).map(c=>c.id);setSelected(ids);setBatchSelection({ids,stoppedOnly:true})}}>{t('清理停止容器','Clean stopped containers')}</Button><Button disabled={!host?.online} onClick={()=>setComposeOpen(true)}>{t('接管已有 Compose','Manage existing Compose')}</Button></Space>
  {host?.docker_capabilities.includes('docker.host')&&!host.docker_capabilities.includes('docker.host.batch')&&<Alert type="info" title={t('批量操作需要升级此主机管理组件，单容器功能仍可使用','Upgrade this host’s management component for batch actions; individual actions remain available')}/>}
  {composeOpen&&<ExternalComposeManagement machine={{...machine,agent_id:host?.agent_id}} projects={[...new Set((host?.containers??[]).filter(c=>!c.application_id).map(c=>c.compose_project).filter((v):v is string=>!!v))]} onClose={()=>setComposeOpen(false)}/>}
  <HostContainerManagement key={machine.id} machine={machine} available={!!host&&host.online&&host.state==='ready'&&!host.truncated&&host.docker_capabilities.includes('docker.host')} selection={selection} batchSelection={batchSelection} onBatchSelected={()=>setBatchSelection(undefined)} onSelected={()=>setSelection(undefined)} onChanged={()=>refresh(true)}/>
  <Typography.Paragraph type="secondary">{t('包含平台应用和外部容器','Includes platform applications and external containers')} · {host?.containers.length??0} {t('个容器','containers')}{host?.observed_at&&' · '+t('观测于 ','Observed ')+new Date(host.observed_at).toLocaleString(language)}</Typography.Paragraph>
  <Typography.Paragraph className="lm-host-file-scroll-hint" type="secondary">{t('左右滑动查看完整表格和操作','Swipe horizontally to see the full table and actions')}</Typography.Paragraph>
  <Table<Container> rowKey="id" size="small" loading={busy&&!host} rowSelection={{selectedRowKeys:selected,onChange:keys=>setSelected(keys.map(String).slice(0,50)),getCheckboxProps:()=>({disabled:busy||!host?.online||host.state!=='ready'||host.truncated||!host.docker_capabilities.includes('docker.host.batch')})}} dataSource={rows} pagination={{pageSize:10,showSizeChanger:true}} scroll={{x:1080}} locale={{emptyText:host?.state==='ready'?t('没有匹配的容器','No matching containers'):t('暂无可用容器清单','No container inventory available')}} columns={[
   {title:t('容器','Container'),width:230,render:(_,c)=><><Button type="link" className="lm-host-file-name" disabled={!host?.docker_capabilities.includes('docker.host')} onClick={()=>setSelection({operation:'inspect',id:c.id})}>{c.name||c.id.slice(0,12)}</Button><div><Typography.Text type="secondary" code copyable={{text:c.id}}>{c.id.slice(0,12)}</Typography.Text></div></>},
   {title:t('镜像','Image'),dataIndex:'image',width:260,render:v=><Typography.Text style={{overflowWrap:'anywhere'}}>{v}</Typography.Text>},
   {title:t('状态','State'),dataIndex:'state',width:110,render:v=><Tag color={v==='running'?'success':v==='exited'?'default':'warning'}>{names[v]??v}</Tag>},
   {title:t('端口','Ports'),dataIndex:'ports',width:230,render:v=><Typography.Text style={{overflowWrap:'anywhere'}}>{v||'—'}</Typography.Text>},
   {title:t('归属','Ownership'),width:130,render:(_,c)=><Tag>{c.application_id?t('平台应用','Platform app'):t('外部容器','External')}</Tag>},
   {title:t('操作','Actions'),width:140,fixed:'right',render:(_,c)=><Dropdown trigger={['click']} disabled={busy||!host?.online||host.state!=='ready'||!host.docker_capabilities.includes('docker.host')} menu={{items:[{key:'inspect',label:t('详情与配置','Details and configuration')},{key:'start',label:t('启动','Start'),disabled:c.state==='running'},{key:'stop',label:t('停止','Stop'),disabled:!['running','restarting'].includes(c.state)},{key:'restart',label:t('重启','Restart')},{type:'divider'},{key:'remove',label:t('删除容器','Delete container'),danger:true}],onClick:({key})=>setSelection({operation:key as ContainerSelection['operation'],id:c.id})}}><Button size="small" aria-label={t('容器操作','Container actions')+' · '+(c.name||c.id.slice(0,12))}>{t('管理','Manage')}</Button></Dropdown>}
  ]}/>
 </Modal>;
}
