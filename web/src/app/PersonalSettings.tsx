import {useEffect,useState} from 'react';
import {Navigate,useSearchParams} from 'react-router-dom';
import {UploadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Empty,Form,Input,Space,Spin,Tabs,Tag,Upload} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import {useI18n} from '../shared/i18n';
import InterfacePreferences from '../shared/InterfacePreferences';
import DefaultHomepageSettings from './DefaultHomepageSettings';
import './settings.css';

interface Profile {nickname:string;avatar_url:string;phone:string;email:string;feishu_id:string;dingtalk_id:string;wecom_id:string}
const adminTabs=['users','login','models','reporting','notifications','directory','retention','alerts'];

export function UserAvatar({user,size=30}:{user:Pick<User,'name'|'nickname'|'avatar_url'>;size?:number}){
 const [failed,setFailed]=useState(false);
 useEffect(()=>setFailed(false),[user.avatar_url]);
 return <span className="lm-avatar" style={{width:size,height:size,fontSize:size>40?26:13}}>{user.avatar_url&&!failed?<img src={user.avatar_url} alt="" onError={()=>setFailed(true)}/>:Array.from(user.nickname||user.name)[0]?.toUpperCase()}</span>;
}

function ProfileSettings({user,onUserUpdated}:{user:User;onUserUpdated:(user:User)=>void}){
 const {language,t}=useI18n();
 const {message}=App.useApp(),[form]=Form.useForm<Profile>();
 const [profile,setProfile]=useState<Profile>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const avatar=Form.useWatch('avatar_url',form) as string|undefined;
 const nickname=Form.useWatch('nickname',form) as string|undefined;
 async function load(){setLoading(true);setError('');try{const data=await api<Profile>('/auth/profile');setProfile(data);form.setFieldsValue(data)}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 useEffect(()=>{if(loading||!profile)return;const fields=form.getFieldsError().filter(field=>field.errors.length>0).map(field=>field.name);if(fields.length>0)void form.validateFields(fields).catch(()=>{})},[language,form,loading,profile]);
 async function save(values:Profile){
  setSaving(true);setError('');
  try{const data=await api<Profile>('/auth/profile',{method:'PUT',body:JSON.stringify(values)});setProfile(data);form.setFieldsValue(data);onUserUpdated({...user,nickname:data.nickname,avatar_url:data.avatar_url});void message.success(t('个人资料已保存','Profile saved'))}
  catch(e){setError((e as Error).message)}finally{setSaving(false)}
 }
 return <div className="lm-surface lm-profile-settings">
  {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}
  {loading?<Spin/>:!profile?<Button onClick={()=>void load()}>{t('重新加载','Reload')}</Button>:<Form form={form} layout="vertical" onFinish={save} disabled={saving}>
   <div className="lm-profile-avatar-row"><UserAvatar user={{...user,nickname,avatar_url:avatar}} size={72}/><div><Space wrap>
    <Upload accept="image/png,image/jpeg" showUploadList={false} beforeUpload={async file=>{
     if(!['image/png','image/jpeg'].includes(file.type)||file.size>256*1024){void message.error(t('请选择不超过 256 KB 的 PNG 或 JPEG 图片','Choose a PNG or JPEG image no larger than 256 KB'));return Upload.LIST_IGNORE}
     try{const value=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error(t('图片读取失败','Could not read the image')));reader.readAsDataURL(file)});form.setFieldValue('avatar_url',value)}catch(e){void message.error((e as Error).message)}
     return Upload.LIST_IGNORE;
    }}><Button icon={<UploadOutlined/>}>{t('更换头像','Change avatar')}</Button></Upload>
    {avatar&&<Button type="text" onClick={()=>form.setFieldValue('avatar_url','')}>{t('移除头像','Remove avatar')}</Button>}
   </Space><p className="lm-settings-hint">{t('PNG / JPEG，最大 256 KB','PNG / JPEG, up to 256 KB')}</p></div></div>
   <Form.Item name="avatar_url" hidden><Input/></Form.Item>
   <div className="lm-profile-fields">
    <Form.Item label={t('登录用户名','Username')}><Input value={user.name} readOnly aria-readonly="true"/></Form.Item>
    <Form.Item name="nickname" label={t('昵称','Display name')} extra={t('留空使用登录用户名。','Leave blank to use your username.')} rules={[{max:40,message:t('昵称最多 40 个字符','Display name must be 40 characters or fewer')}]}><Input maxLength={40} placeholder={t('填写昵称','Enter a display name')}/></Form.Item>
   </div>
   <section className="lm-profile-contacts" aria-labelledby="lm-profile-contacts-title">
    <h2 id="lm-profile-contacts-title">{t('告警联系方式','Alert contacts')}</h2>
    <p className="lm-settings-hint">{t('用于告警和值班通知。','Used for alerts and on-call notifications.')}</p>
    <div className="lm-profile-fields">
     <Form.Item name="phone" label={t('手机号','Phone number')} extra={t('支持国内 11 位或带国家区号的号码。','Use an 11-digit Chinese number or include the country code.')} rules={[{validator:(_,value:string)=>!value||/^(1[3-9]\d{9}|\+[1-9]\d{6,14})$/.test(value.replace(/[ -]/g,''))?Promise.resolve():Promise.reject(new Error(t('请输入有效的手机号','Enter a valid phone number')))}]}><Input type="tel" autoComplete="tel" placeholder="13800000000" maxLength={32}/></Form.Item>
     <Form.Item name="email" label={t('收件邮箱','Email address')} rules={[{type:'email',message:t('请输入有效的收件邮箱','Enter a valid email address')}]}><Input type="email" autoComplete="email" placeholder="name@example.com"/></Form.Item>
     <Form.Item name="feishu_id" label={t('飞书用户 open_id','Feishu user open_id')} extra={t('需与管理员配置的飞书企业应用对应。','Must match the Feishu enterprise app configured by an administrator.')}><Input maxLength={256} placeholder={t('填写 open_id','Enter an open_id')}/></Form.Item>
     <Form.Item name="dingtalk_id" label={t('钉钉用户 ID','DingTalk user ID')}><Input maxLength={256} placeholder={t('填写用户 ID','Enter a user ID')}/></Form.Item>
     <Form.Item name="wecom_id" label={t('企业微信用户 ID','WeCom user ID')}><Input maxLength={256} placeholder={t('填写用户 ID','Enter a user ID')}/></Form.Item>
    </div>
   </section>
   <Button type="primary" htmlType="submit" loading={saving}>{t('保存个人资料','Save profile')}</Button>
  </Form>}
 </div>;
}

function AppearanceSettings({user}:{user:User}){return <div className="lm-surface"><InterfacePreferences/><DefaultHomepageSettings user={user}/></div>}

function AccountBindings(){
 const {t}=useI18n();
 const [providers,setProviders]=useState<{id:string;name:string}[]>([]),[identities,setIdentities]=useState<{provider_id:string}[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 async function load(){setLoading(true);setError('');try{const [p,i]=await Promise.all([api<typeof providers>('/auth/providers'),api<typeof identities>('/auth/identities')]);setProviders(p);setIdentities(i)}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 return <div className="lm-surface lm-account-bindings"><h2>{t('第三方账号绑定','Linked accounts')}</h2><p className="lm-settings-hint">{t('绑定后可使用第三方身份登录当前账号。','Link an external identity to sign in to this account.')}</p>{loading?<Spin/>:error?<Alert type="error" title={error} action={<Button onClick={()=>void load()}>{t('重新加载','Reload')}</Button>}/>:providers.length===0?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('暂无可绑定的登录方式','No sign-in providers are available to link')}/>:providers.map(p=><div className="lm-account-binding" key={p.id}><strong>{p.name}</strong>{identities.some(i=>i.provider_id===p.id)?<Tag color="success">{t('已绑定','Linked')}</Tag>:<Button href={`/api/v1/auth/oauth/${encodeURIComponent(p.id)}/start?bind=1&return_to=${encodeURIComponent('/settings?tab=bindings')}`}>{t('绑定账号','Link account')}</Button>}</div>)}</div>;
}

export default function PersonalSettings({user,onUserUpdated}:{user:User;onUserUpdated:(user:User)=>void}){
 const {t}=useI18n();
 const [params,setParams]=useSearchParams(),tab=params.get('tab')??'profile';
 if(tab==='contacts')return <Navigate to="/settings?tab=profile" replace/>;
 if(adminTabs.includes(tab))return <Navigate to={user.role==='admin'?`/admin?${params}`:'/settings'} replace/>;
 return <div className="lm-page lm-settings-page lm-entry"><div className="lm-page-heading"><div><h1>{t('个人设置','Personal settings')}</h1><p>{t('管理个人资料、联系方式与账号偏好。','Manage your profile, contact details and account preferences.')}</p></div></div><Tabs activeKey={['profile','appearance','bindings'].includes(tab)?tab:'profile'} onChange={tab=>setParams({tab})} destroyOnHidden items={[
  {key:'profile',label:t('个人资料','Profile'),children:<ProfileSettings user={user} onUserUpdated={onUserUpdated}/>},
  {key:'appearance',label:t('界面偏好','Interface preferences'),children:<AppearanceSettings user={user}/>},
  {key:'bindings',label:t('账号绑定','Linked accounts'),children:<AccountBindings/>},
 ]}/></div>;
}
