import {useEffect,useState} from 'react';
import {Alert,Button,Spin} from '../../shared/ui';
import {api,ApiError} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import PrivilegedJobResult,{isPrivilegedJob,type PrivilegedExecutionJob} from '../PrivilegedJobResult';

const capability='operations.managed.v1';
export default function ManagedExecutionResult({jobID,hostID,hostName}:{jobID:string;hostID:string;hostName:string}){
 const {t}=useI18n(),[state,setState]=useState<'loading'|'ready'|'absent'|'error'>('loading'),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true;setState('loading');
  void api<{job:PrivilegedExecutionJob}>('/privileged-execution/jobs/'+encodeURIComponent(jobID)).then(({job})=>{
   if(active)setState(job.id===jobID&&job.machine_id===hostID&&isPrivilegedJob(job,capability)?'ready':'error');
  }).catch(error=>{if(active)setState(error instanceof ApiError&&error.status===404?'absent':'error')});
  return()=>{active=false};
 },[jobID,hostID,retry]);
 if(state==='absent')return null;
 return <div style={{marginTop:16}}>{state==='loading'?<Spin/>:state==='ready'?<PrivilegedJobResult jobID={jobID} capability={capability} hostID={hostID} hostName={hostName}/>:<Alert type="warning" showIcon title={t('主机执行记录无法读取或身份不匹配','Host execution record unavailable or identity does not match')} action={<Button onClick={()=>setRetry(v=>v+1)}>{t('重新读取','Reload')}</Button>}/>}</div>;
}
