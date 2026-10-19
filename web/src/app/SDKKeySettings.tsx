import {useEffect,useState} from 'react';
import {Alert,Button} from '../shared/ui';
import {api,post} from '../shared/api';
import SDKKeys from './SDKKeys';
import type {SDKKey,SDKKeyValues,CreatedSDKKey} from './sdk-onboarding';

export default function SDKKeySettings(){
 const[keys,setKeys]=useState<SDKKey[]>([]),[error,setError]=useState('');
 const load=async()=>{try{setKeys(await api<SDKKey[]>('/keys'));setError('');}catch(error){setError((error as Error).message);}};
 useEffect(()=>{void load();},[]);
 const create=async(values:SDKKeyValues)=>{const item=await post<CreatedSDKKey>('/keys',values);await load();return item;};
 return <>{error&&<Alert type="error" title={error} action={<Button onClick={()=>void load()}>重试</Button>}/>}<SDKKeys keys={keys} admin onCreate={create} onReload={load}/></>;
}
