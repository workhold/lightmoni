import { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Form, Input } from '../../shared/ui';
import { useI18n } from '../../shared/i18n';
import { api } from '../../shared/api';
import ResourceFields from './ResourceFields';
import {editorValues,errorText,KIND_NAMES,serializeSpec,type Agent,type Machine,type Resource,type ResourceKind,type Spec} from './model';
export type QuickRequest={kind:ResourceKind;onCreated:(resource:Resource)=>void;defaults?:Spec};
export default function QuickResourceDrawer({request,onClose,resources,agents,machines,onRefresh,depth=0}:{request?:QuickRequest;onClose:()=>void;resources:Resource[];agents:Agent[];machines:Machine[];onRefresh:()=>Promise<void>;depth?:number}){
 const {t}=useI18n(),[form]=Form.useForm(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[nested,setNested]=useState<QuickRequest>();
 useEffect(()=>{if(!request)return;setError('');form.resetFields();const values=editorValues(request.kind);form.setFieldsValue({...values,spec:{...values.spec,...request.defaults}})},[request,form]);
 async function save(values:Spec){if(!request)return;setBusy(true);setError('');try{const result=await api<{resource:Resource}>('/ops/resources',{method:'POST',body:JSON.stringify({kind:request.kind,name:values.name,spec:serializeSpec(request.kind,values.spec)})});await onRefresh();request.onCreated(result.resource);onClose()}catch(e){setError(errorText(e))}finally{setBusy(false)}}
 return <><Drawer open={!!request} title={request?t('新建','New')+t(...KIND_NAMES[request.kind]):''} size={760} zIndex={1200+depth*100} onClose={()=>{if(!busy)onClose()}} destroyOnHidden extra={<Button type="primary" onClick={()=>form.submit()} loading={busy}>{t('保存并选择','Save and select')}</Button>}>
 {error&&<Alert showIcon type="error" title={t('保存失败，输入已保留','Save failed; input preserved')} description={error}/>}
 <Form name={"ops-quick-"+depth} form={form} layout="vertical" className="lm-ops-form" onFinish={save}><Form.Item name="name" label={t('名称','Name')} rules={[{required:true}]}><Input maxLength={128}/></Form.Item>{request&&<ResourceFields kind={request.kind} resources={resources} agents={agents} machines={machines} onRefresh={()=>void onRefresh()} onQuickCreate={(kind,onCreated,defaults)=>setNested({kind,onCreated,defaults})}/>}</Form></Drawer>
 {nested&&<QuickResourceDrawer request={nested} onClose={()=>setNested(undefined)} resources={resources} agents={agents} machines={machines} onRefresh={onRefresh} depth={depth+1}/>}
 </>;
}
