import {useI18n} from '../shared/i18n';
import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {App,Alert,Button,Space,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api,post} from '../shared/api';
import SDKKeySettings from './SDKKeySettings';

type EnrollmentStatus='issued'|'pending_activation'|'active'|'expired'|'cancelled';
interface Enrollment {
  id:string; status:EnrollmentStatus; endpoint_origin:string; version:string; initial_label_id:string;
  created_at:string; expires_at:string; pending_expires_at?:string; used_at?:string; agent_id?:string;
}
interface Credential {
  id:string;agent_id:string;audience:'control'|'data';scope:string;created_at:string;last_used_at?:string;
  expires_at:string;revoked_at?:string;revoke_reason?:string;status:'active'|'expired'|'revoked';
}

function useCredentialList<T>(path:string) {
 const {t}=useI18n();
const errorText=(error:unknown)=>error instanceof Error?error.message:t("操作失败","Operation failed");

  const [items,setItems]=useState<T[]>([]),[loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void api<T[]>(path,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setItems(value);setLoaded(true)}}).catch(error=>{if(!controller.signal.aborted)setError(errorText(error))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
    return()=>controller.abort();
  },[path,revision]);
  return {items,loading,loaded,error,refresh:()=>setRevision(value=>value+1)};
}

function AgentEnrollments() {
 const {t,language:uiLanguage}=useI18n();
const errorText=(error:unknown)=>error instanceof Error?error.message:t("操作失败","Operation failed");
const dateText=(value?:string)=>value?new Date(value).toLocaleString(uiLanguage):'—';
const enrollmentStates:Record<EnrollmentStatus,{label:string;color:string}>={
  issued:{label:t("待接入","Awaiting enrollment"),color:'blue'},pending_activation:{label:t("待激活","Awaiting activation"),color:'warning'},active:{label:t("已接入","Enrolled"),color:'success'},expired:{label:t("已过期","Expired"),color:'default'},cancelled:{label:t("已撤销","Revoked"),color:'default'},
};

  const {message,modal}=App.useApp(),list=useCredentialList<Enrollment>('/agent-enrollments');
  const [actionError,setActionError]=useState('');
  return <div className="lm-surface">
    <div className="lm-toolbar"><Space wrap><Link to="/machines"><Button type="primary">{t("前往主机管理部署 Agent","Deploy Agent from Hosts")}</Button></Link><Button icon={<ReloadOutlined/>} loading={list.loading} onClick={list.refresh}>{t("刷新令牌","Refresh tokens")}</Button></Space></div>
    <p>{t("一次性令牌由平台在已登记主机的部署流程中内部签发，不再提供独立脚本签发。撤销待激活令牌会阻止该安装继续激活；已接入 Agent 的 control/data 凭据可在「节点凭据」管理。","The platform issues one-time tokens internally when deploying Agent to a registered host. Standalone script tokens are no longer issued. Revoking a pending token blocks activation. Manage Agent control/data credentials under Node credentials.")}</p>
    <p>{t("仅展示最近 200 条签发记录。","Showing the latest 200 issued tokens.")}</p>
    {list.error&&<Alert type="error" showIcon title={t("Agent 接入令牌加载失败","Unable to load Agent enrollment tokens")} description={list.error} action={<Button size="small" onClick={list.refresh}>{t("重试","Retry")}</Button>} style={{marginBottom:16}}/>}
    {actionError&&<Alert type="error" closable onClose={()=>setActionError('')} title={actionError} style={{marginBottom:16}}/>}
    {(list.loaded||list.loading)&&<Table rowKey="id" loading={list.loading} dataSource={list.items} scroll={{x:1450}} locale={{emptyText:list.loading?t("正在加载令牌…","Loading tokens…"):t("尚无 Agent 接入令牌","No Agent enrollment tokens yet")}} columns={[
      {title:t("令牌 ID","Token ID"),dataIndex:'id',width:210,render:(value:string)=><Typography.Text copyable code>{value}</Typography.Text>},
      {title:t("状态","Status"),dataIndex:'status',width:100,render:(value:EnrollmentStatus)=><Tag color={enrollmentStates[value]?.color}>{enrollmentStates[value]?.label??value}</Tag>},
      {title:t("接入地址","Enrollment address"),dataIndex:'endpoint_origin',width:230},
      {title:t("初始任务标签","Initial task label"),dataIndex:'initial_label_id',width:150},
      {title:t("Agent 版本","Agent version"),dataIndex:'version',width:120},
      {title:t("签发时间","Issued at"),dataIndex:'created_at',width:180,render:dateText},
      {title:t("有效期至","Expires at"),width:180,render:(_:unknown,item:Enrollment)=>dateText(item.pending_expires_at&&new Date(item.pending_expires_at)<new Date(item.expires_at)?item.pending_expires_at:item.expires_at)},
      {title:t("节点 ID","Node ID"),dataIndex:'agent_id',width:200,render:(value?:string)=>value?<Typography.Text code>{value}</Typography.Text>:'—'},
      {title:t("操作","Actions"),width:110,render:(_:unknown,item:Enrollment)=><Button size="small" danger disabled={!['issued','pending_activation'].includes(item.status)} onClick={()=>modal.confirm({
        title:t("撤销此 Agent 接入令牌？","Revoke this Agent enrollment token?"),content:item.status==='pending_activation'?t("该令牌已兑换但节点尚未激活。撤销后此安装无法继续激活，请回到主机管理重新生成部署计划。","This token has been redeemed, but the node has not activated. Revoking it blocks activation; return to Hosts to create a new deployment plan."):t("撤销后无法使用此令牌安装或接入节点，请回到主机管理重新生成部署计划。","After revocation, this token cannot install or enroll a node. Create a new deployment plan from Hosts."),
        okText:t("撤销令牌","Revoke token"),okButtonProps:{danger:true},onOk:async()=>{setActionError('');try{await post(`/agent-enrollments/${encodeURIComponent(item.id)}/revoke`,{});list.refresh();void message.success(t("接入令牌已撤销","Enrollment token revoked"))}catch(error){setActionError(errorText(error));throw error}},
      })}>{t("撤销令牌","Revoke token")}</Button>},
    ]}/>}
  </div>;
}

function AgentCredentials() {
 const {t,language:uiLanguage}=useI18n();
const errorText=(error:unknown)=>error instanceof Error?error.message:t("操作失败","Operation failed");
const dateText=(value?:string)=>value?new Date(value).toLocaleString(uiLanguage):'—';

  const {message,modal}=App.useApp(),list=useCredentialList<Credential>('/agent-credentials');
  const [actionError,setActionError]=useState('');
  return <div className="lm-surface">
    <div className="lm-toolbar"><Space wrap><Link to="/agents">{t("查看执行节点","View execution nodes")}</Link><Button icon={<ReloadOutlined/>} loading={list.loading} onClick={list.refresh}>{t("刷新节点凭据","Refresh node credentials")}</Button></Space></div>
    <p>{t("control 用于节点心跳和配置拉取；data 用于节点向平台上报遥测。凭据绑定节点，不与 SDK 上报密钥互换；不提供明文查看、下载或重新生成。","control credentials authorize node heartbeats and configuration retrieval; data credentials authorize telemetry reporting. Credentials are bound to a node and cannot replace SDK reporting keys. Their secrets cannot be viewed, downloaded, or regenerated here.")}</p>
    <p>{t("SDK 向本地 Agent 上报使用的本地 token 由目标 Agent 配置管理，不在中心签发或回显。仅展示最近 200 条节点凭据。","Local tokens for SDK reporting to an Agent are managed in that Agent's configuration, not issued or displayed by the platform. Showing the latest 200 node credentials.")}</p>
    {list.error&&<Alert type="error" showIcon title={t("节点凭据加载失败","Unable to load node credentials")} description={list.error} action={<Button size="small" onClick={list.refresh}>{t("重试","Retry")}</Button>} style={{marginBottom:16}}/>}
    {actionError&&<Alert type="error" closable onClose={()=>setActionError('')} title={actionError} style={{marginBottom:16}}/>}
    {(list.loaded||list.loading)&&<Table rowKey="id" loading={list.loading} dataSource={list.items} scroll={{x:1650}} locale={{emptyText:list.loading?t("正在加载节点凭据…","Loading node credentials…"):t("尚无节点凭据","No node credentials yet")}} columns={[
      {title:t("节点 ID","Node ID"),dataIndex:'agent_id',width:210,render:(value:string)=><Typography.Text copyable code>{value}</Typography.Text>},
      {title:t("凭据 ID","Credential ID"),dataIndex:'id',width:210,render:(value:string)=><Typography.Text code>{value}</Typography.Text>},
      {title:t("用途","Purpose"),dataIndex:'audience',width:160,render:(value:Credential['audience'])=><Tag color={value==='control'?'blue':'purple'}>{value==='control'?t("control · 控制通道","control · Control channel"):t("data · 遥测上报","data · Telemetry reporting")}</Tag>},
      {title:t("权限","Permissions"),dataIndex:'scope',width:150},
      {title:t("状态","Status"),dataIndex:'status',width:90,render:(value:Credential['status'])=><Tag color={value==='active'?'success':'default'}>{{active:t("有效","Active"),expired:t("已过期","Expired"),revoked:t("已撤销","Revoked")}[value]}</Tag>},
      {title:t("签发时间","Issued at"),dataIndex:'created_at',width:180,render:dateText},
      {title:t("有效期至","Expires at"),dataIndex:'expires_at',width:180,render:dateText},
      {title:t("最近使用","Last used"),dataIndex:'last_used_at',width:180,render:(value?:string)=>value?dateText(value):t("尚未使用","Never used")},
      {title:t("撤销时间","Revoked at"),dataIndex:'revoked_at',width:180,render:dateText},
      {title:t("撤销原因","Revocation reason"),dataIndex:'revoke_reason',width:160,render:(value?:string)=>value||'—'},
      {title:t("操作","Actions"),width:190,render:(_:unknown,item:Credential)=><Button size="small" danger disabled={item.status==='revoked'} onClick={()=>modal.confirm({
        title:t(`撤销此节点全部 ${item.audience} 凭据？`,`Revoke all ${item.audience} credentials for this node?`),
        content:<><p>{t(`将撤销节点 ${item.agent_id} 的 ${item.audience} 用途所有未撤销凭据，包含该用途的其他签发记录。`,`Revoke all unrevoked ${item.audience} credentials for node ${item.agent_id}, including other credentials issued for this purpose.`)}</p><p>{item.audience==='control'?t("节点将无法心跳或拉取配置。","The node will be unable to send heartbeats or retrieve configuration."):t("节点将无法向平台上报遥测数据。","The node will be unable to report telemetry to the platform.")}{' '}{t("需要重新接入节点才能恢复该用途。","Enroll the node again to restore access for this purpose.")}</p></>,
        okText:t(`撤销全部 ${item.audience} 凭据`,`Revoke all ${item.audience} credentials`),okButtonProps:{danger:true},onOk:async()=>{setActionError('');try{await post(`/agents/${encodeURIComponent(item.agent_id)}/credentials/revoke`,{audience:item.audience,reason:'管理员在接入凭据管理中撤销'});list.refresh();void message.success(t(`该节点全部 ${item.audience} 凭据已撤销`,`All ${item.audience} credentials for this node revoked`))}catch(error){setActionError(errorText(error));throw error}},
      })}>{t("撤销该用途全部凭据","Revoke all for this purpose")}</Button>},
    ]}/>}
  </div>;
}

export default function AccessCredentialsSettings() {
 const {t}=useI18n();

  const [params,setParams]=useSearchParams();
  const requested=params.get('section'),section=['sdk','enrollments','agents'].includes(requested??'')?requested!:'sdk';
  return <div>
    <h2>{t("接入凭据","Access credentials")}</h2>
    <p>{t("统一管理 SDK 与 LightMoni Agent 的接入身份，按用途分别授权和撤销。","Manage SDK and LightMoni Agent identities in one place, with separate authorization and revocation for each purpose.")}</p>
    <Tabs activeKey={section} destroyOnHidden onChange={value=>setParams(previous=>{const next=new URLSearchParams(previous);next.set('section',value);return next})} items={[
      {key:'sdk',label:t("SDK 上报密钥","SDK reporting keys"),children:section==='sdk'?<SDKKeySettings/>:null},
      {key:'enrollments',label:t("Agent 接入令牌","Agent enrollment tokens"),children:section==='enrollments'?<AgentEnrollments/>:null},
      {key:'agents',label:t("节点凭据","Node credentials"),children:section==='agents'?<AgentCredentials/>:null},
    ]}/>
  </div>;
}
