import {Link,useSearchParams} from 'react-router-dom';
import {Button} from '../shared/ui';
import type {User} from '../shared/types';
import AgentInstall from './AgentInstall';
export default function AgentInstallPage({user}:{user:User}){
 const [params]=useSearchParams();
 return <div className="lm-page"><div className="lm-page-heading"><div><h1>接入执行节点</h1><p>安装 LightMoni Agent，采集主机指标、拨测与目录日志。</p></div><Link to="/agents"><Button>返回节点助手</Button></Link></div><AgentInstall user={user} initialGroup={params.get('group')??undefined} onKeyCreated={()=>{}}/></div>;
}
