import type {AssistantContext} from '../features/assistant/types';

// Keep the snapshot under the assistant endpoint's 32 KB limit, including
// multibyte log text and unsaved SQL. Signal any reduction to the model.
export function boundedMonitoringContext(context:AssistantContext):AssistantContext {
 let result=JSON.parse(JSON.stringify(context)) as AssistantContext;
 const bytes=()=>new TextEncoder().encode(JSON.stringify(result)).byteLength;
 function shrink(value:unknown):unknown {
  if(typeof value==='string')return value.length>128?value.slice(0,Math.ceil(value.length/2)):value;
  if(Array.isArray(value))return value.slice(0,Math.max(1,Math.ceil(value.length/2))).map(shrink);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,shrink(item)]));
  return value;
 }
 while(bytes()>28000){const before=bytes();result={...(shrink(result) as AssistantContext),context_truncated:true};if(bytes()>=before){result={page:result.page,range:result.range,dashboard_id:result.dashboard_id,table:result.table,context_truncated:true};break;}}
 return result;
}
