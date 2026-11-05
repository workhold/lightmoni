import {Empty} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {useAppearance} from '../shared/appearance';
import TimeSeriesPlot from '../features/dashboards/TimeSeriesPlot';
import type {Panel} from '../features/dashboards/model';
import type {Spec} from './ops/model';
export default function Plot({title,unit,rows,range,emptyText}:{title:string;unit:string;rows:Spec[];range?:{from:string;to:string};emptyText?:string}){
 const {t}=useI18n(),{dark}=useAppearance();
 const points=rows.map(r=>({__x:Date.parse(String(r.time).replace(' ','T')+(/Z|\+\d\d:\d\d$/.test(String(r.time))?'':'Z')),__y:Number(r.value),__series:r.series_label??(r.container_name??r.website_id??'')+' · '+String(r.container_id??r.cluster_id??'').slice(0,8),__refId:'A'}));
 const series=[...new Set(points.map(r=>r.__series))];
 const panel:Panel={id:title,title,type:'timeseries',queries:[],options:{unit,decimals:2,show_thresholds:false,show_points:true},grid:{x:0,y:0,w:12,h:6}};
 return <section className="lm-application-plot"><h2>{title}</h2><div className="lm-application-chart">{points.length?<TimeSeriesPlot panel={panel} rows={points} series={series} hidden={[]} range={range} dark={dark} alertRules={[]} alertEvents={[]}/>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText??t('等待指标上报','Waiting for metrics')}/>}</div><small className="lm-ops-note">{series.join(' · ')}</small></section>;
}
