import {createContext,useContext,useLayoutEffect,useMemo,useState,type ReactNode} from 'react';
import zhCN from 'antd/locale/zh_CN';
import {ConfigProvider,theme} from './ui';

type Appearance='dark'|'light';
const AppearanceContext=createContext<{appearance:Appearance;dark:boolean;setAppearance:(value:Appearance)=>void}>({appearance:'dark',dark:true,setAppearance:()=>{}});
export const useAppearance=()=>useContext(AppearanceContext);
export default function AppearanceProvider({children}:{children:ReactNode}){
 const [appearance,setValue]=useState<Appearance>(()=>{try{return localStorage.getItem('lightmoni.appearance')==='light'?'light':'dark'}catch{return 'dark'}});
 const dark=appearance==='dark';
 useLayoutEffect(()=>{document.documentElement.dataset.theme=appearance;document.documentElement.style.colorScheme=appearance;},[appearance]);
 const value=useMemo(()=>({appearance,dark,setAppearance:(next:Appearance)=>{setValue(next);try{localStorage.setItem('lightmoni.appearance',next)}catch{/* Appearance remains usable when storage is unavailable. */}}}),[appearance,dark]);
 return <AppearanceContext.Provider value={value}><ConfigProvider locale={zhCN} theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm,token:{colorPrimary:dark?'#5794f2':'#2563eb',colorBgBase:dark?'#111217':'#fff',colorBgLayout:dark?'#111217':'#f5f6f8',colorBgContainer:dark?'#181b1f':'#fff',colorBgElevated:dark?'#22252b':'#fff',colorBorder:dark?'#3b3f46':'#e2e6ed',colorText:dark?'#d8d9da':'#192337',colorTextSecondary:dark?'#a6adba':'#64738a',borderRadius:3,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',fontSize:14},components:{Button:{controlHeight:34,primaryShadow:'none'},Table:{cellPaddingBlock:11},Modal:{titleFontSize:18},Segmented:{trackBg:dark?'#111217':'#f0f2f5',itemSelectedBg:dark?'#343940':'#fff'}}}}>{children}</ConfigProvider></AppearanceContext.Provider>;
}
