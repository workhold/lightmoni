import {useMonitoringI18n} from '../monitoring-i18n';
import {monitoringText,type MonitoringLanguage} from '../monitoring-translations.ts';
import {useEffect,useMemo,useState} from 'react';
import dayjs from 'dayjs';
import {CalendarOutlined,ClockCircleOutlined,DownOutlined,SearchOutlined} from '@ant-design/icons';
import {Alert,Button,DatePicker,Input,Popover} from '../../shared/ui';
import type {TimeRange} from '../../shared/types';
import {resolveRange} from './model';

const presets=[
 ['now-5m','最近 5 分钟'],['now-15m','最近 15 分钟'],['now-30m','最近 30 分钟'],
 ['now-1h','最近 1 小时'],['now-3h','最近 3 小时'],['now-6h','最近 6 小时'],
 ['now-12h','最近 12 小时'],['now-24h','最近 24 小时'],['now-2d','最近 2 天'],
 ['now-7d','最近 7 天'],['now-30d','最近 30 天'],['now-90d','最近 90 天'],['now-6M','最近 6 个月'],['now-1y','最近 1 年'],['now-2y','最近 2 年'],
];
const calendarPresets:[string,string,string][]=[['now-1d/d','now-1d/d','昨天'],['now-2d/d','now-2d/d','前天'],['now/d','now','今天至今'],['now/w','now','本周至今'],['now/M','now','本月至今'],['now/y','now','今年至今']];
const recentKey='lightmoni.dashboard.recent-ranges';
function readRecent():TimeRange[]{try{const value=JSON.parse(localStorage.getItem(recentKey)??'[]');return Array.isArray(value)?value.filter(item=>typeof item?.from==='string'&&typeof item?.to==='string').slice(0,5):[];}catch{return [];}}
function rangeLabel(range:TimeRange,language:MonitoringLanguage='zh-CN'){
 const l=(text:string,...values:unknown[])=>monitoringText(text,language,...values);

 const calendar=calendarPresets.find(([from,to])=>from===range.from&&to===range.to);if(calendar)return l(calendar[2]);
 const preset=range.to==='now'?presets.find(([from])=>from===range.from):undefined;
 if(preset)return l(preset[1]);
 const format=(value:string)=>value==='now'?l("现在"):value.startsWith('now')?value:dayjs(value).format('MM-DD HH:mm:ss');
 return `${format(range.from)} — ${format(range.to)}`;
}
export default function TimeRangeControl({range,onChange}:{range:TimeRange;onChange:(range:TimeRange)=>void}){
 const {l,language}=useMonitoringI18n();

 const [open,setOpen]=useState(false),[draft,setDraft]=useState(range),[filter,setFilter]=useState(''),[calendar,setCalendar]=useState(false),[error,setError]=useState(''),[recent,setRecent]=useState<TimeRange[]>(readRecent);
 useEffect(()=>{if(!open)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);setCalendar(false);}};document.addEventListener('keydown',close,true);return()=>document.removeEventListener('keydown',close,true);},[open]);
 function toggle(next:boolean){setOpen(next);setCalendar(false);if(next){setDraft(range);setError('');setFilter('');setRecent(readRecent());}}
 function apply(next=draft){try{const resolved=resolveRange(next,undefined,language);onChange(next);if(!presets.some(([from])=>from===next.from&&next.to==='now')&&!calendarPresets.some(([from,to])=>from===next.from&&to===next.to)){const updated=[resolved,...readRecent().filter(item=>item.from!==resolved.from||item.to!==resolved.to)].slice(0,5);setRecent(updated);try{localStorage.setItem(recentKey,JSON.stringify(updated));}catch{/* Time selection remains usable without storage. */}}setOpen(false);setError('');}catch(e){setError((e as Error).message);}}
 const absolute=useMemo(()=>{try{return resolveRange(draft,undefined,language);}catch{return undefined;}},[draft,language]);
 const custom=/^(\d+)(s|m|h|d|w|M|y)$/.test(filter.trim())?`now-${filter.trim()}`:undefined;
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const content=<div className="lm-time-picker" role="dialog" aria-label={l("选择时间范围")}>
  <section className="lm-time-absolute"><h3>{l("自定义时间范围")}</h3>
   <label>{l("从")}<Input aria-label={l("开始时间")} value={draft.from} onChange={e=>setDraft(r=>({...r,from:e.target.value}))} onPressEnter={()=>apply()}/></label>
   <label>{l("至")}<Input aria-label={l("结束时间")} value={draft.to} onChange={e=>setDraft(r=>({...r,to:e.target.value}))} onPressEnter={()=>apply()}/></label>
   <Button type="text" size="small" icon={<CalendarOutlined aria-hidden/>} onClick={()=>setCalendar(v=>!v)}>{l("用日历选择")}</Button>
   {calendar&&<DatePicker.RangePicker aria-label={l("日历时间范围")} classNames={{popup:{root:'lm-dashboard-calendar'}}} showTime allowClear={false} value={absolute?[dayjs(absolute.from),dayjs(absolute.to)]:null} onChange={dates=>{if(dates?.[0]&&dates[1])setDraft({from:dates[0].toISOString(),to:dates[1].toISOString()});}}/>}
   <p className="lm-time-help">{l("支持 now-1h、now/d 或完整日期时间。")}</p>
   {error&&<Alert type="error" showIcon title={error}/>}
   <Button type="primary" block onClick={()=>apply()}>{l("应用时间范围")}</Button>
   {recent.length>0&&<div className="lm-time-recent"><small>{l("最近使用")}</small>{recent.map(item=><Button key={item.from+item.to} type="text" onClick={()=>apply(item)}>{rangeLabel(item,language)}</Button>)}</div>}
  </section>
  <section className="lm-time-relative"><h3>{l("相对时间范围")}</h3><Input aria-label={l("搜索时间范围")} prefix={<SearchOutlined aria-hidden/>} autoFocus placeholder={l("搜索或输入，例如 13h")} allowClear value={filter} onChange={e=>setFilter(e.target.value)} onPressEnter={()=>{if(custom)apply({from:custom,to:'now'});}}/>
   <div className="lm-time-presets">{custom&&<Button type="text" onClick={()=>apply({from:custom,to:'now'})}>{l("最近 ")}{filter.trim()}</Button>}{presets.filter(([,label])=>l(label).toLowerCase().includes(filter.trim().toLowerCase())).map(([from,label])=><Button key={from} type="text" aria-pressed={range.from===from&&range.to==='now'} className={range.from===from&&range.to==='now'?'is-selected':''} onClick={()=>apply({from,to:'now'})}>{l(label)}</Button>)}{calendarPresets.filter(([, ,label])=>l(label).toLowerCase().includes(filter.trim().toLowerCase())).map(([from,to,label])=><Button key={from} type="text" aria-pressed={range.from===from&&range.to===to} className={range.from===from&&range.to===to?'is-selected':''} onClick={()=>apply({from,to})}>{l(label)}</Button>)}</div>
  </section><footer className="lm-time-zone"><ClockCircleOutlined aria-hidden/> {l(" 浏览器时间 · ")}{zone}</footer>
 </div>;
 return <Popover placement="bottomRight" align={{overflow:{adjustX:true,adjustY:true,shiftX:true}}} trigger="click" open={open} onOpenChange={toggle} content={content} destroyOnHidden classNames={{root:'lm-dashboard-time-popover'}}><Button className="lm-dashboard-time-trigger" aria-label={l("时间范围")} aria-expanded={open} icon={<ClockCircleOutlined aria-hidden/>} title={`${range.from} — ${range.to}`}><span>{rangeLabel(range,language)}</span><DownOutlined aria-hidden/></Button></Popover>;
}
