import type {Translator} from '../../shared/i18n';
import {chinese} from './translation.ts';
import type {Channel} from './channels';
export type Responder={id:string;name:string;active:boolean;has_email:boolean;has_phone:boolean;has_feishu:boolean};
export type Shift={primary:string[];backup:string[]};
export type Override=Shift&{id:string;from:string;until:string};
export type Schedule={mode:string;timezone:string;anchor:string;interval_days:number;shifts:Shift[];overrides:Override[]};
export type PriorityPolicy={methods:string[];start:string;end:string;weekdays:number[];night_mode?:'silent'|'immediate'|'after_count';night_methods?:string[];night_after_count?:number;repeat_seconds:number;backup_after_seconds:number;fallback_after_seconds:number;escalate_after_rounds:number;escalate_to:string;max_rounds:number;handling_seconds:number};
export type ResponseGroup={id:string;revision?:number;name:string;enabled:boolean;targets:{channel_id:string;recipient:{kind:string;value:string}}[];members:string[];primary:string[];backup:string[];fallback:string[];timezone:string;channel_ids:string[];schedule:Schedule;policies:Record<string,PriorityPolicy>};
export type EvidenceProfile={log_table_id:string;trace_table_ids:string[];label_mappings:Record<string,string>;lookback_seconds:number};
export type Evidence={status:string;captured_at:string;from:string;to:string;log_table_id:string;logs:Record<string,unknown>[];trace_ids:string[];trace_table_ids:string[];truncated:boolean;error?:string};
export type Incident={id:string;group_id:string;group_name:string;rule_id:string;state:string;priority:string;original_priority:string;stage:string;owner_id:string;owner_name:string;ack_method:string;ack_at:string;created_at:string;resolved_at:string;handling_until:string;round:number;active_seconds:number;level_active_seconds:number;since_round_seconds:number;exhausted:boolean;deferred_reason:string;group:ResponseGroup;event:{rule_name:string;message:string;range:{from:string;to:string};state:{labels:Record<string,string>;value:string}};evidence:Evidence};
export type Silence={id:string;scope:string;group_id?:string;rule_id?:string;response_id?:string;service?:string;from:string;until:string;daily_start?:string;daily_end?:string;weekdays?:number[];timezone:string;reason:string;created_by?:string;priorities?:string[]};
export const priorities=['P0','P1','P2','P3'];
export const getPriorityNames=(t:Translator=chinese):Record<string,string>=>({P0:t("紧急","Critical"),P1:t("高","High"),P2:t("中","Medium"),P3:t("低","Low")});
export const priorityNames=getPriorityNames();
export const priorityColors:Record<string,string>={P0:'red',P1:'orange',P2:'blue',P3:'default'};
export const rulePriority=(value?:string)=>priorities.includes(value??'')?value!:value==='critical'?'P0':'P2';
export const groupHasNotificationTargets=(group:{members?:string[];channel_ids?:string[];targets?:unknown[]})=>!!(group.members?.length&&group.channel_ids?.length||group.targets?.length);
export const getResponseStates=(t:Translator=chinese):Record<string,string>=>({unclaimed:t("待接手","Unclaimed"),acknowledged:t("处理中","In progress"),resolved:t("已恢复","Resolved"),cancelled:t("配置变更已取消","Cancelled by configuration change")});
export const responseStates=getResponseStates();
export const getStages=(t:Translator=chinese):Record<string,string>=>({primary:t("主班","Primary"),backup:t("备班","Backup"),fallback:t("兜底","Fallback")});
export const stages=getStages();
export const getAckMethods=(t:Translator=chinese):Record<string,string>=>({web:t("告警页","Alert page"),chat_link:t("机器人跳转","Bot link"),feishu_link:t("飞书跳转","Feishu link"),dingtalk_link:t("钉钉跳转","DingTalk link"),wecom_link:t("企业微信跳转","WeCom link"),sms_link:t("短信链接","SMS link"),email_link:t("邮件链接","Email link"),webhook_link:t("Webhook链接","Webhook link"),push_link:t("推送链接","Push link"),feishu_card:t("飞书卡片","Feishu card"),phone_answered:t("电话接听","Phone answered")});
export const ackMethods=getAckMethods();
export const getMethods=(t:Translator=chinese)=>([{value:'voice',label:t("电话","Voice call")},{value:'sms',label:t("短信","SMS")},{value:'email',label:t("邮箱","Email")},{value:'chat',label:t("飞书 / 钉钉 / 企业微信","Feishu / DingTalk / WeCom")},{value:'webhook',label:'Webhook'},{value:'push',label:t("公众号 / App","Official account / app")}]);
export const methods=getMethods();
export const getWeekdays=(t:Translator=chinese)=>([{value:1,label:t("周一","Mon")},{value:2,label:t("周二","Tue")},{value:3,label:t("周三","Wed")},{value:4,label:t("周四","Thu")},{value:5,label:t("周五","Fri")},{value:6,label:t("周六","Sat")},{value:0,label:t("周日","Sun")}]);
export const weekdays=getWeekdays();
export const displayTime=(s?:string)=>s?new Date(s).toLocaleString():'—';
export const secondsText=(s:number,t:Translator=chinese)=>s>=3600?t(`${(s/3600).toFixed(1)}小时`,`${(s/3600).toFixed(1)} hours`):s>=60?t(`${(s/60).toFixed(1)}分钟`,`${(s/60).toFixed(1)} minutes`):t(`${s.toFixed(0)}秒`,`${s.toFixed(0)} seconds`);
export const groupDefaults=(policies:Record<string,PriorityPolicy>):ResponseGroup=>({id:'',name:'',enabled:true,targets:[],members:[],primary:[],backup:[],fallback:[],timezone:'Asia/Shanghai',channel_ids:[],schedule:{mode:'fixed',timezone:'Asia/Shanghai',anchor:new Date().toISOString(),interval_days:1,shifts:[],overrides:[]},policies:structuredClone(policies)});
// Go's empty slices can be serialized as null, including on partially configured groups.
export function normalizeResponseGroup(group:Partial<ResponseGroup>|undefined,policies:Record<string,PriorityPolicy>):ResponseGroup {
 const defaults=groupDefaults(policies),schedule={...defaults.schedule,...group?.schedule};
 const shifts=(schedule.shifts??[]).map(s=>({...s,primary:s.primary??[],backup:s.backup??[]}));
 const overrides=(schedule.overrides??[]).map(s=>({...s,primary:s.primary??[],backup:s.backup??[]}));
 const normalizedPolicies=Object.fromEntries(Object.entries({...policies,...group?.policies}).map(([key,p])=>[key,{...policies[key],...p,night_mode:(group?group.policies?.[key]?.night_mode:p?.night_mode)??'silent',night_after_count:p?.night_after_count??0,night_methods:[...(p?.night_methods??[])],methods:[...(p?.methods??policies[key]?.methods??[])],weekdays:[...(p?.weekdays??policies[key]?.weekdays??[])]}])) as Record<string,PriorityPolicy>;
 return {...defaults,...group,members:group?.members??[],primary:group?.primary??[],backup:group?.backup??[],fallback:group?.fallback??[],channel_ids:group?.channel_ids??[],targets:group?.targets??[],timezone:group?.timezone||defaults.timezone,
  schedule:{...schedule,mode:schedule.mode||'fixed',timezone:schedule.timezone||group?.timezone||defaults.timezone,anchor:schedule.anchor&&!Number.isNaN(Date.parse(schedule.anchor))?schedule.anchor:defaults.schedule.anchor,interval_days:schedule.interval_days||1,shifts,overrides},policies:normalizedPolicies};
}
export const traceURL=(e:Evidence,id:string)=>'/traces/'+encodeURIComponent(id)+'?'+new URLSearchParams({tables:(e.trace_table_ids??[]).join(','),log_table:e.log_table_id,from:e.from,to:e.to});
export type ChannelsProps={channels:Channel[]};
