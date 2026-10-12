import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {PlusOutlined,ReloadOutlined,SettingOutlined} from '@ant-design/icons';
import {Alert,App,Button,Descriptions,Empty,Modal,Select,Space,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import AgentTaskEditor from './AgentTaskEditor';
import {defaultTasks,hostCollectors,normalizeTasks,agentIsOnline,type AgentGroup,type AgentItem} from './agent-model';
import './agents.css';

export default function AgentsPage({user}:{user:User}) {
 const [agents,setAgents]=useState<AgentItem[]>([]),[groups,setGroups]=useState<AgentGroup[]>([]);
 const [searchParams,setSearchParams]=useSearchParams(),selected=searchParams.get('group')??'default';
 const setSelected=(id:string)=>setSearchParams(previous=>{const next=new URLSearchParams(previous);if(id==='default')next.delete('group');else next.set('group',id);return next;});
 const [endpoint,setEndpoint]=useState(window.location.origin),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const [editing,setEditing]=useState<AgentGroup|'new'>(),[moving,setMoving]=useState<AgentItem>(),[target,setTarget]=useState('default'),[moveBusy,setMoveBusy]=useState(false),[moveError,setMoveError]=useState('');
 const {modal,message}=App.useApp();
 const load=async()=>{try{const[agents,groups,install]=await Promise.all([api<AgentItem[]>('/agents'),api<AgentGroup[]>('/agent-groups'),api<{endpoint:string}>('/agent-install')]);setAgents(agents);setGroups(groups);setEndpoint(install.endpoint||window.location.origin);setError('')}catch(error){setError(error instanceof Error?error.message:'读取 Agent 分组失败')}};
 useEffect(()=>{if(saved){void message.success(saved);setSaved('');}},[saved,message]);
 useEffect(()=>{if(error)void message.error(error);},[error,message]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),10000);return()=>clearInterval(timer)},[]);
 const group=groups.find(group=>group.id===selected)??groups[0];
 const tasks=normalizeTasks(group?.config);
 const visibleAgents=agents.filter(agent=>agent.group_id===group?.id);
 return <div className="lm-page lm-agents-page">
  <div className="lm-page-heading"><div><h1>Agent 分组与任务</h1><p>同一分组使用相同的机器采集、拨测、目录日志和上报配置，改组后自动同步新任务。</p></div><Button icon={<ReloadOutlined/>} onClick={()=>void load()}>刷新</Button></div>
  <Tabs className="lm-agent-group-tabs" activeKey={group?.id??'default'} onChange={setSelected} destroyOnHidden tabBarExtraContent={<Button icon={<PlusOutlined/>} disabled={user.role!=='admin'} onClick={()=>{setSaved('');setEditing('new')}}>新建分组</Button>} items={groups.map(item=>({key:item.id,label:<span className="lm-agent-group-tab-label">{item.name}<span className="lm-agent-group-count">{item.agent_count}</span></span>,children:item.id===group?.id?<>
  <div className="lm-surface">
   <div className="lm-agent-policy-heading"><h2>{group.name}的任务</h2>
    <Space wrap><Button type="primary" icon={<SettingOutlined/>} disabled={user.role!=='admin'} onClick={()=>{setSaved('');setEditing(group)}}>配置分组任务</Button>{group.id!=='default'&&<Button danger disabled={user.role!=='admin'||group.agent_count>0} onClick={()=>modal.confirm({title:`删除 ${group.name}？`,content:'只有没有 Agent 的分组可以删除。',onOk:async()=>{await api(`/agent-groups/${group.id}`,{method:'DELETE'});setSelected('default');await load()}})}>删除分组</Button>}</Space>
   </div>
   <Descriptions size="small" column={{xs:1,sm:2,md:3}} items={[
    {key:'host',label:'机器指标',children:tasks.host_enabled?<Space size={[0,6]} wrap>{tasks.host_collectors.map(name=><Tag key={name}>{hostCollectors.find(item=>item.value===name)?.label??name}</Tag>)}</Space>:<Tag>已关闭</Tag>},
    {key:'interval',label:'采集间隔',children:`${tasks.collect_interval_seconds} 秒`},
    {key:'host-table',label:'机器指标表',children:<Typography.Text code>{tasks.host_table}</Typography.Text>},
    {key:'probes',label:'拨测任务',children:`${tasks.probes.length} 个`},
    {key:'probe-table',label:'拨测结果表',children:<Typography.Text code>{tasks.probe_table}</Typography.Text>},
    {key:'logs',label:'目录日志',children:tasks.logs_enabled?`${tasks.log_sources.length} 个目录 → ${tasks.log_table}`:<Tag>已关闭</Tag>},
   ]}/>
  </div>
  <div className="lm-surface"><div className="lm-agent-policy-heading"><h2>{group?.name??'当前分组'}的 Agent</h2><Link to={`/data?tab=agent&group=${encodeURIComponent(group?.id??'default')}`}><Button>接入此分组</Button></Link></div>
   <Table rowKey="id" dataSource={visibleAgents} scroll={{x:850}} expandable={{expandedRowRender:agent=><Descriptions size="small" column={{xs:1,sm:2}} items={[
    {key:'success',label:'最近成功上报',children:agent.heartbeat.last_success_at&&String(agent.heartbeat.last_success_at)!=='0001-01-01T00:00:00Z'?new Date(String(agent.heartbeat.last_success_at)).toLocaleString():'尚未上报'},
    {key:'queue',label:'待上报批次',children:String(agent.heartbeat.queue_batches??0)},
    {key:'error',label:'最近错误',span:2,children:String(agent.heartbeat.last_error||'无')},
    {key:'collectors',label:'采集状态',span:2,children:<Space wrap>{Object.entries((agent.heartbeat.collectors_status??{}) as Record<string,string>).map(([name,status])=><Tag key={name} color={status==='ok'?'success':status==='disabled'?'default':'warning'}>{name==='file_logs'?'目录日志':hostCollectors.find(item=>item.value===name)?.label??name}：{status==='disabled'?'已关闭':status}</Tag>)}</Space>},
   ]}/>}} columns={[
    {title:'机器',dataIndex:'hostname'},
    {title:'系统',render:(_:unknown,agent:AgentItem)=>`${agent.platform} / ${agent.arch}`},
    {title:'状态',render:(_:unknown,agent:AgentItem)=><Tag color={agentIsOnline(agent)?'success':'warning'}>{agentIsOnline(agent)?'在线':'心跳超时'}</Tag>},
    {title:'所属分组',dataIndex:'group_name'},
    {title:'配置状态',render:(_:unknown,agent:AgentItem)=><Tag color={agent.heartbeat.config_revision===agent.config?.revision?'success':'processing'}>{agent.heartbeat.config_revision===agent.config?.revision?'已生效':'等待同步'}</Tag>},
    {title:'最近心跳',dataIndex:'last_seen',render:(value:string)=>new Date(value).toLocaleString()},
    {title:'操作',render:(_:unknown,agent:AgentItem)=><Button size="small" disabled={user.role!=='admin'} onClick={()=>{setMoveError('');setTarget(agent.group_id);setMoving(agent)}}>更改分组</Button>},
   ]} locale={{emptyText:<Empty description="这个分组还没有 Agent，接入时选择此分组即可"/>}}/>
  </div>
  </>:null}))}/>
  <Modal title={editing==='new'?'新建 Agent 分组':`分组任务 · ${editing?.name??''}`} open={!!editing} onCancel={()=>setEditing(undefined)} footer={null} width={760} destroyOnHidden>
   {editing&&<AgentTaskEditor key={editing==='new'?'new':editing.id} tasks={editing==='new'?defaultTasks:normalizeTasks(editing.config)} groupName={editing==='new'?'':editing.name} endpoint={endpoint} onCancel={()=>setEditing(undefined)} onSave={async(config,name)=>{const result=await api<AgentGroup>(editing==='new'?'/agent-groups':`/agent-groups/${editing.id}`,{method:editing==='new'?'POST':'PUT',body:JSON.stringify({name,config})});setSelected(result.id);setEditing(undefined);setSaved('分组任务已保存，组内 Agent 将自动同步');await load()}}/>}
  </Modal>
  <Modal title={`更改分组 · ${moving?.hostname??''}`} open={!!moving} onCancel={()=>{if(!moveBusy)setMoving(undefined)}} confirmLoading={moveBusy} okText="保存分组" destroyOnHidden onOk={async()=>{if(!moving)return;setMoveBusy(true);setMoveError('');try{await api(`/agents/${moving.id}/group`,{method:'PUT',body:JSON.stringify({group_id:target})});setMoving(undefined);setSelected(target);setSaved('分组已更改，Agent 将自动同步新组任务');await load()}catch(error){setMoveError(error instanceof Error?error.message:'改组失败')}finally{setMoveBusy(false)}}}>
   <p>改组后使用目标分组的机器指标、拨测、目录日志和上报表。请确认当前上报 Key 已授权目标组的表。</p><Select showSearch={{optionFilterProp:"label"}} aria-label="目标 Agent 分组" style={{width:'100%'}} value={target} onChange={setTarget} disabled={moveBusy} options={groups.map(group=>({value:group.id,label:group.name}))}/>{moveError&&<Alert type="error" title={moveError} style={{marginTop:16}}/>}
  </Modal>
 </div>;
}
