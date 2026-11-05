import {useState} from 'react';
import {Alert,Empty,Select,Table} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {time,type Spec} from './ops/model';
import Plot from './TelemetryPlot';
export default function SDKTelemetry({data}:{data?:Spec}){
 const {t}=useI18n(),[selected,setSelected]=useState('');
 const metrics:Spec[]=data?.results?.sdk_metrics?.rows??[],logs:Spec[]=data?.results?.sdk_logs?.rows??[];
 const key=(r:Spec)=>r.table_name+' / '+r.name+' ('+r.unit+')';
 const names=[...new Set(metrics.map(key))],current=names.includes(selected)?selected:names[0];
 return <section aria-label={t('SDK 指标与日志','SDK metrics and logs')}>
  {!metrics.length&&!logs.length&&<Alert type="info" showIcon title={t('尚未采集到此应用的 SDK 数据','No SDK data received for this application')} description={t('容器负载与输出日志由平台自动采集；业务指标和日志需要应用接入 SDK 并实际产生数据。','Container load and output logs are collected automatically. Business metrics and logs require SDK integration and events from the application.')}/>}
  {data?.sdk_tables_truncated&&<Alert type="warning" showIcon title={t('数据表较多，本次仅查询前 32 张业务表','Only the first 32 business tables were queried')}/>}
  <h2>{t('SDK 指标','SDK metrics')}</h2>
  {names.length>0&&<><Select style={{minWidth:300,maxWidth:'100%'}} aria-label={t('SDK 指标选择','Select SDK metric')} value={current} onChange={setSelected} options={names.map(value=>({value,label:value}))}/><Plot title={current} unit={metrics.find(r=>key(r)===current)?.unit??''} rows={metrics.filter(r=>key(r)===current).map(r=>({...r,series_label:r.instance_id||t('默认实例','Default instance')}))} range={data?.range}/><Table<Spec> size="small" rowKey={r=>r.table_name+r.name+r.instance_id+r.time} dataSource={metrics.filter(r=>key(r)===current).slice(-30).reverse()} pagination={{pageSize:10}} columns={[{title:t('时间','Time'),dataIndex:'time',render:time},{title:t('实例','Instance'),dataIndex:'instance_id'},{title:t('均值','Mean'),dataIndex:'value'},{title:t('样本数','Samples'),dataIndex:'samples'}]}/></>}
  <h2>{t('SDK 日志','SDK logs')}</h2>
  <Table<Spec> size="small" rowKey={r=>r.table_name+r.event_id} dataSource={logs} pagination={{pageSize:20}} scroll={{x:850}} locale={{emptyText:<Empty description={t('此时间范围内暂无 SDK 日志','No SDK logs in this time range')}/>}} columns={[{title:t('时间','Time'),dataIndex:'event_time',width:180,render:time},{title:t('数据表','Table'),dataIndex:'table_name',width:160},{title:t('实例','Instance'),dataIndex:'instance_id',width:170},{title:t('级别','Level'),dataIndex:'severity',width:90},{title:t('日志内容','Log message'),dataIndex:'body',render:v=><pre className="lm-application-log">{v}</pre>}]}/>
 </section>;
}
