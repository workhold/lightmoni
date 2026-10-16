import {useEffect,useState} from 'react';
import {Navigate,useSearchParams} from 'react-router-dom';
import {UploadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Empty,Form,Input,Select,Space,Spin,Tabs,Tag,Upload} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import {useAppearance} from '../shared/appearance';
import './settings.css';

interface Profile {nickname:string;avatar_url:string;phone:string;email:string;feishu_id:string;dingtalk_id:string;wecom_id:string}
const adminTabs=['users','login','models','reporting','notifications','directory','retention','alerts'];

export function UserAvatar({user,size=30}:{user:Pick<User,'name'|'nickname'|'avatar_url'>;size?:number}){
 const [failed,setFailed]=useState(false);
 useEffect(()=>setFailed(false),[user.avatar_url]);
 return <span className="lm-avatar" style={{width:size,height:size,fontSize:size>40?26:13}}>{user.avatar_url&&!failed?<img src={user.avatar_url} alt="" onError={()=>setFailed(true)}/>:Array.from(user.nickname||user.name)[0]?.toUpperCase()}</span>;
}

function ProfileSettings({user,onUserUpdated}:{user:User;onUserUpdated:(user:User)=>void}){
 const {message}=App.useApp(),[form]=Form.useForm<Profile>();
 const [profile,setProfile]=useState<Profile>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const avatar=Form.useWatch('avatar_url',form) as string|undefined;
 const nickname=Form.useWatch('nickname',form) as string|undefined;
 async function load(){setLoading(true);setError('');try{const data=await api<Profile>('/auth/profile');setProfile(data);form.setFieldsValue(data)}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 async function save(values:Profile){
  setSaving(true);setError('');
  try{const data=await api<Profile>('/auth/profile',{method:'PUT',body:JSON.stringify(values)});setProfile(data);form.setFieldsValue(data);onUserUpdated({...user,nickname:data.nickname,avatar_url:data.avatar_url});void message.success('个人资料已保存')}
  catch(e){setError((e as Error).message)}finally{setSaving(false)}
 }
 return <div className="lm-surface lm-profile-settings">
  {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}
  {loading?<Spin/>:!profile?<Button onClick={()=>void load()}>重新加载</Button>:<Form form={form} layout="vertical" onFinish={save} disabled={saving}>
   <div className="lm-profile-avatar-row"><UserAvatar user={{...user,nickname,avatar_url:avatar}} size={72}/><div><Space wrap>
    <Upload accept="image/png,image/jpeg" showUploadList={false} beforeUpload={async file=>{
     if(!['image/png','image/jpeg'].includes(file.type)||file.size>256*1024){void message.error('请选择不超过 256 KB 的 PNG 或 JPEG 图片');return Upload.LIST_IGNORE}
     try{const value=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file)});form.setFieldValue('avatar_url',value)}catch(e){void message.error((e as Error).message)}
     return Upload.LIST_IGNORE;
    }}><Button icon={<UploadOutlined/>}>更换头像</Button></Upload>
    {avatar&&<Button type="text" onClick={()=>form.setFieldValue('avatar_url','')}>移除头像</Button>}
   </Space><p className="lm-settings-hint">PNG / JPEG，最大 256 KB</p></div></div>
   <Form.Item name="avatar_url" hidden><Input/></Form.Item>
   <div className="lm-profile-fields">
    <Form.Item label="登录用户名"><Input value={user.name} readOnly aria-readonly="true"/></Form.Item>
    <Form.Item name="nickname" label="昵称" extra="留空使用登录用户名。" rules={[{max:40,message:'昵称最多 40 个字符'}]}><Input maxLength={40} placeholder="填写昵称"/></Form.Item>
   </div>
   <section className="lm-profile-contacts" aria-labelledby="lm-profile-contacts-title">
    <h2 id="lm-profile-contacts-title">告警联系方式</h2>
    <p className="lm-settings-hint">用于告警和值班通知。</p>
    <div className="lm-profile-fields">
     <Form.Item name="phone" label="手机号" extra="支持国内 11 位或带国家区号的号码。" rules={[{validator:(_,value:string)=>!value||/^(1[3-9]\d{9}|\+[1-9]\d{6,14})$/.test(value.replace(/[ -]/g,''))?Promise.resolve():Promise.reject(new Error('请输入有效的手机号'))}]}><Input type="tel" autoComplete="tel" placeholder="13800000000" maxLength={32}/></Form.Item>
     <Form.Item name="email" label="收件邮箱" rules={[{type:'email',message:'请输入有效的收件邮箱'}]}><Input type="email" autoComplete="email" placeholder="name@example.com"/></Form.Item>
     <Form.Item name="feishu_id" label="飞书用户 open_id" extra="需与管理员配置的飞书企业应用对应。"><Input maxLength={256} placeholder="填写 open_id"/></Form.Item>
     <Form.Item name="dingtalk_id" label="钉钉用户 ID"><Input maxLength={256} placeholder="填写用户 ID"/></Form.Item>
     <Form.Item name="wecom_id" label="企业微信用户 ID"><Input maxLength={256} placeholder="填写用户 ID"/></Form.Item>
    </div>
   </section>
   <Button type="primary" htmlType="submit" loading={saving}>保存个人资料</Button>
  </Form>}
 </div>;
}

function AppearanceSettings(){const {appearance,setAppearance}=useAppearance();return <div className="lm-surface lm-appearance-settings"><div><strong>界面基调</strong><p>选择当前浏览器使用的界面外观。</p></div><Select aria-label="界面基调" value={appearance} onChange={setAppearance} style={{width:160}} options={[{value:'dark',label:'黑色 · 深色'},{value:'light',label:'白色 · 浅色'}]}/></div>}

function AccountBindings(){
 const [providers,setProviders]=useState<{id:string;name:string}[]>([]),[identities,setIdentities]=useState<{provider_id:string}[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 async function load(){setLoading(true);setError('');try{const [p,i]=await Promise.all([api<typeof providers>('/auth/providers'),api<typeof identities>('/auth/identities')]);setProviders(p);setIdentities(i)}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 return <div className="lm-surface lm-account-bindings"><h2>第三方账号绑定</h2><p className="lm-settings-hint">绑定后可使用第三方身份登录当前账号。</p>{loading?<Spin/>:error?<Alert type="error" title={error} action={<Button onClick={()=>void load()}>重新加载</Button>}/>:providers.length===0?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可绑定的登录方式"/>:providers.map(p=><div className="lm-account-binding" key={p.id}><strong>{p.name}</strong>{identities.some(i=>i.provider_id===p.id)?<Tag color="success">已绑定</Tag>:<Button href={`/api/v1/auth/oauth/${encodeURIComponent(p.id)}/start?bind=1&return_to=${encodeURIComponent('/settings?tab=bindings')}`}>绑定账号</Button>}</div>)}</div>;
}

export default function PersonalSettings({user,onUserUpdated}:{user:User;onUserUpdated:(user:User)=>void}){
 const [params,setParams]=useSearchParams(),tab=params.get('tab')??'profile';
 if(tab==='contacts')return <Navigate to="/settings?tab=profile" replace/>;
 if(adminTabs.includes(tab))return <Navigate to={user.role==='admin'?`/admin?${params}`:'/settings'} replace/>;
 return <div className="lm-page lm-settings-page lm-entry"><div className="lm-page-heading"><div><h1>个人设置</h1><p>管理个人资料、联系方式与账号偏好。</p></div></div><Tabs activeKey={['profile','appearance','bindings'].includes(tab)?tab:'profile'} onChange={tab=>setParams({tab})} destroyOnHidden items={[
  {key:'profile',label:'个人资料',children:<ProfileSettings user={user} onUserUpdated={onUserUpdated}/>},
  {key:'appearance',label:'外观',children:<AppearanceSettings/>},
  {key:'bindings',label:'账号绑定',children:<AccountBindings/>},
 ]}/></div>;
}
