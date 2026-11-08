import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Collapse,Empty,Form,Input,Modal,Popconfirm,Select,Space,Table,Tag,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,type Resource} from './model';

type Credential={id:string;name:string;registry:string;repository_prefix:string;cluster_ids:string[];username:string;revision:number;expires_at:string;status:string;references:{id:string;name:string}[]};
export default function RegistryCredentialsPanel(){
  const {t}=useI18n(),[form]=Form.useForm();
  const [items,setItems]=useState<Credential[]>([]),[clusters,setClusters]=useState<Resource[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[editing,setEditing]=useState<Credential>(),[open,setOpen]=useState(false),[error,setError]=useState(''),[formError,setFormError]=useState(''),[notice,setNotice]=useState('');
  const explain=(e:unknown)=>{
    const code=errorText(e);
    return ({registry_credential_revision_conflict:t('凭据已被更新，请关闭后刷新再编辑。','The credential changed. Close and refresh before editing again.'),registry_credential_in_use:t('凭据仍被应用或已发布配置引用，请先解除绑定。','Applications or published configurations still use this credential. Remove their references first.'),registry_credential_password_required:t('请输入密码或 Token；更换仓库或账号时需重新填写。','Enter a password or token. A new secret is required when changing the registry or username.'),INVALID_REGISTRY_CREDENTIAL:t('请检查仓库地址和仓库内路径。地址仅支持 HTTPS 仓库域名及可选端口。','Check the registry and repository path. Use an HTTPS registry host with an optional port.'),invalid_registry_credential:t('请检查账号、密码及名称格式。','Check the username, password and name.'),invalid_registry_credential_expiry:t('有效期必须晚于当前时间。','Expiry must be in the future.'),registry_credential_unavailable:t('凭据已撤销或过期，请新增凭据。','The credential is revoked or expired. Create a new one.')} as Record<string,string>)[code]??code;
  };
  const load=async()=>{setLoading(true);try{const [next,resources]=await Promise.all([api<Credential[]>('/ops/registry-credentials'),api<{resources:Resource[]}>('/ops/resources?kind=cluster')]);setItems(next);setClusters(resources.resources);setError('');}catch(e){setError(explain(e));}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const close=()=>{if(busy)return;form.resetFields();setOpen(false);setEditing(undefined);setFormError('');};
  const localTime=(value:string)=>value?new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  const start=(item?:Credential)=>{setEditing(item);setFormError('');form.resetFields();form.setFieldsValue(item?{...item,password:'',expires_at:localTime(item.expires_at)}:{name:'',registry:'',username:'',password:'',repository_prefix:'',cluster_ids:[],expires_at:''});setOpen(true);};
  const save=async(values:any)=>{
    if(busy)return;setBusy(true);setFormError('');
    try{
      await api('/ops/registry-credentials'+(editing?'/'+editing.id:''),{method:editing?'PUT':'POST',body:JSON.stringify({name:values.name,registry:values.registry,username:values.username,password:values.password??'',repository_prefix:values.repository_prefix??'',cluster_ids:values.cluster_ids??[],expires_at:values.expires_at?new Date(values.expires_at).toISOString():'',...(editing?{revision:editing.revision}:{})})});
      form.resetFields();setOpen(false);setEditing(undefined);setNotice(t('仓库凭据已保存；下次部署或重试时使用。','Registry credential saved; used on the next deployment or retry.'));await load();
    }catch(e){setFormError(explain(e));}finally{setBusy(false);}
  };
  const mutate=async(item:Credential,revoke:boolean)=>{if(busy)return;setBusy(true);setError('');try{await api('/ops/registry-credentials/'+item.id+(revoke?'/revoke':''),{method:revoke?'POST':'DELETE',body:JSON.stringify({revision:item.revision})});setNotice(revoke?t('凭据已撤销；后续拉取将无法使用此账号。','Credential revoked; subsequent pulls cannot use this account.'):t('凭据已删除。','Credential deleted.'));await load();}catch(e){setError(explain(e));}finally{setBusy(false);}};
  return <section className="lm-surface" aria-label={t('镜像仓库凭据','Registry credentials')} style={{padding:20,marginBottom:20}}>
    <div className="lm-page-heading"><div><h3>{t('镜像仓库凭据','Registry credentials')}</h3><p>{t('保存私有仓库账号，在应用配置中选择后用于镜像拉取。','Save private registry accounts, then select them in application settings to pull images.')}</p></div><Space><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()} aria-label={t('刷新仓库凭据','Refresh registry credentials')}/><Button type="primary" icon={<PlusOutlined aria-hidden/>} onClick={()=>start()}>{t('新增仓库凭据','Add registry credential')}</Button></Space></div>
    {error&&<Alert type="error" showIcon title={error} style={{marginBottom:12}}/>}{notice&&<Alert type="success" showIcon title={notice} style={{marginBottom:12}}/>}
    <Table<Credential> rowKey="id" dataSource={items} loading={loading} scroll={{x:900}} pagination={{pageSize:10,hideOnSinglePage:true}} locale={{emptyText:<Empty description={t('尚无仓库凭据','No registry credentials yet')}/>}} columns={[
      {title:t('名称 / 仓库','Name / registry'),width:260,render:(_,c)=><><Typography.Text strong>{c.name}</Typography.Text><div><Typography.Text type="secondary">{c.registry}{c.repository_prefix?'/'+c.repository_prefix+'/*':''}</Typography.Text></div></>},
      {title:t('账号','Username'),dataIndex:'username',width:170},
      {title:t('状态','Status'),width:110,render:(_,c)=><Tag color={c.status==='active'?'success':'default'}>{c.status==='active'?t('有效','Active'):c.status==='revoked'?t('已撤销','Revoked'):t('已过期','Expired')}</Tag>},
      {title:t('关联应用','Applications'),width:210,render:(_,c)=><Space wrap>{c.references.length?c.references.map(a=><Link key={a.id} to={'/applications?resource='+encodeURIComponent(a.id)}>{a.name}</Link>):<Typography.Text type="secondary">{t('尚未关联','Not associated')}</Typography.Text>}</Space>},
      {title:t('操作','Actions'),width:190,render:(_,c)=><Space><Button size="small" disabled={busy||c.status==='revoked'} onClick={()=>start(c)}>{t('编辑','Edit')}</Button>{c.status!=='revoked'&&<Popconfirm title={t('撤销此仓库凭据？','Revoke this registry credential?')} description={t('将清除密码，并阻止待执行任务继续使用；已运行容器继续运行。','Clears the secret and blocks pending work from using it. Running containers continue.')} onConfirm={()=>mutate(c,true)}><Button size="small" danger disabled={busy}>{t('撤销','Revoke')}</Button></Popconfirm>}{!c.references.length&&<Popconfirm title={t('删除此仓库凭据？','Delete this registry credential?')} onConfirm={()=>mutate(c,false)}><Button size="small" danger disabled={busy}>{t('删除','Delete')}</Button></Popconfirm>}</Space>},
    ]}/>
    <Modal open={open} title={editing?t('编辑仓库凭据','Edit registry credential'):t('新增仓库凭据','Add registry credential')} onCancel={close} footer={null} width={580} style={{top:24}} maskClosable={false} closable={!busy} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={values=>void save(values)} disabled={busy}>
        <Form.Item name="name" label={t('凭据名称','Credential name')} rules={[{required:true},{max:128}]}><Input autoComplete="off"/></Form.Item>
        <Form.Item name="registry" label={t('仓库地址','Registry address')} rules={[{required:true}]} extra={t('填写域名及可选端口，例如 ghcr.io 或 registry.example.com:5443。','Enter a host and optional port, such as ghcr.io or registry.example.com:5443.')}><Input placeholder="registry.example.com" autoComplete="off"/></Form.Item>
        <Form.Item name="username" label={t('用户名','Username')} rules={[{required:true},{max:256}]}><Input autoComplete="off"/></Form.Item>
        <Form.Item name="password" label={t('密码或 Token','Password or token')} rules={[{required:!editing},{max:8192}]} extra={editing?t('留空保留同仓库、同账号的现有密码。','Leave blank to retain the secret for the same registry and username.'):undefined}><Input.Password autoComplete="new-password"/></Form.Item>
        <Collapse items={[{key:'scope',label:t('使用范围与有效期（可选）','Scope and expiry (optional)'),forceRender:true,children:<>
          <Form.Item name="repository_prefix" label={t('仓库内路径前缀','Repository prefix')} extra={t('留空允许此仓库全部路径；例如 team 只匹配 team 下的镜像。','Leave empty for all repositories. For example, team matches images under team.')}><Input placeholder="team"/></Form.Item>
          <Form.Item name="cluster_ids" label={t('允许的集群','Allowed clusters')} extra={t('留空允许已绑定应用的所有部署集群。','Leave empty to allow all deployment clusters of applications using this credential.')}><Select mode="multiple" allowClear options={clusters.map(c=>({value:c.id,label:c.name}))}/></Form.Item>
          <Form.Item name="expires_at" label={t('到期时间','Expires at')} extra={t('留空表示永久保存，时间按当前时区填写。','Leave empty for no expiry. Use your local time.')}><Input type="datetime-local"/></Form.Item>
        </>}]}/>
        {formError&&<Alert type="error" showIcon title={formError} style={{marginTop:12}}/>}
        <Button type="primary" htmlType="submit" aria-label={t('保存凭据','Save credential')} block loading={busy} style={{marginTop:16}}>{t('保存凭据','Save credential')}</Button>
      </Form>
    </Modal>
  </section>;
}
