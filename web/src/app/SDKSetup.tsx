import {useMemo} from 'react';
import {Link} from 'react-router-dom';
import {CopyOutlined} from '@ant-design/icons';
import {Alert,App,Button,Radio,Space,Tag,Typography} from '../shared/ui';
import CodeBlock from '../shared/CodeBlock';
import {sdkEndpointError,sdkEndpointIsLoopback,sdkEnvironment,sdkExamples,sdkSampleFor,type SDKConnectionMode} from './sdkExamples';
import ReportingAddressInput from './ReportingAddressInput';
import type {ReportingAddress} from './reporting-addresses';
import './sdk-setup.css';

export default function SDKSetup({language,mode,endpoint,defaultEndpoint,reportingAddresses,defaultEndpointID,onModeChange,onEndpointChange,onResetEndpoint,onManageKeys}:{language:string;mode:SDKConnectionMode;endpoint:string;defaultEndpoint:string;reportingAddresses?:ReportingAddress[];defaultEndpointID?:string;onModeChange:(mode:SDKConnectionMode)=>void;onEndpointChange:(value:string)=>void;onResetEndpoint:()=>void;onManageKeys?:()=>void}){
 const {message}=App.useApp(),direct=mode==='direct',error=sdkEndpointError(endpoint);
 const sample=useMemo(()=>sdkSampleFor(language,mode,endpoint),[language,mode,endpoint]),environment=useMemo(()=>sdkEnvironment(mode,endpoint),[mode,endpoint]);
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);void message.success('已复制');}catch{void message.error('复制失败，请选择代码手动复制');}};
 return <div className="lm-sdk-setup">
  <h3>上报方式</h3>
  <Radio.Group aria-label="SDK 上报方式" optionType="button" buttonStyle="solid" value={mode} onChange={event=>onModeChange(event.target.value)} options={[{label:'直连平台',value:'direct'},{label:'通过 LightMoni Agent',value:'agent'}]}/>
  <p className="lm-sdk-mode-description">{direct?'业务 SDK → LightMoni 平台。适用于普通服务器、容器和 Serverless；只需配置平台地址与业务 data key，无需安装或启动 Agent。':'业务 SDK → LightMoni Agent → 平台。SDK 配置 Agent 地址，Agent 独立管理平台连接、上报凭据和本地持久队列。'}</p>
  <div className="lm-sdk-endpoint">
   <label htmlFor="sdk-report-endpoint">{direct?'平台上报地址':'Agent 接收地址'}</label>
   <ReportingAddressInput id="sdk-report-endpoint" label="SDK 上报地址" value={endpoint} onChange={onEndpointChange} addresses={direct?reportingAddresses:[]} defaultID={defaultEndpointID} error={error} placeholder={direct?'选择内网或公网地址':'http://127.0.0.1:4318'}/>
   {error?<Typography.Text type="danger">{error}</Typography.Text>:<Typography.Text type="secondary">填写基础地址，SDK 自动追加 /v1/metrics、/v1/logs 或 /v1/traces。</Typography.Text>}
  </div>
  {direct&&<Space wrap><Typography.Text type="secondary">选择已配置的内网或公网地址，也可临时填写其他地址。</Typography.Text><Button size="small" disabled={endpoint===defaultEndpoint} onClick={onResetEndpoint}>恢复默认地址</Button>{onManageKeys&&<Link to="/admin?tab=reporting">设置默认地址</Link>}</Space>}
  <Alert className="lm-sdk-container-note" type={sdkEndpointIsLoopback(endpoint)?'warning':'info'} showIcon title="容器上报地址" description={direct?'容器中的 localhost / 127.0.0.1 指向业务容器本身。请填写容器可访问的平台域名或服务地址；同一 Docker 网络可用 http://lightmoni:8080，Docker Desktop 访问宿主机可用 host.docker.internal。':'容器中的 localhost / 127.0.0.1 指向业务容器本身。Agent 在其他容器或宿主机时，请填写业务容器可访问的 Agent 地址；同一 Docker 网络可用 http://lightmoni-agent:4318，Docker Desktop 访问宿主机可用 host.docker.internal。'}/>
  <Space wrap className="lm-sdk-key-help"><Typography.Text>{direct?'平台 data key 需允许写入 business 表，通过 LIGHTMONI_DATA_KEY 或容器 Secret 注入。':'业务 SDK 无需配置平台地址或平台上报凭据。仅在 Agent 启用本地鉴权时注入 LIGHTMONI_LOCAL_TOKEN。'}</Typography.Text>{direct&&onManageKeys&&<Button size="small" onClick={onManageKeys}>管理上报 Key</Button>}</Space>
  <Alert type="info" showIcon title="SDK 自监控" description="默认上报实例心跳、缓冲队列与重试、丢弃等诊断，自动写入系统 SDK 表。可在「系统监控 · SDK」大盘查看并配置告警，业务 Key 无需增加权限。PHP 长驻进程请每 30 秒调用 flush。"/>
  <h3>环境变量</h3>
  <p>先将下面的变量配置到业务进程；复制执行会清理另一种方式及旧凭据来源，避免切换冲突。容器部署时按所选方式配置 environment 或 Secret。</p>
  <CodeBlock code={environment} language="bash" ariaLabel="SDK 环境变量"/>
  <Button icon={<CopyOutlined/>} disabled={!!error} onClick={()=>void copy(environment)}>复制环境变量</Button>
  <div className="lm-sdk-example-heading"><h3>业务接入示例</h3>{language==='typescript'&&<Tag>Node.js 服务端</Tag>}</div>
  <CodeBlock code={sample} language={sdkExamples[language]?.language??'typescript'} ariaLabel="业务接入 SDK 示例"/>
  <Button type="primary" icon={<CopyOutlined/>} disabled={!!error} onClick={()=>void copy(sample)}>复制接入样例</Button>
  <p className="lm-sdk-mode-description">{direct?'直连使用 SDK 的有限进程内缓冲与重试；业务重启或缓冲超限可能丢失尚未上报的数据。需要独立的磁盘队列时可选择 Agent。':'Agent 成功响应表示批次已被本地持久队列接收，不代表平台已经入库；队列有容量和重放期限限制。Agent 的上报凭据需允许 business 表。'}失败时不会自动改投另一条路径；重试仍使用原路径。使用 withTable / with_table 切换表时，上报凭据也需允许对应 table。</p>
 </div>;
}
