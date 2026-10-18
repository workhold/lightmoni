import {useEffect,useMemo,useState} from 'react';
import {Link} from 'react-router-dom';
import {CopyOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,App,AutoComplete,Button,Form,Input,Modal,Radio,Select,Space,Tag,Typography} from '../shared/ui';
import CodeBlock from '../shared/CodeBlock';
import ReportingAddressInput from './ReportingAddressInput';
import {ExemptTableEditor} from './SDKExemptTables';
import {SDK_LANGUAGES,recommendedExemptTables,sdkEndpointError,sdkEndpointIsLoopback,sdkEnvironment,sdkExamples,sdkSampleFor,validSDKTable,type SDKAuthMode,type SDKInstall} from './sdkExamples';
import {sdkError,type SDKKey,type SDKKeyValues,type CreatedSDKKey,type ExemptTable,type ExemptTableValues} from './sdk-onboarding';
import './sdk-setup.css';

export default function SDKSetup({install,keys,secrets,exempt,admin,ready,onCreateKey,onCreateExempt,onManageExempt}:{install?:SDKInstall;keys:SDKKey[];secrets:Record<string,string>;exempt:ExemptTable[];admin:boolean;ready:boolean;onCreateKey:(values:SDKKeyValues)=>Promise<CreatedSDKKey>;onCreateExempt:(values:ExemptTableValues)=>Promise<ExemptTable>;onManageExempt:()=>void}){
 const {message}=App.useApp();
 const [language,setLanguage]=useState('go'),[service,setService]=useState('order-api'),[table,setTable]=useState('business');
 const [authMode,setAuthMode]=useState<SDKAuthMode>('key'),[keyID,setKeyID]=useState<string>(),[endpointOverride,setEndpointOverride]=useState<string>();
 const [keyOpen,setKeyOpen]=useState(false),[creating,setCreating]=useState(false),[keyError,setKeyError]=useState('');
 const [keyDropdown,setKeyDropdown]=useState(false),[suggestion,setSuggestion]=useState<ExemptTableValues>();
 const suggestions=useMemo(()=>recommendedExemptTables(),[]),activeKeys=keys.filter(key=>key.active&&(key.allow_all_tables||key.allowed_tables.length)),activeExempt=exempt.filter(item=>item.active);
 const selectedKey=activeKeys.find(key=>key.id===keyID),anonymous=authMode==='anonymous';
 const endpoint=endpointOverride??install?.endpoint??location.origin,endpointError=sdkEndpointError(endpoint);
 const allowedTables=selectedKey?.allow_all_tables?undefined:selectedKey?.allowed_tables??[];
 const tableAllowed=validSDKTable(table)&&(anonymous?activeExempt.some(item=>item.name===table):!!selectedKey&&(selectedKey.allow_all_tables||selectedKey.allowed_tables.includes(table)));
 const serviceValid=!!service.trim()&&service.length<=128&&!/[\u0000-\u001f]/.test(service);
 const canGenerate=ready&&tableAllowed&&serviceValid&&!endpointError;
 const sampleOptions={table,service:service.trim(),authMode,key:keyID?secrets[keyID]:undefined,keyName:selectedKey?.name};
 const environment=sdkEnvironment('direct',endpoint,sampleOptions),sample=sdkSampleFor(language,'direct',endpoint,sampleOptions);
 const pkg=install?.packages.find(item=>item.id===language),example=sdkExamples[language];
 useEffect(()=>{if(ready&&keyID&&!activeKeys.some(key=>key.id===keyID))setKeyID(undefined);},[keys,ready,keyID]);
 useEffect(()=>{if(anonymous&&ready&&!activeExempt.some(item=>item.name===table))setTable(activeExempt[0]?.name??'');},[exempt,ready,anonymous]);
 const selectKey=(id:string)=>{const key=activeKeys.find(item=>item.id===id);setKeyID(id);if(key&&!key.allow_all_tables&&!key.allowed_tables.includes(table))setTable(key.allowed_tables[0]??'');};
 const changeMode=(mode:SDKAuthMode)=>{setAuthMode(mode);if(mode==='anonymous')setTable(activeExempt[0]?.name??'');else if(selectedKey&&!selectedKey.allow_all_tables)setTable(selectedKey.allowed_tables[0]??'business');else setTable('business');};
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);void message.success('已复制');}catch{void message.error('复制失败，请选择代码手动复制');}};
 const openCreate=()=>{setKeyDropdown(false);setKeyError('');setKeyOpen(true);};
 const createButton=<Button aria-label="创建 SDK 密钥" type="text" block icon={<PlusOutlined/>} disabled={!ready||!validSDKTable(table)} onMouseDown={event=>event.preventDefault()} onClick={openCreate}>创建 SDK 密钥</Button>;
 return <div className="lm-surface lm-sdk-workspace">
  <div className="lm-sdk-config">
   <div className="lm-sdk-section-heading"><div><h2>生成接入样例</h2><p>选择语言、目标表与认证方式，复制到业务服务中使用。</p></div><Tag>直连中心</Tag></div>
   <div className="lm-sdk-fields">
    <div><label htmlFor="sdk-language">SDK 语言</label><Select id="sdk-language" aria-label="SDK 语言" value={language} onChange={setLanguage} options={SDK_LANGUAGES}/></div>
    <div><label htmlFor="sdk-service">服务名称</label><Input id="sdk-service" aria-label="服务名称" value={service} maxLength={128} onChange={event=>setService(event.target.value)} status={serviceValid?'':'error'}/></div>
   </div>
   <div className="lm-sdk-auth">
    <label>认证方式</label><Radio.Group aria-label="SDK 认证方式" optionType="button" buttonStyle="solid" value={authMode} onChange={event=>changeMode(event.target.value)} options={[{label:'使用 SDK 密钥',value:'key'},{label:'无密钥模式',value:'anonymous'}]}/>
   </div>
   <div className="lm-sdk-fields lm-sdk-auth-fields" key={authMode}>
    {!anonymous&&<div><label htmlFor="sdk-key">SDK 密钥</label><Select id="sdk-key" aria-label="SDK 密钥" placeholder={admin?'选择 SDK 密钥':'请由管理员创建 SDK 密钥'} value={keyID} onChange={selectKey} disabled={!ready||!admin} open={keyDropdown} onOpenChange={setKeyDropdown} showSearch optionFilterProp="label" options={activeKeys.map(key=>({value:key.id,label:key.name}))} notFoundContent={activeKeys.length?'没有匹配的密钥':createButton} popupRender={menu=>activeKeys.length?<div>{menu}{admin&&<div className="lm-sdk-create-footer">{createButton}</div>}</div>:menu}/></div>}
    <div><label htmlFor="sdk-table">{anonymous?'豁免逻辑表':'逻辑表名'}</label>{anonymous?<Select id="sdk-table" aria-label="豁免逻辑表" placeholder="选择已启用的豁免表" disabled={!ready||!activeExempt.length} value={table||undefined} onChange={setTable} options={activeExempt.map(item=>({value:item.name,label:item.description?`${item.description} · ${item.name}`:item.name}))}/>:!selectedKey||selectedKey.allow_all_tables?<AutoComplete id="sdk-table" aria-label="逻辑表名" value={table} onChange={setTable} options={[{value:'business'}]}><Input maxLength={48}/></AutoComplete>:<Select id="sdk-table" aria-label="逻辑表名" value={table} onChange={setTable} options={allowedTables?.map(value=>({value,label:value}))}/>}
     {!validSDKTable(table)&&!anonymous&&<Typography.Text type="danger">小写字母开头，最长 48 位，不带 SQL 表前缀。</Typography.Text>}
    </div>
   </div>
   {!anonymous&&<p className="lm-sdk-hint">{selectedKey?(secrets[selectedKey.id]?'新密钥已选中并带入环境变量，请及时保存完整值。':'此密钥仅保存摘要，请在环境变量中填入你保存的完整密钥。'):'先选择 SDK 密钥；新建时只需填写名称，自动授权当前逻辑表。'}</p>}
   {anonymous&&<div className="lm-sdk-anonymous">
    <Alert type="info" showIcon title="仅允许写入已启用的豁免表" description="建议使用带随机后缀的复杂表名。知道豁免表名的客户端即可上报，其他表仍需要密钥。"/>
    {!activeExempt.length&&<p>尚无可用豁免表。{admin?'选择常见用途，确认添加后即可接入。':'请联系管理员添加豁免表。'}</p>}
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
   {canGenerate?<CodeBlock code={environment} language="bash" ariaLabel="SDK 环境变量"/>:<div className="lm-sdk-awaiting">{!ready?'接入配置尚未加载，请重试刷新。':anonymous?'选择已启用的豁免表后生成无密钥样例。':!selectedKey?'选择或创建 SDK 密钥后生成接入样例。':'请填写有效的服务名称、逻辑表名和上报地址。'}</div>}
   <div className="lm-sdk-section-heading"><h3>3. 业务接入 Demo</h3><Button aria-label="复制接入样例" type="primary" icon={<CopyOutlined/>} disabled={!canGenerate} onClick={()=>void copy(sample)}>复制接入样例</Button></div>
   {canGenerate&&<CodeBlock code={sample} language={example.language} ariaLabel="业务接入 SDK 示例"/>}
   <p className="lm-sdk-hint">样例包含指标、日志和链路。退出前调用 shutdown，完成待发送数据的上报。</p>
  </div>
  <Modal title="创建 SDK 密钥" open={keyOpen} onCancel={()=>{if(!creating)setKeyOpen(false);}} footer={null} destroyOnHidden>
   <p>允许写入：<Typography.Text code>{table}</Typography.Text></p><Form layout="vertical" onFinish={async(values:{name:string})=>{if(!validSDKTable(table))return;setCreating(true);setKeyError('');try{const result=await onCreateKey({name:values.name.trim(),allowed_tables:[table],allow_all_tables:false});setKeyID(result.id);setKeyOpen(false);void message.success('SDK 密钥已创建并选中');}catch(error){setKeyError(sdkError(error));}finally{setCreating(false);}}}>
    <Form.Item name="name" label="密钥名称" rules={[{required:true,whitespace:true,message:'请输入密钥名称'}]}><Input aria-label="密钥名称" placeholder="例如：订单服务生产环境" disabled={creating} maxLength={128}/></Form.Item>
    {keyError&&<Alert type="error" showIcon title={keyError} className="lm-sdk-form-error"/>}<Button type="primary" htmlType="submit" loading={creating}>创建并选择</Button>
   </Form>
  </Modal>
  {suggestion&&<ExemptTableEditor initial={suggestion} onClose={()=>setSuggestion(undefined)} onCreate={onCreateExempt} onSaved={item=>{setSuggestion(undefined);setTable(item.name);void message.success('豁免表已添加并选中');}}/>}
 </div>;
}
