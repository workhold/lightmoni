import {useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,Button,Checkbox,Form,Input,InputNumber,Radio,Select,Space,Switch,Typography} from '../shared/ui';
import {agentTaskTypes,defaultTasks,hostCollectors,logicalTableRules,taskFormValues,taskPayload,type AgentTaskLabel,type AgentTaskType,type LogSource,type ManagedAgentTask,type TaskForm} from './agent-model';

type TaskDraft = Omit<ManagedAgentTask,'id'>;
const nameRules = [{required:true,whitespace:true,message:'请输入任务名称'},{validator:(_:unknown,value?:string) => new TextEncoder().encode(value?.trim() ?? '').length <= 128 ? Promise.resolve() : Promise.reject(new Error('任务名称最长 128 字节'))}];

export default function AgentTaskEditor({task,labels,onSave,onCancel,onBusyChange}: {
  task?:ManagedAgentTask;labels:AgentTaskLabel[];onSave:(task:TaskDraft)=>Promise<void>;onCancel:()=>void;onBusyChange:(busy:boolean)=>void;
}) {
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
    } catch(error) {setError(error instanceof Error?error.message:'保存任务失败');}
    finally {setSaving(false);onBusyChange(false);}
  };
  return <Form form={form} layout="vertical" initialValues={initialValues} disabled={saving} onFinish={save} scrollToFirstError>
    <div className="lm-agent-form-grid">
      <Form.Item name="name" label="任务名称" rules={nameRules}><Input aria-label="任务名称" placeholder="例如：生产主机指标"/></Form.Item>
      <Form.Item name="type" label="任务类型" rules={[{required:true}]} extra={task?'既有任务的类型固定；需要其他类型时请新建任务。':undefined}><Select aria-label="任务类型" disabled={saving || !!task} options={agentTaskTypes}/></Form.Item>
    </div>
    <Form.Item name="enabled" label="任务状态" valuePropName="checked" extra="启用后，下发给标签匹配的执行节点；关闭后自动撤除。"><Switch aria-label="启用任务" checkedChildren="启用" unCheckedChildren="停用"/></Form.Item>
    <Form.Item name="label_ids" label="任务标签" extra="任一标签匹配即下发，同一任务只执行一次。"><Select mode="multiple" allowClear showSearch={{optionFilterProp:'label'}} aria-label="任务标签" placeholder="选择目标任务标签" options={labels.map(label=>({value:label.id,label:label.name}))}/></Form.Item>
    {!selectedLabels?.length && <Alert type="info" showIcon title="未选择任务标签，此任务不会下发给任何执行节点。" className="lm-agent-form-notice"/>}
    {type==='host' && <>
      <Form.Item name="host_collectors" label="采集哪些指标" rules={[{validator:(_:unknown,value?:string[])=>!enabled||value?.length?Promise.resolve():Promise.reject(new Error('至少选择一项指标'))}]}><Checkbox.Group className="lm-agent-collectors" options={hostCollectors}/></Form.Item>
      <div className="lm-agent-form-grid">
        <Form.Item name="collect_interval_seconds" label="采集间隔（秒）" rules={[{required:true,type:'number',min:1,max:86400,message:'填写 1–86400 秒'}]}><InputNumber aria-label="采集间隔（秒）" min={1} max={86400} precision={0}/></Form.Item>
        <Form.Item name="host_table" label="指标上报表" rules={logicalTableRules}><Input aria-label="指标上报表" placeholder="host"/></Form.Item>
      </div>
      <Form.Item noStyle shouldUpdate={(a,b)=>a.host_collectors!==b.host_collectors}>{({getFieldValue})=>(getFieldValue('host_collectors') ?? []).includes('process')?<Form.Item name="process_names" label="进程名称" rules={[{required:true,type:'array',min:1,max:32,message:'填写 1–32 个进程名称'}]} extra="按进程名匹配，例如 nginx、postgres；可使用 * 匹配多个进程。"><Select mode="tags" aria-label="进程名称" tokenSeparators={[',','，']} placeholder="输入进程名称并回车"/></Form.Item>:null}</Form.Item>
    </>}
    {type==='probe' && <>
      <Form.Item name="probe_table" label="拨测结果上报表" rules={logicalTableRules}><Input aria-label="拨测结果上报表" placeholder="probe"/></Form.Item>
      <p className="lm-agent-muted">执行节点按配置检测 HTTP 或 TCP 目标，上报可用性、耗时和失败原因。</p>
      <Form.List name="probes" rules={[{validator:(_:unknown,value?:TaskForm['probes'])=>{
        if(!value?.length) return enabled?Promise.reject(new Error('至少添加一个拨测目标')):Promise.resolve();
        if(value.length>128) return Promise.reject(new Error('最多添加 128 个拨测目标'));
        const names=value.map(probe=>probe.id?.trim()).filter(Boolean);
        return new Set(names).size===names.length?Promise.resolve():Promise.reject(new Error('拨测名称不能重复'));
      }}]}>{(fields,{add,remove},{errors})=><>
        {fields.map(field=><div className="lm-agent-probe" key={field.key}>
          <div className="lm-agent-probe-heading"><strong>拨测 {field.name+1}</strong><Button type="text" danger aria-label={`删除拨测 ${field.name+1}`} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
          <div className="lm-agent-form-grid">
            <Form.Item name={[field.name,'id']} label="拨测名称" rules={[{required:true,whitespace:true,message:'请输入拨测名称'},{validator:(_:unknown,value?:string)=>new TextEncoder().encode(value?.trim() ?? '').length<=128?Promise.resolve():Promise.reject(new Error('拨测名称最长 128 字节'))}]}><Input aria-label={`拨测 ${field.name+1} 名称`} placeholder="例如：网站首页"/></Form.Item>
            <Form.Item name={[field.name,'kind']} label="拨测类型" rules={[{required:true}]}><Select aria-label={`拨测 ${field.name+1} 类型`} options={[{value:'http',label:'HTTP / HTTPS'},{value:'tcp',label:'TCP 端口'}]}/></Form.Item>
          </div>
          <Form.Item noStyle shouldUpdate={(a,b)=>a.probes?.[field.name]?.kind!==b.probes?.[field.name]?.kind}>{({getFieldValue})=>{
            const http=getFieldValue(['probes',field.name,'kind'])==='http';
            return <>
              <Form.Item name={[field.name,'target']} label={http?'目标网址':'目标地址与端口'} rules={[{required:true,whitespace:true,message:'请输入拨测目标'},{validator:(_:unknown,value?:string)=>{
                let valid=false;
                if(http) {try {const url=new URL(value?.trim() ?? '');valid=['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password;} catch { /* Validation message below. */ }}
                else {const match=/^(?:\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(value?.trim() ?? '');valid=!!match&&Number(match[1])>0&&Number(match[1])<=65535;}
                return valid?Promise.resolve():Promise.reject(new Error(http?'填写完整的 HTTP / HTTPS 网址':'填写主机名或 IP 加端口，例如 db.internal:5432'));
              }}]}><Input aria-label={`拨测 ${field.name+1} 目标`} placeholder={http?'https://example.com/health':'db.internal:5432'}/></Form.Item>
              <div className="lm-agent-form-grid">
                <Form.Item name={[field.name,'interval_seconds']} label="拨测间隔（秒）" rules={[{required:true,type:'number',min:1,max:86400,message:'填写 1–86400 秒'}]}><InputNumber aria-label={`拨测 ${field.name+1} 间隔（秒）`} min={1} max={86400} precision={0}/></Form.Item>
                <Form.Item name={[field.name,'timeout_seconds']} label="超时（秒）" rules={[{required:true,type:'number',min:0.001,max:120,message:'填写 0.001–120 秒'}]}><InputNumber aria-label={`拨测 ${field.name+1} 超时（秒）`} min={0.001} max={120} step={1}/></Form.Item>
              </div>
              {http&&<Form.Item name={[field.name,'expected_status']} label="成功状态码" extra="留空时 200–399 都视为成功。" rules={[{validator:(_:unknown,value?:string[])=>(value ?? []).every(status=>/^\d{3}$/.test(status)&&Number(status)>=100&&Number(status)<=599)?Promise.resolve():Promise.reject(new Error('填写 100–599 的 HTTP 状态码'))}]}><Select aria-label={`拨测 ${field.name+1} 成功状态码`} mode="tags" tokenSeparators={[',','，']} placeholder="默认：200–399" options={['200','201','204','301','302','304'].map(status=>({label:status,value:status}))}/></Form.Item>}
            </>;
          }}</Form.Item>
        </div>)}
        <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=128} onClick={()=>add({id:'',kind:'http',target:'',interval_seconds:60,timeout_seconds:5,expected_status:[]})}>添加拨测目标</Button>
      </>}</Form.List>
    </>}
    {type==='log' && <>
      <Form.Item name="log_table" label="目录日志上报表" rules={logicalTableRules}><Input aria-label="目录日志上报表" placeholder="files"/></Form.Item>
      <p className="lm-agent-muted">逐行采集文件新增内容，支持日志轮转和重启续读。目录需允许 LightMoni Agent 服务用户读取。</p>
      <Form.List name="log_sources" rules={[{validator:(_:unknown,sources?:LogSource[])=>{
        if(!sources?.length) return enabled?Promise.reject(new Error('至少添加一个日志目录')):Promise.resolve();
        if(sources.length>32) return Promise.reject(new Error('最多添加 32 个日志目录'));
        const paths=sources.map(source=>`${source.directory?.trim()}:${source.pattern?.trim()||'*.log*'}:${!!source.recursive}`);
        return new Set(paths).size===paths.length?Promise.resolve():Promise.reject(new Error('日志目录和匹配规则不能重复'));
      }}]}>{(fields,{add,remove},{errors})=><>
        {fields.map(field=><div className="lm-agent-probe" key={field.key}>
          <div className="lm-agent-probe-heading"><strong>日志目录 {field.name+1}</strong><Button type="text" danger aria-label={`删除日志目录 ${field.name+1}`} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
          <Form.Item name={[field.name,'directory']} label="目录路径" rules={[{required:true,whitespace:true,message:'请输入日志目录'},{validator:(_:unknown,value?:string)=>value?.trim().startsWith('/')&&value.trim().length<=4096?Promise.resolve():Promise.reject(new Error('填写服务器上的绝对目录路径，例如 /var/log/nginx'))}]}><Input aria-label={`日志目录 ${field.name+1} 路径`} placeholder="/var/log/nginx"/></Form.Item>
          <Form.Item name={[field.name,'pattern']} label="文件匹配规则" extra="*.log* 包含 app.log、app.log.1 等轮转文件；压缩文件不采集。" rules={[{required:true,message:'请输入匹配规则'},{max:256,message:'匹配规则最长 256 位'},{validator:(_:unknown,value?:string)=>!/[\/\\]/.test(value ?? '')?Promise.resolve():Promise.reject(new Error('这里只填写文件名规则，目录在上方设置'))}]}><Input aria-label={`日志目录 ${field.name+1} 文件匹配规则`} placeholder="*.log*"/></Form.Item>
          <Form.Item name={[field.name,'recursive']} valuePropName="checked"><Checkbox aria-label={`日志目录 ${field.name+1} 包含子目录`}>同时采集子目录</Checkbox></Form.Item>
          <Form.Item name={[field.name,'from_beginning']} label="首次采集" extra="仅影响首次发现已有文件；修改任务标签不会重读已采集内容。"><Radio.Group aria-label={`日志目录 ${field.name+1} 首次采集`} options={[{value:false,label:'仅采集新增内容'},{value:true,label:'从文件开头采集'}]}/></Form.Item>
        </div>)}
        <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=32} onClick={()=>add({directory:'',pattern:'*.log*',recursive:false,from_beginning:false})}>添加日志目录</Button>
      </>}</Form.List>
    </>}
    <Typography.Paragraph type="secondary" className="lm-agent-report-note">上报表填写逻辑表名，上报 Key 需允许写入对应表。同类任务在同一节点上的采集间隔或目标表等配置不兼容时，保存会明确提示冲突。<Link to="/data?tab=keys">管理上报 Key</Link></Typography.Paragraph>
    {error&&<Alert type="error" showIcon title={error} style={{marginTop:16}}/>}
    <Space className="lm-agent-editor-actions"><Button type="primary" htmlType="submit" loading={saving}>保存任务</Button><Button disabled={saving} onClick={onCancel}>取消</Button></Space>
  </Form>;
}
