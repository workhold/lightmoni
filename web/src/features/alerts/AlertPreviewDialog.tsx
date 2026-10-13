import {useEffect,useState} from 'react';
import {api} from '../../shared/api';
import {Alert,Button,Descriptions,Modal,Spin,Table,Tag,Typography} from '../../shared/ui';
import {displayTime,priorityColors,priorityNames} from './response-model';
import type {AlertGroup} from './types';
import type {Channel} from './channels';
import type {AlertPreviewData,PreviewState} from './alert-preview';

export default function AlertPreviewDialog({open,loading,error,data,groups,onClose}:{open:boolean;loading:boolean;error?:string;data?:AlertPreviewData;groups:AlertGroup[];onClose:()=>void}) {
 const [channels,setChannels]=useState<Channel[]>([]);
 useEffect(()=>{if(!open)return;let active=true;void api<Channel[]>('/notify/channels').then(v=>{if(active)setChannels(v)}).catch(()=>{});return()=>{active=false}},[open]);
 const condition=(s:PreviewState)=>s.health==='error'?<Tag color="error">查询失败</Tag>:s.health==='no_data'?<Tag color="warning">无数据</Tag>:<Tag color={s.status==='firing'?'error':'success'}>{s.status==='firing'?'满足触发条件':'未满足触发条件'}</Tag>;
 return <Modal title="告警预览" open={open} onCancel={onClose} width={820} zIndex={1300} destroyOnHidden styles={{body:{maxHeight:'65vh',overflowY:'auto'}}} footer={<Button type="primary" onClick={onClose}>关闭预览</Button>}>
  <Typography.Paragraph type="secondary">检查当前窗口的查询结果与触发条件；预览不会保存规则或发送通知。</Typography.Paragraph>
  {loading?<div style={{padding:40,textAlign:'center'}}><Spin/><Typography.Paragraph style={{marginTop:12}}>正在执行告警查询</Typography.Paragraph></div>:error?<Alert type="error" showIcon title="告警预览失败" description={error}/>:data&&<>
   <Descriptions column={1} items={[{label:'告警规则',children:data.rule_name},{label:'告警等级',children:<Tag color={priorityColors[data.severity]}>{data.severity} · {priorityNames[data.severity]}</Tag>},{label:'查询窗口',children:data.range?`${displayTime(data.range.from)} — ${displayTime(data.range.to)}`:'—'}]}/>
   {data.warnings.map((warning,index)=><Alert key={index} type="warning" showIcon title={warning} style={{marginBottom:12}}/>)}
   <Typography.Title level={5}>条件判断</Typography.Title>
   <Table size="small" rowKey={s=>s.fingerprint||JSON.stringify(s.labels)} dataSource={data.states} pagination={{pageSize:10}} scroll={{x:550}} columns={[{title:'维度',render:(_,s)=>Object.keys(s.labels).length?JSON.stringify(s.labels):'全部'},{title:'查询值',dataIndex:'value'},{title:'判断',render:(_,s)=>condition(s)},{title:'错误',render:(_,s)=>s.error||'—'}]}/>
   <Typography.Title level={5}>通知目标</Typography.Title>
   {data.routes.length?<Table size="small" rowKey={r=>`${r.target?.channel_id}:${r.target?.recipient.kind}:${r.target?.recipient.value}:${r.group_ids.join(',')}`} dataSource={data.routes} pagination={{pageSize:10}} scroll={{x:550}} columns={[{title:'告警组',render:(_,r)=>r.group_ids.map(id=>groups.find(g=>g.id===id)?.name??'告警组').join('、')||'—'},{title:'通知接入',render:(_,r)=>channels.find(c=>c.id===r.target?.channel_id)?.name??'通知接入'},{title:'接收目标',render:(_,r)=>r.target?.recipient.kind==='channel'?'接入绑定的群 / Webhook':r.target?.recipient.value||'绑定账号'}]}/>:<Typography.Paragraph type="secondary">当前没有可用通知目标，请检查告警组、值班人员和通知接入。</Typography.Paragraph>}
  </>}
 </Modal>;
}
