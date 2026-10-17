import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,App,Button,Form,Input,Radio,Space,Spin,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {sdkEndpointError} from './sdkExamples';
import type {ReportingAddress,ReportingSettings as Settings} from './reporting-addresses';
import './reporting-addresses.css';

export default function ReportingSettings(){
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
  <h2>上报地址</h2><p>为内网、公网等链路分别命名，复制 LightMoni Agent 安装命令和 SDK 示例时可选择对应地址。</p>
  {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}
  {loading?<Spin/>:!settings?<Button onClick={()=>void load()}>重新加载</Button>:<Form form={form} initialValues={{endpoints:settings.endpoints??[{id:'default',name:'默认地址',url:settings.effective_endpoint}],default_endpoint_id:settings.default_endpoint_id??'default'}} layout="vertical" disabled={saving} onFinish={async values=>{
   setSaving(true);setError('');
   try{
    const data=await api<Settings>('/settings/reporting',{method:'PUT',body:JSON.stringify(values)});
    setSettings(data);form.setFieldsValue({endpoints:data.endpoints,default_endpoint_id:data.default_endpoint_id});void message.success('上报地址已保存');
   }catch(error){setError((error as Error).message);}
   finally{setSaving(false);}
  }}>
   <Form.Item name="default_endpoint_id" hidden><Input/></Form.Item>
   <Form.List name="endpoints">{(fields,{add,remove})=><>
    {fields.map((field,index)=><div className="lm-reporting-address-row" key={field.key}>
     <Form.Item name={[field.name,'id']} hidden><Input/></Form.Item>
     <Form.Item name={[field.name,'name']} label="地址名称" rules={[{required:true,whitespace:true,message:'请输入地址名称'},{max:64,message:'地址名称最多 64 个字符'}]}><Input aria-label={`上报地址 ${index+1} 名称`} placeholder="内网 / 公网" maxLength={64}/></Form.Item>
     <Form.Item className="lm-reporting-url-field" name={[field.name,'url']} label="上报地址" rules={[{required:true,message:'请输入上报地址'},{validator:(_,value:string)=>!value||!sdkEndpointError(value)?Promise.resolve():Promise.reject(new Error(sdkEndpointError(value)))}]}><Input aria-label={`上报地址 ${index+1} URL`} placeholder="https://monitor.example.com" maxLength={2048}/></Form.Item>
     <div className="lm-reporting-address-actions"><Form.Item noStyle shouldUpdate={(a,b)=>a.default_endpoint_id!==b.default_endpoint_id}>{({getFieldValue,setFieldValue})=><Radio checked={getFieldValue('default_endpoint_id')===addresses[index]?.id} onChange={()=>setFieldValue('default_endpoint_id',addresses[index]?.id)} aria-label={`设为默认地址 ${index+1}`}>默认</Radio>}</Form.Item><Button type="text" danger icon={<DeleteOutlined/>} aria-label={`移除上报地址 ${index+1}`} onClick={()=>{if(form.getFieldValue('default_endpoint_id')===addresses[index]?.id)form.setFieldValue('default_endpoint_id',addresses.filter((_,i)=>i!==index)[0]?.id??'');remove(field.name)}}/></div>
    </div>)}
    {!fields.length&&<p className="lm-settings-hint">保存后使用部署地址：{settings.default_endpoint}</p>}
    <Button icon={<PlusOutlined/>} disabled={saving||fields.length>=20} onClick={()=>{const id=crypto.randomUUID();add({id,name:'',url:''});if(!fields.length)form.setFieldValue('default_endpoint_id',id)}}>新增地址</Button>
   </>}</Form.List>
   <Typography.Paragraph type="secondary" style={{marginTop:20}}>默认地址用于新生成的配置。已运行的 SDK 和执行节点继续使用各自保存的地址。</Typography.Paragraph>
   <Space wrap><Button type="primary" htmlType="submit" loading={saving}>保存上报地址</Button><Button onClick={()=>form.setFieldsValue({endpoints:[],default_endpoint_id:''})}>使用部署地址</Button><Link to="/data">生成接入配置</Link></Space>
  </Form>}
 </div>;
}
