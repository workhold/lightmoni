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
