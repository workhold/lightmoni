import {Tabs,Alert} from '../shared/ui';
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
  <div className="lm-page-heading"><div><h1>{t('主机','Hosts')}</h1><p>{t('主机标签用于分类和任务派发；安装 Agent 后可执行内置采集、自定义脚本及平台和 AI 助手的已授权操作。','Host labels organize assets and target tasks. Enrolled Agents execute built-in collection, custom scripts, and authorized platform and AI assistant operations.')}</p></div></div>
  <Alert className="lm-machine-notice" type="info" showIcon title={t('日常任务通过 Agent，SSH 用于接入与恢复','Use Agent for ongoing tasks, SSH for enrollment and recovery')} description={t('指标采集与服务拨测默认启用；任务中心可调整内置任务或派发自定义脚本。SDK 独立向平台上报。','Metrics and service probes are enabled by default. Adjust built-in tasks or dispatch custom scripts in Task center. SDKs report directly to the platform.')}/>
  <Tabs activeKey={active} onChange={next=>setParams(previous=>{const updated=new URLSearchParams(previous);if(next==='nodes')updated.delete('tab');else updated.set('tab',next);return updated;})} items={[
   {key:'nodes',label:t('主机','Hosts'),children:<MachinesPage user={user} embedded/>},
   {key:'tasks',label:t('任务中心','Task center'),children:<TaskCenterPage user={user} tab="tasks"/>},
   {key:'labels',label:t('主机标签','Host labels'),children:<TaskCenterPage user={user} tab="labels"/>},
  ]}/>
 </div>;
}
