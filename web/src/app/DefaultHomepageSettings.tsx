import {useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {Alert,Select} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import type {User} from '../shared/types';
import {homepageOptions,saveDefaultHomepage,useDefaultHomepage} from './default-homepage';
import './default-homepage.css';

export default function DefaultHomepageSettings({user}:{user:User}){
 const {t}=useI18n(),[params]=useSearchParams(),homepage=useDefaultHomepage(user);
 const [status,setStatus]=useState<'saved'|'error'>(),section=useRef<HTMLElement>(null);
 const direct=params.get('section')==='homepage';
 useEffect(()=>{
  if(!direct)return;
  section.current?.scrollIntoView({block:'center'});
  section.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});
 },[direct]);
 return <section id="lm-homepage-settings" ref={section} className="lm-interface-preferences lm-homepage-preference" aria-labelledby="lm-homepage-title">
  <div className="lm-preferences-heading"><h2 id="lm-homepage-title">{t('默认首页','Default homepage')}</h2><p>{t('选择登录或访问平台入口时进入的页面。直接打开具体页面链接时仍进入该页面。','Choose the page to open when signing in or entering the platform. Direct links still open their destination.')}</p></div>
  <div className="lm-preference-field">
   <label htmlFor="lm-settings-homepage">{t('默认首页','Default homepage')}</label>
   <Select id="lm-settings-homepage" aria-label={t('默认首页','Default homepage')} value={homepage} onChange={value=>setStatus(saveDefaultHomepage(user,value)?'saved':'error')} options={homepageOptions(user.role).map(link=>({value:link.path,label:t(link.label,link.english)}))}/>
  </div>
  {status&&<Alert showIcon type={status==='saved'?'success':'error'} title={status==='saved'?t('默认首页已保存','Default homepage saved'):t('无法确认默认首页已保存，请检查浏览器存储权限后重试。','Could not confirm your default homepage was saved. Check browser storage permissions and try again.')}/>}
  <p className="lm-preferences-note">{t('仅对当前账号在此浏览器生效。选择“AI 助手”可恢复默认。','Applies only to this account in this browser. Choose “AI assistant” to restore the default.')}</p>
 </section>;
}
