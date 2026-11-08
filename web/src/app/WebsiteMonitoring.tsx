import {useCallback,useEffect,useRef,useState} from 'react';
import {useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {ArrowLeftOutlined,BarChartOutlined,FileTextOutlined,ReloadOutlined,SearchOutlined} from '@ant-design/icons';
import {Alert,Empty,Input,Select,Space,Spin,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {errorText,time,type Overview,type Spec} from './ops/model';
import IconAction from './ops/IconAction';
import LogDetailDrawer from './ops/LogDetailDrawer';
import Plot from './TelemetryPlot';
import TelemetryCollectionStatus from './TelemetryCollectionStatus';
import './operations.css';

// Structured zero values are valid. Older entries retain their original JSON body.
const access=(row:Spec,key:string):string|number=>{
 if(row[key]!==undefined&&row[key]!==null&&row[key]!=='')return row[key];
 try{return JSON.parse(row.body)[key==='duration'?'request_time':key]??'—'}catch{return '—'}
};
const duration=(row:Spec)=>{const value=access(row,'duration');return value!=='—'&&Number.isFinite(Number(value))?Number(value).toFixed(3):value};
const httpColor=(value:unknown)=>Number(value)>=500?'error':Number(value)>=400?'warning':Number(value)>=200&&Number(value)<300?'success':undefined;
export default function WebsiteMonitoring(){
 const {id}=useParams(),navigate=useNavigate(),{t}=useI18n(),[params,setParams]=useSearchParams();
 const minutes=[15,60,360,1440].includes(Number(params.get('minutes')))?Number(params.get('minutes')):60,tab=params.get('tab')==='logs'?'logs':'overview';
 const [data,setData]=useState<Spec>(),[clusters,setClusters]=useState<Spec[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),sequence=useRef(0);
 const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[entry,setEntry]=useState<Spec>();
 const change=(key:string,value:string)=>setParams(previous=>{const next=new URLSearchParams(previous);next.set(key,value);return next});
 const load=useCallback(async()=>{const n=++sequence.current;setLoading(true);const to=new Date(),from=new Date(to.getTime()-minutes*60000);try{const r=await api<Spec>('/ops/resources/'+encodeURIComponent(id??'')+'/website-telemetry?'+new URLSearchParams({from:from.toISOString(),to:to.toISOString()}));if(n===sequence.current){setData(r);setError('')}}catch(e){if(n===sequence.current)setError(errorText(e))}finally{if(n===sequence.current)setLoading(false)}},[id,minutes]);
 useEffect(()=>{setData(undefined);setEntry(undefined);void load();const timer=setInterval(()=>void load(),15000);return()=>{sequence.current++;clearInterval(timer)}},[load]);
 useEffect(()=>{setQuery('');setStatus('all');let active=true;void api<Overview>('/ops/overview').then(result=>{if(active)setClusters(result.resources.filter(r=>r.kind==='cluster'))}).catch(()=>{if(active)setClusters([])});return()=>{active=false}},[id]);
 const rows:Spec[]=data?.results?.web?.rows??[],logs:Spec[]=data?.results?.access?.rows??[];
 const series=(field:string)=>rows.map(r=>({...r,value:r[field],series_label:clusters.find(c=>c.id===r.cluster_id)?.name??r.cluster_id}));
 const filtered=logs.filter(row=>(status==='all'||Math.floor(Number(access(row,'status'))/100)===Number(status))&&(!query.trim()||['host','method','uri','status'].map(key=>access(row,key)).join(' ').toLowerCase().includes(query.trim().toLowerCase())));
 const fields=(row:Spec)=>[{key:'time',label:t('时间','Time'),children:time(row.event_time)},{key:'host',label:t('域名','Host'),children:access(row,'host')},{key:'method',label:t('方法','Method'),children:access(row,'method')},{key:'status',label:t('状态码','Status code'),children:<Tag color={httpColor(access(row,'status'))}>{access(row,'status')}</Tag>},{key:'duration',label:t('耗时（秒）','Duration (s)'),children:duration(row)},{key:'cluster',label:t('集群','Cluster'),children:clusters.find(c=>c.id===row.cluster_id)?.name??row.cluster_id??'—'},{key:'path',label:t('请求路径','Request path'),span:'filled' as const,children:<Typography.Text className="lm-log-path">{access(row,'uri')}</Typography.Text>}];
 return <div className="lm-page lm-operations-page lm-website-monitoring">

  {error&&<Alert showIcon type="error" title={t('监控加载失败','Could not load monitoring')} description={error}/>}
  <TelemetryCollectionStatus hosts={data?.hosts??[]}/>
  {data?.waiting&&<Alert showIcon type="info" title={t('等待首次上报','Waiting for the first observation')}/>}
  <div className="lm-monitor-workspace"><div className="lm-content-toolbar"><div className="lm-monitor-heading"><IconAction label={t('返回网站','Back to websites')} type="text" icon={<ArrowLeftOutlined aria-hidden/>} onClick={()=>navigate('/websites')}/><strong>{data?.website.name??t('网站监控','Website monitoring')}</strong></div><Space><Select aria-label={t('监控时间范围','Monitoring time range')} value={minutes} onChange={v=>change('minutes',String(v))} options={[15,60,360,1440].map(value=>({value,label:t('最近 ','Last ')+(value<60?value+t(' 分钟',' minutes'):value/60+t(' 小时',' hours'))}))}/><IconAction label={t('刷新','Refresh')} icon={<ReloadOutlined aria-hidden/>} loading={loading} onClick={()=>void load()}/></Space></div><Spin spinning={loading&&!data}><Tabs activeKey={tab} onChange={v=>change('tab',v)} animated={{inkBar:true,tabPane:false}} items={[
   {key:'overview',label:<span><BarChartOutlined aria-hidden/> {t('访问大盘','Traffic overview')}</span>,children:<>
    {data?.results?.web?.status==='error'?<Alert showIcon type="error" title={t('流量数据加载失败','Could not load traffic data')} description={String(data.results.web.error)}/>:<div className="lm-application-charts"><Plot title={t('网站 QPS（分钟均值）','Website QPS (minute average)')} unit="reqps" rows={series('qps')} range={data?.range} emptyText={t('此时间范围内暂无请求数据','No request data in this time range')}/><Plot title={t('请求耗时（秒）','Request duration (s)')} unit="s" rows={series('duration')} range={data?.range} emptyText={t('此时间范围内暂无请求数据','No request data in this time range')}/></div>}
    {data?.results?.web?.truncated&&<Alert showIcon type="warning" title={t('流量数据已截断，请缩短时间范围','Traffic results truncated; shorten the time range')}/>}
   </>},
   {key:'logs',label:<span><FileTextOutlined aria-hidden/> {t('访问日志','Access logs')}</span>,children:<>
    <div className="lm-log-toolbar"><Input allowClear prefix={<SearchOutlined aria-hidden/>} aria-label={t('筛选已加载日志','Filter loaded logs')} placeholder={t('搜索域名、路径或方法','Search host, path or method')} value={query} onChange={e=>setQuery(e.target.value)}/><Select aria-label={t('状态码筛选','Filter status codes')} value={status} onChange={setStatus} options={[{value:'all',label:t('全部状态码','All status codes')},...[2,3,4,5].map(code=>({value:String(code),label:code+'xx'}))]}/><Typography.Text type="secondary" aria-live="polite">{t(`已加载 ${logs.length} 条 · 匹配 ${filtered.length} 条`,`Loaded ${logs.length} · Matching ${filtered.length}`)}</Typography.Text></div>
    {data?.results?.access?.status==='error'?<Alert showIcon type="error" title={t('访问日志加载失败','Could not load access logs')} description={String(data.results.access.error)}/>:<Table<Spec> size="small" rowKey="event_id" dataSource={filtered} pagination={{pageSize:20,showSizeChanger:false,hideOnSinglePage:true}} scroll={{x:960}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={logs.length?t('没有符合筛选条件的日志','No logs match your filters'):t('此时间范围内暂无访问日志','No access logs in this time range')}/>}} columns={[
     {title:t('时间','Time'),dataIndex:'event_time',width:178,render:time},{title:t('域名','Host'),width:170,ellipsis:true,render:(_,r)=>access(r,'host')},{title:t('方法','Method'),width:80,render:(_,r)=><span className="lm-log-method">{access(r,'method')}</span>},{title:t('路径','Path'),width:220,ellipsis:true,render:(_,r)=>access(r,'uri')},{title:t('状态码','Status'),width:85,render:(_,r)=><Tag color={httpColor(access(r,'status'))}>{access(r,'status')}</Tag>},{title:t('耗时（秒）','Duration (s)'),width:105,align:'right',render:(_,r)=>duration(r)},{title:t('操作','Actions'),width:64,fixed:'right',render:(_,r)=><IconAction label={t('日志详情','Log details')} type="text" icon={<FileTextOutlined aria-hidden/>} onClick={()=>setEntry(r)}/>}
    ]}/>}
    {data?.results?.access?.truncated&&<Alert showIcon type="warning" title={t('日志已截断，筛选仅针对已加载记录；请缩短时间范围','Logs truncated. Filters apply to loaded records; shorten the time range')}/>}
   </>}
  ]}/></Spin></div>
  <LogDetailDrawer open={!!entry} onClose={()=>setEntry(undefined)} fields={entry?fields(entry):[]} body={entry?.body}/>
 </div>;
}
