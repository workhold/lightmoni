import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestLifecycle,createModel,type Protocol} from '../src/model.js';
const protocols:Protocol[]=['openai-chat-completions','openai-responses','anthropic-messages','google-generative-ai'];
function fixture(){
 const frames:{name:string;data:Record<string,unknown>}[]=[],abort=new AbortController();let phase:'compact'|'execute'='execute';
 const lifecycle=requestLifecycle('openai-chat-completions',{signal:abort.signal,phase:()=>phase,preflight:()=>abort.signal.throwIfAborted(),emit:(name,data)=>frames.push({name,data})});
 return {frames,abort,lifecycle,setPhase:(next:'compact'|'execute')=>phase=next};
}
function oneTerminal(frames:{name:string;data:Record<string,unknown>}[],status:string){assert.deepEqual(frames.map(f=>f.name),['model.request.started','turn.usage']);assert.equal(frames[0].data.request_id,'request-1');assert.equal(frames[1].data.request_id,'request-1');assert.equal(frames[1].data.status,status);}
for(const protocol of protocols)test(`${protocol} HTTP 401 has matching request start and failed terminal`,async()=>{
 const frames:any[]=[];const ac=new AbortController();
 const lifecycle=requestLifecycle(protocol,{signal:ac.signal,phase:()=> 'execute',preflight:()=>{},emit:(name,data)=>frames.push({name,data})});
 const model=lifecycle.wrap(createModel({protocol,base_url:'https://fixture.invalid/v1',api_key:'fixture',model:'fixture'},async()=>new Response('{"error":{"message":"fixture"}}',{status:401,headers:{'content-type':'application/json'}}),{onProviderRequest:lifecycle.providerRequest}));
 await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'test'}]}]}));oneTerminal(frames,'failed');
});
for(const mode of ['part-error','read-error','early-close','cancel','abort','unknown-finish'] as const)test(`stream ${mode} finalizes once`,async()=>{
 const {frames,abort,lifecycle}=fixture();
 const model=lifecycle.wrap({async doGenerate(){return {};},async doStream(){
  lifecycle.providerRequest();
  return {stream:new ReadableStream({start(c){if(mode==='part-error'){c.enqueue({type:'error',error:Error('fixture')});c.enqueue({type:'finish',finishReason:{unified:'stop'}});c.close();}if(mode==='read-error')c.error(Error('read fixture'));if(mode==='early-close')c.close();if(mode==='unknown-finish'){c.enqueue({type:'finish',finishReason:{unified:'unknown'}});c.close();}}})};
 }});
 const result=await model.doStream({});const reader=result.stream.getReader();
 if(mode==='cancel')await reader.cancel('fixture');else if(mode==='abort'){abort.abort();await reader.cancel('after abort');}else{try{while(!(await reader.read()).done){}}catch{}}
 oneTerminal(frames,mode==='cancel'||mode==='abort'?'cancelled':'failed');
});
test('missing usage is unknown, successful length remains provider success, request IDs span phases',async()=>{
 const {frames,lifecycle,setPhase}=fixture();
 const model=lifecycle.wrap({async doGenerate(){lifecycle.providerRequest();return {finishReason:{unified:'length'},usage:undefined};},async doStream(){lifecycle.providerRequest();return {stream:new ReadableStream({start(c){c.enqueue({type:'finish',finishReason:{unified:'length'},usage:undefined});c.close();}})};}});
 setPhase('compact');await model.doGenerate({});setPhase('execute');const response=await model.doStream({});for await(const _ of response.stream){}
 assert.deepEqual(frames,[{name:'model.request.started',data:{request_id:'request-1',phase:'compact'}},{name:'turn.usage',data:{request_id:'request-1',phase:'compact',status:'succeeded'}},{name:'model.request.started',data:{request_id:'request-2',phase:'execute'}},{name:'turn.usage',data:{request_id:'request-2',phase:'execute',status:'succeeded'}}]);
});
test('local preflight and native errors before transport never create provider requests',async()=>{
 const {frames,lifecycle,abort}=fixture();
 const native=lifecycle.wrap({async doGenerate(){throw Error('local serialization');},async doStream(){throw Error('local stream serialization');}});
 await assert.rejects(native.doGenerate({}));await assert.rejects(native.doStream({}));abort.abort();await assert.rejects(native.doGenerate({}));assert.deepEqual(frames,[]);
});
test('parallel invocations retain their IDs and phases through asynchronous SDK calls',async()=>{
 const {frames,lifecycle,setPhase}=fixture();let release!:()=>void;
 const native=lifecycle.wrap({async doGenerate(call:any){if(call.wait)await new Promise<void>(r=>release=r);lifecycle.providerRequest();return {};},async doStream(){throw Error('unused');}});
 setPhase('compact');const first=native.doGenerate({wait:true});setPhase('execute');await native.doGenerate({});release();await first;
 assert.deepEqual(frames.map(f=>[f.name,f.data.request_id,f.data.phase]),[['model.request.started','request-2','execute'],['turn.usage','request-2','execute'],['model.request.started','request-1','compact'],['turn.usage','request-1','compact']]);
});
for(const protocol of protocols)for(const mode of ['early-close','body-error'] as const)test(`${protocol} actual SDK ${mode} has one failed terminal`,async()=>{
 const frames:any[]=[];const ac=new AbortController();
 const lifecycle=requestLifecycle(protocol,{signal:ac.signal,phase:()=> 'execute',preflight:()=>{},emit:(name,data)=>frames.push({name,data})});
 const model=lifecycle.wrap(createModel({protocol,base_url:'https://fixture.invalid/v1',model:'fixture'},async()=>new Response(mode==='early-close'?'':new ReadableStream({start(c){c.error(Error('fixture network stream failure'));}}),{headers:{'content-type':'text/event-stream'}}),{onProviderRequest:lifecycle.providerRequest}));
 try{const result=await model.doStream({prompt:[{role:'user',content:[{type:'text',text:'test'}]}]});for await(const _ of result.stream){}}catch{}
 oneTerminal(frames,'failed');
});
test('a per-call SDK abort finalizes cancelled even when worker signal is still active',async()=>{
 const {frames,lifecycle}=fixture();const callAbort=new AbortController();
 const native=lifecycle.wrap({async doGenerate(){throw Error('unused');},async doStream(){lifecycle.providerRequest();return {stream:new ReadableStream()};}});
 const result=await native.doStream({abortSignal:callAbort.signal});callAbort.abort();await result.stream.cancel();oneTerminal(frames,'cancelled');
});
