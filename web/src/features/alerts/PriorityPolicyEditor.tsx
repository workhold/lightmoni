import dayjs from 'dayjs';
import {Alert,Button,Card,Form,InputNumber,Select,Space,TimePicker,Typography} from '../../shared/ui';
import {methods,priorities,weekdays,type PriorityPolicy} from './response-model';

export default function PriorityPolicyEditor({value,defaults,timezone,onChange}:{value:Record<string,PriorityPolicy>;defaults:Record<string,PriorityPolicy>;timezone:string;onChange:(value:Record<string,PriorityPolicy>)=>void}) {
 const change=(key:string,patch:Partial<PriorityPolicy>)=>onChange({...value,[key]:{...value[key],...patch}});
 return <>
  <Alert type="info" title={`以下设置只控制通知，告警始终记录。时区：${timezone}。`}
   description="过滤突刺请在告警规则中设置连续异常检测次数；夜间轮数从规则已触发告警后开始，按重复提醒间隔累计。"/>
  {priorities.map(key=>{
   const p=value[key];if(!p)return null;
   const allDay=!p.start||!p.end||p.start===p.end,night=p.night_mode??'silent';
   return <Card key={key} className="lm-policy-card" size="small" title={key}
    extra={defaults[key]&&<Button size="small" onClick={()=>onChange({...value,[key]:structuredClone(defaults[key])})}>使用初始策略</Button>}>
    <div className="lm-rule-grid">
     <Form.Item label={allDay?'全天通知方式':'日间通知方式'}><Select aria-label={`${key}通知方式`} mode="multiple" options={methods} value={p.methods} onChange={methods=>change(key,{methods})}/></Form.Item>
     <Form.Item label="通知星期（留空为每天）"><Select mode="multiple" options={weekdays} value={p.weekdays??[]} onChange={weekdays=>change(key,{weekdays})}/></Form.Item>
     <Form.Item label="日间通知时段（清空为全天）"><TimePicker.RangePicker aria-label={`${key}日间通知时段`} order={false} format="HH:mm" value={p.start&&p.end?[dayjs('2000-01-01T'+p.start),dayjs('2000-01-01T'+p.end)]:null}
      onChange={v=>change(key,{start:v?.[0]?.format('HH:mm')??'',end:v?.[1]?.format('HH:mm')??'',...(!v||v[0]?.isSame(v[1])?{night_mode:'silent' as const}:{})})}/></Form.Item>
     {!allDay&&<Form.Item label="夜间策略"><Select aria-label={`${key}夜间策略`} value={night} options={[{value:'silent',label:'仅记录，不通知'},{value:'immediate',label:'直接通知'},{value:'after_count',label:'累计持续告警后通知'}]}
      onChange={night_mode=>change(key,{night_mode,night_methods:p.night_methods?.length?p.night_methods:p.methods.includes('voice')?['voice']:[...p.methods],night_after_count:p.night_after_count||3})}/></Form.Item>}
    </div>
    {!allDay&&night!=='silent'&&<div className="lm-rule-grid lm-policy-night">
     <Form.Item label="夜间通知方式"><Select aria-label={`${key}夜间通知方式`} mode="multiple" options={methods} value={p.night_methods??[]} onChange={night_methods=>change(key,{night_methods})}/></Form.Item>
     {night==='after_count'&&<Form.Item label="夜间持续告警轮数" help={`同一规则、同一指标每 ${p.repeat_seconds/60} 分钟记录一轮；恢复后清零。`}><InputNumber aria-label={`${key}夜间持续告警轮数`} min={1} max={1000} precision={0} value={p.night_after_count??3} onChange={v=>change(key,{night_after_count:v??1})}/></Form.Item>}
    </div>}
    {!allDay&&night==='silent'&&<Typography.Paragraph type="secondary">夜间告警保留在告警响应和事件记录中，可次日回看；日间恢复通知仍然开放的告警。</Typography.Paragraph>}
    <div className="lm-rule-grid">
     {([['repeat_seconds','重复提醒间隔'],['backup_after_seconds','通知备班时间（0关闭）'],['fallback_after_seconds','通知兜底时间（0关闭）'],['handling_seconds','接手后处理期限（0关闭）']] as const).map(([field,label])=><Form.Item key={field} label={label+' / 分钟'}><InputNumber aria-label={`${key}${label}`} min={field==='repeat_seconds'?1:0} value={p[field]/60} onChange={v=>change(key,{[field]:Math.round((v??0)*60)})}/></Form.Item>)}
     <Form.Item label="每层最大通知轮数"><InputNumber min={1} max={30} precision={0} value={p.max_rounds} onChange={v=>change(key,{max_rounds:v??1})}/></Form.Item>
     <Form.Item label="无人接手提级（0关闭）"><Space wrap><InputNumber min={0} max={30} precision={0} value={p.escalate_after_rounds} onChange={v=>change(key,{escalate_after_rounds:v??0})}/><span>轮后升到</span><Select style={{width:80}} value={p.escalate_to||undefined} options={priorities.filter(v=>v<key).map(value=>({value,label:value}))} onChange={escalate_to=>change(key,{escalate_to})}/></Space></Form.Item>
    </div>
   </Card>;
  })}
 </>;
}
