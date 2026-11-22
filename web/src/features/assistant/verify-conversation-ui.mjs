import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';

const publicDirectory=resolve(import.meta.dirname,'../../../../runtime/public');
const output=resolve(import.meta.dirname,'../../../../specs/188-ai-assistant-conversation/evidence');
await mkdir(output,{recursive:true});
const user={id:'fixture-user',name:'Fixture',role:'admin'};
const config={enabled:true,model:'fixture-model',base_url:'https://fixture.invalid/v1',has_key:false,code_tasks_enabled:false};
const now='2026-11-19T00:00:00Z';
const sessions=new Map([
 ['needs-review',{id:'needs-review',user_id:user.id,title:'Approval needed',category:'Review',created_at:now,updated_at:now,status:'needs_action',messages:[],events:[]}],
 ['failed',{id:'failed',user_id:user.id,title:'Failed analysis',category:'',created_at:now,updated_at:now,status:'failed',messages:[],events:[]}],
]);
const turns=[];const cancels=[];const active=new Map();const errors=[];
let nextSession=0,nextTurn=0;
function json(res,value,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function writeEvent(session,turn,res,type,data={}){
 const event={sequence:session.events.length,session_id:session.id,turn_id:turn,type,timestamp:now,data};
 session.events.push(event);res.write(`data: ${JSON.stringify(event)}\n\n`);
}
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
 if(path.startsWith('/api/v1/')){
  if(req.method==='GET'&&path==='/api/v1/setup')return json(res,{required:false});
  if(req.method==='GET'&&path==='/api/v1/auth/providers')return json(res,[]);
  if(req.method==='GET'&&path==='/api/v1/auth/me')return json(res,user);
  if(req.method==='GET'&&path==='/api/v1/catalog/tables')return json(res,[]);
  if(req.method==='GET'&&path==='/api/v1/assistant/config')return json(res,config);
  if(req.method==='GET'&&path==='/api/v1/assistant/sessions')return json(res,{items:[...sessions.values()].map(s=>({...s,status:active.has(s.id)?'running':s.status,messages:null,events:null}))});
  if(req.method==='POST'&&path==='/api/v1/assistant/sessions'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
   const id=`new-${++nextSession}`,session={id,user_id:user.id,title:input.title,category:input.category||'',created_at:now,updated_at:now,status:'idle',messages:[],events:[]};sessions.set(id,session);return json(res,session,201);
  }
  let match=path.match(/^\/api\/v1\/assistant\/sessions\/([^/]+)$/);
  if(match){const session=sessions.get(match[1]);if(!session)return json(res,{error:'not found'},404);
   if(req.method==='PATCH'){let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);session.title=input.title??session.title;session.category=input.category??session.category;return json(res,session);}
   if(req.method==='DELETE'){sessions.delete(match[1]);return json(res,{deleted:true});}
  }
  match=path.match(/^\/api\/v1\/assistant\/sessions\/([^/]+)(?:\/(turns|cancel))?$/);
  if(match){const session=sessions.get(match[1]);if(!session)return json(res,{error:'not found'},404);
   if(req.method==='GET'&&!match[2])return json(res,session);
   if(req.method==='POST'&&match[2]==='cancel'){
    cancels.push(session.id);const running=active.get(session.id);
    if(running){writeEvent(session,running.turn,running.res,'turn.cancelled',{error:'request cancelled'});running.res.end();active.delete(session.id);session.status='idle';}
    return json(res,{cancelled:!!running});
   }
   if(req.method==='POST'&&match[2]==='turns'){
    let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);turns.push({session_id:session.id,...input});
    const turn=`turn-${++nextTurn}`;
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    writeEvent(session,turn,res,'user.message',{text:input.text,attachments:(input.attachments??[]).map(({kind,name,mime_type,pages})=>({kind,name,mime_type,pages}))});
    writeEvent(session,turn,res,'turn.started');
    if(input.text==='first'||input.text==='hold stop'){active.set(session.id,{turn,res});return;}
    if(input.text==='ssh test'){
      writeEvent(session,turn,res,'tool.call',{call_id:'ssh-call',tool:'check_managed_machine_ssh',input:{machine_id:'fixture-host'}});
      writeEvent(session,turn,res,'tool.result',{call_id:'ssh-call',tool:'check_managed_machine_ssh',status:'success',value:{connected:true,ready:true}});
    }
    writeEvent(session,turn,res,'assistant.message',{step:1,text:'## Final answer\n\nDone. `verified`'});
    writeEvent(session,turn,res,'turn.completed');res.end();session.status='idle';return;
   }
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
function pdf(){
 const stream='BT /F1 14 Tf 20 180 Td (PDF fixture text) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let source='%PDF-1.4\n';const offsets=[0];for(const [index,obj] of objects.entries()){offsets.push(Buffer.byteLength(source));source+=`${index+1} 0 obj\n${obj}\nendobj\n`;}
 const start=Buffer.byteLength(source);source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(const offset of offsets.slice(1))source+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 source+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(source);
}
try{
 await page.goto(origin+'/assistant');const assistant=page.locator('.lm-assistant');await expect(assistant).toBeVisible();
 await screenshot('desktop-welcome.png');
 await expect(assistant.locator('.lm-assistant-header,.lm-assistant-context')).toHaveCount(0);
 await assistant.getByRole('button',{name:'分析范围与设置'}).click();
 await expect(page.locator('.lm-assistant-scope:visible')).toContainText('fixture-model');
 await expect.poll(()=>page.locator('.ant-popover:visible').last().evaluate(element=>getComputedStyle(element).opacity)).toBe('1');
 await screenshot('desktop-scope.png');
 await page.keyboard.press('Escape');
 await expect(assistant.locator('.lm-assistant-session').filter({hasText:'Approval needed'})).toContainText('待确认');
 await expect(assistant.locator('.lm-assistant-session').filter({hasText:'Failed analysis'})).toContainText('失败');
 const composer=await assistant.locator('.lm-assistant-composer-wrap').boundingBox();expect(composer.width).toBeLessThanOrEqual(840);
 const box=assistant.locator('.lm-assistant-composer textarea');
 await box.fill('first');await page.evaluate(()=>{const send=document.querySelector('.lm-assistant-send-button');send.click();send.click();});
 await expect.poll(()=>nextSession).toBe(1);
 await expect(assistant.getByRole('button',{name:'停止当前响应'})).toBeVisible();
 await expect(assistant.locator('.lm-assistant-session').filter({hasText:'first'}).locator('.lm-assistant-session-status.running')).toBeVisible();
 await box.fill('second');await page.getByRole('button',{name:/加入队列|Queue turn/}).click();
 await box.fill('third');await page.getByRole('button',{name:/加入队列|Queue turn/}).click();
 await expect(assistant.locator('.lm-assistant-queue-item')).toHaveCount(2);
 await assistant.locator('.lm-assistant-queue-item').filter({hasText:'third'}).getByRole('button',{name:'立即发送'}).click();
 await expect.poll(()=>turns.length).toBe(3);
 expect(turns.map(turn=>turn.text)).toEqual(['first','third','second']);expect(cancels.length).toBe(1);
 await expect(assistant.locator('.lm-assistant-queue-item')).toHaveCount(0);
 await box.fill('hold stop');await assistant.getByRole('button',{name:'发送',exact:true}).click();
 await expect(assistant.getByRole('button',{name:'停止当前响应'})).toBeVisible();
 await assistant.getByRole('button',{name:'停止当前响应'}).click();
 await expect.poll(()=>cancels.length).toBe(2);
 await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeVisible();
 await box.fill('ssh test');await assistant.getByRole('button',{name:'发送',exact:true}).click();
 await expect(assistant.locator('.lm-assistant-activity-trigger').last()).toHaveAttribute('aria-expanded','false');
 await assistant.locator('.lm-assistant-activity-trigger').last().click();
 await assistant.locator('.lm-assistant-tools .ant-collapse-header').last().click();
 await expect(assistant.locator('.lm-assistant-terminal').last()).toContainText('ssh fixture-host');
 await expect(assistant.locator('.lm-assistant-answer').last()).toContainText('Final answer');
 await expect(assistant.locator('.lm-inspector')).toBeVisible();
 await expect(assistant.locator('.lm-inspector-tabs button').filter({hasText:'上下文'})).toBeVisible();
 await expect(assistant.locator('.lm-inspector-chips')).toContainText('助手页');
 await assistant.locator('.lm-inspector-tabs button').filter({hasText:'产物'}).click();
 await expect(assistant.locator('.lm-inspector-item')).toHaveCount(1);
 await assistant.locator('.lm-inspector-item').first().click();
 await expect(assistant.locator('.lm-inspector-detail')).toContainText('主机检查');
 await screenshot('desktop-light.png');
 const failedRow=assistant.locator('.lm-assistant-session-row').filter({hasText:'Failed analysis'});
 await failedRow.getByRole('combobox',{name:'对话分类'}).fill('运维任务');
 await page.keyboard.press('Enter');

 await expect.poll(()=>[...sessions.values()].find(session=>session.title==='Failed analysis')?.category).toBe('运维任务');
 await expect(assistant.locator('.lm-assistant-history-group').filter({hasText:'运维任务'})).toContainText('Failed analysis');
 await assistant.getByRole('button',{name:'新对话'}).click();
 const tempBox=assistant.locator('.lm-assistant-composer textarea');await tempBox.fill('temporary');
 await assistant.getByRole('button',{name:'发送',exact:true}).click();
 await expect.poll(()=>nextSession).toBe(2);
 const reviewRow=assistant.locator('.lm-assistant-session-row').filter({hasText:'temporary'});
 await reviewRow.getByRole('button',{name:'删除对话'}).click();
 await assistant.getByRole('button',{name:'新对话'}).click();
 await expect.poll(()=>nextSession===2 && ![...sessions.values()].some(session=>session.title==='temporary')).toBe(true);
 await expect(assistant.locator('.lm-assistant-session-row').filter({hasText:'temporary'})).toHaveCount(0);
 const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;canvas.getContext('2d').fillRect(0,0,1,1);return canvas.toDataURL('image/png').split(',')[1]});
 await assistant.locator('.lm-assistant-file-input').setInputFiles([{name:'screen.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')},{name:'report.pdf',mimeType:'application/pdf',buffer:pdf()}]);
 await expect(assistant.locator('.lm-assistant-attachments .lm-assistant-attachment')).toHaveCount(2);
 await box.fill('analyze attachment');await assistant.getByRole('button',{name:'发送',exact:true}).click();
 await expect.poll(()=>turns.filter(turn=>turn.text==='analyze attachment').length).toBe(1);
 const attached=turns.find(turn=>turn.text==='analyze attachment').attachments;expect(attached.map(item=>item.kind)).toEqual(['image','pdf']);
 expect(attached[0].data.length).toBeGreaterThan(10);expect(attached[1].text).toContain('PDF fixture text');
 await page.setViewportSize({width:375,height:812});
 await page.evaluate(()=>{localStorage.setItem('lightmoni.appearance','dark');window.dispatchEvent(new StorageEvent('storage',{key:'lightmoni.appearance'}));});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.theme)).toBe('dark');
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const mobileBox=await assistant.locator('.lm-assistant-composer-wrap').boundingBox();expect(mobileBox.width).toBeLessThanOrEqual(375);
 await screenshot('mobile-dark.png');
 await assistant.getByRole('button',{name:'分析范围与设置'}).click();
 const scopeBox=await page.locator('.lm-assistant-scope:visible').boundingBox();
 expect(scopeBox.x).toBeGreaterThanOrEqual(0);expect(scopeBox.x+scopeBox.width).toBeLessThanOrEqual(375);
 await expect.poll(()=>page.locator('.ant-popover:visible').last().evaluate(element=>getComputedStyle(element).opacity)).toBe('1');
 await screenshot('mobile-scope-dark.png');
 await page.keyboard.press('Escape');
 if(errors.length)throw Error(JSON.stringify(errors));
 const result={passed:true,turn_order:turns.map(item=>item.text),cancel_count:cancels.length,composer_width:composer.width,mobile_composer_width:mobileBox.width,mobile_theme:await page.evaluate(()=>document.documentElement.dataset.theme),attachment_kinds:attached.map(item=>item.kind),page_errors:errors};
 await writeFile(resolve(output,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
