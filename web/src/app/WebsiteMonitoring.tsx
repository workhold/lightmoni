import IconAction from './ops/IconAction';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {ArrowLeftOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Empty,Select,Spin,Table} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {errorText,time,type Spec} from './ops/model';
import Plot from './TelemetryPlot';
import TelemetryCollectionStatus from './TelemetryCollectionStatus';
import './operations.css';
export default function WebsiteMonitoring(){
 const {id}=useParams(),navigate=useNavigate(),{t}=useI18n(),[minutes,setMinutes]=useState(60),[data,setData]=useState<Spec>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),sequence=useRef(0);
 const load=useCallback(async()=>{const n=++sequence.current;setLoading(true);const to=new Date(),from=new Date(to.getTime()-minutes*60000);try{const r=await api<Spec>('/ops/resources/'+encodeURIComponent(id??'')+'/website-telemetry?'+new URLSearchParams({from:from.toISOString(),to:to.toISOString()}));if(n===sequence.current){setData(r);setError('')}}catch(e){if(n===sequence.current)setError(errorText(e))}finally{if(n===sequence.current)setLoading(false)}},[id,minutes]);
 useEffect(()=>{setData(undefined);void load();const timer=setInterval(()=>void load(),15000);return()=>{sequence.current++;clearInterval(timer)}},[load]);
 const rows:Spec[]=data?.results?.web?.rows??[],logs:Spec[]=data?.results?.access?.rows??[];
 const series=(field:string)=>rows.map(r=>({...r,value:r[field],series_label:r.cluster_id}));
 const access=(r:Spec,k:string)=>{if(r[k])return r[k];try{const j=JSON.parse(r.body);return j[k==='duration'?'request_time':k]??'—'}catch{return '—'}};
 return <div className="lm-page lm-operations-page"><div className="lm-page-heading"><div><IconAction label={t('返回网站','Back to websites')} type="text" icon={<ArrowLeftOutlined aria-hidden/>} onClick={()=>navigate('/websites')}/><h1>{data?.website.name??t('网站监控','Website monitoring')}</h1><p>{t('请求流量与访问日志','Request traffic and access logs')}</p></div><IconAction label={t('刷新','Refresh')} icon={<ReloadOutlined aria-hidden/>} loading={loading} onClick={()=>void load()}/></div>
  {error&&<Alert showIcon type="error" title={error}/>}{Object.values(data?.results??{}).filter((r:any)=>r.status==='error').map((r:any,i)=><Alert key={i} showIcon type="error" title={r.error}/>)}
  <Select aria-label={t('监控时间范围','Monitoring time range')} value={minutes} onChange={setMinutes} options={[15,60,360,1440].map(value=>({value,label:value<60?value+t(' 分钟',' minutes'):value/60+t(' 小时',' hours')}))}/>
  <TelemetryCollectionStatus hosts={data?.hosts??[]}/>
  <Spin spinning={loading&&!data}><div className="lm-application-charts"><Plot title={t('网站 QPS（分钟均值）','Website QPS (minute average)')} unit="reqps" rows={series('qps')} range={data?.range} emptyText={t('此时间范围内暂无请求数据','No request data in this time range')}/><Plot title={t('请求耗时 (秒)','Request duration (s)')} unit="s" rows={series('duration')} range={data?.range}/></div>
  <h2>{t('访问日志','Access logs')}</h2><Table<Spec> size="small" rowKey="event_id" dataSource={logs} pagination={{pageSize:20}} scroll={{x:1100}} locale={{emptyText:<Empty description={t('此时间范围内暂无访问日志','No access logs in this time range')}/>}} columns={[{title:t('时间','Time'),dataIndex:'event_time',width:180,render:time},{title:t('域名','Host'),width:180,render:(_,r)=>access(r,'host')},{title:t('方法','Method'),width:80,render:(_,r)=>access(r,'method')},{title:t('路径','Path'),width:220,render:(_,r)=>access(r,'uri')},{title:t('状态码','Status'),width:80,render:(_,r)=>access(r,'status')},{title:t('耗时 (秒)','Duration (s)'),width:100,render:(_,r)=>access(r,'duration')},{title:t('原始日志','Raw log'),dataIndex:'body',render:v=><pre className="lm-application-log">{v}</pre>}]}/></Spin>
 </div>;
}
