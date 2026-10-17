import {chromium,expect} from '../../../node_modules/@playwright/test/index.mjs';
import {writeFile} from 'node:fs/promises';
const site=process.env.LIGHTMONI_TEST_BASE_URL??'http://127.0.0.1:8080';
const cfg={runtime:'mastra',protocol:'google-generative-ai',base_url:'https://fixture.invalid/v1',model:'fixture-model',has_key:false,enabled:true,max_input_tokens:32000,max_output_tokens:4096,max_steps:8,reasoning_effort:'provider-default'};
const zero={requests:0,input_tokens:0,output_tokens:0,total_tokens:0,input_missing:0,output_missing:0,total_missing:0,unpriced_requests:0,estimated_costs:[]};
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'}),page=await context.newPage();
const report={checks:[],unexpected:[],tests:[],configWrites:0};
let mode='unique',pendingResolve,pendingSignal;
await page.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.origin!==site){report.unexpected.push(url.origin+url.pathname);return route.abort()}
 if(!url.pathname.startsWith('/api/v1/'))return route.continue();
 const path=url.pathname.slice('/api/v1'.length);
 if(path==='/auth/me')return route.fulfill({json:{id:'review-admin',name:'review-admin',role:'admin'}});
 if(path==='/assistant/config'){if(req.method()!=='GET')report.configWrites++;return route.fulfill({json:cfg})}
 if(path==='/assistant/billing')return route.fulfill({json:{base_url:cfg.base_url,protocol:cfg.protocol,model:cfg.model,currency:'CNY',input_price_per_million:2,output_price_per_million:8}});
 if(path==='/assistant/usage')return route.fulfill({json:{days:30,from:'2026-09-18T00:00:00Z',to:'2026-10-18T00:00:00Z',timezone:'UTC',totals:zero,daily:[],models:[],sources:[]}});
 if(path==='/assistant/models'){
   const input=req.postDataJSON(),currentMode=mode;
   if(currentMode==='pending')await new Promise(resolve=>{pendingResolve=resolve;pendingSignal?.()});
   const ambiguous=currentMode==='ambiguous';
   return route.fulfill({json:{base_url:input.base_url,protocol:ambiguous?'openai-chat-completions':cfg.protocol,protocol_options:ambiguous?['openai-chat-completions','openai-responses']:[cfg.protocol],protocol_source:'catalog',requires_confirmation:ambiguous,capabilities_verified:false,models:[{id:cfg.model}],truncated:false}}).catch(()=>{});
 }
 if(path==='/assistant/test-connection'){
   report.tests.push(req.postDataJSON());return route.fulfill({json:{ok:true,base_url:req.postDataJSON().base_url,protocol:req.postDataJSON().protocol,model:cfg.model,latency_ms:12}});
 }
 if(path==='/settings/instance')return route.fulfill({json:{external_url:site}});
 if(path==='/users'||path==='/settings/login-providers')return route.fulfill({json:[]});
 report.unexpected.push(req.method()+' '+path);return route.fulfill({status:500,json:{error:'unhandled regression fixture'}});
});
async function selectProtocol(dialog,label){await dialog.getByRole('combobox',{name:/API 协议/}).click();await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).click()}
try{
 await page.goto(site+'/admin?tab=models');
 await page.getByRole('button',{name:'编辑模型配置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'AI 模型连接'});
 await selectProtocol(dialog,'自动识别');
 const test=dialog.getByRole('button',{name:/测试连接/});
 await expect(dialog).toContainText('目录只提供模型名称');await expect(test).toBeEnabled();
 await test.click();await expect(dialog).toContainText('连接测试成功');
 expect(report.tests).toHaveLength(1);expect(report.tests[0].protocol).toBe('google-generative-ai');
 report.checks.push('唯一推荐可测试，提交具体协议');
 mode='ambiguous';await dialog.getByRole('textbox',{name:/API Base URL/}).fill('https://ambiguous.invalid/v1');
 await expect(test).toBeDisabled();await expect(dialog).toContainText('还需选择具体调用协议');await expect(test).toBeDisabled();
 report.checks.push('歧义推荐需选协议');
 await selectProtocol(dialog,'OpenAI · Responses');await expect(test).toBeEnabled();await test.click();await expect(dialog).toContainText('连接测试成功');expect(report.tests[1].protocol).toBe('openai-responses');
 report.checks.push('手动协议可覆盖目录推荐');
 mode='pending';let started=new Promise(resolve=>pendingSignal=resolve);await selectProtocol(dialog,'自动识别');await started;
 await dialog.getByRole('textbox',{name:/API Base URL/}).fill('invalid-url');await expect(test).toBeDisabled();pendingResolve();
 await page.waitForTimeout(300);await expect(test).toBeDisabled();await expect(dialog.getByRole('textbox',{name:/API Base URL/})).toHaveValue('invalid-url');
 report.checks.push('迟到目录无法恢复旧协议或地址');
 mode='unique';await dialog.getByRole('textbox',{name:/API Base URL/}).fill(cfg.base_url);await expect(test).toBeEnabled();
 report.checks.push('恢复有效地址重新识别');
 expect(report.unexpected).toEqual([]);expect(report.configWrites).toBe(0);expect(report.tests).toHaveLength(2);
 console.log(JSON.stringify(report,null,2));
 await writeFile('/tmp/lightmoni-model-auto-browser.json',JSON.stringify(report,null,2));
}finally{pendingResolve?.();await context.close();await browser.close()}
