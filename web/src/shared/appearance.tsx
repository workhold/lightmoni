import {createContext,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useState,type ReactNode} from 'react';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import {ConfigProvider,theme} from './ui';
import {useI18n} from './i18n';
import './preferences.css';

export type Appearance='dark'|'light'|'system';
export type Accent='blue'|'teal'|'violet'|'orange';
const appearanceKey='lightmoni.appearance',accentKey='lightmoni.accent';
const validAppearance=(value:unknown):value is Appearance=>value==='dark'||value==='light'||value==='system';
const validAccent=(value:unknown):value is Accent=>value==='blue'||value==='teal'||value==='violet'||value==='orange';
function readAppearance():Appearance{try{const value=localStorage.getItem(appearanceKey);return validAppearance(value)?value:'dark'}catch{return 'dark'}}
function readAccent():Accent{try{const value=localStorage.getItem(accentKey);return validAccent(value)?value:'blue'}catch{return 'blue'}}
function systemDark(){try{return window.matchMedia('(prefers-color-scheme: dark)').matches}catch{return false}}

// Bright colors remain legible on dark surfaces; light themes use darker colors with white button text.
const accentColors={
 blue:{light:'#1d4ed8',dark:'#73a6fa'},
 teal:{light:'#0f766e',dark:'#5eead4'},
 violet:{light:'#6d28d9',dark:'#c4b5fd'},
 orange:{light:'#b45309',dark:'#fdba74'},
} as const;

const AppearanceContext=createContext<{appearance:Appearance;dark:boolean;setAppearance:(value:Appearance)=>void;accent:Accent;setAccent:(value:Accent)=>void}>({appearance:'dark',dark:true,setAppearance:()=>{},accent:'blue',setAccent:()=>{}});
export const useAppearance=()=>useContext(AppearanceContext);

export default function AppearanceProvider({children}:{children:ReactNode}){
 const {language}=useI18n();
 const [appearance,setValue]=useState<Appearance>(readAppearance),[accent,setAccentValue]=useState<Accent>(readAccent),[prefersDark,setPrefersDark]=useState(systemDark);
 const dark=appearance==='system'?prefersDark:appearance==='dark';
 const color=accentColors[accent][dark?'dark':'light'];
 const setAppearance=useCallback((next:Appearance)=>{
  if(!validAppearance(next))return;
  if(next==='system')setPrefersDark(systemDark());
  setValue(next);try{localStorage.setItem(appearanceKey,next)}catch{/* Appearance remains usable without browser storage. */}
 },[]);
 const setAccent=useCallback((next:Accent)=>{
  if(!validAccent(next))return;
  setAccentValue(next);try{localStorage.setItem(accentKey,next)}catch{/* Appearance remains usable without browser storage. */}
 },[]);
 useEffect(()=>{
  let media:MediaQueryList;
  try{media=window.matchMedia('(prefers-color-scheme: dark)')}catch{return}
  const change=()=>setPrefersDark(media.matches);
  change();
  if(typeof media.addEventListener==='function'){media.addEventListener('change',change);return()=>media.removeEventListener('change',change)}
  media.addListener(change);return()=>media.removeListener(change);
 },[]);
 useEffect(()=>{
  const onStorage=(event:StorageEvent)=>{
   if(event.key===appearanceKey||event.key===null)setValue(readAppearance());
   if(event.key===accentKey||event.key===null)setAccentValue(readAccent());
  };
  window.addEventListener('storage',onStorage);return()=>window.removeEventListener('storage',onStorage);
 },[]);
 useLayoutEffect(()=>{
  const root=document.documentElement;
  root.dataset.theme=dark?'dark':'light';root.dataset.accent=accent;root.style.colorScheme=dark?'dark':'light';
  root.style.setProperty('--lm-accent',color);
  root.style.setProperty('--lm-accent-soft',`color-mix(in srgb, ${color} ${dark?'18':'10'}%, transparent)`);
  root.style.setProperty('--lm-accent-contrast',dark?'#10151d':'#ffffff');
  root.style.setProperty('--primary',color);
  root.style.setProperty('--primary-soft',`color-mix(in srgb, ${color} ${dark?'18':'10'}%, transparent)`);
 },[dark,accent,color]);
 const value=useMemo(()=>({appearance,dark,setAppearance,accent,setAccent}),[appearance,dark,setAppearance,accent,setAccent]);
 return <AppearanceContext.Provider value={value}><ConfigProvider locale={language==='en-US'?enUS:zhCN} theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm,token:{colorPrimary:color,colorLink:color,colorBgBase:dark?'#111217':'#fff',colorBgLayout:dark?'#111217':'#f5f6f8',colorBgContainer:dark?'#181b1f':'#fff',colorBgElevated:dark?'#22252b':'#fff',colorBorder:dark?'#3b3f46':'#e2e6ed',colorText:dark?'#d8d9da':'#192337',colorTextSecondary:dark?'#a6adba':'#64738a',borderRadius:3,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',fontSize:14},components:{Button:{controlHeight:34,primaryShadow:'none',primaryColor:dark?'#10151d':'#ffffff'},Table:{cellPaddingBlock:11},Modal:{titleFontSize:18},Segmented:{trackBg:dark?'#111217':'#f0f2f5',itemSelectedBg:dark?'#343940':'#fff'}}}}>{children}</ConfigProvider></AppearanceContext.Provider>;
}
