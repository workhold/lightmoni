import {useI18n} from '../shared/i18n';
import {useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,Button,Checkbox,Form,Input,InputNumber,Radio,Select,Space,Switch,Typography} from '../shared/ui';
import {agentTaskTypes,defaultTasks,hostCollectors,hostCollectorName,localizedLogicalTableRules,taskTypeName,taskFormValues,taskPayload,type AgentTaskLabel,type AgentTaskType,type LogSource,type ManagedAgentTask,type TaskForm} from './agent-model';

type TaskDraft = Omit<ManagedAgentTask,'id'>;

export default function AgentTaskEditor({task,labels,onSave,onCancel,onBusyChange}: {
  task?:ManagedAgentTask;labels:AgentTaskLabel[];onSave:(task:TaskDraft)=>Promise<void>;onCancel:()=>void;onBusyChange:(busy:boolean)=>void;
}) {
 const {t,language:uiLanguage}=useI18n();
const nameRules = [{required:true,whitespace:true,message:t("请输入任务名称","Enter a task name")},{validator:(_:unknown,value?:string) => new TextEncoder().encode(value?.trim() ?? '').length <= 128 ? Promise.resolve() : Promise.reject(new Error(t("任务名称最长 128 字节","Task names may contain up to 128 bytes")))}];

  const [form] = Form.useForm<TaskForm>();
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState('');
  const type = Form.useWatch('type',form) as AgentTaskType|undefined;
  const enabled = Form.useWatch('enabled',form) as boolean|undefined;
  const selectedLabels = Form.useWatch('label_ids',form) as string[]|undefined;
  const initialValues:TaskForm = {...taskFormValues(task?.config ?? defaultTasks),name:task?.name ?? '',type:task?.type ?? 'host',enabled:task?.enabled ?? true,label_ids:task?.label_ids ?? []};
  const save = async(values:TaskForm) => {
    setSaving(true);onBusyChange(true);setError('');
    try {
      const all = {...initialValues,...form.getFieldsValue(true),...values};
      const taskType = all.type ?? 'host';
      const config = taskPayload(all);
      config.host_enabled = taskType==='host';config.logs_enabled = taskType==='log';
      if(taskType!=='host') {config.host_collectors=[];config.process_names=[];}
      if(taskType!=='probe') config.probes=[];
      if(taskType!=='log') config.log_sources=[];
      delete config.revision;delete config.group_id;
      await onSave({name:all.name?.trim() ?? '',type:taskType,enabled:!!all.enabled,label_ids:all.label_ids ?? [],config});
    } catch(error) {setError(error instanceof Error?error.message:t("保存任务失败","Unable to save task"));}
    finally {setSaving(false);onBusyChange(false);}
  };
  return <Form form={form} layout="vertical" initialValues={initialValues} disabled={saving} onFinish={save} scrollToFirstError>
    <div className="lm-agent-form-grid">
      <Form.Item name="name" label={t("任务名称","Task name")} rules={nameRules}><Input aria-label={t("任务名称","Task name")} placeholder={t("例如：生产主机指标","Example: Production host metrics")}/></Form.Item>
      <Form.Item name="type" label={t("任务类型","Task type")} rules={[{required:true}]} extra={task?t("既有任务的类型固定；需要其他类型时请新建任务。","Existing task types cannot be changed. Create a new task for a different type."):undefined}><Select aria-label={t("任务类型","Task type")} disabled={saving || !!task} options={agentTaskTypes.map(item=>({...item,label:taskTypeName(item.value,uiLanguage)}))}/></Form.Item>
    </div>
    <Form.Item name="enabled" label={t("任务状态","Task status")} valuePropName="checked" extra={t("启用后，下发给标签匹配的执行节点；关闭后自动撤除。","Enabled tasks are delivered to nodes with matching labels and removed when disabled.")}><Switch aria-label={t("启用任务","Enable task")} checkedChildren={t("启用","Enabled")} unCheckedChildren={t("停用","Disabled")}/></Form.Item>
    <Form.Item name="label_ids" label={t("任务标签","Task labels")} extra={t("任一标签匹配即下发，同一任务只执行一次。","Any matching label delivers the task. Each task runs only once per node.")}><Select mode="multiple" allowClear showSearch={{optionFilterProp:'label'}} aria-label={t("任务标签","Task labels")} placeholder={t("选择目标任务标签","Select target task labels")} options={labels.map(label=>({value:label.id,label:label.name}))}/></Form.Item>
    {!selectedLabels?.length && <Alert type="info" showIcon title={t("未选择任务标签，此任务不会下发给任何执行节点。","No task labels selected. This task will not be delivered to any execution node.")} className="lm-agent-form-notice"/>}
    {type==='host' && <>
      <Form.Item name="host_collectors" label={t("采集哪些指标","Metrics to collect")} rules={[{validator:(_:unknown,value?:string[])=>!enabled||value?.length?Promise.resolve():Promise.reject(new Error(t("至少选择一项指标","Select at least one metric")))}]}><Checkbox.Group className="lm-agent-collectors" options={hostCollectors.map(item=>({...item,label:hostCollectorName(item.value,uiLanguage)}))}/></Form.Item>
      <div className="lm-agent-form-grid">
        <Form.Item name="collect_interval_seconds" label={t("采集间隔（秒）","Collection interval (seconds)")} rules={[{required:true,type:'number',min:1,max:86400,message:t("填写 1–86400 秒","Enter 1–86400 seconds")}]}><InputNumber aria-label={t("采集间隔（秒）","Collection interval (seconds)")} min={1} max={86400} precision={0}/></Form.Item>
        <Form.Item name="host_table" label={t("指标上报表","Metric reporting table")} rules={localizedLogicalTableRules(uiLanguage)}><Input aria-label={t("指标上报表","Metric reporting table")} placeholder="host"/></Form.Item>
      </div>
      <Form.Item noStyle shouldUpdate={(a,b)=>a.host_collectors!==b.host_collectors}>{({getFieldValue})=>(getFieldValue('host_collectors') ?? []).includes('process')?<Form.Item name="process_names" label={t("进程名称","Process names")} rules={[{required:true,type:'array',min:1,max:32,message:t("填写 1–32 个进程名称","Enter 1–32 process names")}]} extra={t("按进程名匹配，例如 nginx、postgres；可使用 * 匹配多个进程。","Match process names such as nginx or postgres. Use * to match multiple processes.")}><Select mode="tags" aria-label={t("进程名称","Process names")} tokenSeparators={[',','，']} placeholder={t("输入进程名称并回车","Enter a process name and press Enter")}/></Form.Item>:null}</Form.Item>
    </>}
    {type==='probe' && <>
      <Form.Item name="probe_table" label={t("拨测结果上报表","Probe reporting table")} rules={localizedLogicalTableRules(uiLanguage)}><Input aria-label={t("拨测结果上报表","Probe reporting table")} placeholder="probe"/></Form.Item>
      <p className="lm-agent-muted">{t("执行节点按配置检测 HTTP 或 TCP 目标，上报可用性、耗时和失败原因。","Execution nodes probe configured HTTP or TCP targets and report availability, latency, and failure reasons.")}</p>
      <Form.List name="probes" rules={[{validator:(_:unknown,value?:TaskForm['probes'])=>{
        if(!value?.length) return enabled?Promise.reject(new Error(t("至少添加一个拨测目标","Add at least one probe target"))):Promise.resolve();
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
      <Form.Item name="log_table" label={t("目录日志上报表","Directory log reporting table")} rules={localizedLogicalTableRules(uiLanguage)}><Input aria-label={t("目录日志上报表","Directory log reporting table")} placeholder="files"/></Form.Item>
      <p className="lm-agent-muted">{t("逐行采集文件新增内容，支持日志轮转和重启续读。目录需允许 LightMoni Agent 服务用户读取。","Collect new file contents line by line, with log rotation and resume support. The LightMoni Agent service user must have read access to the directory.")}</p>
      <Form.List name="log_sources" rules={[{validator:(_:unknown,sources?:LogSource[])=>{
        if(!sources?.length) return enabled?Promise.reject(new Error(t("至少添加一个日志目录","Add at least one log directory"))):Promise.resolve();
        if(sources.length>32) return Promise.reject(new Error(t("最多添加 32 个日志目录","Add up to 32 log directories")));
        const paths=sources.map(source=>`${source.directory?.trim()}:${source.pattern?.trim()||'*.log*'}:${!!source.recursive}`);
        return new Set(paths).size===paths.length?Promise.resolve():Promise.reject(new Error(t("日志目录和匹配规则不能重复","Log directories and matching patterns must be unique")));
      }}]}>{(fields,{add,remove},{errors})=><>
        {fields.map(field=><div className="lm-agent-probe" key={field.key}>
          <div className="lm-agent-probe-heading"><strong>{t("日志目录","Log directory")} {field.name+1}</strong><Button type="text" danger aria-label={t(`删除日志目录 ${field.name+1}`,`Remove log directory ${field.name+1}`)} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
          <Form.Item name={[field.name,'directory']} label={t("目录路径","Directory path")} rules={[{required:true,whitespace:true,message:t("请输入日志目录","Enter a log directory")},{validator:(_:unknown,value?:string)=>value?.trim().startsWith('/')&&value.trim().length<=4096?Promise.resolve():Promise.reject(new Error(t("填写服务器上的绝对目录路径，例如 /var/log/nginx","Enter an absolute server directory path, such as /var/log/nginx")))}]}><Input aria-label={t(`日志目录 ${field.name+1} 路径`,`Log directory ${field.name+1} path`)} placeholder="/var/log/nginx"/></Form.Item>
          <Form.Item name={[field.name,'pattern']} label={t("文件匹配规则","File pattern")} extra={t("*.log* 包含 app.log、app.log.1 等轮转文件；压缩文件不采集。","*.log* includes rotated files such as app.log and app.log.1. Compressed files are excluded.")} rules={[{required:true,message:t("请输入匹配规则","Enter a file pattern")},{max:256,message:t("匹配规则最长 256 位","File patterns may contain up to 256 characters")},{validator:(_:unknown,value?:string)=>!/[\/\\]/.test(value ?? '')?Promise.resolve():Promise.reject(new Error(t("这里只填写文件名规则，目录在上方设置","Enter only the file-name pattern; set the directory above")))}]}><Input aria-label={t(`日志目录 ${field.name+1} 文件匹配规则`,`Log directory ${field.name+1} file pattern`)} placeholder="*.log*"/></Form.Item>
          <Form.Item name={[field.name,'recursive']} valuePropName="checked"><Checkbox aria-label={t(`日志目录 ${field.name+1} 包含子目录`,`Log directory ${field.name+1} include subdirectories`)}>{t("同时采集子目录","Include subdirectories")}</Checkbox></Form.Item>
          <Form.Item name={[field.name,'from_beginning']} label={t("首次采集","Initial collection")} extra={t("仅影响首次发现已有文件；修改任务标签不会重读已采集内容。","Applies only to existing files when first discovered. Changing task labels does not reread collected content.")}><Radio.Group aria-label={t(`日志目录 ${field.name+1} 首次采集`,`Log directory ${field.name+1} initial collection`)} options={[{value:false,label:t("仅采集新增内容","Collect only new content")},{value:true,label:t("从文件开头采集","Read from the beginning")}]}/></Form.Item>
        </div>)}
        <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=32} onClick={()=>add({directory:'',pattern:'*.log*',recursive:false,from_beginning:false})}>{t("添加日志目录","Add log directory")}</Button>
      </>}</Form.List>
    </>}
    <Typography.Paragraph type="secondary" className="lm-agent-report-note">{t("上报表填写逻辑表名，上报 Key 需允许写入对应表。同类任务在同一节点上的采集间隔或目标表等配置不兼容时，保存会明确提示冲突。","Enter a logical reporting table name and authorize it in the reporting key. Saving reports conflicts if tasks of the same type on a node have incompatible intervals, tables, or other settings.")}<Link to="/admin?tab=credentials&section=sdk">{t("管理接入凭据","Manage access credentials")}</Link></Typography.Paragraph>
    {error&&<Alert type="error" showIcon title={error} style={{marginTop:16}}/>}
    <Space className="lm-agent-editor-actions"><Button type="primary" htmlType="submit" loading={saving}>{t("保存任务","Save task")}</Button><Button disabled={saving} onClick={onCancel}>{t("取消","Cancel")}</Button></Space>
  </Form>;
}
