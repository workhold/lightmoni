import {useI18n} from '../shared/i18n';
import {useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,PlusOutlined,UploadOutlined} from '@ant-design/icons';
import {Alert,Button,Checkbox,Collapse,Descriptions,Form,Input,InputNumber,Modal,Radio,Select,Space,Switch,Tag,Typography} from '../shared/ui';
import {defaultExecutionPolicy,defaultTasks,hostCanRunScript,hostCollectors,hostCollectorName,requiredScriptCapability,taskScheduleSummary,taskTypeName,taskFormValues,taskPayload,type AgentTaskLabel,type LogSource,type ManagedAgentTask,type TaskForm,type TaskHost} from './agent-model';
import TaskScheduleFields,{cleanTaskSchedule} from './TaskScheduleFields';

type TaskDraft = Omit<ManagedAgentTask,'id'>;
const byteLength=(value:string)=>new TextEncoder().encode(value).length;
const argsFrom=(value?:string):string[]=>{if(!value?.trim())return [];const args:unknown=JSON.parse(value);if(!Array.isArray(args)||args.some(item=>typeof item!=='string'))throw new Error('Arguments must be a JSON string array');return args};

export default function AgentTaskEditor({task,labels,hosts=[],hostOverride=false,onSave,onCancel,onBusyChange}: {
  task?:ManagedAgentTask;labels:AgentTaskLabel[];hosts?:TaskHost[];hostOverride?:boolean;onSave:(task:TaskDraft)=>Promise<void>;onCancel:()=>void;onBusyChange:(busy:boolean)=>void;
}) {
 const {t,language:uiLanguage}=useI18n();
 const [form]=Form.useForm<TaskForm>(),[saving,setSaving]=useState(false),[error,setError]=useState(''),[uploadError,setUploadError]=useState(''),[uploadedName,setUploadedName]=useState('');
 const [replacement,setReplacement]=useState<{name:string;code:string;runtime:'shell'|'node'}>(),[review,setReview]=useState<TaskDraft>(),[reviewed,setReviewed]=useState(false);
 const fileInput=useRef<HTMLInputElement>(null),savePending=useRef(false);
 const type=task?.id?task.type:'script';
 const enabled=Form.useWatch('enabled',form) as boolean|undefined;
 const selectedLabels=Form.useWatch('label_ids',form) as string[]|undefined;
 const targetAll=Form.useWatch('target_all',form) as boolean|undefined;
 const selectedHosts=Form.useWatch('host_ids',form) as string[]|undefined;
 const argsText=Form.useWatch('script_args_text',{form,preserve:true}) as string|undefined,cwd=Form.useWatch(['script','cwd'],{form,preserve:true}) as string|undefined;
 let hasArguments=false;try{hasArguments=!!argsFrom(argsText).length}catch{hasArguments=!!argsText?.trim()}
 const needsV2=hasArguments||!!cwd;
 const matching=hosts.filter(host=>targetAll||selectedHosts?.includes(host.id)||selectedLabels?.some(id=>host.label_ids.includes(id)));
 const initialValues:TaskForm={...taskFormValues(task?.config??defaultTasks),name:task?.name??'',type:task?.type??'script',enabled:task?.enabled??true,label_ids:task?.label_ids??[],target_all:task?.target_all??false,host_ids:task?.host_ids??[],schedule:task?.schedule??{mode:task?.type&&task.type!=='script'?'continuous':'once'},script:task?.script??{runtime:'shell',code:'',timeout_seconds:60,max_output_bytes:65536},script_args_text:JSON.stringify(task?.script?.args??[],null,2),execution_policy:{...defaultExecutionPolicy,...task?.execution_policy}};
 const nameRules=[{required:true,whitespace:true,message:t('请输入任务名称','Enter a task name')},{validator:(_:unknown,value?:string)=>byteLength(value?.trim()??'')<=128?Promise.resolve():Promise.reject(new Error(t('任务名称最长 128 字节','Task names may contain up to 128 bytes')))}];
 const applyScript=(value:{name:string;code:string;runtime:'shell'|'node'})=>{form.setFieldValue(['script','code'],value.code);form.setFieldValue(['script','runtime'],value.runtime);setUploadedName(value.name);setReplacement(undefined);setUploadError('')};
 const importScript=async(file?:File)=>{
  setUploadError('');if(!file)return;
  try{
   if(!/\.(sh|js|mjs)$/i.test(file.name))throw new Error(t('请选择 .sh、.js 或 .mjs 脚本文件','Choose a .sh, .js or .mjs script file'));
   if(file.size>65536)throw new Error(t('脚本最长 64 KiB','Scripts may contain up to 64 KiB'));
   let code:string;try{code=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())}catch{throw new Error(t('脚本必须为 UTF-8 文本','Scripts must contain UTF-8 text'))}
   if(!code.trim()||code.includes('\0')||byteLength(code)>65536)throw new Error(t('脚本不能为空、包含 NUL 或超过 64 KiB','Scripts must be nonempty, without NUL, and at most 64 KiB'));
   const next={name:file.name,code,runtime:(/\.sh$/i.test(file.name)?'shell':'node') as 'shell'|'node'};
   if(String(form.getFieldValue(['script','code'])??'').trim())setReplacement(next);else applyScript(next);
  }catch(error){setUploadError(error instanceof Error?error.message:t('读取脚本失败','Unable to read this script'))}
 };
 const build=(values:TaskForm,enabledOverride?:boolean):TaskDraft=>{
  // validateFields returns only mounted fields. Merge nested values so collapsed
  // advanced controls cannot erase an existing script option or execution limit.
  const stored=form.getFieldsValue(true),all={...initialValues,...stored,...values,
   script:{...initialValues.script,...stored.script,...values.script},
   schedule:{...initialValues.schedule,...stored.schedule,...values.schedule},
   execution_policy:{...defaultExecutionPolicy,...initialValues.execution_policy,...stored.execution_policy,...values.execution_policy},
  } as TaskForm,taskType=type,config=taskPayload(all);
  config.host_enabled=taskType==='host';config.logs_enabled=taskType==='log';
  if(taskType!=='host'){config.host_collectors=[];config.process_names=[]}if(taskType!=='probe')config.probes=[];if(taskType!=='log')config.log_sources=[];
  delete config.revision;delete config.group_id;
  const args=taskType==='script'?argsFrom(all.script_args_text):[],directory=all.script?.cwd;
  const script=all.script?{runtime:all.script.runtime,code:all.script.code,timeout_seconds:all.script.timeout_seconds,max_output_bytes:all.script.max_output_bytes,...(args.length?{args}:{}),...(directory?{cwd:directory}:{})}:undefined;
  return {name:all.name?.trim()??'',type:taskType,enabled:enabledOverride??!!all.enabled,label_ids:all.label_ids??[],config,origin:task?.id?task.origin??'custom':'custom',target_all:!!all.target_all,host_ids:all.host_ids??[],schedule:taskType==='script'?cleanTaskSchedule(all.schedule):{mode:'continuous'},...(taskType==='script'?{script,execution_policy:{...defaultExecutionPolicy,...all.execution_policy}}:{})};
 };
 const persist=async(draft:TaskDraft)=>{
  if(savePending.current)return;savePending.current=true;setSaving(true);onBusyChange(true);setError('');
  try{await onSave(draft);setReview(undefined)}catch(error){setError(error instanceof Error?error.message:t('保存任务失败','Unable to save task'));setReview(undefined)}
  finally{savePending.current=false;setSaving(false);onBusyChange(false)}
 };
 const prepare=async(draftOnly=false)=>{
  setError('');try{const values=await form.validateFields(),draft=build(values,draftOnly?false:undefined);if(hostOverride||draftOnly){await persist(draft);return}setReview(draft);setReviewed(false)}catch(error){if(!(error&&typeof error==='object'&&'errorFields' in error))setError(error instanceof Error?error.message:t('请检查任务配置','Check task settings'))}
 };
 return <Form form={form} layout="vertical" initialValues={initialValues} disabled={saving} onFinish={()=>void prepare()} scrollToFirstError className="lm-task-editor">
  {!hostOverride&&<>
   <div className="lm-agent-form-grid">
    <Form.Item name="name" label={t('任务名称','Task name')} rules={nameRules}><Input aria-label={t('任务名称','Task name')} placeholder={type==='script'?t('例如：数据库每日备份','Example: Daily database backup'):t('例如：生产主机指标','Example: Production host metrics')}/></Form.Item>
    <Form.Item label={t('任务类型','Task type')}><Typography.Text>{taskTypeName(type,uiLanguage)}</Typography.Text>{task?.id&&<div><Tag>{task.origin==='builtin'?t('平台默认','Platform default'):t('用户任务','User task')}</Tag></div>}</Form.Item>
   </div>
   <h3>{t('1. 执行内容','1. Execution content')}</h3>
  </>}
  {type==='script'&&<>
   <div className="lm-task-script-toolbar"><Form.Item name={['script','runtime']} label={t('脚本运行时','Script runtime')} rules={[{required:true}]}><Select aria-label={t('脚本运行时','Script runtime')} options={[{value:'shell',label:'POSIX shell'},{value:'node',label:'Node.js'}]}/></Form.Item><Space wrap><input ref={fileInput} type="file" accept=".sh,.js,.mjs" aria-label={t('选择脚本文件','Choose script file')} className="lm-task-file-input" style={{display:'none'}} onChange={event=>{void importScript(event.target.files?.[0]);event.target.value=''}}/><Button icon={<UploadOutlined/>} onClick={()=>fileInput.current?.click()}>{t('上传脚本','Upload script')}</Button>{uploadedName&&<Typography.Text type="secondary" className="lm-task-upload-name">{uploadedName}</Typography.Text>}</Space></div>
   {uploadError&&<Alert type="error" showIcon title={uploadError} className="lm-agent-form-notice"/>}
   <Form.Item name={['script','code']} label={t('脚本代码','Script code')} rules={[{required:true,whitespace:true,message:t('请输入脚本代码','Enter script code')},{validator:(_:unknown,value?:string)=>byteLength(value??'')<=65536&&!(value??'').includes('\0')?Promise.resolve():Promise.reject(new Error(t('脚本最长 64 KiB，不能包含 NUL','Scripts may contain up to 64 KiB and must not contain NUL')))}]} extra={t('直接编写，或上传 UTF-8 脚本后继续编辑。保存的是这里的最终代码。','Write directly, or upload a UTF-8 script and edit it. The final code shown here is saved.')}><Input.TextArea aria-label={t('脚本代码','Script code')} autoSize={{minRows:10,maxRows:25}} spellCheck={false} className="lm-task-code" placeholder={t('在这里编写脚本，或点击“上传脚本”','Write your script here, or choose Upload script')}/></Form.Item>
  </>}
    {type==='host' && <>
      <Form.Item name="host_collectors" label={t("采集哪些指标","Metrics to collect")} rules={[{validator:(_:unknown,value?:string[])=>!enabled||value?.length?Promise.resolve():Promise.reject(new Error(t("至少选择一项指标","Select at least one metric")))}]}><Checkbox.Group className="lm-agent-collectors" options={hostCollectors.map(item=>({...item,label:hostCollectorName(item.value,uiLanguage)}))}/></Form.Item>
      <div className="lm-agent-form-grid">
        <Form.Item name="collect_interval_seconds" label={t("采集间隔（秒）","Collection interval (seconds)")} rules={[{required:true,type:'number',min:1,max:86400,message:t("填写 1–86400 秒","Enter 1–86400 seconds")}]}><InputNumber aria-label={t("采集间隔（秒）","Collection interval (seconds)")} min={1} max={86400} precision={0}/></Form.Item>
        <Form.Item label={t("指标上报表","Metric reporting table")}><Typography.Text code>host</Typography.Text></Form.Item>
      </div>
      <Form.Item noStyle shouldUpdate={(a,b)=>a.host_collectors!==b.host_collectors}>{({getFieldValue})=>(getFieldValue('host_collectors') ?? []).includes('process')?<Form.Item name="process_names" label={t("进程名称","Process names")} rules={[{required:true,type:'array',min:1,max:32,message:t("填写 1–32 个进程名称","Enter 1–32 process names")}]} extra={t("按进程名匹配，例如 nginx、postgres；可使用 * 匹配多个进程。","Match process names such as nginx or postgres. Use * to match multiple processes.")}><Select mode="tags" aria-label={t("进程名称","Process names")} tokenSeparators={[',','，']} placeholder={t("输入进程名称并回车","Enter a process name and press Enter")}/></Form.Item>:null}</Form.Item>
    </>}
    {type==='probe' && <>
      <Form.Item label={t("拨测结果上报表","Probe reporting table")}><Typography.Text code>probe</Typography.Text></Form.Item>
      <p className="lm-agent-muted">{t("执行节点按配置检测 HTTP 或 TCP 目标，上报可用性、耗时和失败原因。","Execution nodes probe configured HTTP or TCP targets and report availability, latency, and failure reasons.")}</p>
      <Alert className="lm-agent-form-notice" type="info" showIcon title={t("没有探测地址时，任务保持启用并显示待配置；添加地址后执行。","Without a probe target, the task stays enabled and awaits configuration. Add a target to begin execution.")}/><Form.List name="probes" rules={[{validator:(_:unknown,value?:TaskForm['probes'])=>{
        if(!value?.length) return Promise.resolve();
        if(value.length>128) return Promise.reject(new Error(t("最多添加 128 个拨测目标","Add up to 128 probe targets")));
        const names=value.map(probe=>probe.id?.trim()).filter(Boolean);
        return new Set(names).size===names.length?Promise.resolve():Promise.reject(new Error(t("拨测名称不能重复","Probe names must be unique")));
      }}]}>{(fields,{add,remove},{errors})=><>
        {fields.map(field=><div className="lm-agent-probe" key={field.key}>
          <div className="lm-agent-probe-heading"><strong>{t("拨测","Probe")} {field.name+1}</strong><Button type="text" danger aria-label={t(`删除拨测 ${field.name+1}`,`Remove probe ${field.name+1}`)} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
          <div className="lm-agent-form-grid">
            <Form.Item name={[field.name,'id']} label={t("拨测名称","Probe name")} rules={[{required:true,whitespace:true,message:t("请输入拨测名称","Enter a probe name")},{validator:(_:unknown,value?:string)=>new TextEncoder().encode(value?.trim() ?? '').length<=128?Promise.resolve():Promise.reject(new Error(t("拨测名称最长 128 字节","Probe names may contain up to 128 bytes")))}]}><Input aria-label={t(`拨测 ${field.name+1} 名称`,`Probe ${field.name+1} name`)} placeholder={t("例如：网站首页","Example: Website home page")}/></Form.Item>
            <Form.Item name={[field.name,'kind']} label={t("拨测类型","Probe type")} rules={[{required:true}]}><Select aria-label={t(`拨测 ${field.name+1} 类型`,`Probe ${field.name+1} type`)} options={[{value:'http',label:'HTTP / HTTPS'},{value:'tcp',label:t("TCP 端口","TCP port")}]}/></Form.Item>
          </div>
          <Form.Item noStyle shouldUpdate={(a,b)=>a.probes?.[field.name]?.kind!==b.probes?.[field.name]?.kind}>{({getFieldValue})=>{
            const http=getFieldValue(['probes',field.name,'kind'])==='http';
            return <>
              <Form.Item name={[field.name,'target']} label={http?t("目标网址","Target URL"):t("目标地址与端口","Target address and port")} rules={[{required:true,whitespace:true,message:t("请输入拨测目标","Enter a probe target")},{validator:(_:unknown,value?:string)=>{
                let valid=false;
                if(http) {try {const url=new URL(value?.trim() ?? '');valid=['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password;} catch { /* Validation message below. */ }}
                else {const match=/^(?:\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(value?.trim() ?? '');valid=!!match&&Number(match[1])>0&&Number(match[1])<=65535;}
                return valid?Promise.resolve():Promise.reject(new Error(http?t("填写完整的 HTTP / HTTPS 网址","Enter a complete HTTP / HTTPS URL"):t("填写主机名或 IP 加端口，例如 db.internal:5432","Enter a hostname or IP with a port, such as db.internal:5432")));
              }}]}><Input aria-label={t(`拨测 ${field.name+1} 目标`,`Probe ${field.name+1} target`)} placeholder={http?'https://example.com/health':'db.internal:5432'}/></Form.Item>
              <div className="lm-agent-form-grid">
                <Form.Item name={[field.name,'interval_seconds']} label={t("拨测间隔（秒）","Probe interval (seconds)")} rules={[{required:true,type:'number',min:1,max:86400,message:t("填写 1–86400 秒","Enter 1–86400 seconds")}]}><InputNumber aria-label={t(`拨测 ${field.name+1} 间隔（秒）`,`Probe ${field.name+1} interval (seconds)`)} min={1} max={86400} precision={0}/></Form.Item>
                <Form.Item name={[field.name,'timeout_seconds']} label={t("超时（秒）","Timeout (seconds)")} rules={[{required:true,type:'number',min:0.001,max:120,message:t("填写 0.001–120 秒","Enter 0.001–120 seconds")}]}><InputNumber aria-label={t(`拨测 ${field.name+1} 超时（秒）`,`Probe ${field.name+1} timeout (seconds)`)} min={0.001} max={120} step={1}/></Form.Item>
              </div>
              {http&&<Form.Item name={[field.name,'expected_status']} label={t("成功状态码","Successful status codes")} extra={t("留空时 200–399 都视为成功。","Leave blank to treat 200–399 as successful.")} rules={[{validator:(_:unknown,value?:string[])=>(value ?? []).every(status=>/^\d{3}$/.test(status)&&Number(status)>=100&&Number(status)<=599)?Promise.resolve():Promise.reject(new Error(t("填写 100–599 的 HTTP 状态码","Enter HTTP status codes from 100 to 599")))}]}><Select aria-label={t(`拨测 ${field.name+1} 成功状态码`,`Probe ${field.name+1} successful status codes`)} mode="tags" tokenSeparators={[',','，']} placeholder={t("默认：200–399","Default: 200–399")} options={['200','201','204','301','302','304'].map(status=>({label:status,value:status}))}/></Form.Item>}
            </>;
          }}</Form.Item>
        </div>)}
        <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=128} onClick={()=>add({id:'',kind:'http',target:'',interval_seconds:60,timeout_seconds:5,expected_status:[]})}>{t("添加拨测目标","Add probe target")}</Button>
      </>}</Form.List>
    </>}
    {type==='log' && <>
      <Form.Item label={t("目录日志上报表","Directory log reporting table")}><Typography.Text code>files</Typography.Text></Form.Item>
      <p className="lm-agent-muted">{t("逐行采集文件新增内容，支持日志轮转和重启续读。目录需允许 LightMoni Agent 服务用户读取。","Collect new file contents line by line, with log rotation and resume support. The LightMoni Agent service user must have read access to the directory.")}</p>
      <Alert className="lm-agent-form-notice" type="info" showIcon title={t("未配置日志目录时等待配置，填写目录后开始采集。","Without a log directory, the task awaits configuration. Add a directory to begin collection.")}/><Form.List name="log_sources" rules={[{validator:(_:unknown,sources?:LogSource[])=>{
        if(!sources?.length) return Promise.resolve();
        if(sources.length>32) return Promise.reject(new Error(t("最多添加 32 个日志目录","Add up to 32 log directories")));
        const paths=sources.map(source=>`${source.directory?.trim()}:${source.pattern?.trim()||'*.log*'}:${!!source.recursive}`);
        return new Set(paths).size===paths.length?Promise.resolve():Promise.reject(new Error(t("日志目录和匹配规则不能重复","Log directories and matching patterns must be unique")));
      }}]}>{(fields,{add,remove},{errors})=><>
        {fields.map(field=><div className="lm-agent-probe" key={field.key}>
          <div className="lm-agent-probe-heading"><strong>{t("日志目录","Log directory")} {field.name+1}</strong><Button type="text" danger aria-label={t(`删除日志目录 ${field.name+1}`,`Remove log directory ${field.name+1}`)} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
          <Form.Item name={[field.name,'directory']} label={t("目录路径","Directory path")} rules={[{required:true,whitespace:true,message:t("请输入日志目录","Enter a log directory")},{validator:(_:unknown,value?:string)=>value?.trim().startsWith('/')&&value.trim().length<=4096?Promise.resolve():Promise.reject(new Error(t("填写服务器上的绝对目录路径，例如 /var/log/nginx","Enter an absolute server directory path, such as /var/log/nginx")))}]}><Input aria-label={t(`日志目录 ${field.name+1} 路径`,`Log directory ${field.name+1} path`)} placeholder="/var/log/nginx"/></Form.Item>
          <Form.Item name={[field.name,'pattern']} label={t("文件匹配规则","File pattern")} extra={t("*.log* 包含 app.log、app.log.1 等轮转文件；压缩文件不采集。","*.log* includes rotated files such as app.log and app.log.1. Compressed files are excluded.")} rules={[{required:true,message:t("请输入匹配规则","Enter a file pattern")},{max:256,message:t("匹配规则最长 256 位","File patterns may contain up to 256 characters")},{validator:(_:unknown,value?:string)=>!/[\/\\]/.test(value ?? '')?Promise.resolve():Promise.reject(new Error(t("这里只填写文件名规则，目录在上方设置","Enter only the file-name pattern; set the directory above")))}]}><Input aria-label={t(`日志目录 ${field.name+1} 文件匹配规则`,`Log directory ${field.name+1} file pattern`)} placeholder="*.log*"/></Form.Item>
          <Form.Item name={[field.name,'recursive']} valuePropName="checked"><Checkbox aria-label={t(`日志目录 ${field.name+1} 包含子目录`,`Log directory ${field.name+1} include subdirectories`)}>{t("同时采集子目录","Include subdirectories")}</Checkbox></Form.Item>
          <Form.Item name={[field.name,'from_beginning']} label={t("首次采集","Initial collection")} extra={t("仅影响首次发现已有文件；修改主机标签不会重读已采集内容。","Applies only to existing files when first discovered. Changing host labels does not reread collected content.")}><Radio.Group aria-label={t(`日志目录 ${field.name+1} 首次采集`,`Log directory ${field.name+1} initial collection`)} options={[{value:false,label:t("仅采集新增内容","Collect only new content")},{value:true,label:t("从文件开头采集","Read from the beginning")}]}/></Form.Item>
        </div>)}
        <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=32} onClick={()=>add({directory:'',pattern:'*.log*',recursive:false,from_beginning:false})}>{t("添加日志目录","Add log directory")}</Button>
      </>}</Form.List>
    </>}
    {type!=='script'&&<Typography.Paragraph type="secondary" className="lm-agent-report-note">{t("主机指标、拨测、目录日志分别写入固定的host、probe、files表。同类任务在同一节点上的采集间隔等配置不兼容时，保存会提示冲突。","Host metrics, probes, and directory logs use the fixed host, probe, and files tables. Saving reports conflicts when tasks have incompatible collection intervals or other settings.")}<Link to="/admin?tab=credentials&section=agents">{t("管理接入凭据","Manage access credentials")}</Link></Typography.Paragraph>}

  {type==='script'&&<TaskScheduleFields form={form}/>}
  {!hostOverride&&<section className="lm-task-editor-section" aria-label={t('目标主机','Target hosts')}>
   <h3>{t(type==='script'?'3. 目标主机':'2. 目标主机',type==='script'?'3. Target hosts':'2. Target hosts')}</h3>
   <Form.Item name="target_all" label={t('派发范围','Dispatch scope')} valuePropName="checked"><Checkbox aria-label={t('所有主机','All hosts')}>{t('所有已登记主机（包含后续新增主机）','All registered hosts, including future hosts')}</Checkbox></Form.Item>
   {!targetAll&&<>
    <Form.Item name="label_ids" label={t('主机标签','Host labels')} extra={t('匹配任一标签的主机与直接选择的主机构成目标并集。','Hosts matching any label and directly selected hosts form the target set.')}><Select mode="multiple" allowClear showSearch={{optionFilterProp:'label'}} aria-label={t('目标主机标签','Target host labels')} options={labels.map(label=>({value:label.id,label:label.name}))}/></Form.Item>
    <Form.Item name="host_ids" label={t('指定主机','Selected hosts')}><Select mode="multiple" allowClear showSearch={{optionFilterProp:'label'}} aria-label={t('指定主机','Selected hosts')} options={hosts.map(host=>({value:host.id,label:host.name}))}/></Form.Item>
   </>}
   <div className="lm-task-target-preview" aria-label={t('目标主机预览','Target host preview')}><strong>{t(`当前匹配 ${matching.length} 台主机`,`Currently matches ${matching.length} hosts`)}</strong>{!matching.length?<p>{t('尚未选择目标，此任务不会派发。','No targets selected. This task will not be dispatched.')}</p>:<ul>{matching.map(host=>{const ready=type!=='script'||hostCanRunScript(host,needsV2?{runtime:'shell',code:'',timeout_seconds:60,max_output_bytes:65536,args:['v2']}:undefined);return <li key={host.id}><span>{host.name}</span><Tag color={!host.agent_id?'default':!ready?'warning':host.agent_status==='online'?'success':'default'}>{!host.agent_id?t('未接入 Agent','Agent not enrolled'):!ready?t('需升级 Agent','Agent upgrade required'):host.agent_status==='online'?t('Agent 在线','Agent online'):t('Agent 离线，等待领取','Agent offline; waits for claim')}</Tag></li>})}</ul>}{type==='script'&&needsV2&&<p>{t('参数或工作目录需要支持 task.script.v2 的 Agent。','Arguments or a working directory require an Agent supporting task.script.v2.')}</p>}</div>
  </section>}
  {type==='script'&&<Collapse className="lm-task-editor-section" items={[{key:'advanced',label:t('4. 高级执行设置','4. Advanced execution settings'),children:<>
   <div className="lm-agent-form-grid">
    <Form.Item name="script_args_text" label={t('脚本参数','Script arguments')} rules={[{validator:(_:unknown,value?:string)=>{try{const args=argsFrom(value);if(args.length<=32&&args.every(item=>byteLength(item)<=1024&&!item.includes('\0'))&&args.reduce((total,item)=>total+byteLength(item),0)<=8192)return Promise.resolve()}catch{}return Promise.reject(new Error(t('使用 JSON 字符串数组：最多32项，每项1 KiB，总计8 KiB，不能包含 NUL','Use a JSON string array: up to 32 items, 1 KiB each and 8 KiB total, without NUL')))}}]} extra={t('使用 JSON 数组，例如 ["--database", "main db"]；参数按原样传递，不展开变量。','Use a JSON array, for example ["--database", "main db"]. Arguments are passed literally, without variable expansion.')}><Input.TextArea aria-label={t('脚本参数','Script arguments')} rows={3} spellCheck={false}/></Form.Item>
    <Form.Item name={['script','cwd']} label={t('工作目录','Working directory')} rules={[{validator:(_:unknown,value?:string)=>!value||/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)&&byteLength(value)<=4096&&!value.includes('\0')?Promise.resolve():Promise.reject(new Error(t('填写目标主机上的绝对目录，最长4096字节','Enter an absolute directory on the target host, up to 4096 bytes')))}]} extra={t('留空时使用本次任务的临时目录。','Leave blank to use this run’s temporary directory.')}><Input aria-label={t('工作目录','Working directory')} placeholder="/opt/backups"/></Form.Item>
   </div>
   <div className="lm-agent-form-grid">
    <Form.Item name={['script','timeout_seconds']} label={t('超时（秒）','Timeout (seconds)')} rules={[{required:true,type:'number',min:1,max:3600}]}><InputNumber aria-label={t('超时（秒）','Timeout (seconds)')} min={1} max={3600} precision={0}/></Form.Item>
    <Form.Item name={['script','max_output_bytes']} label={t('输出上限（字节）','Output limit (bytes)')} rules={[{required:true,type:'number',min:1024,max:262144}]}><InputNumber aria-label={t('输出上限（字节）','Output limit (bytes)')} min={1024} max={262144} precision={0}/></Form.Item>
    <Form.Item name={['execution_policy','max_concurrency']} label={t('最多同时执行的主机数','Maximum concurrent hosts')} rules={[{required:true,type:'number',min:1,max:100}]}><InputNumber aria-label={t('最多同时执行的主机数','Maximum concurrent hosts')} min={1} max={100} precision={0}/></Form.Item>
    <Form.Item name={['execution_policy','queue_timeout_seconds']} label={t('队列等待期限（秒）','Queue timeout (seconds)')} rules={[{required:true,type:'number',min:10,max:86400}]}><InputNumber aria-label={t('队列等待期限（秒）','Queue timeout (seconds)')} min={10} max={86400} precision={0}/></Form.Item>
    <Form.Item name={['execution_policy','retry_count']} label={t('失败重试次数','Failure retries')} rules={[{required:true,type:'number',min:0,max:3}]} extra={t('0 表示不重试；重试会重新执行完整脚本。结果未知不自动重试。','0 disables retries. A retry reruns the complete script; unknown outcomes are never retried automatically.')}><InputNumber aria-label={t('失败重试次数','Failure retries')} min={0} max={3} precision={0}/></Form.Item>
    <Form.Item name={['execution_policy','retry_delay_seconds']} label={t('重试间隔（秒）','Retry delay (seconds)')} rules={[{required:true,type:'number',min:10,max:3600}]}><InputNumber aria-label={t('重试间隔（秒）','Retry delay (seconds)')} min={10} max={3600} precision={0}/></Form.Item>
   </div>
   <Typography.Paragraph type="secondary">{t('脚本以 Agent 的系统用户权限运行，使用独立任务环境。同一主机的上次执行未结束时跳过本次；错过的计划不补跑。','Scripts run as the Agent system user in a separate task environment. An unfinished run on the same host skips the next run; missed schedules are not replayed.')}</Typography.Paragraph>
  </>} ]}/>}
  <Form.Item name="enabled" label={t('任务状态','Task status')} valuePropName="checked" extra={type==='script'?t('启用后按计划执行；手动任务仍需派发。停用只停止后续派发。','Enabled schedules run automatically; manual tasks still require dispatch. Disabling stops future dispatch only.'):t('启用后将任务配置下发给匹配主机。','Enabled task configuration is delivered to matching hosts.')}><Switch aria-label={t('启用任务','Enable task')} checkedChildren={t('启用','Enabled')} unCheckedChildren={t('停用','Disabled')}/></Form.Item>
  {error&&<Alert type="error" showIcon title={error} style={{marginTop:16}}/>}
  <Space wrap className="lm-agent-editor-actions"><Button type="primary" htmlType="submit" loading={saving}>{hostOverride?t('保存任务','Save task'):t('审阅并保存','Review and save')}</Button>{!hostOverride&&<Button disabled={saving} onClick={()=>void prepare(true)}>{t('保存草稿','Save draft')}</Button>}<Button disabled={saving} onClick={onCancel}>{t('取消','Cancel')}</Button></Space>
  <Modal open={!!replacement} title={t('替换现有脚本？','Replace the existing script?')} onCancel={()=>setReplacement(undefined)} onOk={()=>replacement&&applyScript(replacement)} okText={t('替换代码','Replace code')} cancelText={t('保留当前代码','Keep current code')}><p>{t('上传的文件将替换编辑器中的代码，其他任务设置保持不变。','The uploaded file replaces the code in the editor and keeps the other task settings.')}</p><Typography.Text code>{replacement?.name}</Typography.Text></Modal>
  <Modal open={!!review} title={t('审阅任务','Review task')} width={860} maskClosable={false} keyboard={!saving} closable={!saving} onCancel={()=>{if(!saving)setReview(undefined)}} onOk={()=>review&&void persist(review)} confirmLoading={saving} okButtonProps={{disabled:!reviewed||saving}} cancelButtonProps={{disabled:saving}} okText={review?.enabled?t('确认保存并启用','Save and enable'):t('确认保存','Confirm save')} cancelText={t('返回编辑','Back to editing')}>
   {review&&<><Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'name',label:t('任务名称','Task name'),children:review.name},{key:'type',label:t('任务类型','Task type'),children:taskTypeName(review.type,uiLanguage)},{key:'schedule',label:t('执行计划','Execution schedule'),children:taskScheduleSummary(review.schedule,uiLanguage),span:2},{key:'targets',label:t('目标主机','Target hosts'),children:review.target_all?t(`全部主机（当前 ${matching.length} 台，含后续新增主机）`,`All hosts (${matching.length} now, including future hosts)`):matching.map(host=>host.name).join(', ')||t('未选择目标','No targets selected'),span:2},...(review.type==='script'?[{key:'runtime',label:t('运行时','Runtime'),children:review.script?.runtime},{key:'cwd',label:t('工作目录','Working directory'),children:review.script?.cwd||t('任务临时目录','Run temporary directory')},{key:'args',label:t('参数','Arguments'),children:JSON.stringify(review.script?.args??[]),span:2},{key:'timeout',label:t('超时','Timeout'),children:`${review.script?.timeout_seconds}s`},{key:'retry',label:t('失败重试次数','Failure retries'),children:review.execution_policy?.retry_count??0},{key:'parallel',label:t('最多同时执行的主机数','Maximum concurrent hosts'),children:review.execution_policy?.max_concurrency},{key:'queue',label:t('队列等待期限','Queue timeout'),children:`${review.execution_policy?.queue_timeout_seconds}s`},{key:'capability',label:t('Agent 能力','Agent capability'),children:requiredScriptCapability(review.script)}]:[])]}/>{review.type==='script'&&<><h3>{t('最终执行代码','Final execution code')}</h3><pre className="lm-task-output">{review.script?.code}</pre></>}<Checkbox checked={reviewed} disabled={saving} onChange={event=>setReviewed(event.target.checked)}>{review.enabled&&review.type==='script'&&review.schedule?.mode!=='once'?t('我已审阅代码、目标和计划，授权启用后的定时执行','I reviewed the code, targets and schedule, and authorize scheduled execution after enabling'):t('我已审阅任务内容和目标主机','I reviewed the task content and target hosts')}</Checkbox></>}
  </Modal>
 </Form>;
}
