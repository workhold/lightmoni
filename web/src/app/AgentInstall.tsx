import {useI18n} from '../shared/i18n';
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {api,post} from '../shared/api';
import {Alert,Button,Form,Input,Select,Space,Tag,Typography} from '../shared/ui';
import type {User} from '../shared/types';
import ReportingAddressInput from './ReportingAddressInput';
import {sdkEndpointError} from './sdkExamples';
import {agentInstallCommand,type AgentInstallMetadata as Metadata} from './agentInstallCommand';
interface TaskLabel {id:string;name:string;node_count:number;task_count:number}
interface InstallTask {id:string;type:'host'|'probe'|'log';enabled:boolean;label_ids:string[];config:{host_table?:string;probe_table?:string;log_table?:string}}
interface EnrollmentCreated {enrollment_id:string;token_display_once:string;token_expires_at:string;install_command_hint:string}

function endpointOrigin(value:string):string {
 try{return new URL(value.trim()).origin;}catch{return value.trim().replace(/\/+$/,'');}
}

export default function AgentInstall({user,initialGroup}:{user:User;initialGroup?:string}) {
 const {t,language:uiLanguage}=useI18n();

 const [metadata,setMetadata]=useState<Metadata>(),[labels,setLabels]=useState<TaskLabel[]>([]),[tasks,setTasks]=useState<InstallTask[]>([]),[labelID,setLabelID]=useState(initialGroup??'default'),[loaded,setLoaded]=useState(false),[reload,setReload]=useState(0);
 const [endpoint,setEndpoint]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[tokenCopied,setTokenCopied]=useState(false),[enrollmentToken,setEnrollmentToken]=useState(''),[tokenExpires,setTokenExpires]=useState('');
 useEffect(()=>{let active=true;setLoaded(false);setError('');setEnrollmentToken('');setTokenExpires('');Promise.all([api<Metadata>('/agent-install'),api<TaskLabel[]>('/agent-task-labels'),api<InstallTask[]>('/agent-tasks')]).then(([metadata,labels,tasks])=>{if(!active)return;setMetadata(metadata);setLabels(labels);setTasks(tasks);setEndpoint(metadata.endpoint||window.location.origin);const requested=initialGroup??'default';setLabelID(labels.some(label=>label.id===requested)?requested:initialGroup?'':labels[0]?.id??'');if(initialGroup&&!labels.some(label=>label.id===initialGroup))setError(t("接入链接中的任务标签不存在，请重新选择初始任务标签。","The task label in this enrollment link no longer exists. Select an initial task label."));setLoaded(true)}).catch(error=>{if(active)setError(error.message)});return()=>{active=false}},[initialGroup,reload]);
 useEffect(()=>{setCopied(false);setTokenCopied(false)},[endpoint,labelID,enrollmentToken]);
 const label=labels.find(label=>label.id===labelID);
 const matchedTasks=tasks.filter(task=>task.enabled&&task.label_ids.includes(labelID));
 const endpointError=sdkEndpointError(endpoint,uiLanguage),validEndpoint=!!endpoint&&!endpointError;
 const command=metadata&&loaded&&label&&enrollmentToken?agentInstallCommand(metadata,endpoint,labelID):'';
 const createEnrollment=async()=>{
  if(!metadata||!label||!validEndpoint||user.role!=='admin')return;
  setBusy(true);setError('');setEnrollmentToken('');setTokenExpires('');
  try{
   const result=await post<EnrollmentCreated>('/agent-enrollments',{endpoint_origin:endpointOrigin(endpoint),version:metadata.version,initial_label_id:labelID,scopes:['agent.control','agent.data']});
   setEnrollmentToken(result.token_display_once);setTokenExpires(result.token_expires_at);
  }catch(error){setError((error as Error).message)}finally{setBusy(false)}
 };
 const copy=(value:string,done:(v:boolean)=>void,label:string)=>void navigator.clipboard.writeText(value).then(()=>done(true)).catch(()=>setError(t(`${label}复制失败，请重新尝试`,`Unable to copy ${label}. Try again`)));
 return <div className="lm-surface">
  <h2>{t("接入执行节点","Enroll execution node")}</h2><p>{t("为目标 Linux 主机生成一次性接入令牌并安装 LightMoni Agent。Agent 作为独立 systemd 服务运行，接入后会同步所选任务标签匹配的启用任务。","Create a one-time enrollment token and install LightMoni Agent on a Linux host. The Agent runs as an independent systemd service and syncs enabled tasks matching its selected labels after enrollment.")}</p><Tag>Linux · amd64 / arm64 · systemd</Tag>
  {error&&<Alert type="error" title={error} action={!loaded?<Button size="small" onClick={()=>setReload(value=>value+1)}>{t("重新读取","Reload")}</Button>:undefined} style={{marginTop:16}}/>}
  <Form layout="vertical" style={{maxWidth:760,marginTop:20}}>
   <Form.Item label={t("初始任务标签","Initial task label")} extra={<Link to="/agents?tab=labels">{t("管理任务标签","Manage task labels")}</Link>}><Select showSearch={{optionFilterProp:'label'}} aria-label={t("初始任务标签","Initial task label")} value={labelID||undefined} onChange={value=>{setLabelID(value);setEnrollmentToken('');setTokenExpires('');setError('')}} disabled={!loaded||busy} options={labels.map(label=>({value:label.id,label:label.name}))}/></Form.Item>
   <Form.Item label={t("上报地址","Reporting address")} validateStatus={endpoint&&!validEndpoint?'error':undefined} help={endpoint&&!validEndpoint?endpointError:undefined} extra={<Space wrap><span>{t("从已配置地址中选择，也可填写临时地址；安装包直接从所选地址下载。","Select a configured address or enter a temporary one. Installation packages are downloaded from that address.")}</span>{metadata&&<Button size="small" disabled={endpoint===metadata.endpoint||busy} onClick={()=>setEndpoint(metadata.endpoint)}>{t("恢复默认地址","Restore default address")}</Button>}{user.role==='admin'&&<Link to="/admin?tab=reporting">{t("设置默认地址","Set default address")}</Link>}</Space>}><ReportingAddressInput label={t("节点上报地址","Node reporting address")} value={endpoint} onChange={value=>{setEndpoint(value);setEnrollmentToken('');setTokenExpires('')}} addresses={metadata?.endpoints} defaultID={metadata?.default_endpoint_id} error={endpointError} placeholder={t("选择内网或公网地址","Select an internal or public address")}/></Form.Item>
  </Form>
  {loaded&&label&&!matchedTasks.length&&<Alert type="info" showIcon title={t("此任务标签暂未匹配启用任务","No enabled tasks match this label yet")} description={t("节点接入后不会采集指标、目录日志或执行拨测；后续可在节点助手中绑定其他任务标签。","The enrolled node will not collect metrics or directory logs or run probes. You can assign other task labels later in Node assistant.")} style={{marginBottom:16}}/>}
  {user.role==='admin'?<Space wrap><Button type="primary" disabled={!loaded||!label||!validEndpoint||busy} loading={busy} onClick={()=>void createEnrollment()}>{enrollmentToken?t("重新生成一次性接入令牌","Create a new one-time enrollment token"):t("生成一次性接入令牌","Create one-time enrollment token")}</Button><Link to="/agents">{t("查看执行节点与任务","View execution nodes and tasks")}</Link><Link to="/admin?tab=credentials&section=enrollments">{t("管理接入凭据","Manage access credentials")}</Link></Space>:<Alert type="info" showIcon title={t("只有管理员可以生成节点接入令牌","Only administrators can create node enrollment tokens")} description={t("请联系管理员为这台主机生成一次性令牌；令牌只会在生成后显示一次。","Ask an administrator to create a one-time token for this host. Tokens are displayed only when created.")}/>}
  {enrollmentToken&&<div style={{maxWidth:760,marginTop:20}}><Alert type="warning" showIcon title={t("一次性接入令牌（仅显示本次）","One-time enrollment token (shown once)")} description={t("请立即复制并妥善交给目标主机的安装操作者。离开此页面后无法再次查看；令牌不会写入安装命令。","Copy this token now and securely provide it to the host's installer. It cannot be viewed after leaving this page and is not included in the installation command.")}/><Space.Compact style={{width:'100%',marginTop:12}}><Input aria-label={t("一次性接入令牌","One-time enrollment token")} value={enrollmentToken} readOnly/><Button onClick={()=>copy(enrollmentToken,setTokenCopied,t("令牌","Token"))}>{tokenCopied?t("已复制","Copied"):t("复制令牌","Copy token")}</Button></Space.Compact>{tokenExpires&&<Typography.Text type="secondary">{t("过期时间：","Expires at: ")}{new Date(tokenExpires).toLocaleString(uiLanguage)}</Typography.Text>}</div>}
  <div style={{marginTop:24}}><h2>{t("安装命令","Installation command")}</h2><pre className="lm-code" aria-label={t("LightMoni Agent 安装命令","LightMoni Agent installation command")}>{command||(loaded?label?(user.role==='admin'?t("先生成一次性接入令牌，再复制安装命令","Create a one-time enrollment token before copying the installation command"):t("请向管理员索取一次性接入令牌","Ask an administrator for a one-time enrollment token")): t("请选择初始任务标签","Select an initial task label"):error?t("安装信息读取失败，请重试","Unable to load installation information. Try again"):t("读取安装信息…","Loading installation information…"))}</pre>
   <Space wrap><Button type="primary" disabled={!metadata?.bundles.length||!command||!validEndpoint||!label} onClick={()=>copy(command,setCopied,t("安装命令","Installation command"))}>{copied?t("已复制命令","Command copied"):t("复制安装命令","Copy installation command")}</Button><Link to="/agents">{t("查看执行节点与任务","View execution nodes and tasks")}</Link></Space>
   <Typography.Paragraph type="secondary" style={{marginTop:12}}>{t("命令不包含令牌。运行命令时会安全提示输入一次性令牌，通过 stdin 完成下载、兑换和激活；安装器会校验安装包并注册独立 systemd 服务。","The command contains no token. When run, it securely prompts for a one-time token via stdin to download, redeem, and activate. The installer verifies the package and registers an independent systemd service.")}</Typography.Paragraph>
   {metadata&&!metadata.bundles.length&&<Alert type="info" title={t("当前服务尚未包含 LightMoni Agent 安装包","This platform has no LightMoni Agent installation packages yet")}/>}
  </div>
 </div>;
}
