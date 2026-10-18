import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {Alert,Button,Spin} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable,User} from '../shared/types';
import AgentInstall from './AgentInstall';
export default function AgentInstallPage({user}:{user:User}){
 const [params]=useSearchParams(),[tables,setTables]=useState<CatalogTable[]>([]),[error,setError]=useState(''),[ready,setReady]=useState(false);
 const load=async()=>{try{setTables(await api('/catalog/tables'));setReady(true);setError('');}catch(error){setError((error as Error).message);}};
 useEffect(()=>{void load();},[]);
 return <div className="lm-page"><div className="lm-page-heading"><div><h1>接入执行节点</h1><p>安装 LightMoni Agent，采集主机指标、拨测与目录日志。</p></div><Link to="/agents"><Button>返回节点助手</Button></Link></div>{error&&<Alert type="error" title={error} action={<Button onClick={()=>void load()}>重试</Button>}/>}{ready?<AgentInstall user={user} tables={tables} initialGroup={params.get('group')??undefined} onKeyCreated={()=>void load()}/>:!error&&<Spin/>}</div>;
}
