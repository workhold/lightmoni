import {useI18n} from '../../shared/i18n';
import dayjs from 'dayjs';
import {Alert,Button,Card,Form,InputNumber,Select,Space,TimePicker,Typography} from '../../shared/ui';
import {getMethods,priorities,getWeekdays,type PriorityPolicy} from './response-model';

export default function PriorityPolicyEditor({value,defaults,timezone,onChange}:{value:Record<string,PriorityPolicy>;defaults:Record<string,PriorityPolicy>;timezone:string;onChange:(value:Record<string,PriorityPolicy>)=>void}) {
 const {language,t}=useI18n();

 const weekdays=getWeekdays(t);
 const methods=getMethods(t);
 const change=(key:string,patch:Partial<PriorityPolicy>)=>onChange({...value,[key]:{...value[key],...patch}});
 return <>
  <Alert type="info" title={t(`以下设置只控制通知，告警始终记录。时区：${timezone}。`,`These settings only control notifications. Alerts are always recorded. Time zone: ${timezone}.`)}
   description={t("过滤突刺请在告警规则中设置连续异常检测次数；夜间轮数从规则已触发告警后开始，按重复提醒间隔累计。","Set consecutive anomaly counts in the alert rule to filter spikes. Nighttime rounds start after an alert fires and accumulate at the repeat interval.")}/>
  {priorities.map(key=>{
   const p=value[key];if(!p)return null;
   const allDay=!p.start||!p.end||p.start===p.end,night=p.night_mode??'silent';
   return <Card key={key} className="lm-policy-card" size="small" title={key}
    extra={defaults[key]&&<Button size="small" onClick={()=>onChange({...value,[key]:structuredClone(defaults[key])})}>{t("使用初始策略","Restore initial policy")}</Button>}>
    <div className="lm-rule-grid">
     <Form.Item label={allDay?t("全天通知方式","All-day notification methods"):t("日间通知方式","Daytime notification methods")}><Select aria-label={t(`${key}通知方式`,`${key} notification methods`)} mode="multiple" options={methods} value={p.methods} onChange={methods=>change(key,{methods})}/></Form.Item>
     <Form.Item label={t("通知星期（留空为每天）","Notification weekdays (blank for every day)")}><Select mode="multiple" options={weekdays} value={p.weekdays??[]} onChange={weekdays=>change(key,{weekdays})}/></Form.Item>
     <Form.Item label={t("日间通知时段（清空为全天）","Daytime notification window (blank for all day)")}><TimePicker.RangePicker aria-label={t(`${key}日间通知时段`,`${key} daytime notification window`)} order={false} format="HH:mm" value={p.start&&p.end?[dayjs('2000-01-01T'+p.start),dayjs('2000-01-01T'+p.end)]:null}
      onChange={v=>change(key,{start:v?.[0]?.format('HH:mm')??'',end:v?.[1]?.format('HH:mm')??'',...(!v||v[0]?.isSame(v[1])?{night_mode:'silent' as const}:{})})}/></Form.Item>
     {!allDay&&<Form.Item label={t("夜间策略","Nighttime policy")}><Select aria-label={t(`${key}夜间策略`,`${key} nighttime policy`)} value={night} options={[{value:'silent',label:t("仅记录，不通知","Record only")},{value:'immediate',label:t("直接通知","Notify immediately")},{value:'after_count',label:t("累计持续告警后通知","Notify after sustained alert rounds")}]}
      onChange={night_mode=>change(key,{night_mode,night_methods:p.night_methods?.length?p.night_methods:p.methods.includes('voice')?['voice']:[...p.methods],night_after_count:p.night_after_count||3})}/></Form.Item>}
    </div>
    {!allDay&&night!=='silent'&&<div className="lm-rule-grid lm-policy-night">
     <Form.Item label={t("夜间通知方式","Nighttime notification methods")}><Select aria-label={t(`${key}夜间通知方式`,`${key} nighttime notification methods`)} mode="multiple" options={methods} value={p.night_methods??[]} onChange={night_methods=>change(key,{night_methods})}/></Form.Item>
     {night==='after_count'&&<Form.Item label={t("夜间持续告警轮数","Sustained nighttime alert rounds")} help={t(`同一规则、同一指标每 ${p.repeat_seconds/60} 分钟记录一轮；恢复后清零。`,`Count one round every ${p.repeat_seconds/60} minutes for the same rule and metric; reset after recovery.`)}><InputNumber aria-label={t(`${key}夜间持续告警轮数`,`${key} sustained nighttime alert rounds`)} min={1} max={1000} precision={0} value={p.night_after_count??3} onChange={v=>change(key,{night_after_count:v??1})}/></Form.Item>}
    </div>}
    {!allDay&&night==='silent'&&<Typography.Paragraph type="secondary">{t("夜间告警保留在告警响应和事件记录中，可次日回看；日间恢复通知仍然开放的告警。","Nighttime alerts remain in alert responses and event history for later review. Notifications resume during the day for alerts that remain open.")}</Typography.Paragraph>}
    <div className="lm-rule-grid">
     {([['repeat_seconds',t("重复提醒间隔","Repeat notification interval")],['backup_after_seconds',t("通知备班时间（0关闭）","Notify backup after (0 disables)")],['fallback_after_seconds',t("通知兜底时间（0关闭）","Notify fallback after (0 disables)")],['handling_seconds',t("接手后处理期限（0关闭）","Handling deadline after claim (0 disables)")]] as const).map(([field,label])=><Form.Item key={field} label={label+t(' / 分钟',' / minutes')}><InputNumber aria-label={`${key}${label}`} min={field==='repeat_seconds'?1:0} value={p[field]/60} onChange={v=>change(key,{[field]:Math.round((v??0)*60)})}/></Form.Item>)}
     <Form.Item label={t("每层最大通知轮数","Maximum rounds per priority")}><InputNumber min={1} max={30} precision={0} value={p.max_rounds} onChange={v=>change(key,{max_rounds:v??1})}/></Form.Item>
     <Form.Item label={t("无人接手提级（0关闭）","Escalate if unclaimed (0 disables)")}><Space wrap><InputNumber min={0} max={30} precision={0} value={p.escalate_after_rounds} onChange={v=>change(key,{escalate_after_rounds:v??0})}/><span>{t("轮后升到"," rounds, escalate to ")}</span><Select style={{width:80}} value={p.escalate_to||undefined} options={priorities.filter(v=>v<key).map(value=>({value,label:value}))} onChange={escalate_to=>change(key,{escalate_to})}/></Space></Form.Item>
    </div>
   </Card>;
  })}
 </>;
}
