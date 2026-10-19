import {useState} from 'react';
import {PlusOutlined} from '@ant-design/icons';
import {Alert,App,Button,Form,Input,Modal,Space,Switch,Table,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {validSDKTable} from './sdkExamples';
import {sdkError,type ExemptTable,type ExemptTableValues} from './sdk-onboarding';

export function ExemptTableEditor({initial,onClose,onCreate,onSaved}:{initial:ExemptTableValues;onClose:()=>void;onCreate:(values:ExemptTableValues)=>Promise<ExemptTable>;onSaved:(item:ExemptTable)=>void}){
 const [saving,setSaving]=useState(false),[error,setError]=useState('');
 return <Modal open title="添加豁免表" onCancel={()=>{if(!saving)onClose();}} footer={null} destroyOnHidden>
  <p>启用后，不携带密钥的 SDK 可向此逻辑表上报日志、指标和链路。建议使用带随机后缀的复杂表名。</p>
  <Form layout="vertical" initialValues={initial} onFinish={async(values:ExemptTableValues)=>{setSaving(true);setError('');try{onSaved(await onCreate({...values,name:values.name.trim()}));}catch(error){setError(sdkError(error));}finally{setSaving(false);}}}>
   <Form.Item name="name" label="豁免逻辑表名" rules={[{required:true,message:'请输入逻辑表名'},{validator:(_,value)=>validSDKTable(value?.trim()??'')?Promise.resolve():Promise.reject(new Error('最长 48 位，小写字母开头，不带 log_/metric_/trace_ 前缀或系统表名'))}]}><Input aria-label="豁免逻辑表名" disabled={saving} maxLength={48}/></Form.Item>
   <Form.Item name="description" label="用途说明"><Input aria-label="豁免表用途" maxLength={500} disabled={saving}/></Form.Item>
   {error&&<Alert type="error" showIcon title={error} className="lm-sdk-form-error"/>}
   <Button type="primary" htmlType="submit" loading={saving}>添加并启用</Button>
  </Form>
 </Modal>;
}
export default function SDKExemptTables({items,admin,onCreate,onReload}:{items:ExemptTable[];admin:boolean;onCreate:(values:ExemptTableValues)=>Promise<ExemptTable>;onReload:()=>Promise<void>}){
 const {message}=App.useApp(),[creating,setCreating]=useState(false),[busy,setBusy]=useState('');
 const [editing,setEditing]=useState<ExemptTable>(),[description,setDescription]=useState(''),[editError,setEditError]=useState('');
 const update=async(item:ExemptTable,active:boolean)=>{setBusy(item.name);try{await api(`/sdk-exempt-tables/${encodeURIComponent(item.name)}`,{method:'PUT',body:JSON.stringify({active})});await onReload();void message.success(active?'豁免表已启用':'豁免表已停用');}catch(error){void message.error(sdkError(error));}finally{setBusy('');}};
 return <div className="lm-surface">
  <div className="lm-toolbar"><div><h2>豁免表</h2><p>只有已启用的逻辑表允许无密钥上报。停用或移除豁免不会删除已有数据。</p></div>{admin&&<Button type="primary" icon={<PlusOutlined/>} onClick={()=>setCreating(true)}>添加豁免表</Button>}</div>
  <Alert type="info" showIcon title="建议使用复杂表名" description="例如应用日志、业务指标、前端事件表，添加随机后缀可减少被猜中的机会。豁免意味着知道表名即可上报，请仅开放确有需要的表。" style={{marginBottom:20}}/>
  <Table rowKey="name" dataSource={items} scroll={{x:700}} locale={{emptyText:'尚未配置豁免表，当前所有上报均需要 SDK 密钥'}} columns={[
   {title:'逻辑表名',dataIndex:'name',render:(name:string)=><Typography.Text code copyable>{name}</Typography.Text>},
   {title:'用途',dataIndex:'description',render:(value:string)=>value||'—'},
   {title:'状态',dataIndex:'active',render:(value:boolean,item:ExemptTable)=>admin?<Switch checked={value} checkedChildren="启用" unCheckedChildren="停用" aria-label={`豁免 ${item.name}`} loading={busy===item.name} onChange={active=>void update(item,active)}/>:<Tag color={value?'success':'default'}>{value?'启用':'停用'}</Tag>},
   ...(admin?[{title:'操作',render:(_:unknown,item:ExemptTable)=><Space><Button size="small" onClick={()=>{setEditing(item);setDescription(item.description);setEditError('');}}>编辑说明</Button><Button size="small" danger onClick={()=>Modal.confirm({title:`移除 ${item.name} 的豁免？`,content:'后续无密钥请求将被拒绝，已有数据保留。',okText:'移除豁免',cancelText:'取消',onOk:async()=>{try{await api(`/sdk-exempt-tables/${encodeURIComponent(item.name)}`,{method:'DELETE'});await onReload();void message.success('豁免已移除');}catch(error){void message.error(sdkError(error));throw error;}}})}>移除</Button></Space>}]:[]),
  ]}/>
  {creating&&<ExemptTableEditor initial={{name:'',description:''}} onClose={()=>setCreating(false)} onCreate={onCreate} onSaved={()=>{setCreating(false);void message.success('豁免表已添加');}}/>}
  <Modal title="编辑豁免表说明" open={!!editing} onCancel={()=>{if(!busy)setEditing(undefined);}} confirmLoading={!!busy} okText="保存" cancelText="取消" onOk={async()=>{if(!editing)return;setBusy(editing.name);setEditError('');try{await api(`/sdk-exempt-tables/${encodeURIComponent(editing.name)}`,{method:'PUT',body:JSON.stringify({description})});setEditing(undefined);await onReload();}catch(error){setEditError(sdkError(error));}finally{setBusy('');}}}>
   <Typography.Paragraph code>{editing?.name}</Typography.Paragraph><Input.TextArea aria-label="用途说明" value={description} maxLength={500} onChange={e=>setDescription(e.target.value)} disabled={!!busy}/>{editError&&<Alert type="error" title={editError}/>}
  </Modal>
 </div>;
}
