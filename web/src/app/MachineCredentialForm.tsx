import {Alert,Button,Form,Input,Select} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import type {FormInstance} from 'antd';
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {api} from '../shared/api';
import {availableConnectionCredential,type ConnectionCredential} from './connection-credentials';

export type CredentialValues={method:string;name?:string;credential_name?:string;credential_source?:'new'|'existing';connection_credential_id?:string;secret?:string};
export const credentialInitialValues={method:'password',credential_source:'new'};
export function credentialPayload(values:CredentialValues){
 if(values.credential_source==='existing')return {connection_credential_id:values.connection_credential_id};
 const name=values.credential_name?.trim()||values.name?.trim();
 const base={method:values.method,secret:values.secret,...(name?{name}:{})};
 return {...base,retention:'permanent'};
}
export function clearCredentialSecrets(form:FormInstance,changed:Record<string,unknown>){
 if(Object.hasOwn(changed,'credential_source'))form.setFieldsValue({secret:undefined,connection_credential_id:undefined});
 else if(Object.hasOwn(changed,'method'))form.setFieldsValue({secret:undefined});
}
export function MachineCredentialFields({nameRequired=false,nameField='name'}:{nameRequired?:boolean;nameField?:string}){
 const {t}=useI18n();
 return <>
  <Form.Item label={t('凭据名称','Credential name')} name={nameField} rules={[{required:nameRequired,message:t('请输入凭据名称','Enter a credential name')},{max:128}]}><Input autoComplete="off" placeholder={t('例如：生产主机运维私钥','Example: Production operations key')}/></Form.Item>
  <Form.Item label={t('登录方式','Login method')} name="method" rules={[{required:true}]}><Select options={[{value:'password',label:t('SSH 密码','SSH password')},{value:'ssh_key',label:t('SSH 私钥','SSH private key')}]}/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.method!==b.method}>{({getFieldValue})=><Form.Item label={getFieldValue('method')==='ssh_key'?t('SSH 私钥','SSH private key'):t('SSH 密码','SSH password')} name="secret" preserve={false} rules={[{required:true,message:t('请输入登录密码或私钥','Enter the login password or private key')}]} extra={t('加密永久保存，保存后不会回显；用于 SSH 检查和主机操作，可随时撤销。','Encrypted and stored without an expiry, never displayed again. Used for SSH checks and host operations; revoke it at any time.')}>
   {getFieldValue('method')==='ssh_key'?<Input.TextArea autoComplete="off" rows={4} placeholder={t('SSH 私钥内容','SSH private key content')}/>:<Input.Password autoComplete="new-password" visibilityToggle={false} placeholder={t('输入 SSH 密码','Enter SSH password')}/>}
  </Form.Item>}</Form.Item>
  <p>{t('凭据将加密永久保存，直到管理员撤销或解绑。','The credential is encrypted and stored without an expiry until an administrator revokes or unlinks it.')}</p>
 </>;
}
export function HostCredentialFields(){
 const {t,language}=useI18n(),[items,setItems]=useState<ConnectionCredential[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');void api<ConnectionCredential[]>('/connection-credentials',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setItems(value)}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:t('凭据加载失败','Could not load credentials'))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[revision]);
 return <>
  <Form.Item name="credential_source" label={t('凭据来源','Credential source')}><Select options={[{value:'new',label:t('手动填写并保存新凭据','Enter and save a new credential')},{value:'existing',label:t('选择已有凭据','Choose an existing credential')}]}/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.credential_source!==b.credential_source}>{({getFieldValue})=>getFieldValue('credential_source')==='existing'?<>
   <Form.Item name="connection_credential_id" label={t('已有连接凭据','Existing connection credential')} preserve={false} rules={[{required:true,message:t('请选择连接凭据','Select a connection credential')}]} extra={<Link to="/connection-credentials">{t('管理连接凭据','Manage connection credentials')}</Link>}><Select loading={loading} showSearch optionFilterProp="label" placeholder={t('选择有效私钥或密码','Choose an active key or password')} options={items.filter(item=>availableConnectionCredential(item)).map(item=>({value:item.id,label:`${item.name} · ${item.method==='ssh_key'?t('SSH 私钥','SSH private key'):t('SSH 密码','SSH password')} · ${item.secret_fingerprint||item.id} · ${item.retention==='permanent'?t('永久','Permanent'):new Date(item.expires_at).toLocaleString(language)}`}))}/></Form.Item>
   {error&&<Alert type="error" title={error} action={<Button size="small" onClick={()=>setRevision(v=>v+1)}>{t('重试','Retry')}</Button>}/>}
  </>:<MachineCredentialFields nameField="credential_name"/>}</Form.Item>
 </>;
}
export default function MachineCredentialForm({form,busy,error,onFinish,submitLabel}:{form:FormInstance;busy:boolean;error:string;onFinish:(values:ReturnType<typeof credentialPayload>)=>void;submitLabel?:string}){
 const {t}=useI18n();
 return <Form name="host-credential" form={form} layout="vertical" onFinish={values=>onFinish(credentialPayload(values))} disabled={busy} initialValues={credentialInitialValues} onValuesChange={changed=>clearCredentialSecrets(form,changed)}>
  <HostCredentialFields/>
  {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}<Button type="primary" aria-label={submitLabel||t('保存凭据','Save credential')} htmlType="submit" loading={busy} block>{submitLabel||t('保存凭据','Save credential')}</Button>
 </Form>;
}
