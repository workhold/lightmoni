import {createContext,useContext,useEffect} from 'react';
import {useLocation} from 'react-router-dom';
import {boundedMonitoringContext} from './assistant-context';
import type {AssistantContext} from '../features/assistant/types';

export interface PublishedScope{pathname:string;search:string;context:AssistantContext}
export const MonitoringScope=createContext<{publish:(scope:PublishedScope)=>void}>({publish:()=>{}});
export function usePublishMonitoringContext(context:AssistantContext){
 const {publish}=useContext(MonitoringScope),{pathname,search}=useLocation(),signature=JSON.stringify(context);
 useEffect(()=>{publish({pathname,search,context:boundedMonitoringContext(JSON.parse(signature) as AssistantContext)})},[pathname,search,signature,publish]);
}
