import {useCallback,useEffect,useRef,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Descriptions,Empty,Input,Modal,Select,Space,Switch,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import AgentTaskEditor from './AgentTaskEditor';
import {hostCollectors,normalizeTasks,agentIsOnline,taskTypeName,type AgentTaskLabel,type AgentItem,type ManagedAgentTask} from './agent-model';
import './agents.css';

type PageTab = 'nodes'|'tasks'|'labels';
type Deleting = {kind:'task'|'label';id:string;name:string};
const failure = (error:unknown,fallback:string) => error instanceof Error?error.message:fallback;
const time = (value:unknown) => value && String(value)!=='0001-01-01T00:00:00Z' && Number.isFinite(Date.parse(String(value)))?new Date(String(value)).toLocaleString():'尚无记录';
const taskSummary = (task:ManagedAgentTask) => {
 const config=normalizeTasks(task.config);
 if(task.type==='host') return `${config.host_collectors.map(value=>hostCollectors.find(item=>item.value===value)?.label ?? value).join('、') || '未选指标'} · ${config.collect_interval_seconds} 秒 → ${config.host_table}`;
 if(task.type==='probe') return `${config.probes.length} 个拨测目标 → ${config.probe_table}`;
 return `${config.log_sources.length} 个日志目录 → ${config.log_table}`;
};

function NodeDetails({agent}:{agent:AgentItem}) {
 const heartbeat=agent.heartbeat ?? {},config=agent.config?normalizeTasks(agent.config):undefined;
 return <Descriptions size="small" className="lm-agent-details" column={{xs:1,sm:2}} items={[
  {key:'id',label:'节点 ID',children:<Typography.Text code>{agent.id}</Typography.Text>},
  {key:'version',label:'LightMoni Agent 版本',children:agent.version || '未知'},
  {key:'success',label:'最近成功上报',children:time(heartbeat.last_success_at)},
  {key:'queue',label:'待上报批次',children:String(heartbeat.queue_batches ?? 0)},
  {key:'error',label:'最近错误',span:2,children:String(heartbeat.last_error || '无')},
  {key:'tasks',label:'当前匹配任务',span:2,children:agent.tasks?.length?<Space size={[0,6]} wrap>{agent.tasks.map(task=><Tag key={task.id}>{task.name} · {taskTypeName(task.type)}</Tag>)}</Space>:'未匹配启用任务；指标采集、日志采集和拨测暂停，业务数据转发继续可用。'},
  {key:'config',label:'中心下发配置',span:2,children:config?<Space size={[0,6]} wrap><Tag>指标采集：{config.host_enabled?`${config.collect_interval_seconds} 秒 → ${config.host_table}`:'关闭'}</Tag><Tag>服务拨测：{config.probes.length} 个 → {config.probe_table}</Tag><Tag>目录日志：{config.logs_enabled?`${config.log_sources.length} 个 → ${config.log_table}`:'关闭'}</Tag></Space>:'尚未获取配置'},
  {key:'revision',label:'中心配置版本',children:<Typography.Text code>{agent.config?.revision || '尚无版本'}</Typography.Text>},
  {key:'actual-revision',label:'节点已应用版本',children:<Typography.Text code>{String(heartbeat.config_revision || '等待同步')}</Typography.Text>},
  {key:'collectors',label:'节点采集状态',span:2,children:Object.keys((heartbeat.collectors_status ?? {}) as Record<string,unknown>).length?<Space size={[0,6]} wrap>{Object.entries(heartbeat.collectors_status as Record<string,string>).map(([name,status])=><Tag key={name} color={status==='ok'?'success':status==='disabled'?'default':'warning'}>{name==='file_logs'?'目录日志':hostCollectors.find(item=>item.value===name)?.label ?? name}：{status==='disabled'?'已关闭':status}</Tag>)}</Space>:'尚未收到采集状态'},
 ]}/>;
}

function TaskDetails({task}:{task:ManagedAgentTask}) {
 const config=normalizeTasks(task.config);
 if(task.type==='host') return <Descriptions size="small" column={{xs:1,sm:2}} items={[
  {key:'collectors',label:'采集指标',span:2,children:config.host_collectors.map(value=>hostCollectors.find(item=>item.value===value)?.label ?? value).join('、') || '未选指标'},
  {key:'processes',label:'进程名称',span:2,children:config.process_names.join('、') || '无指定进程'},
  {key:'interval',label:'采集间隔',children:`${config.collect_interval_seconds} 秒`},{key:'table',label:'指标上报表',children:config.host_table},
 ]}/>;
 if(task.type==='probe') return <div className="lm-agent-task-details"><Typography.Paragraph type="secondary">拨测结果上报表：{config.probe_table}</Typography.Paragraph>{config.probes.map(probe=><Descriptions key={probe.id} size="small" column={{xs:1,sm:2}} items={[
  {key:'name',label:'拨测名称',children:probe.id},{key:'type',label:'类型',children:probe.kind==='http'?'HTTP / HTTPS':'TCP'},
  {key:'target',label:'目标',span:2,children:probe.target},{key:'interval',label:'拨测间隔',children:`${probe.interval_seconds} 秒`},{key:'timeout',label:'超时',children:`${probe.timeout_ms/1000} 秒`},
  ...(probe.kind==='http'?[{key:'status',label:'成功状态码',span:2,children:probe.expected_status?.length?probe.expected_status.join('、'):'200–399'}]:[]),
 ]}/>)}{!config.probes.length&&<Typography.Text type="secondary">未配置拨测目标</Typography.Text>}</div>;
 return <div className="lm-agent-task-details"><Typography.Paragraph type="secondary">目录日志上报表：{config.log_table}</Typography.Paragraph>{config.log_sources.map((source,index)=><Descriptions key={index} size="small" column={{xs:1,sm:2}} items={[
  {key:'directory',label:'目录路径',span:2,children:source.directory},{key:'pattern',label:'文件匹配规则',children:source.pattern},
  {key:'recursive',label:'包含子目录',children:source.recursive?'是':'否'},{key:'beginning',label:'首次采集',span:2,children:source.from_beginning?'从文件开头采集':'仅采集新增内容'},
 ]}/>)}{!config.log_sources.length&&<Typography.Text type="secondary">未配置日志目录</Typography.Text>}</div>;
}

export default function AgentsPage({user}:{user:User}) {
 const [agents,setAgents]=useState<AgentItem[]>([]),[labels,setLabels]=useState<AgentTaskLabel[]>([]),[tasks,setTasks]=useState<ManagedAgentTask[]>([]);
 const [searchParams,setSearchParams]=useSearchParams();
 const tabParam=searchParams.get('tab'),tab:PageTab=tabParam==='tasks'||tabParam==='labels'?tabParam:'nodes';
 const labelFilter=searchParams.get('group') ?? '';
 const setTab=(next:string)=>setSearchParams(previous=>{const params=new URLSearchParams(previous);if(next==='nodes')params.delete('tab');else params.set('tab',next);return params;});
 const setFilter=(next:string)=>setSearchParams(previous=>{const params=new URLSearchParams(previous);if(next)params.set('group',next);else params.delete('group');return params;});
 const viewLabel=(id:string,nextTab:PageTab)=>setSearchParams(previous=>{const params=new URLSearchParams(previous);params.set('group',id);if(nextTab==='nodes')params.delete('tab');else params.set('tab',nextTab);return params;});
 const [loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[actionError,setActionError]=useState('');
 const [editing,setEditing]=useState<ManagedAgentTask|'new'>(),[taskBusy,setTaskBusy]=useState(false),[toggling,setToggling]=useState('');
 const [moving,setMoving]=useState<AgentItem>(),[targetLabels,setTargetLabels]=useState<string[]>([]),[moveBusy,setMoveBusy]=useState(false),[moveError,setMoveError]=useState('');
 const [editingLabel,setEditingLabel]=useState<AgentTaskLabel|'new'>(),[labelName,setLabelName]=useState(''),[labelBusy,setLabelBusy]=useState(false),[labelError,setLabelError]=useState('');
 const [deleting,setDeleting]=useState<Deleting>(),[deleteBusy,setDeleteBusy]=useState(false),[deleteError,setDeleteError]=useState('');
 const request=useRef(0),admin=user.role==='admin';
 const {message}=App.useApp();
 const load=useCallback(async(silent=false)=>{
  const current=++request.current;if(!silent)setLoading(true);
  try {
   const [nodes,nextLabels,nextTasks]=await Promise.all([api<AgentItem[]>('/agents'),api<AgentTaskLabel[]>('/agent-task-labels'),api<ManagedAgentTask[]>('/agent-tasks')]);
   if(current!==request.current)return;
   setAgents(nodes);setLabels(nextLabels);setTasks(nextTasks);setLoaded(true);setError('');
  } catch(error) {if(current===request.current)setError(failure(error,'读取执行节点和任务失败'));}
  finally {if(current===request.current)setLoading(false);}
 },[]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(true),10000);return()=>{clearInterval(timer);request.current++;};},[load]);
 const labelOptions=labels.map(label=>({value:label.id,label:label.name}));
 const labelNameById=(id:string)=>labels.find(label=>label.id===id)?.name ?? id;
 const renderLabels=(ids:string[])=>ids?.length?<Space size={[0,6]} wrap>{ids.map(id=><Tag key={id}>{labelNameById(id)}</Tag>)}</Space>:<Typography.Text type="secondary">无任务标签</Typography.Text>;
 const visibleAgents=labelFilter?agents.filter(agent=>agent.label_ids?.includes(labelFilter)):agents;
 const visibleTasks=labelFilter?tasks.filter(task=>task.label_ids?.includes(labelFilter)):tasks;
 const openLabel=(label:AgentTaskLabel|'new')=>{setLabelName(label==='new'?'':label.name);setLabelError('');setEditingLabel(label);};
 const openDelete=(item:Deleting)=>{setDeleteError('');setDeleting(item);};
 const saveLabel=async()=>{
  if(!editingLabel)return;
  const name=labelName.trim();
  if(!name){setLabelError('请输入任务标签名称');return;}
  if(new TextEncoder().encode(name).length>128){setLabelError('标签名称最长 128 字节');return;}
  setLabelBusy(true);setLabelError('');
  try {await api(editingLabel==='new'?'/agent-task-labels':`/agent-task-labels/${encodeURIComponent(editingLabel.id)}`,{method:editingLabel==='new'?'POST':'PUT',body:JSON.stringify({name})});await load();setEditingLabel(undefined);void message.success('任务标签已保存');}
  catch(error){setLabelError(failure(error,'保存任务标签失败'));}
  finally{setLabelBusy(false);}
 };
 const toggleTask=async(task:ManagedAgentTask,enabled:boolean)=>{
  setToggling(task.id);setActionError('');
  try {await api(`/agent-tasks/${encodeURIComponent(task.id)}`,{method:'PUT',body:JSON.stringify({...task,enabled})});void message.success(enabled?'任务已启用，匹配节点将自动同步':'任务已停用，匹配节点将自动撤除');await load();}
  catch(error){setActionError(failure(error,'更改任务状态失败'));}
  finally{setToggling('');}
 };
 const filterControl=<Select allowClear showSearch={{optionFilterProp:'label'}} aria-label="按任务标签筛选" className="lm-agent-label-filter" placeholder="全部任务标签" value={labelFilter||undefined} onChange={value=>setFilter(value ?? '')} options={labelFilter&&!labels.some(label=>label.id===labelFilter)?[{value:labelFilter,label:`未知标签（${labelFilter}）`},...labelOptions]:labelOptions}/>;
 const nodesPanel=<div className="lm-surface">
  <div className="lm-agent-policy-heading"><div><h2>执行节点</h2><p className="lm-agent-muted">LightMoni Agent 的运行实例；每个节点可关联多个任务标签。</p></div><Space wrap>{filterControl}<Link to={`/data?tab=agent${labelFilter?`&group=${encodeURIComponent(labelFilter)}`:''}`}><Button type="primary">接入执行节点</Button></Link></Space></div>
  <Table<AgentItem> rowKey="id" dataSource={visibleAgents} loading={loading} scroll={{x:1050}} pagination={{pageSize:10,hideOnSinglePage:true}} expandable={{expandedRowRender:agent=><NodeDetails agent={agent}/>}} columns={[
   {title:'节点名称',dataIndex:'hostname',width:180,render:(hostname:string,agent:AgentItem)=><div className="lm-agent-node-name"><strong>{hostname || agent.id}</strong><Typography.Text type="secondary">{agent.platform} / {agent.arch}</Typography.Text></div>},
   {title:'状态',width:110,render:(_:unknown,agent:AgentItem)=><Tag color={agentIsOnline(agent)?'success':'warning'}>{agentIsOnline(agent)?'在线':'心跳超时'}</Tag>},
   {title:'任务标签',width:220,render:(_:unknown,agent:AgentItem)=>renderLabels(agent.label_ids ?? [])},
   {title:'匹配任务',width:130,render:(_:unknown,agent:AgentItem)=>agent.tasks?.length?<span>{agent.tasks.length} 个启用任务</span>:<Typography.Text type="secondary">无匹配任务</Typography.Text>},
   {title:'配置状态',width:110,render:(_:unknown,agent:AgentItem)=>{const applied=!!agent.config?.revision&&agent.heartbeat?.config_revision===agent.config.revision;return <Tag color={applied?'success':'processing'}>{applied?'已生效':'等待同步'}</Tag>;}},
   {title:'最近心跳',dataIndex:'last_seen',width:180,render:time},
   {title:'操作',width:130,render:(_:unknown,agent:AgentItem)=><Button size="small" disabled={!admin||!loaded} onClick={()=>{setMoveError('');setTargetLabels([...(agent.label_ids ?? [])]);setMoving(agent);}}>设置任务标签</Button>},
  ]} locale={{emptyText:<Empty description={loaded?(labelFilter?'没有匹配此任务标签的执行节点':'尚未接入执行节点，安装 LightMoni Agent 后即可接收监控任务'):error?'读取失败，请刷新重试':'正在读取执行节点'}/>}}/>
 </div>;
 const tasksPanel=<div className="lm-surface">
  <div className="lm-agent-policy-heading"><div><h2>任务管理</h2><p className="lm-agent-muted">独立配置指标采集、服务拨测和目录日志，通过任务标签下发。</p></div><Space wrap>{filterControl}<Button type="primary" icon={<PlusOutlined/>} disabled={!admin||!loaded} onClick={()=>setEditing('new')}>新建任务</Button></Space></div>
  <Table<ManagedAgentTask> rowKey="id" dataSource={visibleTasks} loading={loading} scroll={{x:1050}} pagination={{pageSize:10,hideOnSinglePage:true}} expandable={{expandedRowRender:task=><TaskDetails task={task}/>}} columns={[
   {title:'任务名称',dataIndex:'name',width:180,render:(name:string)=><strong className="lm-agent-wrapped">{name}</strong>},
   {title:'任务类型',dataIndex:'type',width:110,render:taskTypeName},
   {title:'状态',width:110,render:(_:unknown,task:ManagedAgentTask)=><Switch aria-label={`启用任务 ${task.name}`} checked={task.enabled} checkedChildren="启用" unCheckedChildren="停用" disabled={!admin||!!toggling} loading={toggling===task.id} onChange={enabled=>void toggleTask(task,enabled)}/>},
   {title:'任务标签',width:220,render:(_:unknown,task:ManagedAgentTask)=>task.label_ids?.length?renderLabels(task.label_ids):<Tag>未分发</Tag>},
   {title:'任务配置',width:250,render:(_:unknown,task:ManagedAgentTask)=><span className="lm-agent-wrapped">{taskSummary(task)}</span>},
   {title:'操作',width:160,render:(_:unknown,task:ManagedAgentTask)=><Space><Button size="small" disabled={!admin||toggling===task.id} onClick={()=>setEditing(task)}>编辑任务</Button><Button size="small" danger disabled={!admin||toggling===task.id} onClick={()=>openDelete({kind:'task',id:task.id,name:task.name})}>删除</Button></Space>},
  ]} locale={{emptyText:<Empty description={loaded?(labelFilter?'没有关联此任务标签的任务':'尚无监控任务；新建任务并选择任务标签后，匹配的节点会自动同步'):error?'读取失败，请刷新重试':'正在读取任务'}/>}}/>
 </div>;
 const labelsPanel=<div className="lm-surface">
  <div className="lm-agent-policy-heading"><div><h2>任务标签</h2><p className="lm-agent-muted">任务与节点有任一标签相同时即匹配；空标签不会广播任务。</p></div><Button type="primary" icon={<PlusOutlined/>} disabled={!admin||!loaded} onClick={()=>openLabel('new')}>新建任务标签</Button></div>
  <Table<AgentTaskLabel> rowKey="id" dataSource={labels} loading={loading} scroll={{x:650}} pagination={{pageSize:10,hideOnSinglePage:true}} columns={[
   {title:'标签名称',dataIndex:'name',render:(name:string,label:AgentTaskLabel)=><Space wrap><strong className="lm-agent-wrapped">{name}</strong>{label.id==='default'&&<Tag>默认</Tag>}</Space>},
   {title:'执行节点',dataIndex:'node_count',width:110,render:(count:number,label:AgentTaskLabel)=><Button type="link" size="small" onClick={()=>viewLabel(label.id,'nodes')}>{count} 个</Button>},
   {title:'关联任务',dataIndex:'task_count',width:110,render:(count:number,label:AgentTaskLabel)=><Button type="link" size="small" onClick={()=>viewLabel(label.id,'tasks')}>{count} 个</Button>},
   {title:'操作',width:180,render:(_:unknown,label:AgentTaskLabel)=><Space><Button size="small" disabled={!admin} onClick={()=>openLabel(label)}>重命名</Button><Button size="small" danger disabled={!admin||label.id==='default'} onClick={()=>openDelete({kind:'label',id:label.id,name:label.name})}>删除</Button></Space>},
  ]} locale={{emptyText:<Empty description={loaded?'尚无任务标签':error?'读取失败，请刷新重试':'正在读取任务标签'}/>}}/>
 </div>;
 return <div className="lm-page lm-agents-page">
  <div className="lm-page-heading"><div><h1>节点助手</h1><p>统一管理 LightMoni Agent，通过任务标签为执行节点下发指标采集、服务拨测和目录日志任务。</p></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新</Button></div>
  {!admin&&<Alert type="info" showIcon title="当前为只读模式；仅管理员可修改节点标签、任务和任务标签。" className="lm-agent-page-notice"/>}
  {error&&<Alert type="error" showIcon title={error} description={loaded?'已保留上次读取的数据，可刷新重试。':'请刷新重试。'} className="lm-agent-page-notice"/>}
  {actionError&&<Alert type="error" showIcon title={actionError} closable afterClose={()=>setActionError('')} className="lm-agent-page-notice"/>}
  <Tabs className="lm-agent-tabs" activeKey={tab} onChange={setTab} items={[{key:'nodes',label:'执行节点',children:nodesPanel},{key:'tasks',label:'任务管理',children:tasksPanel},{key:'labels',label:'任务标签',children:labelsPanel}]}/>
  <Modal title={editing==='new'?'新建任务':`编辑任务 · ${editing?.name ?? ''}`} open={!!editing} onCancel={()=>{if(!taskBusy)setEditing(undefined);}} closable={!taskBusy} keyboard={!taskBusy} maskClosable={false} footer={null} width={760} destroyOnHidden>
   {editing&&<AgentTaskEditor key={editing==='new'?'new':editing.id} task={editing==='new'?undefined:editing} labels={labels} onBusyChange={setTaskBusy} onCancel={()=>setEditing(undefined)} onSave={async draft=>{await api(editing==='new'?'/agent-tasks':`/agent-tasks/${encodeURIComponent(editing.id)}`,{method:editing==='new'?'POST':'PUT',body:JSON.stringify(draft)});await load();setEditing(undefined);void message.success('任务已保存，匹配的执行节点将自动同步');}}/>}
  </Modal>
  <Modal title={`设置任务标签 · ${moving?.hostname || moving?.id || ''}`} open={!!moving} onCancel={()=>{if(!moveBusy)setMoving(undefined);}} closable={!moveBusy} keyboard={!moveBusy} maskClosable={false} confirmLoading={moveBusy} okText="保存任务标签" cancelButtonProps={{disabled:moveBusy}} destroyOnHidden onOk={async()=>{
   if(!moving)return;setMoveBusy(true);setMoveError('');
   try {await api(`/agents/${encodeURIComponent(moving.id)}/labels`,{method:'PUT',body:JSON.stringify({label_ids:targetLabels})});await load();setMoving(undefined);void message.success('节点任务标签已保存，将自动同步匹配任务');}
   catch(error){setMoveError(failure(error,'保存节点任务标签失败'));}
   finally{setMoveBusy(false);}
  }}>
   <p>可选择多个任务标签，节点接收任一标签匹配的启用任务。请确认上报 Key 已授权这些任务的目标表。</p>
   <Select mode="multiple" allowClear showSearch={{optionFilterProp:'label'}} aria-label="节点任务标签" style={{width:'100%'}} value={targetLabels} onChange={setTargetLabels} disabled={moveBusy} options={labelOptions} placeholder="选择任务标签"/>
   {!targetLabels.length&&<Alert type="info" showIcon title="未选择任务标签，节点将暂停指标采集、日志采集和拨测；业务数据转发继续可用。" className="lm-agent-form-notice"/>}
   {moveError&&<Alert type="error" showIcon title={moveError} className="lm-agent-form-notice"/>}
  </Modal>
  <Modal title={editingLabel==='new'?'新建任务标签':`重命名任务标签 · ${editingLabel?.name ?? ''}`} open={!!editingLabel} onCancel={()=>{if(!labelBusy)setEditingLabel(undefined);}} closable={!labelBusy} keyboard={!labelBusy} maskClosable={false} confirmLoading={labelBusy} okText="保存标签" cancelButtonProps={{disabled:labelBusy}} destroyOnHidden onOk={()=>void saveLabel()}>
   <label className="lm-agent-input-label" htmlFor="lm-agent-label-name">标签名称</label><Input id="lm-agent-label-name" aria-label="标签名称" value={labelName} disabled={labelBusy} onChange={event=>setLabelName(event.target.value)} onPressEnter={()=>{if(!labelBusy)void saveLabel();}} placeholder="例如：生产环境、订单服务"/>
   <p className="lm-agent-report-note lm-agent-muted">标签用于关联任务与执行节点。新建标签后，请为节点和任务分别设置此标签。</p>
   {labelError&&<Alert type="error" showIcon title={labelError} className="lm-agent-form-notice"/>}
  </Modal>
  <Modal title={`删除${deleting?.kind==='task'?'任务':'任务标签'} · ${deleting?.name ?? ''}？`} open={!!deleting} onCancel={()=>{if(!deleteBusy)setDeleting(undefined);}} closable={!deleteBusy} keyboard={!deleteBusy} maskClosable={false} confirmLoading={deleteBusy} okText="确认删除" okButtonProps={{danger:true}} cancelButtonProps={{disabled:deleteBusy}} destroyOnHidden onOk={async()=>{
   if(!deleting)return;setDeleteBusy(true);setDeleteError('');
   try {await api(`${deleting.kind==='task'?'/agent-tasks':'/agent-task-labels'}/${encodeURIComponent(deleting.id)}`,{method:'DELETE'});if(deleting.kind==='label'&&deleting.id===labelFilter)setFilter('');await load();setDeleting(undefined);void message.success('已删除');}
   catch(error){setDeleteError(failure(error,'删除失败'));}
   finally{setDeleteBusy(false);}
  }}>
   <p>{deleting?.kind==='task'?'删除后，所有匹配的执行节点将自动撤除此任务。':'仍被执行节点或任务引用的标签无法删除，请先解除关联。默认标签保留。'}</p>
   {deleteError&&<Alert type="error" showIcon title={deleteError} className="lm-agent-form-notice"/>}
  </Modal>
 </div>;
}
