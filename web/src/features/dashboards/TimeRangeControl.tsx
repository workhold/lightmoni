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
 ['now-7d','最近 7 天'],['now-30d','最近 30 天'],
];
function rangeLabel(range:TimeRange){
 const preset=range.to==='now'?presets.find(([from])=>from===range.from):undefined;
 if(preset)return preset[1];
 const format=(value:string)=>value==='now'?'现在':value.startsWith('now-')?value:dayjs(value).format('MM-DD HH:mm:ss');
 return `${format(range.from)} — ${format(range.to)}`;
}
export default function TimeRangeControl({range,onChange}:{range:TimeRange;onChange:(range:TimeRange)=>void}){
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(range),[filter,setFilter]=useState(''),[calendar,setCalendar]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!open)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);setCalendar(false);}};document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close);},[open]);
 function toggle(next:boolean){setOpen(next);setCalendar(false);if(next){setDraft(range);setError('');setFilter('');}}
 function apply(next=draft){try{resolveRange(next);onChange(next);setOpen(false);setError('');}catch(e){setError((e as Error).message);}}
 const absolute=useMemo(()=>{try{return resolveRange(draft);}catch{return undefined;}},[draft]);
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const content=<div className="lm-time-picker" role="dialog" aria-label="选择时间范围">
  <section className="lm-time-absolute"><h3>自定义时间范围</h3>
   <label>从<Input aria-label="开始时间" value={draft.from} onChange={e=>setDraft(r=>({...r,from:e.target.value}))} onPressEnter={()=>apply()}/></label>
   <label>至<Input aria-label="结束时间" value={draft.to} onChange={e=>setDraft(r=>({...r,to:e.target.value}))} onPressEnter={()=>apply()}/></label>
   <Button type="text" size="small" icon={<CalendarOutlined aria-hidden/>} onClick={()=>setCalendar(v=>!v)}>用日历选择</Button>
   {calendar&&<DatePicker.RangePicker aria-label="日历时间范围" classNames={{popup:{root:'lm-dashboard-calendar'}}} showTime allowClear={false} value={absolute?[dayjs(absolute.from),dayjs(absolute.to)]:null} onChange={dates=>{if(dates?.[0]&&dates[1])setDraft({from:dates[0].toISOString(),to:dates[1].toISOString()});}}/>}
   <p className="lm-time-help">支持相对时间（now-1h）或完整日期时间。</p>
   {error&&<Alert type="error" showIcon title={error}/>}
   <Button type="primary" block onClick={()=>apply()}>应用时间范围</Button>
   <span className="lm-time-zone"><ClockCircleOutlined aria-hidden/> 浏览器时间 · {zone}</span>
  </section>
  <section className="lm-time-relative"><h3>相对时间范围</h3><Input aria-label="搜索时间范围" prefix={<SearchOutlined aria-hidden/>} placeholder="搜索，例如 15 分钟" allowClear value={filter} onChange={e=>setFilter(e.target.value)}/>
   <div className="lm-time-presets">{presets.filter(([,label])=>label.includes(filter.trim())).map(([from,label])=><Button key={from} type="text" className={range.from===from&&range.to==='now'?'is-selected':''} onClick={()=>apply({from,to:'now'})}>{label}</Button>)}</div>
  </section>
 </div>;
 return <Popover placement="bottomRight" trigger="click" open={open} onOpenChange={toggle} content={content} destroyOnHidden classNames={{root:'lm-dashboard-time-popover'}}><Button className="lm-dashboard-time-trigger" aria-label="时间范围" icon={<CalendarOutlined aria-hidden/>} title={`${range.from} — ${range.to}`}><span>{rangeLabel(range)}</span><DownOutlined aria-hidden/></Button></Popover>;
}
