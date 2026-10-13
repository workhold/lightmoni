export type Recipient={kind:string;value:string;mentions?:string[]};
export type Channel={revision?:number;id:string;name:string;type:string;enabled:boolean;config:Record<string,string>;has_secret:boolean};

export const channelLabels:Record<string,string>={
 webhook:'Webhook',feishu:'飞书群机器人',feishu_app:'飞书企业应用机器人',dingtalk:'钉钉群机器人',wecom:'企业微信群机器人',pushplus:'公众号 / App 推送',
 smtp:'邮箱（SMTP）',aliyun_sms:'阿里云短信',tencent_sms:'腾讯云短信',huawei_sms:'华为云短信',
 aliyun_voice:'阿里云电话语音',tencent_voice:'腾讯云电话语音',
};
export const phoneChannels=['aliyun_sms','tencent_sms','huawei_sms','aliyun_voice','tencent_voice'];
export function defaultRecipient(type:string):Recipient{
	if(type==='feishu_app')return {kind:'feishu_user',value:''};
 const kind=type==='smtp'?'email':phoneChannels.includes(type)?'phone':type==='pushplus'?'self':'channel';
 return {kind,value:kind==='channel'?'bound':''};
}
export function recipientPlaceholder(type?:string){
 if(type==='smtp')return '收件邮箱，例如 ops@example.com';
 if(type==='aliyun_voice')return '接听手机号或带区号的固话';
 if(phoneChannels.includes(type??''))return '接收手机号，例如 13800000000';
 if(type==='pushplus')return '群组/好友令牌（自身可留空）';
 return '此渠道绑定的机器人群';
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
const accessKeys=[field('access_key_id','AccessKey ID',{required:true,secret:true}),field('access_key_secret','AccessKey Secret',{required:true,secret:true,password:true})];
const tencentKeys=[field('secret_id','SecretId',{required:true,secret:true}),field('secret_key','SecretKey',{required:true,secret:true,password:true}),field('sdk_app_id','应用 SDK AppID',{required:true}),field('region','地域',{placeholder:'ap-guangzhou'})];
const objectParams=field('template_params','模板变量（JSON 对象）',{multiline:true,placeholder:'例如 {"name":"{{rule}}","state":"{{status}}","value":"{{value}}"}'});
const arrayParams=field('template_params','模板变量（JSON 数组，按模板顺序）',{multiline:true,placeholder:'例如 ["{{rule}}","{{status}}","{{value}}"]'});
const playTimes=field('play_times','语音播放次数',{options:[1,2,3].map(n=>({label:`${n} 次`,value:String(n)}))});
export function channelFields(type:string):Field[]{
 let fields:Field[];
 switch(type){
  case 'feishu_app':fields=[field('app_id','App ID',{required:true}),field('app_secret','App Secret',{required:true,secret:true,password:true}),field('verification_token','Verification Token',{required:true,secret:true,password:true}),field('encrypt_key','Encrypt Key（可选）',{secret:true,password:true})];break;
  case 'smtp':fields=[field('host','SMTP 服务器',{required:true}),field('port','端口',{placeholder:'587'}),field('tls','连接加密',{options:[{label:'STARTTLS（通常为 587）',value:'starttls'},{label:'SSL / TLS（通常为 465）',value:'tls'},{label:'不加密',value:'none'}]}),field('username','登录邮箱 / 用户名'),field('password','客户端授权码 / 密码',{secret:true,password:true}),field('from','发件邮箱',{required:true,placeholder:'例如 alerts@example.com'})];break;
  case 'aliyun_sms':fields=[...accessKeys,field('sign_name','已审核的短信签名',{required:true}),field('template_code','短信模板 Code',{required:true,placeholder:'SMS_…'}),objectParams];break;
  case 'aliyun_voice':fields=[...accessKeys,field('template_code','语音模板 Code',{required:true,placeholder:'TTS_…'}),field('called_show_number','专属外呼号码 / 服务实例 ID',{placeholder:'公共模式留空'}),field('receipt_prod_id','通话查询产品',{options:[{value:'11010000138001',label:'语音验证码（TTS，默认）'},{value:'11000000300006',label:'语音通知'}]}),objectParams,playTimes];break;
  case 'tencent_sms':fields=[...tencentKeys,field('sign_name','已审核的短信签名',{required:true}),field('template_id','短信模板 ID',{required:true}),arrayParams];break;
  case 'tencent_voice':fields=[...tencentKeys,field('template_id','语音模板 ID',{required:true}),arrayParams,playTimes];break;
  case 'huawei_sms':fields=[field('app_key','Application Key',{required:true,secret:true}),field('app_secret','Application Secret',{required:true,secret:true,password:true}),field('endpoint','应用接入地址',{required:true,placeholder:'从华为云短信应用管理中复制'}),field('sender','短信签名通道号',{required:true}),field('template_id','短信模板 ID',{required:true}),field('signature','签名名称（通用模板时填写）'),arrayParams];break;
  case 'pushplus':fields=[field('token','用户 Token',{required:true,secret:true,password:true}),field('access_key','回执查询 Access Key',{secret:true,password:true}),field('push_channel','推送方式',{options:[{label:'微信公众号',value:'wechat'},{label:'App',value:'app'}]})];break;
  default:fields=[field('url','Webhook 地址',{required:true,secret:true}),...(type==='wecom'?[]:[field('secret','签名密钥（可选）',{secret:true,password:true})]),...(type==='webhook'?[field('headers','自定义请求头（JSON 对象）',{secret:true,multiline:true})]:[])];
 }
 return [...fields,field('rate_per_minute','每分钟发送上限（可选）',{placeholder:'留空使用系统默认值'})];
}
export const smtpPresets=[
 {value:'qq',label:'QQ 邮箱',host:'smtp.qq.com'},
 {value:'163',label:'网易 163 邮箱',host:'smtp.163.com'},
 {value:'126',label:'网易 126 邮箱',host:'smtp.126.com'},
 {value:'exmail',label:'腾讯企业邮箱',host:'smtp.exmail.qq.com'},
 {value:'aliyun',label:'阿里企业邮箱',host:'smtp.qiye.aliyun.com'},
];
export function smtpPresetConfig(value:string):Record<string,string>{
 const preset=smtpPresets.find(p=>p.value===value);
 return preset?{host:preset.host,port:'465',tls:'tls'}:{host:'',port:'587',tls:'starttls'};
}
export function channelHelp(type:string){
 if(type==='feishu_app')return '启用应用机器人并配置卡片回调。保存后复制回调地址到飞书开放平台，成员填写此应用对应的 open_id，点击卡片即可接手。';
 if(type==='smtp')return '先在邮箱中开启 SMTP，并填写客户端授权码。预设会自动填入服务器、端口和加密方式，也可以手动配置其他邮箱。';
 if(type==='aliyun_voice')return '使用已审核的语音通知模板。公共模式无需外呼号码；专属模式填写号码或服务实例 ID，须与模板模式一致。';
 if(type==='tencent_voice')return '使用语音应用的 SDK AppID 和已审核的通知模板。国内 11 位手机号会自动补齐 +86。';
 if(type==='huawei_sms')return '应用接入地址、Application Key 和 Secret 从短信应用管理获取；通道号使用已审核签名对应的通道。';
 if(type.endsWith('_sms'))return '短信模板需包含接手链接变量，填写 {{ack_url}}。其他变量支持 {{priority}}、{{rule}}、{{status}}、{{value}}；变量名称与顺序需对应已审核模板。';
 return '';
}
