import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const state=loadSource(new URL('./dashboard-state.ts',import.meta.url));
const {resolveRange}=loadSource(new URL('./model.ts',import.meta.url));
const variables=[{name:'service',type:'custom',value:'api'},{name:'host',type:'query',multi:true,value:['a']},{name:'secret',type:'text',skip_url_sync:true,value:'local'}];
const panel=(id,x,y)=>({id,title:id,type:'line',queries:[{refId:'A',sql:'SELECT 1'}],options:{},grid:{x,y,w:6,h:6}});
test('URL roundtrip preserves multi values, Unicode, empty values and unrelated parameters',()=>{
 const params=new URLSearchParams('from=now-6h&viewPanel=a&var-secret=ignored');
 const values={service:'订单 / api',host:['host a','b,c'],secret:'local'};
 const written=state.writeVariableValues(params,variables,values);
 assert.deepEqual(written.getAll('var-host'),['host a','b,c']);assert.equal(written.get('viewPanel'),'a');assert.equal(written.has('var-secret'),false);
 assert.deepEqual(state.readVariableValues(variables,written),values);
 assert.equal(state.writeVariableValues(params,variables,{service:''}).get('var-service'),'');
 assert.equal(state.readVariableValues(variables,params).secret,'local');
 assert.equal(state.readVariableValues([{name:'fixed',type:'constant',value:'configured'}],new URLSearchParams('var-fixed=injected'),{fixed:'old'}).fixed,'configured');
});
test('refresh units, epoch ranges and calendar ranges parse without silently changing defaults',()=>{
 assert.equal(state.refreshSeconds('1m'),60);assert.equal(state.refreshSeconds('off',10),0);assert.equal(state.refreshSeconds('bad',10),10);assert.equal(state.refreshSeconds('1s',10),10);
 assert.deepEqual(resolveRange({from:'1700000000000',to:'1700003600000'}),{from:'2023-11-14T22:13:20.000Z',to:'2023-11-14T23:13:20.000Z'});
});
test('group moves compact independent grids and never lose or duplicate panels',()=>{
 const dashboard={panels:[panel('a',0,0),panel('b',6,0),panel('c',0,6)],rows:[{id:'r',title:'服务',panel_ids:[]},{id:'s',title:'机器',panel_ids:['c']}],variables:[]};
 const grouped=state.assignPanels(dashboard,'r',['a','b']);assert.deepEqual(state.groupPanels(grouped,'r').map(p=>p.id),['a','b']);assert.equal(grouped.panels[0].grid.y,0);assert.equal(grouped.panels[1].grid.y,0);assert.equal(grouped.panels[2].grid.y,6);
 const moved=state.assignPanels(grouped,'r',['a','c']);assert.deepEqual(moved.rows[1].panel_ids,[]);assert.deepEqual(state.groupPanels(moved).map(p=>p.id),['b']);assert.equal(moved.panels.length,3);
 const ungrouped=state.removeRow(moved,moved.rows[0]);assert.equal(ungrouped.panels.length,3);assert.equal(ungrouped.rows.length,1);assert.equal(state.groupPanels(ungrouped).length,3);assert.equal(dashboard.rows[0].panel_ids.length,0);
});
test('editing a grouped panel never displaces a chart in another row',()=>{
 const dashboard={panels:[panel('a',0,0),panel('b',0,0)],rows:[{id:'r',title:'服务',panel_ids:['a']}],variables:[]};
 const changed=state.placePanel(dashboard,{...dashboard.panels[0],grid:{x:0,y:4,w:12,h:8}});assert.equal(changed.panels[1].grid.y,0);
});
test('copies remap row references and links carry filters without control parameters',()=>{
 const dashboard={id:'source',revision:2,panels:[panel('a',0,0)],rows:[{id:'r',title:'服务',panel_ids:['a']}],variables};const copied=state.copyDefinition(dashboard);assert.notEqual(copied.panels[0].id,'a');assert.equal(copied.rows[0].panel_ids[0],copied.panels[0].id);assert.notEqual(copied.rows[0].id,'r');
 const url=new URL(state.dashboardLinkURL({url:'/dashboards/target?other=keep',title:'下钻',include_time:true,include_variables:true},{from:'now-1h',to:'now'},variables,{service:'a&b',host:['x','y'],secret:'hidden'},'http://localhost:5173'));
 assert.equal(url.searchParams.get('other'),'keep');assert.deepEqual(url.searchParams.getAll('var-host'),['x','y']);assert.equal(url.searchParams.get('var-service'),'a&b');assert.equal(url.searchParams.has('var-secret'),false);
 assert.throws(()=>state.dashboardLinkURL({url:'javascript:alert(1)'},{from:'now-1h',to:'now'},[],{},'http://localhost'));
 assert.equal(state.interpolateTitle('服务 $service / ${host}',{service:'订单',host:['x','y']}),'服务 订单 / x, y');
});
