import {useCallback,useEffect,useRef,useState} from 'react';
import {FileTextOutlined,ReloadOutlined,SearchOutlined} from '@ant-design/icons';
import {Alert,Drawer,Empty,Input,Select,Space,Table,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import IconAction from './IconAction';
import OperationStatus,{LogLevel} from './OperationStatus';
import LogDetailDrawer from './LogDetailDrawer';
import {ACTION_NAMES,errorText,time,type Spec} from './model';
export default function SystemLogDrawer({kind,resourceId,machineId,clusterId,onRun}:{kind?:string;resourceId?:string;machineId?:string;clusterId?:string;onRun?:(id:string)=>void}){
 const {t}=useI18n(),[open,setOpen]=useState(false),[hours,setHours]=useState(24),[rows,setRows]=useState<Spec[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[waiting,setWaiting]=useState(false),request=useRef(0);
 const [query,setQuery]=useState(''),[entry,setEntry]=useState<Spec>();
 const load=useCallback(async()=>{const current=++request.current;setLoading(true);try{const to=new Date(),p=new URLSearchParams({from:new Date(to.getTime()-hours*3600000).toISOString(),to:to.toISOString()});if(kind)p.set('kind',kind);if(resourceId)p.set('resource_id',resourceId);if(machineId)p.set('machine_id',machineId);if(clusterId)p.set('cluster_id',clusterId);const result=await api<Spec>('/ops/system-logs?'+p);if(current!==request.current)return;if(result.status==='error')throw Error(result.error);setRows(result.rows??[]);setWaiting(result.waiting===true);setError('')}catch(e){if(current===request.current)setError(errorText(e));}finally{if(current===request.current)setLoading(false)}},[kind,resourceId,machineId,clusterId,hours]);
 useEffect(()=>{if(!open)return;void load();const interval=setInterval(()=>void load(),10000);return()=>{request.current++;clearInterval(interval)}},[open,load]);
 useEffect(()=>{setOpen(false);setEntry(undefined);setRows([]);setQuery('');setError('')},[kind,resourceId,machineId,clusterId]);
 const event=(r:Spec)=>{const value=r.attributes?.action??r.attributes?.operation??r.attributes?.event??r.attributes?.source;return ACTION_NAMES[value]?t(...ACTION_NAMES[value]):value||'—'};
 const filtered=rows.filter(r=>!query.trim()||[event(r),r.severity,r.attributes?.state,r.attributes?.status,r.body].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
 return <><IconAction label={t('操作日志','Operation logs')} icon={<FileTextOutlined aria-hidden/>} onClick={()=>setOpen(true)}/><Drawer title={t('操作日志','Operation logs')} open={open} onClose={()=>{setOpen(false);setEntry(undefined)}} size="min(960px, 100vw)" destroyOnHidden>
  <div className="lm-log-toolbar"><Select aria-label={t('日志时间范围','Log time range')} value={hours} onChange={setHours} options={[{value:1,label:t('最近 1 小时','Last hour')},{value:6,label:t('最近 6 小时','Last 6 hours')},{value:24,label:t('最近 24 小时','Last 24 hours')}]}/><Input allowClear prefix={<SearchOutlined aria-hidden/>} aria-label={t('筛选已加载日志','Filter loaded logs')} placeholder={t('搜索事件或日志内容','Search event or log content')} value={query} onChange={e=>setQuery(e.target.value)}/><IconAction label={t('刷新','Refresh')} icon={<ReloadOutlined aria-hidden/>} loading={loading} onClick={()=>void load()}/></div>
  <p className="lm-ops-note" aria-live="polite">{t(`已加载 ${rows.length} 条 · 匹配 ${filtered.length} 条`,`Loaded ${rows.length} · Matching ${filtered.length}`)}</p>
  {error&&<Alert type="error" showIcon title={t('日志加载失败，保留上次结果','Could not load logs; showing the last result')} description={error}/>}
  <Table<Spec> size="small" loading={loading} rowKey="event_id" dataSource={filtered} pagination={{pageSize:20,showSizeChanger:false,hideOnSinglePage:true}} scroll={{x:720}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={rows.length?t('没有符合筛选条件的日志','No logs match your filters'):waiting?t('等待系统日志上报','Waiting for system logs'):t('此时间范围内暂无操作日志','No operation logs in this time range')}/>}} columns={[
   {title:t('时间','Time'),dataIndex:'event_time',width:180,render:time},{title:t('级别','Level'),dataIndex:'severity',width:85,render:value=><LogLevel value={value}/>},{title:t('事件','Event'),width:220,ellipsis:true,render:(_,r)=>event(r)},{title:t('状态','State'),width:120,render:(_,r)=><OperationStatus state={r.attributes?.state??r.attributes?.status??r.attributes?.phase??''}/>},{title:t('操作','Actions'),width:100,fixed:'right',render:(_,r)=><Space size={2}><IconAction label={t('日志详情','Log details')} type="text" icon={<SearchOutlined aria-hidden/>} onClick={()=>setEntry(r)}/>{onRun&&['ops_platform_runs','ops_platform_run_events'].includes(r.attributes?.source)&&<IconAction label={t('查看回执','View receipt')} type="text" icon={<FileTextOutlined aria-hidden/>} onClick={()=>onRun(r.attributes.run_id??r.attributes.record_id)}/>}</Space>}
  ]}/>
 </Drawer><LogDetailDrawer open={!!entry} onClose={()=>setEntry(undefined)} body={entry?.body} fields={entry?[
  {key:'time',label:t('时间','Time'),children:time(entry.event_time)},{key:'level',label:t('级别','Level'),children:<LogLevel value={entry.severity}/>},{key:'event',label:t('事件','Event'),children:event(entry)},{key:'state',label:t('状态','State'),children:<OperationStatus state={entry.attributes?.state??entry.attributes?.status??''}/>},
  ...Object.entries(entry.attributes??{}).filter(([key])=>!['action','operation','event','state','status'].includes(key)).map(([key,value])=>({key,label:key,span:'filled' as const,children:<Typography.Text className="lm-result-id">{String(value)}</Typography.Text>}))
 ]:[]}/></>;
}
