import {useI18n} from '../shared/i18n';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Empty,Space,Spin,Table,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable,User} from '../shared/types';
import {retentionLabel,TableRetentionEditor} from './RetentionSettings';
import {LogReportingEditor} from './LogReportingSettings';
import {MetricWindowEditor} from './MetricWindowSettings';

export default function DataManagementPage({user}:{user:User}) {
 const {t}=useI18n();
const errorText=(error:unknown)=>error instanceof Error?error.message:t("请稍后重试","Please try again later");

  const [tables,setTables]=useState<CatalogTable[]>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [retentionTable,setRetentionTable]=useState<CatalogTable>();
  const [logReportingTable,setLogReportingTable]=useState<CatalogTable>();
  const [metricWindowTable,setMetricWindowTable]=useState<CatalogTable>();
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
      <div><h1>{t("数据管理","Data management")}</h1><p>{t("查看已接入的数据表、服务与保留时长，管理员可设置表级保留和日志上报规则。","View ingested tables, services, and retention periods. Administrators can configure table retention and log reporting rules.")}</p></div>
      <Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>{t("刷新数据表","Refresh tables")}</Button>
    </div>
    <div className="lm-surface" style={{minWidth:0}}>
      <div className="lm-toolbar">
        <span>{t("单表保留设置优先于全局默认。","Table retention settings override global defaults.")}</span>
        {admin&&<Link to="/admin?tab=retention">{t("管理全局默认时长","Manage global retention defaults")}</Link>}
        <Link to="/data">{t("接入数据","Connect data")}</Link>
      </div>
      {error&&<Alert type="error" showIcon title={t("数据表目录加载失败","Unable to load table catalog")}
        description={<>{error}{tables!==undefined&&<div>{t("当前显示上次成功加载的目录，请刷新后确认最新设置。","Showing the last successfully loaded catalog. Refresh to confirm current settings.")}</div>}</>}
        action={<Button size="small" loading={loading} onClick={()=>void load()}>{t("重试","Retry")}</Button>}
        style={{marginBottom:16}}/>}
      {tables===undefined?(loading&&<Space role="status"><Spin/><span>{t("正在加载数据表目录…","Loading table catalog…")}</span></Space>):<Table<CatalogTable>
        rowKey="id" dataSource={tables} loading={loading} scroll={{x:1100}}
        locale={{emptyText:<Empty description={t("尚无数据表，接入数据后会自动创建","No tables yet. They are created automatically when data is ingested")}/>}}
        columns={[
          {title:t("SQL 名称","SQL name"),dataIndex:'name',width:260,render:(name:string,table:CatalogTable)=><Space wrap><Typography.Text code>{name}</Typography.Text>{table.system&&<Tag color="blue">{t("系统内置","Built-in")}</Tag>}</Space>},
          {title:t("逻辑表","Logical table"),dataIndex:'logical_name',width:160},
          {title:t("类型","Type"),dataIndex:'kind',width:90},
          {title:t("服务","Service"),dataIndex:'services',width:180,render:(services:string[])=>services.length?services.join(' · '):'—'},
          {title:t("保留时长","Retention period"),width:240,render:(_:unknown,table:CatalogTable)=><Space wrap><span>{retentionLabel(table.effective_retention_days,t)}</span>{table.retention_days==null&&<Tag>{t("跟随全局","Use global default")}</Tag>}{admin&&<Button size="small" onClick={()=>setRetentionTable(table)}>{t("设置时长","Set retention")}</Button>}</Space>},
          {title:t("日志上报","Log reporting"),width:120,render:(_:unknown,table:CatalogTable)=>table.kind==='log'&&!table.system?(admin?<Button size="small" onClick={()=>setLogReportingTable(table)}>{t("上报规则","Reporting rules")}</Button>:t("由管理员配置","Configured by administrators")):'—'},
          {title:t('指标上报','Metric reporting'),width:120,render:(_:unknown,table:CatalogTable)=>table.kind==='metric'&&table.metric_type==='histogram'&&!table.system?(admin?<Button size="small" onClick={()=>setMetricWindowTable(table)}>{t('聚合周期','Aggregation period')}</Button>:t('由管理员配置','Configured by administrators')):'—'},
        ]}
      />}
    </div>
    {admin&&<>
      <TableRetentionEditor table={retentionTable} onClose={()=>setRetentionTable(undefined)} onSaved={()=>void load()}/>
      <LogReportingEditor table={logReportingTable} onClose={()=>setLogReportingTable(undefined)}/>
      <MetricWindowEditor table={metricWindowTable} onClose={()=>setMetricWindowTable(undefined)}/>
    </>}
  </div>;
}
