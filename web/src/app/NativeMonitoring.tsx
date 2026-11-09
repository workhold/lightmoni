import {useEffect,useState} from 'react';
import {ReloadOutlined} from '@ant-design/icons';
import {Button,Select,Space} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import PanelCard from '../features/dashboards/PanelCard';
import type {Panel} from '../features/dashboards/model';
import '../features/dashboards/dashboards.css';
import './native-monitoring.css';

/** Platform views share the existing query/chart renderer without entering dashboard editing. */
export default function NativeMonitoring({panels}:{panels:Panel[]}) {
 const {t}=useI18n(),[minutes,setMinutes]=useState(60),[tick,setTick]=useState(0),[range,setRange]=useState(()=>windowRange(60));
 useEffect(()=>{setRange(windowRange(minutes));const timer=setInterval(()=>{setRange(windowRange(minutes));setTick(value=>value+1)},15000);return()=>clearInterval(timer)},[minutes]);
 return <><Space wrap className="lm-native-toolbar"><Select aria-label={t('监控时间范围','Monitoring time range')} value={minutes} onChange={setMinutes} options={[15,60,360,1440].map(value=>({value,label:t(`最近 ${value} 分钟`,`Last ${value} minutes`)}))}/><Button icon={<ReloadOutlined aria-hidden/>} onClick={()=>{setRange(windowRange(minutes));setTick(value=>value+1)}}>{t('刷新','Refresh')}</Button></Space><div className="lm-native-panels">{panels.map(panel=><section key={panel.id} className={['table','timeline'].includes(panel.type)?'is-wide':''}><PanelCard panel={panel} variables={[]} values={{}} choices={{}} range={range} tick={tick} editing={false} onBrush={(from,to)=>setRange({from:new Date(from).toISOString(),to:new Date(to).toISOString()})}/></section>)}</div></>;
}
function windowRange(minutes:number){const now=Date.now();return {from:new Date(now-minutes*60000).toISOString(),to:new Date(now).toISOString()}}
