import {MonitoringScope,type PublishedScope} from '../shared/monitoring-context';
import {lazy,Suspense,useEffect,useMemo,useState} from 'react';
import {Link,Navigate,Route,Routes,useLocation,useNavigate} from 'react-router-dom';
import {ApiOutlined,AppstoreOutlined,BellOutlined,DatabaseOutlined,DashboardOutlined,LogoutOutlined,MessageOutlined,SearchOutlined,SettingOutlined,MenuFoldOutlined,MenuUnfoldOutlined} from '@ant-design/icons';
import {Button,Drawer,Spin,Tooltip} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import {LoginPage,OverviewPage,DataPage,AgentsPage,SettingsPage} from './CorePages';
const DashboardPage=lazy(()=>import('../features/dashboards/DashboardPage'));
const LogExplorePage=lazy(()=>import('../features/logs/LogExplorePage'));
const AlertsPage=lazy(()=>import('../features/alerts/AlertsPage'));
const AssistantPage=lazy(()=>import('../features/assistant/AssistantPage'));
const AssistantPanel=lazy(()=>import('../features/assistant/AssistantPage').then(module=>({default:module.AssistantPanel})));

const links=[['/','概览',DashboardOutlined],['/dashboards','监控大盘',AppstoreOutlined],['/logs','日志探索',SearchOutlined],['/alerts','告警中心',BellOutlined],['/agents','Agent',ApiOutlined],['/data','数据接入',DatabaseOutlined],['/assistant','AI 助手',MessageOutlined],['/settings','设置',SettingOutlined]] as const;

export default function Root(){
 const location=useLocation(),navigate=useNavigate();
 const[user,setUser]=useState<User|null>(null);
 const[loading,setLoading]=useState(true);
 const[assistant,setAssistant]=useState(false);
 const[publishedScope,setPublishedScope]=useState<PublishedScope>();
 const currentPage=links.find(([url])=>url==='/'?location.pathname==='/':location.pathname.startsWith(url))?.[1]??'监控工作台';
 const currentContext=useMemo(()=>({...((publishedScope?.pathname===location.pathname&&publishedScope.search===location.search)?publishedScope.context:{}),page:{path:location.pathname+location.search,title:currentPage}}),[publishedScope,location.pathname,location.search,currentPage]);
 const[navCollapsed,setNavCollapsed]=useState(()=>{try{const saved=localStorage.getItem('lightmoni.nav.collapsed');return saved===null?window.innerWidth<1100:saved==='true'}catch{return window.innerWidth<1100}});
 function toggleNavigation(){setNavCollapsed(value=>{try{localStorage.setItem('lightmoni.nav.collapsed',String(!value))}catch{}return !value})}
 useEffect(()=>{let alive=true;api<User>('/auth/me').then(u=>{if(alive)setUser(u)}).catch(()=>{if(alive)setUser(null)}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[]);
 if(loading)return <div className="lm-loading"><Spin size="large"/></div>;
 if(!user)return <LoginPage onLogin={u=>{setUser(u);navigate('/')}}/>;
 return <MonitoringScope.Provider value={{publish:setPublishedScope}}><div className={`lm-shell ${navCollapsed?'is-nav-collapsed':'is-nav-expanded'}`}>
  <aside className="lm-sidebar">
   <Link to="/" className="lm-brand"><span className="lm-brand-mark">L</span><span>LightMoni<small>监控工作台</small></span></Link>
   <nav>{links.map(([url,label,Icon])=><Link key={url} aria-label={label} title={label} className={(url==='/'?location.pathname===url:location.pathname.startsWith(url))?'active':''} to={url}>{Icon&&<Icon/>}<span>{label}</span></Link>)}</nav>
   <Button className="lm-nav-collapse" type="text" aria-label={navCollapsed?'展开导航':'收起导航'} title={navCollapsed?'展开导航':'收起导航'} icon={navCollapsed?<MenuUnfoldOutlined/>:<MenuFoldOutlined/>} onClick={toggleNavigation}>{!navCollapsed&&'收起导航'}</Button>
   <div className="lm-sidebar-bottom"><span className="lm-avatar">{user.name[0]?.toUpperCase()}</span><div>{user.name}<small>{user.role==='admin'?'管理员':'成员'}</small></div><Button type="text" aria-label="退出登录" icon={<LogoutOutlined/>} onClick={async()=>{await api('/auth/logout',{method:'POST'});setUser(null)}}/></div>
  </aside>
  <main className="lm-main"><Suspense fallback={<div className="lm-page"><Spin/></div>}><Routes>
    <Route path="/" element={<OverviewPage/>}/>
    <Route path="/data" element={<DataPage user={user}/>}/>
    <Route path="/agents" element={<AgentsPage user={user}/>}/>
    <Route path="/settings" element={<SettingsPage user={user}/>}/>
    <Route path="/assistant" element={<AssistantPage/>}/>
    <Route path="/dashboards" element={<DashboardPage/>}/>
    <Route path="/dashboards/:id" element={<DashboardPage/>}/>
    <Route path="/logs/*" element={<LogExplorePage/>}/>
    <Route path="/alerts/*" element={<AlertsPage/>}/>
    <Route path="/login" element={<Navigate to="/"/>}/>
    <Route path="*" element={<Navigate to="/" replace/>}/>
   </Routes></Suspense></main>
  {location.pathname!=='/assistant'&&<Tooltip title="AI 助手 · 分析当前页面" placement="left"><Button className="lm-assistant-launcher" type="primary" shape="circle" size="large" icon={<MessageOutlined/>} aria-label="打开 AI 助手" aria-expanded={assistant} onClick={()=>setAssistant(true)}/></Tooltip>}
  <Drawer title="AI 助手" size="large" open={assistant} onClose={()=>setAssistant(false)} destroyOnHidden><Suspense fallback={<Spin/>}><AssistantPanel compact initialContext={currentContext}/></Suspense></Drawer></div></MonitoringScope.Provider>;
}
