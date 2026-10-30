import {useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Form,Input,InputNumber,Modal,Space,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {HostNetwork} from './HostNetworkSummary';

type Host={id:string;name:string;address:string;port:number;username:string;connection_method:string;observed_hostname?:string;network?:HostNetwork};
export default function MachineEditDialog({machine,onClose,onSaved}:{machine:Host;onClose:()=>void;onSaved:()=>Promise<void>}){
 const {t}=useI18n();
 const [configureSSH,setConfigureSSH]=useState(machine.connection_method==='direct_ssh'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false);
 return <Modal title={t(`编辑主机 · ${machine.name}`,`Edit host · ${machine.name}`)} open onCancel={()=>{if(!pending.current)onClose()}} closable={!busy} keyboard={!busy} maskClosable={false} footer={null} width={620} destroyOnHidden>
  <Descriptions size="small" column={1} items={[{key:'id',label:t('主机 ID（平台生成，不可修改）','Host ID (platform-generated, immutable)'),children:<Typography.Text code copyable={{text:machine.id}}>{machine.id}</Typography.Text>},...((machine.network?.hostname||machine.observed_hostname)?[{key:'observed',label:t('观测主机名','Observed hostname'),children:machine.network?.hostname||machine.observed_hostname}]:[])]}/>
  <Form layout="vertical" className="lm-machine-form-notice" disabled={busy} initialValues={{name:machine.name,address:machine.address,port:machine.port||22,username:machine.username}} onFinish={async values=>{
   if(pending.current)return;pending.current=true;setBusy(true);setError('');
   try{
    await api(`/machines/${encodeURIComponent(machine.id)}`,{method:'PUT',body:JSON.stringify(configureSSH?{...values,connection_method:'direct_ssh'}:{name:values.name})});
    await onSaved();onClose();
   }catch(e){setError(e instanceof Error?e.message:t('保存主机失败','Unable to save host'))}finally{pending.current=false;setBusy(false)}
  }}>
   <Form.Item label={t('主机名称','Host name')} name="name" rules={[{required:true,message:t('请输入主机名称','Enter a host name')},{validator:(_,value)=>typeof value==='string'&&(/\p{Cc}/u.test(value)||new TextEncoder().encode(value).length>128)?Promise.reject(new Error(t('名称不能包含控制字符，且最多 128 字节','Names cannot contain control characters and must fit within 128 bytes'))):Promise.resolve()}]}><Input/></Form.Item>
   <Checkbox checked={configureSSH} disabled={busy} onChange={event=>setConfigureSSH(event.target.checked)}>{t('配置 SSH 连接','Configure SSH connection')}</Checkbox>
   {configureSSH?<>
    <Alert className="lm-machine-form-notice" type="info" showIcon title={t('请核对 SSH 连接信息','Verify SSH connection details')} description={t('发现的主机名和网卡 IP 仅用于展示，不会自动替换 SSH 连接地址。保存不会连接或安装程序；随后可添加凭据。','Discovered hostnames and interface IPs are display metadata and do not replace the SSH connection address. Saving does not connect or install software. Add credentials afterward.')}/>
    <Form.Item label={t('SSH 连接地址','SSH connection address')} name="address" extra={t('填写平台能访问的 IP 或域名，支持内网地址。','Enter an IP address or hostname reachable from the platform, including private addresses.')} rules={[{required:true,message:t('请输入平台可访问的 IP 或域名','Enter an IP address or hostname reachable from the platform')}]}><Input placeholder="host.example.com"/></Form.Item>
    <Space.Compact block><Form.Item label={t('SSH 端口','SSH port')} name="port" rules={[{required:true}]} style={{width:'35%'}}><InputNumber min={1} max={65535} style={{width:'100%'}}/></Form.Item><Form.Item label={t('登录用户名','Login username')} name="username" rules={[{required:true}]} style={{width:'65%'}}><Input placeholder="deploy"/></Form.Item></Space.Compact>
   </>:<Typography.Paragraph type="secondary" className="lm-machine-form-notice">{t('仅保存名称，已有连接配置保持不变。主机名称不会被后续 Agent 心跳覆盖。','Only the name is saved. Existing connection settings are retained. Subsequent Agent heartbeats will keep your chosen name.')}</Typography.Paragraph>}
   {error&&<Alert type="error" showIcon title={error} className="lm-machine-form-notice"/>}
   <Button type="primary" htmlType="submit" loading={busy} block>{t('保存主机','Save host')}</Button>
  </Form>
 </Modal>;
}
