import {useEffect,useState} from 'react';
import {Alert,App,Button,Modal,Select,Typography} from '../shared/ui';
import {api} from '../shared/api';
import type {CatalogTable} from '../shared/types';
type Policy={table:string;default_seconds:number;periods:number[];history:{seconds:number;effective_at:number}[]};
const label=(v:number)=>v<60?`${v} 秒`:v<3600?`${v/60} 分钟`:`${v/3600} 小时`;
export function MetricWindowEditor({table,onClose}:{table?:CatalogTable;onClose:()=>void}){
 const {message}=App.useApp();
 const[policy,setPolicy]=useState<Policy>(),[seconds,setSeconds]=useState(30),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{if(!table)return;const abort=new AbortController();setPolicy(undefined);setError('');api<Policy>('/metric-windows/'+table.logical_name,{signal:abort.signal}).then(p=>{if(abort.signal.aborted)return;setPolicy(p);setSeconds(p.history.at(-1)?.seconds??p.default_seconds);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[table,reload]);
 const current=policy?.history.filter(p=>p.effective_at<=Date.now()/1000).at(-1),pending=policy?.history.find(p=>p.effective_at>Date.now()/1000);
 return <Modal title="上报聚合周期" open={!!table} onCancel={()=>{if(!busy)onClose();}} okText="保存" cancelText="取消" confirmLoading={busy} okButtonProps={{disabled:!policy}} onOk={async()=>{if(!table||!policy||busy)return;setBusy(true);setError('');try{const saved=await api<Policy>('/metric-windows/'+table.logical_name,{method:'PUT',body:JSON.stringify({window_seconds:seconds})});const next=saved.history.find(p=>p.effective_at>Date.now()/1000);void message.success(next?`已保存，将于 ${new Date(next.effective_at*1000).toLocaleString()} 生效`:'上报聚合周期已保存');onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
 <p>每张表选择一个周期，默认 30 秒。同表所有指标和实例按统一时间边界聚合，不同表可独立设置。</p>
 <Select aria-label="上报聚合周期" value={seconds} style={{width:'100%'}} disabled={!policy||busy} onChange={setSeconds} options={(policy?.periods??[]).map(v=>({value:v,label:label(v)+(v===policy?.default_seconds?'（默认）':'')}))}/>
 <p><Typography.Text type="secondary">查询步长须为实际上报周期的整数倍。变更会在至少一分钟后的共同窗口边界生效，历史数据保留原周期。</Typography.Text></p>
 {current&&<p>当前生效：{label(current.seconds)}{pending&&`；待生效：${label(pending.seconds)}（${new Date(pending.effective_at*1000).toLocaleString()}）`}</p>}
 {error&&<Alert type="error" title={error} action={!policy?<Button onClick={()=>setReload(v=>v+1)}>重试</Button>:undefined}/>}
 </Modal>;
}
