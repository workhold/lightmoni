import {useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {CheckOutlined,DownOutlined,GlobalOutlined,HomeOutlined,LogoutOutlined,SettingOutlined,SkinOutlined,UserOutlined} from '@ant-design/icons';
import {App,Button,Dropdown,Popover} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import {useI18n} from '../shared/i18n';
import InterfacePreferences from '../shared/InterfacePreferences';
import {UserAvatar} from './PersonalSettings';
import './workspace-header.css';

export default function WorkspaceHeader({user,title,onLoggedOut}:{user:User;title:string;onLoggedOut:()=>void}) {
 const {t,language,setLanguage}=useI18n(),navigate=useNavigate(),{message}=App.useApp();
 const [loggingOut,setLoggingOut]=useState(false),[preferencesOpen,setPreferencesOpen]=useState(false);
 const name=user.nickname||user.name,role=user.role==='admin'?t('管理员','Administrator'):t('成员','Member');
 async function logout() {
  if(loggingOut)return;
  setLoggingOut(true);
  try {await api('/auth/logout',{method:'POST'});onLoggedOut()}
  catch(error) {void message.error(error instanceof Error?error.message:t('退出登录失败，请重试','Could not sign out. Please try again.'))}
  finally {setLoggingOut(false)}
 }
 return <header className="lm-workspace-header" role="banner" aria-label={t('工作台顶部栏','Workspace header')}>
  <div className="lm-workspace-location" title={title}><span>LightMoni</span><span aria-hidden>/</span><strong>{title}</strong></div>
  <div className="lm-workspace-actions">
   <Popover trigger="click" placement="bottomRight" open={preferencesOpen} onOpenChange={setPreferencesOpen}
    title={t('界面配色','Appearance')} content={<InterfacePreferences compact/>}>
    <Button type="text" className="lm-header-icon" icon={<SkinOutlined/>} title={t('界面配色','Appearance')} aria-label={t('界面配色','Appearance')} aria-expanded={preferencesOpen}/>
   </Popover>
   <Dropdown trigger={['click']} placement="bottomRight" menu={{selectedKeys:[language],items:[
    {key:'zh-CN',label:'简体中文',icon:language==='zh-CN'?<CheckOutlined/>:undefined},
    {key:'en-US',label:'English',icon:language==='en-US'?<CheckOutlined/>:undefined},
   ],onClick:({key})=>{if(key==='zh-CN'||key==='en-US')setLanguage(key)}}}>
    <Button type="text" className="lm-header-icon" icon={<GlobalOutlined/>} title={t('切换语言','Change language')} aria-label={t('切换语言','Change language')}/>
   </Dropdown>
   <Dropdown trigger={['click']} placement="bottomRight" menu={{items:[
    {key:'identity',label:<span className="lm-account-identity"><strong>{name}</strong><small>{user.name} · {role}</small></span>,disabled:true},
    {type:'divider'},
    {key:'profile',label:t('个人设置','Personal settings'),icon:<UserOutlined/>},
    {key:'homepage',label:t('默认首页','Default homepage'),icon:<HomeOutlined/>},
    {key:'preferences',label:t('外观与语言','Appearance and language'),icon:<SettingOutlined/>},
    {type:'divider'},
    {key:'logout',label:loggingOut?t('正在退出…','Signing out…'):t('退出登录','Sign out'),icon:<LogoutOutlined/>,danger:true,disabled:loggingOut},
   ],onClick:({key})=>{if(key==='profile')navigate('/settings?tab=profile');else if(key==='homepage')navigate('/settings?tab=appearance&section=homepage');else if(key==='preferences')navigate('/settings?tab=appearance');else if(key==='logout')void logout()}}}>
    <Button type="text" className="lm-account-trigger" aria-label={`${t('账户菜单','Account menu')}: ${name} · ${role}`} title={`${name} (${user.name}) · ${role}`} loading={loggingOut}>
     <UserAvatar user={user}/><span className="lm-account-summary"><strong>{name}</strong><small>{role}</small></span><DownOutlined className="lm-account-chevron"/>
    </Button>
   </Dropdown>
  </div>
 </header>;
}
