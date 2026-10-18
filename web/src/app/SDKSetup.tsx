import {useEffect,useMemo,useState} from 'react';
import {Link} from 'react-router-dom';
import {CopyOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,App,Button,Form,Input,Modal,Radio,Select,Space,Tag,Typography} from '../shared/ui';
import CodeBlock from '../shared/CodeBlock';
import ReportingAddressInput from './ReportingAddressInput';
import {ExemptTableEditor} from './SDKExemptTables';
import {SDK_LANGUAGES,recommendedExemptTables,sdkEndpointError,sdkEndpointIsLoopback,sdkEnvironment,sdkExamples,sdkSampleFor,type SDKAuthMode,type SDKInstall} from './sdkExamples';
import {sdkError,type SDKKey,type SDKKeyValues,type CreatedSDKKey,type ExemptTable,type ExemptTableValues} from './sdk-onboarding';
import {sdkMetricQuery} from './sdkMetricQueries';
import './sdk-setup.css';

export default function SDKSetup({install,keys,secrets,exempt,admin,ready,onCreateKey,onCreateExempt,onManageExempt}:{install?:SDKInstall;keys:SDKKey[];secrets:Record<string,string>;exempt:ExemptTable[];admin:boolean;ready:boolean;onCreateKey:(values:SDKKeyValues)=>Promise<CreatedSDKKey>;onCreateExempt:(values:ExemptTableValues)=>Promise<ExemptTable>;onManageExempt:()=>void}){
 const {message}=App.useApp();
 const [language,setLanguage]=useState('go'),[service,setService]=useState('order-api'),[env,setEnv]=useState('test'),[version,setVersion]=useState(''),[instanceID,setInstanceID]=useState('');
 const [authMode,setAuthMode]=useState<SDKAuthMode>('key'),[keyID,setKeyID]=useState<string>(),[endpointOverride,setEndpointOverride]=useState<string>();
 const [keyOpen,setKeyOpen]=useState(false),[creating,setCreating]=useState(false),[keyError,setKeyError]=useState('');
 const [keyDropdown,setKeyDropdown]=useState(false),[suggestion,setSuggestion]=useState<ExemptTableValues>();
 const suggestions=useMemo(()=>recommendedExemptTables(),[]),activeKeys=keys.filter(key=>key.active),activeExempt=exempt.filter(item=>item.active);
 const selectedKey=activeKeys.find(key=>key.id===keyID),anonymous=authMode==='anonymous';
 const endpoint=endpointOverride??install?.endpoint??location.origin,endpointError=sdkEndpointError(endpoint);
 const identityValid=[env,version,instanceID].every(value=>value.length<=128&&!/[\u0000-\u001f]/.test(value))&&!!env.trim();
 const serviceValid=!!service.trim()&&service.length<=128&&!/[\u0000-\u001f]/.test(service);
 const canGenerate=ready&&(anonymous||!!selectedKey)&&serviceValid&&identityValid&&!endpointError;
 const sampleOptions={service:service.trim(),env:env.trim(),service_version:version.trim()||undefined,instance_id:instanceID.trim()||undefined,authMode,key:keyID?secrets[keyID]:undefined,keyName:selectedKey?.name};
 const environment=sdkEnvironment('direct',endpoint,sampleOptions),sample=sdkSampleFor(language,'direct',endpoint,sampleOptions);
 const pkg=install?.packages.find(item=>item.id===language),example=sdkExamples[language];
 useEffect(()=>{if(ready&&keyID&&!activeKeys.some(key=>key.id===keyID))setKeyID(undefined);},[keys,ready,keyID]);
 const selectKey=(id:string)=>setKeyID(id);
 const changeMode=(mode:SDKAuthMode)=>setAuthMode(mode);
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);void message.success('已复制');}catch{void message.error('复制失败，请选择代码手动复制');}};
 const openCreate=()=>{setKeyDropdown(false);setKeyError('');setKeyOpen(true);};
 const createButton=<Button aria-label="创建 SDK 密钥" type="text" block icon={<PlusOutlined/>} disabled={!ready} onMouseDown={event=>event.preventDefault()} onClick={openCreate}>创建 SDK 密钥</Button>;
 return <div className="lm-surface lm-sdk-workspace">
  <div className="lm-sdk-config">
   <div className="lm-sdk-section-heading"><div><h2>生成接入样例</h2><p>选择语言与认证方式，初始化后按业务需要指定上报表。</p></div><Tag>直连中心</Tag></div>
   <div className="lm-sdk-fields">
    <div><label htmlFor="sdk-language">SDK 语言</label><Select id="sdk-language" aria-label="SDK 语言" value={language} onChange={setLanguage} options={SDK_LANGUAGES}/></div>
    <div><label htmlFor="sdk-service">服务名称</label><Input id="sdk-service" aria-label="服务名称" value={service} maxLength={128} onChange={event=>setService(event.target.value)} status={serviceValid?'':'error'}/></div>
   </div>
   <div className="lm-sdk-fields"><div><label htmlFor="sdk-env">环境</label><Input id="sdk-env" aria-label="环境" placeholder="test / prod" value={env} maxLength={128} onChange={event=>setEnv(event.target.value)} status={env.trim()?'':'error'}/></div></div>
   <details className="lm-sdk-optional"><summary>可选实例信息</summary><div className="lm-sdk-fields"><div><label htmlFor="sdk-version">服务版本</label><Input id="sdk-version" aria-label="服务版本" value={version} maxLength={128} onChange={event=>setVersion(event.target.value)} placeholder="例如：1.2.0"/></div><div><label htmlFor="sdk-instance">实例 ID</label><Input id="sdk-instance" aria-label="实例 ID" value={instanceID} maxLength={128} onChange={event=>setInstanceID(event.target.value)} placeholder="留空时自动生成"/></div></div></details>
   <div className="lm-sdk-auth">
    <label>认证方式</label><Radio.Group aria-label="SDK 认证方式" optionType="button" buttonStyle="solid" value={authMode} onChange={event=>changeMode(event.target.value)} options={[{label:'使用 SDK 密钥',value:'key'},{label:'无密钥模式',value:'anonymous'}]}/>
   </div>
   <div className="lm-sdk-fields lm-sdk-auth-fields" key={authMode}>
    {!anonymous&&<div><label htmlFor="sdk-key">SDK 密钥</label><Select id="sdk-key" aria-label="SDK 密钥" placeholder={admin?'选择 SDK 密钥':'请由管理员创建 SDK 密钥'} value={keyID} onChange={selectKey} disabled={!ready||!admin} open={keyDropdown} onOpenChange={setKeyDropdown} showSearch optionFilterProp="label" options={activeKeys.map(key=>({value:key.id,label:key.name}))} notFoundContent={activeKeys.length?'没有匹配的密钥':createButton} popupRender={menu=>activeKeys.length?<div>{menu}{admin&&<div className="lm-sdk-create-footer">{createButton}</div>}</div>:menu}/></div>}
   </div>
   {!anonymous&&<p className="lm-sdk-hint">{selectedKey?(secrets[selectedKey.id]?'新密钥已选中并带入环境变量，请及时保存完整值。':'此密钥仅保存摘要，请在环境变量中填入你保存的完整密钥。'):'选择或创建 SDK 密钥，即可向任意业务表上报。'}</p>}
   {anonymous&&<div className="lm-sdk-anonymous">
    <Alert type="info" showIcon title="仅允许写入已启用的豁免表" description="建议使用带随机后缀的复杂表名。知道豁免表名的客户端即可上报，其他表会被拒绝；无密钥 SDK 不上报自身日志、指标或事件。"/>
    {!activeExempt.length&&<p>尚无可用豁免表。{admin?'可先复制初始化样例，再按业务需要注册豁免表。':'请联系管理员添加豁免表。'}</p>}
    {!!activeExempt.length&&<p>已启用：{activeExempt.map(item=><Typography.Text code key={item.name}>{item.name} </Typography.Text>)}。无需在初始化时选择，在实际写入时指定表名。</p>}
    <div className="lm-sdk-recommendations">{suggestions.map(item=><div className="lm-sdk-recommendation" key={item.name}><div><strong>{item.description}</strong><Typography.Text code>{item.name}</Typography.Text></div>{admin&&<Button aria-label="添加" size="small" icon={<PlusOutlined/>} disabled={!ready} onClick={()=>setSuggestion(item)}>添加</Button>}</div>)}</div>
    <Button type="link" onClick={onManageExempt}>管理豁免表</Button>
   </div>}
   <div className="lm-sdk-endpoint"><label htmlFor="sdk-report-endpoint">中心上报地址</label><ReportingAddressInput id="sdk-report-endpoint" label="SDK 上报地址" value={endpoint} onChange={setEndpointOverride} addresses={install?.endpoints} defaultID={install?.default_endpoint_id} error={endpointError}/>{endpointError&&<Typography.Text type="danger">{endpointError}</Typography.Text>}</div>
   {sdkEndpointIsLoopback(endpoint)&&<p className="lm-sdk-hint">容器中的 localhost 指向业务容器本身，请使用容器可访问的中心地址，例如 host.docker.internal。</p>}
   <Space wrap><Button size="small" disabled={endpointOverride===undefined} onClick={()=>setEndpointOverride(undefined)}>恢复默认地址</Button>{admin&&<Link to="/admin?tab=reporting">配置上报地址</Link>}<Link to="/agents/install">接入执行节点</Link></Space>
  </div>
  <div className="lm-sdk-output">
   <div className="lm-sdk-section-heading"><h3>1. 安装 SDK</h3><Space wrap>{pkg?.runtime&&<Tag>{pkg.runtime}</Tag>}<Button aria-label="复制安装命令" size="small" icon={<CopyOutlined/>} onClick={()=>void copy(example.install)}>复制安装命令</Button><Button size="small" href={pkg?.url} disabled={!pkg?.available}>下载 SDK 与 Demo</Button></Space></div>
   {pkg&&!pkg.available&&<Alert type="warning" title="当前服务尚未打包此 SDK，请先生成安装包。"/>}
   <CodeBlock code={example.install} language="bash" ariaLabel="SDK 安装命令"/>
   <div className="lm-sdk-section-heading"><h3>2. 设置环境变量</h3><Button aria-label="复制环境变量" size="small" icon={<CopyOutlined/>} disabled={!canGenerate} onClick={()=>void copy(environment)}>复制环境变量</Button></div>
   {canGenerate?<CodeBlock code={environment} language="bash" ariaLabel="SDK 环境变量"/>:<div className="lm-sdk-awaiting">{!ready?'接入配置尚未加载，请重试刷新。':!anonymous&&!selectedKey?'选择或创建 SDK 密钥后生成接入样例。':'请填写有效的服务名称、环境和上报地址。'}</div>}
   <div className="lm-sdk-section-heading"><h3>3. 业务接入 Demo</h3><Button aria-label="复制接入样例" type="primary" icon={<CopyOutlined/>} disabled={!canGenerate} onClick={()=>void copy(sample)}>复制接入样例</Button></div>
   {canGenerate&&<CodeBlock code={sample} language={example.language} ariaLabel="业务接入 SDK 示例"/>}
   <p className="lm-sdk-hint">每次请求后调用 record，传入表、指标名、业务维度、总值和数量；逐次打点数量填 1，SDK 自动聚合发送。</p><p className="lm-sdk-hint">请替换 your_table 后接入业务代码。</p>
   <div className="lm-sdk-section-heading"><h3>4. 查询业务指标</h3><Button aria-label="复制指标查询" size="small" icon={<CopyOutlined/>} disabled={!identityValid||!serviceValid} onClick={()=>void copy(sdkMetricQuery('your_table',service.trim(),env.trim()))}>复制指标查询</Button></div>
   <p className="lm-sdk-hint">替换 your_table 后查询最近 5 分钟的数据。示例按 key1、key2 汇总；其他维度可加入筛选或分组。数量是打点人数或请求数，平均值为总值除以数量。</p><p className="lm-sdk-hint">分布数据不完整时，最小值、最大值和 P 值为空；数量、总值和平均值仍可用。</p>
   <CodeBlock code={sdkMetricQuery('your_table',service.trim(),env.trim())} language="sql" ariaLabel="业务指标查询 SQL"/>

  </div>
  <Modal title="创建 SDK 密钥" open={keyOpen} onCancel={()=>{if(!creating)setKeyOpen(false);}} footer={null} destroyOnHidden>
   <p>启用后可向任意业务表上报。</p><Form layout="vertical" onFinish={async(values:{name:string})=>{setCreating(true);setKeyError('');try{const result=await onCreateKey({name:values.name.trim()});setKeyID(result.id);setKeyOpen(false);void message.success('SDK 密钥已创建并选中');}catch(error){setKeyError(sdkError(error));}finally{setCreating(false);}}}>
    <Form.Item name="name" label="密钥名称" rules={[{required:true,whitespace:true,message:'请输入密钥名称'}]}><Input aria-label="密钥名称" placeholder="例如：订单服务生产环境" disabled={creating} maxLength={128}/></Form.Item>
    {keyError&&<Alert type="error" showIcon title={keyError} className="lm-sdk-form-error"/>}<Button type="primary" htmlType="submit" loading={creating}>创建并选择</Button>
   </Form>
  </Modal>
  {suggestion&&<ExemptTableEditor initial={suggestion} onClose={()=>setSuggestion(undefined)} onCreate={onCreateExempt} onSaved={()=>{setSuggestion(undefined);void message.success('豁免表已添加');}}/>}
 </div>;
}
