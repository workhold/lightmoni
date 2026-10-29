import {useRef,useState} from 'react';
import {Alert,Button,Form,Input,InputNumber,Modal,Space} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {MachineCredentialFields,clearCredentialSecrets,credentialInitialValues,credentialPayload} from './MachineCredentialForm';

type Host={id:string;name:string;capabilities?:{ssh_check?:{available:boolean};deploy_agent?:{available:boolean}}};
export default function MachineRegistrationDialog({onClose,onChanged,onCheck,onPlan}:{onClose:()=>void;onChanged:()=>Promise<void>;onCheck:(id:string)=>void;onPlan:(id:string)=>void}){
 const {t}=useI18n(),[form]=Form.useForm(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[host,setHost]=useState<Host>(),[complete,setComplete]=useState(false);
 const pending=useRef(false),registered=useRef<Host|undefined>(undefined);
 const save=async(values:any,withCredential=true)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{
   let target=registered.current;
   if(!target){target=await api<Host>('/machines',{method:'POST',body:JSON.stringify({name:values.name,address:values.address,port:values.port,username:values.username,connection_method:'direct_ssh'})});registered.current=target;setHost(target);await onChanged()}
   if(withCredential)await api(`/machines/${encodeURIComponent(target.id)}/credentials`,{method:'POST',body:JSON.stringify(credentialPayload(values))});
   form.setFieldsValue({secret:undefined,confirm_permanent:false});
   if(!withCredential){onClose();return}
   setComplete(true);try{const fresh=await api<{machine:Host}>(`/machines/${encodeURIComponent(target.id)}`);setHost(fresh.machine)}catch{/* The save succeeded; refreshing capabilities can be retried from the list. */}await onChanged();
  }catch(e){setError(e instanceof Error?e.message:t('保存失败','Save failed'))}finally{pending.current=false;setBusy(false)}
 };
 const registerOnly=async()=>{try{await save(await form.validateFields(['name','address','port','username']),false)}catch{/* Inline host field validation explains what is missing. */}};
 const close=()=>{if(pending.current)return;form.resetFields();onClose()};
 return <Modal open className="lm-machine-credential-dialog" style={{top:24}} title={t('登记主机','Register host')} onCancel={close} closable={!busy} maskClosable={false} keyboard={!busy} footer={null} width={640} destroyOnHidden>
  {!complete?<Form name="host-registration" form={form} layout="vertical" onFinish={values=>void save(values)} disabled={busy} initialValues={{port:22,...credentialInitialValues}} onValuesChange={changed=>clearCredentialSecrets(form,changed)}>
   {host&&<Alert showIcon type="info" className="lm-machine-form-notice" title={t(`主机“${host.name}”已登记`,`Host “${host.name}” registered`)} description={t('主机记录已保存。请重试保存凭据，不会重复登记；也可关闭后稍后配置。','The host record is saved. Retry credential saving without creating another host, or close and configure later.')}/>}
   <Form.Item label={t('主机名称','Host name')} name="name" rules={[{required:true,message:t('请输入主机名称','Enter a host name')},{validator:(_,value)=>typeof value==='string'&&(/\p{Cc}/u.test(value)||new TextEncoder().encode(value).length>128)?Promise.reject(new Error(t('名称不能包含控制字符，且最多 128 字节','Names cannot contain control characters and must fit within 128 bytes'))):Promise.resolve()}]}><Input disabled={busy||!!host} placeholder={t('例如：生产订单主机','Example: Production order host')}/></Form.Item>
   <Form.Item label={t('地址','Address')} name="address" rules={[{required:true,message:t('请输入主机名或 IP','Enter a hostname or IP')}]}><Input disabled={busy||!!host} placeholder={t('host.example.com 或 10.0.0.12','host.example.com or 10.0.0.12')}/></Form.Item>
   <Space.Compact block><Form.Item label={t('SSH 端口','SSH port')} name="port" rules={[{required:true}]} style={{width:'35%'}}><InputNumber disabled={busy||!!host} min={1} max={65535} style={{width:'100%'}}/></Form.Item><Form.Item label={t('登录用户名','Login username')} name="username" rules={[{required:true}]} style={{width:'65%'}}><Input disabled={busy||!!host} placeholder={t('例如：deploy','Example: deploy')}/></Form.Item></Space.Compact>
   <MachineCredentialFields/>
   {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}
   <Button type="primary" aria-label={host?t('重试保存凭据','Retry saving credential'):t('登记并保存凭据','Register and save credential')} htmlType="submit" loading={busy} block>{host?t('重试保存凭据','Retry saving credential'):t('登记并保存凭据','Register and save credential')}</Button>
   <Button block className="lm-machine-onboarding-later" disabled={busy} onClick={()=>void registerOnly()}>{host?t('稍后配置凭据','Configure credentials later'):t('仅登记，稍后配置凭据','Register only; configure credentials later')}</Button>
  </Form>:<>
   <Alert showIcon type="success" className="lm-machine-form-notice" title={t('主机与凭据已保存','Host and credential saved')} description={t('下一步可执行只读 SSH 预检，或生成 Agent 安装计划。生成计划不会安装程序；仍需审阅并确认执行。','Next, run read-only SSH preflight or create an Agent installation plan. Creating a plan does not install software; review and execution confirmation are still required.')}/>
   <Space wrap><Button disabled={!host?.capabilities?.ssh_check?.available} onClick={()=>{if(host){close();onCheck(host.id)}}}>{t('SSH 安装检查','SSH preflight')}</Button><Button type="primary" disabled={!host?.capabilities?.deploy_agent?.available} onClick={()=>{if(host){close();onPlan(host.id)}}}>{t('生成 Agent 安装计划','Create Agent installation plan')}</Button><Button onClick={close}>{t('返回主机列表','Back to hosts')}</Button></Space>
  </>}
 </Modal>;
}
