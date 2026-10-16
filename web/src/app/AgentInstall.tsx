import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {api,post} from '../shared/api';
import {Alert,Button,Form,Input,Select,Space,Tag,Typography} from '../shared/ui';
import type {CatalogTable,User} from '../shared/types';
import type {AgentGroup} from './agent-model';
import {KeyTablePermissions} from './AllowedTablesInput';
import ReportingAddressInput from './ReportingAddressInput';
import {sdkEndpointError} from './sdkExamples';
import {agentInstallCommand,type AgentInstallMetadata as Metadata} from './agentInstallCommand';
export default function AgentInstall({user,tables,onKeyCreated,initialGroup}:{user:User;tables:CatalogTable[];onKeyCreated:()=>void;initialGroup?:string}) {
 const [metadata,setMetadata]=useState<Metadata>(),[groups,setGroups]=useState<AgentGroup[]>([]),[groupID,setGroupID]=useState(initialGroup??'default');
 const [endpoint,setEndpoint]=useState(''),[key,setKey]=useState(''),[createKey,setCreateKey]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[keyCopied,setKeyCopied]=useState(false);
 useEffect(()=>{Promise.all([api<Metadata>('/agent-install'),api<AgentGroup[]>('/agent-groups')]).then(([metadata,groups])=>{setMetadata(metadata);setGroups(groups);setEndpoint(metadata.endpoint||window.location.origin);if(!groups.some(group=>group.id===(initialGroup??'default')))setGroupID(groups[0]?.id??'default')}).catch(error=>setError(error.message))},[initialGroup]);
 useEffect(()=>setCopied(false),[endpoint,groupID,key]);
 useEffect(()=>setKeyCopied(false),[key]);
 const group=groups.find(group=>group.id===groupID);
 const endpointError=sdkEndpointError(endpoint),validEndpoint=!endpointError;
 const command=metadata?agentInstallCommand(metadata,endpoint,groupID,key):'';

 return <div className="lm-surface">
  <h2>接入 Agent</h2><p>选择分组、上报地址和 Key，复制命令到 Linux 服务器执行。安装后自动应用该组的机器指标、拨测和目录日志任务。</p><Tag>Linux · amd64 / arm64 · systemd</Tag>
  {error&&<Alert type="error" title={error} style={{marginTop:16}}/>}
  <Form layout="vertical" style={{maxWidth:760,marginTop:20}}>
   <Form.Item label="Agent 分组" extra={<Link to="/agents">管理分组与任务</Link>}><Select showSearch={{optionFilterProp:"label"}} aria-label="接入 Agent 分组" value={groupID} onChange={setGroupID} options={groups.map(group=>({value:group.id,label:group.name}))}/></Form.Item>
   <Form.Item label="上报地址" validateStatus={endpoint&&!validEndpoint?'error':undefined} help={endpoint&&!validEndpoint?endpointError:undefined} extra={<Space wrap><span>从已配置地址中选择，也可填写临时地址；安装包直接从所选地址下载。</span>{metadata&&<Button size="small" disabled={endpoint===metadata.endpoint} onClick={()=>setEndpoint(metadata.endpoint)}>恢复默认地址</Button>}{user.role==='admin'&&<Link to="/admin?tab=reporting">设置默认地址</Link>}</Space>}><ReportingAddressInput label="Agent 上报地址" value={endpoint} onChange={setEndpoint} addresses={metadata?.endpoints} defaultID={metadata?.default_endpoint_id} error={endpointError} placeholder="选择内网或公网地址"/></Form.Item>
   <Form.Item label="上报 Key" extra={group?`Key 需允许 ${group.config.host_table??'host'}、${group.config.probe_table??'probe'}、${group.config.log_table??'files'}，或允许所有 table。`:'选择分组后会提示需要授权的表。'}><Input.Password aria-label="Agent 上报 Key" value={key} onChange={event=>setKey(event.target.value)} autoComplete="off" placeholder="粘贴已有的上报 Key"/></Form.Item>
  </Form>
  {user.role==='admin'&&<Button onClick={()=>setCreateKey(value=>!value)}>{createKey?'收起 Key 创建':'创建上报 Key'}</Button>}
  {createKey&&user.role==='admin'&&<Form key={groupID} layout="vertical" style={{maxWidth:760,marginTop:16}} initialValues={{name:`${group?.name??'服务器'}接入`,allow_all_tables:false,allowed_tables:[...new Set([group?.config.host_table??'host',group?.config.probe_table??'probe',group?.config.log_table??'files'])]}} onFinish={async values=>{setBusy(true);setError('');try{const result=await post<{key:string}>('/keys',values);setKey(result.key);onKeyCreated()}catch(error){setError((error as Error).message)}finally{setBusy(false)}}}>
   <Form.Item name="name" label="新 Key 名称" rules={[{required:true,whitespace:true,message:'请输入 Key 名称'}]}><Input aria-label="新 Key 名称" disabled={busy}/></Form.Item>
   <KeyTablePermissions tables={tables} disabled={busy} help="默认授权此组的机器指标、拨测结果和目录日志表，也可允许所有 table。"/>
   <Button htmlType="submit" loading={busy}>创建 Key 并填入</Button>
  </Form>}
  <div style={{marginTop:24}}><h2>安装命令</h2><pre className="lm-code" aria-label="Agent 安装命令">{command||(metadata?'填写上报 Key 后生成安装命令':'读取安装信息…')}</pre>
   <Space wrap><Button type="primary" disabled={!metadata?.bundles.length||!command||!validEndpoint||!group} onClick={()=>void navigator.clipboard.writeText(command).then(()=>setCopied(true)).catch(()=>setError('复制失败，请重新尝试'))}>{copied?'已复制命令':'复制安装命令'}</Button><Button disabled={!key.trim()} onClick={()=>void navigator.clipboard.writeText(key.trim()).then(()=>setKeyCopied(true)).catch(()=>setError('复制 Key 失败，请重新尝试'))}>{keyCopied?'已复制 Key':'复制上报 Key'}</Button><Link to="/agents">查看 Agent 与分组</Link></Space>
   <Typography.Paragraph type="secondary" style={{marginTop:12}}>命令已包含所填 Key，用于下载鉴权并保存上报连接。安装程序自动识别 amd64 / arm64，校验安装包后注册系统服务。</Typography.Paragraph>
   {metadata&&!metadata.bundles.length&&<Alert type="info" title="当前服务尚未包含 Agent 安装包"/>}
  </div>
 </div>;
}
