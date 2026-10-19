import type {Translator} from '../../shared/i18n';
import {chinese} from './translation.ts';
export type Recipient={kind:string;value:string;mentions?:string[]};
export type Channel={revision?:number;id:string;name:string;type:string;enabled:boolean;config:Record<string,string>;has_secret:boolean};

export const getChannelLabels=(t:Translator=chinese):Record<string,string>=>({
 webhook:'Webhook',feishu:t("飞书群机器人","Feishu group bot"),feishu_app:t("飞书企业应用机器人","Feishu enterprise app bot"),dingtalk:t("钉钉群机器人","DingTalk group bot"),wecom:t("企业微信群机器人","WeCom group bot"),pushplus:t("公众号 / App 推送","Official account / app push"),
 smtp:t("邮箱（SMTP）","Email (SMTP)"),aliyun_sms:t("阿里云短信","Alibaba Cloud SMS"),tencent_sms:t("腾讯云短信","Tencent Cloud SMS"),huawei_sms:t("华为云短信","Huawei Cloud SMS"),
 aliyun_voice:t("阿里云电话语音","Alibaba Cloud voice call"),tencent_voice:t("腾讯云电话语音","Tencent Cloud voice call"),
});
export const channelLabels=getChannelLabels();
export const phoneChannels=['aliyun_sms','tencent_sms','huawei_sms','aliyun_voice','tencent_voice'];
export function defaultRecipient(type:string):Recipient{
	if(type==='feishu_app')return {kind:'feishu_user',value:''};
 const kind=type==='smtp'?'email':phoneChannels.includes(type)?'phone':type==='pushplus'?'self':'channel';
 return {kind,value:kind==='channel'?'bound':''};
}
export function recipientPlaceholder(type?:string,t:Translator=chinese){
 if(type==='smtp')return t("收件邮箱，例如 ops@example.com","Recipient email, e.g. ops@example.com");
 if(type==='aliyun_voice')return t("接听手机号或带区号的固话","Mobile or landline number including area code");
 if(phoneChannels.includes(type??''))return t("接收手机号，例如 13800000000","Recipient phone number, e.g. 13800000000");
 if(type==='pushplus')return t("群组/好友令牌（自身可留空）","Group / friend token (blank for own account)");
 return t("此渠道绑定的机器人群","Bot group linked to this channel");
}
export function channelDefaults(type:string):Record<string,string>{
 if(type==='smtp')return {tls:'starttls',port:'587'};
 if(type==='pushplus')return {push_channel:'wechat'};
 if(type==='aliyun_sms'||type==='aliyun_voice')return {template_params:'{}',...(type==='aliyun_voice'?{play_times:'2'}:{})};
 if(type==='tencent_sms'||type==='tencent_voice')return {region:'ap-guangzhou',template_params:'[]',...(type==='tencent_voice'?{play_times:'2'}:{})};
 if(type==='huawei_sms')return {template_params:'[]'};
 return {};
}

type Field={key:string;label:string;required?:boolean;secret?:boolean;password?:boolean;placeholder?:string;multiline?:boolean;options?:{label:string;value:string}[]};
const field=(key:string,label:string,extra:Omit<Field,'key'|'label'>={}):Field=>({key,label,...extra});
export function channelFields(type:string,t:Translator=chinese):Field[]{
const accessKeys=[field('access_key_id','AccessKey ID',{required:true,secret:true}),field('access_key_secret','AccessKey Secret',{required:true,secret:true,password:true})];
const tencentKeys=[field('secret_id','SecretId',{required:true,secret:true}),field('secret_key','SecretKey',{required:true,secret:true,password:true}),field('sdk_app_id',t("应用 SDK AppID","Application SDK AppID"),{required:true}),field('region',t("地域","Region"),{placeholder:'ap-guangzhou'})];
const objectParams=field('template_params',t("模板变量（JSON 对象）","Template variables (JSON object)"),{multiline:true,placeholder:t("例如 {\"name\":\"{{rule}}\",\"state\":\"{{status}}\",\"value\":\"{{value}}\"}","E.g. {\"name\":\"{{rule}}\",\"state\":\"{{status}}\",\"value\":\"{{value}}\"}")});
const arrayParams=field('template_params',t("模板变量（JSON 数组，按模板顺序）","Template variables (JSON array in template order)"),{multiline:true,placeholder:t("例如 [\"{{rule}}\",\"{{status}}\",\"{{value}}\"]","E.g. [\"{{rule}}\",\"{{status}}\",\"{{value}}\"]")});
const playTimes=field('play_times',t("语音播放次数","Voice playback count"),{options:[1,2,3].map(n=>({label:t(`${n} 次`,`${n} times`),value:String(n)}))});

 let fields:Field[];
 switch(type){
  case 'feishu_app':fields=[field('app_id','App ID',{required:true}),field('app_secret','App Secret',{required:true,secret:true,password:true}),field('verification_token','Verification Token',{required:true,secret:true,password:true}),field('encrypt_key',t("Encrypt Key（可选）","Encrypt Key (optional)"),{secret:true,password:true})];break;
  case 'smtp':fields=[field('host',t("SMTP 服务器","SMTP server"),{required:true}),field('port',t("端口","Port"),{placeholder:'587'}),field('tls',t("连接加密","Connection encryption"),{options:[{label:t("STARTTLS（通常为 587）","STARTTLS (usually port 587)"),value:'starttls'},{label:t("SSL / TLS（通常为 465）","SSL / TLS (usually port 465)"),value:'tls'},{label:t("不加密","No encryption"),value:'none'}]}),field('username',t("登录邮箱 / 用户名","Login email / username")),field('password',t("客户端授权码 / 密码","App password / password"),{secret:true,password:true}),field('from',t("发件邮箱","Sender email"),{required:true,placeholder:t("例如 alerts@example.com","E.g. alerts@example.com")})];break;
  case 'aliyun_sms':fields=[...accessKeys,field('sign_name',t("已审核的短信签名","Approved SMS signature"),{required:true}),field('template_code',t("短信模板 Code","SMS template code"),{required:true,placeholder:'SMS_…'}),objectParams];break;
  case 'aliyun_voice':fields=[...accessKeys,field('template_code',t("语音模板 Code","Voice template code"),{required:true,placeholder:'TTS_…'}),field('called_show_number',t("专属外呼号码 / 服务实例 ID","Dedicated caller number / service instance ID"),{placeholder:t("公共模式留空","Leave blank for shared mode")}),field('receipt_prod_id',t("通话查询产品","Call query product"),{options:[{value:'11010000138001',label:t("语音验证码（TTS，默认）","Voice verification (TTS, default)")},{value:'11000000300006',label:t("语音通知","Voice notification")}]}),objectParams,playTimes];break;
  case 'tencent_sms':fields=[...tencentKeys,field('sign_name',t("已审核的短信签名","Approved SMS signature"),{required:true}),field('template_id',t("短信模板 ID","SMS template ID"),{required:true}),arrayParams];break;
  case 'tencent_voice':fields=[...tencentKeys,field('template_id',t("语音模板 ID","Voice template ID"),{required:true}),arrayParams,playTimes];break;
  case 'huawei_sms':fields=[field('app_key','Application Key',{required:true,secret:true}),field('app_secret','Application Secret',{required:true,secret:true,password:true}),field('endpoint',t("应用接入地址","Application endpoint"),{required:true,placeholder:t("从华为云短信应用管理中复制","Copy from Huawei Cloud SMS app management")}),field('sender',t("短信签名通道号","SMS signature channel number"),{required:true}),field('template_id',t("短信模板 ID","SMS template ID"),{required:true}),field('signature',t("签名名称（通用模板时填写）","Signature name (for generic templates)")),arrayParams];break;
  case 'pushplus':fields=[field('token',t("用户 Token","User token"),{required:true,secret:true,password:true}),field('access_key',t("回执查询 Access Key","Receipt query access key"),{secret:true,password:true}),field('push_channel',t("推送方式","Push method"),{options:[{label:t("微信公众号","WeChat official account"),value:'wechat'},{label:'App',value:'app'}]})];break;
  default:fields=[field('url',t("Webhook 地址","Webhook URL"),{required:true,secret:true}),...(type==='wecom'?[]:[field('secret',t("签名密钥（可选）","Signing secret (optional)"),{secret:true,password:true})]),...(type==='webhook'?[field('headers',t("自定义请求头（JSON 对象）","Custom headers (JSON object)"),{secret:true,multiline:true})]:[])];
 }
 return [...fields,field('rate_per_minute',t("每分钟发送上限（可选）","Maximum sends per minute (optional)"),{placeholder:t("留空使用系统默认值","Leave blank to use the system default")})];
}
export const getSmtpPresets=(t:Translator=chinese)=>([
 {value:'qq',label:t("QQ 邮箱","QQ Mail"),host:'smtp.qq.com'},
 {value:'163',label:t("网易 163 邮箱","NetEase 163 Mail"),host:'smtp.163.com'},
 {value:'126',label:t("网易 126 邮箱","NetEase 126 Mail"),host:'smtp.126.com'},
 {value:'exmail',label:t("腾讯企业邮箱","Tencent Enterprise Mail"),host:'smtp.exmail.qq.com'},
 {value:'aliyun',label:t("阿里企业邮箱","Alibaba Enterprise Mail"),host:'smtp.qiye.aliyun.com'},
]);
export const smtpPresets=getSmtpPresets();
export function smtpPresetConfig(value:string):Record<string,string>{
 const preset=smtpPresets.find(p=>p.value===value);
 return preset?{host:preset.host,port:'465',tls:'tls'}:{host:'',port:'587',tls:'starttls'};
}
export function channelHelp(type:string,t:Translator=chinese){
 if(type==='feishu_app')return t("启用应用机器人并配置卡片回调。保存后复制回调地址到飞书开放平台，成员填写此应用对应的 open_id，点击卡片即可接手。","Enable the app bot and configure card callbacks. After saving, copy the callback URL to the Feishu developer platform. Members enter their open_id for this app and can claim alerts from cards.");
 if(type==='smtp')return t("先在邮箱中开启 SMTP，并填写客户端授权码。预设会自动填入服务器、端口和加密方式，也可以手动配置其他邮箱。","Enable SMTP in your mailbox and enter an app password. Presets fill in the server, port and encryption; other providers can be configured manually.");
 if(type==='aliyun_voice')return t("使用已审核的语音通知模板。公共模式无需外呼号码；专属模式填写号码或服务实例 ID，须与模板模式一致。","Use an approved voice notification template. Shared mode needs no caller number; dedicated mode requires a number or service instance ID matching the template mode.");
 if(type==='tencent_voice')return t("使用语音应用的 SDK AppID 和已审核的通知模板。国内 11 位手机号会自动补齐 +86。","Use the voice application's SDK AppID and an approved notification template. Chinese 11-digit phone numbers receive the +86 prefix automatically.");
 if(type==='huawei_sms')return t("应用接入地址、Application Key 和 Secret 从短信应用管理获取；通道号使用已审核签名对应的通道。","Get the endpoint, Application Key and Secret from SMS app management. Use the channel associated with the approved signature.");
 if(type.endsWith('_sms'))return t("短信模板需包含接手链接变量，填写 {{ack_url}}。其他变量支持 {{priority}}、{{rule}}、{{status}}、{{value}}；变量名称与顺序需对应已审核模板。","Include {{ack_url}} for the claim link in the SMS template. Other variables are {{priority}}, {{rule}}, {{status}} and {{value}}. Names and order must match the approved template.");
 return '';
}
