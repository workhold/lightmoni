import {useI18n} from '../shared/i18n';
import {useEffect,useState} from 'react';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {App,Alert,Button,Form,Input,Modal,Space,Table,Tag,Typography} from '../shared/ui';
import {api,post} from '../shared/api';
import type {CatalogTable} from '../shared/types';
import {KeyTablePermissions} from './AllowedTablesInput';

interface KeyItem {
  id:string; name:string; active:boolean; allowed_tables:string[]; allow_all_tables:boolean;
  last_used:string; upload_batches:number; error_count:number;
}
interface CreatedKey {id:string; name:string; key:string; allowed_tables:string[]; allow_all_tables:boolean}

export default function SDKKeySettings() {
 const {t,language:uiLanguage}=useI18n();
const errorText=(error:unknown)=>error instanceof Error?error.message:t("操作失败","Operation failed");

  const {message,modal}=App.useApp();
  const [keys,setKeys]=useState<KeyItem[]>([]),[tables,setTables]=useState<CatalogTable[]>([]);
  const [loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
  const [revision,setRevision]=useState(0),[catalogRevision,setCatalogRevision]=useState(0),[catalogError,setCatalogError]=useState('');
  const [keyEditor,setKeyEditor]=useState<KeyItem|'new'>(),[keyError,setKeyError]=useState(''),[saving,setSaving]=useState(false);
  const [created,setCreated]=useState<CreatedKey>(),[eventKey,setEventKey]=useState<KeyItem>();
  const [keyEvents,setKeyEvents]=useState<Record<string,unknown>[]>([]),[eventLoading,setEventLoading]=useState(false),[eventError,setEventError]=useState(''),[eventRevision,setEventRevision]=useState(0);
  const [actionError,setActionError]=useState('');
  const refresh=()=>setRevision(value=>value+1);

  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void api<KeyItem[]>('/keys',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setKeys(value);setLoaded(true)}}).catch(error=>{if(!controller.signal.aborted)setError(errorText(error))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
    return()=>controller.abort();
  },[revision]);
  useEffect(()=>{
    const controller=new AbortController();setCatalogError('');
    void api<CatalogTable[]>('/catalog/tables',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setTables(value)}).catch(error=>{if(!controller.signal.aborted)setCatalogError(errorText(error))});
    return()=>controller.abort();
  },[catalogRevision]);
  useEffect(()=>{
    if(!eventKey)return;
    const controller=new AbortController();setEventLoading(true);setEventError('');setKeyEvents([]);
    void api<Record<string,unknown>[]>(`/keys/${encodeURIComponent(eventKey.id)}/events`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setKeyEvents(value)}).catch(error=>{if(!controller.signal.aborted)setEventError(errorText(error))}).finally(()=>{if(!controller.signal.aborted)setEventLoading(false)});
    return()=>controller.abort();
  },[eventKey,eventRevision]);

  const openKeyEditor=(key:KeyItem|'new')=>{setKeyError('');setKeyEditor(key)};
  const isNew=keyEditor==='new';
  return <div className="lm-surface">
    <div className="lm-toolbar"><Space wrap><Button type="primary" icon={<PlusOutlined/>} onClick={()=>openKeyEditor('new')}>{t("创建 SDK 上报密钥","Create SDK reporting key")}</Button><Button icon={<ReloadOutlined/>} loading={loading} onClick={refresh}>{t("刷新密钥","Refresh keys")}</Button></Space></div>
    <p>{t("SDK 直连平台时使用，按逻辑表控制写入权限，同一密钥可供多个服务使用。旧版 Agent 也可能使用这些密钥；禁用前请确认使用范围。","Used when SDKs report directly to the platform. Write access is scoped to logical tables; one key may serve multiple services. Legacy Agents may also use these keys. Check their usage before disabling.")}</p>
    {error&&<Alert type="error" showIcon title={t("SDK 上报密钥加载失败","Unable to load SDK reporting keys")} description={error} action={<Button size="small" onClick={refresh}>{t("重试","Retry")}</Button>} style={{marginBottom:16}}/>}
    {catalogError&&<Alert type="warning" showIcon title={t("数据表选项加载失败","Unable to load table options")} description={t(`${catalogError}；仍可在编辑时手动填写逻辑表名。`,`${catalogError}; you can still enter logical table names manually when editing.`)} action={<Button size="small" onClick={()=>setCatalogRevision(value=>value+1)}>{t("重试表选项","Retry table options")}</Button>} style={{marginBottom:16}}/>}
    {actionError&&<Alert type="error" closable onClose={()=>setActionError('')} title={actionError} style={{marginBottom:16}}/>}
    {keys.some(key=>!key.allow_all_tables&&!key.allowed_tables.length)&&<Alert type="warning" style={{marginBottom:16}} title={t("有密钥尚未配置逻辑表，数据写入已受限","Some keys have no logical tables configured and cannot write data")} description={t("请编辑这些密钥，指定允许写入的逻辑表或选择所有表后再继续上报。","Edit these keys to specify allowed logical tables or allow all tables before continuing to report.")}/>}
    {(loaded||loading)&&<Table rowKey="id" loading={loading} dataSource={keys} scroll={{x:1250}} locale={{emptyText:loading?t("正在加载密钥…","Loading keys…"):t("尚无 SDK 上报密钥","No SDK reporting keys yet")}} columns={[
      {title:t("名称","Name"),dataIndex:'name',width:160},
      {title:t("密钥 ID","Key ID"),dataIndex:'id',width:210,render:(value:string)=><Typography.Text copyable code>{value}</Typography.Text>},
      {title:t("允许写入的逻辑表","Allowed logical tables"),dataIndex:'allowed_tables',width:220,render:(value:string[],key:KeyItem)=>key.allow_all_tables?<Tag color="blue">{t("所有逻辑表","All logical tables")}</Tag>:value.length?<Space size={[0,6]} wrap>{value.map(table=><Tag key={table}>{table}</Tag>)}</Space>:<Tag color="warning">{t("待配置 · 禁止写入","Needs configuration · Writes denied")}</Tag>},
      {title:t("状态","Status"),dataIndex:'active',width:80,render:(value:boolean)=><Tag color={value?'success':'default'}>{value?t("启用","Enabled"):t("禁用","Disabled")}</Tag>},
      {title:t("最近使用","Last used"),dataIndex:'last_used',width:190,render:(value:string)=>value?new Date(value).toLocaleString(uiLanguage):t("尚未使用","Never used")},
      {title:t("上传批次","Uploaded batches"),dataIndex:'upload_batches',width:100},{title:t("错误","Error"),dataIndex:'error_count',width:80},
      {title:t("操作","Actions"),width:260,render:(_:unknown,key:KeyItem)=><Space wrap>
        <Button size="small" onClick={()=>openKeyEditor(key)}>{t("编辑","Edit")}</Button>
        <Button size="small" onClick={()=>setEventKey(key)}>{t("查看上报记录","View reporting history")}</Button>
        <Button size="small" danger={key.active} disabled={!key.active&&!key.allow_all_tables&&!key.allowed_tables.length} onClick={()=>modal.confirm({
          title:`${key.active?t("禁用","Disabled"):t("启用","Enabled")} ${key.name}？`,
          content:key.active?t("使用此密钥的 SDK 或旧版 Agent 将停止上报；缓存不会删除。","SDKs and legacy Agents using this key will stop reporting. Buffered data will not be deleted."):key.allow_all_tables?t("此密钥将允许向所有逻辑表上报数据。","This key will allow data reporting to all logical tables."):t("此密钥将允许向已配置的逻辑表上报数据。","This key will allow data reporting to the configured logical tables."),
          onOk:async()=>{setActionError('');try{await api(`/keys/${encodeURIComponent(key.id)}`,{method:'PUT',body:JSON.stringify({active:!key.active})});refresh();void message.success(key.active?t("密钥已禁用","Key disabled"):t("密钥已启用","Key enabled"))}catch(error){setActionError(errorText(error));throw error}},
        })}>{key.active?t("禁用","Disabled"):t("启用","Enabled")}</Button>
      </Space>},
    ]}/>}
    <Modal title={isNew?t("创建 SDK 上报密钥","Create SDK reporting key"):t("编辑 SDK 上报密钥","Edit SDK reporting key")} open={!!keyEditor} onCancel={()=>{if(!saving)setKeyEditor(undefined)}} footer={null} destroyOnHidden>
      <Form key={typeof keyEditor==='object'?keyEditor.id:'new'} layout="vertical" initialValues={typeof keyEditor==='object'?keyEditor:{allow_all_tables:false}} onFinish={async(values:{name:string;allowed_tables?:string[];allow_all_tables:boolean})=>{
        setSaving(true);setKeyError('');
        try{
          if(isNew)setCreated(await post<CreatedKey>('/keys',values));
          else if(keyEditor)await api(`/keys/${encodeURIComponent(keyEditor.id)}`,{method:'PUT',body:JSON.stringify(values)});
          setKeyEditor(undefined);if(!isNew)void message.success(t("上报密钥配置已保存","Reporting key settings saved"));refresh();
        }catch(error){setKeyError(errorText(error))}finally{setSaving(false)}
      }}>
        <Form.Item name="name" label={t("名称","Name")} rules={[{required:true,whitespace:true,message:t("请输入密钥名称","Enter a key name")}]}><Input aria-label={t("密钥名称","Key name")} placeholder={t("例如：Web 日志上报","Example: Web log reporting")} disabled={saving}/></Form.Item>
        <KeyTablePermissions tables={tables} disabled={saving}/>
        {keyError&&<Alert type="error" title={keyError} style={{marginBottom:16}}/>}
        <Button type="primary" htmlType="submit" loading={saving}>{isNew?t("创建","Create"):t("保存","Save")}</Button>
      </Form>
    </Modal>
    <Modal title={t("上报密钥已创建，仅显示这一次","Reporting key created. Shown only once")} destroyOnHidden open={!!created} onCancel={()=>setCreated(undefined)} footer={<Button type="primary" onClick={()=>setCreated(undefined)}>{t("已保存","Saved")}</Button>}>
      <p>{t("请保存到 SDK 配置或密钥管理系统。关闭后无法再次查看明文；列表只显示密钥 ID 和权限。","Save this key in your SDK configuration or secret manager. It cannot be viewed after closing. The list shows only key IDs and permissions.")}</p>
      <p>{t("允许写入：","Allowed tables: ")}{created?.allow_all_tables?t("所有逻辑表","All logical tables"):created?.allowed_tables.join('、')}</p>
      <Typography.Paragraph copyable code>{created?.key}</Typography.Paragraph>
    </Modal>
    <Modal title={t(`${eventKey?.name??''} · 最近上报记录`,`${eventKey?.name??''} · Recent reporting history`)} open={!!eventKey} onCancel={()=>setEventKey(undefined)} footer={null} width={900} destroyOnHidden>
      {eventError?<Alert type="error" title={t("上报记录加载失败","Unable to load reporting history")} description={eventError} action={<Button size="small" onClick={()=>setEventRevision(value=>value+1)}>{t("重试","Retry")}</Button>}/>:<Table rowKey={(_,index)=>String(index)} loading={eventLoading} dataSource={keyEvents} scroll={{x:600}} columns={[{title:t("时间","Time"),dataIndex:'at'},{title:t("服务","Service"),dataIndex:'service'},{title:t("状态","Status"),dataIndex:'status'},{title:t("详情","Details"),dataIndex:'detail'}]}/>}
    </Modal>
  </div>;
}
