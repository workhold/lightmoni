import {useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Alert,Button,Checkbox,Form,Input,InputNumber,Select,Space,Switch,Tabs,Typography} from '../shared/ui';
import {hostCollectors,logicalTableRules,taskFormValues,taskPayload,type AgentTasks,type TaskForm} from './agent-model';
import AgentLogSources from './AgentLogSources';

export default function AgentTaskEditor({tasks,endpoint,groupName,onSave,onCancel}: {
  tasks:AgentTasks;endpoint:string;groupName:string;onSave:(tasks:AgentTasks,name:string)=>Promise<void>;onCancel:()=>void;
}) {
  const [form] = Form.useForm<TaskForm>();
  const [tab,setTab] = useState('host');
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState('');
  return <Form form={form} layout="vertical" initialValues={{...taskFormValues(tasks),group_name:groupName}} disabled={saving}
    onFinish={async values => { setSaving(true);setError('');try { await onSave(taskPayload({...taskFormValues(tasks),...form.getFieldsValue(true),...values}),values.group_name?.trim() ?? ''); } catch (error) { setError(error instanceof Error?error.message:'保存失败'); } finally { setSaving(false); } }}
    onFinishFailed={({errorFields}) => { const field = errorFields[0]?.name[0];setTab(field === 'probes'?'probes':field === 'log_sources'?'logs':['host_table','probe_table','log_table'].includes(String(field))?'report':'host'); }}>
    <Form.Item name="group_name" label="分组名称" rules={[{required:true,whitespace:true,message:'请输入分组名称'},{validator:(_:unknown,value?:string) => new TextEncoder().encode(value ?? '').length <= 128 ? Promise.resolve() : Promise.reject(new Error('分组名称过长'))}]}><Input aria-label="分组名称" placeholder="例如：生产服务器"/></Form.Item>
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key:'host',label:'机器指标',forceRender:true,children:<>
        <Form.Item name="host_enabled" label="采集开关" valuePropName="checked"><Switch aria-label="开启机器指标采集" checkedChildren="开启" unCheckedChildren="关闭"/></Form.Item>
        <Form.Item noStyle shouldUpdate={(a,b) => a.host_enabled !== b.host_enabled}>{({getFieldValue}) => getFieldValue('host_enabled') ? <>
          <Form.Item name="host_collectors" label="采集哪些数据" rules={[{type:'array',min:1,required:true,message:'至少选择一项采集数据'}]}><Checkbox.Group className="lm-agent-collectors" options={hostCollectors}/></Form.Item>
          <Form.Item name="collect_interval_seconds" label="采集间隔（秒）" rules={[{required:true,type:'number',min:1,max:86400,message:'填写 1–86400 秒'}]}><InputNumber aria-label="采集间隔（秒）" min={1} max={86400} precision={0}/></Form.Item>
          <Form.Item noStyle shouldUpdate={(a,b) => a.host_collectors !== b.host_collectors}>{({getFieldValue}) => (getFieldValue('host_collectors') ?? []).includes('process') ? <Form.Item name="process_names" label="进程名称" rules={[{required:true,type:'array',min:1,message:'请填写需要监控的进程名称'}]} extra="按进程名匹配，例如 nginx、postgres；可使用 * 匹配多个进程。"><Select mode="tags" aria-label="进程名称" tokenSeparators={[',','，']} placeholder="输入进程名称并回车"/></Form.Item> : null}</Form.Item>
        </> : <p className="lm-agent-muted">关闭后停止采集机器指标，拨测和业务数据上报继续运行。</p>}</Form.Item>
      </>},
      {key:'probes',label:'拨测任务',forceRender:true,children:<>
        <p className="lm-agent-muted">保存任务后自动执行拨测，并上报成功率、耗时和失败原因。</p>
        <Form.List name="probes" rules={[{validator:(_:unknown,value?:TaskForm['probes']) => {
          if ((value?.length ?? 0) > 128) return Promise.reject(new Error('最多添加 128 个拨测任务'));
          const names = (value ?? []).map(probe => probe.id?.trim()).filter(Boolean);
          return new Set(names).size === names.length ? Promise.resolve() : Promise.reject(new Error('拨测任务名称不能重复'));
        }}]}>{(fields,{add,remove},{errors}) => <>
          {fields.length === 0 && <p className="lm-agent-muted">尚未配置拨测，添加一个 HTTP 或 TCP 目标即可开始。</p>}
          {fields.map(field => <div className="lm-agent-probe" key={field.key}>
            <div className="lm-agent-probe-heading"><strong>拨测 {field.name+1}</strong><Button type="text" danger aria-label={`删除拨测 ${field.name+1}`} icon={<DeleteOutlined/>} onClick={() => remove(field.name)}/></div>
            <div className="lm-agent-form-grid">
              <Form.Item name={[field.name,'id']} label="任务名称" rules={[{required:true,whitespace:true,message:'请输入任务名称'},{validator:(_:unknown,value?:string) => new TextEncoder().encode(value ?? '').length <= 128 ? Promise.resolve() : Promise.reject(new Error('任务名称过长'))}]}><Input aria-label={`拨测 ${field.name+1} 任务名称`} placeholder="例如：网站首页"/></Form.Item>
              <Form.Item name={[field.name,'kind']} label="类型" rules={[{required:true}]}><Select aria-label={`拨测 ${field.name+1} 类型`} options={[{value:'http',label:'HTTP / HTTPS'},{value:'tcp',label:'TCP 端口'}]}/></Form.Item>
            </div>
            <Form.Item noStyle shouldUpdate={(a,b) => a.probes?.[field.name]?.kind !== b.probes?.[field.name]?.kind}>{({getFieldValue}) => {
              const http = getFieldValue(['probes',field.name,'kind']) === 'http';
              return <>
                <Form.Item name={[field.name,'target']} label={http?'目标网址':'目标地址与端口'} rules={[{required:true,whitespace:true,message:'请输入拨测目标'},{validator:(_:unknown,value?:string) => {
                  let valid = false;
                  if (http) { try { const url = new URL(value ?? '');valid = ['http:','https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { /* Report the validation below. */ } }
                  else { const match = /^(?:\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(value ?? '');valid = !!match && Number(match[1]) > 0 && Number(match[1]) <= 65535; }
                  return valid ? Promise.resolve() : Promise.reject(new Error(http?'填写完整的 HTTP / HTTPS 网址':'填写主机名或 IP 加端口，例如 db.internal:5432'));
                }}]}><Input aria-label={`拨测 ${field.name+1} 目标`} placeholder={http?'https://example.com/health':'db.internal:5432'}/></Form.Item>
                <div className="lm-agent-form-grid">
                  <Form.Item name={[field.name,'interval_seconds']} label="拨测间隔（秒）" rules={[{required:true,type:'number',min:1,max:86400,message:'填写 1–86400 秒'}]}><InputNumber aria-label={`拨测 ${field.name+1} 间隔（秒）`} min={1} max={86400} precision={0}/></Form.Item>
                  <Form.Item name={[field.name,'timeout_seconds']} label="超时（秒）" rules={[{required:true,type:'number',min:0.001,max:120,message:'填写 0.001–120 秒'}]}><InputNumber aria-label={`拨测 ${field.name+1} 超时（秒）`} min={0.001} max={120} step={1}/></Form.Item>
                </div>
                {http && <Form.Item name={[field.name,'expected_status']} label="成功状态码" extra="留空时 200–399 都视为成功；也可填写 200、204 等状态码。" rules={[{validator:(_:unknown,value?:string[]) => (value ?? []).every(status => /^\d{3}$/.test(status) && Number(status) >= 100 && Number(status) <= 599) ? Promise.resolve() : Promise.reject(new Error('填写 100–599 的 HTTP 状态码'))}]}><Select aria-label={`拨测 ${field.name+1} 成功状态码`} mode="tags" tokenSeparators={[',','，']} placeholder="默认：200–399" options={['200','201','204','301','302','304'].map(status => ({label:status,value:status}))}/></Form.Item>}
              </>;
            }}</Form.Item>
          </div>)}
          <Form.ErrorList errors={errors}/>
          <Button icon={<PlusOutlined/>} disabled={saving || fields.length >= 128} onClick={() => add({id:'',kind:'http',target:'',interval_seconds:60,timeout_seconds:5,expected_status:[]})}>添加拨测</Button>
        </>}</Form.List>
      </>},
      {key:'logs',label:'目录日志',forceRender:true,children:<AgentLogSources saving={saving}/>},
      {key:'report',label:'上报配置',forceRender:true,children:<>
        <Form.Item label="上报地址" extra="安装时设置当前工作台地址和上报 Key，所有任务共用这份连接配置。"><Input aria-label="上报地址" readOnly value={endpoint}/></Form.Item>
        <Form.Item name="host_table" label="机器指标上报表" rules={logicalTableRules}><Input aria-label="机器指标上报表" placeholder="host"/></Form.Item>
        <Form.Item name="probe_table" label="拨测结果上报表" rules={logicalTableRules} extra="填写逻辑表名，系统自动生成对应的指标表。"><Input aria-label="拨测结果上报表" placeholder="probe"/></Form.Item>
        <Form.Item name="log_table" label="目录日志上报表" rules={logicalTableRules} extra="填写逻辑表名，系统自动生成对应的日志表。"><Input aria-label="目录日志上报表" placeholder="files"/></Form.Item>
        <Typography.Paragraph type="secondary">上报 Key 需允许写入这些表，或允许所有 table。<Link to="/data?tab=keys">管理上报 Key</Link></Typography.Paragraph>
      </>},
    ]}/>
    {error && <Alert type="error" title={error} style={{marginTop:16}}/>}
    <Space className="lm-agent-editor-actions"><Button type="primary" htmlType="submit" loading={saving}>保存配置</Button><Button disabled={saving} onClick={onCancel}>取消</Button></Space>
  </Form>;
}
