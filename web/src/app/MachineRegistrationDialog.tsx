import {useRef,useState} from 'react';
import {Alert,Button,Form,Input,InputNumber,Modal,Space,Typography} from '../shared/ui';
import {api,ApiError} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {HostCredentialFields,clearCredentialSecrets,credentialInitialValues,credentialPayload} from './MachineCredentialForm';

type Account={id:string;machine_id:string;username:string;revision:number};
type Host={id:string;name:string;capabilities?:{ssh_check?:{available:boolean};deploy_agent?:{available:boolean}}};
export default function MachineRegistrationDialog({onClose,onChanged,onCheck,onPlan}:{onClose:()=>void;onChanged:()=>Promise<void>;onCheck:(id:string)=>void;onPlan:(id:string,name:string)=>void}){
 const {t,language}=useI18n(),[form]=Form.useForm(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[host,setHost]=useState<Host>(),[complete,setComplete]=useState(false),[savedCredential,setSavedCredential]=useState<{retention:string;expires_at:string;reused?:boolean}>();
 const [unknown,setUnknown]=useState<'host'|'account'|'default'|'credential'|''>('');
 const pending=useRef(false),registered=useRef<Host|undefined>(undefined),registeredAccount=useRef<Account|undefined>(undefined);
 const save=async(values:any,withCredential=true)=>{
  if(pending.current||unknown)return;pending.current=true;setBusy(true);setError('');let stage:'host'|'account'|'default'|'credential'|''='';
  try{
   let target=registered.current;
   if(!target){stage='host';target=await api<Host>('/machines',{method:'POST',body:JSON.stringify({name:values.name,address:values.address,port:values.port,connection_method:'direct_ssh'})});if(typeof target.id!=='string'||!target.id)throw Error(t('主机登记回执不完整，请回读列表核对','Host registration receipt is incomplete. Read the host list to verify.'));stage='';registered.current=target;setHost(target);try{await onChanged()}catch{/* Saved asset is retained. */}}
   if(withCredential){
    let account=registeredAccount.current;
    if(!account){stage='account';account=await api<Account>(`/machines/${encodeURIComponent(target.id)}/accounts`,{method:'POST',body:JSON.stringify({username:values.username})});if(!account.id||account.machine_id!==target.id||account.username!==values.username||!Number.isSafeInteger(account.revision))throw Error(t('账户回执与登记信息不匹配','Account receipt does not match registration'));registeredAccount.current=account;stage=''}
    stage='default';await api(`/machines/${encodeURIComponent(target.id)}/default-account`,{method:'PUT',body:JSON.stringify({account_id:account.id})});stage='credential';
    const saved=await api<{retention:string;expires_at:string;reused?:boolean;account_id:string;username:string;account_revision:number}>(`/machines/${encodeURIComponent(target.id)}/accounts/${encodeURIComponent(account.id)}/credentials`,{method:'POST',body:JSON.stringify({...credentialPayload(values),make_default:true})});if(saved.account_id!==account.id||saved.username!==account.username||saved.account_revision!==account.revision)throw Error(t('凭据回执与登录账户不匹配','Credential receipt does not match login account'));stage='';setSavedCredential(saved)
   }
   form.setFieldsValue({secret:undefined,confirm_permanent:false});
   if(!withCredential){onClose();return}
   setComplete(true);try{const fresh=await api<{machine:Host}>(`/machines/${encodeURIComponent(target.id)}`);if(fresh.machine.id===target.id)setHost(fresh.machine)}catch{/* The save succeeded; refreshing capabilities can be retried from the list. */}try{await onChanged()}catch{/* Save succeeded; the list can refresh later. */};
  }catch(e){if(stage&&!(e instanceof ApiError&&e.status<500)){setUnknown(stage);form.setFieldsValue({secret:undefined,confirm_permanent:false})}setError(e instanceof Error?e.message:t('保存失败','Save failed'))}finally{pending.current=false;setBusy(false)}
 };
 const registerOnly=async()=>{try{await save(await form.validateFields(['name','address','port']),false)}catch{/* Inline host field validation explains what is missing. */}};
 const close=()=>{if(pending.current)return;form.resetFields();onClose()};
 return <Modal open className="lm-machine-credential-dialog" style={{top:24}} title={t('登记主机','Register host')} onCancel={close} closable={!busy} maskClosable={false} keyboard={!busy} footer={null} width={640} destroyOnHidden>
  {unknown?<><Alert showIcon type="warning" title={unknown==='host'?t('主机登记结果未知','Host registration outcome unknown'):unknown==='account'||unknown==='default'?t('账户保存结果未知','Account save outcome unknown'):t('凭据保存结果未知','Credential save outcome unknown')} description={t('服务器可能已经保存。请返回列表刷新并核查记录后再操作；本窗口禁止重复保存。','The server may have saved the record. Return to the list, refresh, and verify it before continuing. This window blocks another save.')}/>{error&&<Alert type="error" title={error} className="lm-machine-form-notice"/>}<Button block className="lm-machine-form-notice" onClick={()=>{close();void onChanged()}}>{t('返回主机列表并刷新','Back to hosts and refresh')}</Button></>:!complete?<Form name="host-registration" form={form} layout="vertical" onFinish={values=>void save(values)} disabled={busy} initialValues={{port:22,username:'root',...credentialInitialValues}} onValuesChange={changed=>clearCredentialSecrets(form,changed)}>
   {host&&<Alert showIcon type="info" className="lm-machine-form-notice" title={t(`主机“${host.name}”已登记`,`Host “${host.name}” registered`)} description={t('主机记录已保存。请继续保存登录账户与凭据，不会重复登记主机；也可关闭后稍后配置。','The host record is saved. Retry credential saving without creating another host, or close and configure later.')}/>}
   <Form.Item label={t('主机名称（用户自定义）','Host name (user-defined)')} name="name" rules={[{required:true,message:t('请输入主机名称','Enter a host name')},{validator:(_,value)=>typeof value==='string'&&(/\p{Cc}/u.test(value)||new TextEncoder().encode(value).length>128)?Promise.reject(new Error(t('名称不能包含控制字符，且最多 128 字节','Names cannot contain control characters and must fit within 128 bytes'))):Promise.resolve()}]}><Input disabled={busy||!!host} placeholder={t('例如：生产订单主机','Example: Production order host')}/></Form.Item>
   <Form.Item label={t('SSH 连接地址','SSH connection address')} name="address" extra={t('填写平台能访问的 IP 或域名，支持内网地址。','Enter an IP address or hostname reachable from the platform, including private addresses.')} rules={[{required:true,message:t('请输入平台可访问的 IP 或域名','Enter an IP address or hostname reachable from the platform')}]}><Input disabled={busy||!!host} placeholder={t('host.example.com 或 10.0.0.12','host.example.com or 10.0.0.12')}/></Form.Item>
   <Space.Compact block><Form.Item label={t('SSH 端口','SSH port')} name="port" rules={[{required:true}]} style={{width:'35%'}}><InputNumber disabled={busy||!!host} min={1} max={65535} style={{width:'100%'}}/></Form.Item><Form.Item label={t('登录用户名','Login username')} name="username" rules={[{required:true}]} style={{width:'65%'}} extra={t('安装维护推荐使用 root，也支持具备免交互系统管理 sudo 权限的账号。SSH 登录账号不决定 Agent 或脚本的运行身份。','For installation and maintenance, root is recommended; accounts with non-interactive system-administration sudo also work. The SSH login account does not determine the identity used by Agent or scripts.')}><Input disabled={busy||!!registeredAccount.current} placeholder={t('root（推荐）或运维账号','root (recommended) or an administration account')}/></Form.Item></Space.Compact>
   <HostCredentialFields/>
   {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}
   <Button type="primary" aria-label={host?t('重试保存凭据','Retry saving credential'):t('登记并保存凭据','Register and save credential')} htmlType="submit" loading={busy} block>{host?t('重试保存凭据','Retry saving credential'):t('登记并保存凭据','Register and save credential')}</Button>
   <Button block className="lm-machine-onboarding-later" disabled={busy} onClick={()=>void registerOnly()}>{host?t('稍后配置凭据','Configure credentials later'):t('仅登记，稍后配置凭据','Register only; configure credentials later')}</Button>
  </Form>:<>
   <Alert showIcon type="success" className="lm-machine-form-notice" title={t('主机与凭据已保存','Host and credential saved')} description={t('下一步可执行只读 SSH 预检，或生成 Agent 安装计划。生成计划不会安装程序；仍需审阅并确认执行。','Next, run read-only SSH preflight or create an Agent installation plan. Creating a plan does not install software; review and execution confirmation are still required.')}/>
   {savedCredential&&<Typography.Paragraph>{savedCredential.reused&&t('已复用已有私钥。','Existing private key reused. ')}{savedCredential.retention==='permanent'?t('本主机授权：永久','Host authorization: permanent'):t('本主机授权有效至：','Host authorization expires at: ')+new Date(savedCredential.expires_at).toLocaleString(language)}</Typography.Paragraph>}
   <Space wrap><Button disabled={!host?.capabilities?.ssh_check?.available} onClick={()=>{if(host){close();onCheck(host.id)}}}>{t('SSH 安装检查','SSH preflight')}</Button><Button type="primary" disabled={!host?.capabilities?.deploy_agent?.available} onClick={()=>{if(host){close();onPlan(host.id,host.name)}}}>{t('生成 Agent 安装计划','Create Agent installation plan')}</Button><Button onClick={close}>{t('返回主机列表','Back to hosts')}</Button></Space>
  </>}
 </Modal>;
}
