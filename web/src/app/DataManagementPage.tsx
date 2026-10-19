import {useCallback,useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Empty,Space,Spin,Table,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable,User} from '../shared/types';
import {retentionLabel,TableRetentionEditor} from './RetentionSettings';
import {LogReportingEditor} from './LogReportingSettings';

const errorText=(error:unknown)=>error instanceof Error?error.message:'请稍后重试';

export default function DataManagementPage({user}:{user:User}) {
  const [tables,setTables]=useState<CatalogTable[]>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [retentionTable,setRetentionTable]=useState<CatalogTable>();
  const [logReportingTable,setLogReportingTable]=useState<CatalogTable>();
  const request=useRef<AbortController|null>(null);
  const admin=user.role==='admin';

  const load=useCallback(async()=>{
    request.current?.abort();
    const controller=new AbortController();
    request.current=controller;
    setLoading(true);
    setError('');
    try {
      const catalog=await api<CatalogTable[]>('/catalog/tables',{signal:controller.signal});
      if(!controller.signal.aborted)setTables(catalog);
    } catch(error) {
      if(!controller.signal.aborted)setError(errorText(error));
    } finally {
      if(!controller.signal.aborted)setLoading(false);
    }
  },[]);

  useEffect(()=>{
    void load();
    return()=>request.current?.abort();
  },[load]);

  return <div className="lm-page">
    <div className="lm-page-heading" style={{flexWrap:'wrap'}}>
      <div><h1>数据管理</h1><p>查看已接入的数据表、服务与保留时长，管理员可设置表级保留和日志上报规则。</p></div>
      <Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新数据表</Button>
    </div>
    <div className="lm-surface" style={{minWidth:0}}>
      <div className="lm-toolbar">
        <span>单表保留设置优先于全局默认。</span>
        {admin&&<Link to="/admin?tab=retention">管理全局默认时长</Link>}
        <Link to="/data">接入数据</Link>
      </div>
      {error&&<Alert type="error" showIcon title="数据表目录加载失败"
        description={<>{error}{tables!==undefined&&<div>当前显示上次成功加载的目录，请刷新后确认最新设置。</div>}</>}
        action={<Button size="small" loading={loading} onClick={()=>void load()}>重试</Button>}
        style={{marginBottom:16}}/>}
      {tables===undefined?(loading&&<Space role="status"><Spin/><span>正在加载数据表目录…</span></Space>):<Table<CatalogTable>
        rowKey="id" dataSource={tables} loading={loading} scroll={{x:1100}}
        locale={{emptyText:<Empty description="尚无数据表，接入数据后会自动创建"/>}}
        columns={[
          {title:'SQL 名称',dataIndex:'name',width:260,render:(name:string,table:CatalogTable)=><Space wrap><Typography.Text code>{name}</Typography.Text>{table.system&&<Tag color="blue">系统内置</Tag>}</Space>},
          {title:'逻辑表',dataIndex:'logical_name',width:160},
          {title:'类型',dataIndex:'kind',width:90},
          {title:'服务',dataIndex:'services',width:180,render:(services:string[])=>services.length?services.join(' · '):'—'},
          {title:'保留时长',width:240,render:(_:unknown,table:CatalogTable)=><Space wrap><span>{retentionLabel(table.effective_retention_days)}</span>{table.retention_days==null&&<Tag>跟随全局</Tag>}{admin&&<Button size="small" onClick={()=>setRetentionTable(table)}>设置时长</Button>}</Space>},
          {title:'日志上报',width:120,render:(_:unknown,table:CatalogTable)=>table.kind==='log'&&!table.system?(admin?<Button size="small" onClick={()=>setLogReportingTable(table)}>上报规则</Button>:'由管理员配置'):'—'},
        ]}
      />}
    </div>
    {admin&&<>
      <TableRetentionEditor table={retentionTable} onClose={()=>setRetentionTable(undefined)} onSaved={()=>void load()}/>
      <LogReportingEditor table={logReportingTable} onClose={()=>setLogReportingTable(undefined)}/>
    </>}
  </div>;
}
