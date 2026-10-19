import {useMonitoringI18n} from '../monitoring-i18n';
import {printable} from './model';
export default function JSONTree({value,depth=0}:{value:unknown;depth?:number}){
 const {l,language}=useMonitoringI18n();

 if(value===null||typeof value!=='object')return <code className={typeof value==='string'?'lm-log-json-string':''}>{printable(value)}</code>;
 const entries=Object.entries(value);if(depth>=8)return <pre>{JSON.stringify(value,null,2)}</pre>;
 return <details open={depth<2} className="lm-log-json-node"><summary>{Array.isArray(value)?l("[{0} 项]",entries.length):l("{{0} 个字段}",entries.length)}</summary><div>{entries.slice(0,300).map(([key,v])=><div className="lm-log-json-field" key={key}><b>{key}: </b><JSONTree value={v} depth={depth+1}/></div>)}{entries.length>300&&<small>{l("当前树展示前 300 项，完整内容可复制为 JSON。")}</small>}</div></details>
}
