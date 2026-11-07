import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:19992',out=new URL('../../../../specs/100-registry-image-versions/evidence/',import.meta.url).pathname;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 for(let pass=1;pass<=3;pass++){
  await fetch(base+'/__qa/reset');const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/private-images');await expect(page.getByRole('heading',{name:'私有镜像管理',exact:true})).toBeVisible();
  const panel=page.locator('.lm-registry-images');await expect(panel.getByText('仓库中暂无镜像',{exact:true})).not.toBeVisible();
  const selectImage=async(name)=>{await panel.getByRole('combobox',{name:'镜像',exact:true}).click();await page.getByTitle(name,{exact:true}).click();};
  await selectImage('lightmoni/api');await expect(panel.getByText('v1.0',{exact:true})).toBeVisible();await expect(panel.getByRole('link',{name:'监控 API'})).toBeVisible();await expect(panel.getByText('未使用',{exact:true})).toBeVisible();
  await expect(panel.locator('.ant-spin-blur')).toHaveCount(0);if(pass===1){await page.screenshot({path:out+'versions-desktop.png',fullPage:true,animations:"disabled"});await page.evaluate(()=>document.documentElement.style.zoom='2');await page.screenshot({path:out+'versions-zoom.png',fullPage:true,animations:"disabled"});await page.evaluate(()=>document.documentElement.style.zoom='');}
  await panel.getByRole('button',{name:'下一页',exact:true}).click();await expect(panel.getByText('v0.1',{exact:true})).toBeVisible();await panel.getByRole('button',{name:'上一页',exact:true}).click();await expect(panel.getByText('v1.0',{exact:true})).toBeVisible();
  await selectImage('lightmoni/worker');await expect(panel.getByText('此镜像暂无版本',{exact:true})).toBeVisible();await selectImage('lightmoni/api');await expect(panel.getByText('v1.0',{exact:true})).toBeVisible();
  await fetch(base+'/__qa/fail');await panel.getByRole('button',{name:'刷新镜像',exact:true}).click();await expect(panel.getByText('仓库读取失败，请检查部署状态后重试。',{exact:true})).toBeVisible();await panel.getByRole('button',{name:/重\s*试/}).click();await expect(panel.getByText('v1.0',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'清理未使用版本',exact:true}).click();let modal=page.getByRole('dialog');await expect(modal.getByText(/当前镜像筛选不会限制清理范围/)).toBeVisible();await modal.getByRole('button',{name:/取\s*消/}).click();
  let calls=await(await fetch(base+'/__qa/calls')).json();expect(calls.filter(c=>c.path.endsWith('/cleanup')).length).toBe(0);
  await panel.getByRole('button',{name:'清理未使用版本',exact:true}).click();modal=page.getByRole('dialog');await expect(modal.getByRole('button',{name:'确认清理',exact:true})).toBeVisible();await expect(modal).toHaveCSS('opacity','1');if(pass===1)await page.screenshot({path:out+'cleanup-confirm.png',fullPage:true});
  await fetch(base+'/__qa/slow');await modal.getByRole('button',{name:'确认清理',exact:true}).click();await expect(panel.getByText('正在清理仓库，暂时暂停应用配置与发布。',{exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'清理未使用版本',exact:true})).toBeDisabled();
  await expect(panel.getByText('已删除 2 个摘要（2 个标签），保留 1 个使用中摘要，失败 0 项。',{exact:true})).toBeVisible();await expect(panel.getByText('v0.9',{exact:true})).not.toBeVisible();
  calls=await(await fetch(base+'/__qa/calls')).json();const clean=calls.filter(c=>c.path.endsWith('/cleanup'));expect(clean.length).toBe(1);expect(clean[0].body).toEqual({cluster_id:'qa-cluster',revision:1,confirmed:true});
  await page.reload();await selectImage('lightmoni/api');await expect(panel.getByText('v1.0',{exact:true})).toBeVisible();await expect(panel.getByText('v0.9',{exact:true})).not.toBeVisible();
  await panel.getByRole('button',{name:'清理未使用版本',exact:true}).click();await fetch(base+'/__qa/slow');await page.getByRole('dialog').getByRole('button',{name:'确认清理',exact:true}).click();await expect(panel.getByText('正在清理仓库，暂时暂停应用配置与发布。',{exact:true})).toBeVisible();await page.reload();await expect(panel.getByText('已删除 2 个摘要（2 个标签），保留 1 个使用中摘要，失败 0 项。',{exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'清理未使用版本',exact:true})).toBeEnabled();
  await fetch(base+'/__qa/partial');await panel.getByRole('button',{name:'清理未使用版本',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认清理',exact:true}).click();await expect(panel.getByText('已删除 1 个摘要（1 个标签），保留 1 个使用中摘要，失败 1 项。',{exact:true})).toBeVisible();
  await page.evaluate(()=>localStorage.setItem('lightmoni.language','en-US'));await page.reload();await expect(page.getByRole('heading',{name:'Images and versions',exact:true})).toBeVisible();
  if(pass===1){await page.setViewportSize({width:390,height:844});await panel.getByRole('combobox',{name:'Image',exact:true}).click();await page.getByTitle('lightmoni/api',{exact:true}).click();await expect(panel.getByText('v1.0',{exact:true})).toBeVisible();await expect(panel.getByRole('combobox',{name:'Image',exact:true})).toBeEnabled();await page.screenshot({path:out+'versions-mobile.png',fullPage:true,animations:"disabled"});}
  expect(errors).toEqual([]);await writeFile(out+`ui-pass-${pass}.json`,JSON.stringify({pass,checks:['deployment selector','repository filter','versions and app usage','pagination','empty image','read failure and retry','cancel avoids deletion','global cleanup confirmation','pending disables duplicate','confirmed result and refresh','English','reload persistence','resume cleanup after reload','partial failure remains warning'],pageErrors:errors},null,2));console.log('UI pass '+pass+' passed');await page.close();
 }
}finally{await browser.close();}
