export {default as DataPage} from './DataPage';
import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {ArrowRightOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,Button,Divider,Form,Input,Select,Space,Spin,Table,Tag,Typography} from '../shared/ui';
import {api,post} from '../shared/api';
import {type CatalogTable,type User} from '../shared/types';
import {useI18n} from '../shared/i18n';
export const defaultRange=()=>({from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()});
const errorText=(e:unknown,fallback:string)=>e instanceof Error?e.message:fallback;
function Heading({title,description,action}:{title:string;description:string;action?:React.ReactNode}){return <div className="lm-page-heading"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>}
export function LoginPage({onLogin}:{onLogin:(u:User)=>void}){
 const {language,setLanguage,t}=useI18n();
 const [form]=Form.useForm();
 const [setup,setSetup]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[providers,setProviders]=useState<{id:string;name:string}[]>([]);
 const [params]=useSearchParams();
 useEffect(()=>{Promise.all([api<{required:boolean}>('/setup'),api<{id:string;name:string}[]>('/auth/providers')]).then(([s,p])=>{setSetup(s.required);setProviders(p)}).catch(e=>setError(errorText(e,t('操作失败','Operation failed')))).finally(()=>setLoading(false))},[]);
 useEffect(()=>{if(loading)return;const fields=form.getFieldsError().filter(field=>field.errors.length>0).map(field=>field.name);if(fields.length>0)void form.validateFields(fields).catch(()=>{})},[language,form,loading]);
 return <div className="lm-login"><div className="lm-login-panel">
  <div className="lm-login-brand" style={{flexWrap:'wrap'}}><span style={{display:'flex',alignItems:'center',gap:10,fontSize:22}}><span className="lm-brand-mark">L</span>LightMoni</span><Select size="small" aria-label={t('显示语言','Display language')} value={language} onChange={setLanguage} style={{width:104,marginLeft:'auto',fontWeight:400}} options={[{value:'zh-CN',label:'简体中文'},{value:'en-US',label:'English'}]}/></div>
  <h1>{setup?t('创建监控工作台','Create your monitoring workspace'):t('登录监控工作台','Sign in to your monitoring workspace')}</h1>
  <p>{setup?t('设置第一个管理员，随后接入服务器和业务数据。','Create the first administrator, then connect your servers and application data.'):t('服务器状态、业务趋势与日志，都在一个工作台。','Server health, application trends and logs in one workspace.')}</p>
  {loading?<Spin/>:<>
   <Form form={form} layout="vertical" onFinish={async values=>{setBusy(true);setError('');try{onLogin(await post<User>(setup?'/setup':'/auth/login',values))}catch(e){setError(errorText(e,t('操作失败','Operation failed')))}finally{setBusy(false)}}}>
    <Form.Item label={t('用户名','Username')} name="name" rules={[{required:true,message:t('请输入用户名','Enter your username')}]}><Input autoComplete="username" placeholder={t('管理员或成员用户名','Administrator or member username')}/></Form.Item>
    <Form.Item label={t('密码','Password')} name="password" rules={[{required:true,message:t('请输入密码','Enter your password')},...(setup?[{min:8,message:t('密码至少8位','Password must be at least 8 characters')}]:[])]}><Input.Password autoComplete={setup?'new-password':'current-password'} placeholder={setup?t('至少8位密码','At least 8 characters'):t('输入密码','Enter your password')}/></Form.Item>
    {(error||params.get('oauth_error'))&&<Alert type="error" title={error||params.get('oauth_error')} style={{marginBottom:18}}/>}
    <Button type="primary" block loading={busy} htmlType="submit">{setup?t('创建并进入工作台','Create and enter workspace'):t('登录','Sign in')}</Button>
   </Form>
   {providers.length>0&&!setup&&<><Divider plain>{t('第三方登录','Sign in with')}</Divider><Space wrap>{providers.map(p=><Button key={p.id} href={`/api/v1/auth/oauth/${encodeURIComponent(p.id)}/start?return_to=${encodeURIComponent(location.pathname+location.search)}`}>{p.name}</Button>)}</Space></>}
  </>}
 </div></div>;
}
export function OverviewPage(){
 const {t}=useI18n();
 const [data,setData]=useState<{tables:CatalogTable[];agent_count:number;key_count:number;user_count:number}>();
 const [error,setError]=useState('');
 useEffect(()=>{api<typeof data>('/overview').then(setData).catch(e=>setError(errorText(e,t('操作失败','Operation failed'))))},[]);
 const stats=[
  {id:'tables',label:t('数据表','Data tables'),value:data?.tables.length},
  {id:'agents',label:t('执行节点','Execution nodes'),value:data?.agent_count},
  {id:'keys',label:t('启用 Key','Active keys'),value:data?.key_count},
  {id:'users',label:t('团队成员','Team members'),value:data?.user_count},
 ];
 const entries=[
  {url:'/dashboards',title:t('监控大盘','Dashboards'),description:t('汇总机器与服务趋势，使用SQL构建需要的图表。','Explore host and service trends, and build charts with SQL.'),action:t('打开监控大盘','Open dashboards')},
  {url:'/logs',title:t('日志探索','Log explorer'),description:t('按时间、服务和字段定位错误，查看上下文。','Find errors by time, service and field, and inspect their context.'),action:t('打开日志探索','Open log explorer')},
  {url:'/assistant',title:t('AI 助手','AI assistant'),description:t('读取真实表结构，生成SQL、分析异常与创建大盘。','Inspect actual schemas, generate SQL, analyze anomalies and create dashboards.'),action:t('打开AI 助手','Open AI assistant')},
 ];
 return <div className="lm-page lm-entry">
  <Heading title={t('监控概览','Monitoring overview')} description={t('从机器到业务，快速找到需要关注的变化。','Find changes that need attention across hosts and applications.')} action={<Link to="/data"><Button type="primary" icon={<PlusOutlined/>}>{t('接入数据','Connect data')}</Button></Link>}/>
  {error&&<Alert type="error" title={error}/>}
  <div className="lm-stats">{stats.map(({id,label,value})=><div className="lm-stat" key={id}><span>{label}</span><strong>{value??'—'}</strong></div>)}</div>
  <div className="lm-template-grid">{entries.map(({title,description,url,action})=><div className="lm-template" key={url}><h3>{title}</h3><p>{description}</p><Link to={url}><Button type="link" style={{padding:0}} icon={<ArrowRightOutlined/>}>{action}</Button></Link></div>)}</div>
  <div className="lm-surface" style={{marginTop:24}}><h2>{t('已接入的数据','Connected data')}</h2><Table rowKey="id" dataSource={data?.tables??[]} pagination={{pageSize:8}} columns={[
   {title:t('数据表','Data table'),dataIndex:'name',render:(v:string)=><Typography.Text code>{v}</Typography.Text>},
   {title:t('类型','Type'),dataIndex:'kind',render:(v:string)=><Tag>{v}</Tag>},
   {title:t('服务','Services'),dataIndex:'services',render:(v:string[])=>v.join(' · ')},
   {title:t('告警组','Alert group'),dataIndex:'alert_group_id',render:(v:string)=>v||t('尚未绑定','Not linked')},
  ]}/></div>
 </div>;
}
export {default as AgentsPage} from './AgentsPage';
