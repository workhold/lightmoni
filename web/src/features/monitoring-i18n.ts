import {useCallback} from 'react';
import {useI18n} from '../shared/i18n';
import {monitoringText} from './monitoring-translations';
export function useMonitoringI18n(){
 const {language,t}=useI18n();
 const l=useCallback((text:string,...values:unknown[])=>monitoringText(text,language,...values),[language]);
 return {l,language,t};
}
