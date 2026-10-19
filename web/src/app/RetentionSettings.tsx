import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {App,Button,Form,InputNumber,Modal,Select,Space,Spin} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable} from '../shared/types';

export const retentionLabel=(days:number|undefined)=>days===0?'永久保留':days===undefined?'—':`${days} 天`;
const dayRules=[{required:true,message:'请输入保留天数'},{type:'integer' as const,min:1,max:36500,message:'请输入 1 到 36500 的整数天数'}];
const cleanupHint='到期数据由存储后台逐步清理。缩短时长可能清理已有数据，延长时长无法恢复已清理的数据。';

export default function RetentionSettings(){
 const {message}=App.useApp(),[form]=Form.useForm();
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
 const mode=Form.useWatch('mode',form);
 async function load(){setLoading(true);try{const data=await api<{default_days:number}>('/settings/retention');form.setFieldsValue({mode:data.default_days===0?'forever':'days',days:data.default_days||7});setLoaded(true);}catch(error){void message.error((error as Error).message);}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 return <div className="lm-surface lm-retention-settings"><h2>全局默认保留时长</h2><p>新数据表和“跟随全局”的表使用此时长，单表自定义设置优先。</p>{loading?<Spin/>:!loaded?<Button onClick={()=>void load()}>重新加载</Button>:<Form form={form} layout="vertical" onFinish={async values=>{setSaving(true);try{await api('/settings/retention',{method:'PUT',body:JSON.stringify({default_days:values.mode==='forever'?0:values.days})});void message.success('默认保留时长已保存，跟随全局的数据表已更新');}catch(error){void message.error((error as Error).message);}finally{setSaving(false);}}}>
  <Form.Item name="mode" label="保留方式"><Select aria-label="全局保留方式" disabled={saving} options={[{label:'按天保留',value:'days'},{label:'永久保留',value:'forever'}]}/></Form.Item>
  {mode==='days'&&<Form.Item name="days" label="默认保留天数" rules={dayRules}><InputNumber aria-label="默认保留天数" min={1} max={36500} precision={0} suffix="天" style={{width:160}} disabled={saving}/></Form.Item>}
  <p className="lm-retention-hint">{cleanupHint}</p><Space wrap><Button type="primary" htmlType="submit" loading={saving}>保存默认时长</Button><Link to="/data-management">设置单表时长</Link></Space>
 </Form>}</div>;
}

export function TableRetentionEditor({table,onClose,onSaved}:{table?:CatalogTable;onClose:()=>void;onSaved:()=>void}){
 const {message}=App.useApp(),[form]=Form.useForm(),[saving,setSaving]=useState(false);
 const mode=Form.useWatch('mode',form);
 useEffect(()=>{if(table)form.setFieldsValue({mode:table.retention_days==null?'inherit':table.retention_days===0?'forever':'days',days:table.retention_days||table.effective_retention_days||7});},[table,form]);
 return <Modal title="数据表保留时长" open={!!table} onCancel={()=>{if(!saving)onClose();}} onOk={()=>form.submit()} confirmLoading={saving} okText="保存时长" cancelText="取消" destroyOnHidden>
  <p className="lm-retention-table-name">{table?.name}</p><Form form={form} layout="vertical" onFinish={async values=>{if(!table)return;setSaving(true);try{await api(`/catalog/tables/${encodeURIComponent(table.id)}/retention`,{method:'PUT',body:JSON.stringify({retention_days:values.mode==='inherit'?null:values.mode==='forever'?0:values.days})});void message.success('数据表保留时长已保存');onClose();onSaved();}catch(error){void message.error((error as Error).message);}finally{setSaving(false);}}}>
   <Form.Item name="mode" label="保留方式"><Select aria-label="单表保留方式" disabled={saving} options={[{label:'跟随全局默认',value:'inherit'},{label:'自定义天数',value:'days'},{label:'永久保留',value:'forever'}]}/></Form.Item>
   {mode==='days'&&<Form.Item name="days" label="保留天数" rules={dayRules}><InputNumber aria-label="单表保留天数" min={1} max={36500} precision={0} suffix="天" style={{width:160}} disabled={saving}/></Form.Item>}
   <p className="lm-retention-hint">{cleanupHint}</p>
  </Form>
 </Modal>;
}
