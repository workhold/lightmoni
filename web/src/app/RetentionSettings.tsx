import {useI18n} from '../shared/i18n';
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {App,Button,Form,InputNumber,Modal,Select,Space,Spin} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable} from '../shared/types';

export const retentionLabel=(days:number|undefined,t:(zh:string,en:string)=>string=zh=>zh)=>days===0?t("永久保留","Keep forever"):days===undefined?'—':t(`${days} 天`,`${days} days`);

export default function RetentionSettings(){
 const {t}=useI18n();
const dayRules=[{required:true,message:t("请输入保留天数","Enter retention days")},{type:'integer' as const,min:1,max:36500,message:t("请输入 1 到 36500 的整数天数","Enter a whole number of days from 1 to 36500")}];
const cleanupHint=t("到期数据由存储后台逐步清理。缩短时长可能清理已有数据，延长时长无法恢复已清理的数据。","Expired data is gradually removed by storage cleanup. Shorter retention may delete existing data; longer retention cannot restore deleted data.");

 const {message}=App.useApp(),[form]=Form.useForm();
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
 const mode=Form.useWatch('mode',form);
 async function load(){setLoading(true);try{const data=await api<{default_days:number}>('/settings/retention');form.setFieldsValue({mode:data.default_days===0?'forever':'days',days:data.default_days||7});setLoaded(true);}catch(error){void message.error((error as Error).message);}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 return <div className="lm-surface lm-retention-settings"><h2>{t("全局默认保留时长","Global default retention")}</h2><p>{t("新数据表和“跟随全局”的表使用此时长，单表自定义设置优先。","New tables and tables using the global default use this period. Custom table settings take priority.")}</p>{loading?<Spin/>:!loaded?<Button onClick={()=>void load()}>{t("重新加载","Reload")}</Button>:<Form form={form} layout="vertical" onFinish={async values=>{setSaving(true);try{await api('/settings/retention',{method:'PUT',body:JSON.stringify({default_days:values.mode==='forever'?0:values.days})});void message.success(t("默认保留时长已保存，跟随全局的数据表已更新","Default retention saved. Tables using the global default have been updated"));}catch(error){void message.error((error as Error).message);}finally{setSaving(false);}}}>
  <Form.Item name="mode" label={t("保留方式","Retention mode")}><Select aria-label={t("全局保留方式","Global retention mode")} disabled={saving} options={[{label:t("按天保留","Keep for a number of days"),value:'days'},{label:t("永久保留","Keep forever"),value:'forever'}]}/></Form.Item>
  {mode==='days'&&<Form.Item name="days" label={t("默认保留天数","Default retention days")} rules={dayRules}><InputNumber aria-label={t("默认保留天数","Default retention days")} min={1} max={36500} precision={0} suffix={t("天","days")} style={{width:160}} disabled={saving}/></Form.Item>}
  <p className="lm-retention-hint">{cleanupHint}</p><Space wrap><Button type="primary" htmlType="submit" loading={saving}>{t("保存默认时长","Save default retention")}</Button><Link to="/data-management">{t("设置单表时长","Set table retention")}</Link></Space>
 </Form>}</div>;
}

export function TableRetentionEditor({table,onClose,onSaved}:{table?:CatalogTable;onClose:()=>void;onSaved:()=>void}){
 const {t}=useI18n();
const dayRules=[{required:true,message:t("请输入保留天数","Enter retention days")},{type:'integer' as const,min:1,max:36500,message:t("请输入 1 到 36500 的整数天数","Enter a whole number of days from 1 to 36500")}];
const cleanupHint=t("到期数据由存储后台逐步清理。缩短时长可能清理已有数据，延长时长无法恢复已清理的数据。","Expired data is gradually removed by storage cleanup. Shorter retention may delete existing data; longer retention cannot restore deleted data.");

 const {message}=App.useApp(),[form]=Form.useForm(),[saving,setSaving]=useState(false);
 const mode=Form.useWatch('mode',form);
 useEffect(()=>{if(table)form.setFieldsValue({mode:table.retention_days==null?'inherit':table.retention_days===0?'forever':'days',days:table.retention_days||table.effective_retention_days||7});},[table,form]);
 return <Modal title={t("数据表保留时长","Table retention")} open={!!table} onCancel={()=>{if(!saving)onClose();}} onOk={()=>form.submit()} confirmLoading={saving} okText={t("保存时长","Save retention")} cancelText={t("取消","Cancel")} destroyOnHidden>
  <p className="lm-retention-table-name">{table?.name}</p><Form form={form} layout="vertical" onFinish={async values=>{if(!table)return;setSaving(true);try{await api(`/catalog/tables/${encodeURIComponent(table.id)}/retention`,{method:'PUT',body:JSON.stringify({retention_days:values.mode==='inherit'?null:values.mode==='forever'?0:values.days})});void message.success(t("数据表保留时长已保存","Table retention saved"));onClose();onSaved();}catch(error){void message.error((error as Error).message);}finally{setSaving(false);}}}>
   <Form.Item name="mode" label={t("保留方式","Retention mode")}><Select aria-label={t("单表保留方式","Table retention mode")} disabled={saving} options={[{label:t("跟随全局默认","Use global default"),value:'inherit'},{label:t("自定义天数","Custom number of days"),value:'days'},{label:t("永久保留","Keep forever"),value:'forever'}]}/></Form.Item>
   {mode==='days'&&<Form.Item name="days" label={t("保留天数","Retention days")} rules={dayRules}><InputNumber aria-label={t("单表保留天数","Table retention days")} min={1} max={36500} precision={0} suffix={t("天","days")} style={{width:160}} disabled={saving}/></Form.Item>}
   <p className="lm-retention-hint">{cleanupHint}</p>
  </Form>
 </Modal>;
}
