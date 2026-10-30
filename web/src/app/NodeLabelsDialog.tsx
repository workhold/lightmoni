import {useEffect,useRef,useState} from 'react';
import {Alert,Modal,Select} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {AgentTaskLabel,TaskHost} from './agent-model';

export default function NodeLabelsDialog({host,labels,onClose,onSaved}:{host:Pick<TaskHost,'id'|'name'|'label_ids'>;labels:AgentTaskLabel[];onClose:()=>void;onSaved:()=>Promise<void>}){
 const {t}=useI18n();
 const [ids,setIDs]=useState(host.label_ids||[]),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[readReady,setReadReady]=useState(false),[error,setError]=useState('');
 const pending=useRef(false);
 useEffect(()=>{let active=true;api<{label_ids:string[]}>(`/machines/${encodeURIComponent(host.id)}/labels`).then(result=>{if(active){setIDs(result.label_ids);setReadReady(true)}}).catch(e=>{if(active)setError(e instanceof Error?e.message:t('读取失败','Unable to load'))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[host.id]);
 return <Modal title={t(`设置主机标签 · ${host.name}`,`Set host labels · ${host.name}`)} open onCancel={()=>{if(!pending.current)onClose()}} closable={!busy} maskClosable={false} keyboard={!busy} confirmLoading={busy} okText={t('保存主机标签','Save host labels')} okButtonProps={{'aria-label':t('保存主机标签','Save host labels'),disabled:loading||!readReady}} cancelButtonProps={{disabled:busy}} onOk={async()=>{
  if(pending.current||loading||!readReady)return;pending.current=true;setBusy(true);setError('');
  try{await api(`/machines/${encodeURIComponent(host.id)}/labels`,{method:'PUT',body:JSON.stringify({label_ids:ids})});await onSaved();onClose()}catch(e){setError(e instanceof Error?e.message:t('保存失败','Unable to save'))}finally{pending.current=false;setBusy(false)}
 }}>
  <p>{t('标签用于分类主机和选择任务目标，未安装 Agent 时也可设置，卸载和重装后保留。','Labels organize hosts and select task targets. Set them before Agent installation; they persist through removal and reinstallation.')}</p>
  <Select aria-label={t('主机标签','Host labels')} mode="multiple" allowClear style={{width:'100%'}} value={ids} onChange={setIDs} loading={loading} disabled={busy||loading||!readReady} options={labels.map(label=>({value:label.id,label:label.name}))}/>
  {error&&<Alert className="lm-machine-form-notice" type="error" showIcon title={error}/>}
 </Modal>;
}
