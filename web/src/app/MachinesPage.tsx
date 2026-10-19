import {useCallback,useEffect,useState} from 'react';
import {PlusOutlined,ReloadOutlined,SecurityScanOutlined,CloudServerOutlined} from '@ant-design/icons';
import {Alert,Button,Descriptions,Empty,Form,Input,InputNumber,Modal,Popconfirm,Select,Space,Table,Tag,Typography,App} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import './machines.css';

type Machine={id:string;name:string;address:string;port:number;username:string;connection_method:string;host_key_fingerprint:string;host_key_status:string;platform:string;arch:string;agent_id:string;agent_status:string;credential_count:number;active_credential_count:number;last_deployment_status:string;updated_at:string;created_at:string};
type Credential={id:string;method:string;secret_fingerprint:string;retention:string;created_at:string;expires_at:string;revoked_at?:string;last_used_at:string;created_by:string};
type Deployment={id:string;machine_id:string;credential_id:string;status:string;version:string;arch:string;initial_label_id:string;plan:any;receipt:any;error:string;created_at:string;approved_at:string;started_at:string;finished_at:string};
type Detail={machine:Machine;credentials:Credential[];deployments:Deployment[]};
const errorText=(e:unknown)=>e instanceof Error?e.message:'操作失败';
const time=(value:string)=>value?new Date(value).toLocaleString():'尚无记录';
const methodName=(value:string)=>({direct_ssh:'直接 SSH',bastion:'跳板机 / SSH',ssm:'云 SSM',manual_script:'手动脚本'}[value]??value);
const statusName=(value:string)=>({unknown:'未接入',online:'Agent 在线',offline:'Agent 离线',installing:'部署中',error:'需要处理'}[value]??value);

export default function MachinesPage({user}:{user:User}){
 const admin=user.role==='admin';
 const {message}=App.useApp();
 const [machines,setMachines]=useState<Machine[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [newOpen,setNewOpen]=useState(false),[newBusy,setNewBusy]=useState(false),[newError,setNewError]=useState('');
 const [credentialMachine,setCredentialMachine]=useState<Machine>(),[credentialBusy,setCredentialBusy]=useState(false),[credentialError,setCredentialError]=useState('');
 const [detail,setDetail]=useState<Detail>(),[detailBusy,setDetailBusy]=useState(false);
 const [planMachine,setPlanMachine]=useState<Machine>(),[planDetail,setPlanDetail]=useState<Detail>(),[planBusy,setPlanBusy]=useState(false),[planError,setPlanError]=useState(''),[planResult,setPlanResult]=useState<any>();
 const load=useCallback(async()=>{setLoading(true);try{setMachines(await api<Machine[]>('/machines'));setError('')}catch(e){setError(errorText(e))}finally{setLoading(false)}},[]);
 useEffect(()=>{void load()},[load]);
 const openDetail=async(machine:Machine)=>{setDetailBusy(true);try{setDetail(await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`))}catch(e){void message.error(errorText(e))}finally{setDetailBusy(false)}};
 const create=async(values:any)=>{setNewBusy(true);setNewError('');try{const machine=await api<Machine>('/machines',{method:'POST',body:JSON.stringify(values)});setNewOpen(false);await load();void message.success('主机已登记');setCredentialMachine(machine)}catch(e){setNewError(errorText(e))}finally{setNewBusy(false)}};
 const addCredential=async(values:any)=>{if(!credentialMachine)return;setCredentialBusy(true);setCredentialError('');try{const result=await api<any>(`/machines/${encodeURIComponent(credentialMachine.id)}/credentials`,{method:'POST',body:JSON.stringify(values)});setCredentialMachine(undefined);await load();void message.success(result.warning||'连接凭据已保存')}catch(e){setCredentialError(errorText(e))}finally{setCredentialBusy(false)}};
 const revokeCredential=async(machineID:string,credentialID:string)=>{try{await api(`/machines/${encodeURIComponent(machineID)}/credentials/${encodeURIComponent(credentialID)}`,{method:'DELETE'});void message.success('连接凭据已撤销');if(detail?.machine.id===machineID)await openDetail(detail.machine);await load()}catch(e){void message.error(errorText(e))}};
 const openPlan=async(machine:Machine)=>{setPlanMachine(machine);setPlanResult(undefined);setPlanError('');try{setPlanDetail(await api<Detail>(`/machines/${encodeURIComponent(machine.id)}`))}catch(e){setPlanError(errorText(e))}};
 const makePlan=async(values:any)=>{if(!planMachine)return;setPlanBusy(true);setPlanError('');try{setPlanResult(await api<any>(`/machines/${encodeURIComponent(planMachine.id)}/deployments/plan`,{method:'POST',body:JSON.stringify(values)}))}catch(e){setPlanError(errorText(e))}finally{setPlanBusy(false)}};
 const applyPlan=async()=>{if(!planMachine||!planResult)return;setPlanBusy(true);setPlanError('');try{const result=await api<any>(`/machines/${encodeURIComponent(planMachine.id)}/deployments/${encodeURIComponent(planResult.id)}/apply`,{method:'POST',body:JSON.stringify({confirm:true})});setPlanResult(result);await load();void message.success('Agent 部署已完成')}catch(e){setPlanError(errorText(e))}finally{setPlanBusy(false)}};
 if(!admin)return <div className="lm-page"><Alert type="info" showIcon title="主机管理仅管理员可用" description="主机地址、连接凭据和 Agent 部署会影响用户机器，成员不能查看或修改。"/></div>;
 return <div className="lm-page lm-machines-page">
  <div className="lm-page-heading"><div><h1>主机管理</h1><p>登记用户机器，使用受审阅的固定流程引导安装 LightMoni Agent。</p></div><Space><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新</Button><Button type="primary" icon={<PlusOutlined/>} onClick={()=>{setNewError('');setNewOpen(true)}}>登记主机</Button></Space></div>
  <Alert type="warning" showIcon icon={<SecurityScanOutlined/>} title="连接凭据安全提示" description="SSH 私钥只在后端部署流程中短暂解密；密码建议只使用一次，不要长期保存。AI 助手不会读取、展示或发送任何连接秘密。" className="lm-machine-notice"/>
  {error&&<Alert type="error" showIcon title={error} className="lm-machine-notice"/>}
  <div className="lm-surface"><Table<Machine> rowKey="id" dataSource={machines} loading={loading} scroll={{x:1080}} pagination={{pageSize:10,hideOnSinglePage:true}} locale={{emptyText:<Empty description="尚未登记主机"/>}} columns={[
   {title:'主机',width:220,render:(_:unknown,m:Machine)=><div><strong>{m.name}</strong><Typography.Text type="secondary" copyable={{text:m.id}}>{m.address}:{m.port}</Typography.Text></div>},
   {title:'登录主体',width:150,render:(_:unknown,m:Machine)=><span>{m.username}<br/><Typography.Text type="secondary">{methodName(m.connection_method)}</Typography.Text></span>},
   {title:'主机指纹',width:180,render:(_:unknown,m:Machine)=>m.host_key_status==='confirmed'?<Tag color="success">已确认 · {m.host_key_fingerprint.slice(-12)}</Tag>:<Tag color="warning">未确认</Tag>},
   {title:'Agent 状态',width:130,render:(_:unknown,m:Machine)=><Tag color={m.agent_status==='online'?'success':m.agent_status==='error'?'error':'default'}>{statusName(m.agent_status)}</Tag>},
   {title:'凭据',width:100,render:(_:unknown,m:Machine)=><span>{m.active_credential_count}/{m.credential_count} 有效</span>},
   {title:'最近更新',dataIndex:'updated_at',width:180,render:time},
   {title:'操作',width:250,render:(_:unknown,m:Machine)=><Space wrap><Button size="small" onClick={()=>void openDetail(m)}>详情</Button><Button size="small" onClick={()=>{setCredentialError('');setCredentialMachine(m)}}>添加凭据</Button><Button size="small" type="primary" disabled={!m.active_credential_count} onClick={()=>void openPlan(m)}>部署 Agent</Button></Space>},
  ]}/></div>
  <Modal title="登记主机" open={newOpen} onCancel={()=>{if(!newBusy)setNewOpen(false)}} footer={null} destroyOnHidden>
   <Form layout="vertical" onFinish={create} disabled={newBusy} initialValues={{port:22,connection_method:'direct_ssh'}}>
    <Form.Item label="主机名称" name="name" rules={[{required:true,message:'请输入主机名称'}]}><Input placeholder="例如：生产订单节点"/></Form.Item>
    <Form.Item label="地址" name="address" rules={[{required:true,message:'请输入主机名或 IP'}]}><Input placeholder="host.example.com 或 10.0.0.12"/></Form.Item>
    <Space.Compact block><Form.Item label="SSH 端口" name="port" rules={[{required:true}]} style={{width:'35%'}}><InputNumber min={1} max={65535} style={{width:'100%'}}/></Form.Item><Form.Item label="登录用户名" name="username" rules={[{required:true}]} style={{width:'65%'}}><Input placeholder="例如：deploy"/></Form.Item></Space.Compact>
    <Form.Item label="连接方式" name="connection_method"><Select options={[{value:'direct_ssh',label:'直接 SSH（支持固定私钥部署）'},{value:'bastion',label:'跳板机 / SSH（先登记跳板机）'},{value:'ssm',label:'云 SSM（手动执行脚本）'},{value:'manual_script',label:'手动脚本（推荐内网机器）'}]}/></Form.Item>
    <Form.Item label="主机公钥指纹" name="host_key_fingerprint" extra="必须是 SHA256:... 格式；未确认前不能自动 SSH。"><Input placeholder="SHA256:..."/></Form.Item>
    {newError&&<Alert type="error" showIcon title={newError} className="lm-machine-form-notice"/>}<Button type="primary" htmlType="submit" loading={newBusy} block>保存主机</Button>
   </Form>
  </Modal>
  <Modal title={`添加连接凭据 · ${credentialMachine?.name??''}`} open={!!credentialMachine} onCancel={()=>{if(!credentialBusy)setCredentialMachine(undefined)}} footer={null} destroyOnHidden>
   <Alert type="warning" showIcon title="密码不建议长期保存" description="密码凭据默认只保留 15 分钟，且不能用于自动 SSH 部署。优先使用每台主机独立的 SSH 私钥、Vault/SSM 或手动 enrollment 脚本。" className="lm-machine-form-notice"/>
   <Form layout="vertical" onFinish={addCredential} disabled={credentialBusy} initialValues={{method:'ssh_key'}}>
    <Form.Item label="凭据类型" name="method"><Select options={[{value:'ssh_key',label:'SSH 私钥（推荐）'},{value:'password',label:'密码（仅一次性登记）'},{value:'manual_script',label:'手动脚本（不保存秘密）'}]}/></Form.Item>
    <Form.Item label="秘密内容" name="secret" extra="私钥或密码不会回显，保存后只能撤销和轮换。"><Input.TextArea rows={7} placeholder="SSH 私钥内容；密码模式输入一次性密码"/></Form.Item>
    <Form.Item label="保留秒数" name="expires_in_seconds" extra="密码最多 1 小时，默认 15 分钟；私钥默认 90 天。"><InputNumber min={60} max={31536000} style={{width:'100%'}} placeholder="留空使用默认值"/></Form.Item>
    {credentialError&&<Alert type="error" showIcon title={credentialError} className="lm-machine-form-notice"/>}<Button type="primary" htmlType="submit" loading={credentialBusy} block>保存凭据</Button>
   </Form>
  </Modal>
  <Modal title={`主机详情 · ${detail?.machine.name??''}`} open={!!detail} onCancel={()=>setDetail(undefined)} footer={null} width={820} destroyOnHidden>
   {detail&&<><Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'id',label:'machine_id',children:<Typography.Text code>{detail.machine.id}</Typography.Text>},{key:'agent',label:'agent_id',children:detail.machine.agent_id||'尚未绑定'},{key:'address',label:'连接地址',children:`${detail.machine.username}@${detail.machine.address}:${detail.machine.port}`},{key:'status',label:'Agent 状态',children:statusName(detail.machine.agent_status)},{key:'fingerprint',label:'主机指纹',span:2,children:detail.machine.host_key_fingerprint||'未确认'}]}/><h3>连接凭据</h3><Table<Credential> size="small" rowKey="id" dataSource={detail.credentials} pagination={false} columns={[{title:'类型',dataIndex:'method'},{title:'指纹',dataIndex:'secret_fingerprint'},{title:'保留策略',dataIndex:'retention',render:(v:string)=>v==='one_time'?<Tag color="warning">一次性</Tag>:<Tag>托管</Tag>},{title:'有效期',dataIndex:'expires_at',render:time},{title:'最近使用',dataIndex:'last_used_at',render:time},{title:'状态',render:(_:unknown,c:Credential)=>c.revoked_at?<Tag>已撤销</Tag>:Date.parse(c.expires_at)<=Date.now()?<Tag>已过期</Tag>:<Tag color="success">有效</Tag>},{title:'操作',render:(_:unknown,c:Credential)=>c.revoked_at||Date.parse(c.expires_at)<=Date.now()?null:<Popconfirm title="撤销此连接凭据？" description="撤销后不能用于部署，需重新添加凭据。" okText="撤销" cancelText="取消" onConfirm={()=>void revokeCredential(detail.machine.id,c.id)}><Button size="small" danger>撤销</Button></Popconfirm>}]}/><h3>部署历史</h3><Table<Deployment> size="small" rowKey="id" dataSource={detail.deployments} pagination={{pageSize:5}} columns={[{title:'状态',dataIndex:'status'},{title:'版本',dataIndex:'version'},{title:'创建时间',dataIndex:'created_at',render:time},{title:'错误',dataIndex:'error'}]}/></>}
  </Modal>
  <Modal title={`部署 LightMoni Agent · ${planMachine?.name??''}`} open={!!planMachine} onCancel={()=>{if(!planBusy)setPlanMachine(undefined)}} footer={null} width={760} destroyOnHidden>
   {!planResult&&planDetail&&(()=>{const keys=planDetail.credentials.filter(c=>!c.revoked_at&&Date.parse(c.expires_at)>Date.now()&&c.method==='ssh_key');return keys.length?<Form layout="vertical" onFinish={makePlan} disabled={planBusy} initialValues={{version:'0.1.0',arch:planDetail.machine.arch||'amd64'}}><Form.Item label="连接凭据" name="credential_id" rules={[{required:true,message:'请选择 SSH 私钥'}]}><Select options={keys.map(c=>({value:c.id,label:`SSH 私钥 · ${c.secret_fingerprint||'无指纹'} · 到期 ${time(c.expires_at)}`}))}/></Form.Item><Space.Compact block><Form.Item label="Agent 版本" name="version" rules={[{required:true}]} style={{width:'50%'}}><Input/></Form.Item><Form.Item label="架构" name="arch" rules={[{required:true}]} style={{width:'50%'}}><Select options={[{value:'amd64',label:'amd64'},{value:'arm64',label:'arm64'}]}/></Form.Item></Space.Compact><Form.Item label="初始任务标签" name="initial_label_id"><Input placeholder="可留空，接入后在节点助手中设置"/></Form.Item>{planError&&<Alert type="error" showIcon title={planError} className="lm-machine-form-notice"/>}<Button type="primary" htmlType="submit" loading={planBusy} block>生成部署计划</Button></Form>:<Alert type="warning" showIcon title="暂无可用于自动部署的 SSH 私钥" description="当前自动部署只使用已确认主机指纹的 SSH 私钥。密码建议只使用一次，不要长期保存；手动脚本请在目标主机上执行。请先添加 SSH 私钥后重试。"/>})()}
   {planResult&&<><Alert type={planResult.status==='succeeded'?'success':'info'} showIcon title={planResult.status==='succeeded'?'Agent 已部署并收到激活回执':'请审阅固定部署步骤后确认'} description={planResult.plan?.warnings?.join(' ')||planResult.receipt?.error}/><Descriptions size="small" column={1} items={(planResult.plan?.steps||planResult.receipt?.stages||[]).map((step:string,index:number)=>({key:index,label:`步骤 ${index+1}`,children:step}))}/><Typography.Paragraph type="secondary">部署计划 ID：<Typography.Text code>{planResult.id}</Typography.Text></Typography.Paragraph>{planError&&<Alert type="error" showIcon title={planError} className="lm-machine-form-notice"/>}{planResult.status==='awaiting_approval'&&<Button type="primary" danger loading={planBusy} onClick={()=>void applyPlan()} block>我已审阅，确认执行 SSH 部署</Button>}</>}
  </Modal>
 </div>;
}
