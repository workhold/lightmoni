import {Alert,ConfigProvider,Form,Input,Select,Switch,Typography} from '../../shared/ui';
import {channelDefaults,channelFields,channelHelp,channelLabels,phoneChannels,smtpPresetConfig,smtpPresets,type Channel} from './channels';

export default function ChannelEditor({channel,onChange}:{channel:Channel;onChange:(channel:Channel)=>void}){
 const config=(key:string,value:string)=>onChange({...channel,config:{...channel.config,[key]:value}});
 const help=channelHelp(channel.type);
 const preset=smtpPresets.find(p=>p.host===channel.config.host&&channel.config.port==='465'&&channel.config.tls==='tls')?.value??'custom';
 return <ConfigProvider getPopupContainer={node=>node?.parentElement??document.body}><Form layout="vertical">
  <Form.Item label="名称" required><Input aria-label="通知渠道名称" value={channel.name} onChange={e=>onChange({...channel,name:e.target.value})}/></Form.Item>
  <Form.Item label="类型"><Select aria-label="通知渠道类型" virtual={false} value={channel.type} disabled={!!channel.id} options={Object.entries(channelLabels).map(([value,label])=>({label,value}))} onChange={type=>onChange({...channel,type,config:channelDefaults(type)})}/></Form.Item>
  <Form.Item label="渠道状态"><Switch checked={channel.enabled} onChange={enabled=>onChange({...channel,enabled})} checkedChildren="启用" unCheckedChildren="禁用"/></Form.Item>
  {help&&<Alert type="info" showIcon title={help}/>}
  {channel.type==='smtp'&&<Form.Item label="邮箱配置预设"><Select aria-label="邮箱配置预设" value={preset} options={[{label:'自定义 SMTP',value:'custom'},...smtpPresets.map(({value,label})=>({value,label}))]} onChange={value=>onChange({...channel,config:{...channel.config,...smtpPresetConfig(value)}})}/></Form.Item>}
  {channelFields(channel.type).map(field=>{
   const label=field.label+(field.secret&&channel.has_secret?'（留空保留已配置值）':'');
   return <Form.Item key={field.key} label={label} required={field.required}>
    {field.options?<Select aria-label={field.label} value={channel.config[field.key]||undefined} options={field.options} onChange={value=>config(field.key,value)}/>:field.multiline?<Input.TextArea aria-label={field.label} value={channel.config[field.key]??''} rows={3} placeholder={field.placeholder} onChange={e=>config(field.key,e.target.value)}/>:<Input aria-label={field.label} value={channel.config[field.key]??''} type={field.password?'password':'text'} autoComplete={field.password?'new-password':'off'} placeholder={field.placeholder} onChange={e=>config(field.key,e.target.value)}/>}
   </Form.Item>;
  })}
  {phoneChannels.includes(channel.type)&&<Typography.Paragraph type="secondary">模板变量支持 {'{{rule}}'}（告警名称）、{'{{status}}'}（事件类型）、{'{{value}}'}（数值）、{'{{message}}'}（告警详情）。无变量的模板填写空对象或空数组。供应商受理后可在发送记录查看流水号。</Typography.Paragraph>}
 </Form></ConfigProvider>;
}
