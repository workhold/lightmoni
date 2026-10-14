import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Deterministic API fixtures exercise the real dashboard, editor and G2 canvas.
const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5178';
const output=resolve(import.meta.dirname,'../../../../docs/evidence/time-boundary');
await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'chrome'});}
const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});
const page=await context.newPage(),errors=[],requests=[],checks=[];
let options={query_interval:'1h'},type='line';
let range={from:'2026-10-13T23:05:00Z',to:'2026-10-14T00:05:00Z'};
const sql='SELECT $__timeInterval(event_time) AS time, avg(value) AS value FROM metric_test_gauge WHERE $__timeFilter(event_time) GROUP BY time ORDER BY time';
const panel=()=>({id:'boundary-panel',title:'运行协程数',type,queries:[{refId:'A',sql}],options:{x:'time',y:'value',...options},grid:{x:0,y:0,w:12,h:8}});
const dashboard=()=>({id:'time-boundary',title:'聚合边界验证',description:'',panels:[panel()],variables:[],range,refresh:0,revision:1});
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>localStorage.setItem('lightmoni.nav.collapsed','true'));
await page.route('**/src/features/dashboards/ChartView.tsx*',async route=>{
 const response=await route.fetch(),source=await response.text();
 await route.fulfill({response,body:source.replace('queue.submit(finalOptions);','node.__qaOptions=finalOptions; node.__qaChart=chart; queue.submit(finalOptions);')});
});
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname;
 let body=[];
 if(path.endsWith('/auth/me'))body={id:'qa-user',name:'qa-user',role:'admin'};
 else if(path.endsWith('/dashboards/time-boundary'))body=dashboard();
 else if(path.endsWith('/dashboards'))body=[dashboard()];
 else if(path.endsWith('/alerts/annotations'))body={rules:[],events:[],truncated:false};
 else if(path.endsWith('/query')){
  const query=request.postDataJSON();requests.push(query);
  const start=Date.parse(query.range.from),end=Date.parse(query.range.to),width=query.interval_ms,rows=[];
  for(let time=Math.floor(start/width)*width;time<end;time+=width)rows.push([new Date(time).toISOString(),rows.length%2?29:17]);
  body={request_id:query.request_id,results:query.queries.map(({refId})=>({refId,status:'success',complete:true,truncated:false,frames:[{columns:[{name:'time',type:"DateTime64(3, 'UTC')"},{name:'value',type:'Float64'}],rows}]}))};
 }
 await route.fulfill({json:body});
});
async function ready(){
 const chart=page.locator('.lm-g2-chart').first();
 await expect.poll(()=>chart.evaluate(node=>Number(node.dataset.chartCommits)>0&&!node.querySelector('.lm-chart-frame:not([hidden])'))).toBe(true);
 await expect(page.locator('.lm-panel-body .ant-alert')).toHaveCount(0);
 return chart;
}
async function snapshot(chart){return chart.evaluate(node=>{
 const context=node.__qaChart.getContext(),plots=context.canvas.document.querySelectorAll('.plot');
 return {clip:node.__qaOptions.clip,plots:[...plots].map(plot=>({bounds:plot.getBounds(),clip:!!plot.getAttribute('clipPath')})),marks:node.__qaOptions.type==='view'?node.__qaOptions.children.map(mark=>({type:mark.type,rows:mark.data?.length})): [{type:node.__qaOptions.type,rows:node.__qaOptions.data.length}]};
});}
try{
 await page.goto(base+'/dashboards/time-boundary');
 let chart=await ready();
 const initial=await snapshot(chart);
 await page.screenshot({path:resolve(output,process.env.LIGHTMONI_QA_BASELINE?'before.png':'hourly.png'),animations:'disabled'});
 if(process.env.LIGHTMONI_QA_BASELINE){console.log(JSON.stringify(initial));}
 else{
  expect(initial.clip).toBe(true);expect(initial.plots.every(plot=>plot.clip)).toBe(true);
  expect(requests.at(-1).interval_ms).toBe(3600000);checks.push('1h 时间桶早于查询起点，实际 G2 绘图区启用裁剪');
  options={};await page.reload();chart=await ready();
  expect(requests.at(-1).interval_ms).toBe(60000);
  await page.getByRole('button',{name:'编辑 运行协程数',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'聚合间隔',exact:true})).toHaveValue('1m');
  await expect(page.getByRole('combobox',{name:'最小聚合间隔',exact:true})).toBeDisabled();
  await expect(page.getByRole('spinbutton',{name:'最大数据点',exact:true})).toBeDisabled();
  checks.push('无聚合配置的已有面板查询为 1min，编辑器显示固定 1min');
  await page.reload();await ready();
  await page.setViewportSize({width:390,height:900});await ready();
  expect(requests.at(-1).interval_ms).toBe(60000);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:resolve(output,'minute-390.png'),animations:'disabled'});
  checks.push('390px 默认仍为 1min，页面无横向溢出');
  await page.setViewportSize({width:1440,height:1000});
  for(const nextType of ['area','bar','heatmap','timeline']){
   type=nextType;options={query_interval:'1h',...(type==='timeline'?{timeline_mode:'auto'}:{})};
   await page.reload();chart=await ready();const spec=await snapshot(chart);
   expect(spec.clip).toBe(true);expect(spec.plots.every(plot=>plot.clip)).toBe(true);
  }
  checks.push('面积、时间柱状、热力和状态时间线均裁剪绘图区');
  expect(errors).toEqual([]);
  await writeFile(resolve(output,'report.json'),JSON.stringify({checks,page_errors:errors,hourly:initial},null,2));
  console.log(JSON.stringify({checks,page_errors:errors}));
 }
}catch(error){
 await page.screenshot({path:resolve(output,'failure.png'),animations:'disabled'});
 console.error(JSON.stringify({errors,spec:await snapshot(page.locator('.lm-g2-chart').first()),alerts:await page.locator('.ant-alert').allTextContents()}));throw error;
}finally{await context.close();await browser.close();}
