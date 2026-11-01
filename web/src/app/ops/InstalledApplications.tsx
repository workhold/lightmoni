import ApplicationLogo from './ApplicationLogo';
import { AppstoreOutlined } from '@ant-design/icons';
import { Button, Empty, Popconfirm, Space, Tag, Typography } from '../../shared/ui';
import { useI18n } from '../../shared/i18n';
import { resourceState, type Resource, type Machine, type Spec } from './model';
import { installDiagnostic } from './install-state';

export default function InstalledApplications({applications,resources,machines,onEdit,onLogo,onAction,onProgress,onDetails,onMonitor,onDelete,onStore,filter}:{applications:Resource[];resources:Resource[];machines:Machine[];onEdit:(r:Resource)=>void;onLogo:(r:Resource)=>void;onAction:(r:Resource,action:string)=>void;onProgress:(r:Resource)=>void;onDetails:(r:Resource)=>void;onMonitor:(r:Resource)=>void;onDelete:(r:Resource)=>void;onStore:()=>void;filter:string}){
 const {t}=useI18n();
 const labels:Record<string,[string,string]>={running:['运行中','Running'],pending:['待处理','Pending'],queued:['排队中','Queued'],failed:['失败','Failed'],unknown:['结果未知','Unknown'],stopped:['已停止','Stopped'],removed:['已卸载','Uninstalled'],configured:['未部署','Not deployed'],degraded:['部分失败','Degraded']};
 const state=(r:Resource)=>resourceState(r),name=(id:string)=>resources.find(r=>r.id===id)?.name??id;
 const filtered=applications.filter(r=>filter==='all'||(filter==='failed'?['failed','degraded','error','unknown'].includes(state(r)):filter==='pending'?!['running','stopped','failed','degraded','error','unknown'].includes(state(r)):state(r)===filter));
 return <>
 {filtered.length?<div className="lm-installed-apps">{filtered.map(r=>{
  const current=(r.status.instances??[]).filter((i:Spec)=>!i.retired&&i.state!=='removed'),s=state(r),unknown=s==='unknown',running=s==='running';
  const error=Object.values<Spec>(r.status.deployments??{}).find(d=>d.last_error)?.last_error??r.status.last_error;

  return <article key={r.id} className="lm-installed-app" aria-label={r.name}>
   <div className="lm-app-card-heading"><ApplicationLogo name={r.name} templateID={r.spec.source?.template_id??(['registry','openresty'].includes(r.spec.role)?r.spec.role:undefined)} url={r.logo_url}/><div className="lm-app-card-title"><h3><Button type="link" onClick={()=>onDetails(r)}>{r.name}</Button></h3><Typography.Text type="secondary">{r.spec.service_name}</Typography.Text></div><Tag color={running?'success':['failed','error','degraded'].includes(s)?'error':unknown?'warning':'default'}>{labels[s]?t(...labels[s]):s}</Tag></div>
   <div className="lm-app-card-version"><Tag>{r.spec.role==='registry'||r.spec.role==='openresty'?t('系统应用','System application'):r.spec.source?.type==='store'?t('应用商店','Application store'):t('自定义','Custom')}</Tag><span>{r.spec.source?.template_version??r.spec.image??Object.values<Spec>(r.spec.compose?.services??{}).map(s=>s.image).join(' · ')}</span><Typography.Text type="secondary">v{r.revision}</Typography.Text></div>
   <div className="lm-app-placements">{(r.spec.deployments??[]).map((d:Spec)=>{
    const instances=current.filter((i:Spec)=>i.cluster_id===d.cluster_id);
    return <div key={d.cluster_id}><strong>{name(d.cluster_id)}</strong><span>{r.spec.deployment_mode==='managed'?t('自动调度','Automatic scheduling')+' · '+d.replicas+' '+t('实例','instances'):(d.machine_ids??[]).map((id:string)=>machines.find(m=>m.id===id)?.name??id).join(' · ')}</span><div className="lm-app-card-ports">{instances.length?instances.flatMap((i:Spec)=>(i.ports??[]).map((p:Spec)=><Typography.Text key={i.id+':'+p.name} code title={(i.healthy?t('就绪端口','Ready port'):t('已分配端口','Allocated port'))+' · '+(p.host_ip??i.address??'')}>{p.host_ip??'0.0.0.0'}:{p.host_port} → {p.container_port}/{p.protocol??'tcp'}</Typography.Text>)):<Typography.Text type="secondary">{t('等待部署分配端口','Ports will be assigned on deployment')}</Typography.Text>}</div></div>;
   })}</div>
   {error&&<p className="lm-ops-error-text">{t(...installDiagnostic(error).slice(0,2) as [string,string])} <code>{String(error)}</code></p>}
   <div className="lm-app-card-actions"><Space wrap size={6}><Button size="small" onClick={()=>onEdit(r)}>{t('配置','Configure')}</Button><Button size="small" onClick={()=>onLogo(r)}>{t('Logo','Logo')}</Button><Button size="small" onClick={()=>onAction(r,unknown?'inspect':'deploy')}>{unknown?t('核对状态','Inspect state'):running||s==='failed'?t('重新部署','Redeploy'):['stopped','removed'].includes(s)?t('启动','Start'):t('部署','Deploy')}</Button><Button size="small" disabled={!current.length||unknown||s==='stopped'} onClick={()=>onAction(r,'stop')}>{t('停止','Stop')}</Button><Button size="small" onClick={()=>onProgress(r)}>{t('安装记录','Installation history')}</Button><Button size="small" onClick={()=>onMonitor(r)}>{t('监控与日志','Monitoring & logs')}</Button></Space><Space size={0}><Button type="text" size="small" onClick={()=>onAction(r,'remove')} disabled={!current.length||unknown}>{t('卸载容器','Uninstall containers')}</Button><Popconfirm title={t('删除应用登记？','Delete application registration?')} description={t('需先卸载容器并解除引用。持久化数据保留。','Uninstall containers and remove references first. Persistent data is retained.')} onConfirm={()=>onDelete(r)} okText={t('删除','Delete')} cancelText={t('取消','Cancel')}><Button size="small" type="text" danger>{t('删除登记','Delete registration')}</Button></Popconfirm></Space></div>
  </article>;
 })}</div>:<Empty description={applications.length?t('没有符合状态的应用','No applications match this state'):t('还没有安装应用','No applications installed')}><Button type="primary" onClick={onStore}>{t('前往应用商店','Browse application store')}</Button></Empty>}
 </>;
}
