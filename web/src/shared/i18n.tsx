import {createContext,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useState,type ReactNode} from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/en';

export type Language='zh-CN'|'en-US';
export type Translator=(chinese:string,english:string)=>string;
const languageKey='lightmoni.language';
const validLanguage=(value:unknown):value is Language=>value==='zh-CN'||value==='en-US';
function readLanguage():Language{
 try{const value=localStorage.getItem(languageKey);return validLanguage(value)?value:'zh-CN'}catch{return 'zh-CN'}
}

const I18nContext=createContext<{language:Language;setLanguage:(language:Language)=>void;t:(chinese:string,english:string)=>string}>({language:'zh-CN',setLanguage:()=>{},t:chinese=>chinese});
export const useI18n=()=>useContext(I18nContext);

export function I18nProvider({children}:{children:ReactNode}){
 const [language,setValue]=useState<Language>(readLanguage);
 const setLanguage=useCallback((next:Language)=>{
  if(!validLanguage(next))return;
  setValue(next);
  try{localStorage.setItem(languageKey,next)}catch{/* Preferences remain usable when browser storage is unavailable. */}
 },[]);
 const t=useCallback((chinese:string,english:string)=>language==='en-US'?english:chinese,[language]);
 useLayoutEffect(()=>{document.documentElement.lang=language;dayjs.locale(language==='en-US'?'en':'zh-cn')},[language]);
 useEffect(()=>{
  const onStorage=(event:StorageEvent)=>{if(event.key===languageKey||event.key===null)setValue(readLanguage())};
  window.addEventListener('storage',onStorage);
  return()=>window.removeEventListener('storage',onStorage);
 },[]);
 const value=useMemo(()=>({language,setLanguage,t}),[language,setLanguage,t]);
 return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export default I18nProvider;
