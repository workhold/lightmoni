import {useI18n} from '../shared/i18n';
import {DeleteOutlined,PlusOutlined} from '@ant-design/icons';
import {Button,Checkbox,Form,Input,Radio,Switch} from '../shared/ui';
import type {LogSource} from './agent-model';

export default function AgentLogSources({saving}:{saving:boolean}) {
 const {t}=useI18n();

 return <>
  <Form.Item name="logs_enabled" label={t("采集开关","Collection switch")} valuePropName="checked"><Switch aria-label={t("开启目录日志采集","Enable directory log collection")} checkedChildren={t("开启","On")} unCheckedChildren={t("关闭","Off")}/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.logs_enabled!==b.logs_enabled}>{({getFieldValue})=>getFieldValue('logs_enabled')?<>
   <p className="lm-agent-muted">{t("逐行采集文件新增内容，自动记录读取进度。支持日志轮转和重启续读；目录需允许 Agent 服务用户读取。","Collect new file contents line by line and track read positions automatically. Supports log rotation and resuming after restart. The Agent service user must have read access to the directory.")}</p>
   <Form.List name="log_sources" rules={[{validator:(_:unknown,sources?:LogSource[])=>{
    if (!sources?.length) return Promise.reject(new Error(t("至少添加一个日志目录","Add at least one log directory")));
    if (sources.length>32) return Promise.reject(new Error(t("最多添加 32 个日志目录","Add up to 32 log directories")));
    const paths=sources.map(source=>`${source.directory?.trim()}:${source.pattern?.trim()||'*.log*'}:${!!source.recursive}`);
    return new Set(paths).size===paths.length?Promise.resolve():Promise.reject(new Error(t("日志目录和匹配规则不能重复","Log directories and matching patterns must be unique")));
   }}]}>{(fields,{add,remove},{errors})=><>
    {fields.map(field=><div className="lm-agent-probe" key={field.key}>
     <div className="lm-agent-probe-heading"><strong>{t("日志目录","Log directory")} {field.name+1}</strong><Button type="text" danger aria-label={t(`删除日志目录 ${field.name+1}`,`Remove log directory ${field.name+1}`)} icon={<DeleteOutlined/>} onClick={()=>remove(field.name)}/></div>
     <Form.Item name={[field.name,'directory']} label={t("目录路径","Directory path")} rules={[{required:true,whitespace:true,message:t("请输入日志目录","Enter a log directory")},{validator:(_:unknown,value?:string)=>value?.trim().startsWith('/')&&value.trim().length<=4096?Promise.resolve():Promise.reject(new Error(t("填写服务器上的绝对目录路径，例如 /var/log/nginx","Enter an absolute server directory path, such as /var/log/nginx")))}]}><Input aria-label={t(`日志目录 ${field.name+1} 路径`,`Log directory ${field.name+1} path`)} placeholder="/var/log/nginx"/></Form.Item>
     <Form.Item name={[field.name,'pattern']} label={t("文件匹配规则","File pattern")} extra={t("按文件名匹配；*.log* 包含 app.log、app.log.1 等轮转文件。压缩文件不采集。","Match file names: *.log* includes rotated files such as app.log and app.log.1. Compressed files are excluded.")} rules={[{required:true,message:t("请输入匹配规则","Enter a file pattern")},{max:256,message:t("匹配规则最长 256 位","File patterns may contain up to 256 characters")},{validator:(_:unknown,value?:string)=>!/[\/\\]/.test(value??'')?Promise.resolve():Promise.reject(new Error(t("这里只填写文件名规则，目录在上方设置","Enter only the file-name pattern; set the directory above")))}]}><Input aria-label={t(`日志目录 ${field.name+1} 文件匹配规则`,`Log directory ${field.name+1} file pattern`)} placeholder="*.log*"/></Form.Item>
     <Form.Item name={[field.name,'recursive']} valuePropName="checked"><Checkbox aria-label={t(`日志目录 ${field.name+1} 包含子目录`,`Log directory ${field.name+1} include subdirectories`)}>{t("同时采集子目录","Include subdirectories")}</Checkbox></Form.Item>
     <Form.Item name={[field.name,'from_beginning']} label={t("首次采集","Initial collection")} extra={t("仅影响首次发现已有文件；后续新建文件会完整采集，修改分组不会重读已采集内容。","Applies only to existing files when first discovered. New files are read in full. Changing groups does not reread collected content.")}><Radio.Group aria-label={t(`日志目录 ${field.name+1} 首次采集`,`Log directory ${field.name+1} initial collection`)} options={[{value:false,label:t("仅采集新增内容","Collect only new content")},{value:true,label:t("从文件开头采集","Read from the beginning")}]}/></Form.Item>
    </div>)}
    <Form.ErrorList errors={errors}/><Button icon={<PlusOutlined/>} disabled={saving||fields.length>=32} onClick={()=>add({directory:'',pattern:'*.log*',recursive:false,from_beginning:false})}>{t("添加日志目录","Add log directory")}</Button>
   </>}</Form.List>
  </>:<p className="lm-agent-muted">{t("开启后，组内 Agent 会按目录和文件规则统一采集日志。","When enabled, Agents in the group collect logs using these directory and file patterns.")}</p>}</Form.Item>
 </>;
}
