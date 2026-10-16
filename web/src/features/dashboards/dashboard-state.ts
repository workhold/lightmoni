import type {Dashboard,DashboardLink,DashboardRow,Panel,Values,Variable} from './model';
import type {TimeRange} from '../../shared/types';
import {layoutItems,overlaps,previewLayout} from './layout';

export function readVariableValues(variables:Variable[],params:URLSearchParams,fallback:Values={}):Values {
 return Object.fromEntries(variables.map(variable=>{
  if(variable.type==='constant')return [variable.name,String(variable.value??'')];
  const supplied=variable.skip_url_sync?[]:params.getAll(`var-${variable.name}`);
  const value=supplied.length?supplied:fallback[variable.name]??variable.value??(variable.multi?[]:variable.options?.[0]??'');
  return [variable.name,variable.multi?(Array.isArray(value)?value.map(String):[String(value)]):String(Array.isArray(value)?value[0]??'':value)];
 }));
}
export function writeVariableValues(params:URLSearchParams,variables:Variable[],values:Values):URLSearchParams {
 const next=new URLSearchParams(params);
 for(const variable of variables){next.delete(`var-${variable.name}`);if(variable.skip_url_sync||variable.type==='constant')continue;const value=values[variable.name];if(value===undefined)continue;for(const item of Array.isArray(value)?value:[value])next.append(`var-${variable.name}`,item);if(Array.isArray(value)&&!value.length)next.append(`var-${variable.name}`,'');}
 return next;
}
export function refreshSeconds(value:string|null,fallback=0):number {
 if(value===null)return fallback;if(value==='off'||value==='0')return 0;
 const match=/^(\d+)(s|m|h)?$/.exec(value);if(!match)return fallback;
 const seconds=Number(match[1])*({s:1,m:60,h:3600}[match[2]??'s']??1);return seconds>=5&&seconds<=3600?seconds:fallback;
}
export function groupPanels(dashboard:Dashboard,rowID?:string):Panel[]{
 const ids=new Set(rowID?dashboard.rows?.find(row=>row.id===rowID)?.panel_ids??[]:dashboard.rows?.flatMap(row=>row.panel_ids)??[]);
 return dashboard.panels.filter(panel=>rowID?ids.has(panel.id):!ids.has(panel.id));
}
export function placePanel(dashboard:Dashboard,panel:Panel):Dashboard {
 const row=dashboard.rows?.find(row=>row.panel_ids.includes(panel.id)),peers=groupPanels(dashboard,row?.id),panels=peers.some(item=>item.id===panel.id)?peers.map(item=>item.id===panel.id?panel:item):[...peers,panel];
 const items=layoutItems(panels),target=items.find(item=>item.id===panel.id)!,placed=previewLayout(items,panel.id,target).items;
 return {...dashboard,panels:[...(dashboard.panels.some(item=>item.id===panel.id)?dashboard.panels:[...dashboard.panels,panel])].map(item=>{const grid=placed.find(grid=>grid.id===item.id);return item.id===panel.id?{...panel,grid:grid?{x:grid.x,y:grid.y,w:grid.w,h:grid.h}:panel.grid}:grid?{...item,grid:{x:grid.x,y:grid.y,w:grid.w,h:grid.h}}:item;})};
}
export function assignPanels(dashboard:Dashboard,rowID:string,ids:string[]):Dashboard {
 const moved=new Set(ids),previous=new Set(dashboard.rows?.find(row=>row.id===rowID)?.panel_ids??[]),affected=new Set<string|undefined>([rowID]);
 for(const id of new Set([...moved,...previous]))if(moved.has(id)!==previous.has(id))affected.add(dashboard.rows?.find(row=>row.panel_ids.includes(id))?.id);
 if([...previous].some(id=>!moved.has(id)))affected.add(undefined);
 const rows=(dashboard.rows??[]).map(row=>({...row,panel_ids:row.id===rowID?ids:row.panel_ids.filter(id=>!moved.has(id))}));
 const next:Dashboard={...dashboard,rows},grids=new Map<string,Panel['grid']>();
 // A row owns its grid. Start at zero and pack in reading order when membership
 // changes, so moving a chart cannot leave an entire empty viewport above it.
 for(const row of [undefined,...rows]){if(!affected.has(row?.id))continue;const placed:Panel['grid'][]=[];for(const panel of groupPanels(next,row?.id).sort((a,b)=>a.grid.y-b.grid.y||a.grid.x-b.grid.x)){const grid={...panel.grid,y:0};let collisions=placed.filter(other=>overlaps(grid,other));while(collisions.length){grid.y=Math.max(...collisions.map(other=>other.y+other.h));collisions=placed.filter(other=>overlaps(grid,other));}placed.push(grid);grids.set(panel.id,grid);}}
 return {...next,panels:next.panels.map(panel=>({...panel,grid:grids.get(panel.id)??panel.grid}))};
}
export function removeRow(dashboard:Dashboard,row:DashboardRow):Dashboard {
 const released=assignPanels(dashboard,row.id,[]);return {...released,rows:released.rows?.filter(item=>item.id!==row.id)};
}
export function copyDefinition(dashboard:Dashboard):Dashboard {
 const ids=new Map(dashboard.panels.map(panel=>[panel.id,crypto.randomUUID()]));
 return {...dashboard,id:'',revision:0,panels:dashboard.panels.map(panel=>({...structuredClone(panel),id:ids.get(panel.id)!})),rows:dashboard.rows?.map(row=>({...row,id:crypto.randomUUID(),panel_ids:row.panel_ids.map(id=>ids.get(id)!)}))};
}
export function interpolateTitle(text:string,values:Values):string {
 return text.replace(/\$\{([A-Za-z][\w]*)\}|\$([A-Za-z][\w]*)/g,(original,braced,plain)=>{const value=values[braced??plain];return value===undefined?original:Array.isArray(value)?value.includes('__all__')?'全部':value.join(', '):value;});
}
export function dashboardLinkURL(link:DashboardLink,range:TimeRange,variables:Variable[],values:Values,origin:string):string {
 const url=new URL(link.url,origin);if(!['http:','https:'].includes(url.protocol))throw new Error('链接地址无效');
 if(link.include_time){url.searchParams.set('from',range.from);url.searchParams.set('to',range.to);}
 if(link.include_variables)url.search=writeVariableValues(url.searchParams,variables,values).toString();
 return url.toString();
}
