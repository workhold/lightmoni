import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {App,Alert,Button,Modal,Space,Table,Tabs,Tag,Typography} from '../shared/ui';
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
const errorText=(error:unknown)=>error instanceof Error?error.message:'操作失败';
const dateText=(value?:string)=>value?new Date(value).toLocaleString():'—';

function useCredentialList<T>(path:string) {
  const [items,setItems]=useState<T[]>([]),[loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void api<T[]>(path,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setItems(value);setLoaded(true)}}).catch(error=>{if(!controller.signal.aborted)setError(errorText(error))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
    return()=>controller.abort();
  },[path,revision]);
  return {items,loading,loaded,error,refresh:()=>setRevision(value=>value+1)};
}

const enrollmentStates:Record<EnrollmentStatus,{label:string;color:string}>={
  issued:{label:'待接入',color:'blue'},pending_activation:{label:'待激活',color:'warning'},active:{label:'已接入',color:'success'},expired:{label:'已过期',color:'default'},cancelled:{label:'已撤销',color:'default'},
};
function AgentEnrollments() {
  const {message}=App.useApp(),list=useCredentialList<Enrollment>('/agent-enrollments');
  const [actionError,setActionError]=useState('');
  return <div className="lm-surface">
    <div className="lm-toolbar"><Space wrap><Link to="/data?tab=agent"><Button type="primary">生成 Agent 接入令牌</Button></Link><Button icon={<ReloadOutlined/>} loading={list.loading} onClick={list.refresh}>刷新令牌</Button></Space></div>
    <p>一次性令牌用于新节点接入，明文只在生成时显示。撤销待激活令牌会同时阻止该安装继续激活；已接入节点的 control/data 凭据请到「节点凭据」管理。</p>
    <p>仅展示最近 200 条签发记录。</p>
    {list.error&&<Alert type="error" showIcon title="Agent 接入令牌加载失败" description={list.error} action={<Button size="small" onClick={list.refresh}>重试</Button>} style={{marginBottom:16}}/>}
    {actionError&&<Alert type="error" closable onClose={()=>setActionError('')} title={actionError} style={{marginBottom:16}}/>}
    {(list.loaded||list.loading)&&<Table rowKey="id" loading={list.loading} dataSource={list.items} scroll={{x:1450}} locale={{emptyText:list.loading?'正在加载令牌…':'尚无 Agent 接入令牌'}} columns={[
      {title:'令牌 ID',dataIndex:'id',width:210,render:(value:string)=><Typography.Text copyable code>{value}</Typography.Text>},
      {title:'状态',dataIndex:'status',width:100,render:(value:EnrollmentStatus)=><Tag color={enrollmentStates[value]?.color}>{enrollmentStates[value]?.label??value}</Tag>},
      {title:'接入地址',dataIndex:'endpoint_origin',width:230},
      {title:'初始任务标签',dataIndex:'initial_label_id',width:150},
      {title:'Agent 版本',dataIndex:'version',width:120},
      {title:'签发时间',dataIndex:'created_at',width:180,render:dateText},
      {title:'有效期至',width:180,render:(_:unknown,item:Enrollment)=>dateText(item.pending_expires_at&&new Date(item.pending_expires_at)<new Date(item.expires_at)?item.pending_expires_at:item.expires_at)},
      {title:'节点 ID',dataIndex:'agent_id',width:200,render:(value?:string)=>value?<Typography.Text code>{value}</Typography.Text>:'—'},
      {title:'操作',width:110,render:(_:unknown,item:Enrollment)=><Button size="small" danger disabled={!['issued','pending_activation'].includes(item.status)} onClick={()=>Modal.confirm({
        title:'撤销此 Agent 接入令牌？',content:item.status==='pending_activation'?'该令牌已兑换但节点尚未激活。撤销后此安装无法继续激活，需要重新生成令牌并接入。':'撤销后无法使用此令牌安装或接入节点，需要重新生成令牌。',
        okText:'撤销令牌',okButtonProps:{danger:true},onOk:async()=>{setActionError('');try{await post(`/agent-enrollments/${encodeURIComponent(item.id)}/revoke`,{});list.refresh();void message.success('接入令牌已撤销')}catch(error){setActionError(errorText(error));throw error}},
      })}>撤销令牌</Button>},
    ]}/>}
  </div>;
}

function AgentCredentials() {
  const {message}=App.useApp(),list=useCredentialList<Credential>('/agent-credentials');
  const [actionError,setActionError]=useState('');
  return <div className="lm-surface">
    <div className="lm-toolbar"><Space wrap><Link to="/agents">查看执行节点</Link><Button icon={<ReloadOutlined/>} loading={list.loading} onClick={list.refresh}>刷新节点凭据</Button></Space></div>
    <p>control 用于节点心跳和配置拉取；data 用于节点向平台上报遥测。凭据绑定节点，不与 SDK 上报密钥互换；不提供明文查看、下载或重新生成。</p>
    <p>SDK 向本地 Agent 上报使用的本地 token 由目标 Agent 配置管理，不在中心签发或回显。仅展示最近 200 条节点凭据。</p>
    {list.error&&<Alert type="error" showIcon title="节点凭据加载失败" description={list.error} action={<Button size="small" onClick={list.refresh}>重试</Button>} style={{marginBottom:16}}/>}
    {actionError&&<Alert type="error" closable onClose={()=>setActionError('')} title={actionError} style={{marginBottom:16}}/>}
    {(list.loaded||list.loading)&&<Table rowKey="id" loading={list.loading} dataSource={list.items} scroll={{x:1650}} locale={{emptyText:list.loading?'正在加载节点凭据…':'尚无节点凭据'}} columns={[
      {title:'节点 ID',dataIndex:'agent_id',width:210,render:(value:string)=><Typography.Text copyable code>{value}</Typography.Text>},
      {title:'凭据 ID',dataIndex:'id',width:210,render:(value:string)=><Typography.Text code>{value}</Typography.Text>},
      {title:'用途',dataIndex:'audience',width:160,render:(value:Credential['audience'])=><Tag color={value==='control'?'blue':'purple'}>{value==='control'?'control · 控制通道':'data · 遥测上报'}</Tag>},
      {title:'权限',dataIndex:'scope',width:150},
      {title:'状态',dataIndex:'status',width:90,render:(value:Credential['status'])=><Tag color={value==='active'?'success':'default'}>{{active:'有效',expired:'已过期',revoked:'已撤销'}[value]}</Tag>},
      {title:'签发时间',dataIndex:'created_at',width:180,render:dateText},
      {title:'有效期至',dataIndex:'expires_at',width:180,render:dateText},
      {title:'最近使用',dataIndex:'last_used_at',width:180,render:(value?:string)=>value?dateText(value):'尚未使用'},
      {title:'撤销时间',dataIndex:'revoked_at',width:180,render:dateText},
      {title:'撤销原因',dataIndex:'revoke_reason',width:160,render:(value?:string)=>value||'—'},
      {title:'操作',width:190,render:(_:unknown,item:Credential)=><Button size="small" danger disabled={item.status==='revoked'} onClick={()=>Modal.confirm({
        title:`撤销此节点全部 ${item.audience} 凭据？`,
        content:<><p>将撤销节点 {item.agent_id} 的 {item.audience} 用途所有未撤销凭据，包含该用途的其他签发记录。</p><p>{item.audience==='control'?'节点将无法心跳或拉取配置。':'节点将无法向平台上报遥测数据。'}需要重新接入节点才能恢复该用途。</p></>,
        okText:`撤销全部 ${item.audience} 凭据`,okButtonProps:{danger:true},onOk:async()=>{setActionError('');try{await post(`/agents/${encodeURIComponent(item.agent_id)}/credentials/revoke`,{audience:item.audience,reason:'管理员在接入凭据管理中撤销'});list.refresh();void message.success(`该节点全部 ${item.audience} 凭据已撤销`)}catch(error){setActionError(errorText(error));throw error}},
      })}>撤销该用途全部凭据</Button>},
    ]}/>}
  </div>;
}

export default function AccessCredentialsSettings() {
  const [params,setParams]=useSearchParams();
  const requested=params.get('section'),section=['sdk','enrollments','agents'].includes(requested??'')?requested!:'sdk';
  return <div>
    <h2>接入凭据</h2>
    <p>统一管理 SDK 与 LightMoni Agent 的接入身份，按用途分别授权和撤销。</p>
    <Tabs activeKey={section} destroyOnHidden onChange={value=>setParams(previous=>{const next=new URLSearchParams(previous);next.set('section',value);return next})} items={[
      {key:'sdk',label:'SDK 上报密钥',children:section==='sdk'?<SDKKeySettings/>:null},
      {key:'enrollments',label:'Agent 接入令牌',children:section==='enrollments'?<AgentEnrollments/>:null},
      {key:'agents',label:'节点凭据',children:section==='agents'?<AgentCredentials/>:null},
    ]}/>
  </div>;
}
