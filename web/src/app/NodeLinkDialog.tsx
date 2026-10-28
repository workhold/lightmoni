import {useEffect,useRef,useState} from 'react';
import {Alert,Descriptions,Modal,Select,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {AgentItem} from './agent-model';

type Host={id:string;name:string;agent_id:string;address:string;port:number;host_key_status:string;connection_method:string};
type Key={id:string;method:string;retention?:string;secret_fingerprint:string;expires_at:string;revoked_at?:string;secret_cleared_at?:string};
export default function NodeLinkDialog({machines,agents,machineID,agentID,onClose,onSaved}:{machines:Host[];agents:AgentItem[];machineID?:string;agentID?:string;onClose:()=>void;onSaved:()=>Promise<void>}){
 const {t}=useI18n();
 const [hostID,setHostID]=useState(machineID),[nodeID,setNodeID]=useState(agentID),[keyID,setKeyID]=useState<string>(),[keys,setKeys]=useState<Key[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false),version=useRef(0);
 const selected=machines.find(host=>host.id===hostID);
 const available=agents.filter(agent=>agent.lifecycle_state!=='removed'&&!machines.some(host=>host.agent_id===agent.id));
 useEffect(()=>{
  const current=++version.current;setKeys([]);setKeyID(undefined);setError('');
  if(!hostID){setLoading(false);return}
  setLoading(true);void api<{credentials:Key[]}>(`/machines/${encodeURIComponent(hostID)}`).then(detail=>{
   if(current!==version.current)return;
   const active=detail.credentials.filter(key=>(key.method==='ssh_key'||key.method==='password'&&['temporary','managed'].includes(key.retention||''))&&!key.revoked_at&&!key.secret_cleared_at&&Date.parse(key.expires_at)>Date.now());setKeys(active);if(active.length===1)setKeyID(active[0].id);
  }).catch(e=>{if(current===version.current)setError(e instanceof Error?e.message:t('读取凭据失败','Unable to load credentials'))}).finally(()=>{if(current===version.current)setLoading(false)});
  return()=>{version.current++};
 },[hostID]);
 return <Modal title={t('核验并关联主机与节点','Verify and link host to node')} open maskClosable={false} closable={!busy} keyboard={!busy} confirmLoading={busy} okText={t('执行只读核验并关联','Verify identity and link')} okButtonProps={{'aria-label':t('执行只读核验并关联','Verify identity and link'),disabled:loading||!hostID||!nodeID||!keyID||selected?.host_key_status!=='confirmed'||selected?.connection_method!=='direct_ssh'}} cancelButtonProps={{disabled:busy}} onCancel={()=>{if(!pending.current)onClose()}} onOk={async()=>{
  if(pending.current||!hostID||!nodeID||!keyID)return;pending.current=true;setBusy(true);setError('');
  try{await api(`/machines/${encodeURIComponent(hostID)}/agent-link`,{method:'POST',body:JSON.stringify({agent_id:nodeID,credential_id:keyID})});await onSaved();onClose()}catch(e){setError(e instanceof Error?e.message:t('身份核验失败','Identity verification failed'))}finally{pending.current=false;setBusy(false)}
 }}>
  <Alert type="info" showIcon title={t('通过 SSH 核对真实 Agent 身份','Verify the real Agent identity using SSH')} description={t('平台使用已确认的主机指纹和有效私钥或可复用密码，执行固定只读检查。只有远端 Agent ID 与所选节点一致才会建立关联，不按 IP 或名称自动合并；不会安装或卸载程序。','The platform uses the verified host fingerprint and an active SSH key or reusable password for fixed read-only checks. The remote Agent ID must match the selected node; IP addresses and names are never used to infer identity. No software is installed or removed.')}/>
  <Typography.Paragraph className="lm-machine-form-notice">{t('主机','Host')}</Typography.Paragraph>
  <Select aria-label={t('待关联主机','Host to link')} style={{width:'100%'}} value={hostID} onChange={setHostID} disabled={busy||!!machineID} options={machines.filter(host=>!host.agent_id||host.id===machineID).map(host=>({value:host.id,label:`${host.name} · ${host.address}:${host.port}`}))}/>
  {selected&&<Descriptions className="lm-machine-form-notice" size="small" column={1} items={[{key:'fingerprint',label:t('主机指纹','Host fingerprint'),children:selected.host_key_status==='confirmed'?t('已确认','Verified'):t('未确认，请先登记可信主机指纹','Unverified. Register a trusted host fingerprint first.')} ]}/>}
  <Typography.Paragraph className="lm-machine-form-notice">{t('独立接入节点','Independently enrolled node')}</Typography.Paragraph>
  <Select aria-label={t('待关联节点','Node to link')} style={{width:'100%'}} value={nodeID} onChange={setNodeID} disabled={busy||!!agentID} options={available.map(agent=>({value:agent.id,label:`${agent.hostname||agent.id} · ${agent.id}`}))}/>
  <Typography.Paragraph className="lm-machine-form-notice">{t('核验使用的 SSH 凭据','SSH credential for verification')}</Typography.Paragraph>
  <Select aria-label={t('核验 SSH 凭据','Verification SSH credential')} loading={loading} style={{width:'100%'}} value={keyID} onChange={setKeyID} disabled={busy||loading} options={keys.map(key=>({value:key.id,label:`${key.method==='password'?t('可复用密码','Reusable password'):t('SSH 私钥','SSH private key')} · ${key.secret_fingerprint||key.id}`}))}/>
  {hostID&&!loading&&!keys.length&&<Alert className="lm-machine-form-notice" type="warning" showIcon title={t('请先在该主机添加有效私钥或临时/托管密码，再进行身份核验。','Add an active key or temporary/managed password to this host before verifying its identity.')}/>}
  {error&&<Alert className="lm-machine-form-notice" type="error" showIcon title={error}/>}
 </Modal>;
}
