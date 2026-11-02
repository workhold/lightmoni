import {useEffect,useState} from 'react';
import {Progress,Typography} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {agentOperationMatches,agentOperationProgress,type AgentOperationKind,type AgentOperationRecord} from './agent-operation-progress';

/** Stage evidence only: percentages never advance because time has passed. */
export default function AgentOperationProgress({kind,machineID,record,submitting=false,compact=false,refreshError}:{kind:AgentOperationKind;machineID:string;record:AgentOperationRecord;submitting?:boolean;compact?:boolean;refreshError?:string}){
 const {t}=useI18n(),[now,setNow]=useState(Date.now());
 const valid=agentOperationMatches(record,machineID),progress=agentOperationProgress(kind,record,submitting);
 useEffect(()=>{setNow(Date.now());if(!valid||!progress.active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[valid,record.id,progress.active]);
 if(!valid||record.kind&&record.kind!==kind)return null;
 const statuses:Record<string,string>={awaiting_approval:t('待审阅，尚未执行','Awaiting review; not executed'),submitting:t('正在提交已批准的操作','Submitting the approved operation'),running:kind==='install'?t('正在安装','Installing'):t('正在卸载','Uninstalling'),succeeded:kind==='install'?t('安装完成','Installed'):t('卸载完成','Uninstalled'),failed:t('执行失败','Failed'),cancelled:t('已取消，未完成','Cancelled; not completed'),unknown:t('结果未知，需只读核对','Outcome unknown; read-only verification required'),resolved:t('已人工结束，原结果仍未知','Manually resolved; original outcome remains unknown')};
 const stages:Record<string,string>={planned:t('计划已生成','Plan created'),review:t('计划待审阅，尚未执行','Plan awaits review; not executed'),submitting:t('正在提交已批准的操作','Submitting the approved operation'),preflight:t('检查安装条件','Checking installation prerequisites'),enrollment_issuing:t('签发接入授权','Issuing enrollment authorization'),enrollment_issued:t('接入授权已签发','Enrollment authorization issued'),installing:t('安装执行中，等待阶段更新','Installation running; waiting for a stage update'),bootstrap_dispatched:t('下载并安装 Agent','Downloading and installing Agent'),removing:t('停止服务并移除程序','Stopping the service and removing Agent'),complete:kind==='install'?t('已确认 Agent 激活','Agent activation confirmed'):t('已核验 Agent 移除','Agent removal verified')};
 const start=Date.parse(record.started_at||''),end=Date.parse(record.finished_at||'');
 const elapsed=Number.isFinite(start)?Math.max(0,Math.floor(((Number.isFinite(end)?end:now)-start)/1000)):undefined;
 const name=t(kind==='install'?'Agent 安装进度':'Agent 卸载进度',kind==='install'?'Agent installation progress':'Agent removal progress');
 return <section aria-label={name} data-agent-operation-id={record.id} data-agent-operation-machine={machineID} data-agent-operation-status={progress.status} style={{minWidth:0,maxWidth:'100%',marginBlock:compact?6:12,overflowWrap:'anywhere'}}>
  <Typography.Text strong={!compact}>{statuses[progress.status]||progress.status}</Typography.Text>
  <Progress aria-label={name} percent={progress.percent} status={record.status==='succeeded'?'success':record.status==='failed'||record.status==='unknown'?'exception':progress.active?'active':'normal'} showInfo={false} size={compact?'small':'default'}/>
  <Typography.Text type="secondary" style={{display:'block',fontSize:compact?12:undefined}}>{t('阶段进度：','Stage progress: ')}{stages[progress.stage]}{elapsed!==undefined?' · '+t('已耗时 '+elapsed+' 秒','Elapsed '+elapsed+' seconds'):''}</Typography.Text>
  {record.error&&<Typography.Text type="danger" style={{display:'block'}}>{record.error}</Typography.Text>}
  {(record.status==='unknown'||record.resolved_at)&&<Typography.Text type="warning" style={{display:'block'}}>{t('请查看原记录并只读核对，不会自动重试。','Open the original record for read-only verification. No automatic retry occurs.')}</Typography.Text>}
  {refreshError&&<Typography.Text type="warning" style={{display:'block'}}>{refreshError}</Typography.Text>}
 </section>;
}
