import {useMemo} from 'react';
import {CopyOutlined} from '@ant-design/icons';
import {Alert,App,Button,Input,Radio,Space,Tag,Typography} from '../shared/ui';
import CodeBlock from '../shared/CodeBlock';
import {sdkEndpointError,sdkEndpointIsLoopback,sdkEnvironment,sdkExamples,sdkSampleFor,type SDKConnectionMode} from './sdkExamples';
import './sdk-setup.css';

export default function SDKSetup({language,mode,endpoint,onModeChange,onEndpointChange,onManageKeys}:{language:string;mode:SDKConnectionMode;endpoint:string;onModeChange:(mode:SDKConnectionMode)=>void;onEndpointChange:(value:string)=>void;onManageKeys?:()=>void}){
 const {message}=App.useApp(),direct=mode==='direct',error=sdkEndpointError(endpoint);
 const sample=useMemo(()=>sdkSampleFor(language,mode),[language,mode]),environment=useMemo(()=>sdkEnvironment(mode,endpoint),[mode,endpoint]);
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);void message.success('已复制');}catch{void message.error('复制失败，请选择代码手动复制');}};
 return <div className="lm-sdk-setup">
  <h3>上报方式</h3>
  <Radio.Group aria-label="SDK 上报方式" optionType="button" buttonStyle="solid" value={mode} onChange={event=>onModeChange(event.target.value)} options={[{label:'通过 Agent',value:'agent'},{label:'直连中心',value:'direct'}]}/>
  <p className="lm-sdk-mode-description">{direct?'业务服务 → 中心。适用于容器、Serverless 或没有 Agent 的服务，SDK 携带上报 Key 直接发送。':'业务服务 → Agent → 中心。业务使用 Agent 地址，由 Agent 保存中心 Key，并提供本地磁盘队列。'}</p>
  <div className="lm-sdk-endpoint">
   <label htmlFor="sdk-report-endpoint">{direct?'中心上报地址':'Agent 上报地址'}</label>
   <Input id="sdk-report-endpoint" aria-label="SDK 上报地址" value={endpoint} status={error?'error':undefined} maxLength={2048} onChange={event=>onEndpointChange(event.target.value)} placeholder={direct?'https://monitor.example.com':'http://127.0.0.1:4318'}/>
   {error?<Typography.Text type="danger">{error}</Typography.Text>:<Typography.Text type="secondary">填写基础地址，SDK 自动追加 /v1/metrics、/v1/logs 或 /v1/traces。</Typography.Text>}
  </div>
  {direct&&<Alert className="lm-sdk-container-note" type={sdkEndpointIsLoopback(endpoint)?'warning':'info'} showIcon title="容器上报地址" description="容器中的 localhost / 127.0.0.1 指向业务容器本身。请填写容器可访问的中心域名或服务地址；同一 Docker 网络可用 http://lightmoni:8080，Docker Desktop 访问宿主机可用 host.docker.internal。"/>}
  <Space wrap className="lm-sdk-key-help"><Typography.Text>{direct?'中心 Key 需允许写入 business 表，通过环境变量或容器 Secret 注入。':'业务 SDK 无需中心 Key；Agent 启用本地访问令牌时，将该令牌设为 LIGHTMONI_KEY。'}</Typography.Text>{direct&&onManageKeys&&<Button size="small" onClick={onManageKeys}>管理上报 Key</Button>}</Space>
  <Alert type="info" showIcon title="SDK 自监控" description="默认上报实例心跳、缓冲队列与重试、丢弃等诊断，自动写入系统 SDK 表。可在「系统监控 · SDK」大盘查看并配置告警，业务 Key 无需增加权限。PHP 长驻进程请每 30 秒调用 flush。"/>
  <h3>环境变量</h3>
  <p>先将下面的变量配置到业务进程；容器部署时写入容器的 environment 或 Secret。</p>
  <CodeBlock code={environment} language="bash" ariaLabel="SDK 环境变量"/>
  <Button icon={<CopyOutlined/>} disabled={!!error} onClick={()=>void copy(environment)}>复制环境变量</Button>
  <div className="lm-sdk-example-heading"><h3>业务接入示例</h3>{language==='typescript'&&<Tag>Node.js 服务端</Tag>}</div>
  <CodeBlock code={sample} language={sdkExamples[language]?.language??'typescript'} ariaLabel="业务接入 SDK 示例"/>
  <Button type="primary" icon={<CopyOutlined/>} disabled={!!error} onClick={()=>void copy(sample)}>复制接入样例</Button>
  <p className="lm-sdk-mode-description">{direct?'直连使用 SDK 的进程内缓冲与重试；需要本地磁盘缓存时可选择 Agent。':'Agent 的中心 Key 需允许 business 表；业务可以通过服务名或地址访问远程 Agent。'}使用 withTable / with_table 切换表时，Key 也需允许对应 table。</p>
 </div>;
}
