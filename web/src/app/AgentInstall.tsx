import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {api,post} from '../shared/api';
import {Alert,Button,Form,Input,Select,Space,Tag,Typography} from '../shared/ui';
import type {CatalogTable,User} from '../shared/types';
import ReportingAddressInput from './ReportingAddressInput';
import {sdkEndpointError} from './sdkExamples';
import {agentInstallCommand,type AgentInstallMetadata as Metadata} from './agentInstallCommand';
interface TaskLabel {id:string;name:string;node_count:number;task_count:number}
interface InstallTask {id:string;type:'host'|'probe'|'log';enabled:boolean;label_ids:string[];config:{host_table?:string;probe_table?:string;log_table?:string}}
interface EnrollmentCreated {enrollment_id:string;token_display_once:string;token_expires_at:string;install_command_hint:string}

function endpointOrigin(value:string):string {
 try{return new URL(value.trim()).origin;}catch{return value.trim().replace(/\/+$/,'');}
}

export default function AgentInstall({user,initialGroup}:{user:User;tables:CatalogTable[];onKeyCreated:()=>void;initialGroup?:string}) {
 const [metadata,setMetadata]=useState<Metadata>(),[labels,setLabels]=useState<TaskLabel[]>([]),[tasks,setTasks]=useState<InstallTask[]>([]),[labelID,setLabelID]=useState(initialGroup??'default'),[loaded,setLoaded]=useState(false),[reload,setReload]=useState(0);
 const [endpoint,setEndpoint]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[tokenCopied,setTokenCopied]=useState(false),[enrollmentToken,setEnrollmentToken]=useState(''),[tokenExpires,setTokenExpires]=useState('');
 useEffect(()=>{let active=true;setLoaded(false);setError('');setEnrollmentToken('');setTokenExpires('');Promise.all([api<Metadata>('/agent-install'),api<TaskLabel[]>('/agent-task-labels'),api<InstallTask[]>('/agent-tasks')]).then(([metadata,labels,tasks])=>{if(!active)return;setMetadata(metadata);setLabels(labels);setTasks(tasks);setEndpoint(metadata.endpoint||window.location.origin);const requested=initialGroup??'default';setLabelID(labels.some(label=>label.id===requested)?requested:initialGroup?'':labels[0]?.id??'');if(initialGroup&&!labels.some(label=>label.id===initialGroup))setError('接入链接中的任务标签不存在，请重新选择初始任务标签。');setLoaded(true)}).catch(error=>{if(active)setError(error.message)});return()=>{active=false}},[initialGroup,reload]);
 useEffect(()=>{setCopied(false);setTokenCopied(false)},[endpoint,labelID,enrollmentToken]);
 const label=labels.find(label=>label.id===labelID);
 const matchedTasks=tasks.filter(task=>task.enabled&&task.label_ids.includes(labelID));
 const endpointError=sdkEndpointError(endpoint),validEndpoint=!!endpoint&&!endpointError;
 const command=metadata&&loaded&&label&&enrollmentToken?agentInstallCommand(metadata,endpoint,labelID):'';
 const createEnrollment=async()=>{
  if(!metadata||!label||!validEndpoint||user.role!=='admin')return;
  setBusy(true);setError('');setEnrollmentToken('');setTokenExpires('');
  try{
   const result=await post<EnrollmentCreated>('/agent-enrollments',{endpoint_origin:endpointOrigin(endpoint),version:metadata.version,initial_label_id:labelID,scopes:['agent.control','agent.data']});
   setEnrollmentToken(result.token_display_once);setTokenExpires(result.token_expires_at);
  }catch(error){setError((error as Error).message)}finally{setBusy(false)}
 };
 const copy=(value:string,done:(v:boolean)=>void,label:string)=>void navigator.clipboard.writeText(value).then(()=>done(true)).catch(()=>setError(`${label}复制失败，请重新尝试`));
 return <div className="lm-surface">
  <h2>接入执行节点</h2><p>为目标 Linux 主机生成一次性接入令牌并安装 LightMoni Agent。Agent 作为独立 systemd 服务运行，接入后会同步所选任务标签匹配的启用任务。</p><Tag>Linux · amd64 / arm64 · systemd</Tag>
  {error&&<Alert type="error" title={error} action={!loaded?<Button size="small" onClick={()=>setReload(value=>value+1)}>重新读取</Button>:undefined} style={{marginTop:16}}/>}
  <Form layout="vertical" style={{maxWidth:760,marginTop:20}}>
   <Form.Item label="初始任务标签" extra={<Link to="/agents?tab=labels">管理任务标签</Link>}><Select showSearch={{optionFilterProp:'label'}} aria-label="初始任务标签" value={labelID||undefined} onChange={value=>{setLabelID(value);setEnrollmentToken('');setTokenExpires('');setError('')}} disabled={!loaded||busy} options={labels.map(label=>({value:label.id,label:label.name}))}/></Form.Item>
   <Form.Item label="上报地址" validateStatus={endpoint&&!validEndpoint?'error':undefined} help={endpoint&&!validEndpoint?endpointError:undefined} extra={<Space wrap><span>从已配置地址中选择，也可填写临时地址；安装包直接从所选地址下载。</span>{metadata&&<Button size="small" disabled={endpoint===metadata.endpoint||busy} onClick={()=>setEndpoint(metadata.endpoint)}>恢复默认地址</Button>}{user.role==='admin'&&<Link to="/admin?tab=reporting">设置默认地址</Link>}</Space>}><ReportingAddressInput label="节点上报地址" value={endpoint} onChange={value=>{setEndpoint(value);setEnrollmentToken('');setTokenExpires('')}} addresses={metadata?.endpoints} defaultID={metadata?.default_endpoint_id} error={endpointError} placeholder="选择内网或公网地址"/></Form.Item>
  </Form>
  {loaded&&label&&!matchedTasks.length&&<Alert type="info" showIcon title="此任务标签暂未匹配启用任务" description="节点接入后不会采集指标、目录日志或执行拨测；后续可在节点助手中绑定其他任务标签。" style={{marginBottom:16}}/>}
  {user.role==='admin'?<Space wrap><Button type="primary" disabled={!loaded||!label||!validEndpoint||busy} loading={busy} onClick={()=>void createEnrollment()}>{enrollmentToken?'重新生成一次性接入令牌':'生成一次性接入令牌'}</Button><Link to="/agents">查看执行节点与任务</Link></Space>:<Alert type="info" showIcon title="只有管理员可以生成节点接入令牌" description="请联系管理员为这台主机生成一次性令牌；令牌只会在生成后显示一次。"/>}
  {enrollmentToken&&<div style={{maxWidth:760,marginTop:20}}><Alert type="warning" showIcon title="一次性接入令牌（仅显示本次）" description="请立即复制并妥善交给目标主机的安装操作者。离开此页面后无法再次查看；令牌不会写入安装命令。"/><Space.Compact style={{width:'100%',marginTop:12}}><Input aria-label="一次性接入令牌" value={enrollmentToken} readOnly/><Button onClick={()=>copy(enrollmentToken,setTokenCopied,'令牌')}>{tokenCopied?'已复制':'复制令牌'}</Button></Space.Compact>{tokenExpires&&<Typography.Text type="secondary">过期时间：{new Date(tokenExpires).toLocaleString()}</Typography.Text>}</div>}
  <div style={{marginTop:24}}><h2>安装命令</h2><pre className="lm-code" aria-label="LightMoni Agent 安装命令">{command||(loaded?label?(user.role==='admin'?'先生成一次性接入令牌，再复制安装命令':'请向管理员索取一次性接入令牌'): '请选择初始任务标签':error?'安装信息读取失败，请重试':'读取安装信息…')}</pre>
   <Space wrap><Button type="primary" disabled={!metadata?.bundles.length||!command||!validEndpoint||!label} onClick={()=>copy(command,setCopied,'安装命令')}>{copied?'已复制命令':'复制安装命令'}</Button><Link to="/agents">查看执行节点与任务</Link></Space>
   <Typography.Paragraph type="secondary" style={{marginTop:12}}>命令不包含令牌。运行命令时会安全提示输入一次性令牌，通过 stdin 完成下载、兑换和激活；安装器会校验安装包并注册独立 systemd 服务。</Typography.Paragraph>
   {metadata&&!metadata.bundles.length&&<Alert type="info" title="当前服务尚未包含 LightMoni Agent 安装包"/>}
  </div>
 </div>;
}
