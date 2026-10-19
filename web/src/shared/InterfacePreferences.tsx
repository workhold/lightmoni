import {CheckOutlined} from '@ant-design/icons';
import {Select} from './ui';
import {useAppearance,type Accent} from './appearance';
import {useI18n} from './i18n';

export default function InterfacePreferences({compact=false}:{compact?:boolean}){
 const {appearance,setAppearance,accent,setAccent}=useAppearance(),{language,setLanguage,t}=useI18n();
 const accents:{value:Accent;label:string}[]=[
  {value:'blue',label:t('蓝色','Blue')},
  {value:'teal',label:t('青色','Teal')},
  {value:'violet',label:t('紫色','Violet')},
  {value:'orange',label:t('橙色','Orange')},
 ];
 return <section className={`lm-interface-preferences${compact?' is-compact':''}`} aria-label={t('界面偏好','Interface preferences')}>
  {!compact&&<div className="lm-preferences-heading"><h2>{t('界面偏好','Interface preferences')}</h2><p>{t('调整界面外观和显示语言。','Customize the appearance and display language.')}</p></div>}
  <div className="lm-preference-field">
   <label htmlFor={compact?'lm-header-theme':'lm-settings-theme'}>{t('界面主题','Theme')}</label>
   <Select id={compact?'lm-header-theme':'lm-settings-theme'} aria-label={t('界面主题','Theme')} value={appearance} onChange={setAppearance} options={[
    {value:'dark',label:t('深色','Dark')},{value:'light',label:t('浅色','Light')},{value:'system',label:t('跟随系统','System')},
   ]}/>
  </div>
  <div className="lm-preference-field">
   <span className="lm-preference-label" id={compact?'lm-header-accent-label':'lm-settings-accent-label'}>{t('强调色','Accent color')}</span>
   <div className="lm-accent-options" role="group" aria-labelledby={compact?'lm-header-accent-label':'lm-settings-accent-label'}>
    {accents.map(option=><button type="button" key={option.value} className={`lm-accent-option${accent===option.value?' is-selected':''}`} data-accent-option={option.value} aria-pressed={accent===option.value} onClick={()=>setAccent(option.value)}><span className="lm-accent-swatch" aria-hidden="true">{accent===option.value&&<CheckOutlined/>}</span><span>{option.label}</span></button>)}
   </div>
  </div>
  <div className="lm-preference-field">
   <label htmlFor={compact?'lm-header-language':'lm-settings-language'}>{t('显示语言','Display language')}</label>
   <Select id={compact?'lm-header-language':'lm-settings-language'} aria-label={t('显示语言','Display language')} value={language} onChange={setLanguage} options={[{value:'zh-CN',label:'简体中文'},{value:'en-US',label:'English'}]}/>
  </div>
  <p className="lm-preferences-note">{t('偏好仅保存在当前浏览器。','Preferences are saved in this browser only.')}</p>
 </section>;
}
