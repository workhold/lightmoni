import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel, rawUsage } from '../src/model.js';
for (const protocol of ['openai-chat-completions','openai-responses','anthropic-messages','google-generative-ai'] as const) {
 test(`${protocol} native request contract`, async()=>{
 let seen:any;
 const model=createModel({protocol,base_url:'http://localhost/tenant/v1',api_key:'fixture',model:'models/gemini-test'},async(url,init)=>{seen={url:String(url),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body)),signal:init?.signal}; return new Response('{"error":{"message":"private"}}',{status:401,headers:{'content-type':'application/json'}});});
 const ac=new AbortController();
 await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'hello'}]}],tools:[{type:'function',name:'list_tables',inputSchema:{type:'object',properties:{}}}],abortSignal:ac.signal}));
 const path=protocol==='openai-responses'?'/responses':protocol==='anthropic-messages'?'/messages':protocol==='google-generative-ai'?'/models/gemini-test:generateContent':'/chat/completions';
 assert.equal(seen.url,'http://localhost/tenant/v1'+path); assert.equal(seen.signal,ac.signal); assert.ok(seen.body.tools.length);
 assert.equal(seen.headers.get(protocol==='anthropic-messages'?'x-api-key':protocol==='google-generative-ai'?'x-goog-api-key':'authorization'),protocol.startsWith('openai')?'Bearer fixture':'fixture');
 if(protocol==='openai-responses'){assert.equal(seen.body.store,false);assert.ok(seen.body.include.includes('reasoning.encrypted_content'));}
 });
}
test('legacy and unknown protocol',()=>{assert.ok(createModel({base_url:'http://localhost/v1',model:'test'}));assert.throws(()=>createModel({protocol:'auto' as any,base_url:'http://localhost/v1',model:'test'}),/invalid_protocol/);});
test('OpenAI-compatible streaming requests and reports provider token usage',async()=>{
 let requestBody:any;
 const model=createModel({protocol:'openai-chat-completions',base_url:'http://localhost/v1',api_key:'fixture',model:'fixture'},async(_url,init)=>{
  requestBody=JSON.parse(String(init?.body));
  const chunks:any[]=[{id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:'OK'},finish_reason:null}]},{id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
  // OpenAI-compatible servers normally omit streaming usage unless requested.
  if(requestBody.stream_options?.include_usage===true)chunks.push({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});
  return new Response(chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 });
 const result=await model.doStream({prompt:[{role:'user',content:[{type:'text',text:'hello'}]}]});
 const reader=result.stream.getReader();let usage;
 while(true){const {value,done}=await reader.read();if(done)break;if(value.type==='finish')usage=rawUsage('openai-chat-completions',value.usage);}
 assert.equal(requestBody.stream,true);
 assert.equal(requestBody.stream_options?.include_usage,true);
 assert.deepEqual(usage,{input_tokens:10,output_tokens:3,total_tokens:13});
});
test('native raw usage retains absence and additive counts',()=>{
 assert.equal(rawUsage('openai-responses',{inputTokens:{total:0}}),undefined);
 assert.deepEqual(rawUsage('openai-responses',{raw:{input_tokens:2,output_tokens:3,total_tokens:5}}),{input_tokens:2,output_tokens:3,total_tokens:5});
 assert.deepEqual(rawUsage('anthropic-messages',{raw:{input_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4,output_tokens:5}}),{input_tokens:9,output_tokens:5});
 assert.deepEqual(rawUsage('google-generative-ai',{raw:{promptTokenCount:2,candidatesTokenCount:3,thoughtsTokenCount:4,totalTokenCount:9}}),{input_tokens:2,output_tokens:7,total_tokens:9});
 assert.deepEqual(rawUsage('google-generative-ai',{raw:{promptTokenCount:2}}),{input_tokens:2});
});

test('continuation persistence allowlists opaque metadata and drops reasoning plaintext', async()=>{
 const {fromModelMessages,toModelMessages}=await import('../src/context.js');
 const messages=fromModelMessages([{role:'assistant',content:[{type:'reasoning',text:'private chain of thought',providerOptions:{openai:{itemId:'reason-id',reasoningEncryptedContent:'cipher',secret:'forbidden'}}},{type:'text',text:'visible answer'}]}]);
 assert.ok(!JSON.stringify(messages).includes('private chain'));
 assert.ok(!JSON.stringify(messages).includes('forbidden'));
 assert.equal((toModelMessages(messages)[0].content[0] as any).text,'');
 assert.equal((toModelMessages(messages)[0].content[0] as any).providerOptions.openai.reasoningEncryptedContent,'cipher');
});
test('signed public text retains its original association and opaque oversize fails',async()=>{
 const {fromModelMessages,toModelMessages}=await import('../src/context.js');
 const history=fromModelMessages([{role:'assistant',content:[{type:'text',text:'first',providerOptions:{google:{thoughtSignature:'signed-first'}}},{type:'text',text:'second'}]}]);
 const parts=toModelMessages(history)[0].content;
 assert.equal(parts[0].text,'first');assert.equal(parts[0].providerOptions.google.thoughtSignature,'signed-first');assert.equal(parts[1].text,'second');
 assert.throws(()=>fromModelMessages([{role:'assistant',content:[{type:'reasoning',text:'',providerOptions:{openai:{reasoningEncryptedContent:'x'.repeat(256*1024+1)}}}]}]),/invalid_provider_state/);
});

test('connection probes cap native output at 256 and preserve feasible reasoning',async()=>{
 const cases=[{protocol:'openai-chat-completions',model:'gpt-5',reasoning:'high'},{protocol:'openai-responses',model:'gpt-5',reasoning:'high'},{protocol:'anthropic-messages',model:'claude-sonnet-4-6',reasoning:'high'},{protocol:'google-generative-ai',model:'gemini-3-flash-preview',reasoning:'high'},{protocol:'anthropic-messages',model:'claude-sonnet-4-5',reasoning:'none'}] as const;
 for(const item of cases){
  let body:any,requests=0,starts=0;
  const model=createModel({protocol:item.protocol,base_url:'https://fixture.invalid/v1',model:item.model},async(_url,init)=>{requests++;body=JSON.parse(String(init?.body));return new Response('{"error":{"message":"fixture"}}',{status:401,headers:{'content-type':'application/json'}});},{connectionTest:true,onProviderRequest:()=>starts++});
  await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'OK'}]}],maxOutputTokens:4096,reasoning:item.reasoning}));assert.equal(requests,1);assert.equal(starts,1);
  const limit=item.protocol==='openai-responses'?body.max_output_tokens:item.protocol==='google-generative-ai'?body.generationConfig.maxOutputTokens:body.max_tokens??body.max_completion_tokens;assert.equal(limit,256,JSON.stringify(body));
  if(item.protocol==='openai-chat-completions')assert.equal(body.reasoning_effort,'high');if(item.protocol==='openai-responses')assert.equal(body.reasoning.effort,'high');
  if(item.protocol==='anthropic-messages'&&item.reasoning==='high'){assert.equal(body.thinking.type,'adaptive');assert.equal(body.output_config.effort,'high');}
  if(item.protocol==='google-generative-ai')assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'high');if(item.reasoning==='none')assert.equal(body.thinking.type,'disabled');
 }
});
test('infeasible thinking probe reports explicit budget error before fetch or request-start',async()=>{
 for(const item of [{protocol:'anthropic-messages',model:'claude-sonnet-4-5'},{protocol:'google-generative-ai',model:'gemini-2.5-flash'}] as const){
  let requests=0,starts=0,budgetErrors=0;const model=createModel({protocol:item.protocol,base_url:'https://fixture.invalid/v1',model:item.model},async()=>{requests++;throw Error('must not send');},{connectionTest:true,onProviderRequest:()=>starts++,onBudgetError:()=>budgetErrors++});
  await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'OK'}]}],maxOutputTokens:256,reasoning:'high'}));assert.equal(requests,0);assert.equal(starts,0);assert.equal(budgetErrors,1);
 }
});
test('normal assistant requests retain SDK thinking budget outside connection probes',async()=>{
 let body:any;const model=createModel({protocol:'anthropic-messages',base_url:'https://fixture.invalid/v1',model:'claude-sonnet-4-5'},async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response('{"error":{"message":"fixture"}}',{status:401,headers:{'content-type':'application/json'}});});
 await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'test'}]}],maxOutputTokens:256,reasoning:'high'}));assert.ok(body.thinking.budget_tokens>=1024);assert.ok(body.max_tokens>256);
});
