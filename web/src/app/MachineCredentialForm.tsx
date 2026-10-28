import {Alert,Button,Checkbox,Form,Input,InputNumber,Select} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import type {FormInstance} from 'antd';

type Values={method:string;retention:string;secret?:string;expires_in_seconds?:number;confirm_managed?:boolean};
export default function MachineCredentialForm({form,busy,error,onFinish}:{form:FormInstance;busy:boolean;error:string;onFinish:(values:Values)=>void}){
 const {t}=useI18n();
 return <>
  <Alert type="info" showIcon title={t('SSH 用于首次接入和故障恢复','SSH is for enrollment and recovery')} description={t('私钥默认临时保留 1 小时，密码默认 15 分钟且使用后清除。到期、撤销或 Agent 激活后会清除临时秘密；日常管理优先使用 Agent。需要长期 SSH 恢复通道时，请主动选择托管。','Private keys are temporary for 1 hour by default. Passwords expire after 15 minutes and are cleared after use. Temporary secrets are cleared on expiry, revocation, or Agent activation. Prefer Agent for daily management; explicitly choose managed storage for long-term SSH recovery.')} className="lm-machine-form-notice"/>
  <Form form={form} layout="vertical" onFinish={onFinish} disabled={busy} initialValues={{method:'ssh_key',retention:'temporary'}} onValuesChange={changed=>{
   if(Object.hasOwn(changed,'method'))form.setFieldsValue({secret:undefined,expires_in_seconds:undefined,confirm_managed:false,retention:changed.method==='password'?'one_time':changed.method==='manual_script'?'none':'temporary'});
   else if(Object.hasOwn(changed,'retention'))form.setFieldsValue({secret:undefined,expires_in_seconds:undefined,confirm_managed:false});
  }}>
   <Form.Item label={t('凭据类型','Credential type')} name="method"><Select options={[{value:'ssh_key',label:t('SSH 私钥（推荐）','SSH private key (recommended)')},{value:'password',label:t('密码（仅一次性使用）','Password (single use only)')},{value:'manual_script',label:t('手动脚本（不保存秘密）','Manual script (no secret stored)')}]}/></Form.Item>
   <Form.Item noStyle shouldUpdate={(a,b)=>a.method!==b.method||a.retention!==b.retention}>{({getFieldValue})=>{
    const method=getFieldValue('method'),managed=getFieldValue('retention')==='managed';
    return <>
     {method==='ssh_key'?<Form.Item label={t('保留策略','Retention policy')} name="retention"><Select options={[{value:'temporary',label:t('临时接入（默认 1 小时）','Temporary enrollment (1 hour by default)')},{value:'managed',label:t('长期托管（默认 90 天）','Managed storage (90 days by default)')}]}/></Form.Item>:<Form.Item name="retention" hidden><Input/></Form.Item>}
     {method==='manual_script'?<Alert type="info" showIcon title={t('此方式不保存 SSH 密码或私钥','This method stores no SSH password or private key')} description={t('请在目标主机执行节点助手提供的 enrollment 安装脚本。手动脚本凭据不提供 SSH 登录、安装检查或自动部署能力。','Run the enrollment installation script from Node assistant on the target host. Manual-script records do not enable SSH login, preflight, or automatic deployment.')} className="lm-machine-form-notice"/>:<>
      {managed&&<><Alert type="warning" showIcon title={t('长期托管会在平台保存此主机的 SSH 私钥','Managed storage keeps this host’s SSH private key in the platform')} description={t('仅在需要持续 SSH 故障恢复时使用。建议每台主机使用独立私钥，并在替换后撤销旧凭据；Agent 激活不会清除此托管私钥。','Use only when ongoing SSH recovery is needed. Use a separate key per host and revoke old credentials after rotation. Agent activation does not clear this managed key.')} className="lm-machine-form-notice"/><Form.Item name="confirm_managed" valuePropName="checked" preserve={false} rules={[{validator:(_,value)=>value?Promise.resolve():Promise.reject(new Error(t('请确认长期托管后继续','Confirm managed storage to continue')))}]}><Checkbox>{t('我确认长期托管此私钥，用于此主机的 SSH 恢复','I confirm managed storage of this key for this host’s SSH recovery')}</Checkbox></Form.Item></>}
      <Form.Item label={t('秘密内容','Secret')} name="secret" preserve={false} rules={[{required:true,message:t('请输入连接秘密','Enter the connection secret')}]} extra={t('秘密不会回显；撤销、到期或使用结束后按策略清除当前保存的密文。','Secrets are never shown again. Stored ciphertext is cleared according to policy on revocation, expiry, or completion.')}>{method==='password'?<Input.Password autoComplete="new-password" visibilityToggle={false} placeholder={t('输入一次性 SSH 密码','Enter a one-time SSH password')}/>:<Input.TextArea autoComplete="off" rows={7} placeholder={t('SSH 私钥内容','SSH private key')}/>}</Form.Item>
      <Form.Item label={t('有效秒数','Validity in seconds')} name="expires_in_seconds" preserve={false} rules={[{type:'number',min:60,max:managed?31536000:3600,message:t(managed?'请输入 60 至 31536000 秒':'请输入 60 至 3600 秒',managed?'Enter 60 to 31536000 seconds':'Enter 60 to 3600 seconds')}]} extra={method==='password'?t('默认 900 秒（15 分钟），最长 3600 秒；一次检查或终端结束后即清除。','Defaults to 900 seconds (15 minutes), up to 3600 seconds. Cleared after one preflight or terminal session.'):managed?t('默认 7776000 秒（90 天），最长 31536000 秒（365 天）。','Defaults to 7776000 seconds (90 days), up to 31536000 seconds (365 days).'):t('默认及最长 3600 秒（1 小时）；Agent 激活后清除临时私钥。','Defaults to and is limited to 3600 seconds (1 hour). Cleared after Agent activation.')}><InputNumber min={60} max={managed?31536000:3600} style={{width:'100%'}} placeholder={t('留空使用默认值','Leave blank to use the default')}/></Form.Item>
     </>}
    </>;
   }}</Form.Item>
   {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}<Button type="primary" htmlType="submit" loading={busy} block>{t('保存凭据','Save credential')}</Button>
  </Form>
 </>;
}
