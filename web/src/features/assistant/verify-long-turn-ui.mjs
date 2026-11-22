import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';

const publicDirectory=resolve(import.meta.dirname,'../../../../runtime/public');
const output=resolve(import.meta.dirname,'../../../../specs/216-assistant-long-turn-reliability/evidence');
await mkdir(output,{recursive:true});
const user={id:'fixture-user',name:'Fixture',role:'admin'};
const config={enabled:true,model:'fixture-model',base_url:'https://fixture.invalid/v1',has_key:false,code_tasks_enabled:false};
const sessions=new Map([['idle',{id:'idle',user_id:user.id,title:'Long task probe',category:'',created_at:'',updated_at:'',status:'idle',messages:[],events:[]}]]);
const errors=[];let nextTurn=0;
function json(res,value,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function writeEvent(session,turn,res,type,data={}){
 const event={sequence:session.events.length,session_id:session.id,turn_id:turn,type,timestamp:new Date().toISOString(),data};
 session.events.push(event);res.write(`data: ${JSON.stringify(event)}\n\n`);
}
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
 if(path.startsWith('/api/v1/')){
  if(req.method==='GET'&&path==='/api/v1/setup')return json(res,{required:false});
  if(req.method==='GET'&&path==='/api/v1/auth/providers')return json(res,[]);
  if(req.method==='GET'&&path==='/api/v1/auth/me')return json(res,user);
  if(req.method==='GET'&&path==='/api/v1/catalog/tables')return json(res,[{id:'logs',name:'log_app',kind:'log',columns:[{name:'body',type:'String'}],services:['app']}]);
  if(req.method==='GET'&&path==='/api/v1/assistant/config')return json(res,config);
  if(req.method==='GET'&&path==='/api/v1/assistant/sessions')return json(res,{items:[...sessions.values()].map(item=>({...item,messages:null,events:null}))});
  if(req.method==='POST'&&path==='/api/v1/assistant/sessions'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
   const id=`fixture-${++nextTurn}`,session={id,user_id:user.id,title:input.title,category:input.category||'',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),status:'idle',messages:[],events:[]};
   sessions.set(id,session);return json(res,session,201);
  }
  let match=path.match(/^\/api\/v1\/assistant\/sessions\/([^/]+)$/);
  if(match&&req.method==='GET'){const session=sessions.get(match[1]);if(!session)return json(res,{error:'not found'},404);return json(res,session);}
  match=path.match(/^\/api\/v1\/assistant\/sessions\/([^/]+)\/turns$/);
  if(match&&req.method==='POST'){
   let raw='';for await(const chunk of req)raw+=chunk;
   const session=sessions.get(match[1]);if(!session)return json(res,{error:'not found'},404);
   const input=JSON.parse(raw),turn=`turn-${++nextTurn}`;
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','x-accel-buffering':'no'});
   writeEvent(session,turn,res,'user.message',{text:input.text});
   writeEvent(session,turn,res,'turn.started');
   if(input.text==='long tool'){
    writeEvent(session,turn,res,'tool.call',{call_id:'slow-1',tool:'slow_tool',input:{target:'fixture-host'}});
    session.status='running';
    const pinger=setInterval(()=>{try{res.write(': ping\n\n');}catch{/* client gone */}},500);
    setTimeout(()=>{
     clearInterval(pinger);
     writeEvent(session,turn,res,'tool.result',{call_id:'slow-1',tool:'slow_tool',status:'success',value:{ok:true}});
     writeEvent(session,turn,res,'assistant.message',{step:1,text:'## 长任务完成\n\n工具执行结束后正常返回。'});
     writeEvent(session,turn,res,'turn.completed');
     res.end();session.status='idle';
    },3000);
    return;
   }
   if(input.text==='drop resume'){
    writeEvent(session,turn,res,'tool.call',{call_id:'drop-1',tool:'run_query',input:{sql:'SELECT 1'}});
    session.status='running';
    // Stream ends without a terminal event: the UI must switch to recovery polling.
    res.end();
    setTimeout(()=>{
     writeEvent(session,turn,{write:()=>{}},'tool.result',{call_id:'drop-1',tool:'run_query',status:'success',value:{results:[{refId:'A',status:'success',elapsed_ms:5,truncated:false,frames:[{columns:[{name:'1'}],rows:[[1]]}]}]}});
     writeEvent(session,turn,{write:()=>{}},'assistant.message',{step:1,text:'连接恢复后的最终答复。'});
     writeEvent(session,turn,{write:()=>{}},'turn.completed');
     session.status='idle';
    },2200);
    return;
   }
   if(input.text==='run query'){
    writeEvent(session,turn,res,'tool.call',{call_id:'query-1',tool:'run_query',input:{sql:'SELECT body FROM log_app LIMIT 2'}});
    writeEvent(session,turn,res,'tool.result',{call_id:'query-1',tool:'run_query',status:'success',value:{results:[{refId:'A',status:'success',elapsed_ms:12,truncated:true,frames:[{columns:[{name:'body'}],rows:[['a'],['b']]}]}]}});
    writeEvent(session,turn,res,'assistant.message',{step:1,text:'查询完成。'});
    writeEvent(session,turn,res,'turn.completed');
    res.end();
    return;
   }
   errors.push(`unexpected turn text: ${input.text}`);return json(res,{error:'unexpected'},400);
  }
  errors.push(`${req.method} ${path}`);return json(res,{error:'unexpected fixture request'},404);
 }
 const file=path.startsWith('/assets/')?resolve(publicDirectory,'.'+path):resolve(publicDirectory,'index.html');
 const contentType={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';
 try{const body=await readFile(file);res.writeHead(200,{'content-type':contentType});res.end(body);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
const screenshot=async name=>page.screenshot({path:resolve(output,name),fullPage:true,animations:'disabled'});
const result={passed:true,pings_seen:0,recovery_badge:false,badges:[],raw_details_expanded:false,page_errors:[]};
try{
 await page.goto(origin+'/assistant');
 const assistant=page.locator('.lm-assistant');await expect(assistant).toBeVisible();
 const composer=assistant.locator('.lm-assistant-composer textarea');

 // 1. Long silent tool: run bar with live elapsed, per-tool rows, heartbeats keep the stream open.
 await composer.fill('long tool');await assistant.getByRole('button',{name:'发送',exact:true}).click();
 const runbar=assistant.locator('.lm-assistant-runbar');
 await expect(runbar).toBeVisible();
 await expect(runbar).toContainText('slow tool');
 await expect(runbar.locator('.lm-assistant-runbar-elapsed')).toContainText(/\d{2}:\d{2}/);
 await expect(runbar.locator('.lm-assistant-runbar-steps')).toContainText('1');
 await expect(assistant.locator('.lm-assistant-tool-rows .lm-assistant-tool-row.running')).toHaveCount(1);
 await screenshot('runbar-long-tool.png');
 await expect(assistant.locator('.lm-assistant-answer').last()).toContainText('长任务完成',{timeout:15000});
 await expect(runbar).toHaveCount(0);
 await expect(assistant.locator('.lm-assistant-activity-elapsed').last()).toContainText(/\d{2}:\d{2}/);

 // 2. Dropped stream: recovery badge appears, polling completes the turn without an error alert.
 await composer.fill('drop resume');await assistant.getByRole('button',{name:'发送',exact:true}).click();
 const recovery=assistant.locator('.lm-assistant-runbar-recovery');
 await expect(recovery).toBeVisible();
 await expect(recovery).toContainText('连接中断，正在恢复…');
 result.recovery_badge=true;
 await screenshot('recovery-polling.png');
 await expect(assistant.locator('.lm-assistant-answer').last()).toContainText('连接恢复后的最终答复',{timeout:20000});
 await expect(runbar).toHaveCount(0);
 await expect(assistant.locator('.lm-assistant-feed .ant-alert-error')).toHaveCount(0);

 // 3. Tool badges: summary chips replace raw JSON, which stays collapsed until expanded.
 await composer.fill('run query');await assistant.getByRole('button',{name:'发送',exact:true}).click();
 await expect(assistant.locator('.lm-assistant-answer').last()).toContainText('查询完成',{timeout:15000});
 const trigger=assistant.locator('.lm-assistant-activity-trigger').last();
 await expect(trigger).toHaveAttribute('aria-expanded','false');
 await trigger.click();
 await assistant.locator('.lm-assistant-tools .ant-collapse-header').last().click();
 const badges=assistant.locator('.lm-assistant-tool-badge');
 await expect(badges.filter({hasText:'2 行'})).toBeVisible();
 await expect(badges.filter({hasText:'结果已截断'})).toBeVisible();
 await expect(badges.filter({hasText:'12 ms'})).toBeVisible();
 result.badges=await badges.allInnerTexts();
 const rawDetails=assistant.locator('.lm-assistant-tool-raw');
 await expect(rawDetails).toHaveCount(1);
 await expect(rawDetails.locator('.lm-assistant-tool-json').first()).toBeHidden();
 await rawDetails.locator('summary').click();
 await expect(rawDetails.locator('.lm-assistant-tool-json').first()).toBeVisible();
 result.raw_details_expanded=true;
 await screenshot('tool-badges.png');

 if(errors.length)throw Error(JSON.stringify(errors));
 result.page_errors=errors;
 await writeFile(resolve(output,'browser.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
