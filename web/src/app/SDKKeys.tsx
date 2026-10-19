import {useState} from 'react';
import {PlusOutlined} from '@ant-design/icons';
import {Alert,App,Button,Form,Input,Modal,Space,Table,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {SDKReportingEditor} from './LogReportingSettings';
import {sdkError,type SDKKey,type CreatedSDKKey,type SDKKeyValues} from './sdk-onboarding';
export default function SDKKeys({keys,admin,onCreate,onReload}:{keys:SDKKey[];admin:boolean;onCreate:(values:SDKKeyValues)=>Promise<CreatedSDKKey>;onReload:()=>Promise<void>}){
 const {message}=App.useApp(),[editor,setEditor]=useState<SDKKey|'new'>(),[saving,setSaving]=useState(false),[error,setError]=useState(''),[created,setCreated]=useState<CreatedSDKKey>(),[events,setEvents]=useState<Record<string,unknown>[]>(),[reportingOpen,setReportingOpen]=useState(false);
 if(!admin)return <Alert type="info" title="SDK 密钥由管理员创建和管理"/>;
 const open=(key:SDKKey|'new')=>{setError('');setEditor(key);};
 return <div className="lm-surface">
  <div className="lm-toolbar"><div><h2>SDK 密钥</h2><p>启用的密钥可向任意业务表上报，同一密钥可供多个服务使用。</p></div><Space wrap><Button onClick={()=>setReportingOpen(true)}>SDK 停报规则</Button><Button type="primary" icon={<PlusOutlined/>} onClick={()=>open('new')}>创建 SDK 密钥</Button></Space></div>
  <Table rowKey="id" dataSource={keys} scroll={{x:1050}} columns={[
   {title:'名称',dataIndex:'name'},
   {title:'状态',dataIndex:'active',render:(value:boolean)=><Tag color={value?'success':'default'}>{value?'启用':'禁用'}</Tag>},
   {title:'最近使用',dataIndex:'last_used',render:(value:string)=>value?new Date(value).toLocaleString():'尚未使用'},
   {title:'上传批次',dataIndex:'upload_batches'},{title:'错误',dataIndex:'error_count'},
   {title:'操作',width:240,render:(_:unknown,key:SDKKey)=><Space wrap><Button size="small" onClick={()=>open(key)}>编辑</Button><Button size="small" onClick={async()=>{try{setEvents(await api(`/keys/${key.id}/events`));}catch(error){void message.error(sdkError(error));}}}>上传记录</Button><Button size="small" danger={key.active} onClick={()=>Modal.confirm({title:`${key.active?'禁用':'启用'} ${key.name}？`,content:key.active?'使用此密钥的 SDK 或执行节点将停止上报，已有数据保留。':'允许此密钥向任意业务表上报。',okText:key.active?'禁用':'启用',cancelText:'取消',onOk:async()=>{try{await api(`/keys/${key.id}`,{method:'PUT',body:JSON.stringify({active:!key.active})});await onReload();}catch(error){void message.error(sdkError(error));throw error;}}})}>{key.active?'禁用':'启用'}</Button></Space>},
  ]}/>
  <Modal title={editor==='new'?'创建 SDK 密钥':'编辑 SDK 密钥'} open={!!editor} onCancel={()=>{if(!saving)setEditor(undefined);}} footer={null} destroyOnHidden>
   <Form key={typeof editor==='object'?editor.id:'new'} layout="vertical" initialValues={typeof editor==='object'?editor:{}} onFinish={async(values:SDKKeyValues)=>{setSaving(true);setError('');try{if(editor==='new')setCreated(await onCreate(values));else if(editor){await api(`/keys/${editor.id}`,{method:'PUT',body:JSON.stringify(values)});await onReload();}setEditor(undefined);void message.success('SDK 密钥已保存');}catch(error){setError(sdkError(error));}finally{setSaving(false);}}}>
    <Form.Item name="name" label="密钥名称" rules={[{required:true,whitespace:true,message:'请输入密钥名称'}]}><Input aria-label="密钥名称" disabled={saving}/></Form.Item>
    {error&&<Alert type="error" title={error} className="lm-sdk-form-error"/>}<Button type="primary" htmlType="submit" loading={saving}>{editor==='new'?'创建':'保存'}</Button>
   </Form>
  </Modal>
  <Modal title="SDK 密钥已创建" open={!!created} onCancel={()=>setCreated(undefined)} footer={<Button type="primary" onClick={()=>setCreated(undefined)}>已保存</Button>}><p>请保存完整密钥，刷新后无法再次查看。</p><Typography.Paragraph copyable code>{created?.key}</Typography.Paragraph></Modal>
  <SDKReportingEditor open={reportingOpen} onClose={()=>setReportingOpen(false)}/>
  <Modal title="最近上传记录" open={!!events} onCancel={()=>setEvents(undefined)} footer={null} width={900}><Table rowKey={(_,index)=>String(index)} dataSource={events} scroll={{x:600}} columns={[{title:'时间',dataIndex:'at'},{title:'服务',dataIndex:'service'},{title:'状态',dataIndex:'status'},{title:'详情',dataIndex:'detail'}]}/></Modal>
 </div>;
}
