import {useEffect,useState} from 'react';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Descriptions,Drawer,Empty,Select,Space,Spin,Table,Tag,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,time,type Machine,type Resource,type Run,type Spec} from './model';
import {INSTALL_PHASES,installDiagnostic,installationState} from './install-state';

export default function ApplicationInstallDrawer({resourceId,resources,machines,onClose,onManage}:{resourceId?:string;resources:Resource[];machines:Machine[];onClose:()=>void;onManage:(resource:Resource)=>void}){
 const {t}=useI18n(),[resource,setResource]=useState<Resource>(),[runs,setRuns]=useState<Run[]>([]),[runID,setRunID]=useState<string>(),[run,setRun]=useState<Run>(),[events,setEvents]=useState<Spec[]>([]),[error,setError]=useState(''),[eventError,setEventError]=useState(''),[loaded,setLoaded]=useState(false),[refresh,setRefresh]=useState(0);
 const phase=(value:string)=>value==='started'?t('已开始','Started'):INSTALL_PHASES[value]?t(...INSTALL_PHASES[value]):value||'—';
 const badge=(state:string)=><Tag color={state==='succeeded'?'success':['failed','error'].includes(state)?'error':['unknown','warning','cancelled'].includes(state)?'warning':state==='started'?undefined:'processing'}>{phase(state)}</Tag>;
 useEffect(()=>{setResource(undefined);setRuns([]);setRunID(undefined);setLoaded(false);setError('')},[resourceId]);
 useEffect(()=>{
  if(!resourceId)return;let active=true,busy=false;
  const load=async()=>{if(busy)return;busy=true;try{
   const [snapshot,history]=await Promise.all([api<{resource:Resource}>('/ops/resources/'+encodeURIComponent(resourceId)),api<{runs:Run[]}>('/ops/runs?resource_id='+encodeURIComponent(resourceId))]);
   if(!active)return;setResource(snapshot.resource);setRuns(history.runs);setRunID(id=>id&&history.runs.some(r=>r.id===id)?id:history.runs.find(r=>['apply','deploy'].includes(r.action))?.id??history.runs[0]?.id);setError('');
  }catch(e){if(active)setError(errorText(e))}finally{if(active)setLoaded(true);busy=false}};
  void load();const timer=setInterval(()=>void load(),2000);return()=>{active=false;clearInterval(timer)};
 },[resourceId,refresh]);
 useEffect(()=>{
  setEvents([]);setRun(undefined);setEventError('');if(!resourceId||!runID)return;let active=true,busy=false,after=0;
  const load=async()=>{if(busy)return;busy=true;try{for(let page=0;page<10;page++){
   const data=await api<{run:Run;events:Spec[];next_after:number}>('/ops/runs/'+encodeURIComponent(runID)+'/events?after='+after);
   if(!active)return;setRun(data.run);setEvents(previous=>[...previous,...data.events.filter(e=>!previous.some(old=>old.sequence===e.sequence))]);after=data.next_after;setEventError('');if(data.events.length<200)break;
  }}catch(e){if(active)setEventError(errorText(e))}finally{busy=false}};
  void load();const timer=setInterval(()=>void load(),2000);return()=>{active=false;clearInterval(timer)};
 },[resourceId,runID,refresh]);
 const state=resource?installationState(resource):'pending',result=run?.result??{},latest=events.at(-1);
 const failed=['failed','unknown','cancelled'].includes(run?.state??'');
 const cause=result.cause_code??result.code??(failed?[...events].reverse().find(e=>e.code)?.code:undefined);
 const diagnosis=installDiagnostic(cause),deployments=Object.entries(resource?.status.deployments??{}) as [string,Spec][];
 return <Drawer open={!!resourceId} title={t('安装进度','Installation progress')+(resource?' · '+resource.name:'')} size="min(960px, 100vw)" className="lm-install-progress" onClose={onClose} destroyOnHidden>
  <Space wrap style={{marginBottom:16}}><Button icon={<ReloadOutlined aria-hidden/>} onClick={()=>setRefresh(v=>v+1)}>{t('刷新','Refresh')}</Button>{resource&&<Button onClick={()=>onManage(resource)}>{t('调整配置 / 重新部署','Edit configuration / redeploy')}</Button>}</Space>
  {error&&<Alert type="error" showIcon title={t('进度读取失败，保留上次结果','Could not refresh progress; showing the last result')} description={error}/>}
  {!loaded?<Spin/>:resource?<>
   <Alert className="lm-install-summary" showIcon type={state==='succeeded'?'success':state==='failed'?'error':state==='unknown'?'warning':'info'} title={state==='succeeded'?t('安装完成，应用已运行','Installation complete; application is running'):state==='failed'?t('安装未完成','Installation incomplete'):state==='unknown'?t('执行结果未知','Execution result unknown'):state==='stopped'?t('应用已停止','Application is stopped'):t('安装进行中','Installation in progress')} description={state==='unknown'?t('请先检查目标机器的实际状态，再决定是否重新部署。','Inspect actual state on the target before redeploying.'):state==='pending'?t('每 2 秒更新。关闭此窗口后仍会继续安装，可从应用列表重新查看。','Updates every 2 seconds. Installation continues after closing; reopen from the application list.'):t('各机器的执行记录和失败原因保留在下方。','Per-machine history and failure details are retained below.')}/>
   {deployments.map(([id,d])=>(d.last_error||d.pending)?<Alert key={id} showIcon style={{marginTop:12}} type={d.last_error?'error':'info'} title={(resources.find(r=>r.id===id)?.name??id)+' · '+t(...installDiagnostic(d.last_error||d.pending).slice(0,2) as [string,string])} description={<>{String(d.last_error||d.pending)}<br/>{t(...installDiagnostic(d.last_error||d.pending).slice(2,4) as [string,string])}</>}/>:null)}
   {!deployments.some(([,d])=>d.last_error)&&resource.status.last_error&&state==='failed'&&<Alert style={{marginTop:12}} type="error" title={t(...installDiagnostic(resource.status.last_error).slice(0,2) as [string,string])} description={String(resource.status.last_error)}/>}
   <h3>{t('机器执行记录','Machine execution history')}</h3>
   <Select aria-label={t('机器执行记录','Machine execution history')} style={{width:'100%'}} value={runID} onChange={setRunID} placeholder={t('等待生成执行记录','Waiting for an execution record')} options={runs.map(r=>({value:r.id,label:(machines.find(m=>m.agent_id===r.agent_id)?.name??r.agent_id??t('中心','Controller'))+' · '+time(r.created_at)+' · '+r.action+' · '+phase(r.state)+' · '+r.id.slice(0,6)}))}/>
   {run&&<Descriptions style={{marginTop:16}} size="small" column={{xs:1,sm:2}} items={[{key:'state',label:t('执行状态','Execution state'),children:badge(run.state)},{key:'phase',label:t('当前 / 最后阶段','Current / last phase'),children:phase(result.phase??latest?.phase??run.state)},{key:'updated',label:t('更新时间','Updated'),children:time(run.updated_at)},{key:'version',label:t('配置版本','Revision'),children:'v'+run.resource_revision},{key:'id',label:t('执行 ID','Run ID'),children:<Typography.Text copyable>{run.id}</Typography.Text>}]}/>}
   {failed&&<Alert style={{marginTop:12}} type={run?.state==='unknown'?'warning':'error'} showIcon title={t('失败原因','Failure reason')+' · '+t(diagnosis[0],diagnosis[1])} description={<div>{cause&&<Typography.Text code>{String(cause)}</Typography.Text>}<p>{t(diagnosis[2],diagnosis[3])}</p>{result.code&&result.code!==cause&&<small>{String(result.code)}</small>}{run?.state==='unknown'&&<p>{t('结果未知，请先检查实际状态，不要重复安装。','Inspect actual state before attempting another installation.')}</p>}</div>}/>} 
   {eventError&&<Alert style={{marginTop:12}} type="error" showIcon title={t('步骤日志读取失败','Could not load step logs')} description={eventError}/>}
   <Table<Spec> style={{marginTop:16}} rowKey="sequence" size="small" pagination={false} dataSource={events} scroll={{x:580}} locale={{emptyText:<Empty description={run?t('此执行暂无步骤日志；旧记录无法还原步骤','No steps recorded; older executions cannot be reconstructed'):t('尚未生成执行记录，请查看上方安装状态','No execution record yet; check the installation status above')}/>}} columns={[{title:t('时间','Time'),dataIndex:'created_at',width:170,render:time},{title:t('安装步骤','Installation step'),render:(_,e)=><>{phase(e.phase)}{e.code&&<small className="lm-ops-error-text">{t(...installDiagnostic(e.code).slice(0,2) as [string,string])}<br/>{e.code}</small>}</>},{title:t('状态','State'),width:110,render:(_,e)=>badge(e.state==='running'&&e.sequence!==latest?.sequence?'started':e.state)}]}/>
  </>:null}
 </Drawer>;
}
