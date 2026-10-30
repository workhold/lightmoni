import {useEffect,useRef,useState} from 'react';
import type {FormInstance} from 'antd';
import {Alert,Button,Form,Input,InputNumber,Select,Space,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {TaskForm,TaskSchedule} from './agent-model';

export function cleanTaskSchedule(value?:TaskSchedule):TaskSchedule {
 if(value?.mode==='interval')return {mode:'interval',interval_seconds:value.interval_seconds};
 if(value?.mode==='at')return {mode:'at',run_at:value.run_at};
 if(value?.mode==='cron')return {mode:'cron',cron:value.cron?.trim(),timezone:value.timezone?.trim()};
 return {mode:'once'};
}
const localInput=(value?:string)=>{
 if(!value||!Number.isFinite(Date.parse(value)))return '';
 const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
};
const initialCalendar=(cron?:string)=>{
 const fields=cron?.trim().split(/\s+/)??[];
 if(fields.length===5&&/^\d+$/.test(fields[0])&&/^\d+$/.test(fields[1])&&fields[3]==='*'){
  const time=`${fields[1].padStart(2,'0')}:${fields[0].padStart(2,'0')}`;
  if(fields[2]==='*'&&fields[4]==='*')return {preset:'daily',time,weekday:1,monthday:1};
  if(fields[2]==='*'&&/^[0-6]$/.test(fields[4]))return {preset:'weekly',time,weekday:Number(fields[4]),monthday:1};
  if(/^\d+$/.test(fields[2])&&fields[4]==='*')return {preset:'monthly',time,weekday:1,monthday:Number(fields[2])};
 }
 return {preset:cron?'custom':'daily',time:'02:00',weekday:1,monthday:1};
};

export default function TaskScheduleFields({form}:{form:FormInstance<TaskForm>}){
 const {t,language}=useI18n(),schedule=Form.useWatch('schedule',form) as TaskSchedule|undefined;
 const initial=useRef(initialCalendar(form.getFieldValue(['schedule','cron']))).current;
 const [preset,setPreset]=useState(initial.preset),[calendarTime,setCalendarTime]=useState(initial.time),[weekday,setWeekday]=useState(initial.weekday),[monthday,setMonthday]=useState(initial.monthday);
 const [preview,setPreview]=useState<{key:string;runs:string[];timezone:string}>(),[previewError,setPreviewError]=useState(''),[loading,setLoading]=useState(false);
 const generation=useRef(0),key=JSON.stringify(cleanTaskSchedule(schedule)),mode=schedule?.mode??'once';
 useEffect(()=>{setPreview(undefined);setPreviewError('');setLoading(false);generation.current++;return()=>{generation.current++}},[key]);
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
 const zones=Array.from(new Set([zone,'Asia/Shanghai','UTC','America/New_York','Europe/London',...((Intl as unknown as {supportedValuesOf?:(key:string)=>string[]}).supportedValuesOf?.('timeZone')??[])]));
 const calendar=(nextPreset=preset,nextTime=calendarTime,nextWeekday=weekday,nextMonthday=monthday)=>{
  if(nextPreset==='custom')return;
  const [hour,minute]=nextTime.split(':').map(Number);
  if(!Number.isInteger(hour)||!Number.isInteger(minute))return;
  form.setFieldValue(['schedule','cron'],`${minute} ${hour} ${nextPreset==='monthly'?nextMonthday:'*'} * ${nextPreset==='weekly'?nextWeekday:'*'}`);
 };
 const changeMode=(next:string)=>{
  if(next==='cron'){form.setFieldValue('schedule',{mode:'cron',cron:'0 2 * * *',timezone:zone});setPreset('daily');setCalendarTime('02:00');setWeekday(1);setMonthday(1)}
  else if(next==='interval')form.setFieldValue('schedule',{mode:'interval',interval_seconds:3600});
  else if(next==='at')form.setFieldValue('schedule',{mode:'at',run_at:new Date(Date.now()+3600_000).toISOString()});
  else form.setFieldValue('schedule',{mode:'once'});
 };
 const showPreview=async()=>{
  const current=++generation.current;setLoading(true);setPreviewError('');setPreview(undefined);
  try{
   const result=await api<{schedule:TaskSchedule;next_runs:string[];timezone:string}>('/task-schedules/preview',{method:'POST',body:JSON.stringify({schedule:cleanTaskSchedule(form.getFieldValue('schedule'))})});
   if(current===generation.current)setPreview({key,runs:result.next_runs,timezone:result.timezone});
  }catch(error){if(current===generation.current)setPreviewError(error instanceof Error?error.message:t('无法预览执行计划','Unable to preview this schedule'))}
  finally{if(current===generation.current)setLoading(false)}
 };
 return <section className="lm-task-editor-section" aria-label={t('执行计划','Execution schedule')}>
  <h3>{t('2. 执行计划','2. Execution schedule')}</h3>
  <Form.Item name={['schedule','mode']} label={t('执行方式','Execution mode')} rules={[{required:true}]}><Select aria-label={t('执行方式','Execution mode')} onChange={changeMode} options={[{value:'once',label:t('手动执行','Manual dispatch')},{value:'at',label:t('指定时间执行一次','Once at a scheduled time')},{value:'interval',label:t('固定间隔','Fixed interval')},{value:'cron',label:t('日历定时','Calendar schedule')}]}/></Form.Item>
  {mode==='interval'&&<Form.Item name={['schedule','interval_seconds']} label={t('执行间隔（秒）','Run interval (seconds)')} rules={[{required:true,type:'number',min:10,max:2592000}]}><InputNumber aria-label={t('执行间隔（秒）','Run interval (seconds)')} min={10} max={2592000} precision={0}/></Form.Item>}
  {mode==='at'&&<Form.Item name={['schedule','run_at']} label={t('执行时间','Execution time')} getValueProps={value=>({value:localInput(value)})} normalize={value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():''} rules={[{required:true,message:t('请选择执行时间','Choose an execution time')}]} extra={t(`按本机时区 ${zone} 输入，平台保存为准确时间。`,`Enter a time in your device timezone ${zone}; the platform stores an exact instant.`)}><Input aria-label={t('执行时间','Execution time')} type="datetime-local"/></Form.Item>}
  {mode==='cron'&&<>
   <div className="lm-agent-form-grid">
    <Form.Item label={t('日历频率','Calendar frequency')}><Select aria-label={t('日历频率','Calendar frequency')} value={preset} onChange={value=>{setPreset(value);calendar(value)}} options={[{value:'daily',label:t('每天','Every day')},{value:'weekly',label:t('每周','Every week')},{value:'monthly',label:t('每月','Every month')},{value:'custom',label:t('自定义 Cron','Custom Cron')}]}/></Form.Item>
    <Form.Item name={['schedule','timezone']} label={t('时区','Timezone')} rules={[{required:true,message:t('请选择时区','Choose a timezone')}]}><Select aria-label={t('时区','Timezone')} showSearch options={zones.map(value=>({value,label:value}))}/></Form.Item>
   </div>
   {preset!=='custom'&&<div className="lm-agent-form-grid">
    <Form.Item label={t('每天执行时间','Time of day')}><Input type="time" aria-label={t('每天执行时间','Time of day')} value={calendarTime} onChange={event=>{setCalendarTime(event.target.value);calendar(preset,event.target.value)}}/></Form.Item>
    {preset==='weekly'&&<Form.Item label={t('星期','Day of week')}><Select aria-label={t('星期','Day of week')} value={weekday} onChange={value=>{setWeekday(value);calendar(preset,calendarTime,value)}} options={[t('星期日','Sunday'),t('星期一','Monday'),t('星期二','Tuesday'),t('星期三','Wednesday'),t('星期四','Thursday'),t('星期五','Friday'),t('星期六','Saturday')].map((label,value)=>({value,label}))}/></Form.Item>}
    {preset==='monthly'&&<Form.Item label={t('每月日期','Day of month')} extra={t('没有该日期的月份跳过。','Months without this date are skipped.')}><InputNumber aria-label={t('每月日期','Day of month')} min={1} max={31} precision={0} value={monthday} onChange={value=>{const day=Number(value);setMonthday(day);calendar(preset,calendarTime,weekday,day)}}/></Form.Item>}
   </div>}
   <Form.Item name={['schedule','cron']} label={t('Cron 表达式','Cron expression')} rules={[{required:true,whitespace:true,message:t('请输入五段 Cron 表达式','Enter a five-field Cron expression')}]} extra={t('分钟 小时 日 月 星期；不使用秒字段。','Minute hour day month weekday; no seconds field.')}><Input aria-label={t('Cron 表达式','Cron expression')} readOnly={preset!=='custom'} placeholder="0 2 * * *" className="lm-task-code"/></Form.Item>
  </>}
  {mode==='once'?<Typography.Paragraph type="secondary">{t('保存后等待手动派发，不会立即运行。','Saving waits for a manual dispatch and does not run the script immediately.')}</Typography.Paragraph>:<>
   <Space wrap><Button aria-label={t('预览执行时间','Preview execution times')} loading={loading} onClick={()=>void showPreview()}>{t('预览未来执行时间','Preview upcoming runs')}</Button><Typography.Text type="secondary">{t('错过的计划不补跑，同一主机不重叠执行。','Missed schedules are skipped; runs on the same host do not overlap.')}</Typography.Text></Space>
   {previewError&&<Alert type="error" showIcon title={previewError} className="lm-agent-form-notice"/>}
   {preview?.key===key&&<div className="lm-task-schedule-preview" aria-label={t('未来执行时间','Upcoming execution times')}><strong>{t('未来执行时间','Upcoming execution times')} · {preview.timezone||zone}</strong>{preview.runs.length?<ol>{preview.runs.map(run=><li key={run}>{new Date(run).toLocaleString(language,{timeZone:preview.timezone||zone,timeZoneName:'short'})}</li>)}</ol>:<p>{t('没有未来执行时间；已过去的单次计划不会补跑。','No future runs. A past one-time schedule is not replayed.')}</p>}</div>}
  </>}
 </section>;
}
