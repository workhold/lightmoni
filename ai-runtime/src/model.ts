import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { reportedUsage, type Input } from './protocol.js';
import { AsyncLocalStorage } from 'node:async_hooks';
export type Protocol = 'openai-chat-completions'|'openai-responses'|'anthropic-messages'|'google-generative-ai';
export function protocolOf(value?:string):Protocol {
 const protocol=value||'openai-chat-completions';
 if(!['openai-chat-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(protocol))throw Error('invalid_protocol');
 return protocol as Protocol;
}
interface ModelOptions {
 connectionTest?: boolean;
 onProviderRequest?: () => void;
 onBudgetError?: () => void;
}

// SDKs may add a separate thinking budget to maxOutputTokens. Check the final
// serialized request, preserving the chosen reasoning mode instead of turning
// it off or silently requesting tens of thousands of test tokens.
function connectionTestBody(protocol:Protocol,body:string):string {
 const value=JSON.parse(body);
 const max=256;
 const positive=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0;
 switch(protocol){
 case 'anthropic-messages': {
  // Enabled thinking requires at least 1024 tokens in the Anthropic protocol,
  // so no enabled budget fits a 256-token test. Adaptive thinking shares the
  // capped total and remains enabled with its selected effort.
  if(value.thinking?.type==='enabled')throw Error('test_budget_exceeded');
  value.max_tokens=Math.min(positive(value.max_tokens)?value.max_tokens:max,max);
  break;
 }
 case 'google-generative-ai': {
  value.generationConfig??={};
  const budget=value.generationConfig.thinkingConfig?.thinkingBudget;
  if(positive(budget)&&budget>=max)throw Error('test_budget_exceeded');
  value.generationConfig.maxOutputTokens=Math.min(positive(value.generationConfig.maxOutputTokens)?value.generationConfig.maxOutputTokens:max,max);
  break;
 }
 case 'openai-responses':value.max_output_tokens=Math.min(positive(value.max_output_tokens)?value.max_output_tokens:max,max);break;
 default: {
  const field='max_completion_tokens' in value?'max_completion_tokens':'max_tokens';
  value[field]=Math.min(positive(value[field])?value[field]:max,max);
  if(field==='max_completion_tokens')delete value.max_tokens;
 }
 }
 return JSON.stringify(value);
}

export function createModel(config:Pick<Input['config'],'base_url'|'api_key'|'model'|'protocol'>,customFetch:typeof fetch=async(request,init)=>fetch(request,{...init,redirect:'error'}),hooks:ModelOptions={}) {
 const protocol=protocolOf(config.protocol);
 const providerFetch:typeof fetch=async(request,init)=>{
  let checked=init;
  if(hooks.connectionTest){
   try{
    if(typeof init?.body!=='string')throw Error('test_budget_exceeded');
    checked={...init,body:connectionTestBody(protocol,init.body)};
   }catch{hooks.onBudgetError?.();throw Error('test_budget_exceeded');}
  }
  hooks.onProviderRequest?.();
  return customFetch(request,checked);
 };
 const options={baseURL:config.base_url,apiKey:config.api_key||'lightmoni-no-key',fetch:providerFetch};
 switch(protocolOf(config.protocol)) {
 case 'openai-chat-completions': return createOpenAICompatible({...options,name:'lightmoni',includeUsage:true}).chatModel(config.model);
 case 'openai-responses': {
  const native=createOpenAI(options).responses(config.model);
  // Explicitly stateless; encrypted reasoning is requested by SDK for continuation.
  return new Proxy(native,{get(target,key,receiver){
   if(key==='doGenerate'||key==='doStream')return (call:any)=>target[key]({...call,providerOptions:{...call.providerOptions,openai:{...call.providerOptions?.openai,store:false,include:[...new Set([...(call.providerOptions?.openai?.include??[]),"reasoning.encrypted_content"])]}}});
   return Reflect.get(target,key,receiver);
  }});
 }
 case 'anthropic-messages':return createAnthropic(options)(config.model);
 case 'google-generative-ai':return createGoogleGenerativeAI(options)(config.model.replace(/^models\//,''));
 }
}
type RequestPhase='compact'|'execute';
type RequestStatus='succeeded'|'failed'|'cancelled';
interface ModelRequest {id:string;phase:RequestPhase;started:boolean;terminal:boolean;signals:AbortSignal[];abort?:()=>void}

// A start means the SDK reached its HTTP transport after local validation. The
// invocation context remains attached to the fetch even through SDK awaits.
export function requestLifecycle(protocol:Protocol,options:{signal:AbortSignal;phase:()=>RequestPhase;preflight:(call:any)=>void;emit:(name:string,data:Record<string,unknown>)=>void}) {
 const invocation=new AsyncLocalStorage<ModelRequest>();
 let serial=0;
 const complete=(record:ModelRequest,status:RequestStatus,usage?:unknown)=>{
  if(!record.started||record.terminal)return;
  record.terminal=true;
  if(record.abort)for(const signal of record.signals)signal.removeEventListener('abort',record.abort);
  options.emit('turn.usage',{request_id:record.id,phase:record.phase,status,...(rawUsage(protocol,usage)??{})});
 };
 const failed=(record:ModelRequest)=>complete(record,record.signals.some(signal=>signal.aborted)?'cancelled':'failed');
 return {
  providerRequest(){
   const record=invocation.getStore();
   if(!record||record.started)return;
   for(const signal of record.signals)signal.throwIfAborted();
   record.started=true;
   options.emit('model.request.started',{request_id:record.id,phase:record.phase});
   record.abort=()=>complete(record,'cancelled');
   for(const signal of record.signals)signal.addEventListener('abort',record.abort,{once:true});
  },
  wrap<T extends {doGenerate:(call:any)=>PromiseLike<any>;doStream:(call:any)=>PromiseLike<any>}>(native:T):T {
   return new Proxy(native,{get(target,key,receiver){
    if(key!=='doGenerate'&&key!=='doStream')return Reflect.get(target,key,receiver);
    return async(call:any)=>{
     options.preflight(call);
     const signals=[...new Set([options.signal,...(call.abortSignal?[call.abortSignal as AbortSignal]:[])])];
     const record:ModelRequest={id:`request-${++serial}`,phase:options.phase(),started:false,terminal:false,signals};
     return invocation.run(record,async()=>{
      try{
       if(key==='doGenerate'){
        const result=await target.doGenerate(call);
        complete(record,'succeeded',result.usage);
        return result;
       }
       const result=await target.doStream(call);
       const reader=result.stream.getReader();
       const stream=new ReadableStream({
        async pull(controller){
         try{
          const next=await reader.read();
          if(next.done){failed(record);controller.close();return;}
          const part=next.value;
          if(part.type==='error')failed(record);
          if(part.type==='finish'){
           const reason=part.finishReason;
           // Several SDKs synthesize an "other" finish on EOF even when the
           // provider never sent its terminating frame. That is an interrupted
           // request, not a successful response with zero/unknown token usage.
           const finished=reason&&reason.unified!=='error'&&(!['other','unknown'].includes(reason.unified)||reason.raw!=null);
           complete(record,finished?'succeeded':'failed',part.usage);
          }
          controller.enqueue(part);
         }catch(error){failed(record);controller.error(error);}
        },
        async cancel(reason){complete(record,'cancelled');await reader.cancel(reason);},
       });
       return {...result,stream};
      }catch(error){failed(record);throw error;}
     });
    };
   }});
  },
 };
}
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function additive(base:unknown,...optional:unknown[]) {
 if(!count(base)||optional.some(v=>v!==undefined&&v!==null&&!count(v)))return undefined;
 const result=base+optional.reduce<number>((sum,v)=>sum+(count(v)?v:0),0);
 return count(result)?result:undefined;
}
export function rawUsage(protocol:Protocol,usage:unknown) {
 const raw=(usage as {raw?:Record<string,unknown>}|undefined)?.raw;
 if(!raw)return;
 switch(protocol){
 case 'openai-chat-completions':return reportedUsage({inputTokens:raw.prompt_tokens,outputTokens:raw.completion_tokens,totalTokens:raw.total_tokens});
 case 'openai-responses':return reportedUsage({inputTokens:raw.input_tokens,outputTokens:raw.output_tokens,totalTokens:raw.total_tokens});
 case 'anthropic-messages':return reportedUsage({inputTokens:additive(raw.input_tokens,raw.cache_creation_input_tokens,raw.cache_read_input_tokens),outputTokens:raw.output_tokens});
 case 'google-generative-ai':return reportedUsage({inputTokens:raw.promptTokenCount,outputTokens:additive(raw.candidatesTokenCount,raw.thoughtsTokenCount),totalTokens:raw.totalTokenCount});
 }
}
// Persist only opaque continuation tokens. Never retain plaintext model reasoning.
export function continuationOptions(value:any) {
 const options=value?.providerOptions??value?.providerMetadata;
 if(!options||typeof options!=='object')return undefined;
 const result:Record<string,Record<string,string>>={};
 for(const [provider,keys] of [['google',['thoughtSignature']],['openai',['itemId','reasoningEncryptedContent']]] as const){
  const source=options[provider];if(!source)continue;
  const kept:Record<string,string>={};
  for(const key of keys)if(typeof source[key]==='string'){if(Buffer.byteLength(source[key],'utf8')>256*1024)throw Error('invalid_provider_state');kept[key]=source[key];}
  if(Object.keys(kept).length)result[provider]=kept;
 }
 return Object.keys(result).length?result:undefined;
}
