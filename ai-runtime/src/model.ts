import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { reportedUsage, type Input } from './protocol.js';
export type Protocol = 'openai-chat-completions'|'openai-responses'|'anthropic-messages'|'google-generative-ai';
export function protocolOf(value?:string):Protocol {
 const protocol=value||'openai-chat-completions';
 if(!['openai-chat-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(protocol))throw Error('invalid_protocol');
 return protocol as Protocol;
}
export function createModel(config:Pick<Input['config'],'base_url'|'api_key'|'model'|'protocol'>,customFetch:typeof fetch=async(request,init)=>fetch(request,{...init,redirect:'error'})) {
 const options={baseURL:config.base_url,apiKey:config.api_key||'lightmoni-no-key',fetch:customFetch};
 switch(protocolOf(config.protocol)) {
 case 'openai-chat-completions': return createOpenAICompatible({...options,name:'lightmoni'}).chatModel(config.model);
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
