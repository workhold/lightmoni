export interface LogCondition { field: string; operator: 'in' | 'exists'; values?: (string | boolean | number | bigint)[] }
export interface LogExcludeRule { name: string; conditions: LogCondition[] }
export interface LogRule extends LogExcludeRule { rate: number }
export interface LogSamplingPolicy { key?: string; rules: LogRule[]; exclude?: LogExcludeRule[] }
export interface SDKConfig { revision: string; log_sampling: Record<string, LogSamplingPolicy>; disable_rules?: LogExcludeRule[] }
export interface SamplingRecord { record: Record<string, unknown>; attributes: Record<string, unknown>; resource: Record<string, unknown> }
const encoder = new TextEncoder();
const fieldValid = (field: unknown): field is string => typeof field === 'string' && encoder.encode(field).length <= 136 && !field.includes('\0') && (/^(event_id|service|severity|trace_id|instance_id|sdk.language)$/.test(field) || /^(attr|resource):.+$/.test(field));
const scalar = (v: unknown) => ['string', 'boolean', 'bigint'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
function decimal(v: number): string {
 const text=String(v); if(!text.includes('e'))return text;
 const [mantissa,exponent]=text.split('e'),negative=mantissa.startsWith('-'),digits=mantissa.replace('-','').replace('.','');
 const point=(mantissa.replace('-','').split('.')[0].length)+Number(exponent);
 return (negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
}
function token(v: unknown): string { return typeof v==='string'?`s:${v}`:typeof v==='boolean'?`b:${v}`:typeof v==='number'?`n:${decimal(v)}`:`n:${v}`; }
function checkKeys(object: object, keys: string[]) { if(Object.keys(object).some(key=>!keys.includes(key)))throw new Error('unknown reporting rule field'); }
export function copyExclusions(rules: LogExcludeRule[], sdk=false): LogExcludeRule[] {
 if(!Array.isArray(rules)||rules.length>32)throw new Error('at most 32 exclusion rules');
 return rules.map(rule=>{ if(!rule||typeof rule.name!=='string'||encoder.encode(rule.name).length>64||!Array.isArray(rule.conditions)||rule.conditions.length===0)throw new Error('exclusion requires a name and condition');checkKeys(rule,['name','conditions']);return {name:rule.name,conditions:copyConditions(rule.conditions,sdk)}; });
}
function copyConditions(conditions: LogCondition[],sdk=false):LogCondition[] {
 if(!Array.isArray(conditions)||conditions.length>8)throw new Error('at most 8 conditions per rule');
 return conditions.map(c=>{if(!c||!fieldValid(c.field)||!['in','exists'].includes(c.operator)||!Array.isArray(c.values??[]))throw new Error('invalid condition');checkKeys(c,['field','operator','values']);
  if(sdk&&!['service','instance_id','sdk.language'].includes(c.field)&&!c.field.startsWith('resource:'))throw new Error('invalid SDK selector');
  const values=c.values??[];
  if(c.operator==='exists'?values.length!==0:values.length===0||values.length>256||values.some(v=>!scalar(v)))throw new Error('invalid condition values');
  return {field:c.field,operator:c.operator,values:[...values]};
 });
}
export function copyLogSampling(p: LogSamplingPolicy):LogSamplingPolicy {
 if(!p||!fieldValid(p.key??'event_id')||!Array.isArray(p.rules)||p.rules.length>32)throw new Error('log policy requires rules');checkKeys(p,['key','rules','exclude']);
 const rules=p.rules.map(r=>{if(!r||typeof r.name!=='string'||encoder.encode(r.name).length>64||!Number.isFinite(r.rate)||r.rate<0||r.rate>1||r.rate>0&&r.rate<0.000001)throw new Error('invalid log rule rate/name');checkKeys(r,['name','conditions','rate']);return {name:r.name,rate:r.rate,conditions:copyConditions(r.conditions)};});
 const policy={key:p.key??'event_id',rules,exclude:copyExclusions(p.exclude??[])};
 if(encoder.encode(JSON.stringify(policy,(_k,v)=>typeof v==='bigint'?String(v):v)).length>64*1024)throw new Error('log policy exceeds 64 KiB');return policy;
}
function value(log:SamplingRecord,field:string):unknown {
 const data=field.startsWith('attr:')?log.attributes:field.startsWith('resource:')?log.resource:log.record;
 const key=field.startsWith('attr:')?field.slice(5):field.startsWith('resource:')?field.slice(9):field;
 return Object.hasOwn(data,key)?data[key]:undefined;
}
export function matches(conditions:LogCondition[],log:SamplingRecord):boolean {
 return conditions.every(c=>{const v=value(log,c.field);return v!==undefined&&v!==null&&(c.operator==='exists'||scalar(v)&&c.values?.some(expected=>token(v)===token(expected)));});
}
export function sampleLog(p:LogSamplingPolicy,table:string,log:SamplingRecord):{keep:boolean;rate:number;reason:string} {
 if(p.exclude?.some(r=>matches(r.conditions,log)))return {keep:false,rate:0,reason:'excluded'};
 let rate=-1,reason='unmatched';for(const rule of p.rules)if(matches(rule.conditions,log)&&rule.rate>rate){rate=rule.rate;reason=rule.name||'matched';}
 if(rate<=0)return {keep:false,rate:0,reason};
 let field=p.key??'event_id',key=value(log,field);if(key===undefined||key===null||key===''||!scalar(key)){field='event_id';key=log.record.event_id;}
 let hash=2166136261;for(const byte of encoder.encode(`lightmoni-log-rules\0${table}\0${field}\0${token(key)}`))hash=Math.imul(hash^byte,16777619)>>>0;
 hash^=hash>>>16;hash=Math.imul(hash,0x85ebca6b);hash^=hash>>>13;hash=Math.imul(hash,0xc2b2ae35);hash=(hash^(hash>>>16))>>>0;
 return {keep:hash/2**32<rate,rate,reason};
}
