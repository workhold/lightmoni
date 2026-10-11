import type {Grid,Panel} from './model';
import {panelMinHeight} from './model';

export const columns=12,gap=10,rowHeight=40,rowStep=rowHeight+gap,maxRows=40;
export interface LayoutItem extends Grid{id:string;minH:number}
export interface PixelRect{x:number;y:number;width:number;height:number}
export function layoutItems(panels:Panel[]):LayoutItem[]{return panels.map(panel=>({...panel.grid,id:panel.id,minH:panelMinHeight(panel.type),h:Math.max(panel.grid.h,panelMinHeight(panel.type))}));}
export function columnStep(width:number):number{return (width+gap)/columns;}
export function toPixels(grid:Grid,width:number):PixelRect{return {x:grid.x*columnStep(width),y:grid.y*rowStep,width:grid.w*columnStep(width)-gap,height:grid.h*rowStep-gap};}
export function snapGrid(rect:PixelRect,origin:LayoutItem,width:number,mode:'move'|'resize'):Grid{
 const step=columnStep(width);
 if(mode==='move')return {x:Math.max(0,Math.min(columns-origin.w,Math.round(rect.x/step))),y:Math.max(0,Math.round(rect.y/rowStep)),w:origin.w,h:origin.h};
 return {x:origin.x,y:origin.y,w:Math.max(2,Math.min(columns-origin.x,Math.round((rect.width+gap)/step))),h:Math.max(origin.minH,Math.min(maxRows,Math.round((rect.height+gap)/rowStep)))};
}
export function overlaps(a:Grid,b:Grid):boolean{return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;}
/** Preview and commit use the same insertion rule. Only collisions move down; gaps stay intact. */
export function previewLayout(items:LayoutItem[],id:string,target:Grid):{items:LayoutItem[];displaced:string[]}{
 const active=items.find(item=>item.id===id);if(!active)return {items,displaced:[]};
 const placed:LayoutItem[]=[{...active,...target}],displaced:string[]=[];
 for(const source of items.filter(item=>item.id!==id).sort((a,b)=>a.y-b.y||a.x-b.x)){
  const item={...source};let collisions=placed.filter(other=>overlaps(item,other));
  while(collisions.length){item.y=Math.max(...collisions.map(other=>other.y+other.h));collisions=placed.filter(other=>overlaps(item,other));}
  if(item.y!==source.y)displaced.push(item.id);placed.push(item);
 }
 const byID=new Map(placed.map(item=>[item.id,item]));return {items:items.map(item=>byID.get(item.id)!),displaced};
}
export function layoutHeight(items:LayoutItem[]):number{return Math.max(120,...items.map(item=>(item.y+item.h)*rowStep));}
