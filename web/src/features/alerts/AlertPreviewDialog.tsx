import {useI18n} from '../../shared/i18n';
import {useEffect,useState} from 'react';
import {api} from '../../shared/api';
import {Alert,Button,Descriptions,Modal,Spin,Table,Tag,Typography} from '../../shared/ui';
import {displayTime,priorityColors,getPriorityNames} from './response-model';
import type {AlertGroup} from './types';
import type {Channel} from './channels';
import type {AlertPreviewData,PreviewState} from './alert-preview';

export default function AlertPreviewDialog({open,loading,error,data,groups,onClose}:{open:boolean;loading:boolean;error?:string;data?:AlertPreviewData;groups:AlertGroup[];onClose:()=>void}) {
 const {language,t}=useI18n();

 const priorityNames=getPriorityNames(t);
 const [channels,setChannels]=useState<Channel[]>([]);
 useEffect(()=>{if(!open)return;let active=true;void api<Channel[]>('/notify/channels').then(v=>{if(active)setChannels(v)}).catch(()=>{});return()=>{active=false}},[open]);
 const condition=(s:PreviewState)=>s.health==='error'?<Tag color="error">{t("查询失败","Query failed")}</Tag>:s.health==='no_data'?<Tag color="warning">{t("无数据","No data")}</Tag>:<Tag color={s.status==='firing'?'error':'success'}>{s.status==='firing'?t("满足触发条件","Trigger condition met"):t("未满足触发条件","Trigger condition not met")}</Tag>;
 return <Modal title={t("告警预览","Alert preview")} open={open} onCancel={onClose} width={820} zIndex={1300} destroyOnHidden styles={{body:{maxHeight:'65vh',overflowY:'auto'}}} footer={<Button type="primary" onClick={onClose}>{t("关闭预览","Close preview")}</Button>}>
  <Typography.Paragraph type="secondary">{t("检查当前窗口的查询结果与触发条件；预览不会累计连续异常次数、保存规则或发送通知。","Check query results and trigger conditions for the current window. Preview does not count consecutive failures, save rules or send notifications.")}</Typography.Paragraph>
  {loading?<div style={{padding:40,textAlign:'center'}}><Spin/><Typography.Paragraph style={{marginTop:12}}>{t("正在执行告警查询","Running alert query")}</Typography.Paragraph></div>:error?<Alert type="error" showIcon title={t("告警预览失败","Alert preview failed")} description={error}/>:data&&<>
   <Descriptions column={1} items={[{label:t("告警规则","Alert rules"),children:data.rule_name},{label:t("告警等级","Alert priority"),children:<Tag color={priorityColors[data.severity]}>{data.severity} · {priorityNames[data.severity]}</Tag>},{label:t("查询窗口","Query window"),children:data.range?`${displayTime(data.range.from)} — ${displayTime(data.range.to)}`:'—'}]}/>
   {data.warnings.map((warning,index)=><Alert key={index} type="warning" showIcon title={warning} style={{marginBottom:12}}/>)}
   <Typography.Title level={5}>{t("条件判断","Condition evaluation")}</Typography.Title>
   <Table size="small" rowKey={s=>s.fingerprint||JSON.stringify(s.labels)} dataSource={data.states} pagination={{pageSize:10}} scroll={{x:550}} columns={[{title:t("维度","Dimensions"),render:(_,s)=>Object.keys(s.labels).length?JSON.stringify(s.labels):t("全部","All")},{title:t("查询值","Query value"),dataIndex:'value'},{title:t("判断","Evaluation"),render:(_,s)=>condition(s)},{title:t("错误","Error"),render:(_,s)=>s.error||'—'}]}/>
   <Typography.Title level={5}>{t("通知目标","Notification targets")}</Typography.Title>
   {data.routes.length?<Table size="small" rowKey={r=>`${r.target?.channel_id}:${r.target?.recipient.kind}:${r.target?.recipient.value}:${r.group_ids.join(',')}`} dataSource={data.routes} pagination={{pageSize:10}} scroll={{x:550}} columns={[{title:t("告警组","Alert group"),render:(_,r)=>r.group_ids.map(id=>groups.find(g=>g.id===id)?.name??t("告警组","Alert group")).join('、')||'—'},{title:t("通知接入","Notification connections"),render:(_,r)=>channels.find(c=>c.id===r.target?.channel_id)?.name??t("通知接入","Notification connections")},{title:t("接收目标","Recipient"),render:(_,r)=>r.target?.recipient.kind==='channel'?t("接入绑定的群 / Webhook","Connected group / Webhook"):r.target?.recipient.value||t("绑定账号","Linked account")}]}/>:<Typography.Paragraph type="secondary">{t("当前没有可用通知目标，请检查告警组、值班人员和通知接入。","No notification targets are available. Check alert groups, on-call responders and notification connections.")}</Typography.Paragraph>}
  </>}
 </Modal>;
}
