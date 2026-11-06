import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Input,Modal,Space,Table,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';

type Plan={id:string;machine_id:string;status:string;reason:string;revision:string;expires_at:string;error:string;
 snapshot:{machine:{id:string;name:string;agent_id:string};instances:Record<string,any>[]};proof:Record<string,any>[];receipt:{instances?:unknown[];data_retained?:boolean}};
export default function MachineWorkloadRecoveryDialog({machine,onClose,onRefresh}:{machine:{id:string;name:string};onClose():void;onRefresh():Promise<void>}){
 const {t}=useI18n(),[record,setRecord]=useState<Plan>(),[reason,setReason]=useState(''),[name,setName]=useState(''),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[now,setNow]=useState(Date.now());
 const mounted=useRef(true),pending=useRef(false),reading=useRef(false),ref=useRef(record);ref.current=record;
 const base=`/machines/${encodeURIComponent(machine.id)}/workload-recoveries`;
 const valid=(p:Plan)=>{if(!p?.id||p.machine_id!==machine.id||p.snapshot?.machine.id!==machine.id||!Array.isArray(p.snapshot.instances))throw Error(t('恢复记录与主机不匹配','Recovery record does not match this host'));return p;};
 const message=(value:unknown)=>{
  const code=value instanceof Error?value.message:String(value);
  if(code.includes('upgrade_required'))return t('请先升级当前 Agent，再核验旧实例','Upgrade the current Agent before verifying previous instances');
  if(code.includes('execution_unresolved'))return t('旧身份仍在线或有未结束任务，请先核对任务结果','The previous Agent or its execution is unresolved. Verify the task results first.');
  if(code.includes('instance_count'))return t('没有需要恢复绑定的旧实例，或数量超过单次上限','No previous bindings require recovery, or the batch exceeds its limit.');
  if(code.includes('managed_state_required'))return t('原受管状态或数据位置无法确认，请先核对保留目录和备份','The original managed state or data location is unconfirmed. Check retained directories and backups.');
  if(code.includes('ownership_unverified'))return t('容器归属、受管状态或固定路径未通过核验，请核对原目录和备份','Container ownership, managed state or fixed paths could not be verified. Check original directories and backups.');
  if(code.includes('inspection_failed'))return t('只读核验未完成，请检查当前 Agent 的 Docker 访问和保留目录','Read-only verification did not complete. Check the current Agent Docker access and retained directories.');
  if(/changed|expired/.test(code))return t('主机、配置或核验结果已变化，请取消原计划后重新核验','The host, configuration or evidence changed. Cancel the old plan and verify again.');
  return code;
 };
 const read=async()=>{
  if(reading.current||pending.current)return;reading.current=true;
  try{
   const old=ref.current;
   const next=old?valid(await api<Plan>(`${base}/${encodeURIComponent(old.id)}`)):(await api<Plan[]>(base)).map(valid).find(p=>['preparing','awaiting_approval','verifying','unknown'].includes(p.status));
   if(mounted.current){if(next){setRecord(next);setReason(next.reason)}setUncertain(false);setError('');}
  }catch(e){if(mounted.current)setError(message(e));}finally{reading.current=false;}
 };
 useEffect(()=>{mounted.current=true;void read();const clock=setInterval(()=>setNow(Date.now()),1000);return()=>{mounted.current=false;clearInterval(clock)}},[machine.id]);
 useEffect(()=>{if(!record||!['preparing','verifying'].includes(record.status))return;const timer=setInterval(()=>void read(),2000);return()=>clearInterval(timer)},[record?.id,record?.status]);
 const mutate=async(action:'plan'|'apply'|'cancel')=>{
  if(pending.current||reading.current)return;pending.current=true;setBusy(true);setError('');
  const old=record;
  try{
   const next=valid(await api<Plan>(action==='plan'?`${base}/plan`:`${base}/${encodeURIComponent(old!.id)}/${action}`,{method:'POST',body:JSON.stringify(action==='plan'?{reason:reason.trim()}:action==='apply'?{revision:old!.revision,confirm:true}:{})}));
   if(mounted.current){setRecord(next);setChecked(false);setName('');setUncertain(false);void onRefresh().catch(()=>{});}
  }catch(e){if(mounted.current){setError(message(e));setUncertain(true);}}finally{pending.current=false;if(mounted.current)setBusy(false);}
 };
 const labels:Record<string,string>={preparing:t('正在只读核验旧实例','Verifying previous instances'),awaiting_approval:t('核验完成，等待审阅','Verified; awaiting review'),verifying:t('正在复验并恢复绑定','Rechecking and restoring bindings'),succeeded:t('应用绑定已恢复','Application bindings restored'),failed:t('恢复未完成','Recovery incomplete'),unknown:t('结果待核对','Outcome requires verification'),cancelled:t('计划已取消','Plan cancelled'),expired:t('计划已过期','Plan expired')};
 const expired=!!record&&Date.parse(record.expires_at)<=now;
 const rows:Record<string,any>[]=record?.snapshot.instances.map(i=>({...i,proof:record.proof.find(p=>p.instance_id===i.instance_id)}))??[];
 return <Modal open title={t('恢复重装后的应用绑定','Restore application bindings after reinstallation')+' · '+machine.name} width={1050} onCancel={()=>{if(!busy)onClose()}} closable={!busy} maskClosable={false} footer={<Space wrap>
  {!record&&<Button type="primary" loading={busy} disabled={busy||uncertain||!reason.trim()} onClick={()=>void mutate('plan')}>{t('只读核验并生成计划','Verify and create plan')}</Button>}
  {record?.status==='awaiting_approval'&&<Button type="primary" loading={busy} disabled={busy||uncertain||expired||!checked||name!==record.snapshot.machine.name} onClick={()=>void mutate('apply')}>{t('复验并恢复应用绑定','Recheck and restore bindings')}</Button>}
  {record&&['preparing','awaiting_approval'].includes(record.status)&&<Button disabled={busy||uncertain} onClick={()=>void mutate('cancel')}>{t('取消恢复计划','Cancel recovery plan')}</Button>}
  <Button disabled={busy} onClick={()=>void read()}>{t('刷新原记录','Refresh original record')}</Button>
  {record&&['succeeded','failed','cancelled','expired'].includes(record.status)&&<Button disabled={busy} onClick={()=>{setRecord(undefined);setChecked(false);setName('');setUncertain(false)}}>{t('新建核验计划','Create another verification plan')}</Button>}
  <Button disabled={busy} onClick={onClose}>{t('关闭','Close')}</Button>
 </Space>}>
  <Typography.Paragraph>{t('核对这台主机重装前的待恢复应用实例。审批后再次只读核验，再恢复中心管理绑定；保留原实例、数据位置、端口和配置，随后按中心配置对账并验证健康。','Verify application instances awaiting recovery from the previous Agent on this host. After approval, recheck the evidence and restore center bindings while retaining instance IDs, data locations, ports and configuration. Normal reconciliation then verifies configuration and health.')}</Typography.Paragraph>
  {error&&<Alert type="error" showIcon title={error}/>}
  {uncertain&&<Alert type="warning" showIcon title={t('请求结果尚未确认，请刷新原记录，不要重复提交','The request is not confirmed. Refresh its original record instead of submitting again.')}/>}
  {!record?<><Typography.Paragraph>{t('核查原因','Verification reason')}</Typography.Paragraph><Input.TextArea aria-label={t('应用绑定恢复原因','Application binding recovery reason')} value={reason} maxLength={1000} rows={3} onChange={e=>setReason(e.target.value)}/></>:<>
   <Alert showIcon type={record.status==='succeeded'?'success':record.status==='failed'?'error':'info'} title={labels[record.status]??record.status} description={record.error?message(record.error):record.status==='succeeded'?t('中心绑定已更新，业务健康由后续实际观测确认。','Center bindings are updated. Subsequent observations confirm business health.'):undefined}/>
   <Descriptions size="small" column={1} items={[
    {key:'host',label:t('目标主机','Target host'),children:record.snapshot.machine.name},
    {key:'agent',label:t('当前 Agent 身份','Current Agent identity'),children:<Typography.Text code copyable>{record.snapshot.machine.agent_id}</Typography.Text>},
    {key:'reason',label:t('核查原因','Verification reason'),children:record.reason},
    {key:'expires',label:t('审阅有效期','Review expiry'),children:record.expires_at?new Date(record.expires_at).toLocaleString():'—'},
   ]}/>
   <Table rowKey="instance_id" pagination={false} scroll={{x:850,y:380}} dataSource={rows} columns={[
    {title:t('应用与原实例','Application and previous instance'),render:(_,r)=><>{r.name}<br/><Typography.Text code title={r.instance_id}>{r.instance_id.slice(0,12)}</Typography.Text> · v{r.resource_revision}</>},
    {title:t('原 Agent','Previous Agent'),render:(_,r)=><Typography.Text code title={r.old_agent_id}>{r.old_agent_id.slice(0,12)}</Typography.Text>},
    {title:t('容器与数据位置','Containers and data location'),render:(_,r)=><>{r.proof?<>{r.proof.containers.length} {t('个归属已核验容器','verified containers')}<br/><Typography.Text code>{r.proof.data_path}</Typography.Text>{(r.proof.mounts??[]).map((m:Record<string,any>,n:number)=><div key={n}><Typography.Text code>{m.source} → {m.target}</Typography.Text></div>)}</>:t('正在核验','Verifying')}</>},
    {title:t('恢复影响','Recovery effect'),render:(_,r)=>r.proof?r.proof.action==='retire_absent'?t('退役已确认的空记录','Retire verified empty record'):t('恢复原实例管理，保留数据位置','Restore original instance binding and data location'):'—'},
   ]}/>
   {record.status==='awaiting_approval'&&<><Alert type="warning" showIcon title={t('此计划不执行远端容器写入；旧任务、身份或数据核验异常时拒绝恢复。','This plan performs no remote container writes. Unresolved tasks, changed identities or unverified data block recovery.')}/><Typography.Paragraph>{t('输入主机名称确认范围','Enter the host name to confirm scope')}</Typography.Paragraph><Input aria-label={t('确认恢复应用的主机名称','Confirm workload recovery host name')} value={name} onChange={e=>setName(e.target.value)}/><Checkbox checked={checked} onChange={e=>setChecked(e.target.checked)}>{t('已审阅全部旧实例、容器归属、数据位置和恢复影响','I reviewed all previous instances, container ownership, data locations and recovery effects')}</Checkbox>{expired&&<Alert type="warning" title={t('计划已过期，请取消后重新核验','The plan expired. Cancel it and verify again.')}/>}</>}
   <Typography.Paragraph type="secondary">{t('恢复计划 ID','Recovery plan ID')}: {record.id}</Typography.Paragraph>
  </>}
 </Modal>;
}
