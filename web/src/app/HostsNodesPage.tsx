import {Tabs} from '../shared/ui';
import {useSearchParams} from 'react-router-dom';
import type {User} from '../shared/types';
import {useI18n} from '../shared/i18n';
import MachinesPage from './MachinesPage';
import TaskCenterPage from './TaskCenterPage';

export default function HostsNodesPage({user}:{user:User}){
 const {t}=useI18n();
 const [params,setParams]=useSearchParams();
 const tab=params.get('tab'),active=tab==='tasks'||tab==='labels'?tab:'nodes';
 return <div className="lm-page lm-hosts-nodes-page">


  <Tabs activeKey={active} onChange={next=>setParams(previous=>{const updated=new URLSearchParams(previous);if(next==='nodes')updated.delete('tab');else updated.set('tab',next);return updated;})} items={[
   {key:'nodes',label:t('主机','Hosts'),children:<MachinesPage user={user} embedded/>},
   {key:'tasks',label:t('任务中心','Task center'),children:<TaskCenterPage user={user} tab="tasks"/>},
   {key:'labels',label:t('主机标签','Host labels'),children:<TaskCenterPage user={user} tab="labels"/>},
  ]}/>
  <details className="lm-host-page-help"><summary>{t('主机接入与任务说明','About host enrollment and tasks')}</summary><p>{t('Agent 负责采集、上报和定时任务；中心发起的机器操作通过 SSH 执行。平台默认启用指标采集；服务拨测与目录日志填写目标后开始采集。用户脚本需要完整管理模式，所有执行保留记录。SDK 独立向平台上报。','Agent handles collection, reporting, and scheduled tasks; the center runs host operations over SSH. Metrics are enabled by default; service probes and directory logs start after targets are configured. Custom scripts require full management, and all executions are recorded. SDKs report directly to the platform.')}</p></details>
 </div>;
}
