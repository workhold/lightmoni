import {Tabs,Alert} from '../shared/ui';
import {useSearchParams} from 'react-router-dom';
import type {User} from '../shared/types';
import {useI18n} from '../shared/i18n';
import MachinesPage from './MachinesPage';
import AgentsPage from './AgentsPage';

export default function HostsNodesPage({user}:{user:User}){
 const {t}=useI18n();
 const [params,setParams]=useSearchParams();
 const tab=params.get('tab'),active=tab==='tasks'||tab==='labels'?tab:'nodes';
 return <div className="lm-page lm-hosts-nodes-page">
  <div className="lm-page-heading"><div><h1>{t('主机与节点','Hosts & nodes')}</h1><p>{t('主机安装并接入 LightMoni Agent 后具备节点能力；按任务标签执行监控任务，通过 Agent 通道接受平台与 AI 助手的已授权操作。','A host becomes a node after enrolling LightMoni Agent. Task labels assign monitoring work; the Agent channel handles authorized platform and AI assistant operations.')}</p></div></div>
  <Alert className="lm-machine-notice" type="info" showIcon title={t('日常任务通过 Agent，SSH 用于接入与恢复','Use Agent for ongoing tasks, SSH for enrollment and recovery')} description={t('已支持周期指标采集、拨测、目录日志及平台提供的固定运维工具。通用定时脚本、任意命令和 Agent 自卸载尚未提供；SDK 可独立向平台上报。','Periodic metrics, probes, directory logs, and supported fixed operations are available. General scheduled scripts, arbitrary commands, and Agent self-uninstall are not available; SDKs report directly to the platform.')}/>
  <Tabs activeKey={active} onChange={next=>setParams(previous=>{const updated=new URLSearchParams(previous);if(next==='nodes')updated.delete('tab');else updated.set('tab',next);return updated;})} items={[
   {key:'nodes',label:t('主机与节点','Hosts & nodes'),children:<MachinesPage user={user} embedded/>},
   {key:'tasks',label:t('监控任务','Monitoring tasks'),children:<AgentsPage user={user} embeddedTab="tasks"/>},
   {key:'labels',label:t('任务标签','Task labels'),children:<AgentsPage user={user} embeddedTab="labels"/>},
  ]}/>
 </div>;
}
