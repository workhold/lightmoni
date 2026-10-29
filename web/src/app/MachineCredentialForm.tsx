import {Alert,Button,Checkbox,Form,Input,InputNumber,Select} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import type {FormInstance} from 'antd';

export type CredentialValues={method:string;duration?:number|'custom'|'permanent';secret?:string;expires_in_seconds?:number;confirm_permanent?:boolean};
export const credentialInitialValues={method:'password',duration:21600};
export function credentialPayload(values:CredentialValues){
 const base={method:values.method,secret:values.secret};
 return values.duration==='permanent'?{...base,retention:'permanent',confirm_permanent:values.confirm_permanent===true}:{...base,retention:'managed',confirm_managed:true,expires_in_seconds:values.duration==='custom'?values.expires_in_seconds:values.duration||21600};
}
export function clearCredentialSecrets(form:FormInstance,changed:Record<string,unknown>){
 if(Object.hasOwn(changed,'method'))form.setFieldsValue({secret:undefined,expires_in_seconds:undefined,confirm_permanent:false});
 else if(Object.hasOwn(changed,'duration'))form.setFieldsValue({expires_in_seconds:undefined,confirm_permanent:false});
}
export function MachineCredentialFields(){
 const {t}=useI18n();
 return <>
  <Form.Item label={t('登录方式','Login method')} name="method" rules={[{required:true}]}><Select options={[{value:'password',label:t('SSH 密码','SSH password')},{value:'ssh_key',label:t('SSH 私钥','SSH private key')}]}/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.method!==b.method}>{({getFieldValue})=><Form.Item label={getFieldValue('method')==='ssh_key'?t('SSH 私钥','SSH private key'):t('SSH 密码','SSH password')} name="secret" preserve={false} rules={[{required:true,message:t('请输入登录密码或私钥','Enter the login password or private key')}]} extra={t('加密保存，保存后不会回显；用于 SSH 检查、安装和故障恢复。','Encrypted and never displayed again. Used for SSH preflight, installation, and recovery.')}>
   {getFieldValue('method')==='ssh_key'?<Input.TextArea autoComplete="off" rows={4} placeholder={t('SSH 私钥内容','SSH private key content')}/>:<Input.Password autoComplete="new-password" visibilityToggle={false} placeholder={t('输入 SSH 密码','Enter SSH password')}/>}
  </Form.Item>}</Form.Item>
  <Form.Item label={t('保存时长','Storage duration')} name="duration" rules={[{required:true}]} extra={t('仅作用于登录密码或私钥，默认 6 小时。主机 ID、名称与公钥指纹随主机记录保留。','Applies only to the login password or private key; defaults to 6 hours. Host ID, name, and public-key fingerprint stay with the host record.')}><Select options={[{value:21600,label:t('6 小时（默认）','6 hours (default)')},{value:86400,label:t('1 天','1 day')},{value:604800,label:t('7 天','7 days')},{value:2592000,label:t('30 天','30 days')},{value:'custom',label:t('自定义','Custom')},{value:'permanent',label:t('永久','Permanent')}]}/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.duration!==b.duration}>{({getFieldValue})=>getFieldValue('duration')==='custom'?<Form.Item label={t('有效秒数','Validity in seconds')} name="expires_in_seconds" preserve={false} rules={[{required:true,message:t('请输入保存时长','Enter a storage duration')},{type:'number',min:60,max:31536000,message:t('请输入 60 至 31536000 秒','Enter 60 to 31536000 seconds')}]} extra={t('60 秒至 365 天。到期或撤销后清除秘密。','60 seconds to 365 days. Secrets are cleared on expiry or revocation.')}><InputNumber min={60} max={31536000} precision={0} style={{width:'100%'}}/></Form.Item>:getFieldValue('duration')==='permanent'?<>
   <Form.Item name="confirm_permanent" valuePropName="checked" preserve={false} rules={[{validator:(_,value)=>value?Promise.resolve():Promise.reject(new Error(t('请确认永久保存后继续','Confirm permanent storage to continue')))}]}><Checkbox>{t('我确认永久保存此登录凭据','I confirm permanent storage of this login credential')}</Checkbox></Form.Item>
  </>:null}</Form.Item>
 </>;
}
export default function MachineCredentialForm({form,busy,error,onFinish,submitLabel}:{form:FormInstance;busy:boolean;error:string;onFinish:(values:ReturnType<typeof credentialPayload>)=>void;submitLabel?:string}){
 const {t}=useI18n();
 return <Form name="host-credential" form={form} layout="vertical" onFinish={values=>onFinish(credentialPayload(values))} disabled={busy} initialValues={credentialInitialValues} onValuesChange={changed=>clearCredentialSecrets(form,changed)}>
  <MachineCredentialFields/>
  {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}<Button type="primary" aria-label={submitLabel||t('保存凭据','Save credential')} htmlType="submit" loading={busy} block>{submitLabel||t('保存凭据','Save credential')}</Button>
 </Form>;
}
