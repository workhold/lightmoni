import {Alert,Button,Checkbox,Form,Input,InputNumber,Select} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import type {FormInstance} from 'antd';

type Values={method:string;retention:string;secret?:string;expires_in_seconds?:number;confirm_managed?:boolean};
export default function MachineCredentialForm({form,busy,error,onFinish,submitLabel}:{form:FormInstance;busy:boolean;error:string;onFinish:(values:Values)=>void;submitLabel?:string}){
 const {t}=useI18n();
 return <>
  <Alert type="info" showIcon title={t('建议短期保存 SSH 凭据','Prefer short-lived SSH credentials')} description={t('SSH 用于首次接入和故障恢复，日常管理优先使用 Agent。临时凭据到期或 Agent 激活后清除；按期限托管仅在到期或撤销时清除，需要主动确认。秘密加密保存且不回显。','Use SSH for enrollment and recovery; prefer Agent for daily operations. Temporary credentials are cleared on expiry or Agent activation. Managed credentials remain until expiry or revocation and require explicit confirmation. Secrets are encrypted and never displayed again.')} className="lm-machine-form-notice"/>
  <Form form={form} layout="vertical" onFinish={onFinish} disabled={busy} initialValues={{method:'ssh_key',retention:'temporary'}} onValuesChange={changed=>{
   if(Object.hasOwn(changed,'method'))form.setFieldsValue({secret:undefined,expires_in_seconds:undefined,confirm_managed:false,retention:changed.method==='manual_script'?'none':'temporary'});
   else if(Object.hasOwn(changed,'retention'))form.setFieldsValue({secret:undefined,expires_in_seconds:undefined,confirm_managed:false});
  }}>
   <Form.Item label={t('凭据类型','Credential type')} name="method"><Select options={[{value:'ssh_key',label:t('SSH 私钥（推荐）','SSH private key (recommended)')},{value:'password',label:t('SSH 密码','SSH password')},{value:'manual_script',label:t('不保存凭据（稍后配置）','No credential (configure later)')}]}/></Form.Item>
   <Form.Item noStyle shouldUpdate={(a,b)=>a.method!==b.method||a.retention!==b.retention}>{({getFieldValue})=>{
    const method=getFieldValue('method'),retention=getFieldValue('retention'),managed=retention==='managed',oneTime=retention==='one_time',password=method==='password';
    return <>
     {method!=='manual_script'?<Form.Item label={t('保留策略','Retention policy')} name="retention"><Select options={[
      ...(password?[{value:'one_time',label:t('一次性使用（默认 15 分钟）','Single use (15 minutes by default)')}]:[]),
      {value:'temporary',label:password?t('临时接入（默认 15 分钟，可复用）','Temporary enrollment (15 minutes, reusable)'):t('临时接入（默认 1 小时）','Temporary enrollment (1 hour by default)')},
      {value:'managed',label:password?t('按期限托管（默认 1 天）','Managed storage (1 day by default)'):t('按期限托管（默认 90 天）','Managed storage (90 days by default)')},
     ]}/></Form.Item>:<Form.Item name="retention" hidden><Input/></Form.Item>}
     {method==='manual_script'?<Alert type="info" showIcon title={t('主机记录会保留，不保存连接秘密','Keep the host record without connection secrets')} description={t('可稍后在主机列表添加凭据。未配置有效凭据和确认主机指纹前，不能使用 SSH 检查、自动部署或卸载。','Add credentials later from the host list. SSH checks, automatic installation, and removal require an active credential and a verified host fingerprint.')} className="lm-machine-form-notice"/>:<>
      {managed&&<><Alert type="warning" showIcon title={t('按期限托管会在平台保留此 SSH 凭据','Managed storage retains this SSH credential in the platform')} description={t('建议不要长期保存；仅在持续 SSH 故障恢复时使用，最长 365 天。Agent 激活不会提前清除此托管凭据，请按需轮换或撤销。','Avoid long-term storage. Use only for ongoing SSH recovery, for at most 365 days. Agent activation does not clear managed credentials early. Rotate or revoke them when no longer needed.')} className="lm-machine-form-notice"/><Form.Item name="confirm_managed" valuePropName="checked" preserve={false} rules={[{validator:(_,value)=>value?Promise.resolve():Promise.reject(new Error(t('请确认按期限托管后继续','Confirm managed storage to continue')))}]}><Checkbox>{t('我确认在所选有效期内托管此 SSH 凭据','I confirm storing this SSH credential for the selected validity period')}</Checkbox></Form.Item></>}
      {password&&<Alert type="info" showIcon className="lm-machine-form-notice" title={oneTime?t('一次性密码不能用于自动安装或卸载','Single-use passwords cannot install or uninstall Agent'):t('有效期内可复用此密码进行检查、安装或卸载','Reuse this password for checks, installation, or removal during its validity')} description={oneTime?t('一次检查或终端结束后即清除。需要检查后继续安装 Agent，请选择临时接入或按期限托管。','Cleared after one check or terminal session. Choose temporary or managed storage to install Agent after preflight.'):managed?t('Agent 激活后仍保留至到期或撤销；不建议长期保存。','Retained after Agent activation until expiry or revocation. Avoid long-term storage.'):t('默认 15 分钟，最长 1 小时；到期、撤销或 Agent 激活后清除。','Defaults to 15 minutes, up to 1 hour. Cleared on expiry, revocation, or Agent activation.')}/>}
      <Form.Item label={t('秘密内容','Secret')} name="secret" preserve={false} rules={[{required:true,message:t('请输入连接秘密','Enter the connection secret')}]} extra={t('秘密不会回显，请确保保存前已核对目标主机和保留策略。','Secrets cannot be viewed again. Check the target host and retention policy before saving.')}>{password?<Input.Password autoComplete="new-password" visibilityToggle={false} placeholder={t('输入 SSH 密码','Enter SSH password')}/>:<Input.TextArea autoComplete="off" rows={5} placeholder={t('SSH 私钥内容','SSH private key')}/>}</Form.Item>
      <Form.Item label={t('有效秒数','Validity in seconds')} name="expires_in_seconds" preserve={false} rules={[{type:'number',min:60,max:managed?31536000:3600,message:t(managed?'请输入 60 至 31536000 秒':'请输入 60 至 3600 秒',managed?'Enter 60 to 31536000 seconds':'Enter 60 to 3600 seconds')}]} extra={managed?password?t('默认 86400 秒（1 天），最长 31536000 秒（365 天）。','Defaults to 86400 seconds (1 day), up to 31536000 seconds (365 days).'):t('默认 7776000 秒（90 天），最长 31536000 秒（365 天）。','Defaults to 7776000 seconds (90 days), up to 31536000 seconds (365 days).'):password?t('默认 900 秒（15 分钟），最长 3600 秒（1 小时）。','Defaults to 900 seconds (15 minutes), up to 3600 seconds (1 hour).'):t('默认及最长 3600 秒（1 小时）。','Defaults to and is limited to 3600 seconds (1 hour).')}><InputNumber min={60} max={managed?31536000:3600} style={{width:'100%'}} placeholder={t('留空使用默认值','Leave blank to use the default')}/></Form.Item>
     </>}
    </>;
   }}</Form.Item>
   {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}<Button type="primary" aria-label={submitLabel||t('保存凭据','Save credential')} htmlType="submit" loading={busy} block>{submitLabel||t('保存凭据','Save credential')}</Button>
  </Form>
 </>;
}
