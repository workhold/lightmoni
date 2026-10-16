// Discover regressions against the actual SDK → Agent → ClickHouse fixture.
// Run smoke.mjs first. No responses are mocked; each pass uses fresh tabs.
import { mediaDirectory } from '../../scripts/qa-artifacts.mjs';
import {createRequire} from 'node:module';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'web/package.json'));
const {chromium,request}=require('playwright'),{expect}=require('@playwright/test');
const fixture=JSON.parse(readFileSync(path.join(root,'examples/logs/results/run.json'),'utf8'));
const base=process.env.LIGHTMONI_TEST_URL??fixture.base,ui=process.env.LIGHTMONI_UI_URL??fixture.ui;
const evidence=path.join(root,'docs/evidence/logs-discover/regression');mkdirSync(evidence,{recursive:true});
const mediaOutput=mediaDirectory(evidence);
const api=await request.newContext({baseURL:base});
async function send(url,data,method='POST'){
 const response=await api.fetch('/api/v1'+url,{method,data});
 expect(response.ok(),`${url}: ${response.status()}`).toBe(true);return response.json();
}
await send('/auth/login',{name:process.env.LIGHTMONI_TEST_USER??'local-admin',password:process.env.LIGHTMONI_TEST_PASSWORD??'local-demo-password'});
const spec={table_id:fixture.table,range:{from:fixture.from,to:fixture.to},services:[],keyword:fixture.run,filters:[],mode:'filters',sort:'desc'};
const filtered={...spec,filters:[{scope:'column',field:'service',type:'string',op:'eq',value:'logs-go-demo'},{scope:'attribute',field:'status',type:'number',op:'gte',value:500}]};
const expected=await send('/logs/search',{spec:filtered,limit:200});
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
const report=[];
try{
 for(let round=1;round<=3;round++){
  const context=await browser.newContext({viewport:{width:1440,height:960},storageState:await api.storageState(),permissions:['clipboard-read','clipboard-write'],...(round===1?{recordVideo:{dir:path.join(mediaOutput,'motion'),size:{width:1440,height:960}}}:{})});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',err=>errors.push(err.message));let savedID;
  const query=async(action)=>{const pending=page.waitForResponse(r=>r.url().endsWith('/logs/search')&&r.request().method()==='POST');await action();const response=await pending;expect(response.status()).toBe(200);return response.json()};
  const select=async(label,text)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText(text,{exact:true}).click()};
  const loaded=async(count)=>expect(page.getByText(`${count} 条已载入`,{exact:true})).toBeVisible();
  try{
   await page.goto(ui+'/logs?'+new URLSearchParams({table:spec.table_id,...spec.range}),{waitUntil:'networkidle'});
   const input=page.getByRole('combobox',{name:'日志关键词',exact:true});
   // Punctuation remains a literal body query, and Enter really runs it.
   await input.fill('PaymentError:');const literal=await query(()=>input.press('Enter'));
   expect(literal.params.lm_log_keyword.value).toBe('PaymentError:');expect(literal.total_loaded).toBeGreaterThan(0);
   await select('检索模式','字段表达式');await input.fill('serv');
   await expect(page.locator('.ant-select-dropdown:visible .lm-log-suggestion').getByText('service',{exact:true})).toBeVisible();
   await input.press('ArrowDown');await input.press('Enter');await expect(input).toHaveValue('service:');
   await input.fill(`${fixture.run} service:"logs-go-demo" AND @status>=500`);
   const result=await query(()=>input.press('Enter'));expect(result.total_loaded).toBe(expected.total_loaded);await loaded(expected.total_loaded);
   await expect(page.locator('.lm-log-chip')).toHaveCount(2);
   const head=page.locator('.ant-table-header');
   await expect.poll(()=>head.evaluate(el=>el.scrollLeft)).toBe(0);
   const geometry=await page.locator('.ant-table-thead th').evaluateAll(cells=>cells.map(cell=>({left:cell.getBoundingClientRect().left,right:cell.getBoundingClientRect().right})));
   expect(geometry[2].left).toBeGreaterThanOrEqual(geometry[1].right-1);
   await query(()=>page.getByRole('button',{name:'禁用过滤 status',exact:true}).click());
   await query(()=>page.getByRole('button',{name:'启用过滤 status',exact:true}).click());await loaded(expected.total_loaded);
   await page.getByRole('textbox',{name:'搜索字段'}).fill('retryable');await page.getByRole('button',{name:'添加列 attr:retryable',exact:true}).click();
   await select('日志行数','三行');
   await page.locator('.lm-log-message').first().click();let detail=page.getByRole('dialog',{name:/日志详情/});
   await expect(detail.getByRole('button',{name:'上一条日志'})).toBeDisabled();await detail.getByRole('button',{name:'下一条日志'}).click();
   await expect(detail).toContainText(`2 / ${expected.total_loaded}`);await detail.getByRole('tab',{name:'属性字段'}).click();
   await expect(detail.getByRole('button',{name:'包含属性 status'})).toBeVisible();await expect(detail.getByRole('button',{name:'排除属性 status'})).toBeVisible();
   await detail.locator('.ant-drawer-close').click();
   // A new tab has no router history: the URL must restore the full query/view.
   await page.getByRole('button',{name:'分享检索',exact:true}).click();const share=await page.evaluate(()=>navigator.clipboard.readText());
   const linked=await context.newPage();await linked.goto(share,{waitUntil:'networkidle'});
   await expect(linked.getByText(`${expected.total_loaded} 条已载入`,{exact:true})).toBeVisible();
   await expect(linked.locator('.lm-log-chip')).toHaveCount(2);await expect(linked.locator('.lm-log-column-title').filter({hasText:'retryable'})).toBeVisible();
   await expect(linked.getByRole('combobox',{name:'日志行数'}).locator('..')).toContainText('三行');
   await linked.reload();await expect(linked.getByText(`${expected.total_loaded} 条已载入`,{exact:true})).toBeVisible();await linked.close();
   // Real SQLite persistence and reopening retain the new display settings.
   const title=`discover-regression-${Date.now()}-${round}`;
   await page.getByRole('button',{name:/保存检索$/}).click();await page.getByRole('textbox',{name:'检索名称'}).fill(title);await page.getByRole('dialog',{name:'保存检索',exact:true}).getByRole('button',{name:/保\s*存$/}).click();
   await expect(page.getByRole('dialog',{name:'保存检索',exact:true})).not.toBeVisible();const list=await send('/logs/saved-searches',undefined,'GET');
   const saved=list.find(item=>item.title===title);expect(saved).toBeTruthy();savedID=saved.id;expect(saved.view.row_lines).toBe(3);expect(saved.spec.filters).toEqual(filtered.filters);
   await page.goto(ui+'/logs?saved='+savedID,{waitUntil:'networkidle'});await loaded(expected.total_loaded);await expect(page.locator('.lm-log-message.is-wrapped').first()).toBeVisible();
   await page.getByRole('tab',{name:'聚合',exact:true}).click();await expect(page.getByRole('tabpanel',{name:'聚合结果'}).locator('.lm-log-value-row').first()).toBeVisible();
   await page.getByRole('tab',{name:'原始日志',exact:true}).click();
   await page.getByRole('button',{name:'分布数据'}).click();const distribution=page.getByRole('dialog',{name:'日志时间分布数据'});
   await query(()=>distribution.getByRole('button',{name:'查看时段'}).first().click());
   const reset=await query(()=>page.getByRole('button',{name:'清除时间选择',exact:true}).click());expect(reset.range).toEqual(spec.range);
   await page.setViewportSize({width:751,height:950});if(await page.locator('.lm-nav-collapse').isVisible())await page.locator('.lm-nav-collapse').click();await page.getByRole('button',{name:/字\s*段$/}).click();const fields=page.getByRole('dialog',{name:'字段探索'});
   await expect(fields.getByRole('textbox',{name:'搜索字段'})).toBeVisible();await fields.locator('.ant-drawer-close').click();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.getByRole('button',{name:'更多日志操作'}).click();await expect(page.getByRole('menuitem',{name:'查看执行 SQL'})).toBeVisible();await page.keyboard.press('Escape');
   expect(errors).toEqual([]);report.push({round,status:'passed',matched:expected.total_loaded});
   if(round===1){await page.setViewportSize({width:1440,height:960});await page.screenshot({path:path.join(mediaOutput,'verified-desktop.png'),fullPage:true});}
  }catch(error){await page.screenshot({path:path.join(mediaOutput,`failure-${round}.png`),fullPage:true});throw error}
  finally{if(savedID)await api.delete('/api/v1/logs/saved-searches/'+savedID);await context.close()}
  console.log(`PASS Discover round ${round}: literal punctuation, expression/autocomplete, chips, columns/wrap, detail navigation, new-tab share/reload, saved SQLite view, statistics, time reset, narrow fields/menu.`);
 }
 writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
}finally{await browser.close();await api.dispose()}
