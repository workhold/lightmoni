import {useEffect,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {Alert,Empty,Spin,Tabs} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {Dashboard} from '../features/dashboards/model';
import NativeMonitoring from './NativeMonitoring';

export default function SystemMonitoring(){
 const {t}=useI18n(),[params,setParams]=useSearchParams(),[boards,setBoards]=useState<Dashboard[]>(),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();void api<Dashboard[]>('/system-monitoring',{signal:controller.signal}).then(setBoards).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message)});return()=>controller.abort()},[]);
 const names:Record<string,string>={'system-center':t('上报中心','Reporting center'),'system-agent':t('执行节点','Agents'),'system-sdk':'SDK'};
 return <div className="lm-page"><h1>{t('系统监控','System monitoring')}</h1>{error&&<Alert type="error" showIcon title={error}/>}<Spin spinning={!boards&&!error}>{boards?.length?<Tabs activeKey={boards.some(board=>board.id===params.get('tab'))?params.get('tab')!:boards[0].id} onChange={tab=>setParams({tab})} destroyOnHidden items={boards.map(board=>({key:board.id,label:names[board.id]??board.title,children:<NativeMonitoring key={board.id} panels={board.panels}/>}))}/>:boards&&<Empty description={t('内置监控已被删除，历史删除状态已保留','Built-in monitoring was deleted; the existing deletion is preserved')}/>}</Spin></div>;
}
