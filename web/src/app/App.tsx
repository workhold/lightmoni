import ApplicationMonitoring from "./ApplicationMonitoring";
import {MonitoringScope,type PublishedScope} from '../shared/monitoring-context';
import {lazy,Suspense,useEffect,useMemo,useState} from 'react';
import {Link,Navigate,Route,Routes,useLocation,useNavigate,useParams} from 'react-router-dom';
import {MessageOutlined,MenuFoldOutlined,MenuUnfoldOutlined} from '@ant-design/icons';
import {Button,Drawer,Spin,Tooltip} from '../shared/ui';
import {api} from '../shared/api';
import type {User} from '../shared/types';
import {LoginPage,OverviewPage,DataPage} from './CorePages';
import PersonalSettings from './PersonalSettings';
import {useI18n} from '../shared/i18n';
import WorkspaceHeader from './WorkspaceHeader';
import {navigationLinks} from './navigation';
import SidebarNavigation from './SidebarNavigation';
import {loginDestination,useDefaultHomepage} from './default-homepage';
import './navigation.css';
const McpAccessPage=lazy(()=>import('./McpAccessPage'));
const McpAuthorizationPage=lazy(()=>import('./McpAccessPage').then(module=>({default:module.McpAuthorizationPage})));
const AdminPage=lazy(()=>import('./AdminPage'));
const DashboardPage=lazy(()=>import('../features/dashboards/DashboardPage'));
const LogExplorePage=lazy(()=>import('../features/logs/LogExplorePage'));
const AlertsPage=lazy(()=>import('../features/alerts/AlertsPage'));
const TracePage=lazy(()=>import('../features/alerts/TracePage'));
const AssistantPage=lazy(()=>import('../features/assistant/AssistantPage'));
const AssistantPanel=lazy(()=>import('../features/assistant/AssistantPage').then(module=>({default:module.AssistantPanel})));
const OperationsPage=lazy(()=>import('./OperationsPage'));
const HostsNodesPage=lazy(()=>import('./HostsNodesPage'));
const DataManagementPage=lazy(()=>import('./DataManagementPage'));
const ConnectionCredentialsPage=lazy(()=>import('./ConnectionCredentialsPage'));

function ClaimLanding(){const {token}=useParams(),{search}=useLocation(),params=new URLSearchParams(search);params.set('claim',token??'');return <Navigate to={'/alerts?'+params} replace/>}

export default function Root(){
 const {t}=useI18n();
 const location=useLocation(),navigate=useNavigate();
 const[user,setUser]=useState<User|null>(null);
 const homepage=useDefaultHomepage(user);
 const[loading,setLoading]=useState(true);
 const[assistant,setAssistant]=useState(false);
 useEffect(()=>setAssistant(false),[location.pathname]);
 const[publishedScope,setPublishedScope]=useState<PublishedScope>();
 const activePath=(url:string)=>location.pathname===url||(url==='/machines'&&(location.pathname==='/agents'||location.pathname.startsWith('/agents/')))||(url!=='/'&&location.pathname.startsWith(url+'/'));
 const currentLink=navigationLinks.find(link=>activePath(link.path));
 const currentPage=location.pathname==='/mcp/authorize'?t('授权 MCP 客户端','Authorize MCP client'):currentLink?t(currentLink.pageLabel,currentLink.pageEnglish):t('监控工作台','Monitoring workspace');
 const contextPageTitle=location.pathname==='/mcp/authorize'?'授权 MCP 客户端':currentLink?.pageLabel??'监控工作台';
 const currentContext=useMemo(()=>({...((publishedScope?.pathname===location.pathname&&publishedScope.search===location.search)?publishedScope.context:{}),page:{path:location.pathname+location.search,title:contextPageTitle}}),[publishedScope,location.pathname,location.search,contextPageTitle]);
 const[navCollapsed,setNavCollapsed]=useState(()=>{try{const saved=localStorage.getItem('lightmoni.nav.collapsed');return saved===null?window.innerWidth<1100:saved==='true'}catch{return window.innerWidth<1100}});
 useEffect(()=>{const narrow=window.matchMedia('(max-width:680px)');const adapt=()=>{if(narrow.matches){setNavCollapsed(true);return;}try{const saved=localStorage.getItem('lightmoni.nav.collapsed');setNavCollapsed(saved===null?window.innerWidth<1100:saved==='true')}catch{setNavCollapsed(window.innerWidth<1100)}};adapt();narrow.addEventListener('change',adapt);return()=>narrow.removeEventListener('change',adapt)},[]);
 function toggleNavigation(){setNavCollapsed(value=>{try{localStorage.setItem('lightmoni.nav.collapsed',String(!value))}catch{}return !value})}
 useEffect(()=>{if(location.pathname==='/settings')setAssistant(false)},[location.pathname]);
 useEffect(()=>{let alive=true;api<User>('/auth/me').then(u=>{if(alive)setUser(u)}).catch(()=>{if(alive)setUser(null)}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[]);
 if(loading)return <div className="lm-loading"><Spin size="large"/></div>;
 if(!user)return <LoginPage onLogin={u=>{setUser(u);navigate(loginDestination(u,location.pathname,location.search),{replace:true})}}/>;
 return <MonitoringScope.Provider value={{publish:setPublishedScope}}><div className={`lm-shell ${navCollapsed?'is-nav-collapsed':'is-nav-expanded'} ${/^\/dashboards\/[^/]+\/panels\//.test(location.pathname)?'is-panel-standalone':''}`}>
  <aside className="lm-sidebar">
   <Link to={homepage} className="lm-brand" aria-label={t('返回默认首页','Go to default homepage')}><span className="lm-brand-mark">L</span><span>LightMoni<small>{t('监控工作台','Monitoring workspace')}</small></span></Link>
   <SidebarNavigation pathname={location.pathname} role={user.role} collapsed={navCollapsed}/>
   <Button className="lm-nav-collapse" type="text" aria-label={navCollapsed?t('展开导航','Expand navigation'):t('收起导航','Collapse navigation')} title={navCollapsed?t('展开导航','Expand navigation'):t('收起导航','Collapse navigation')} icon={navCollapsed?<MenuUnfoldOutlined/>:<MenuFoldOutlined/>} onClick={toggleNavigation}>{!navCollapsed&&t('收起导航','Collapse navigation')}</Button>
  </aside>
  <main className="lm-main"><WorkspaceHeader user={user} title={currentPage} onLoggedOut={()=>setUser(null)}/><div className="lm-route-content"><Suspense fallback={<div className="lm-page"><Spin/></div>}><Routes>
    <Route path="/" element={<Navigate to={homepage} replace/>}/>
    <Route path="/overview" element={<OverviewPage/>}/>
    <Route path="/data" element={<DataPage user={user}/>}/>
    <Route path="/data-management" element={<DataManagementPage user={user}/>}/>
    <Route path="/agents" element={<HostsNodesPage user={user}/>}/>
    <Route path="/machines" element={<HostsNodesPage user={user}/>}/>
    <Route path="/connection-credentials" element={user.role==='admin'?<ConnectionCredentialsPage/>:<Navigate to="/settings" replace/>}/>
    <Route path="/services" element={<Navigate to={user.role==='admin'?"/applications":"/settings"} replace/>}/>
    <Route path="/operations" element={<Navigate to="/applications" replace/>}/>
    {["/clusters","/applications","/websites","/domains","/certificates"].map(path=><Route key={path} path={path} element={user.role==='admin'?<OperationsPage user={user}/>:<Navigate to="/settings" replace/>}/>)}
    <Route path="/applications/:id/monitoring" element={user.role==='admin'?<ApplicationMonitoring/>:<Navigate to="/settings" replace/>}/>
    <Route path="/mcp-access" element={<McpAccessPage user={user}/>}/>
    <Route path="/mcp/authorize" element={<McpAuthorizationPage user={user}/>}/>

    <Route path="/settings" element={<PersonalSettings user={user} onUserUpdated={setUser}/>}/>
    <Route path="/admin" element={user.role==='admin'?<AdminPage user={user}/>:<Navigate to="/settings" replace/>}/>
    <Route path="/assistant" element={<AssistantPage/>}/>
    <Route path="/dashboards" element={<DashboardPage/>}/>
    <Route path="/dashboards/:id" element={<DashboardPage/>}/>
    <Route path="/dashboards/:id/panels/:panelId" element={<DashboardPage/>}/>
    <Route path="/logs/*" element={<LogExplorePage/>}/>
    <Route path="/a/:token" element={<ClaimLanding/>}/>
    <Route path="/traces/:trace_id" element={<TracePage/>}/>
    <Route path="/alerts/*" element={<AlertsPage/>}/>
    <Route path="/login" element={<Navigate to={homepage} replace/>}/>
    <Route path="*" element={<Navigate to={homepage} replace/>}/>
   </Routes></Suspense></div></main>
  {location.pathname!=='/assistant'&&location.pathname!=='/mcp/authorize'&&<Tooltip title={t('AI 助手 · 分析当前页面','AI assistant · Analyze this page')} placement="left"><Button className="lm-assistant-launcher" type="primary" shape="circle" size="large" icon={<MessageOutlined/>} aria-label={t('打开 AI 助手','Open AI assistant')} aria-expanded={assistant} onClick={()=>setAssistant(true)}/></Tooltip>}
  <Drawer title={t('AI 助手','AI assistant')} size="large" open={assistant} onClose={()=>setAssistant(false)} destroyOnHidden><Suspense fallback={<Spin/>}><AssistantPanel compact initialContext={currentContext}/></Suspense></Drawer></div></MonitoringScope.Provider>;
}
