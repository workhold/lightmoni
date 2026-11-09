import {Empty} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {useAppearance} from '../shared/appearance';
import TimeSeriesPlot from '../features/dashboards/TimeSeriesPlot';
import {colorForSeries,type Panel} from '../features/dashboards/model';
import {formatValue} from '../features/dashboards/formatting';
import {calculate} from '../features/dashboards/statistics';
import type {Spec} from './ops/model';
import './telemetry-values.css';
export default function Plot({title,unit,rows,range,emptyText}:{title:string;unit:string;rows:Spec[];range?:{from:string;to:string};emptyText?:string}){
 const {t}=useI18n(),{dark}=useAppearance();
 const points=rows.map(r=>{
  const value=typeof r.value==='number'||typeof r.value==='string'&&r.value.trim()!==''?Number(r.value):NaN;
  return {__x:Date.parse(String(r.time).replace(' ','T')+(/Z|[+-]\d\d:\d\d$/.test(String(r.time))?'':'Z')),__y:Number.isFinite(value)?value:null,__series:String(r.series_label??(r.container_name??r.website_id??'')+' · '+String(r.container_id??r.cluster_id??'').slice(0,8)),__refId:'A'};
 }).filter(point=>Number.isFinite(point.__x)).sort((a,b)=>a.__x-b.__x);
 const series=[...new Set(points.map(r=>r.__series))];
 const panel:Panel={id:title,title,type:'timeseries',queries:[],options:{unit,decimals:2,show_thresholds:false,show_points:true},grid:{x:0,y:0,w:12,h:6}};
 const summaries=series.map(name=>{
  const samples=points.filter(point=>point.__series===name),values=samples.map(point=>point.__y);
  return {name,latest:samples.filter(point=>point.__y!==null).at(-1),values};
 });
 return <section className="lm-application-plot"><h2>{title}</h2><div className="lm-application-chart">{points.length?<TimeSeriesPlot panel={panel} rows={points} series={series} hidden={[]} range={range} dark={dark} alertRules={[]} alertEvents={[]}/>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText??t('等待指标上报','Waiting for metrics')}/>}</div>{summaries.length>0&&<ul className="lm-telemetry-values" aria-label={title+' · '+t('数值统计','Value statistics')}>{summaries.map(({name,latest,values},index)=><li key={name}>
  <span className="lm-telemetry-series"><i aria-hidden style={{background:colorForSeries(name,index,panel.options)}}/><span>{name}</span></span>
  <dl>{[['lastNotNull',t('最新值','Latest')],['mean',t('平均值','Average')],['max',t('最大值','Maximum')]].map(([reducer,label])=><div key={reducer}><dt>{label}</dt><dd title={reducer==='lastNotNull'&&latest?t('最新有效样本：','Latest valid sample: ')+new Date(latest.__x).toLocaleString():undefined}>{formatValue(calculate(values,reducer),unit,2)}</dd></div>)}</dl>
 </li>)}</ul>}</section>;
}
