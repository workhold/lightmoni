import ApplicationLogo from './ApplicationLogo';
import {useState} from 'react';
import {ApplicationBackupDialog} from '../BackupTools';
import {ArrowUpOutlined,CloudUploadOutlined,CodeOutlined,EllipsisOutlined,HistoryOutlined,LineChartOutlined,PlayCircleOutlined,ReloadOutlined,SettingOutlined} from '@ant-design/icons';
import IconAction from './IconAction';
import {App,Button,Dropdown,Empty,Space,Tag,Typography} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';
import {resourceState,filterApplicationsByState,publishedApplicationRevisions,type Resource,type Machine,type Spec} from './model';
import {installDiagnostic} from './install-state';
import {recoveryMessage} from './recovery-state';

type Props={applications:Resource[];resources:Resource[];machines:Machine[];onEdit:(r:Resource)=>void;onLogo:(r:Resource)=>void;onAction:(r:Resource,action:string)=>void;onProgress:(r:Resource)=>void;onDetails:(r:Resource)=>void;onMonitor:(r:Resource)=>void;onDelete:(r:Resource)=>void;onUpgrade:(r:Resource)=>void;onTerminal:(r:Resource)=>void;onStore:()=>void;filter:string};
export default function InstalledApplications({applications,resources,machines,onEdit,onLogo,onAction,onProgress,onDetails,onMonitor,onDelete,onUpgrade,onTerminal,onStore,filter}:Props){
 const {t}=useI18n(),{modal}=App.useApp(),[backup,setBackup]=useState<Resource>();
 const labels:Record<string,[string,string]>={running:['运行中','Running'],pending:['待处理','Pending'],unverified:['待核实','Unverified'],queued:['排队中','Queued'],failed:['失败','Failed'],unknown:['结果未知','Unknown'],stopped:['已停止','Stopped'],removed:['已卸载','Uninstalled'],configured:['未部署','Not deployed'],degraded:['部分失败','Degraded']};
 const state=(r:Resource)=>resourceState(r),name=(id:string)=>resources.find(r=>r.id===id)?.name??id;
 const filtered=filterApplicationsByState(applications,filter),hasApplications=resources.some(r=>r.kind==='application');
 return filtered.length?<div className="lm-installed-apps">{filtered.map(r=>{
   const instances:Spec[]=r.status.instances??[],nonRetired=instances.filter((i:Spec)=>!i.retired),current=nonRetired.filter((i:Spec)=>i.state!=='removed'),s=state(r),unknown=s==='unknown',running=s==='running';
  const enabledClusters=new Set(Object.entries<Spec>(r.status.deployments??{}).filter(([,d])=>d.enabled&&Number(d.desired_revision)>0).map(([id])=>id));
  const blocked=nonRetired.find((i:Spec)=>i.unresolved_run_id||i.state==='unknown'||i.recovery?.state==='blocked'&&(i.recovery?.code??i.recovery?.error)==='unknown_execution_result');
  const published=publishedApplicationRevisions(r);
  const error=Object.entries<Spec>(r.status.deployments??{}).find(([id,d])=>enabledClusters.has(id)&&d.last_error)?.[1].last_error??(s==='failed'?r.status.last_error:undefined);
  const image=r.spec.source?.template_version??r.spec.image??Object.values<Spec>(r.spec.compose?.services??{}).map(s=>s.image).join(' · ');
  const inspect=unknown||s==='unverified'||!!blocked;
  const deployLabel=inspect?t('核对状态','Inspect state'):running||s==='failed'?t('重新部署','Redeploy'):['stopped','removed'].includes(s)?t('启动','Start'):t('部署','Deploy');
  const inspectOrDeploy=()=>{if(inspect)onProgress(r);else onAction(r,'deploy')};
  return <article key={r.id} className="lm-installed-app" aria-label={r.name}>
   <div className="lm-app-card-heading"><ApplicationLogo name={r.name} templateID={r.spec.source?.template_id??(['registry','openresty'].includes(r.spec.role)?r.spec.role:undefined)} url={r.logo_url}/><div className="lm-app-card-title"><h3><Button type="link" onClick={()=>onDetails(r)}>{r.name}</Button></h3><Typography.Text type="secondary">{r.spec.service_name}</Typography.Text></div><Tag color={running?'success':['failed','error','degraded'].includes(s)?'error':inspect?'warning':'default'}>{labels[s]?t(...labels[s]):s}</Tag>{running&&blocked&&<Tag color="warning">{t('另有执行结果待核对','Another execution needs verification')}</Tag>}</div>
   <div className="lm-app-card-version"><span className="lm-app-type">{r.spec.role==='registry'||r.spec.role==='openresty'?t('系统应用','System application'):r.spec.source?.type==='store'?t('应用商店','Application store'):t('自定义应用','Custom application')}</span><span>{r.spec.deployment_mode==='managed'?t('托管部署','Managed deployment'):t('手动部署','Manual deployment')}</span><Typography.Text type="secondary">{t('配置','Configuration')} v{r.revision}</Typography.Text>{published.some(version=>version!==r.revision)&&<><Tag color="warning">{published.includes(r.revision)?t('部分集群未发布当前配置','Current configuration unpublished in some clusters'):t('当前配置未发布','Current configuration unpublished')}</Tag><Typography.Text type="secondary">{t('已发布','Published')} {published.map(version=>'v'+version).join(' / ')}</Typography.Text></>}{r.upgrade?.available&&<Tag color="blue">{t('可升级','Update available')} · {r.upgrade.target_version}</Tag>}</div>
   <Typography.Text className="lm-app-image" ellipsis={{tooltip:image}}>{image}</Typography.Text>
   <div className="lm-app-placements">{(r.spec.deployments??[]).map((d:Spec)=>{
    const instances=current.filter((i:Spec)=>i.cluster_id===d.cluster_id);
    const recovery:[string,string]|undefined=instances.map((i:Spec)=>recoveryMessage(i.recovery)).find(Boolean);
    return <div key={d.cluster_id}><div className="lm-app-placement-heading"><strong>{name(d.cluster_id)}</strong><span>{r.spec.deployment_mode==='managed'?t('自动调度','Automatic scheduling')+' · '+d.replicas+' '+t('实例','instances'):(d.machine_ids??[]).map((id:string)=>machines.find(m=>m.id===id)?.name??id).join(' · ')}</span></div>{r.spec.deployment_mode==='managed'&&<Typography.Text type="secondary">{t('确认就绪','Confirmed ready')} {r.status.deployments?.[d.cluster_id]?.ready_instances??0} / {d.replicas} · {t('最低保留','Minimum retained')} {Math.ceil(d.replicas*(d.min_available_percent??60)/100)}</Typography.Text>}{instances.some((i:Spec)=>i.state==='draining')&&<Tag color="processing">{t('等待切流确认与排空','Waiting for route confirmation and drain')}</Tag>}{instances.some((i:Spec)=>i.availability==='grace')&&<Tag color="warning">{t('宽限中，保留服务地址','Within grace; addresses retained')}</Tag>}{instances.some((i:Spec)=>i.availability==='retained')&&<Tag color="warning">{t('服务地址已保留，按中心配置恢复','Addresses retained; restoring center configuration')}</Tag>}{instances.some((i:Spec)=>i.availability==='protected')&&<Tag color="warning">{t('可用性保护，等待就绪替换','Availability protected; awaiting ready replacement')}</Tag>}{recovery&&<p className="lm-ops-note" role="status">{t(...recovery)}</p>}<div className="lm-app-card-ports">{instances.length?instances.flatMap((i:Spec)=>(i.ports??[]).map((p:Spec)=><Typography.Text key={i.id+':'+p.name} code title={(i.healthy?t('就绪端口','Ready port'):t('已分配端口','Allocated port'))+' · '+(p.host_ip??i.address??'')}>{p.host_ip??'0.0.0.0'}:{p.host_port} → {p.container_port}/{p.protocol??'tcp'}</Typography.Text>)):<Typography.Text type="secondary">{t('等待部署分配端口','Ports will be assigned on deployment')}</Typography.Text>}</div></div>;
   })}</div>
   {error&&<p className="lm-ops-error-text" title={String(error)}>{t(...installDiagnostic(error).slice(0,2) as [string,string])}</p>}
   <div className="lm-app-card-actions"><Space wrap size={8}><IconAction label={t('监控与日志','Monitoring & logs')} className="lm-monitor-action" icon={<LineChartOutlined aria-hidden/>} onClick={()=>onMonitor(r)}/><IconAction label={t('容器终端','Container terminal')} icon={<CodeOutlined aria-hidden/>} onClick={()=>onTerminal(r)}/><IconAction label={t('配置','Configure')} icon={<SettingOutlined aria-hidden/>} onClick={()=>onEdit(r)}/><IconAction label={t('升级','Upgrade')} disabled={inspect} type={r.upgrade?.available?'primary':'default'} icon={<ArrowUpOutlined aria-hidden/>} onClick={()=>onUpgrade(r)}/><IconAction label={t('安装记录','Installation history')} icon={<HistoryOutlined aria-hidden/>} onClick={()=>onProgress(r)}/>{(!running||!!blocked)&&<IconAction label={deployLabel} hint={inspect?t('先核对应用原执行记录','Inspect the original application execution first'):undefined} type={inspect?'default':'primary'} icon={inspect?<ReloadOutlined aria-hidden/>:['stopped','removed'].includes(s)?<PlayCircleOutlined aria-hidden/>:<CloudUploadOutlined aria-hidden/>} onClick={inspectOrDeploy}/>}</Space>
    <Dropdown trigger={['click']} menu={{items:[
     ...(running&&!blocked?[{key:'deploy',label:deployLabel}]:[]),
     {key:'stop',label:t('停止','Stop'),disabled:!current.length||inspect||s==='stopped'},
     {key:'logo',label:t('设置 Logo','Set logo')},
     {key:'backup',label:t('备份应用','Back up application')},
     {type:'divider'},
     {key:'remove',label:t('卸载容器','Uninstall containers'),disabled:!current.length||inspect,danger:true},
     {key:'delete',label:t('删除登记','Delete registration'),disabled:inspect,danger:true},
    ],onClick:({key})=>{if(key==='backup')setBackup(r);else if(key==='logo')onLogo(r);else if(key==='delete')modal.confirm({title:t('删除应用登记？','Delete application registration?'),content:t('需先卸载容器并解除引用。持久化数据保留。','Uninstall containers and remove references first. Persistent data is retained.'),okText:t('删除','Delete'),cancelText:t('取消','Cancel'),okButtonProps:{danger:true},onOk:()=>onDelete(r)});else onAction(r,key)}}}><IconAction label={t('更多操作','More actions')} type="text" aria-label={t('更多操作','More actions')+' · '+r.name} icon={<EllipsisOutlined aria-hidden/>}/></Dropdown>
   </div>
  </article>;
 })}<ApplicationBackupDialog application={backup} onClose={()=>setBackup(undefined)}/></div>:<Empty description={hasApplications?t('没有符合筛选条件的应用','No applications match your filters'):t('还没有安装应用','No applications installed')}>{!hasApplications&&<Button type="primary" onClick={onStore}>{t('前往应用商店','Browse application store')}</Button>}</Empty>;
}
