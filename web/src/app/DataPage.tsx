import {useEffect,useState} from 'react';
import {Navigate,useNavigate,useSearchParams} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Select,Space,Tabs,Tag} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import AgentInstall from './AgentInstall';
import {SDK_AGENT_ENDPOINT,sdkEndpointError,sdkExamples,type SDKInstall,type SDKConnectionMode} from './sdkExamples';
import SDKSetup from './SDKSetup';
import CodeBlock from '../shared/CodeBlock';
import {SDKReportingEditor} from './LogReportingSettings';

interface SDKDraft {language?:string;mode?:SDKConnectionMode;agentEndpoint?:string;centerEndpoint?:string}
const draftKey='lightmoni.sdk-setup';
function readDraft():SDKDraft {
 try {const value=JSON.parse(sessionStorage.getItem(draftKey)??'{}');return value&&typeof value==='object'?value:{};}catch{return {};}
}
export default function DataPage({user}:{user:User}) {
 const [params,setParams]=useSearchParams(),navigate=useNavigate();
 const [draft]=useState(readDraft),[sdk,setSDK]=useState<SDKInstall>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
 const [sdkReportingOpen,setSDKReportingOpen]=useState(false);
 const [sdkLanguage,setSDKLanguage]=useState(draft.language&&sdkExamples[draft.language]?draft.language:'typescript');
 const [sdkMode,setSDKMode]=useState<SDKConnectionMode>(draft.mode==='agent'?'agent':'direct');
 const [agentEndpoint,setAgentEndpoint]=useState(typeof draft.agentEndpoint==='string'&&!sdkEndpointError(draft.agentEndpoint)?draft.agentEndpoint:SDK_AGENT_ENDPOINT);
 const [centerEndpoint,setCenterEndpoint]=useState<string|undefined>(typeof draft.centerEndpoint==='string'&&!sdkEndpointError(draft.centerEndpoint)?draft.centerEndpoint:undefined);
 useEffect(()=>{
  const abort=new AbortController();setLoading(true);setError('');
  api<SDKInstall>('/sdk-install',{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setSDK(value)}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'读取接入信息失败')}).finally(()=>{if(!abort.signal.aborted)setLoading(false)});
  return()=>abort.abort();
 },[refresh]);
 useEffect(()=>{
  try {sessionStorage.setItem(draftKey,JSON.stringify({language:sdkLanguage,mode:sdkMode,agentEndpoint:!sdkEndpointError(agentEndpoint)?agentEndpoint:undefined,centerEndpoint:centerEndpoint&&!sdkEndpointError(centerEndpoint)?centerEndpoint:undefined}));}catch{}
 },[sdkLanguage,sdkMode,agentEndpoint,centerEndpoint]);
 const requested=params.get('tab'),tab=requested==='agent'?'agent':'sdk';
 const sdkPackage=sdk?.packages?.find(item=>item.id===sdkLanguage),sdkExample=sdkExamples[sdkLanguage]??sdkExamples.typescript;
 const legacy=requested==='keys'?(user.role==='admin'?'/admin?tab=credentials&section=sdk':'/data?tab=sdk'):requested==='tables'?'/data-management':requested==='templates'?'/dashboards':undefined;
 if(legacy)return <Navigate to={legacy} replace/>;
 return <div className="lm-page">
  <div className="lm-page-heading"><div><h1>数据接入</h1><p>业务 SDK 可直连平台或通过 LightMoni Agent 上报；节点助手独立负责主机采集、目录日志和拨测。</p></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>setRefresh(value=>value+1)}>刷新接入状态</Button></div>
  {error&&<Alert type="error" showIcon title={error} action={<Button onClick={()=>setRefresh(value=>value+1)}>重试接入信息</Button>} style={{marginBottom:16}}/>}
  <Tabs activeKey={tab} onChange={tab=>setParams(previous=>{const next=new URLSearchParams(previous);next.set('tab',tab);return next})} destroyOnHidden items={[
      {key:'sdk',label:'SDK 接入',children:<div className="lm-surface">
        <Space wrap style={{marginBottom:14}}>
          <h2 style={{margin:0}}>SDK 接入</h2>
          <Select aria-label="SDK 语言" style={{minWidth:260}} value={sdkLanguage} onChange={setSDKLanguage}
            options={(sdk?.packages ?? []).filter(item=>sdkExamples[item.id]).map(item => ({value:item.id,label:item.language}))}/>
          {sdkPackage && <Tag>{sdkPackage.runtime}</Tag>}
          {user.role==='admin'&&<Button onClick={()=>setSDKReportingOpen(true)}>SDK 停报规则</Button>}
        </Space>
        {!!sdk?.deferred?.length&&<p>后续支持：{sdk.deferred.map(item=>item.language).join('、')}。暂不提供安装包。</p>}
        <p>下载源码包或 npm 安装包后，按所选语言的命令安装。解压包内包含 README 和可运行示例。</p>
        <Space wrap style={{marginBottom:14}}>
          <Button href={sdkPackage?.url} disabled={!sdkPackage?.available}>下载 SDK 与示例</Button>
          {sdk?.checksums_url && <Button href={sdk.checksums_url}>下载 SHA256 校验文件</Button>}
        </Space>
        {sdkPackage && !sdkPackage.available && <Alert type="warning" style={{marginBottom:14}} title="当前服务尚未打包此 SDK，请先构建 SDK 安装包。"/>}
        <CodeBlock code={sdkExample.install} language="bash" ariaLabel="SDK 安装命令"/>
        <SDKSetup language={sdkLanguage} mode={sdkMode} endpoint={sdkMode==='agent'?agentEndpoint:centerEndpoint??sdk?.endpoint??window.location.origin} defaultEndpoint={sdk?.endpoint??window.location.origin} reportingAddresses={sdk?.endpoints} defaultEndpointID={sdk?.default_endpoint_id} onModeChange={setSDKMode} onEndpointChange={sdkMode==='agent'?setAgentEndpoint:setCenterEndpoint} onResetEndpoint={()=>setCenterEndpoint(undefined)} onManageKeys={user.role==='admin'?()=>navigate('/admin?tab=credentials&section=sdk'):undefined}/>
        <p>所有 SDK 支持 Counter、Gauge、Histogram、日志和基础链路。SDK 默认报告实例心跳与内部诊断；Node.js、Python、Ruby 每 30 秒报告。退出前停止生产，再调用有截止时间的 shutdown。</p>
        <p>浏览器通过业务后端转发，后端保管仅允许目标 table 的 Key，页面无需保存私有 Key。</p>
      </div>},
      {key:'agent',label:'执行节点接入',children:<AgentInstall user={user} initialGroup={params.get('group')??undefined}/>},
  ]}/>
  <SDKReportingEditor open={sdkReportingOpen} onClose={()=>setSDKReportingOpen(false)}/>
 </div>;
}
