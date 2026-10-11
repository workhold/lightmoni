import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.LIGHTMONI_UI_URL??'http://127.0.0.1:5178';
const run=process.env.LIGHTMONI_QA_RUN??'1';
const output=resolve(import.meta.dirname,'../../../docs/evidence/agent-groups');
await mkdir(output,{recursive:true});
let browser;try{browser=await chromium.launch({headless:true})}catch{browser=await chromium.launch({headless:true,channel:'chrome'})}
const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write'],recordVideo:run==='1'?{dir:output,size:{width:1440,height:1000}}:undefined});
context.setDefaultTimeout(10000);
const page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
async function request(path,options){const response=await context.request.fetch(base+'/api/v1'+path,options);if(!response.ok())throw new Error(`${path}: ${response.status()} ${await response.text()}`);return response.json()}
const stamp=Date.now(),name=`生产服务器 ${run}-${stamp}`,secondary=`拨测服务器 ${run}-${stamp}`;
async function screenshot(label){await page.screenshot({path:resolve(output,`${label}-${run}.png`),fullPage:true,animations:'disabled'})}
async function noOverflow(){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
try{
 const setup=await request('/setup');const account={name:'ingestion-qa',password:'local-ingestion-qa-password'};
 await request(setup.required?'/setup':'/auth/login',{method:'POST',data:account});
 await page.goto(base+'/agents');await expect(page.locator('.lm-agent-group-tabs').getByRole('tab').first()).toContainText('默认分组');await page.getByRole('button',{name:/新建分组/}).click();
 let dialog=page.getByRole('dialog',{name:'新建 Agent 分组',exact:true});
 await dialog.getByRole('textbox',{name:'分组名称',exact:true}).fill(name);
 await expect(dialog.getByRole('tab')).toHaveCount(4);
 await dialog.getByRole('switch',{name:'开启机器指标采集'}).click();await expect(dialog.getByText(/关闭后停止采集机器指标/)).toBeVisible();
 await dialog.getByRole('switch',{name:'开启机器指标采集'}).click();
 for(const checkbox of await dialog.getByRole('checkbox').all()){const label=await checkbox.getAttribute('value');if(label!=='memory'&&await checkbox.isChecked())await checkbox.uncheck()}
 await dialog.getByRole('spinbutton',{name:'采集间隔（秒）',exact:true}).fill('19');
 await screenshot('host-form');
 await dialog.getByRole('tab',{name:'拨测任务',exact:true}).click();await dialog.getByRole('button',{name:/添加拨测/}).click();
 await dialog.getByRole('textbox',{name:'拨测 1 任务名称',exact:true}).fill('网站健康检查');
 await dialog.getByRole('textbox',{name:'拨测 1 目标',exact:true}).fill('https://example.com/health');
 await dialog.getByRole('spinbutton',{name:'拨测 1 超时（秒）',exact:true}).fill('1.025');
 await dialog.getByRole('combobox',{name:'拨测 1 成功状态码',exact:true}).fill('204');await dialog.getByRole('combobox',{name:'拨测 1 成功状态码',exact:true}).press('Enter');await dialog.getByRole('combobox',{name:'拨测 1 成功状态码',exact:true}).press('Escape');
 await screenshot('probe-form');
 await dialog.getByRole('tab',{name:'目录日志',exact:true}).click();await dialog.getByRole('switch',{name:'开启目录日志采集'}).click();
 await dialog.getByRole('button',{name:/添加日志目录/}).click();await dialog.getByRole('textbox',{name:'日志目录 1 路径',exact:true}).fill('relative');
 await dialog.getByRole('button',{name:/保存配置/}).click();await expect(dialog.getByText(/填写服务器上的绝对目录路径/)).toBeVisible();
 await dialog.getByRole('textbox',{name:'日志目录 1 路径',exact:true}).fill('/var/log/nginx');await expect(dialog.getByText(/填写服务器上的绝对目录路径/)).toHaveCount(0);
 await dialog.getByRole('checkbox',{name:'日志目录 1 包含子目录',exact:true}).check();
 await dialog.getByRole('radio',{name:'仅采集新增内容',exact:true}).check();await screenshot('log-form');
 await dialog.getByRole('tab',{name:'上报配置',exact:true}).click();
 await dialog.getByRole('textbox',{name:'机器指标上报表',exact:true}).fill('machine_prod');
 await dialog.getByRole('textbox',{name:'拨测结果上报表',exact:true}).fill('check_prod');
 await dialog.getByRole('textbox',{name:'目录日志上报表',exact:true}).fill('log_bad');
 await dialog.getByRole('button',{name:/保存配置/}).click();await expect(dialog.getByText(/使用小写字母开头的逻辑表名/)).toBeVisible();
 await dialog.getByRole('textbox',{name:'目录日志上报表',exact:true}).fill('file_prod');
 let releaseSave;await page.route('**/api/v1/agent-groups',async route=>{if(route.request().method()==='POST'){await new Promise(resolve=>releaseSave=resolve);await route.fulfill({status:503,json:{error:'QA 保存失败，请重试'}})}else await route.continue()});
 await dialog.getByRole('button',{name:/保存配置/}).click();await expect(dialog.locator('button[type="submit"]')).toHaveClass(/ant-btn-loading/);await screenshot('saving');releaseSave();
 await expect(dialog.getByText('QA 保存失败，请重试')).toBeVisible();await expect(dialog.getByRole('textbox',{name:'目录日志上报表',exact:true})).toHaveValue('file_prod');
 await page.unroute('**/api/v1/agent-groups');await dialog.getByRole('button',{name:/保存配置/}).click();await expect(dialog).toBeHidden();
 const group=(await request('/agent-groups')).find(group=>group.name===name);expect(group.config.host_collectors).toEqual(['memory']);expect(group.config.collect_interval_seconds).toBe(19);
 expect(group.config.probes[0].timeout_ms).toBe(1025);expect(group.config.probes[0].expected_status).toEqual([204]);expect(group.config.log_sources).toEqual([{directory:'/var/log/nginx',pattern:'*.log*',recursive:true,from_beginning:false}]);
 checks.push('四个表单 Tab，机器开关/采集项、拨测秒数转换、目录日志选项、合法表名；失败保留输入后重试真实保存');
 await page.reload();await expect(page.getByRole('tab').filter({hasText:name})).toHaveAttribute('aria-selected','true');
 await page.getByRole('button',{name:/配置分组任务/}).click();dialog=page.getByRole('dialog',{name:`分组任务 · ${name}`,exact:true});await dialog.getByRole('tab',{name:'目录日志',exact:true}).click();
 await expect(dialog.getByRole('switch',{name:'开启目录日志采集'})).toBeChecked();await expect(dialog.getByRole('textbox',{name:'日志目录 1 路径',exact:true})).toHaveValue('/var/log/nginx');
 await dialog.getByRole('radio',{name:'从文件开头采集',exact:true}).check();await dialog.getByRole('button',{name:/保存配置/}).click();await expect(dialog).toBeHidden();
 const fresh=(await request('/agent-groups')).find(item=>item.id===group.id);expect(fresh.config.log_sources[0].from_beginning).toBe(true);expect(fresh.config.revision).not.toBe(group.config.revision);
 checks.push('刷新重新读取分组配置，编辑目录日志真实保存并更新版本');
 const keyResult=await request('/keys',{method:'POST',data:{name:`Agent test ${stamp}`,allow_all_tables:true,allowed_tables:[]}});const auth={Authorization:'Bearer '+keyResult.key};
 const nodes=[`node-a-${stamp}`,`node-b-${stamp}`];for(const node of nodes)await request('/agents/register',{method:'POST',headers:auth,data:{agent_id:node,hostname:node,platform:'linux',arch:'amd64',group_id:group.id,config_revision:fresh.config.revision}});
 const first=await request(`/agents/${nodes[0]}/config`,{headers:auth}),second=await request(`/agents/${nodes[1]}/config`,{headers:auth});expect(first.revision).toBe(second.revision);expect(first.log_table).toBe('file_prod');
 await page.getByRole('button',{name:/刷新/,exact:true}).click();await expect(page.getByRole('row').filter({hasText:nodes[0]}).getByText('已生效',{exact:true})).toBeVisible();await screenshot('groups');
 const other=await request('/agent-groups',{method:'POST',data:{name:secondary,config:{...fresh.config,host_enabled:false,logs_enabled:false,probes:[],host_table:'machine_other',probe_table:'check_other',log_table:'file_other'}}});
 await page.getByRole('button',{name:/刷新/,exact:true}).click();await page.getByRole('row').filter({hasText:nodes[0]}).getByRole('button',{name:/更改分组/}).click();
 dialog=page.getByRole('dialog',{name:`更改分组 · ${nodes[0]}`,exact:true});await dialog.getByRole('combobox',{name:'目标 Agent 分组'}).fill(secondary);await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:secondary}).click();await dialog.getByRole('button',{name:'保存分组',exact:true}).click();await expect(dialog).toBeHidden();
 await request(`/agents/${nodes[0]}/heartbeat`,{method:'POST',headers:auth,data:{agent_id:nodes[0],hostname:nodes[0],group_id:group.id}});expect((await request(`/agents/${nodes[0]}/config`,{headers:auth})).group_id).toBe(other.id);expect((await request(`/agents/${nodes[1]}/config`,{headers:auth})).group_id).toBe(group.id);
 await page.reload();await expect(page.getByRole('tab').filter({hasText:secondary})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('row').filter({hasText:nodes[0]})).toBeVisible();
 await page.getByRole('button',{name:/配置分组任务/}).click();dialog=page.getByRole('dialog',{name:`分组任务 · ${secondary}`,exact:true});await dialog.getByRole('tab',{name:'目录日志',exact:true}).click();await dialog.getByRole('button',{name:/保存配置/}).click();await expect(dialog).toBeHidden();expect((await request('/agent-groups')).find(item=>item.id===other.id).config.collect_interval_seconds).toBe(19);
 checks.push('两台 Agent 共享组任务；平台改组、旧分组心跳和刷新后保留平台分配，另一台继续原组');
 await page.getByRole('tab').filter({hasText:name}).click();await page.getByRole('button',{name:'接入此分组',exact:true}).click();
 await expect(page.getByRole('tab',{name:'Agent 接入',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByText(name,{exact:true})).toBeVisible();
 await expect(page.locator('[aria-label="Agent 安装命令"]')).toContainText(`--group-id '${group.id}'`);
 await page.getByRole('button',{name:'创建上报 Key',exact:true}).click();const keyName=`分组安装 ${stamp}`;await page.getByRole('textbox',{name:'新 Key 名称',exact:true}).fill(keyName);
 await page.locator('form button[type="submit"]').click();await expect(page.getByLabel('Agent 上报 Key',{exact:true})).toHaveValue(/^lm_/);
 const key=(await request('/keys')).find(item=>item.name===keyName);expect([...key.allowed_tables].sort()).toEqual(['machine_prod','check_prod','file_prod'].sort());
 await page.getByRole('button',{name:'复制安装命令',exact:true}).click();await expect(page.getByRole('button',{name:'已复制命令',exact:true})).toBeVisible();
 const command=await page.evaluate(()=>navigator.clipboard.readText());expect(command).toContain(`--group-id '${group.id}'`);expect(command).toContain('--key-stdin');expect(command).toContain('--endpoint');expect(command).not.toContain(await page.getByLabel('Agent 上报 Key',{exact:true}).inputValue());expect(command).toContain('systemd-ask-password');await page.getByRole('button',{name:'复制上报 Key',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(await page.getByLabel('Agent 上报 Key',{exact:true}).inputValue());
 expect(await page.locator('textarea').count()).toBe(0);await screenshot('install');checks.push('接入选择分组生成真实 CLI；新 Key 默认覆盖该组的三张表，命令使用隐藏输入接收 Key，单独复制 Key 可用，无需配置 JSON');
 for(const width of [750,390]){await page.setViewportSize({width,height:900});if(await page.locator('.lm-shell.is-nav-expanded').count())await page.locator('.lm-nav-collapse').click();await noOverflow();await screenshot(`install-${width}`);await page.goto(base+'/agents');await page.getByRole('button',{name:/新建分组/}).click();dialog=page.getByRole('dialog',{name:'新建 Agent 分组',exact:true});await dialog.getByRole('tab',{name:'目录日志',exact:true}).click();await dialog.getByRole('switch',{name:'开启目录日志采集'}).click();await dialog.getByRole('button',{name:/添加日志目录/}).click();await noOverflow();await screenshot(`form-${width}`);await dialog.getByRole('button',{name:/取\s*消/}).click();await page.goto(base+`/data?tab=agent&group=${group.id}`)}
 checks.push('1440 / 750 / 390 视口接入与目录表单无页面溢出');expect(errors).toEqual([]);
 await writeFile(resolve(output,`verification-${run}.json`),JSON.stringify({run,checks,pageErrors:errors,passed:true},null,2));
 console.log(JSON.stringify({run,passed:true,checks:checks.length}));
}catch(error){await screenshot('failure');await writeFile(resolve(output,`verification-${run}.json`),JSON.stringify({run,checks,pageErrors:errors,passed:false,error:String(error)},null,2));throw error}
finally{const video=page.video();await context.close();if(video&&run==='1'){await video.saveAs(resolve(output,'interaction-1.webm'));await video.delete()}await browser.close()}
