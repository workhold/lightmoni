import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import type {Protocol} from '../src/model.js';
const protocols:Protocol[]=['openai-chat-completions','openai-responses','anthropic-messages','google-generative-ai'];
function reply(p:Protocol,tool:boolean,stream:boolean,usage=true){
 const text='verified fixture answer',id='fixture-id',call='fixture-call';
 if(p==='openai-chat-completions'){
 const u=usage?{prompt_tokens:10,completion_tokens:3,total_tokens:13}:undefined;
 const message=tool?{role:'assistant',content:null,tool_calls:[{id:call,type:'function',function:{name:'list_tables',arguments:'{}'}}]}:{role:'assistant',content:text};
 if(!stream)return {id,object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:u};
 return [{id,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:tool?{tool_calls:[{index:0,...message.tool_calls![0]}]}:{content:text},finish_reason:null}]},{id,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:u}];
 }
 if(p==='openai-responses'){
 const u=usage?{input_tokens:10,output_tokens:3,total_tokens:13}:undefined;
 const item=tool?{type:'function_call',id,call_id:call,name:'list_tables',arguments:'{}',status:'completed'}:{type:'message',id,role:'assistant',content:[{type:'output_text',text,annotations:[]}]};
 const response={id,created_at:1,model:'fixture',status:'completed',output:[item],usage:u};
 if(!stream)return response;
 const events:any[]=[{type:'response.created',response},{type:'response.output_item.added',output_index:0,item:tool?{...item,arguments:''}:item}];
 if(tool)events.push({type:'response.function_call_arguments.delta',item_id:id,output_index:0,delta:'{}'},{type:'response.function_call_arguments.done',item_id:id,output_index:0,arguments:'{}'});
 else events.push({type:'response.content_part.added',item_id:id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:id,output_index:0,content_index:0,delta:text});
 if(tool){const reasoning={type:'reasoning',id:'reasoning-id',encrypted_content:'opaque-encrypted-reasoning'};events.splice(1,0,{type:'response.output_item.added',output_index:1,item:reasoning},{type:'response.output_item.done',output_index:1,item:reasoning});}
 events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response});return events;
 }
 if(p==='anthropic-messages'){
 const u={input_tokens:10,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:1};
 const content=tool?{type:'tool_use',id:call,name:'list_tables',input:{}}:{type:'text',text};
 if(!stream)return {id,type:'message',role:'assistant',model:'fixture',content:[content],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:u};
 return [{type:'message_start',message:{id,model:'fixture',role:'assistant',usage:u}},{type:'content_block_start',index:0,content_block:tool?content:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}];
 }
 const value={candidates:[{index:0,content:{role:'model',parts:[tool?{functionCall:{name:'list_tables',args:{}},thoughtSignature:'opaque-gemini-signature'}:{text,thoughtSignature:'opaque-text-signature'}]},finishReason:'STOP'}],usageMetadata:usage?{promptTokenCount:10,candidatesTokenCount:3,thoughtsTokenCount:2,totalTokenCount:15}:undefined};
 return stream?[value]:value;
}
async function worker(p:Protocol,mode:'tool'|'summary'|'missing'|'error'|'cancel', replay?:any[]){
 const requests:any[]=[];let child:ReturnType<typeof spawn>;
 const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);requests.push({url:req.url,headers:req.headers,body});
 if(mode==='cancel'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': waiting\n\n');setTimeout(()=>child.kill('SIGTERM'),20);return;}
 if(mode==='error'){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"message":"secret fixture error"}}');return;}
 const streaming=body.stream===true||req.url!.includes('streamGenerateContent');
 const tool=mode==='tool'&&requests.length===1;
 const result=reply(p,tool,streaming,mode!=='missing');
 res.writeHead(200,{'content-type':streaming?'text/event-stream':'application/json'});
 res.end(streaming?(result as any[]).map(x=>`event: ${x.type??'message'}\ndata: ${JSON.stringify(x)}\n\n`).join(''):JSON.stringify(result));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as any).port;
 child=spawn(process.execPath,['--import','tsx','src/runner.ts'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
 const frames:any[]=[];let buffer='',stderr='';
 child.stdout!.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const f=JSON.parse(line);frames.push(f);if(f.type==='tool.request')child.stdin!.write(JSON.stringify({type:'tool.response',id:f.id,value:{tables:['fixture']}})+'\n');}});
 child.stderr!.on('data',chunk=>stderr+=chunk);
 const messages=replay??(mode==='summary'?[{role:'user',content:'old '.repeat(350)},{role:'assistant',content:'old answer'},{role:'user',content:'older '.repeat(250)},{role:'assistant',content:'older answer'},{role:'user',content:'new question'}]:[{role:'user',content:'previous question'},{role:'assistant',content:'previous answer'},{role:'user',content:'current question'}]);
 child.stdin!.write(JSON.stringify({type:'start',input:{system:'monitoring',config:{protocol:p,base_url:`http://127.0.0.1:${port}/tenant/v1`,api_key:'fixture',model:p==='google-generative-ai'?'models/gemini-fixture':'fixture',max_input_tokens:mode==='summary'?4096:20000,max_output_tokens:1024,max_steps:4},messages,tools:[{name:'list_tables',description:'list',schema:{type:'object',properties:{}}}]}})+'\n');
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
 await new Promise<void>(r=>child.on('exit',()=>r()));clearTimeout(timer);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 return {frames,requests,stderr};
}
for(const p of protocols){
 test(`${p} worker text/tool/history checkpoint`,async()=>{
 const {frames,requests,stderr}=await worker(p,'tool');assert.equal(stderr,'');assert.ok(frames.some(f=>f.type==='done'),JSON.stringify(frames));assert.equal(requests.length,2);assert.ok(frames.some(f=>f.type==='tool.request'));assert.ok(frames.some(f=>f.type==='checkpoint'&&f.messages.some((m:any)=>m.role==='tool')));assert.ok(frames.some(f=>f.name==='assistant.delta'&&f.data.text.includes('verified')));assert.ok(JSON.stringify(requests[0].body).includes('previous answer'));assert.ok(JSON.stringify(requests[1].body).includes('fixture'));assert.ok(frames.some(f=>f.name==='turn.usage'));
 });
 test(`${p} worker generation summary`,async()=>{const {frames,requests}=await worker(p,'summary');assert.ok(frames.some(f=>f.type==='compacted'),JSON.stringify(frames));assert.ok(frames.some(f=>f.type==='done'),JSON.stringify(frames));assert.ok(requests.length>=2);});
 test(`${p} worker errors redacted and cancellation`,async()=>{for(const mode of ['error','cancel'] as const){const {frames,stderr}=await worker(p,mode);assert.equal(stderr,'');assert.ok(frames.some(f=>f.type==='error'));assert.ok(!JSON.stringify(frames).includes('secret fixture'));assert.ok(!frames.some(f=>f.type==='done'));}});
 if(p!=='anthropic-messages')test(`${p} missing usage is unknown`,async()=>{const {frames}=await worker(p,'missing');assert.ok(frames.some(f=>f.type==='done'),JSON.stringify(frames));assert.ok(!frames.some(f=>f.name==='turn.usage'));});
}

for(const p of ['google-generative-ai','openai-responses'] as const)test(`${p} opaque continuation metadata survives new worker`,async()=>{
 const initial=await worker(p,'tool');
 const checkpoint=initial.frames.filter(f=>f.type==='checkpoint').at(-1);assert.ok(checkpoint);
 const marker=p==='google-generative-ai'?'opaque-gemini-signature':'opaque-encrypted-reasoning';
 assert.ok(JSON.stringify(checkpoint.messages).includes(marker),JSON.stringify(checkpoint));
 assert.ok(JSON.stringify(initial.requests[1].body).includes(marker));
 const replay=await worker(p,'missing',[{role:'user',content:'original'},...checkpoint.messages,{role:'user',content:'follow up'}]);
 assert.ok(replay.frames.some(f=>f.type==='done'),JSON.stringify(replay.frames));
 assert.ok(JSON.stringify(replay.requests[0].body).includes(marker));
 if(p==='google-generative-ai'){const contents=replay.requests[0].body.contents;const signed=contents.flatMap((c:any)=>c.parts).find((part:any)=>part.thoughtSignature==='opaque-text-signature');assert.equal(signed.text,'verified fixture answer');}
});
