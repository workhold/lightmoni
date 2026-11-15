import {Tag} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';

const labels:Record<string,[string,string]>={queued:['排队中','Queued'],leased:['已领取','Leased'],pending:['待处理','Pending'],unverified:['待核实','Unverified'],accepted:['已接受','Accepted'],running:['运行中','Running'],deploying:['部署中','Deploying'],issuing:['申请中','Applying'],verifying:['核验中','Verifying'],staging:['准备中','Staging'],activating:['激活中','Activating'],awaiting_approval:['待审阅','Awaiting review'],succeeded:['成功','Succeeded'],success:['成功','Success'],ready:['就绪','Ready'],issued:['已签发','Issued'],active:['已上线','Active'],applied:['已应用','Applied'],registered:['已注册','Registered'],verified:['已验证','Verified'],synced:['已同步','Synced'],observed:['已同步','Observed'],configured:['已保存','Saved'],failed:['失败','Failed'],error:['错误','Error'],degraded:['部分失败','Degraded'],unknown:['结果未知','Unknown'],warning:['需要关注','Needs attention'],cancelled:['已取消','Cancelled'],stopped:['已停止','Stopped'],disabled:['已停用','Disabled']};
const success=new Set(['succeeded','success','ready','issued','active','applied','registered','verified','synced','observed']);
const active=new Set(['queued','leased','pending','accepted','running','deploying','issuing','verifying','staging','activating']);
export default function OperationStatus({state}:{state:string}){
 const {t}=useI18n();
 const color=success.has(state)?'success':['failed','error','degraded'].includes(state)?'error':['unknown','unverified','warning'].includes(state)?'warning':active.has(state)?'processing':undefined;
 return <Tag color={color} className={'lm-ops-state lm-ops-state-'+(color??'default')}>{labels[state]?t(...labels[state]):state||'—'}</Tag>;
}
export function LogLevel({value}:{value?:string}){
 const {t}=useI18n(),level=(value??'').toLowerCase();
 const names:Record<string,[string,string]>={error:['错误','Error'],fatal:['严重','Fatal'],warn:['警告','Warning'],warning:['警告','Warning'],info:['信息','Info'],debug:['调试','Debug'],trace:['追踪','Trace']};
 return <Tag color={['error','fatal'].includes(level)?'error':['warn','warning'].includes(level)?'warning':undefined}>{names[level]?t(...names[level]):value||'—'}</Tag>;
}
