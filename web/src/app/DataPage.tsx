import {useCallback,useEffect,useRef,useState} from 'react';
import {Navigate,useSearchParams} from 'react-router-dom';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Spin,Tabs} from '../shared/ui';
import {api,post} from '../shared/api';
import type {User} from '../shared/types';
import SDKSetup from './SDKSetup';
import SDKKeys from './SDKKeys';
import SDKExemptTables from './SDKExemptTables';
import type {SDKInstall} from './sdkExamples';
import {sdkError,type SDKKey,type SDKKeyValues,type CreatedSDKKey,type ExemptTable,type ExemptTableValues} from './sdk-onboarding';

export default function DataPage({user}:{user:User}){
 const [params,setParams]=useSearchParams(),admin=user.role==='admin',requestedTab=params.get('tab');
 const tab=requestedTab==='keys'||requestedTab==='exempt'?requestedTab:'sdk';
 const [install,setInstall]=useState<SDKInstall>(),[keys,setKeys]=useState<SDKKey[]>([]),[exempt,setExempt]=useState<ExemptTable[]>([]),[secrets,setSecrets]=useState<Record<string,string>>({});
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[error,setError]=useState(''),request=useRef(0);
 const load=useCallback(async()=>{const current=++request.current;setLoading(true);setError('');try{const [sdk,keyList,exemptList]=await Promise.all([api<SDKInstall>('/sdk-install'),admin?api<SDKKey[]>('/keys'):Promise.resolve([]),api<ExemptTable[]>('/sdk-exempt-tables')]);if(current!==request.current)return;setInstall(sdk);setKeys(keyList);setExempt(exemptList);setReady(true);}catch(error){if(current===request.current){setError(sdkError(error));setReady(false);}}finally{if(current===request.current)setLoading(false);}},[admin]);
 useEffect(()=>{void load();return()=>{request.current++;};},[load]);
 const createKey=async(values:SDKKeyValues)=>{const created=await post<CreatedSDKKey>('/keys',values);setKeys(previous=>[{...created,active:true,last_used:'',upload_batches:0,error_count:0},...previous]);setSecrets(previous=>({...previous,[created.id]:created.key}));return created;};
 const createExempt=async(values:ExemptTableValues)=>{const item=await post<ExemptTable>('/sdk-exempt-tables',values);setExempt(previous=>[item,...previous]);return item;};
 if(requestedTab==='tables')return <Navigate replace to="/data-management"/>;
 if(requestedTab==='templates')return <Navigate replace to="/dashboards"/>;
 return <div className="lm-page lm-sdk-page">
  <div className="lm-page-heading"><div><h1>SDK 接入</h1></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新</Button></div>
  {error&&<Alert showIcon type="error" title="接入配置加载失败" description={error} action={<Button size="small" onClick={()=>void load()}>重试</Button>} style={{marginBottom:16}}/>}
  {loading&&!ready?<Spin/>:<Tabs activeKey={tab} onChange={tab=>setParams({tab})} items={[
   {key:'sdk',label:'SDK 样例',children:<SDKSetup install={install} keys={keys} secrets={secrets} exempt={exempt} admin={admin} ready={ready&&!loading} onCreateKey={createKey} onCreateExempt={createExempt} onManageExempt={()=>setParams({tab:'exempt'})}/>},
   {key:'keys',label:'SDK 密钥',children:<SDKKeys keys={keys} admin={admin} onCreate={createKey} onReload={load}/>},
   {key:'exempt',label:'豁免表',children:<SDKExemptTables items={exempt} admin={admin} onCreate={createExempt} onReload={load}/>},
  ]}/>}
 </div>;
}
