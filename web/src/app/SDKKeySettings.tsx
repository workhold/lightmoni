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
const errorText=(error:unknown)=>error instanceof Error?error.message:'操作失败';

export default function SDKKeySettings() {
  const {message}=App.useApp();
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
    <div className="lm-toolbar"><Space wrap><Button type="primary" icon={<PlusOutlined/>} onClick={()=>openKeyEditor('new')}>创建 SDK 上报密钥</Button><Button icon={<ReloadOutlined/>} loading={loading} onClick={refresh}>刷新密钥</Button></Space></div>
    <p>SDK 直连平台时使用，按逻辑表控制写入权限，同一密钥可供多个服务使用。旧版 Agent 也可能使用这些密钥；禁用前请确认使用范围。</p>
    {error&&<Alert type="error" showIcon title="SDK 上报密钥加载失败" description={error} action={<Button size="small" onClick={refresh}>重试</Button>} style={{marginBottom:16}}/>}
    {catalogError&&<Alert type="warning" showIcon title="数据表选项加载失败" description={`${catalogError}；仍可在编辑时手动填写逻辑表名。`} action={<Button size="small" onClick={()=>setCatalogRevision(value=>value+1)}>重试表选项</Button>} style={{marginBottom:16}}/>}
    {actionError&&<Alert type="error" closable onClose={()=>setActionError('')} title={actionError} style={{marginBottom:16}}/>}
    {keys.some(key=>!key.allow_all_tables&&!key.allowed_tables.length)&&<Alert type="warning" style={{marginBottom:16}} title="有密钥尚未配置逻辑表，数据写入已受限" description="请编辑这些密钥，指定允许写入的逻辑表或选择所有表后再继续上报。"/>}
    {(loaded||loading)&&<Table rowKey="id" loading={loading} dataSource={keys} scroll={{x:1250}} locale={{emptyText:loading?'正在加载密钥…':'尚无 SDK 上报密钥'}} columns={[
      {title:'名称',dataIndex:'name',width:160},
      {title:'密钥 ID',dataIndex:'id',width:210,render:(value:string)=><Typography.Text copyable code>{value}</Typography.Text>},
      {title:'允许写入的逻辑表',dataIndex:'allowed_tables',width:220,render:(value:string[],key:KeyItem)=>key.allow_all_tables?<Tag color="blue">所有逻辑表</Tag>:value.length?<Space size={[0,6]} wrap>{value.map(table=><Tag key={table}>{table}</Tag>)}</Space>:<Tag color="warning">待配置 · 禁止写入</Tag>},
      {title:'状态',dataIndex:'active',width:80,render:(value:boolean)=><Tag color={value?'success':'default'}>{value?'启用':'禁用'}</Tag>},
      {title:'最近使用',dataIndex:'last_used',width:190,render:(value:string)=>value?new Date(value).toLocaleString():'尚未使用'},
      {title:'上传批次',dataIndex:'upload_batches',width:100},{title:'错误',dataIndex:'error_count',width:80},
      {title:'操作',width:260,render:(_:unknown,key:KeyItem)=><Space wrap>
        <Button size="small" onClick={()=>openKeyEditor(key)}>编辑</Button>
        <Button size="small" onClick={()=>setEventKey(key)}>查看上报记录</Button>
        <Button size="small" danger={key.active} disabled={!key.active&&!key.allow_all_tables&&!key.allowed_tables.length} onClick={()=>Modal.confirm({
          title:`${key.active?'禁用':'启用'} ${key.name}？`,
          content:key.active?'使用此密钥的 SDK 或旧版 Agent 将停止上报；缓存不会删除。':key.allow_all_tables?'此密钥将允许向所有逻辑表上报数据。':'此密钥将允许向已配置的逻辑表上报数据。',
          onOk:async()=>{setActionError('');try{await api(`/keys/${encodeURIComponent(key.id)}`,{method:'PUT',body:JSON.stringify({active:!key.active})});refresh();void message.success(key.active?'密钥已禁用':'密钥已启用')}catch(error){setActionError(errorText(error));throw error}},
        })}>{key.active?'禁用':'启用'}</Button>
      </Space>},
    ]}/>}
    <Modal title={isNew?'创建 SDK 上报密钥':'编辑 SDK 上报密钥'} open={!!keyEditor} onCancel={()=>{if(!saving)setKeyEditor(undefined)}} footer={null} destroyOnHidden>
      <Form key={typeof keyEditor==='object'?keyEditor.id:'new'} layout="vertical" initialValues={typeof keyEditor==='object'?keyEditor:{allow_all_tables:false}} onFinish={async(values:{name:string;allowed_tables?:string[];allow_all_tables:boolean})=>{
        setSaving(true);setKeyError('');
        try{
          if(isNew)setCreated(await post<CreatedKey>('/keys',values));
          else if(keyEditor)await api(`/keys/${encodeURIComponent(keyEditor.id)}`,{method:'PUT',body:JSON.stringify(values)});
          setKeyEditor(undefined);if(!isNew)void message.success('上报密钥配置已保存');refresh();
        }catch(error){setKeyError(errorText(error))}finally{setSaving(false)}
      }}>
        <Form.Item name="name" label="名称" rules={[{required:true,whitespace:true,message:'请输入密钥名称'}]}><Input aria-label="密钥名称" placeholder="例如：Web 日志上报" disabled={saving}/></Form.Item>
        <KeyTablePermissions tables={tables} disabled={saving}/>
        {keyError&&<Alert type="error" title={keyError} style={{marginBottom:16}}/>}
        <Button type="primary" htmlType="submit" loading={saving}>{isNew?'创建':'保存'}</Button>
      </Form>
    </Modal>
    <Modal title="上报密钥已创建，仅显示这一次" destroyOnHidden open={!!created} onCancel={()=>setCreated(undefined)} footer={<Button type="primary" onClick={()=>setCreated(undefined)}>已保存</Button>}>
      <p>请保存到 SDK 配置或密钥管理系统。关闭后无法再次查看明文；列表只显示密钥 ID 和权限。</p>
      <p>允许写入：{created?.allow_all_tables?'所有逻辑表':created?.allowed_tables.join('、')}</p>
      <Typography.Paragraph copyable code>{created?.key}</Typography.Paragraph>
    </Modal>
    <Modal title={`${eventKey?.name??''} · 最近上报记录`} open={!!eventKey} onCancel={()=>setEventKey(undefined)} footer={null} width={900} destroyOnHidden>
      {eventError?<Alert type="error" title="上报记录加载失败" description={eventError} action={<Button size="small" onClick={()=>setEventRevision(value=>value+1)}>重试</Button>}/>:<Table rowKey={(_,index)=>String(index)} loading={eventLoading} dataSource={keyEvents} scroll={{x:600}} columns={[{title:'时间',dataIndex:'at'},{title:'服务',dataIndex:'service'},{title:'状态',dataIndex:'status'},{title:'详情',dataIndex:'detail'}]}/>}
    </Modal>
  </div>;
}
