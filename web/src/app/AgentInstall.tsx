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
export default function AgentInstall({user,onKeyCreated,initialGroup}:{user:User;onKeyCreated:()=>void;initialGroup?:string}) {
 const [metadata,setMetadata]=useState<Metadata>(),[labels,setLabels]=useState<TaskLabel[]>([]),[tasks,setTasks]=useState<InstallTask[]>([]),[labelID,setLabelID]=useState(initialGroup??'default'),[loaded,setLoaded]=useState(false),[reload,setReload]=useState(0);
 const [endpoint,setEndpoint]=useState(''),[key,setKey]=useState(''),[createKey,setCreateKey]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[keyCopied,setKeyCopied]=useState(false);
 useEffect(()=>{let active=true;setLoaded(false);setError('');Promise.all([api<Metadata>('/agent-install'),api<TaskLabel[]>('/agent-task-labels'),api<InstallTask[]>('/agent-tasks')]).then(([metadata,labels,tasks])=>{if(!active)return;setMetadata(metadata);setLabels(labels);setTasks(tasks);setEndpoint(metadata.endpoint||window.location.origin);const requested=initialGroup??'default';setLabelID(labels.some(label=>label.id===requested)?requested:initialGroup?'':labels[0]?.id??'');if(initialGroup&&!labels.some(label=>label.id===initialGroup))setError('接入链接中的任务标签不存在，请重新选择初始任务标签。');setLoaded(true)}).catch(error=>{if(active)setError(error.message)});return()=>{active=false}},[initialGroup,reload]);
 useEffect(()=>setCopied(false),[endpoint,labelID,key]);
 useEffect(()=>setKeyCopied(false),[key]);
 const label=labels.find(label=>label.id===labelID);
 const matchedTasks=tasks.filter(task=>task.enabled&&task.label_ids.includes(labelID));
 const endpointError=sdkEndpointError(endpoint),validEndpoint=!endpointError;
 const command=metadata&&loaded&&label?agentInstallCommand(metadata,endpoint,labelID,key):'';

 return <div className="lm-surface">
  <h2>安装配置</h2><p>安装 LightMoni Agent，选择初始任务标签、上报地址和 Key，复制命令到 Linux 服务器执行。节点接入后会同步该标签匹配的启用任务；可在节点助手中绑定多个任务标签。</p><Tag>Linux · amd64 / arm64 · systemd</Tag>
  {error&&<Alert type="error" title={error} action={!loaded?<Button size="small" onClick={()=>setReload(value=>value+1)}>重新读取</Button>:undefined} style={{marginTop:16}}/>}
  <Form layout="vertical" style={{maxWidth:760,marginTop:20}}>
   <Form.Item label="初始任务标签" extra={<Link to="/agents?tab=labels">管理任务标签</Link>}><Select showSearch={{optionFilterProp:"label"}} aria-label="初始任务标签" value={labelID||undefined} onChange={value=>{setLabelID(value);setError('')}} disabled={!loaded||busy} options={labels.map(label=>({value:label.id,label:label.name}))}/></Form.Item>
   <Form.Item label="上报地址" validateStatus={endpoint&&!validEndpoint?'error':undefined} help={endpoint&&!validEndpoint?endpointError:undefined} extra={<Space wrap><span>从已配置地址中选择，也可填写临时地址；安装包直接从所选地址下载。</span>{metadata&&<Button size="small" disabled={endpoint===metadata.endpoint} onClick={()=>setEndpoint(metadata.endpoint)}>恢复默认地址</Button>}{user.role==='admin'&&<Link to="/admin?tab=reporting">设置默认地址</Link>}</Space>}><ReportingAddressInput label="节点上报地址" value={endpoint} onChange={setEndpoint} addresses={metadata?.endpoints} defaultID={metadata?.default_endpoint_id} error={endpointError} placeholder="选择内网或公网地址"/></Form.Item>
   <Form.Item label="上报 Key" extra="有效且启用的 Key 可上报所有业务表及 Agent 任务数据。"><Input.Password aria-label="节点上报 Key" value={key} onChange={event=>setKey(event.target.value)} autoComplete="off" placeholder="粘贴已有的上报 Key"/></Form.Item>
  </Form>
  {loaded&&label&&!matchedTasks.length&&<Alert type="info" showIcon title="此任务标签暂未匹配启用任务" description="节点接入后不会采集指标、目录日志或执行拨测；业务 SDK 数据转发仍可使用。" style={{marginBottom:16}}/>}
  {user.role==='admin'&&<Button disabled={!loaded||!label||busy} onClick={()=>setCreateKey(value=>!value)}>{createKey?'收起 Key 创建':'创建上报 Key'}</Button>}
  {createKey&&user.role==='admin'&&loaded&&label&&<Form key={labelID} layout="vertical" style={{maxWidth:760,marginTop:16}} initialValues={{name:`${label.name}节点接入`}} onFinish={async values=>{setBusy(true);setError('');try{const result=await post<{key:string}>('/keys',values);setKey(result.key);onKeyCreated()}catch(error){setError((error as Error).message)}finally{setBusy(false)}}}>
   <Form.Item name="name" label="新 Key 名称" rules={[{required:true,whitespace:true,message:'请输入 Key 名称'}]}><Input aria-label="新 Key 名称" disabled={busy}/></Form.Item>

   <Button htmlType="submit" loading={busy}>创建 Key 并填入</Button>
  </Form>}
  <div style={{marginTop:24}}><h2>安装命令</h2><pre className="lm-code" aria-label="LightMoni Agent 安装命令">{command||(loaded?label?'填写上报 Key 后生成安装命令':'请选择初始任务标签':error?'安装信息读取失败，请重试':'读取安装信息…')}</pre>
   <Space wrap><Button type="primary" disabled={!metadata?.bundles.length||!command||!validEndpoint||!label} onClick={()=>void navigator.clipboard.writeText(command).then(()=>setCopied(true)).catch(()=>setError('复制失败，请重新尝试'))}>{copied?'已复制命令':'复制安装命令'}</Button><Button disabled={!key.trim()} onClick={()=>void navigator.clipboard.writeText(key.trim()).then(()=>setKeyCopied(true)).catch(()=>setError('复制 Key 失败，请重新尝试'))}>{keyCopied?'已复制 Key':'复制上报 Key'}</Button><Link to="/agents">查看执行节点与任务</Link></Space>
   <Typography.Paragraph type="secondary" style={{marginTop:12}}>命令已包含所填 Key，用于下载鉴权并保存上报连接。安装程序自动识别 amd64 / arm64，校验安装包后注册系统服务。</Typography.Paragraph>
   {metadata&&!metadata.bundles.length&&<Alert type="info" title="当前服务尚未包含 LightMoni Agent 安装包"/>}
  </div>
 </div>;
}
