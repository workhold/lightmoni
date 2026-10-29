import {useRef,useState} from 'react';
import {Alert,Modal,Select} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {AgentItem,AgentTaskLabel} from './agent-model';

export default function NodeLabelsDialog({agent,labels,onClose,onSaved}:{agent:AgentItem;labels:AgentTaskLabel[];onClose:()=>void;onSaved:()=>Promise<void>}){
 const {t}=useI18n();
 const [ids,setIDs]=useState(agent.label_ids||[]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false);
 return <Modal title={t(`设置任务标签 · ${agent.hostname||agent.id}`,`Set task labels · ${agent.hostname||agent.id}`)} open onCancel={()=>{if(!pending.current)onClose()}} closable={!busy} maskClosable={false} keyboard={!busy} confirmLoading={busy} okText={t('保存任务标签','Save task labels')} okButtonProps={{'aria-label':t('保存任务标签','Save task labels')}} cancelButtonProps={{disabled:busy}} onOk={async()=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await api(`/agents/${encodeURIComponent(agent.id)}/labels`,{method:'PUT',body:JSON.stringify({label_ids:ids})});await onSaved();onClose()}catch(e){setError(e instanceof Error?e.message:t('保存失败','Unable to save'))}finally{pending.current=false;setBusy(false)}
 }}>
  <p>{t('节点接收任一任务标签匹配的启用监控任务；空标签不会广播任务。','The node receives enabled monitoring tasks matching any selected label. Empty labels never broadcast tasks.')}</p>
  <Select aria-label={t('节点任务标签','Node task labels')} mode="multiple" allowClear style={{width:'100%'}} value={ids} onChange={setIDs} disabled={busy} options={labels.map(label=>({value:label.id,label:label.name}))}/>
  {error&&<Alert className="lm-machine-form-notice" type="error" showIcon title={error}/>}
 </Modal>;
}
