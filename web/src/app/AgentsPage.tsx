import {useI18n} from '../shared/i18n';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Descriptions,Empty,Input,Modal,Select,Space,Switch,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import AgentTaskEditor from './AgentTaskEditor';
import {hostCollectorName,normalizeTasks,agentIsOnline,taskTypeName,type AgentTaskLabel,type AgentItem,type ManagedAgentTask} from './agent-model';
import './agents.css';

type PageTab = 'nodes'|'tasks'|'labels';
type Deleting = {kind:'task'|'label';id:string;name:string};
const failure = (error:unknown,fallback:string) => error instanceof Error?error.message:fallback;

export function NodeDetails({agent}:{agent:AgentItem}) {
 const {t,language:uiLanguage}=useI18n();
const time = (value:unknown) => value && String(value)!=='0001-01-01T00:00:00Z' && Number.isFinite(Date.parse(String(value)))?new Date(String(value)).toLocaleString(uiLanguage):t("尚无记录","No records yet");

 const heartbeat=agent.heartbeat ?? {},config=agent.config?normalizeTasks(agent.config):undefined;
 return <Descriptions size="small" className="lm-agent-details" column={{xs:1,sm:2}} items={[
  {key:'id',label:t("节点 ID","Node ID"),children:<Typography.Text code>{agent.id}</Typography.Text>},
  {key:'version',label:t("LightMoni Agent 版本","LightMoni Agent version"),children:agent.version || t("未知","Unknown")},
  {key:'success',label:t("最近成功上报","Last successful report"),children:time(heartbeat.last_success_at)},
  {key:'queue',label:t("待上报批次","Queued batches"),children:String(heartbeat.queue_batches ?? 0)},
  {key:'error',label:t("最近错误","Latest error"),span:2,children:String(heartbeat.last_error || t("无","None"))},
  {key:'tasks',label:t("当前匹配任务","Currently matched tasks"),span:2,children:agent.tasks?.length?<Space size={[0,6]} wrap>{agent.tasks.map(task=><Tag key={task.id}>{task.name} · {taskTypeName(task.type,uiLanguage)}</Tag>)}</Space>:t("未匹配启用任务；指标采集、日志采集和拨测暂停，SDK 独立直报不受影响。","No enabled tasks match. Metric and log collection and probing are paused; independent SDK reporting is unaffected.")},
  {key:'config',label:t("中心下发配置","Platform configuration"),span:2,children:config?<Space size={[0,6]} wrap><Tag>{t("指标采集：","Metric collection: ")}{config.host_enabled?t(`${config.collect_interval_seconds} 秒 → ${config.host_table}`,`${config.collect_interval_seconds} s → ${config.host_table}`):t("关闭","Off")}</Tag><Tag>{t("服务拨测：","Service probes: ")}{config.probes.length}  {t("个 →"," →")} {config.probe_table}</Tag><Tag>{t("目录日志：","Directory logs: ")}{config.logs_enabled?t(`${config.log_sources.length} 个 → ${config.log_table}`,`${config.log_sources.length} → ${config.log_table}`):t("关闭","Off")}</Tag></Space>:t("尚未获取配置","Configuration not received yet")},
  {key:'revision',label:t("中心配置版本","Platform configuration version"),children:<Typography.Text code>{agent.config?.revision || t("尚无版本","No version yet")}</Typography.Text>},
  {key:'actual-revision',label:t("节点已应用版本","Version applied by node"),children:<Typography.Text code>{String(heartbeat.config_revision || t("等待同步","Awaiting sync"))}</Typography.Text>},
  {key:'collectors',label:t("节点采集状态","Node collector status"),span:2,children:Object.keys((heartbeat.collectors_status ?? {}) as Record<string,unknown>).length?<Space size={[0,6]} wrap>{Object.entries(heartbeat.collectors_status as Record<string,string>).map(([name,status])=><Tag key={name} color={status==='ok'?'success':status==='disabled'?'default':'warning'}>{name==='file_logs'?t("目录日志","Directory logs"):hostCollectorName(name,uiLanguage)}：{status==='disabled'?t("已关闭","Disabled"):status}</Tag>)}</Space>:t("尚未收到采集状态","Collector status not received yet")},
 ]}/>;
}

function TaskDetails({task}:{task:ManagedAgentTask}) {
 const {t,language:uiLanguage}=useI18n();

 const config=normalizeTasks(task.config);
 if(task.type==='host') return <Descriptions size="small" column={{xs:1,sm:2}} items={[
  {key:'collectors',label:t("采集指标","Collected metrics"),span:2,children:config.host_collectors.map(value=>hostCollectorName(value,uiLanguage)).join(t('、',', ')) || t("未选指标","No metrics selected")},
  {key:'processes',label:t("进程名称","Process names"),span:2,children:config.process_names.join(t('、',', ')) || t("无指定进程","No specific processes")},
  {key:'interval',label:t("采集间隔","Collection interval"),children:t(`${config.collect_interval_seconds} 秒`,`${config.collect_interval_seconds} s`)},{key:'table',label:t("指标上报表","Metric reporting table"),children:config.host_table},
 ]}/>;
 if(task.type==='probe') return <div className="lm-agent-task-details"><Typography.Paragraph type="secondary">{t("拨测结果上报表：","Probe reporting table: ")}{config.probe_table}</Typography.Paragraph>{config.probes.map(probe=><Descriptions key={probe.id} size="small" column={{xs:1,sm:2}} items={[
  {key:'name',label:t("拨测名称","Probe name"),children:probe.id},{key:'type',label:t("类型","Type"),children:probe.kind==='http'?'HTTP / HTTPS':'TCP'},
  {key:'target',label:t("目标","Target"),span:2,children:probe.target},{key:'interval',label:t("拨测间隔","Probe interval"),children:t(`${probe.interval_seconds} 秒`,`${probe.interval_seconds} s`)},{key:'timeout',label:t("超时","Timeout"),children:t(`${probe.timeout_ms/1000} 秒`,`${probe.timeout_ms/1000} s`)},
  ...(probe.kind==='http'?[{key:'status',label:t("成功状态码","Successful status codes"),span:2,children:probe.expected_status?.length?probe.expected_status.join(t('、',', ')):'200–399'}]:[]),
 ]}/>)}{!config.probes.length&&<Typography.Text type="secondary">{t("未配置拨测目标","No probe targets configured")}</Typography.Text>}</div>;
 return <div className="lm-agent-task-details"><Typography.Paragraph type="secondary">{t("目录日志上报表：","Directory log reporting table: ")}{config.log_table}</Typography.Paragraph>{config.log_sources.map((source,index)=><Descriptions key={index} size="small" column={{xs:1,sm:2}} items={[
  {key:'directory',label:t("目录路径","Directory path"),span:2,children:source.directory},{key:'pattern',label:t("文件匹配规则","File pattern"),children:source.pattern},
  {key:'recursive',label:t("包含子目录","Include subdirectories"),children:source.recursive?t("是","Yes"):t("否","No")},{key:'beginning',label:t("首次采集","Initial collection"),span:2,children:source.from_beginning?t("从文件开头采集","Read from the beginning"):t("仅采集新增内容","Collect only new content")},
 ]}/>)}{!config.log_sources.length&&<Typography.Text type="secondary">{t("未配置日志目录","No log directories configured")}</Typography.Text>}</div>;
}

export default function AgentsPage({user,embeddedTab}:{user:User;embeddedTab?:'tasks'|'labels'}) {
 const {t,language:uiLanguage}=useI18n();
const time = (value:unknown) => value && String(value)!=='0001-01-01T00:00:00Z' && Number.isFinite(Date.parse(String(value)))?new Date(String(value)).toLocaleString(uiLanguage):t("尚无记录","No records yet");
const taskSummary = (task:ManagedAgentTask) => {
 const config=normalizeTasks(task.config);
 if(task.type==='host') return t(`${config.host_collectors.map(value=>hostCollectorName(value,uiLanguage)).join(t('、',', ')) || t("未选指标","No metrics selected")} · ${config.collect_interval_seconds} 秒 → ${config.host_table}`,`${config.host_collectors.map(value=>hostCollectorName(value,uiLanguage)).join(t('、',', ')) || t("未选指标","No metrics selected")} · ${config.collect_interval_seconds} s → ${config.host_table}`);
 if(task.type==='probe') return t(`${config.probes.length} 个拨测目标 → ${config.probe_table}`,`${config.probes.length} probe targets → ${config.probe_table}`);
 return t(`${config.log_sources.length} 个日志目录 → ${config.log_table}`,`${config.log_sources.length} log directories → ${config.log_table}`);
};

 const [agents,setAgents]=useState<AgentItem[]>([]),[labels,setLabels]=useState<AgentTaskLabel[]>([]),[tasks,setTasks]=useState<ManagedAgentTask[]>([]);
 const [searchParams,setSearchParams]=useSearchParams();
 const tabParam=searchParams.get('tab'),tab:PageTab=embeddedTab||(tabParam==='tasks'||tabParam==='labels'?tabParam:'nodes');
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
  } catch(error) {if(current===request.current)setError(failure(error,t("读取执行节点和任务失败","Unable to load execution nodes and tasks")));}
  finally {if(current===request.current)setLoading(false);}
 },[]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(true),10000);return()=>{clearInterval(timer);request.current++;};},[load]);
 const labelOptions=labels.map(label=>({value:label.id,label:label.name}));
 const labelNameById=(id:string)=>labels.find(label=>label.id===id)?.name ?? id;
 const renderLabels=(ids:string[])=>ids?.length?<Space size={[0,6]} wrap>{ids.map(id=><Tag key={id}>{labelNameById(id)}</Tag>)}</Space>:<Typography.Text type="secondary">{t("无任务标签","No task labels")}</Typography.Text>;
 const visibleAgents=labelFilter?agents.filter(agent=>agent.label_ids?.includes(labelFilter)):agents;
 const visibleTasks=labelFilter?tasks.filter(task=>task.label_ids?.includes(labelFilter)):tasks;
 const openLabel=(label:AgentTaskLabel|'new')=>{setLabelName(label==='new'?'':label.name);setLabelError('');setEditingLabel(label);};
 const openDelete=(item:Deleting)=>{setDeleteError('');setDeleting(item);};
 const saveLabel=async()=>{
  if(!editingLabel)return;
  const name=labelName.trim();
  if(!name){setLabelError(t("请输入任务标签名称","Enter a task label name"));return;}
  if(new TextEncoder().encode(name).length>128){setLabelError(t("标签名称最长 128 字节","Label names may contain up to 128 bytes"));return;}
  setLabelBusy(true);setLabelError('');
  try {await api(editingLabel==='new'?'/agent-task-labels':`/agent-task-labels/${encodeURIComponent(editingLabel.id)}`,{method:editingLabel==='new'?'POST':'PUT',body:JSON.stringify({name})});await load();setEditingLabel(undefined);void message.success(t("任务标签已保存","Task label saved"));}
  catch(error){setLabelError(failure(error,t("保存任务标签失败","Unable to save task label")));}
  finally{setLabelBusy(false);}
 };
 const toggleTask=async(task:ManagedAgentTask,enabled:boolean)=>{
  setToggling(task.id);setActionError('');
  try {await api(`/agent-tasks/${encodeURIComponent(task.id)}`,{method:'PUT',body:JSON.stringify({...task,enabled})});void message.success(enabled?t("任务已启用，匹配节点将自动同步","Task enabled. Matching nodes will sync automatically"):t("任务已停用，匹配节点将自动撤除","Task disabled. Matching nodes will remove it automatically"));await load();}
  catch(error){setActionError(failure(error,t("更改任务状态失败","Unable to change task status")));}
  finally{setToggling('');}
 };
 const filterControl=<Select allowClear showSearch={{optionFilterProp:'label'}} aria-label={t("按任务标签筛选","Filter by task label")} className="lm-agent-label-filter" placeholder={t("全部任务标签","All task labels")} value={labelFilter||undefined} onChange={value=>setFilter(value ?? '')} options={labelFilter&&!labels.some(label=>label.id===labelFilter)?[{value:labelFilter,label:t(`未知标签（${labelFilter}）`,`Unknown label (${labelFilter})`)},...labelOptions]:labelOptions}/>;
 const nodesPanel=<div className="lm-surface">
  <div className="lm-agent-policy-heading"><div><h2>{t("执行节点","Execution nodes")}</h2><p className="lm-agent-muted">{t("LightMoni Agent 的运行实例；每个节点可关联多个任务标签。","Running instances of LightMoni Agent. Each node can have multiple task labels.")}</p></div><Space wrap>{filterControl}<Link to="/machines"><Button type="primary">{t("管理主机","Manage hosts")}</Button></Link></Space></div>
  <Table<AgentItem> rowKey="id" dataSource={visibleAgents} loading={loading} scroll={{x:1050}} pagination={{pageSize:10,hideOnSinglePage:true}} expandable={{expandedRowRender:agent=><NodeDetails agent={agent}/>}} columns={[
   {title:t("节点名称","Node name"),dataIndex:'hostname',width:180,render:(hostname:string,agent:AgentItem)=><div className="lm-agent-node-name"><strong>{hostname || agent.id}</strong><Typography.Text type="secondary">{agent.platform} / {agent.arch}</Typography.Text></div>},
   {title:t("状态","Status"),width:110,render:(_:unknown,agent:AgentItem)=><Tag color={agentIsOnline(agent)?'success':'warning'}>{agentIsOnline(agent)?t("在线","Online"):t("心跳超时","Heartbeat timed out")}</Tag>},
   {title:t("任务标签","Task labels"),width:220,render:(_:unknown,agent:AgentItem)=>renderLabels(agent.label_ids ?? [])},
   {title:t("匹配任务","Matched tasks"),width:130,render:(_:unknown,agent:AgentItem)=>agent.tasks?.length?<span>{agent.tasks.length}  {t("个启用任务","enabled tasks")}</span>:<Typography.Text type="secondary">{t("无匹配任务","No matching tasks")}</Typography.Text>},
   {title:t("配置状态","Configuration status"),width:110,render:(_:unknown,agent:AgentItem)=>{const applied=!!agent.config?.revision&&agent.heartbeat?.config_revision===agent.config.revision;return <Tag color={applied?'success':'processing'}>{applied?t("已生效","Applied"):t("等待同步","Awaiting sync")}</Tag>;}},
   {title:t("最近心跳","Last heartbeat"),dataIndex:'last_seen',width:180,render:time},
   {title:t("操作","Actions"),width:130,render:(_:unknown,agent:AgentItem)=><Button size="small" disabled={!admin||!loaded} onClick={()=>{setMoveError('');setTargetLabels([...(agent.label_ids ?? [])]);setMoving(agent);}}>{t("设置任务标签","Set task labels")}</Button>},
  ]} locale={{emptyText:<Empty description={loaded?(labelFilter?t("没有匹配此任务标签的执行节点","No execution nodes match this task label"):t("尚未接入执行节点，安装 LightMoni Agent 后即可接收监控任务","No execution nodes enrolled. Install LightMoni Agent to receive monitoring tasks")):error?t("读取失败，请刷新重试","Unable to load. Refresh to try again"):t("正在读取执行节点","Loading execution nodes")}/>}}/>
 </div>;
 const tasksPanel=<div className="lm-surface">
  <div className="lm-agent-policy-heading"><div><h2>{t("任务管理","Task management")}</h2><p className="lm-agent-muted">{t("独立配置指标采集、服务拨测和目录日志，通过任务标签下发。","Configure metric collection, service probes, and directory logs independently and deliver them using task labels.")}</p></div><Space wrap>{filterControl}<Button type="primary" icon={<PlusOutlined/>} disabled={!admin||!loaded} onClick={()=>setEditing('new')}>{t("新建任务","Create task")}</Button></Space></div>
  <Table<ManagedAgentTask> rowKey="id" dataSource={visibleTasks} loading={loading} scroll={{x:1050}} pagination={{pageSize:10,hideOnSinglePage:true}} expandable={{expandedRowRender:task=><TaskDetails task={task}/>}} columns={[
   {title:t("任务名称","Task name"),dataIndex:'name',width:180,render:(name:string)=><strong className="lm-agent-wrapped">{name}</strong>},
   {title:t("任务类型","Task type"),dataIndex:'type',width:110,render:(type:ManagedAgentTask['type'])=>taskTypeName(type,uiLanguage)},
   {title:t("状态","Status"),width:110,render:(_:unknown,task:ManagedAgentTask)=><Switch aria-label={t(`启用任务 ${task.name}`,`Enable task ${task.name}`)} checked={task.enabled} checkedChildren={t("启用","Enabled")} unCheckedChildren={t("停用","Disabled")} disabled={!admin||!!toggling} loading={toggling===task.id} onChange={enabled=>void toggleTask(task,enabled)}/>},
   {title:t("任务标签","Task labels"),width:220,render:(_:unknown,task:ManagedAgentTask)=>task.label_ids?.length?renderLabels(task.label_ids):<Tag>{t("未分发","Not assigned")}</Tag>},
   {title:t("任务配置","Task configuration"),width:250,render:(_:unknown,task:ManagedAgentTask)=><span className="lm-agent-wrapped">{taskSummary(task)}</span>},
   {title:t("操作","Actions"),width:160,render:(_:unknown,task:ManagedAgentTask)=><Space><Button size="small" disabled={!admin||toggling===task.id} onClick={()=>setEditing(task)}>{t("编辑任务","Edit task")}</Button><Button size="small" danger disabled={!admin||toggling===task.id} onClick={()=>openDelete({kind:'task',id:task.id,name:task.name})}>{t("删除","Delete")}</Button></Space>},
  ]} locale={{emptyText:<Empty description={loaded?(labelFilter?t("没有关联此任务标签的任务","No tasks have this task label"):t("尚无监控任务；新建任务并选择任务标签后，匹配的节点会自动同步","No monitoring tasks yet. Create a task and select task labels; matching nodes will sync automatically")):error?t("读取失败，请刷新重试","Unable to load. Refresh to try again"):t("正在读取任务","Loading tasks")}/>}}/>
 </div>;
 const labelsPanel=<div className="lm-surface">
  <div className="lm-agent-policy-heading"><div><h2>{t("任务标签","Task labels")}</h2><p className="lm-agent-muted">{t("任务与节点有任一标签相同时即匹配；空标签不会广播任务。","Tasks match nodes with any shared label. Empty labels do not broadcast tasks.")}</p></div><Button type="primary" icon={<PlusOutlined/>} disabled={!admin||!loaded} onClick={()=>openLabel('new')}>{t("新建任务标签","Create task label")}</Button></div>
  <Table<AgentTaskLabel> rowKey="id" dataSource={labels} loading={loading} scroll={{x:650}} pagination={{pageSize:10,hideOnSinglePage:true}} columns={[
   {title:t("标签名称","Label name"),dataIndex:'name',render:(name:string,label:AgentTaskLabel)=><Space wrap><strong className="lm-agent-wrapped">{name}</strong>{label.id==='default'&&<Tag>{t("默认","Default")}</Tag>}</Space>},
   {title:t("执行节点","Execution nodes"),dataIndex:'node_count',width:110,render:(count:number,label:AgentTaskLabel)=><Button type="link" size="small" onClick={()=>viewLabel(label.id,'nodes')}>{count}  {t("个","items")}</Button>},
   {title:t("关联任务","Associated tasks"),dataIndex:'task_count',width:110,render:(count:number,label:AgentTaskLabel)=><Button type="link" size="small" onClick={()=>viewLabel(label.id,'tasks')}>{count}  {t("个","items")}</Button>},
   {title:t("操作","Actions"),width:180,render:(_:unknown,label:AgentTaskLabel)=><Space><Button size="small" disabled={!admin} onClick={()=>openLabel(label)}>{t("重命名","Rename")}</Button><Button size="small" danger disabled={!admin||label.id==='default'} onClick={()=>openDelete({kind:'label',id:label.id,name:label.name})}>{t("删除","Delete")}</Button></Space>},
  ]} locale={{emptyText:<Empty description={loaded?t("尚无任务标签","No task labels yet"):error?t("读取失败，请刷新重试","Unable to load. Refresh to try again"):t("正在读取任务标签","Loading task labels")}/>}}/>
 </div>;
 return <div className={embeddedTab?"lm-agents-page":"lm-page lm-agents-page"}>
  {!embeddedTab&&<div className="lm-page-heading"><div><h1>{t("节点助手","Node assistant")}</h1><p>{t("统一管理 LightMoni Agent，通过任务标签为执行节点下发指标采集、服务拨测和目录日志任务。","Manage LightMoni Agent and deliver metric collection, service probing, and directory log tasks to execution nodes using task labels.")}</p></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>{t("刷新","Refresh")}</Button></div>}
  {!admin&&<Alert type="info" showIcon title={t("当前为只读模式；仅管理员可修改节点标签、任务和任务标签。","Read-only mode. Only administrators can change node labels, tasks, and task labels.")} className="lm-agent-page-notice"/>}
  {error&&<Alert type="error" showIcon title={error} description={loaded?t("已保留上次读取的数据，可刷新重试。","The previous data is retained. Refresh to try again."):t("请刷新重试。","Refresh to try again.")} className="lm-agent-page-notice"/>}
  {actionError&&<Alert type="error" showIcon title={actionError} closable afterClose={()=>setActionError('')} className="lm-agent-page-notice"/>}
  {embeddedTab?(embeddedTab==='tasks'?tasksPanel:labelsPanel):<Tabs className="lm-agent-tabs" activeKey={tab} onChange={setTab} items={[{key:'nodes',label:t("执行节点","Execution nodes"),children:nodesPanel},{key:'tasks',label:t("任务管理","Task management"),children:tasksPanel},{key:'labels',label:t("任务标签","Task labels"),children:labelsPanel}]}/>}
  <Modal title={editing==='new'?t("新建任务","Create task"):t(`编辑任务 · ${editing?.name ?? ''}`,`Edit task · ${editing?.name ?? ''}`)} open={!!editing} onCancel={()=>{if(!taskBusy)setEditing(undefined);}} closable={!taskBusy} keyboard={!taskBusy} maskClosable={false} footer={null} width={760} destroyOnHidden>
   {editing&&<AgentTaskEditor key={editing==='new'?'new':editing.id} task={editing==='new'?undefined:editing} labels={labels} onBusyChange={setTaskBusy} onCancel={()=>setEditing(undefined)} onSave={async draft=>{await api(editing==='new'?'/agent-tasks':`/agent-tasks/${encodeURIComponent(editing.id)}`,{method:editing==='new'?'POST':'PUT',body:JSON.stringify(draft)});await load();setEditing(undefined);void message.success(t("任务已保存，匹配的执行节点将自动同步","Task saved. Matching execution nodes will sync automatically"));}}/>}
  </Modal>
  <Modal title={t(`设置任务标签 · ${moving?.hostname || moving?.id || ''}`,`Set task labels · ${moving?.hostname || moving?.id || ''}`)} open={!!moving} onCancel={()=>{if(!moveBusy)setMoving(undefined);}} closable={!moveBusy} keyboard={!moveBusy} maskClosable={false} confirmLoading={moveBusy} okText={t("保存任务标签","Save task labels")} cancelButtonProps={{disabled:moveBusy}} destroyOnHidden onOk={async()=>{
   if(!moving)return;setMoveBusy(true);setMoveError('');
   try {await api(`/agents/${encodeURIComponent(moving.id)}/labels`,{method:'PUT',body:JSON.stringify({label_ids:targetLabels})});await load();setMoving(undefined);void message.success(t("节点任务标签已保存，将自动同步匹配任务","Node task labels saved. Matching tasks will sync automatically"));}
   catch(error){setMoveError(failure(error,t("保存节点任务标签失败","Unable to save node task labels")));}
   finally{setMoveBusy(false);}
  }}>
   <p>{t("可选择多个任务标签，节点接收任一标签匹配的启用任务。请确认上报 Key 已授权这些任务的目标表。","Select multiple task labels. The node receives enabled tasks matching any label. Ensure the reporting key permits their target tables.")}</p>
   <Select mode="multiple" allowClear showSearch={{optionFilterProp:'label'}} aria-label={t("节点任务标签","Node task labels")} style={{width:'100%'}} value={targetLabels} onChange={setTargetLabels} disabled={moveBusy} options={labelOptions} placeholder={t("选择任务标签","Select task labels")}/>
   {!targetLabels.length&&<Alert type="info" showIcon title={t("未选择任务标签，节点将暂停指标采集、日志采集和拨测；SDK 独立直报不受影响。","No task labels selected. Metric and log collection and probing will pause; independent SDK reporting is unaffected.")} className="lm-agent-form-notice"/>}
   {moveError&&<Alert type="error" showIcon title={moveError} className="lm-agent-form-notice"/>}
  </Modal>
  <Modal title={editingLabel==='new'?t("新建任务标签","Create task label"):t(`重命名任务标签 · ${editingLabel?.name ?? ''}`,`Rename task label · ${editingLabel?.name ?? ''}`)} open={!!editingLabel} onCancel={()=>{if(!labelBusy)setEditingLabel(undefined);}} closable={!labelBusy} keyboard={!labelBusy} maskClosable={false} confirmLoading={labelBusy} okText={t("保存标签","Save label")} cancelButtonProps={{disabled:labelBusy}} destroyOnHidden onOk={()=>void saveLabel()}>
   <label className="lm-agent-input-label" htmlFor="lm-agent-label-name">{t("标签名称","Label name")}</label><Input id="lm-agent-label-name" aria-label={t("标签名称","Label name")} value={labelName} disabled={labelBusy} onChange={event=>setLabelName(event.target.value)} onPressEnter={()=>{if(!labelBusy)void saveLabel();}} placeholder={t("例如：生产环境、订单服务","Example: Production, Order service")}/>
   <p className="lm-agent-report-note lm-agent-muted">{t("标签用于关联任务与执行节点。新建标签后，请为节点和任务分别设置此标签。","Labels connect tasks and execution nodes. After creating a label, assign it to both the nodes and tasks.")}</p>
   {labelError&&<Alert type="error" showIcon title={labelError} className="lm-agent-form-notice"/>}
  </Modal>
  <Modal title={t(`删除${deleting?.kind==='task'?t("任务","Task"):t("任务标签","Task labels")} · ${deleting?.name ?? ''}？`,`Delete ${deleting?.kind==='task'?t("任务","Task"):t("任务标签","Task labels")} · ${deleting?.name ?? ''}?`)} open={!!deleting} onCancel={()=>{if(!deleteBusy)setDeleting(undefined);}} closable={!deleteBusy} keyboard={!deleteBusy} maskClosable={false} confirmLoading={deleteBusy} okText={t("确认删除","Confirm deletion")} okButtonProps={{danger:true}} cancelButtonProps={{disabled:deleteBusy}} destroyOnHidden onOk={async()=>{
   if(!deleting)return;setDeleteBusy(true);setDeleteError('');
   try {await api(`${deleting.kind==='task'?'/agent-tasks':'/agent-task-labels'}/${encodeURIComponent(deleting.id)}`,{method:'DELETE'});if(deleting.kind==='label'&&deleting.id===labelFilter)setFilter('');await load();setDeleting(undefined);void message.success(t("已删除","Deleted"));}
   catch(error){setDeleteError(failure(error,t("删除失败","Unable to delete")));}
   finally{setDeleteBusy(false);}
  }}>
   <p>{deleting?.kind==='task'?t("删除后，所有匹配的执行节点将自动撤除此任务。","After deletion, all matching execution nodes will automatically remove this task."):t("仍被执行节点或任务引用的标签无法删除，请先解除关联。默认标签保留。","Labels referenced by nodes or tasks cannot be deleted. Remove their associations first. The default label is retained.")}</p>
   {deleteError&&<Alert type="error" showIcon title={deleteError} className="lm-agent-form-notice"/>}
  </Modal>
 </div>;
}
