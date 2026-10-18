import {useEffect,useState} from 'react';
import {Alert,App,Button,Space,Table,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable} from '../shared/types';
import {retentionLabel,TableRetentionEditor} from './RetentionSettings';
import {LogReportingEditor} from './LogReportingSettings';
export default function DataTables(){
 const {message}=App.useApp(),[tables,setTables]=useState<CatalogTable[]>([]),[error,setError]=useState(''),[retention,setRetention]=useState<CatalogTable>(),[reporting,setReporting]=useState<CatalogTable>();
 const load=async()=>{try{setTables(await api('/catalog/tables'));setError('');}catch(error){setError((error as Error).message);}};
 useEffect(()=>{void load();},[]);
 return <div className="lm-surface"><h2>数据表管理</h2><p>单表保留时长优先于全局默认；业务日志表可配置采样和上报规则。</p>{error&&<Alert type="error" title={error} action={<Button onClick={()=>void load()}>重试</Button>}/>}
  <Table rowKey="id" dataSource={tables} scroll={{x:1000}} columns={[
   {title:'SQL 名称',dataIndex:'name',render:(name:string,table:CatalogTable)=><Space><Typography.Text code>{name}</Typography.Text>{table.system&&<Tag color="blue">系统内置</Tag>}</Space>},
   {title:'逻辑表',dataIndex:'logical_name'},{title:'类型',dataIndex:'kind'},
   {title:'服务',dataIndex:'services',render:(values:string[])=>values.join(' · ')},
   {title:'保留时长',render:(_:unknown,table:CatalogTable)=><Space wrap>{retentionLabel(table.effective_retention_days)}{table.retention_days==null&&<Tag>跟随全局</Tag>}<Button size="small" onClick={()=>setRetention(table)}>设置时长</Button></Space>},
   {title:'日志上报',render:(_:unknown,table:CatalogTable)=>table.kind==='log'&&!table.system?<Button size="small" onClick={()=>setReporting(table)}>上报规则</Button>:'—'},
  ]}/>
  <TableRetentionEditor table={retention} onClose={()=>setRetention(undefined)} onSaved={()=>{void load();void message.success('数据表已刷新');}}/><LogReportingEditor table={reporting} onClose={()=>setReporting(undefined)}/>
 </div>;
}
