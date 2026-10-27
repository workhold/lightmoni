import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {RightOutlined} from '@ant-design/icons';
import {useI18n} from '../shared/i18n';
import type {User} from '../shared/types';
import {navigationGroups} from './navigation';

export default function SidebarNavigation({pathname,role,collapsed}:{pathname:string;role:User['role'];collapsed:boolean}){
 const {t}=useI18n();
 const activePath=(path:string)=>pathname===path||(path!=='/'&&pathname.startsWith(path+'/'));
 const groups=navigationGroups.map(group=>({...group,items:group.items.filter(item=>!item.adminOnly||role==='admin')})).filter(group=>group.items.length>0);
 const currentGroup=groups.find(group=>group.items.some(item=>activePath(item.path)))?.id;
 const [expandedGroup,setExpandedGroup]=useState(currentGroup);
 useEffect(()=>setExpandedGroup(currentGroup),[pathname,currentGroup]);

 return <nav aria-label={t('主导航','Main navigation')}>{groups.map(group=>{
  const open=collapsed||expandedGroup===group.id;
  const title=t(group.label,group.english),titleID=`lm-nav-${group.id}`,linksID=`${titleID}-links`;
  return <section className="lm-nav-group" key={group.id} aria-labelledby={titleID}>
   <h2 className="lm-nav-group-title" id={titleID}>{collapsed?title:<button type="button" className={`lm-nav-group-toggle${currentGroup===group.id?' is-current':''}`} aria-expanded={open} aria-controls={linksID} onClick={()=>setExpandedGroup(value=>value===group.id?undefined:group.id)}><span>{title}</span><RightOutlined className="lm-nav-group-chevron" aria-hidden/></button>}</h2>
   <div className="lm-nav-group-links" id={linksID} hidden={!open}>{group.items.map(({path,label,english,icon:Icon})=><Link key={path} aria-label={t(label,english)} title={t(label,english)} aria-current={activePath(path)?'page':undefined} className={activePath(path)?'active':''} to={path}><Icon/><span>{t(label,english)}</span></Link>)}</div>
  </section>;
 })}</nav>;
}
