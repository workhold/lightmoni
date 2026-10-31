import {useI18n} from '../shared/i18n';
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,App,Button,Form,Input,Radio,Select,Space,Spin,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {sdkEndpointError} from './sdkExamples';
import type {ReportingAddress,ReportingSettings as Settings} from './reporting-addresses';
import './reporting-addresses.css';

export default function ReportingSettings(){
 const {t,language:uiLanguage}=useI18n();

 const {message}=App.useApp(),[form]=Form.useForm();
 const [settings,setSettings]=useState<Settings>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const addresses=(Form.useWatch('endpoints',form)??[]) as ReportingAddress[];
 async function load(){
  setLoading(true);setError('');
  try{setSettings(await api<Settings>('/settings/reporting'));}
  catch(error){setError((error as Error).message);}
  finally{setLoading(false);}
 }
 useEffect(()=>{void load();},[]);
 return <div className="lm-surface lm-reporting-settings">
  <h2>{t("上报地址","Reporting address")}</h2><p>{t("登记中心内网 IP 和端口及公网入口。SDK 与 Agent 自动同步地址，内网优先，不通时使用公网。","Register the center’s internal IP and port and public entrance. SDKs and Agents sync changes, prefer internal connections, and fall back to public access.")}</p>
  {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}
  {loading?<Spin/>:!settings?<Button onClick={()=>void load()}>{t("重新加载","Reload")}</Button>:<Form form={form} initialValues={{endpoints:settings.endpoints??[{id:'default',name:t("默认地址","Default address"),url:settings.effective_endpoint}],default_endpoint_id:settings.default_endpoint_id??'default'}} layout="vertical" disabled={saving} onFinish={async values=>{
   setSaving(true);setError('');
   try{
    const data=await api<Settings>('/settings/reporting',{method:'PUT',body:JSON.stringify(values)});
    setSettings(data);form.setFieldsValue({endpoints:data.endpoints,default_endpoint_id:data.default_endpoint_id});void message.success(t("上报地址已保存","Reporting addresses saved"));
   }catch(error){setError((error as Error).message);}
   finally{setSaving(false);}
  }}>
   <Form.Item name="default_endpoint_id" hidden><Input/></Form.Item>
   <Form.List name="endpoints">{(fields,{add,remove})=><>
    {fields.map((field,index)=><div className="lm-reporting-address-row" key={field.key}>
     <Form.Item name={[field.name,'id']} hidden><Input/></Form.Item>
     <Form.Item name={[field.name,'name']} label={t("地址名称","Address name")} rules={[{required:true,whitespace:true,message:t("请输入地址名称","Enter an address name")},{max:64,message:t("地址名称最多 64 个字符","Address names may contain up to 64 characters")}]}><Input aria-label={t(`上报地址 ${index+1} 名称`,`Reporting address ${index+1} name`)} placeholder={t("内网 / 公网","Internal / Public")} maxLength={64}/></Form.Item>
     <Form.Item name={[field.name,'scope']} label={t("地址用途","Network")}><Select aria-label={t(`上报地址 ${index+1} 用途`,`Reporting address ${index+1} network`)} onChange={scope=>{if(scope==='internal'&&form.getFieldValue('default_endpoint_id')===addresses[index]?.id)form.setFieldValue('default_endpoint_id',addresses.find((a,i)=>i!==index&&a.scope==='public')?.id??'')}} options={[{value:'internal',label:t('内网优先','Internal (preferred)')},{value:'public',label:t('公网引导 / 备用','Public bootstrap / fallback')}]}/></Form.Item>
     <Form.Item className="lm-reporting-url-field" name={[field.name,'url']} label={t("上报地址","Reporting address")} rules={[{required:true,message:t("请输入上报地址","Enter a reporting address")},{validator:(_,value:string)=>!value||!sdkEndpointError(value,uiLanguage)?Promise.resolve():Promise.reject(new Error(sdkEndpointError(value,uiLanguage)))}]}><Input aria-label={t(`上报地址 ${index+1} URL`,`Reporting address ${index+1} URL`)} placeholder="https://monitor.example.com" maxLength={2048}/></Form.Item>
     <div className="lm-reporting-address-actions"><Form.Item noStyle shouldUpdate={(a,b)=>a.default_endpoint_id!==b.default_endpoint_id}>{({getFieldValue,setFieldValue})=><Radio disabled={addresses[index]?.scope==='internal'} checked={getFieldValue('default_endpoint_id')===addresses[index]?.id} onChange={()=>setFieldValue('default_endpoint_id',addresses[index]?.id)} aria-label={t(`设为默认地址 ${index+1}`,`Set address ${index+1} as default`)}>{t("默认","Default")}</Radio>}</Form.Item><Button type="text" danger icon={<DeleteOutlined/>} aria-label={t(`移除上报地址 ${index+1}`,`Remove reporting address ${index+1}`)} onClick={()=>{if(form.getFieldValue('default_endpoint_id')===addresses[index]?.id)form.setFieldValue('default_endpoint_id',addresses.find((a,i)=>i!==index&&a.scope==='public')?.id??'');remove(field.name)}}/></div>
    </div>)}
    {!fields.length&&<p className="lm-settings-hint">{t("保存后使用部署地址：","After saving, the deployment address is used: ")}{settings.default_endpoint}</p>}
    <Button icon={<PlusOutlined/>} disabled={saving||fields.length>=20} onClick={()=>{const id=crypto.randomUUID();add({id,name:'',url:'',scope:'public'});if(!fields.length)form.setFieldValue('default_endpoint_id',id)}}>{t("新增地址","Add address")}</Button>
   </>}</Form.List>
   <Typography.Paragraph type="secondary" style={{marginTop:20}}>{t("至少保留一个公网入口作为引导地址。SDK 与 Agent 每 30 秒同步；修改内网地址无需重新部署。Agent 的控制、任务通道和数据上报共用所选入口。","Keep at least one public bootstrap entrance. SDKs and Agents sync every 30 seconds; internal address changes need no redeployment. Agent control, task channels, and telemetry share the selected entrance.")}</Typography.Paragraph>
   <Space wrap><Button type="primary" htmlType="submit" loading={saving}>{t("保存上报地址","Save reporting addresses")}</Button><Button onClick={()=>form.setFieldsValue({endpoints:[],default_endpoint_id:''})}>{t("使用部署地址","Use deployment address")}</Button><Link to="/data">{t("生成接入配置","Generate integration settings")}</Link></Space>
  </Form>}
 </div>;
}
