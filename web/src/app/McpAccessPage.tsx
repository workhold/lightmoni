import {useEffect,useState} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {ApiOutlined,PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Checkbox,Descriptions,Form,Input,InputNumber,Modal,Select,Space,Spin,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api,post} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {User} from '../shared/types';
import './mcp-access.css';

interface Grant {id:string;name:string;scopes:string[];host_ids:string[]|null;created_at:string;expires_at:string;revoked_at?:string;used_at?:string;active?:boolean;client_id?:string}
interface Client {id:string;name:string;redirect_uris:string[];created_at:string;revoked_at?:string}
interface AccessData {endpoint:string;scopes:string[];tokens:Grant[];grants:Grant[];clients:Client[]}
interface Machine {id:string;name:string}
interface OAuthRequest {client_id:string;redirect_uri:string;response_type:string;code_challenge:string;code_challenge_method:string;resource:string;state?:string;scope:string}
interface ConsentData {endpoint:string;client:Client;request:OAuthRequest;scopes:string[]}
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const command=(endpoint:string)=>`codex mcp add lightmoni --url '${endpoint.replaceAll("'","'\\''")}' --bearer-token-env-var LIGHTMONI_MCP_TOKEN`;

function useMachines(user:User){
 const [machines,setMachines]=useState<Machine[]>([]),[error,setError]=useState('');
 useEffect(()=>{if(user.role!=='admin')return;const controller=new AbortController();void api<Machine[]>('/machines',{signal:controller.signal}).then(setMachines).catch(error=>{if(!controller.signal.aborted)setError(errorText(error))});return()=>controller.abort()},[user.role]);
 return {machines,error};
}
function scopeLabel(scope:string,t:(zh:string,en:string)=>string){
 const labels:Record<string,[string,string]>={
  'hosts.read':['主机信息','Host information'],'tasks.read':['任务元数据','Task metadata'],'tasks.source.read':['任务脚本源码','Task script source'],'tasks.propose':['创建任务操作提案','Propose task operations'],
  'executions.read':['执行记录','Execution records'],'telemetry.catalog.read':['遥测数据目录','Telemetry catalog'],'alerts.read':['告警规则目录','Alert rule catalog'],
 };
 const value=labels[scope];return value?t(...value):scope;
}
function Targets({machines,error,all,onAll}:{machines:Machine[];error:string;all:boolean;onAll:(all:boolean)=>void}){
 const {t}=useI18n();
 return <><Form.Item label={t('主机授权范围','Authorized hosts')}><Checkbox checked={all} onChange={event=>onAll(event.target.checked)}>{t('所有主机，包含以后登记的主机','All hosts, including hosts registered later')}</Checkbox></Form.Item>
  {!all&&<Form.Item name="host_ids" label={t('选择主机','Select hosts')} rules={[{required:true,type:'array',min:1,message:t('请选择主机或明确授权所有主机','Select hosts or explicitly authorize all hosts')}]}><Select mode="multiple" optionFilterProp="label" placeholder={t('选择允许访问的已登记主机','Select registered hosts this client can access')} options={machines.map(machine=>({label:`${machine.name} · ${machine.id}`,value:machine.id}))}/></Form.Item>}
  {error&&<Alert type="error" showIcon title={t('主机列表加载失败','Unable to load hosts')} description={error}/>}
 </>;
}
function Lifetime(){const {t}=useI18n();return <Form.Item name="expires_in_hours" label={t('授权有效期（小时）','Authorization lifetime (hours)')} rules={[{required:true,type:'number',min:1,max:8760,message:t('请输入 1–8760 小时','Enter 1–8760 hours')}]}><InputNumber min={1} max={8760} precision={0} style={{width:'100%'}}/></Form.Item>}

export default function McpAccessPage({user}:{user:User}){
 const {t,language}=useI18n(),{message,modal}=App.useApp(),{machines,error:machinesError}=useMachines(user);
 const [data,setData]=useState<AccessData>(),[loading,setLoading]=useState(true),[error,setError]=useState(''),[actionError,setActionError]=useState('');
 const [tokenOpen,setTokenOpen]=useState(false),[clientOpen,setClientOpen]=useState(false),[allHosts,setAllHosts]=useState(false),[busy,setBusy]=useState(false),[secret,setSecret]=useState('');
 const [tokenForm]=Form.useForm(),[clientForm]=Form.useForm();
 async function load(){setLoading(true);setError('');try{setData(await api<AccessData>('/mcp-access'))}catch(error){setError(errorText(error))}finally{setLoading(false)}}
 useEffect(()=>{void load();return()=>setSecret('')},[]);
 const date=(value?:string)=>value?new Date(value).toLocaleString(language):'—';
 const target=(ids:string[]|null)=>ids===null?t('所有主机','All hosts'):ids.map(id=>machines.find(machine=>machine.id===id)?.name??id).join(' · ')||t('无主机权限','No host access');
 async function remove(kind:'tokens'|'grants'|'clients',id:string){setActionError('');try{await api(`/mcp-access/${kind}/${encodeURIComponent(id)}`,{method:'DELETE'});await load();void message.success(t('已撤销','Revoked'))}catch(error){setActionError(errorText(error));throw error}}
 const revoke=(kind:'tokens'|'grants'|'clients',item:{id:string;name:string})=>modal.confirm({title:t('撤销此接入授权？','Revoke this access?'),content:item.name,okText:t('撤销','Revoke'),cancelText:t('取消','Cancel'),okButtonProps:{danger:true},onOk:()=>remove(kind,item.id)});
 const grantColumns=(kind:'tokens'|'grants')=>[
  {title:t('名称','Name'),dataIndex:'name',width:170},
  {title:t('能力范围','Capabilities'),dataIndex:'scopes',width:260,render:(scopes:string[])=>scopes.map(scope=><Tag key={scope}>{scope}</Tag>)},
  {title:t('主机范围','Hosts'),dataIndex:'host_ids',width:220,render:target},
  {title:t('状态','Status'),width:90,render:(_:unknown,item:Grant)=><Tag color={item.active?'success':'default'}>{item.revoked_at?t('已撤销','Revoked'):item.active?t('有效','Active'):t('已过期','Expired')}</Tag>},
  {title:t('有效期至','Expires at'),dataIndex:'expires_at',width:180,render:date},
  {title:t('操作','Actions'),width:100,render:(_:unknown,item:Grant)=><Button danger size="small" disabled={!item.active} onClick={()=>revoke(kind,item)}>{t('撤销','Revoke')}</Button>},
 ];
 return <div className="lm-page lm-mcp-page">
  <div className="lm-page-heading"><div><h1><ApiOutlined aria-hidden/> {t('MCP 接入','MCP access')}</h1><p>{t('让本地 AI 客户端使用你的平台权限访问 LightMoni。','Allow a local AI client to access LightMoni with your platform permissions.')}</p></div><Button icon={<ReloadOutlined aria-hidden/>} loading={loading} onClick={()=>void load()}>{t('刷新','Refresh')}</Button></div>
  <Alert showIcon type="info" title={t('首期开放查询与操作提案，提案需要在平台审阅后执行。','This release supports queries and operation proposals. Review proposals in the platform before execution.')} description={t('MCP 凭据与 SDK、Agent、SSH 凭据分开；授权不会提升当前账号的权限。','MCP credentials are separate from SDK, Agent, and SSH credentials. Authorization does not elevate your account permissions.')}/>
  {error&&<Alert showIcon type="error" title={error} action={<Button onClick={()=>void load()}>{t('重试','Retry')}</Button>}/>}
  {actionError&&<Alert showIcon type="error" closable title={actionError} onClose={()=>setActionError('')}/>}
  {loading&&!data?<Spin/>:data&&<>
   <section className="lm-surface lm-mcp-connect"><h2>{t('连接客户端','Connect a client')}</h2><Descriptions size="small" column={1} items={[{key:'endpoint',label:t('MCP 地址','MCP endpoint'),children:<Typography.Text copyable code>{data.endpoint}</Typography.Text>}]}/>
    <p>{t('支持 Streamable HTTP。OAuth 客户端需先登记客户端 ID 与回调地址，再从客户端发起浏览器授权；本页管理已授予的权限。','Uses Streamable HTTP. Register an OAuth client ID and redirect URIs, then start browser authorization from the client. Manage granted access here.')}</p>
    <p>{t('对于支持自定义 Bearer Token 的客户端，可先创建个人令牌。将令牌配置到启动客户端的受保护环境中，变量名使用 LIGHTMONI_MCP_TOKEN，然后执行：','For clients supporting a custom Bearer token, create a personal token. Configure it in the protected environment used to launch the client as LIGHTMONI_MCP_TOKEN, then run:')}</p>
    <Typography.Paragraph className="lm-mcp-command" copyable={{text:command(data.endpoint)}}><code>{command(data.endpoint)}</code></Typography.Paragraph>
    <p>{t('Claude 或其他客户端请填写上述服务地址，并按客户端支持的 OAuth 或 Bearer 配置接入。客户端版本与授权方式需匹配，不能把 SDK 上报密钥用于此处。','For Claude or another client, use the endpoint above with its supported OAuth or Bearer configuration. Match the client version and authorization method; SDK reporting keys cannot be used here.')}</p>
   </section>
   {!data.scopes.length&&<Alert type="info" showIcon title={t('当前账号没有可授予的 MCP 能力','This account has no grantable MCP capabilities')}/>}
   <Tabs destroyOnHidden items={[
    {key:'tokens',label:t('个人令牌','Personal tokens'),children:<section className="lm-surface"><div className="lm-toolbar"><Button type="primary" icon={<PlusOutlined aria-hidden/>} disabled={!data.scopes.length} onClick={()=>{tokenForm.resetFields();setAllHosts(false);setTokenOpen(true)}}>{t('创建令牌','Create token')}</Button></div><Table rowKey="id" columns={grantColumns('tokens')} dataSource={data.tokens} pagination={{pageSize:10}} scroll={{x:1100}}/></section>},
    {key:'grants',label:t('OAuth 授权','OAuth grants'),children:<section className="lm-surface"><Table rowKey="id" columns={grantColumns('grants')} dataSource={data.grants} pagination={{pageSize:10}} scroll={{x:1100}}/></section>},
    {key:'clients',label:t('OAuth 客户端','OAuth clients'),children:<section className="lm-surface"><div className="lm-toolbar"><Button icon={<PlusOutlined aria-hidden/>} disabled={!data.scopes.length} onClick={()=>{clientForm.resetFields();setClientOpen(true)}}>{t('登记客户端','Register client')}</Button></div><Table rowKey="id" dataSource={data.clients} pagination={{pageSize:10}} scroll={{x:850}} columns={[
     {title:t('名称','Name'),dataIndex:'name'}, {title:'Client ID',dataIndex:'id',render:(id:string)=><Typography.Text copyable code>{id}</Typography.Text>},
     {title:t('回调地址','Redirect URIs'),dataIndex:'redirect_uris',render:(uris:string[])=>uris.map(uri=><div key={uri}><Typography.Text code>{uri}</Typography.Text></div>)},
     {title:t('操作','Actions'),render:(_:unknown,item:Client)=><Button danger size="small" disabled={!!item.revoked_at} onClick={()=>revoke('clients',item)}>{item.revoked_at?t('已撤销','Revoked'):t('撤销','Revoke')}</Button>},
    ]}/></section>},
   ]}/>
  </>}
  <Modal title={t('创建个人令牌','Create personal token')} open={tokenOpen} forceRender mask={{closable:false}} confirmLoading={busy} okText={t('创建令牌','Create token')} cancelText={t('取消','Cancel')} onCancel={()=>{if(!busy)setTokenOpen(false)}} onOk={()=>tokenForm.submit()}>
   <Form name="mcp-token" form={tokenForm} layout="vertical" initialValues={{expires_in_hours:168,scopes:[],host_ids:[]}} disabled={busy} onFinish={async values=>{setBusy(true);try{const result=await post<{token:string}>('/mcp-access/tokens',{name:values.name,scopes:values.scopes,host_ids:allHosts?null:values.host_ids,expires_in_hours:values.expires_in_hours});setSecret(result.token);setTokenOpen(false);await load()}catch(error){void message.error(errorText(error))}finally{setBusy(false)}}}>
    <Form.Item name="name" label={t('名称','Name')} rules={[{required:true,whitespace:true,message:t('请输入名称','Enter a name')},{max:100}]}><Input autoComplete="off" placeholder={t('例如：我的 Codex','For example: My Codex')}/></Form.Item>
    <Form.Item name="scopes" label={t('允许调用的能力','Allowed capabilities')} rules={[{required:true,type:'array',min:1,message:t('请选择至少一种能力','Select at least one capability')}]}><Select mode="multiple" options={(data?.scopes??[]).map(scope=>({value:scope,label:`${scopeLabel(scope,t)} · ${scope}`}))}/></Form.Item>
    <Targets machines={machines} error={machinesError} all={allHosts} onAll={setAllHosts}/><Lifetime/>
   </Form>
  </Modal>
  <Modal title={t('保存新令牌','Save the new token')} open={!!secret} mask={{closable:false}} destroyOnHidden onCancel={()=>setSecret('')} footer={<Button type="primary" onClick={()=>setSecret('')}>{t('我已保存，关闭','I saved it, close')}</Button>}>
   <p>{t('令牌仅在本次创建后显示；关闭后无法再次查看。请保存到客户端的凭据存储或受保护环境中。','The token is displayed only after creation and cannot be viewed again after closing. Store it in the client credential store or a protected environment.')}</p>
   <Typography.Paragraph code copyable={{text:secret}} className="lm-mcp-secret" data-testid="mcp-new-token">{secret}</Typography.Paragraph>
  </Modal>
  <Modal title={t('登记 OAuth 客户端','Register OAuth client')} open={clientOpen} forceRender mask={{closable:false}} confirmLoading={busy} okText={t('登记','Register')} cancelText={t('取消','Cancel')} onCancel={()=>{if(!busy)setClientOpen(false)}} onOk={()=>clientForm.submit()}>
   <Form name="mcp-client" form={clientForm} layout="vertical" disabled={busy} onFinish={async values=>{setBusy(true);try{await post('/mcp-access/clients',{name:values.name,redirect_uris:values.redirect_uris.split(/\r?\n/).map((uri:string)=>uri.trim()).filter(Boolean)});setClientOpen(false);await load();void message.success(t('客户端已登记，请复制 Client ID 配置到客户端','Client registered. Copy its Client ID to the client configuration.'))}catch(error){void message.error(errorText(error))}finally{setBusy(false)}}}>
    <Form.Item name="name" label={t('客户端名称','Client name')} rules={[{required:true,whitespace:true},{max:100}]}><Input autoComplete="off"/></Form.Item>
    <Form.Item name="redirect_uris" label={t('回调地址（每行一个）','Redirect URIs (one per line)')} extra={t('填写客户端实际使用的 HTTPS 或本机 loopback 回调地址。平台会校验地址与授权请求是否匹配。','Enter HTTPS or local loopback redirect URIs actually used by the client. The platform validates them against authorization requests.')} rules={[{required:true,whitespace:true}]}><Input.TextArea rows={4} autoComplete="off" placeholder="http://127.0.0.1:1455/callback"/></Form.Item>
   </Form>
  </Modal>
 </div>;
}

export function McpAuthorizationPage({user}:{user:User}){
 const {t}=useI18n(),location=useLocation(),navigate=useNavigate(),{machines,error:machinesError}=useMachines(user),{message}=App.useApp();
 const [data,setData]=useState<ConsentData>(),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[allHosts,setAllHosts]=useState(false),[form]=Form.useForm();
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setData(undefined);setAllHosts(false);void api<ConsentData>('/mcp/oauth/request'+location.search,{signal:controller.signal}).then(setData).catch(error=>{if(!controller.signal.aborted)setError(errorText(error))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[location.search,form]);
 useEffect(()=>{if(data)form.resetFields()},[data,form]);
 return <div className="lm-page lm-mcp-page lm-mcp-consent"><div className="lm-page-heading"><div><h1>{t('授权 MCP 客户端','Authorize MCP client')}</h1><p>{t('检查客户端、能力范围和主机目标，再决定是否允许访问。','Review the client, capabilities, and host targets before allowing access.')}</p></div></div>
  {loading?<Spin/>:error?<Alert showIcon type="error" title={t('授权请求无效或已失效','Invalid or expired authorization request')} description={error}/>:data&&<section className="lm-surface">
   <Descriptions column={1} bordered size="small" items={[
    {key:'client',label:t('客户端','Client'),children:<><strong>{data.client.name}</strong><br/><Typography.Text code>{data.client.id}</Typography.Text></>},
    {key:'user',label:t('授权账号','Account'),children:user.nickname||user.name},
    {key:'endpoint',label:t('资源服务','Resource server'),children:<Typography.Text code>{data.endpoint}</Typography.Text>},
    {key:'redirect',label:t('完成后返回','Return to'),children:<Typography.Text code>{data.request.redirect_uri}</Typography.Text>},
    {key:'scopes',label:t('请求能力','Requested capabilities'),children:data.scopes.map(scope=><div key={scope}><Tag>{scope}</Tag>{scopeLabel(scope,t)}</div>)},
   ]}/>
   <Alert showIcon type="info" title={t('查询与操作提案','Queries and operation proposals')} description={t('授权不允许客户端代替你批准操作；主机变更仍需在平台审阅。任务脚本源码读取是独立权限。','Authorization does not allow the client to approve operations for you. Host changes still require platform review. Task source access is a separate permission.')}/>
   <Form name="mcp-consent" form={form} key={location.search} layout="vertical" initialValues={{host_ids:[],expires_in_hours:168}} disabled={busy} onFinish={async values=>{setBusy(true);try{const result=await post<{redirect_url:string}>('/mcp/oauth/approve',{...data.request,host_ids:allHosts?null:values.host_ids,expires_in_hours:values.expires_in_hours});window.location.assign(result.redirect_url)}catch(error){void message.error(errorText(error));setBusy(false)}}}>
    <Targets machines={machines} error={machinesError} all={allHosts} onAll={setAllHosts}/><Lifetime/>
    <Space><Button type="primary" htmlType="submit" loading={busy}>{t('允许访问','Allow access')}</Button><Button disabled={busy} onClick={()=>navigate('/mcp-access')}>{t('取消授权','Cancel authorization')}</Button></Space>
   </Form>
  </section>}
 </div>;
}
