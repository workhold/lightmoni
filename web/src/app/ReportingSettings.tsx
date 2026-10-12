import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {Alert,App,Button,Form,Input,Space,Spin,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {sdkEndpointError} from './sdkExamples';

interface Settings {endpoint:string;default_endpoint:string;effective_endpoint:string}

export default function ReportingSettings(){
 const {message}=App.useApp(),[form]=Form.useForm();
 const [settings,setSettings]=useState<Settings>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 async function load(){
  setLoading(true);setError('');
  try{const data=await api<Settings>('/settings/reporting');setSettings(data);}
  catch(error){setError((error as Error).message);}
  finally{setLoading(false);}
 }
 useEffect(()=>{void load();},[]);
 return <div className="lm-surface">
  <h2>默认中心上报地址</h2>
  <p>生成 SDK 直连配置和 Agent 安装命令时使用此地址。接入时可按网络环境改为公网域名或内网地址。</p>
  {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}
  {loading?<Spin/>:!settings?<Button onClick={()=>void load()}>重新加载</Button>:<Form form={form} initialValues={{endpoint:settings.endpoint}} layout="vertical" style={{maxWidth:760}} onFinish={async values=>{
   setSaving(true);setError('');
   try{
    const data=await api<Settings>('/settings/reporting',{method:'PUT',body:JSON.stringify({endpoint:values.endpoint?.trim()??''})});
    setSettings(data);form.setFieldsValue({endpoint:data.endpoint});void message.success('默认上报地址已保存');
   }catch(error){setError((error as Error).message);}
   finally{setSaving(false);}
  }}>
   <Form.Item name="endpoint" label="默认上报地址" extra="填写 Nginx 对外域名或可访问的服务基础地址；留空使用部署地址。" rules={[{validator:(_,value:string)=>!value?.trim()||!sdkEndpointError(value)?Promise.resolve():Promise.reject(new Error(sdkEndpointError(value)))}]}>
    <Input aria-label="默认上报地址" maxLength={2048} disabled={saving} placeholder={settings.default_endpoint}/>
   </Form.Item>
   <p>部署地址：<Typography.Text code>{settings.default_endpoint}</Typography.Text></p>
   <p>当前默认：<Typography.Text code>{settings.effective_endpoint}</Typography.Text></p>
   <Typography.Paragraph type="secondary">保存后用于新生成的接入配置。已运行的 SDK 和 Agent 使用各自保存的地址；SDK 通过 Agent 时默认连接本机 http://127.0.0.1:4318。</Typography.Paragraph>
   <Space wrap><Button type="primary" htmlType="submit" loading={saving}>保存默认地址</Button><Link to="/data">生成接入配置</Link></Space>
  </Form>}
 </div>;
}
