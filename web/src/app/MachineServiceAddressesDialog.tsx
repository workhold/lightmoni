import {useEffect,useRef,useState} from 'react';
import {Alert,App,Button,Form,Input,Modal,Select,Spin,Tag} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {ipAddressCategory} from './host-network-view';
import type {MachineServiceAddressSettings} from './machine-service-addresses';

export default function MachineServiceAddressesDialog({machineID,name,onClose,onSaved}:{machineID:string;name:string;onClose:()=>void;onSaved:()=>void}) {
  const {t}=useI18n(),{message}=App.useApp(),[form]=Form.useForm();
  const [snapshot,setSnapshot]=useState<MachineServiceAddressSettings>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),saving=useRef(false);
  useEffect(()=>{let current=true;generation.current++;setLoading(true);void api<MachineServiceAddressSettings>('/machines/'+encodeURIComponent(machineID)+'/service-addresses').then(value=>{if(current){setSnapshot(value);form.setFieldsValue({private:{mode:value.private.mode,address:value.private.address},public:{mode:value.public.mode,address:value.public.address}})}}).catch(e=>{if(current)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(current)setLoading(false)});return()=>{current=false;generation.current++}},[machineID,form]);
  const copy=(code:string)=>code==='machine_service_address_revision_conflict'?t('地址配置已被其他操作更新。当前输入已保留，请关闭后重新打开最新配置。','Address settings changed elsewhere. Your input is preserved. Close and reopen the latest settings.'):
    code==='machine_network_target_changed'?t('SSH 目标已变化。请核对主机后重新打开并确认地址。','The SSH target changed. Verify the host, then reopen and confirm the addresses.'):code;
  const save=async(values:any)=>{
    if(!snapshot||saving.current)return;saving.current=true;setBusy(true);setError('');const requestGeneration=generation.current;
    try{await api('/machines/'+encodeURIComponent(machineID)+'/service-addresses',{method:'PUT',body:JSON.stringify({revision:snapshot.revision,target_generation:snapshot.target_generation,...Object.fromEntries(['private','public'].map(scope=>[scope,{mode:values[scope].mode,address:values[scope].mode==='manual'?values[scope].address:''}]))})});
      if(requestGeneration!==generation.current)return;void message.success(t('内外网服务地址已保存','Private and public service addresses saved'));onSaved();onClose();
    }catch(e){if(requestGeneration!==generation.current)return;const code=e instanceof Error?e.message:String(e);if(code==='invalid_private_service_address'||code==='invalid_public_service_address'){const scope=code.includes('private')?'private':'public';form.setFields([{name:[scope,'address'],errors:[scope==='private'?t('请填写内网或共享范围的 IP，不含端口。','Enter a private or shared-range IP without a port.'):t('请填写普通公网范围的 IP，不含端口。','Enter a public-range IP without a port.')]}]);form.scrollToField([scope,'address'],{focus:true});}else setError(copy(code));
    }finally{if(requestGeneration===generation.current){saving.current=false;setBusy(false)}}
  };
  return <Modal open title={t('内外网服务地址','Private & public service addresses')+' · '+name} width={760} onCancel={()=>{if(!busy)onClose()}} className="lm-machine-address-dialog" footer={<div className="lm-ops-modal-actions"><Button disabled={busy} onClick={onClose}>{t('取消','Cancel')}</Button><Button type="primary" aria-label={t('保存服务地址','Save service addresses')} htmlType="submit" form="lm-machine-service-addresses" loading={busy} disabled={loading||!snapshot}>{t('保存服务地址','Save service addresses')}</Button></div>} styles={{body:{maxHeight:'calc(100dvh - 210px)',overflowY:'auto'}}} style={{top:24}}>
    {error&&<Alert type="error" showIcon title={t('未保存，输入已保留','Not saved; your input is preserved')} description={error}/>}
    <Spin spinning={loading}><Form disabled={busy} id="lm-machine-service-addresses" form={form} layout="vertical" onFinish={save} scrollToFirstError={{block:'center',focus:true}}>
      <p className="lm-ops-note">{t('内网地址用于集群内部连接；公网地址用于入口域名的 A / AAAA。候选可直接采用，也可手动修正。','Private addresses connect services within a cluster. Public addresses are used for entry A / AAAA records. Adopt a candidate or enter a correction.')}</p>
      {(['private','public'] as const).map(scope=>{
        const value=snapshot?.[scope],candidates=snapshot?.candidates.filter(c=>c.scope===scope)??[];
        return <section className="lm-machine-address-section" key={scope} aria-label={scope==='private'?t('内网服务地址','Private service address'):t('公网服务地址','Public service address')}>
          <h3>{scope==='private'?t('内网服务地址','Private service address'):t('公网服务地址','Public service address')}</h3>
          <p className="lm-machine-address-effective">{t('当前使用','Currently used')}：<strong>{value?.effective||t('尚无可用地址','No usable address')}</strong>{value?.source==='manual'&&<Tag>{t('手动指定','Manual')}</Tag>}{value?.needs_confirmation&&<Tag color="warning">{t('主机目标变化，待确认','Host target changed; confirm again')}</Tag>}</p>
          <Form.Item name={[scope,'mode']} label={t('选择方式','Selection mode')}><Select options={[{value:'auto',label:t('自动选择网卡地址','Select interface address automatically')},{value:'manual',label:t('手动指定','Specify manually')}]}/></Form.Item>
          <Form.Item noStyle shouldUpdate={(a,b)=>a[scope]?.mode!==b[scope]?.mode}>{({getFieldValue})=>getFieldValue([scope,'mode'])==='manual'&&<Form.Item className="lm-machine-manual-address" name={[scope,'address']} label={scope==='private'?t('内网 IP','Private IP'):t('公网 IP','Public IP')} validateFirst rules={[{required:true,message:t('请填写 IP 地址','Enter an IP address')},{validator:(_,raw)=>{const category=typeof raw==='string'&&!raw.includes('%')?ipAddressCategory(raw):'invalid';return (scope==='private'?['private','shared'].includes(category):category==='public')?Promise.resolve():Promise.reject(Error(scope==='private'?t('请填写内网或共享范围的 IP，不含端口、CIDR 或 URL。','Enter a private or shared-range IP without a port, CIDR or URL.'):t('请填写普通公网范围的 IP，不含端口、CIDR 或 URL。','Enter a public-range IP without a port, CIDR or URL.')))}}]}><Input autoComplete="off" placeholder={scope==='private'?'10.0.0.16':t('公网 IPv4 或 IPv6','Public IPv4 or IPv6')}/></Form.Item>}</Form.Item>
          <div className="lm-machine-address-candidates"><span>{t('自动识别的候选','Detected candidates')}</span>{candidates.length?candidates.map(c=><div key={c.source+':'+c.interface+':'+c.address}><div><strong>{c.address}</strong><small>{c.source==='interface'?t('网卡','Interface')+' '+c.interface:c.source==='ssh_target'?t('SSH 连接目标 · 需确认映射','SSH target · confirm mapping'):t('到平台的公网来源 · 需确认映射','Public source to platform · confirm mapping')}{c.observed_at?' · '+new Date(c.observed_at).toLocaleString():''}</small></div><Button size="small" disabled={busy} aria-label={t('采用地址 ','Use address ')+c.address} onClick={()=>{form.setFieldsValue({[scope]:{mode:'manual',address:c.address}});form.setFields([{name:[scope,'address'],errors:[]}])}}>{t('采用','Use')}</Button></div>):<p>{t('尚未发现候选，可手动指定或等待主机采集。','No candidates discovered. Specify an address or wait for host discovery.')}</p>}</div>
          {scope==='public'&&<p className="lm-ops-note">{t('云主机的 NAT 公网地址可能不在网卡中。SSH 和平台来源只作候选，采用并保存后才用于服务；公网端口是否可达需由云映射和防火墙保证。','A cloud NAT public address may not appear on an interface. SSH and platform sources are candidates only; adopt and save one to use it. Cloud mappings and firewalls determine port reachability.')}</p>}
        </section>;
      })}
    </Form></Spin>
  </Modal>;
}
