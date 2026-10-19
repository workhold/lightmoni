import {useI18n} from '../../shared/i18n';
import {Alert,ConfigProvider,Form,Input,Select,Switch,Typography} from '../../shared/ui';
import {channelDefaults,channelFields,channelHelp,getChannelLabels,phoneChannels,smtpPresetConfig,getSmtpPresets,type Channel} from './channels';

export default function ChannelEditor({channel,onChange}:{channel:Channel;onChange:(channel:Channel)=>void}){
 const {language,t}=useI18n();

 const smtpPresets=getSmtpPresets(t);
 const channelLabels=getChannelLabels(t);
 const config=(key:string,value:string)=>onChange({...channel,config:{...channel.config,[key]:value}});
 const help=channelHelp(channel.type,t);
 const preset=smtpPresets.find(p=>p.host===channel.config.host&&channel.config.port==='465'&&channel.config.tls==='tls')?.value??'custom';
 return <ConfigProvider getPopupContainer={node=>node?.parentElement??document.body}><Form layout="vertical">
  <Form.Item label={t("名称","Name")} required><Input aria-label={t("通知渠道名称","Notification channel name")} value={channel.name} onChange={e=>onChange({...channel,name:e.target.value})}/></Form.Item>
  <Form.Item label={t("类型","Type")}><Select aria-label={t("通知渠道类型","Notification channel type")} virtual={false} value={channel.type} disabled={!!channel.id} options={Object.entries(channelLabels).map(([value,label])=>({label,value}))} onChange={type=>onChange({...channel,type,config:channelDefaults(type)})}/></Form.Item>
  <Form.Item label={t("渠道状态","Channel status")}><Switch checked={channel.enabled} onChange={enabled=>onChange({...channel,enabled})} checkedChildren={t("启用","Enable")} unCheckedChildren={t("禁用","Disable")}/></Form.Item>
  {help&&<Alert type="info" showIcon title={help}/>}
  {channel.type==='smtp'&&<Form.Item label={t("邮箱配置预设","Email preset")}><Select aria-label={t("邮箱配置预设","Email preset")} value={preset} options={[{label:t("自定义 SMTP","Custom SMTP"),value:'custom'},...smtpPresets.map(({value,label})=>({value,label}))]} onChange={value=>onChange({...channel,config:{...channel.config,...smtpPresetConfig(value)}})}/></Form.Item>}
  {channelFields(channel.type,t).map(field=>{
   const label=field.label+(field.secret&&channel.has_secret?t("（留空保留已配置值）"," (leave blank to keep the saved value)"):'');
   return <Form.Item key={field.key} label={label} required={field.required}>
    {field.options?<Select aria-label={field.label} value={channel.config[field.key]||undefined} options={field.options} onChange={value=>config(field.key,value)}/>:field.multiline?<Input.TextArea aria-label={field.label} value={channel.config[field.key]??''} rows={3} placeholder={field.placeholder} onChange={e=>config(field.key,e.target.value)}/>:<Input aria-label={field.label} value={channel.config[field.key]??''} type={field.password?'password':'text'} autoComplete={field.password?'new-password':'off'} placeholder={field.placeholder} onChange={e=>config(field.key,e.target.value)}/>}
   </Form.Item>;
  })}
  {phoneChannels.includes(channel.type)&&<Typography.Paragraph type="secondary">{t("模板变量支持","Supported template variables: ")}{'{{rule}}'}{t("（告警名称）、"," (alert name), ")}{'{{status}}'}{t("（事件类型）、"," (event type), ")}{'{{value}}'}{t("（数值）、"," (value), ")}{'{{message}}'}{t("（告警详情）。无变量的模板填写空对象或空数组。供应商受理后可在发送记录查看流水号。"," (alert details). Use an empty object or array for templates without variables. Provider references appear in delivery history after acceptance.")}</Typography.Paragraph>}
 </Form></ConfigProvider>;
}
