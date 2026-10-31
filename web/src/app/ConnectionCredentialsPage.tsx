import {useCallback,useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Empty,Form,Input,Modal,Space,Table,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {MachineCredentialFields,clearCredentialSecrets,credentialInitialValues,credentialPayload} from './MachineCredentialForm';
import {availableConnectionCredential,type ConnectionCredential} from './connection-credentials';
import './connection-credentials.css';

export default function ConnectionCredentialsPage(){
 const {t,language}=useI18n(),{message}=App.useApp();
 const [items,setItems]=useState<ConnectionCredential[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [creating,setCreating]=useState(false),[editing,setEditing]=useState<ConnectionCredential>(),[revoking,setRevoking]=useState<ConnectionCredential>();
 const [busy,setBusy]=useState(false),[actionError,setActionError]=useState(''),[form]=Form.useForm(),pending=useRef(false);
 const text=(e:unknown)=>e instanceof Error?e.message:t('操作失败','Operation failed');
 const time=(value:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(language):'—';
 const load=useCallback(async()=>{setLoading(true);try{setItems(await api<ConnectionCredential[]>('/connection-credentials'));setError('')}catch(e){setError(text(e))}finally{setLoading(false)}},[]);
 useEffect(()=>{void load();const refresh=()=>void load(),timer=setInterval(refresh,30000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh)}},[load]);
 const close=()=>{if(pending.current)return;form.resetFields();setCreating(false);setEditing(undefined);setRevoking(undefined);setActionError('')};
 const save=async(values:any)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setActionError('');
  try{
   if(editing){await api(`/connection-credentials/${encodeURIComponent(editing.id)}`,{method:'PUT',body:JSON.stringify({name:values.name.trim()})});void message.success(t('凭据名称已更新','Credential name updated'))}
   else{const saved=await api<ConnectionCredential>('/connection-credentials',{method:'POST',body:JSON.stringify(credentialPayload(values))});void message.success(saved.reused?t('已复用已有私钥，保留其原有有效期','Existing private key reused with its original expiry'):t('连接凭据已保存','Connection credential saved'))}
   form.resetFields();setCreating(false);setEditing(undefined);await load();
  }catch(e){setActionError(text(e))}finally{pending.current=false;setBusy(false)}
 };
 const revoke=async()=>{
  if(!revoking||pending.current)return;pending.current=true;setBusy(true);setActionError('');
  try{await api(`/connection-credentials/${encodeURIComponent(revoking.id)}/revoke`,{method:'POST',body:JSON.stringify({confirm:true})});setRevoking(undefined);void message.success(t('连接凭据已撤销','Connection credential revoked'));await load()}catch(e){setActionError(text(e))}finally{pending.current=false;setBusy(false)}
 };
 return <div className="lm-page lm-connection-credentials-page">
  <div className="lm-page-heading"><div><h1>{t('连接凭据','Connection credentials')}</h1><p>{t('集中管理主机 SSH 私钥和密码，同一凭据可供多台主机使用。','Manage host SSH keys and passwords centrally and reuse a credential across hosts.')}</p></div><Space wrap><Button aria-label={t('刷新','Refresh')} icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>{t('刷新','Refresh')}</Button><Button aria-label={t('新增凭据','Add credential')} type="primary" icon={<PlusOutlined/>} onClick={()=>{form.resetFields();setActionError('');setCreating(true)}}>{t('新增凭据','Add credential')}</Button></Space></div>
  {error&&<Alert showIcon type="error" title={error} style={{marginBottom:16}}/>}
  <div className="lm-surface"><Table<ConnectionCredential> rowKey="id" dataSource={items} loading={loading} scroll={{x:1160}} pagination={{pageSize:10,hideOnSinglePage:true}} locale={{emptyText:<Empty description={t('尚无连接凭据','No connection credentials yet')}/>}} columns={[
   {title:t('名称','Name'),dataIndex:'name',width:200,render:(name:string,c)=><><Typography.Text strong>{name}</Typography.Text><Typography.Text type="secondary" className="lm-credential-meta">{c.id}</Typography.Text></>},
   {title:t('类型 / 公钥指纹','Type / public-key fingerprint'),width:270,render:(_,c)=><><Tag>{c.method==='ssh_key'?t('SSH 私钥','SSH private key'):t('SSH 密码','SSH password')}</Tag>{c.method==='ssh_key'&&c.secret_fingerprint&&<Typography.Text code copyable className="lm-credential-meta">{c.secret_fingerprint}</Typography.Text>}</>},
   {title:t('状态','Status'),width:90,render:(_,c)=><Tag color={availableConnectionCredential(c)?'success':'default'}>{c.revoked_at||c.status==='revoked'?t('已撤销','Revoked'):availableConnectionCredential(c)?t('有效','Active'):t('已过期','Expired')}</Tag>},
   {title:t('有效期','Expires at'),width:180,render:(_,c)=>c.retention==='permanent'?t('永久','Permanent'):time(c.expires_at)},
   {title:t('关联主机','Associated hosts'),width:210,render:(_,c)=><Space wrap>{c.hosts.length?c.hosts.map(host=><Link key={host.id} to={`/machines?machine=${encodeURIComponent(host.id)}`}><Tag>{host.name}</Tag></Link>):<Typography.Text type="secondary">{t('尚未关联','Not associated')}</Typography.Text>}</Space>},
   {title:t('最近使用','Last used'),dataIndex:'last_used_at',width:180,render:time},
   {title:t('操作','Actions'),width:160,render:(_,c)=><Space><Button size="small" onClick={()=>{form.resetFields();form.setFieldsValue({name:c.name});setActionError('');setEditing(c)}}>{t('重命名','Rename')}</Button><Button aria-label={t('撤销','Revoke')} size="small" danger disabled={c.status==='revoked'||!!c.revoked_at} onClick={()=>{setActionError('');setRevoking(c)}}>{t('撤销','Revoke')}</Button></Space>},
  ]}/></div>
  <Modal open={creating||!!editing} title={editing?t('重命名连接凭据','Rename connection credential'):t('新增连接凭据','Add connection credential')} onCancel={close} footer={null} width={600} className="lm-machine-credential-dialog" style={{top:24}} closable={!busy} maskClosable={false} destroyOnHidden>
   <Form form={form} layout="vertical" disabled={busy} initialValues={credentialInitialValues} onValuesChange={changed=>clearCredentialSecrets(form,changed)} onFinish={values=>void save(values)}>
    {editing?<Form.Item name="name" label={t('凭据名称','Credential name')} rules={[{required:true,message:t('请输入凭据名称','Enter a credential name')},{max:128}]}><Input autoComplete="off"/></Form.Item>:<MachineCredentialFields nameRequired/>}
    {actionError&&<Alert type="error" showIcon title={actionError} style={{marginBottom:16}}/>}<Button type="primary" htmlType="submit" block loading={busy}>{t('保存凭据','Save credential')}</Button>
   </Form>
  </Modal>
  <Modal open={!!revoking} title={t('撤销连接凭据？','Revoke connection credential?')} onCancel={close} onOk={()=>void revoke()} okText={t('确认撤销','Confirm revocation')} cancelText={t('取消','Cancel')} confirmLoading={busy} cancelButtonProps={{'aria-label':t('取消','Cancel')}} okButtonProps={{danger:true}} closable={!busy} maskClosable={false} destroyOnHidden>
   {revoking&&<><p>{t(`将撤销“${revoking.name}”，清除保存的秘密，并立即停止所有关联主机使用该凭据的 SSH 连接与待执行计划。`,`Revoke “${revoking.name}”, clear its stored secret, and immediately stop SSH connections and pending plans using it on associated hosts.`)}</p><p>{t(`关联 ${revoking.hosts.length} 台主机：`,`Associated hosts (${revoking.hosts.length}):`)} {revoking.hosts.map(host=>host.name).join('、')||t('无','None')}</p><p>{t('如果只想取消某台主机使用，请在该主机详情中解绑。','To stop using it on only one host, unlink it in that host’s details.')}</p></>}
   {actionError&&<Alert type="error" showIcon title={actionError}/>}
  </Modal>
 </div>;
}
