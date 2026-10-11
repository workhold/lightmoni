import {useEffect,useState} from 'react';
import {Link,useNavigate,useSearchParams} from 'react-router-dom';
import {CopyOutlined,PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {App,Alert,Button,Empty,Form,Input,Modal,Select,Space,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api,post} from '../shared/api';
import type {CatalogTable,User} from '../shared/types';
import {retentionLabel,TableRetentionEditor} from './RetentionSettings';
import AgentInstall from './AgentInstall';
import {KeyTablePermissions} from './AllowedTablesInput';
import {sdkExamples,type SDKInstall} from './sdkExamples';
import CodeBlock from '../shared/CodeBlock';

interface KeyItem {
  id:string; name:string; active:boolean; allowed_tables:string[]; allow_all_tables:boolean;
  last_used:string; upload_batches:number; error_count:number;
}
interface CreatedKey {id:string; name:string; key:string; allowed_tables:string[]; allow_all_tables:boolean}
interface Template {id:string;title:string;description:string;type:string;table_id:string;sql:string;options:Record<string,unknown>}
const errorText = (error:unknown) => error instanceof Error ? error.message : '操作失败';

export default function DataPage({user}:{user:User}) {
  const {message}=App.useApp(),[params]=useSearchParams();
  const [retentionTable,setRetentionTable]=useState<CatalogTable>();
  const [keys,setKeys] = useState<KeyItem[]>([]);
  const [tables,setTables] = useState<CatalogTable[]>([]);
  const [templates,setTemplates] = useState<Template[]>([]);
  const [error,setError] = useState('');
  const [keyEditor,setKeyEditor] = useState<KeyItem|'new'>();
  const [keyError,setKeyError] = useState('');
  const [saving,setSaving] = useState(false);
  const [created,setCreated] = useState<CreatedKey>();
  const [keyEvents,setKeyEvents] = useState<Record<string,unknown>[]>();
  const [tab,setTab] = useState(params.get('tab')??'sdk');
  const [sdk,setSDK] = useState<SDKInstall>();
  const [sdkLanguage,setSDKLanguage] = useState('typescript');
  const navigate = useNavigate();
  const load = async () => {
    setError('');
    try {
      const [install,catalog,examples,keyList] = await Promise.all([
        api<SDKInstall>('/sdk-install'),
        api<CatalogTable[]>('/catalog/tables'),
        api<Template[]>('/templates'),
        user.role === 'admin' ? api<KeyItem[]>('/keys') : Promise.resolve([]),
      ]);
      setSDK(install); setTables(catalog); setTemplates(examples); setKeys(keyList);
    } catch (error) { setError(errorText(error)); }
  };
  useEffect(() => { void load(); }, [user.role]);
  useEffect(()=>{if(error)void message.error(error);},[error,message]);
  const openKeyEditor = (key:KeyItem|'new') => { setKeyError(''); setKeyEditor(key); };
  const sdkPackage = sdk?.packages?.find(item => item.id === sdkLanguage);
  const sdkExample = sdkExamples[sdkLanguage] ?? sdkExamples.typescript;
  const sample = sdkExample.sample;
  const isNew = keyEditor === 'new';
  return <div className="lm-page">
    <div className="lm-page-heading"><div><h1>数据接入</h1><p>选择 SDK 或 Agent 接入，使用 Key 限定允许写入的 table。</p></div><Button icon={<ReloadOutlined/>} onClick={() => void load()}>刷新接入状态</Button></div>

    <Tabs activeKey={tab} onChange={setTab} destroyOnHidden items={[
      {key:'sdk',label:'SDK 接入',children:<div className="lm-surface">
        <Space wrap style={{marginBottom:14}}>
          <h2 style={{margin:0}}>SDK 接入</h2>
          <Select aria-label="SDK 语言" style={{minWidth:260}} value={sdkLanguage} onChange={setSDKLanguage}
            options={(sdk?.packages ?? []).map(item => ({value:item.id,label:item.language}))}/>
          {sdkPackage && <Tag>{sdkPackage.runtime}</Tag>}
        </Space>
        <p>下载源码包或 npm 安装包后，按所选语言的命令安装。解压包内包含 README 和可运行示例。</p>
        <Space wrap style={{marginBottom:14}}>
          <Button href={sdkPackage?.url} disabled={!sdkPackage?.available}>下载 SDK 与示例</Button>
          {sdk?.checksums_url && <Button href={sdk.checksums_url}>下载 SHA256 校验文件</Button>}
        </Space>
        {sdkPackage && !sdkPackage.available && <Alert type="warning" style={{marginBottom:14}} title="当前服务尚未打包此 SDK，请先构建 SDK 安装包。"/>}
        <CodeBlock code={sdkExample.install} language="bash" ariaLabel="SDK 安装命令"/>
        <h3>业务接入示例</h3>
        <CodeBlock code={sample} language={sdkExample.language} ariaLabel="业务接入 SDK 示例"/>
        <Button icon={<CopyOutlined/>} onClick={() => void navigator.clipboard.writeText(sample).catch(() => setError('复制失败，请选择样例手动复制'))}>复制接入样例</Button>
        <p>本机 Agent 的 Key 需允许写入 <Typography.Text code>business</Typography.Text>。直连主服务时添加 <Typography.Text code>key</Typography.Text>，并使用允许写入目标 table 的 Key。指定 table 模式下，使用 <Typography.Text code>withTable</Typography.Text> 时也需将对应 table 加入白名单。</p>
        <p>所有 SDK 支持 Counter、Gauge、Histogram、日志和基础链路。Python、Java、.NET、PHP、Ruby、Rust 由应用定时或在请求结束时调用 flush；退出前停止生产，再调用有截止时间的 shutdown。</p>
        <p>浏览器通过业务后端转发，后端保管仅允许目标 table 的 Key，页面无需保存私有 Key。Java 包适用于 Kotlin/JVM 服务端。</p>
      </div>},
      {key:'agent',label:'Agent 接入',children:<AgentInstall user={user} tables={tables} initialGroup={params.get('group') ?? undefined} onKeyCreated={() => void load()}/>},
      {key:'keys',label:'上报 Key',children:user.role === 'admin' ? <div className="lm-surface">
        <div className="lm-toolbar"><Button type="primary" icon={<PlusOutlined/>} onClick={() => openKeyEditor('new')}>创建 Key</Button><span>可指定允许写入的 table，或显式允许所有 table；同一 Key 可供多个 service 使用。</span></div>
        {keys.some(key => !key.allow_all_tables && !key.allowed_tables.length) && <Alert type="warning" style={{marginBottom:16}} title="有 Key 尚未配置 table，数据写入已受限" description="请编辑这些 Key，指定允许写入的 table 或选择所有 table 后再继续上报。"/>}
        <Table rowKey="id" dataSource={keys} scroll={{x:1200}} columns={[
          {title:'名称',dataIndex:'name'},
          {title:'Key ID',dataIndex:'id',render:(value:string) => <Typography.Text copyable code>{value}</Typography.Text>},
          {title:'允许写入的 Table',dataIndex:'allowed_tables',width:220,render:(value:string[],key:KeyItem) => key.allow_all_tables ? <Tag color="blue">所有 table</Tag> : value.length ? <Space size={[0,6]} wrap>{value.map(table => <Tag key={table}>{table}</Tag>)}</Space> : <Tag color="warning">待配置 · 禁止写入</Tag>},
          {title:'状态',dataIndex:'active',render:(value:boolean) => <Tag color={value?'success':'default'}>{value?'启用':'禁用'}</Tag>},
          {title:'最近使用',dataIndex:'last_used',render:(value:string) => value ? new Date(value).toLocaleString() : '尚未使用'},
          {title:'上传批次',dataIndex:'upload_batches'},
          {title:'错误',dataIndex:'error_count'},
          {title:'操作',width:250,render:(_:unknown,key:KeyItem) => <Space wrap>
            <Button size="small" onClick={() => openKeyEditor(key)}>编辑</Button>
            <Button size="small" onClick={async () => { try { setKeyEvents(await api(`/keys/${key.id}/events`)); } catch (error) { setError(errorText(error)); } }}>查看上传记录</Button>
            <Button size="small" danger={key.active} disabled={!key.active && !key.allow_all_tables && !key.allowed_tables.length} onClick={() => Modal.confirm({
              title:`${key.active?'禁用':'启用'} ${key.name}？`,
              content:key.active ? '使用此 Key 的 Agent 或 SDK 将停止上报；缓存不会删除。' : key.allow_all_tables ? '此 Key 将允许向所有 table 上传数据。' : '此 Key 将允许向已配置的 table 上传数据。',
              onOk:async () => { try { await api(`/keys/${key.id}`,{method:'PUT',body:JSON.stringify({active:!key.active})}); await load(); } catch (error) { setError(errorText(error)); throw error; } },
            })}>{key.active?'禁用':'启用'}</Button>
          </Space>},
        ]}/>
      </div> : <Alert type="info" title="由管理员创建和管理 Key"/>},
      {key:'tables',label:'数据表',children:<div className="lm-surface"><div className="lm-toolbar"><span>单表设置优先于全局默认。</span>{user.role==='admin'&&<Link to="/settings?tab=retention">管理全局默认时长</Link>}</div><Table rowKey="id" dataSource={tables} scroll={{x:650}} columns={[
        {title:'SQL 名称',dataIndex:'name'},{title:'业务表',dataIndex:'logical_name'},{title:'类型',dataIndex:'kind'},
        {title:'服务',dataIndex:'services',render:(value:string[]) => value.join(' · ')},
        {title:'保留时长',render:(_:unknown,table:CatalogTable)=><Space wrap><span>{retentionLabel(table.effective_retention_days)}</span>{table.retention_days==null&&<Tag>跟随全局</Tag>}{user.role==='admin'&&<Button size="small" onClick={()=>setRetentionTable(table)}>设置时长</Button>}</Space>},
        {title:'查看',render:(_:unknown,table:CatalogTable) => <Button onClick={() => navigate('/query?sql='+encodeURIComponent(`SELECT * FROM ${table.name} WHERE $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100`))}>查询数据</Button>},
      ]}/></div>},
      {key:'templates',label:'图表与 SQL 样例',children:<div className="lm-template-grid">{templates.length === 0 ? <Empty description="接入数据后自动生成与真实表结构匹配的图表模板"/> : templates.map(template => <div className="lm-template" key={template.id}>
        <Tag>{template.table_id}</Tag><h3>{template.title}</h3><p>{template.description}</p><Space>
          <Button onClick={() => navigate('/query?sql='+encodeURIComponent(template.sql))}>运行 SQL</Button>
          <Button type="primary" onClick={async () => { try { const dashboard = await post<{id:string}>('/dashboards',{title:template.title,description:template.description,panels:[{id:crypto.randomUUID(),title:template.title,type:template.type,queries:[{refId:'A',sql:template.sql}],options:template.options,grid:{x:0,y:0,w:12,h:7}}]}); navigate('/dashboards/'+dashboard.id); } catch (error) { setError(errorText(error)); } }}>快速创建图表</Button>
        </Space>
      </div>)}</div>},
    ]}/>
    <TableRetentionEditor table={retentionTable} onClose={()=>setRetentionTable(undefined)} onSaved={()=>void load()}/>
    <Modal title={isNew?'创建上报 Key':'编辑上报 Key'} open={!!keyEditor} onCancel={() => { if (!saving) setKeyEditor(undefined); }} footer={null} destroyOnHidden>
      <Form key={typeof keyEditor === 'object'?keyEditor.id:'new'} layout="vertical" initialValues={typeof keyEditor === 'object'?keyEditor:{allow_all_tables:false}} onFinish={async (values:{name:string;allowed_tables?:string[];allow_all_tables:boolean}) => {
        setSaving(true); setKeyError('');
        try {
          if (isNew) setCreated(await post<CreatedKey>('/keys',values));
          else if (keyEditor) await api(`/keys/${keyEditor.id}`,{method:'PUT',body:JSON.stringify(values)});
          setKeyEditor(undefined);if(!isNew)void message.success('Key 配置已保存'); await load();
        } catch (error) { setKeyError(errorText(error)); } finally { setSaving(false); }
      }}>
        <Form.Item name="name" label="名称" rules={[{required:true,whitespace:true,message:'请输入 Key 名称'}]}><Input aria-label="Key 名称" placeholder="例如：Web 日志上报" disabled={saving}/></Form.Item>
        <KeyTablePermissions tables={tables} disabled={saving}/>
        {keyError && <Alert type="error" title={keyError} style={{marginBottom:16}}/>}
        <Button type="primary" htmlType="submit" loading={saving}>{isNew?'创建':'保存'}</Button>
      </Form>
    </Modal>
    <Modal title="Key 已创建，仅显示这一次" open={!!created} onCancel={() => setCreated(undefined)} footer={<Button type="primary" onClick={() => setCreated(undefined)}>已保存</Button>}>
      <p>请保存到 Agent 或 SDK 配置。管理列表只保留摘要。</p>
      <p>允许写入：{created?.allow_all_tables?'所有 table':created?.allowed_tables.join('、')}</p>
      <Typography.Paragraph copyable code>{created?.key}</Typography.Paragraph>
    </Modal>
    <Modal title="最近上传记录" open={!!keyEvents} onCancel={() => setKeyEvents(undefined)} footer={null} width={900}>
      <Table rowKey={(_,index) => String(index)} dataSource={keyEvents} scroll={{x:600}} columns={[{title:'时间',dataIndex:'at'},{title:'服务',dataIndex:'service'},{title:'状态',dataIndex:'status'},{title:'详情',dataIndex:'detail'}]}/>
    </Modal>
  </div>;
}
