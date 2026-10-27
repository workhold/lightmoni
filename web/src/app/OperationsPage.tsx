import {useCallback,useEffect,useMemo,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,App,Button,Checkbox,Descriptions,Empty,Form,Input,InputNumber,Modal,Popconfirm,Select,Space,Switch,Table,Tabs,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import type {User} from '../shared/types';
import './operations.css';

type Kind='website'|'certificate'|'compose'|'backup';
type Resource={id:string;kind:Kind;name:string;agent_id:string;revision:number;config:Record<string,any>;updated_at:string};
type Run={id:string;resource_id:string;resource_revision:number;operation:string;state:string;preview:any;receipt:any;created_at:string;expires_at:string;job_id:string};
type Schedule={id:string;name:string;revision:number;resource_id:string;resource_revision:number;operation:string;input:any;cron:string;timezone:string;enabled:boolean;disabled_reason:string};
type Agent={id:string;hostname?:string;host_id:string;last_seen:string};
const ACTIONS:Record<Kind,string[]>={website:['inspect','apply','check','logs','restore','disable'],certificate:['inspect','install','issue','renew'],compose:['discover','inspect','logs','adopt','apply','start','stop','restart','rollback'],backup:['list','create','verify','prune','restore']};
const SCHEDULED:Record<Kind,string[]>={website:['inspect'],certificate:['renew'],compose:['inspect'],backup:['create','verify','prune']};
const READ_ONLY=new Set(['inspect','check','logs','discover','list','verify']);
const ACTIVE=new Set(['queued','leased','accepted','preflighting','staging','activating','verifying']);
const EXAMPLE=JSON.stringify({services:{web:{image:'nginx:1.27.5',restart:'unless-stopped',ports:['127.0.0.1:18080:80']}}},null,2);
const splitDomains=(v:string)=>v.split(/[\s,，]+/).map(v=>v.trim()).filter(Boolean);
const resultOf=(run?:Run)=>run?.receipt?.snapshot?.operations?.data??{};
const pathID=(v:string)=>encodeURIComponent(v);

export default function OperationsPage({user}:{user:User}){
 const {t,language}=useI18n(),{message}=App.useApp();
 const [params]=useSearchParams();
 const [tab,setTab]=useState<Kind|'schedules'>('website');
 const [resources,setResources]=useState<Resource[]>([]),[runs,setRuns]=useState<Run[]>([]),[agents,setAgents]=useState<Agent[]>([]),[services,setServices]=useState<{id:string;name:string}[]>([]),[schedules,setSchedules]=useState<Schedule[]>([]);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [editor,setEditor]=useState<{kind:Kind;resource?:Resource}>(),[editorError,setEditorError]=useState('');
 const [actionResource,setActionResource]=useState<Resource>(),[actionError,setActionError]=useState('');
 const [currentRun,setCurrentRun]=useState<Run>(),[runError,setRunError]=useState(''),[planNow,setPlanNow]=useState(Date.now());
 const [scheduleEditor,setScheduleEditor]=useState<{schedule?:Schedule}>(),[scheduleError,setScheduleError]=useState(''),[fireDetail,setFireDetail]=useState<{schedule:Schedule;fires:any[]}>();
 const [form]=Form.useForm(),[actionForm]=Form.useForm(),[scheduleForm]=Form.useForm();
 const selectedAgent=Form.useWatch('agent_id',form),mode=Form.useWatch('mode',form),certificate=Form.useWatch('certificate_id',form),storageType=Form.useWatch('storage_type',form),keepCompose=Form.useWatch('keep_compose',form);
 const operation=Form.useWatch('operation',actionForm),scheduleResourceID=Form.useWatch('resource_id',scheduleForm),scheduleOperation=Form.useWatch('operation',scheduleForm);
 const scheduleResource=resources.find(r=>r.id===scheduleResourceID);
 const name=(kind:Kind|'schedules')=>({website:t('网站','Websites'),certificate:t('证书','Certificates'),compose:t('容器与 Compose','Containers & Compose'),backup:t('备份恢复','Backup & restore'),schedules:t('计划任务','Schedules')}[kind]);
 const actionName=(op:string)=>({inspect:t('检查状态','Inspect'),apply:t('应用配置','Apply configuration'),check:t('验证访问','Check website'),logs:t('查看日志','View logs'),restore:t('恢复','Restore'),disable:t('停用网站','Disable website'),install:t('安装上传证书','Install certificate'),issue:t('申请 ACME 证书','Issue ACME certificate'),renew:t('续期 ACME 证书','Renew ACME certificate'),discover:t('发现容器','Discover containers'),adopt:t('接管项目','Adopt project'),start:t('启动','Start'),stop:t('停止','Stop'),restart:t('重启','Restart'),rollback:t('恢复历史配置','Restore configuration'),list:t('备份目录','List backups'),create:t('创建备份','Create backup'),verify:t('校验备份','Verify backup'),prune:t('执行保留策略','Apply retention')}[op]??op);
 const stateName=(state:string)=>({awaiting_approval:t('待人工确认','Awaiting approval'),queued:t('等待节点领取','Queued'),leased:t('节点已领取','Leased'),accepted:t('执行中','Accepted'),preflighting:t('预检中','Preflighting'),staging:t('准备中','Staging'),activating:t('应用中','Applying'),verifying:t('验证中','Verifying'),succeeded:t('已验证成功','Verified success'),failed:t('失败','Failed'),unknown:t('结果未知，需检查','Unknown; inspect target'),cancelled:t('已取消','Cancelled'),skipped_busy:t('跳过：上次尚未结束','Skipped: prior run active')}[state]??state);
 const reasonName=(reason:string)=>({resource_changed:t('配置版本变化，需重新授权','Resource changed; authorize again'),unknown_result:t('结果未知，需检查并重新授权','Unknown result; inspect and authorize again'),authorizer_unavailable:t('授权管理员已禁用或降权','Authorizing administrator unavailable'),resource_unavailable:t('资源不可用','Resource unavailable'),dispatch_failed:t('任务下发失败','Dispatch failed')}[reason]??reason);
 const errorText=(e:unknown)=>e instanceof Error?e.message:t('操作失败，请重试','Operation failed; try again');
 const time=(v:string)=>v?new Date(v).toLocaleString(language):'—';
 const status=(s:string)=><Tag color={s==='succeeded'?'success':s==='unknown'||s==='failed'?'error':s==='awaiting_approval'?'warning':'processing'}>{stateName(s)}</Tag>;
 const load=useCallback(async()=>{setLoading(true);try{
  const [rs,rr,aa,ss,sv]=await Promise.all([api<{resources:Resource[]}>('/operations/resources'),api<{runs:Run[]}>('/operations/runs'),api<{agents:Agent[]}>('/operations/agents'),api<{schedules:Schedule[]}>('/operation-schedules'),api<{id:string;name:string}[]>('/services')]);
  setResources(rs.resources);setRuns(rr.runs);setAgents(aa.agents);setSchedules(ss.schedules);setServices(sv);setError('');
 }catch(e){setError(e instanceof Error?e.message:'Request failed')}finally{setLoading(false)}},[]);
 useEffect(()=>{if(user.role==='admin')void load()},[load,user.role]);
 useEffect(()=>{const id=params.get('run');if(!id||user.role!=='admin')return;let alive=true;api<{run:Run}>('/operations/runs/'+pathID(id)).then(v=>{if(alive)setCurrentRun(v.run)}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'Request failed')});return()=>{alive=false}},[params,user.role]);
 useEffect(()=>{if(!currentRun||!ACTIVE.has(currentRun.state))return;const id=currentRun.id;const timer=setInterval(()=>{api<{run:Run}>('/operations/runs/'+pathID(id)).then(v=>{setCurrentRun(r=>r?.id===id?v.run:r);setRuns(rs=>rs.map(r=>r.id===id?v.run:r))}).catch(()=>{})},5000);return()=>clearInterval(timer)},[currentRun?.id,currentRun?.state]);
 useEffect(()=>{setPlanNow(Date.now());const expiry=Date.parse(currentRun?.expires_at??'');if(currentRun?.state!=='awaiting_approval'||!Number.isFinite(expiry)||expiry<=Date.now())return;const timer=setTimeout(()=>setPlanNow(Date.now()),Math.min(2147483647,expiry-Date.now()+50));return()=>clearTimeout(timer)},[currentRun?.id,currentRun?.state,currentRun?.expires_at]);
 const latestData=(resource:Resource)=>Object.assign({},...runs.filter(r=>r.resource_id===resource.id&&r.state==='succeeded').slice().reverse().map(resultOf));
 const openEditor=(kind:Kind,resource?:Resource)=>{
  const c=resource?.config??{},s=c.storage??{};setEditor({kind,resource});setEditorError('');form.resetFields();
  form.setFieldsValue({name:resource?.name??'',agent_id:resource?.agent_id,domains:(c.domains??[]).join('\n'),mode:c.mode??'proxy',upstream:c.upstream??'http://127.0.0.1:3000',upstream_tls_verify:c.upstream_tls_verify!==false,listen_port:c.listen_port??8088,https_port:c.https_port??8443,certificate_id:c.certificate_id??'',service_id:c.service_id,html:c.static_files?.['index.html']??'<!doctype html>\n<html><body><h1>Hello from LightMoni</h1></body></html>',email:c.email??'',certificate_pem:'',private_key_pem:'',project_name:c.project_name??'',keep_compose:!!resource,compose_json:resource?'':EXAMPLE,source_path:c.source_path??'/srv/lightmoni/site',storage_type:s.type??'local',storage_path:s.path??'/var/lib/lightmoni/backups',endpoint:s.endpoint??'',bucket:s.bucket??'',region:s.region??'us-east-1',prefix:s.prefix??'lightmoni',access_key_id:'',secret_access_key:'',session_token:'',max_mib:(c.max_bytes??64*1024*1024)/1024/1024,max_files:c.max_files??10000,retain_count:c.retain_count??7});
 };
 const saveResource=async(v:any)=>{if(!editor)return;setBusy(true);setEditorError('');try{
  let config:Record<string,any>={};
  if(editor.kind==='website')config={domains:splitDomains(v.domains),mode:v.mode,listen_port:v.listen_port,certificate_id:v.certificate_id??'',...(v.certificate_id?{https_port:v.https_port}:{}),service_id:v.service_id||null,...(v.mode==='proxy'?{upstream:v.upstream,upstream_tls_verify:v.upstream_tls_verify!==false}:{static_files:{...(editor.resource?.config.static_files??{}),'index.html':v.html}})};
  if(editor.kind==='certificate')config={domains:splitDomains(v.domains),email:v.email??'',...(v.certificate_pem?.trim()?{certificate_pem:v.certificate_pem.trim(),private_key_pem:v.private_key_pem?.trim()??''}:{})};
  if(editor.kind==='compose'){
   config={project_name:v.project_name,service_id:v.service_id||null};
   if(!editor.resource||!v.keep_compose){let doc;try{doc=JSON.parse(v.compose_json)}catch{throw Error(t('Compose 配置必须是有效的 JSON 对象','Compose configuration must be a valid JSON object'))}if(!doc||typeof doc!=='object'||Array.isArray(doc)||JSON.stringify(doc).includes('[redacted]'))throw Error(t('请填写完整配置，不能提交脱敏占位内容','Provide the complete configuration without redaction placeholders'));config.compose=doc;}
  }
  if(editor.kind==='backup')config={source_path:v.source_path,max_bytes:Math.round(v.max_mib*1024*1024),max_files:v.max_files,retain_count:v.retain_count,storage:v.storage_type==='local'?{type:'local',path:v.storage_path}:{type:'s3',endpoint:v.endpoint,bucket:v.bucket,region:v.region,prefix:v.prefix,...(v.access_key_id?{access_key_id:v.access_key_id}:{}),...(v.secret_access_key?{secret_access_key:v.secret_access_key}:{}),...(v.session_token?{session_token:v.session_token}:{})}};
  const body=editor.resource?{revision:editor.resource.revision,name:v.name,config}:{kind:editor.kind,name:v.name,agent_id:v.agent_id,config};
  await api('/operations/resources'+(editor.resource?'/'+pathID(editor.resource.id):''),{method:editor.resource?'PUT':'POST',body:JSON.stringify(body)});setEditor(undefined);form.resetFields();await load();void message.success(t('配置已保存，尚未执行','Configuration saved; no action executed'));
 }catch(e){setEditorError(errorText(e))}finally{setBusy(false)}};
 const openAction=(resource:Resource,op?:string,extra:any={})=>{const data=latestData(resource);setActionResource(resource);setActionError('');actionForm.resetFields();actionForm.setFieldsValue({operation:op??ACTIONS[resource.kind][0],expected_generation:data.generation??0,inventory_sha256:data.inventory_sha256??'',expected_target_sha256:data.current_target_sha256??data.source_sha256??'',tail:100,lines:100,stream:'access',...extra});};
 const plan=async(v:any)=>{if(!actionResource)return;setBusy(true);setActionError('');try{const op=v.operation;let input:any={};
  if(actionResource.kind==='website'){if(op==='restore')input={version:v.version};if(op==='logs')input={stream:v.stream,lines:v.lines};}
  if(actionResource.kind==='backup'&&['verify','restore'].includes(op))input={backup_id:v.backup_id,...(op==='restore'?{expected_target_sha256:v.expected_target_sha256}:{})};
  if(actionResource.kind==='compose'){if(op==='logs')input={container_id:v.container_id,tail:v.tail};else if(!READ_ONLY.has(op)){input={expected_generation:v.expected_generation};if(op==='adopt')input={...input,inventory_sha256:v.inventory_sha256,acknowledge_recreate:v.acknowledge_recreate===true};if(op==='rollback')input.target_generation=v.target_generation;if(v.acknowledge_unknown&&['apply','rollback'].includes(op))input.acknowledge_unknown=true;if(v.service&&['start','stop','restart'].includes(op))input.service=v.service;}}
  const result=await api<{run:Run}>('/operations/resources/'+pathID(actionResource.id)+'/plans',{method:'POST',body:JSON.stringify({operation:op,input})});setActionResource(undefined);setCurrentRun(result.run);setRunError('');await load();
 }catch(e){setActionError(errorText(e))}finally{setBusy(false)}};
 const refreshRun=async()=>{if(!currentRun)return;setBusy(true);try{const r=await api<{run:Run}>('/operations/runs/'+pathID(currentRun.id));setCurrentRun(r.run);setRunError('');await load()}catch(e){setRunError(errorText(e))}finally{setBusy(false)}};
 const approve=async()=>{if(!currentRun)return;setBusy(true);setRunError('');try{const r=await api<{run:Run}>('/operations/runs/'+pathID(currentRun.id)+'/approve',{method:'POST',body:JSON.stringify({revision:currentRun.resource_revision})});setCurrentRun(r.run);await load()}catch(e){setRunError(errorText(e))}finally{setBusy(false)}};
 const remove=async(r:Resource)=>{setBusy(true);try{await api('/operations/resources/'+pathID(r.id),{method:'DELETE',body:JSON.stringify({revision:r.revision})});await load()}catch(e){void message.error(errorText(e))}finally{setBusy(false)}};
 const openSchedule=(schedule?:Schedule)=>{setScheduleEditor({schedule});setScheduleError('');scheduleForm.resetFields();scheduleForm.setFieldsValue(schedule?{...schedule,backup_id:schedule.input?.backup_id}:{cron:'0 2 * * *',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone??'UTC',enabled:false});};
 const saveSchedule=async(v:any)=>{if(!scheduleEditor||!scheduleResource)return;setBusy(true);setScheduleError('');try{const old=scheduleEditor.schedule;await api('/operation-schedules'+(old?'/'+pathID(old.id):''),{method:old?'PUT':'POST',body:JSON.stringify({...(old?{revision:old.revision}:{}),name:v.name,resource_id:scheduleResource.id,resource_revision:scheduleResource.revision,operation:v.operation,input:v.operation==='verify'?{backup_id:v.backup_id}:{},cron:v.cron,timezone:v.timezone,enabled:v.enabled===true})});setScheduleEditor(undefined);await load()}catch(e){setScheduleError(errorText(e))}finally{setBusy(false)}};
 const scheduleCommand=async(s:Schedule,command:'run'|'delete')=>{setBusy(true);try{await api('/operation-schedules/'+pathID(s.id)+(command==='run'?'/run':''),{method:command==='run'?'POST':'DELETE',body:JSON.stringify({revision:s.revision})});await load();if(command==='run')await showFires(s)}catch(e){void message.error(errorText(e))}finally{setBusy(false)}};
 const showFires=async(s:Schedule)=>{try{setFireDetail(await api<{schedule:Schedule;fires:any[]}>('/operation-schedules/'+pathID(s.id)))}catch(e){void message.error(errorText(e))}};
 const resourceMap=useMemo(()=>new Map(resources.map(r=>[r.id,r])),[resources]);
 const data=resultOf(currentRun),currentResource=currentRun?resourceMap.get(currentRun.resource_id):undefined;
 const required=[{required:true,message:t('请填写此项','This field is required')}];
 if(user.role!=='admin')return <div className="lm-page"><Alert type="info" showIcon title={t('运维工具仅管理员可用','Operations are available to administrators')}/></div>;
 return <div className="lm-page lm-operations-page">
  <div className="lm-page-heading"><div><h1>{t('运维工具','Operations')}</h1><p>{t('管理网站、证书、容器与备份，通过 LightMoni Agent 执行并验证。','Manage websites, certificates, containers and backups with verified Agent execution.')}</p></div><Button icon={<ReloadOutlined/>} onClick={()=>void load()} loading={loading}>{t('刷新','Refresh')}</Button></div>
  <Alert type="info" showIcon title={t('先保存配置，再预览并确认执行','Save configuration, then review and approve execution')} description={t('保存配置不会更改主机。每次执行绑定节点、配置版本和参数；AI 助手可以生成方案，执行需要管理员确认。','Saving does not modify the host. Each action binds its node, revision and parameters. AI can propose plans; administrators approve execution.')}/>
  {error&&<Alert type="error" showIcon title={t('加载失败','Unable to load')} description={error}/>}
  <Tabs activeKey={tab} onChange={k=>setTab(k as any)} items={(['website','certificate','compose','backup','schedules']as const).map(k=>({key:k,label:name(k)}))}/>
  <section className="lm-ops-section lm-surface">
   <div className="lm-ops-section-heading"><h2>{name(tab)}</h2><Button type="primary" icon={<PlusOutlined/>} onClick={()=>tab==='schedules'?openSchedule():openEditor(tab)}>{tab==='schedules'?t('新增计划','New schedule'):t('新增配置','New configuration')}</Button></div>
   {tab==='schedules'?<>
    <p className="lm-ops-note">{t('仅支持已登记的备份、证书续期及只读检查。修改资源后计划停用，需重新确认版本；错过的执行窗口不补跑。','Only registered backups, certificate renewal and read-only inspections can be scheduled. Resource changes revoke authorization. Missed execution windows are skipped.')}</p>
    <Table<Schedule> rowKey="id" loading={loading} dataSource={schedules} scroll={{x:960}} locale={{emptyText:<Empty description={t('尚无计划任务','No schedules yet')}/>}} columns={[
     {title:t('计划','Schedule'),dataIndex:'name',render:(_,s)=><div><strong>{s.name}</strong><small>{resourceMap.get(s.resource_id)?.name??s.resource_id} · {actionName(s.operation)}</small></div>},
     {title:t('时间规则','Timing'),render:(_,s)=><div><code>{s.cron}</code><small>{s.timezone}</small></div>},
     {title:t('授权状态','Authorization'),render:(_,s)=><div><Tag color={s.enabled?'success':'default'}>{s.enabled?t('已启用','Enabled'):t('已停用','Disabled')}</Tag>{s.disabled_reason&&<small>{reasonName(s.disabled_reason)}</small>}</div>},
     {title:t('操作','Actions'),render:(_,s)=><Space wrap><Button size="small" onClick={()=>openSchedule(s)}>{t('编辑 / 重新授权','Edit / authorize')}</Button><Button size="small" onClick={()=>void showFires(s)}>{t('历史','History')}</Button><Popconfirm title={t('立即运行这个已授权动作？','Run this authorized action now?')} onConfirm={()=>scheduleCommand(s,'run')}><Button size="small" disabled={busy||s.disabled_reason==='unknown_result'}>{t('立即运行','Run now')}</Button></Popconfirm><Popconfirm title={t('删除计划？已有执行记录仍保留在运维历史中。','Delete schedule? Operation runs remain in history.')} onConfirm={()=>scheduleCommand(s,'delete')}><Button size="small" danger>{t('删除','Delete')}</Button></Popconfirm></Space>}
    ]}/>
   </>:<>
    <p className="lm-ops-note">{tab==='website'?t('静态站与反向代理使用独立受管 Nginx；不会自动接管已有网关或端口。ACME 需要域名公网解析到本机，并使用受管 HTTP 80 端口。','Static sites and proxies use a dedicated Nginx gateway. Existing gateways and ports are never adopted automatically. ACME requires public DNS and managed HTTP port 80.'):tab==='certificate'?t('先创建证书配置，上传后选择安装，或申请 ACME 证书。续期可通过计划任务启用；私钥不回显。','Create a configuration, then install uploaded material or issue an ACME certificate. Renewal can be scheduled; private keys are never returned.'):tab==='compose'?t('先发现并检查项目，再明确接管。停止不会删除卷；配置恢复不回滚业务数据。仅支持已校验的 Compose 子集。','Discover and inspect before adopting a project. Stopping preserves volumes; restoring configuration does not restore application data. A validated Compose subset is supported.'):t('仅备份受管目录文件，不提供数据库一致性保证。恢复前校验目标摘要并保留副本；副本不受自动保留清理影响。','Back up managed directory files; database consistency is not provided. Restore checks the target digest and preserves a recovery copy, which retention never prunes.')}</p>
    <Table<Resource> rowKey="id" loading={loading} dataSource={resources.filter(r=>r.kind===tab)} scroll={{x:850}} locale={{emptyText:<Empty description={t('尚无配置，先登记节点并新增配置','No configurations. Enroll a node and add one.')}/>}} columns={[
     {title:t('名称','Name'),render:(_,r)=><div><strong>{r.name}</strong><small>{r.kind==='website'||r.kind==='certificate'?(r.config.domains??[]).join(', '):r.kind==='compose'?r.config.project_name:r.config.source_path}</small></div>},
     {title:t('执行节点','Execution node'),render:(_,r)=><div>{agents.find(a=>a.id===r.agent_id)?.hostname??r.agent_id}<small>{t('配置版本','Revision')} {r.revision}</small></div>},
     {title:t('最近执行','Latest execution'),render:(_,r)=>{const last=runs.find(v=>v.resource_id===r.id);return last?<Button type="link" onClick={()=>{setCurrentRun(last);setRunError('')}}>{status(last.state)}</Button>:t('尚未执行','Not executed')}},
     {title:t('操作','Actions'),render:(_,r)=><Space wrap><Button type="primary" size="small" onClick={()=>openAction(r)}>{t('执行操作','Actions')}</Button><Button size="small" onClick={()=>openEditor(r.kind,r)}>{t('编辑','Edit')}</Button><Popconfirm title={t('仅删除平台配置，不删除远端文件、容器、卷或备份。确认删除？','Delete configuration only? Remote files, containers, volumes and backups remain.')} onConfirm={()=>remove(r)}><Button size="small" danger disabled={busy}>{t('删除配置','Delete config')}</Button></Popconfirm></Space>}
    ]}/>
   </>}
  </section>
  <section className="lm-ops-section lm-surface"><div className="lm-ops-section-heading"><h2>{t('最近执行记录','Recent operation runs')}</h2></div>
   <Table<Run> rowKey="id" size="small" dataSource={runs} scroll={{x:850}} pagination={{pageSize:8}} columns={[
    {title:t('资源 / 动作','Resource / action'),render:(_,r)=><div>{resourceMap.get(r.resource_id)?.name??r.resource_id}<small>{actionName(r.operation)} · {t('版本','Revision')} {r.resource_revision}</small></div>},
    {title:t('状态','Status'),render:(_,r)=>status(r.state)},{title:t('创建时间','Created'),render:(_,r)=>time(r.created_at)},
    {title:t('详情','Details'),render:(_,r)=><Button size="small" onClick={()=>{setCurrentRun(r);setRunError('')}}>{r.state==='awaiting_approval'?t('审阅方案','Review plan'):t('查看结果','View result')}</Button>}
   ]}/>
  </section>
  <Modal title={editor?(editor.resource?t('编辑','Edit'):t('新增','New'))+' · '+name(editor.kind):''} open={!!editor} onCancel={()=>{if(!busy){setEditor(undefined);form.resetFields()}}} footer={null} width={760} destroyOnHidden>
   {editorError&&<Alert type="error" showIcon title={t('无法保存配置','Unable to save configuration')} description={editorError}/>}
   <Form form={form} layout="vertical" onFinish={saveResource} className="lm-ops-form">
    <div className="lm-ops-grid"><Form.Item name="name" label={t('名称','Name')} rules={required}><Input maxLength={128}/></Form.Item><Form.Item name="agent_id" label={t('执行节点','Execution node')} rules={required}><Select onChange={()=>form.setFieldValue('certificate_id','')} showSearch optionFilterProp="label" disabled={!!editor?.resource} options={agents.map(a=>({value:a.id,label:(a.hostname??a.host_id??a.id)+' · '+a.id}))} notFoundContent={t('请先安装并注册 LightMoni Agent','Install and enroll a LightMoni Agent first')}/></Form.Item></div>
    {editor&&['website','certificate'].includes(editor.kind)&&<Form.Item name="domains" label={t('域名','Domains')} rules={required} extra={t('每行一个域名，或用逗号分隔。此版本不支持通配符。','One domain per line or comma-separated. Wildcards are not supported.')}><Input.TextArea rows={2} placeholder="example.com"/></Form.Item>}
    {editor?.kind==='website'&&<>
     <div className="lm-ops-grid"><Form.Item name="mode" label={t('网站类型','Website type')}><Select options={[{value:'proxy',label:t('反向代理','Reverse proxy')},{value:'static',label:t('静态网站','Static website')}]}/></Form.Item><Form.Item name="listen_port" label={t('HTTP 端口','HTTP port')} rules={required}><InputNumber min={1} max={65535}/></Form.Item></div>
     {mode==='proxy'?<Form.Item name="upstream" label={t('上游地址','Upstream URL')} rules={required}><Input placeholder="http://127.0.0.1:3000"/></Form.Item>:<Form.Item name="html" label="index.html" rules={required} extra={t('编辑首页；保留其他静态文件，总文本限 512 KiB / 200 个文件。','Edit the index page; preserve other files. Total text is limited to 512 KiB / 200 files.')}><Input.TextArea rows={8} className="lm-ops-code"/></Form.Item>}
     {mode==='proxy'&&<Form.Item name="upstream_tls_verify" valuePropName="checked" extra={t('HTTPS 上游默认验证证书；仅在已了解风险的自签名环境中关闭。','HTTPS upstream certificates are verified by default. Disable only for a trusted self-signed environment.')}><Checkbox>{t('验证 HTTPS 上游证书','Verify HTTPS upstream certificate')}</Checkbox></Form.Item>}
     <div className="lm-ops-grid"><Form.Item name="certificate_id" label={t('HTTPS 证书','HTTPS certificate')}><Select allowClear options={resources.filter(r=>r.kind==='certificate'&&r.agent_id===(editor.resource?.agent_id??selectedAgent)).map(r=>({value:r.id,label:r.name}))} placeholder={t('不启用 HTTPS','HTTPS disabled')}/></Form.Item>{certificate&&<Form.Item name="https_port" label={t('HTTPS 端口','HTTPS port')} rules={required}><InputNumber min={1} max={65535}/></Form.Item>}</div>
    </>}
    {editor?.kind==='certificate'&&<>
     <Form.Item name="email" label={t('ACME 联系邮箱','ACME contact email')} extra={t('申请和续期必须填写；签发意味着接受 ACME 服务条款。','Required for issuance and renewal; issuing accepts the ACME terms.')} rules={[{type:'email',message:t('请输入有效邮箱','Enter a valid email address')}]}><Input autoComplete="off"/></Form.Item>
     <Alert type="info" showIcon title={t('上传证书与私钥必须成对提供；编辑留空会保留已保存内容。','Provide certificate and key together. Leave blank when editing to keep stored material.')}/>
     <Form.Item name="certificate_pem" label={t('证书链 PEM','Certificate chain PEM')}><Input.TextArea rows={4} autoComplete="off" spellCheck={false}/></Form.Item>
     <Form.Item name="private_key_pem" label={t('私钥 PEM','Private key PEM')} extra={t('仅通过加密连接提交；保存后不回显。','Submit over a secure connection; never returned after saving.')}><Input.TextArea rows={4} autoComplete="off" spellCheck={false}/></Form.Item>
    </>}
    {editor?.kind==='compose'&&<>
     <Form.Item name="project_name" label={t('Compose 项目名','Compose project name')} rules={[...required,{pattern:/^[a-z0-9][a-z0-9_-]{0,47}$/,message:t('使用小写字母、数字、短横线或下划线，最多 48 字符','Use lowercase letters, digits, hyphens or underscores; up to 48 characters')}]}><Input disabled={!!editor.resource}/></Form.Item>
     {editor.resource&&<Form.Item name="keep_compose" valuePropName="checked"><Checkbox>{t('保留已保存的完整 Compose 内容及秘密','Keep stored Compose document and secrets')}</Checkbox></Form.Item>}
     {(!editor.resource||!keepCompose)&&<><Alert type="warning" showIcon title={t('替换完整 Compose 配置','Replace the full Compose document')} description={t('使用 JSON 格式并指定镜像版本。仅支持项目命名卷与网络；禁止宿主目录挂载、特权、host 网络、构建与 env_file。环境值按字面量处理。','Use JSON with pinned image versions. Only project-scoped named volumes and networks are supported. Host mounts, privileges, host networking, builds and env_file are forbidden. Environment values are literal.')}/>
      <Button size="small" onClick={()=>form.setFieldValue('compose_json',EXAMPLE)}>{t('填入 Nginx 示例','Insert Nginx example')}</Button>
      <Form.Item name="compose_json" label={t('Compose 配置（JSON）','Compose configuration (JSON)')} rules={required}><Input.TextArea rows={12} className="lm-ops-code" autoComplete="off" spellCheck={false}/></Form.Item></>}
    </>}
    {editor&&['website','compose'].includes(editor.kind)&&<Form.Item name="service_id" label={t('关联业务服务（可选）','Related business service (optional)')}><Select allowClear options={services.map(s=>({value:s.id,label:s.name}))}/></Form.Item>}
    {editor?.kind==='backup'&&<>
     <Form.Item name="source_path" label={t('备份源目录','Source directory')} rules={required} extra={t('Linux：目录及文件由 root 管理，不可由其他用户写入；拒绝符号链接。暂停业务写入以取得稳定文件副本。','Linux: root-owned files and directories, not writable by other users; symbolic links are rejected. Pause application writes for a stable file copy.')}><Input/></Form.Item>
     <Form.Item name="storage_type" label={t('存储目标','Storage target')}><Select options={[{value:'local',label:t('本地目录','Local directory')},{value:'s3',label:t('S3 兼容存储','S3-compatible storage')}]}/></Form.Item>
     {storageType==='local'?<Form.Item name="storage_path" label={t('备份存储目录','Backup storage directory')} rules={required} extra={t('必须已存在，且不得与源目录重叠；按资源自动隔离。','Must exist and must not overlap the source. Each resource is isolated.')}><Input/></Form.Item>:<>
      <Form.Item name="endpoint" label="S3 Endpoint" rules={required}><Input placeholder="https://s3.example.com"/></Form.Item>
      <div className="lm-ops-grid"><Form.Item name="bucket" label="Bucket" rules={required}><Input/></Form.Item><Form.Item name="region" label={t('区域','Region')} rules={required}><Input/></Form.Item></div>
      <Form.Item name="prefix" label={t('对象前缀','Object prefix')}><Input/></Form.Item>
      <Alert type="info" showIcon title={t('相同目标编辑可留空复用凭据；更换目标请重新填写。','Leave credentials blank to reuse them for the same target. Enter new credentials when changing target.')}/>
      <div className="lm-ops-grid"><Form.Item name="access_key_id" label="Access Key ID" rules={editor.resource?.config.storage?.has_credentials?[]:required}><Input.Password autoComplete="new-password"/></Form.Item><Form.Item name="secret_access_key" label="Secret Access Key" rules={editor.resource?.config.storage?.has_credentials?[]:required}><Input.Password autoComplete="new-password"/></Form.Item></div>
      <Form.Item name="session_token" label={t('Session Token（可选）','Session Token (optional)')}><Input.Password autoComplete="new-password"/></Form.Item>
     </>}
     <div className="lm-ops-grid"><Form.Item name="max_mib" label={t('单次文件总大小上限（MiB）','Maximum file content per backup (MiB)')} rules={required}><InputNumber min={0.001} max={256}/></Form.Item><Form.Item name="max_files" label={t('文件及目录数上限','Maximum files and directories')} rules={required}><InputNumber min={1} max={20000}/></Form.Item><Form.Item name="retain_count" label={t('保留最近常规备份数','Retain latest regular backups')} rules={required}><InputNumber min={1} max={1000}/></Form.Item></div>
    </>}
    <div className="lm-ops-footer"><Button onClick={()=>setEditor(undefined)} disabled={busy}>{t('取消','Cancel')}</Button><Button type="primary" htmlType="submit" loading={busy}>{t('保存配置','Save configuration')}</Button></div>
   </Form>
  </Modal>
  <Modal open={!!actionResource} title={actionResource?t('准备操作','Prepare action')+' · '+actionResource.name:''} onCancel={()=>{if(!busy)setActionResource(undefined)}} footer={null} width={640} destroyOnHidden>
   {actionError&&<Alert type="error" showIcon title={t('无法创建方案','Unable to create plan')} description={actionError}/>}
   <Form form={actionForm} layout="vertical" onFinish={plan} className="lm-ops-form">
    <Form.Item name="operation" label={t('动作','Action')} rules={required}><Select options={(actionResource?ACTIONS[actionResource.kind]:[]).map(op=>({value:op,label:actionName(op)}))}/></Form.Item>
    {actionResource?.kind==='website'&&operation==='restore'&&<Form.Item name="version" label={t('历史配置版本','Historical configuration version')} rules={required} extra={t('先执行检查状态，从结果中选择已存在的版本。','Inspect first and select an existing version from the result.')}><Input/></Form.Item>}
    {actionResource?.kind==='website'&&operation==='logs'&&<div className="lm-ops-grid"><Form.Item name="stream" label={t('日志类型','Log stream')}><Select options={[{value:'access',label:t('访问日志','Access')},{value:'error',label:t('错误日志','Error')}]}/></Form.Item><Form.Item name="lines" label={t('最近行数','Tail lines')}><InputNumber min={1} max={200}/></Form.Item></div>}
    {actionResource?.kind==='backup'&&['verify','restore'].includes(operation)&&<Form.Item name="backup_id" label={t('备份 ID','Backup ID')} rules={required} extra={t('从备份目录或执行结果中取得。','Find the ID in the backup catalog or operation result.')}><Input/></Form.Item>}
    {actionResource?.kind==='backup'&&operation==='restore'&&<><Alert type="warning" showIcon title={t('恢复将替换源目录，先暂停业务写入','Restore replaces the source directory; pause application writes first')} description={t('系统会保留恢复前副本；目标内容变化会拒绝执行。','A pre-restore copy is preserved. Execution is rejected if target contents change.')}/><Form.Item name="expected_target_sha256" label={t('当前目标摘要 SHA-256','Current target SHA-256')} rules={[...required,{pattern:/^[a-f0-9]{64}$/,message:t('需要 64 位十六进制摘要','A 64-character hexadecimal digest is required')}]} extra={t('执行备份目录或校验后，复制 current_target_sha256。','List or verify backups, then copy current_target_sha256.')}><Input/></Form.Item></>}
    {actionResource?.kind==='compose'&&!READ_ONLY.has(operation)&&<>
     <Form.Item name="expected_generation" label={t('预期节点配置代次','Expected node generation')} rules={required} extra={t('先检查实际代次；0 仅适用于首次配置或明确接管。版本变化将拒绝执行。','Inspect the actual generation first. Zero is only for an initial configuration or explicit adoption. Changes reject execution.')}><InputNumber min={0}/></Form.Item>
     {operation==='adopt'&&<><Form.Item name="inventory_sha256" label={t('发现清单摘要 SHA-256','Inventory SHA-256')} rules={required}><Input/></Form.Item><Form.Item name="acknowledge_recreate" valuePropName="checked" rules={[{validator:(_,v)=>v?Promise.resolve():Promise.reject(Error(t('需要明确确认','Explicit confirmation required')))}]}><Checkbox>{t('我确认接管会按照当前配置重新创建容器','I confirm adoption recreates containers using this configuration')}</Checkbox></Form.Item></>}
     {operation==='rollback'&&<Form.Item name="target_generation" label={t('要恢复的历史代次','Target historical generation')} rules={required}><InputNumber min={1}/></Form.Item>}
     {['apply','rollback'].includes(operation)&&<Form.Item name="acknowledge_unknown" valuePropName="checked"><Checkbox>{t('已人工检查未知结果，允许新的恢复操作','I inspected the unknown result and authorize a new recovery action')}</Checkbox></Form.Item>}
     {['start','stop','restart'].includes(operation)&&<Form.Item name="service" label={t('服务（留空表示全部）','Service (blank means all)')}><Select allowClear options={Object.keys(actionResource.config.compose?.services??{}).map(s=>({value:s,label:s}))}/></Form.Item>}
    </>}
    {actionResource?.kind==='compose'&&operation==='logs'&&<><Form.Item name="container_id" label={t('完整容器 ID','Full container ID')} rules={[...required,{pattern:/^[a-f0-9]{64}$/,message:t('请输入完整 64 位容器 ID','Enter the full 64-character container ID')}]}><Input/></Form.Item><Form.Item name="tail" label={t('最近行数','Tail lines')}><InputNumber min={1} max={500}/></Form.Item></>}
    <Alert type="info" showIcon title={t('创建方案不会执行，下一步审阅确认','Creating a plan does not execute it; review and approve next')}/>
    <div className="lm-ops-footer"><Button onClick={()=>setActionResource(undefined)}>{t('取消','Cancel')}</Button><Button type="primary" htmlType="submit" loading={busy}>{t('预览方案','Preview plan')}</Button></div>
   </Form>
  </Modal>
  <Modal open={!!currentRun} title={t('执行方案与结果','Operation plan & result')} onCancel={()=>{setCurrentRun(undefined);setRunError('')}} footer={null} width={880} destroyOnHidden>
   {currentRun&&<>
    {runError&&<Alert type="error" showIcon title={t('操作失败','Operation failed')} description={runError}/>}
    <Descriptions size="small" column={2} items={[{key:'resource',label:t('资源','Resource'),children:currentResource?.name??currentRun.resource_id},{key:'revision',label:t('配置版本','Revision'),children:currentRun.resource_revision},{key:'operation',label:t('动作','Action'),children:actionName(currentRun.operation)},{key:'state',label:t('状态','State'),children:status(currentRun.state)},{key:'expiry',label:t('方案有效期','Plan expiry'),children:time(currentRun.expires_at)},{key:'id',label:t('运行 ID','Run ID'),children:<Typography.Text copyable>{currentRun.id}</Typography.Text>}]}/>
    {currentRun.state==='unknown'&&<Alert type="error" showIcon title={t('结果未知：请先检查节点，不要直接重复写操作','Unknown result: inspect the node before repeating a write action')}/>}
    {currentRun.state==='awaiting_approval'&&<Alert type="warning" showIcon title={READ_ONLY.has(currentRun.operation)?t('确认后将向节点发送这次检查请求','Approval sends this inspection request to the node'):t('确认后将修改目标主机，请核对配置和参数','Approval modifies the target host. Review configuration and parameters.')} description={t('方案绑定当前配置版本，30 分钟有效；修改配置后需要重新创建方案。','The plan binds the resource revision and expires in 30 minutes. Resource changes require a new plan.')}/>}
    <pre className="lm-ops-result">{JSON.stringify(currentRun.preview,null,2)}</pre>
    {Object.keys(data).length>0&&<>
     {data.expires_at&&<Alert type={data.days_remaining<=30?'warning':'success'} showIcon title={t('证书到期时间','Certificate expires')+' · '+time(data.expires_at)} description={t('剩余天数','Days remaining')+': '+data.days_remaining}/>}
     {data.current_target_sha256&&<p>{t('当前目标摘要','Current target digest')} <Typography.Text copyable code>{data.current_target_sha256}</Typography.Text></p>}
     {Array.isArray(data.backups)&&<Table rowKey="backup_id" size="small" scroll={{x:640}} dataSource={data.backups} columns={[{title:t('备份','Backup'),render:(_,b:any)=><Typography.Text copyable>{b.backup_id}</Typography.Text>},{title:t('类型','Type'),render:(_,b:any)=>b.purpose==='pre_restore'?t('恢复前副本','Recovery copy'):t('常规备份','Regular backup')},{title:t('大小','Size'),render:(_,b:any)=>(b.size/1024).toFixed(1)+' KiB'},{title:t('操作','Actions'),render:(_,b:any)=>currentResource&&<Space><Button size="small" onClick={()=>{setCurrentRun(undefined);openAction(currentResource,'verify',{backup_id:b.backup_id})}}>{t('校验','Verify')}</Button><Button size="small" onClick={()=>{setCurrentRun(undefined);openAction(currentResource,'restore',{backup_id:b.backup_id,expected_target_sha256:data.current_target_sha256})}}>{t('恢复','Restore')}</Button></Space>} ]}/>}
     {Array.isArray(data.containers)&&<Table rowKey="id" size="small" scroll={{x:600}} dataSource={data.containers} columns={[{title:t('容器','Container'),render:(_,c:any)=><div>{c.name}<small><Typography.Text copyable>{c.id}</Typography.Text></small></div>},{title:t('镜像','Image'),dataIndex:'image'},{title:t('状态','State'),dataIndex:'state'},{title:t('日志','Logs'),render:(_,c:any)=>currentResource&&<Button size="small" onClick={()=>{setCurrentRun(undefined);openAction(currentResource,'logs',{container_id:c.id})}}>{t('查看','View')}</Button>}]}/>}
     {typeof data.text==='string'&&<pre className="lm-ops-result">{data.text||t('暂无日志','No log entries')}</pre>}
     <details className="lm-ops-details" open={!data.backups&&!data.containers&&!data.text}><summary>{t('完整验证结果','Full verification result')}</summary><pre className="lm-ops-result">{JSON.stringify(data,null,2)}</pre></details>
    </>}
    {currentRun.receipt?.code&&<Alert showIcon type={currentRun.state==='succeeded'?'info':'error'} title={t('节点回执代码','Agent receipt code')} description={currentRun.receipt.code}/>}
    <div className="lm-ops-footer"><Button icon={<ReloadOutlined/>} loading={busy} onClick={()=>void refreshRun()}>{t('刷新结果','Refresh result')}</Button>
     {(currentRun.state==='awaiting_approval'||currentRun.state==='queued')&&<Popconfirm title={t('取消尚未执行的操作？','Cancel this pending operation?')} onConfirm={async()=>{try{const r=await api<{run:Run}>('/operations/runs/'+pathID(currentRun.id)+'/cancel',{method:'POST',body:'{}'});setCurrentRun(r.run);await load()}catch(e){setRunError(errorText(e))}}}><Button>{t('取消操作','Cancel operation')}</Button></Popconfirm>}
     {currentRun.state==='awaiting_approval'&&<Popconfirm title={t('确认目标、动作和版本无误并立即下发？','Approve this exact target, action and revision for execution?')} onConfirm={approve}><Button type="primary" loading={busy} disabled={Date.parse(currentRun.expires_at)<=planNow}>{t('确认执行','Approve & execute')}</Button></Popconfirm>}
    </div>
   </>}
  </Modal>
  <Modal open={!!scheduleEditor} title={scheduleEditor?.schedule?t('编辑并重新授权计划','Edit and reauthorize schedule'):t('新增计划任务','New schedule')} onCancel={()=>{if(!busy)setScheduleEditor(undefined)}} footer={null} width={640} destroyOnHidden>
   {scheduleError&&<Alert type="error" title={t('无法保存计划','Unable to save schedule')} description={scheduleError}/>}
   <Form form={scheduleForm} layout="vertical" onFinish={saveSchedule} className="lm-ops-form">
    <Form.Item name="name" label={t('计划名称','Schedule name')} rules={required}><Input maxLength={128}/></Form.Item>
    <Form.Item name="resource_id" label={t('资源','Resource')} rules={required}><Select onChange={()=>{scheduleForm.setFieldValue('operation',undefined);scheduleForm.setFieldValue('backup_id',undefined)}} showSearch optionFilterProp="label" options={resources.map(r=>({value:r.id,label:name(r.kind)+' · '+r.name+' · v'+r.revision}))}/></Form.Item>
    <Form.Item name="operation" label={t('登记动作','Authorized action')} rules={required}><Select options={(scheduleResource?SCHEDULED[scheduleResource.kind]:[]).map(op=>({value:op,label:actionName(op)}))}/></Form.Item>
    {scheduleOperation==='verify'&&<Form.Item name="backup_id" label={t('固定备份 ID','Fixed backup ID')} rules={required}><Input/></Form.Item>}
    <Form.Item name="cron" label={t('五字段 Cron','Five-field cron')} rules={required} extra={t('分钟 小时 日期 月份 星期；如 0 2 * * * 表示每天 02:00。','Minute hour day month weekday; 0 2 * * * runs daily at 02:00.')}><Input placeholder="0 2 * * *"/></Form.Item>
    <Form.Item name="timezone" label={t('IANA 时区','IANA timezone')} rules={required}><Input placeholder="Asia/Shanghai"/></Form.Item>
    <Alert type="warning" showIcon title={t('启用即授权周期执行这些精确参数','Enabling authorizes recurring execution of these exact parameters')} description={t('绑定当前资源版本；跳过错过的窗口与未结束的上次运行；未知结果自动停用，需人工核对并重新授权。','Binds the current resource revision. Missed windows and overlaps are skipped. Unknown results disable the schedule until inspected and reauthorized.')}/>
    <Form.Item name="enabled" label={t('启用计划','Enable schedule')} valuePropName="checked"><Switch/></Form.Item>
    <div className="lm-ops-footer"><Button onClick={()=>setScheduleEditor(undefined)}>{t('取消','Cancel')}</Button><Button type="primary" htmlType="submit" loading={busy}>{t('保存并授权','Save & authorize')}</Button></div>
   </Form>
  </Modal>
  <Modal open={!!fireDetail} title={t('计划执行历史','Schedule history')+' · '+(fireDetail?.schedule.name??'')} onCancel={()=>setFireDetail(undefined)} footer={<Button onClick={()=>fireDetail&&void showFires(fireDetail.schedule)}>{t('刷新','Refresh')}</Button>} width={760}>
   <Table rowKey="slot" dataSource={fireDetail?.fires??[]} scroll={{x:600}} columns={[{title:t('UTC 触发窗口','UTC slot'),dataIndex:'slot'},{title:t('状态','State'),render:(_,f:any)=>stateName(f.state)},{title:t('详情','Details'),render:(_,f:any)=>f.run_id&&<Button size="small" onClick={async()=>{try{const r=await api<{run:Run}>('/operations/runs/'+pathID(f.run_id));setFireDetail(undefined);setCurrentRun(r.run);setRunError('')}catch(e){void message.error(errorText(e))}}}>{t('查看执行','View run')}</Button>}]}/>
  </Modal>
 </div>;
}
