import {AppstoreOutlined,BellOutlined,CloudServerOutlined,DashboardOutlined,DatabaseOutlined,MessageOutlined,SafetyCertificateOutlined,SearchOutlined,SettingOutlined,ToolOutlined} from '@ant-design/icons';

export const navigationGroups=[
 {id:'workspace',label:'工作台',english:'Workspace',items:[
  {path:'/overview',label:'概览',english:'Overview',icon:DashboardOutlined,adminOnly:false},
  {path:'/assistant',label:'AI 助手',english:'AI assistant',icon:MessageOutlined,adminOnly:false},
 ]},
 {id:'monitoring',label:'监控分析',english:'Monitoring',items:[
  {path:'/dashboards',label:'监控大盘',english:'Dashboards',icon:AppstoreOutlined,adminOnly:false},
  {path:'/logs',label:'日志探索',english:'Log explorer',icon:SearchOutlined,adminOnly:false},
  {path:'/alerts',label:'告警中心',english:'Alerts',icon:BellOutlined,adminOnly:false},
 ]},
 {id:'operations',label:'运维工具',english:'Operations',items:[
  {path:'/machines',label:'主机',english:'Hosts',icon:CloudServerOutlined,adminOnly:false},
  {path:'/clusters',label:'集群',english:'Clusters',icon:CloudServerOutlined,adminOnly:true},
  {path:'/applications',label:'应用管理',english:'Applications',icon:AppstoreOutlined,adminOnly:true},
  {path:'/websites',label:'网站',english:'Websites',icon:ToolOutlined,adminOnly:true},
  {path:'/domains',label:'托管域名',english:'DNS zones',icon:DatabaseOutlined,adminOnly:true},
  {path:'/certificates',label:'证书管理',english:'Certificates',icon:SafetyCertificateOutlined,adminOnly:true},
 ]},
 {id:'data',label:'数据与接入',english:'Data & ingestion',items:[
  {path:'/data',label:'数据接入',english:'Data ingestion',icon:DatabaseOutlined,adminOnly:false},
  {path:'/data-management',label:'数据管理',english:'Data management',icon:DatabaseOutlined,adminOnly:false},
 ]},
 {id:'settings',label:'系统设置',english:'Settings',items:[
  {path:'/settings',label:'个人设置',english:'Personal settings',icon:SettingOutlined,adminOnly:false},
  {path:'/admin',label:'管理后台',english:'Administration',icon:SafetyCertificateOutlined,adminOnly:true},
 ]},
];

export const navigationLinks=navigationGroups.flatMap(group=>group.items).map(item=>({...item,pageLabel:item.label,pageEnglish:item.english}));
