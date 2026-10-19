import {useI18n} from '../shared/i18n';
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
 const {t,language:uiLanguage}=useI18n();

 const {message}=App.useApp(),direct=mode==='direct',error=sdkEndpointError(endpoint,uiLanguage);
 const sample=useMemo(()=>sdkSampleFor(language,mode,endpoint),[language,mode,endpoint]),environment=useMemo(()=>sdkEnvironment(mode,endpoint),[mode,endpoint]);
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);void message.success(t("已复制","Copied"));}catch{void message.error(t("复制失败，请选择代码手动复制","Unable to copy. Select and copy the code manually"));}};
 return <div className="lm-sdk-setup">
  <h3>{t("上报方式","Reporting mode")}</h3>
  <Radio.Group aria-label={t("SDK 上报方式","SDK reporting mode")} optionType="button" buttonStyle="solid" value={mode} onChange={event=>onModeChange(event.target.value)} options={[{label:t("直连平台","Direct to platform"),value:'direct'},{label:t("通过 LightMoni Agent","Through LightMoni Agent"),value:'agent'}]}/>
  <p className="lm-sdk-mode-description">{direct?t("业务 SDK → LightMoni 平台。适用于普通服务器、容器和 Serverless；只需配置平台地址与业务 data key，无需安装或启动 Agent。","Business SDK → LightMoni platform. Suitable for servers, containers, and serverless. Configure only the platform address and business data key; no Agent installation is required."):t("业务 SDK → LightMoni Agent → 平台。SDK 配置 Agent 地址，Agent 独立管理平台连接、上报凭据和本地持久队列。","Business SDK → LightMoni Agent → platform. Configure the Agent address in the SDK. The Agent independently manages the platform connection, reporting credentials, and local persistent queue.")}</p>
  <div className="lm-sdk-endpoint">
   <label htmlFor="sdk-report-endpoint">{direct?t("平台上报地址","Platform reporting address"):t("Agent 接收地址","Agent receiver address")}</label>
   <ReportingAddressInput id="sdk-report-endpoint" label={t("SDK 上报地址","SDK reporting address")} value={endpoint} onChange={onEndpointChange} addresses={direct?reportingAddresses:[]} defaultID={defaultEndpointID} error={error} placeholder={direct?t("选择内网或公网地址","Select an internal or public address"):'http://127.0.0.1:4318'}/>
   {error?<Typography.Text type="danger">{error}</Typography.Text>:<Typography.Text type="secondary">{t("填写基础地址，SDK 自动追加 /v1/metrics、/v1/logs 或 /v1/traces。","Enter the base address. The SDK appends /v1/metrics, /v1/logs, or /v1/traces automatically.")}</Typography.Text>}
  </div>
  {direct&&<Space wrap><Typography.Text type="secondary">{t("选择已配置的内网或公网地址，也可临时填写其他地址。","Select a configured internal or public address, or temporarily enter another address.")}</Typography.Text><Button size="small" disabled={endpoint===defaultEndpoint} onClick={onResetEndpoint}>{t("恢复默认地址","Restore default address")}</Button>{onManageKeys&&<Link to="/admin?tab=reporting">{t("设置默认地址","Set default address")}</Link>}</Space>}
  <Alert className="lm-sdk-container-note" type={sdkEndpointIsLoopback(endpoint)?'warning':'info'} showIcon title={t("容器上报地址","Container reporting address")} description={direct?t("容器中的 localhost / 127.0.0.1 指向业务容器本身。请填写容器可访问的平台域名或服务地址；同一 Docker 网络可用 http://lightmoni:8080，Docker Desktop 访问宿主机可用 host.docker.internal。","Inside a container, localhost / 127.0.0.1 points to the business container itself. Use a platform address reachable from that container. On the same Docker network, use http://lightmoni:8080; Docker Desktop can reach the host via host.docker.internal."):t("容器中的 localhost / 127.0.0.1 指向业务容器本身。Agent 在其他容器或宿主机时，请填写业务容器可访问的 Agent 地址；同一 Docker 网络可用 http://lightmoni-agent:4318，Docker Desktop 访问宿主机可用 host.docker.internal。","Inside a container, localhost / 127.0.0.1 points to the business container itself. If the Agent runs elsewhere, enter an Agent address reachable from the business container. On the same Docker network, use http://lightmoni-agent:4318; Docker Desktop can reach the host via host.docker.internal.")}/>
  <Space wrap className="lm-sdk-key-help"><Typography.Text>{direct?t("平台 data key 需允许写入 business 表，通过 LIGHTMONI_DATA_KEY 或容器 Secret 注入。","The platform data key must allow writes to the business table. Inject it through LIGHTMONI_DATA_KEY or a container Secret."):t("业务 SDK 无需配置平台地址或平台上报凭据。仅在 Agent 启用本地鉴权时注入 LIGHTMONI_LOCAL_TOKEN。","The business SDK needs no platform address or platform reporting credentials. Inject LIGHTMONI_LOCAL_TOKEN only when local authentication is enabled on the Agent.")}</Typography.Text>{direct&&onManageKeys&&<Button size="small" onClick={onManageKeys}>{t("管理接入凭据","Manage access credentials")}</Button>}</Space>
  <Alert type="info" showIcon title={t("SDK 自监控","SDK self-monitoring")} description={t("默认上报实例心跳、缓冲队列与重试、丢弃等诊断，自动写入系统 SDK 表。可在「系统监控 · SDK」大盘查看并配置告警，业务 Key 无需增加权限。","Instance heartbeats, buffer status, retries, and dropped-data diagnostics are reported to the system SDK table by default. View them and configure alerts in the System monitoring · SDK dashboard. No additional business-key permissions are required.")}/>
  <h3>{t("环境变量","Environment variables")}</h3>
  <p>{t("先将下面的变量配置到业务进程；复制执行会清理另一种方式及旧凭据来源，避免切换冲突。容器部署时按所选方式配置 environment 或 Secret。","Configure these variables in the business process. Running the copied commands clears the other mode and legacy credential sources to prevent conflicts. For containers, configure environment variables or Secrets for the selected mode.")}</p>
  <CodeBlock code={environment} language="bash" ariaLabel={t("SDK 环境变量","SDK environment variables")}/>
  <Button icon={<CopyOutlined/>} disabled={!!error} onClick={()=>void copy(environment)}>{t("复制环境变量","Copy environment variables")}</Button>
  <div className="lm-sdk-example-heading"><h3>{t("业务接入示例","Business integration example")}</h3>{language==='typescript'&&<Tag>{t("Node.js 服务端","Node.js server")}</Tag>}</div>
  <CodeBlock code={sample} language={sdkExamples[language]?.language??'typescript'} ariaLabel={t("业务接入 SDK 示例","Business SDK integration example")}/>
  <Button type="primary" icon={<CopyOutlined/>} disabled={!!error} onClick={()=>void copy(sample)}>{t("复制接入样例","Copy integration example")}</Button>
  <p className="lm-sdk-mode-description">{direct?t("直连使用 SDK 的有限进程内缓冲与重试；业务重启或缓冲超限可能丢失尚未上报的数据。需要独立的磁盘队列时可选择 Agent。","Direct reporting uses the SDK's bounded in-process buffer and retries. Restarts or buffer overflow may lose unsent data. Choose Agent mode if you need an independent disk queue."):t("Agent 成功响应表示批次已被本地持久队列接收，不代表平台已经入库；队列有容量和重放期限限制。Agent 的上报凭据需允许 business 表。","An Agent success response confirms receipt in its local persistent queue, not ingestion by the platform. Queue capacity and replay age are limited. Agent reporting credentials must allow the business table.")}{' '}{t("失败时不会自动改投另一条路径；重试仍使用原路径。使用 withTable / with_table 切换表时，上报凭据也需允许对应 table。","Failures do not switch reporting modes; retries use the original path. When switching tables with withTable / with_table, reporting credentials must allow the selected table.")}</p>
 </div>;
}
