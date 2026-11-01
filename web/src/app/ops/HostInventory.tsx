import DockerEnvironmentPanel from './DockerEnvironmentPanel';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Drawer,Empty,Input,Space,Table,Tabs,Tag} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,time,type Spec} from './model';

/** Historical inventory is read from the centre; ordinary Agent control is removed. */
export default function HostInventory({machine,onClose}:{machine?:{id:string;name:string};onClose:()=>void}){
 const {t}=useI18n(),navigate=useNavigate();
 const [dockerOpen,setDockerOpen]=useState(false),[activeTab,setActiveTab]=useState('applications'),[data,setData]=useState<Spec>({hosts:[],applications:[]});
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[search,setSearch]=useState('');
 const request=useRef(0);
 const load=useCallback(async()=>{
  if(!machine)return;const current=++request.current;setLoading(true);
  try{const result=await api<Spec>('/ops/inventory?machine_id='+encodeURIComponent(machine.id));if(current===request.current){setData(result);setError('')}}
  catch(e){if(current===request.current)setError(errorText(e))}
  finally{if(current===request.current)setLoading(false)}
 },[machine?.id]);
 useEffect(()=>{setDockerOpen(false);setActiveTab('applications');setData({hosts:[],applications:[]});setSearch('');setError('');if(!machine)return;void load();return()=>{request.current++}},[machine?.id,load]);
 const host=data.hosts?.[0],containers=(host?.containers??[]).filter((c:Spec)=>!search||[c.name,c.image,c.id].some(v=>String(v).toLowerCase().includes(search.toLowerCase())));
 return <><DockerEnvironmentPanel machine={dockerOpen?machine:undefined} onClose={()=>{setDockerOpen(false);void load();}}/>
 <Drawer title={t('主机应用与 Docker','Host applications & Docker')+' · '+(machine?.name??'')} open={!!machine} size={1100} onClose={onClose} destroyOnHidden>
  <Alert type="info" showIcon title={t('旧容器操作通道已移除','Legacy container operations were removed')} description={t('历史清单仅供参考。请前往主机执行权限，使用独立执行器的受管容器操作；网站、Compose 等业务部署尚未接入新通道。','Historical inventory is for reference. Open host execution permissions for managed container operations through the independent executor. Website and Compose deployment profiles are not yet connected.')}/>
  <div className="lm-ops-section-heading"><span className="lm-ops-note">{host?.observed_at&&Date.parse(host.observed_at)>0?t('历史清单','Historical inventory')+' · '+time(host.observed_at):t('暂无历史容器清单','No historical container inventory')}</span><Button loading={loading} icon={<ReloadOutlined/>} onClick={()=>void load()}>{t('刷新平台记录','Refresh platform records')}</Button></div>
  {error&&<Alert showIcon type="error" title={error}/>}
  <Space wrap style={{marginBottom:12}}><Button onClick={()=>setDockerOpen(true)}>{t('检查 / 安装 Docker 环境','Check / install Docker environment')}</Button><Button onClick={()=>{onClose();navigate('/machines?machine='+encodeURIComponent(machine!.id))}}>{t('前往主机执行权限','Open host execution permissions')}</Button></Space>
  <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
   {key:'applications',label:t('平台应用','Platform applications')+` (${data.applications?.length??0})`,children:<Table<Spec> loading={loading} size="small" rowKey="id" dataSource={data.applications??[]} pagination={{pageSize:10}} locale={{emptyText:<Empty description={<>{t('此主机暂无平台应用','No platform applications on this host')}{host?.containers?.length>0&&<p><Button type="link" onClick={()=>setActiveTab('docker')}>{t('查看历史 Docker 清单','View historical Docker inventory')}</Button></p>}</>}/>}} columns={[
    {title:t('应用','Application'),render:(_,a)=><><strong>{a.name}</strong><small>{a.spec.service_name}</small></>},
    {title:t('部署','Deployments'),render:(_,a)=>(a.status.instances??[]).map((i:Spec)=><div key={i.id}>{i.state} · {i.id.slice(0,12)}</div>)},
    {title:t('操作','Actions'),render:(_,a)=><Button onClick={()=>{onClose();navigate('/applications/'+a.id+'/monitoring?machine_id='+encodeURIComponent(machine!.id))}}>{t('监控与日志','Monitoring & logs')}</Button>},
   ]}/>},
   {key:'docker',label:t('历史 Docker 清单','Historical Docker inventory')+` (${host?.containers?.length??0})`,children:<>
    <Input.Search allowClear aria-label={t('搜索容器','Search containers')} placeholder={t('搜索容器名称、镜像或 ID','Search container name, image or ID')} value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:380,marginBottom:16}}/>
    <Table<Spec> rowKey="id" loading={loading} size="small" dataSource={containers} pagination={{pageSize:15}} scroll={{x:900}} locale={{emptyText:<Empty description={t('暂无匹配的历史容器记录','No matching historical container records')}/>}} columns={[
     {title:t('容器','Container'),render:(_,c)=><><strong>{c.name}</strong><small>{c.id.slice(0,12)}</small></>},
     {title:t('镜像','Image'),dataIndex:'image'},
     {title:t('历史状态','Historical state'),dataIndex:'state',render:v=><Tag>{v}</Tag>},
     {title:t('端口','Ports'),dataIndex:'ports'},
     {title:t('登记归属','Registered ownership'),render:(_,c)=>c.application_id?<Button type="link" onClick={()=>{onClose();navigate('/applications/'+c.application_id+'/monitoring?container_id='+c.id)}}>{data.applications.find((a:Spec)=>a.id===c.application_id)?.name??t('平台应用','Platform application')}</Button>:<Tag>{c.deployment_id?t('未关联平台应用','Unlinked platform application'):t('非平台创建','External container')}</Tag>},
    ]}/>
   </>},
  ]}/>
 </Drawer></>;
}
