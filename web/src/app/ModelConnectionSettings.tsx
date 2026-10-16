import {useEffect,useState} from 'react';
import {Alert,Button,Descriptions,Spin,Tag} from '../shared/ui';
import {api} from '../shared/api';
import {ModelSettings} from '../features/assistant/ModelSettings';
import type {AssistantConfig} from '../features/assistant/types';
import {protocolLabel} from '../features/assistant/model-protocol';

export default function ModelConnectionSettings(){
 const [config,setConfig]=useState<AssistantConfig>(),[loading,setLoading]=useState(true),[open,setOpen]=useState(false),[error,setError]=useState('');
 async function load(){setLoading(true);setError('');try{setConfig(await api<AssistantConfig>('/assistant/config'))}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 return <div className="lm-surface lm-model-settings">
  <div className="lm-settings-section-head"><div><p>配置 AI 助手使用的模型服务、密钥与执行限制。</p></div><Button type="primary" disabled={loading||!config} onClick={()=>setOpen(true)}>{config?.base_url?'编辑模型配置':'配置模型'}</Button></div>
  {loading?<Spin/>:error?<Alert type="error" title={error} action={<Button onClick={()=>void load()}>重新加载</Button>}/>:config&&<Descriptions column={1} items={[
   {key:'status',label:'状态',children:<Tag color={config.enabled?'success':'default'}>{config.enabled?'已启用':'未启用'}</Tag>},
   {key:'address',label:'服务地址',children:config.base_url||'尚未配置'},
   {key:'protocol',label:'API 协议',children:config.protocol?protocolLabel(config.protocol):'尚未配置'},
   {key:'model',label:'模型名称',children:config.model||'尚未配置'},
   {key:'key',label:'API Key',children:config.has_key?'已保存':'未设置'},
  ]}/>}
  <ModelSettings open={open} config={config} onClose={()=>setOpen(false)} onSaved={setConfig}/>
 </div>;
}
