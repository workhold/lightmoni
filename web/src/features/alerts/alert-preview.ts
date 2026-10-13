import type {AlertRule} from './types';
import {rulePriority} from './response-model';

export type PreviewState={rule_id?:string;fingerprint?:string;labels:Record<string,string>;status:string;health:string;value:string;error?:string};
export type PreviewRoute={group_ids:string[];target?:{channel_id:string;recipient:{kind:string;value:string}}};
export type AlertPreviewData={rule_name:string;severity:string;range?:{from:string;to:string};states:PreviewState[];routes:PreviewRoute[];warnings:string[]};
export function normalizeAlertPreview(value:Partial<AlertPreviewData>,rule:Pick<AlertRule,'name'|'severity'>):AlertPreviewData {
 return {rule_name:rule.name,severity:rulePriority(rule.severity),range:value.range,
  states:(value.states??[]).map(s=>({...s,labels:s.labels??{}})),routes:(value.routes??[]).map(r=>({...r,group_ids:r.group_ids??[]})),warnings:value.warnings??[]};
}
