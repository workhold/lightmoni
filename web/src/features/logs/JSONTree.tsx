import {printable} from './model';
export default function JSONTree({value,depth=0}:{value:unknown;depth?:number}){
 if(value===null||typeof value!=='object')return <code className={typeof value==='string'?'lm-log-json-string':''}>{printable(value)}</code>;
 const entries=Object.entries(value);if(depth>=8)return <pre>{JSON.stringify(value,null,2)}</pre>;
 return <details open={depth<2} className="lm-log-json-node"><summary>{Array.isArray(value)?`[${entries.length} 项]`:`{${entries.length} 个字段}`}</summary><div>{entries.slice(0,300).map(([key,v])=><div className="lm-log-json-field" key={key}><b>{key}: </b><JSONTree value={v} depth={depth+1}/></div>)}{entries.length>300&&<small>当前树展示前 300 项，完整内容可复制为 JSON。</small>}</div></details>
}
