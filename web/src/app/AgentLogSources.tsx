import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Button,Checkbox,Form,Input,Radio,Switch} from '../shared/ui';
import type {LogSource} from './agent-model';

export default function AgentLogSources({saving}:{saving:boolean}) {
 return <>
  <Form.Item name="logs_enabled" label="采集开关" valuePropName="checked"><Switch aria-label="开启目录日志采集" checkedChildren="开启" unCheckedChildren="关闭"/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.logs_enabled!==b.logs_enabled}>{({getFieldValue})=>getFieldValue('logs_enabled')?<>
   <p className="lm-agent-muted">逐行采集文件新增内容，自动记录读取进度。支持日志轮转和重启续读；目录需允许 Agent 服务用户读取。</p>
   <Form.List name="log_sources" rules={[{validator:(_:unknown,sources?:LogSource[])=>{
    if (!sources?.length) return Promise.reject(new Error('至少添加一个日志目录'));
    if (sources.length>32) return Promise.reject(new Error('最多添加 32 个日志目录'));
    const paths=sources.map(source=>`${source.directory?.trim()}:${source.pattern?.trim()||'*.log*'}:${!!source.recursive}`);
    return new Set(paths).size===paths.length?Promise.resolve():Promise.reject(new Error('日志目录和匹配规则不能重复'));
   }}]}>{(fields,{add,remove},{errors})=><>
    {fields.map(field=><div className="lm-agent-probe" key={field.key}>
     <div className="lm-agent-probe-heading"><strong>日志目录 {field.name+1}</strong><Button type="text" danger aria-label={`删除日志目录 ${field.name+1}`} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
     <Form.Item name={[field.name,'directory']} label="目录路径" rules={[{required:true,whitespace:true,message:'请输入日志目录'},{validator:(_:unknown,value?:string)=>value?.trim().startsWith('/')&&value.trim().length<=4096?Promise.resolve():Promise.reject(new Error('填写服务器上的绝对目录路径，例如 /var/log/nginx'))}]}><Input aria-label={`日志目录 ${field.name+1} 路径`} placeholder="/var/log/nginx"/></Form.Item>
     <Form.Item name={[field.name,'pattern']} label="文件匹配规则" extra="按文件名匹配；*.log* 包含 app.log、app.log.1 等轮转文件。压缩文件不采集。" rules={[{required:true,message:'请输入匹配规则'},{max:256,message:'匹配规则最长 256 位'},{validator:(_:unknown,value?:string)=>!/[\/\\]/.test(value??'')?Promise.resolve():Promise.reject(new Error('这里只填写文件名规则，目录在上方设置'))}]}><Input aria-label={`日志目录 ${field.name+1} 文件匹配规则`} placeholder="*.log*"/></Form.Item>
     <Form.Item name={[field.name,'recursive']} valuePropName="checked"><Checkbox aria-label={`日志目录 ${field.name+1} 包含子目录`}>同时采集子目录</Checkbox></Form.Item>
     <Form.Item name={[field.name,'from_beginning']} label="首次采集" extra="仅影响首次发现已有文件；后续新建文件会完整采集，修改分组不会重读已采集内容。"><Radio.Group aria-label={`日志目录 ${field.name+1} 首次采集`} options={[{value:false,label:'仅采集新增内容'},{value:true,label:'从文件开头采集'}]}/></Form.Item>
    </div>)}
    <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=32} onClick={()=>add({directory:'',pattern:'*.log*',recursive:false,from_beginning:false})}>添加日志目录</Button>
   </>}</Form.List>
  </>:<p className="lm-agent-muted">开启后，组内 Agent 会按目录和文件规则统一采集日志。</p>}</Form.Item>
 </>;
}
