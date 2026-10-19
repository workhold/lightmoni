import {useMonitoringI18n} from '../monitoring-i18n';
import {Children,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
import {Leafer,Group,Rect,Line,DragEvent,PointerEvent as LeaferPointerEvent} from 'leafer-ui';
import {columnStep,columns,gap,rowStep,maxRows,toPixels,snapGrid,previewLayout,layoutHeight,type LayoutItem,type PixelRect} from './layout';

interface Gesture{item:LayoutItem;mode:'move'|'resize';pointer:number;start:{x:number;y:number};last:{x:number;y:number};base:PixelRect;source:LayoutItem[];preview:LayoutItem[];displaced:string[];snapKey?:string;chart?:{node:HTMLElement;width:number;height:number;style:string};moved:boolean;cancelled:boolean;frames:number}
interface Scene{engine:Leafer;world:Group;grid:Group;ghost:Rect;selection:Rect;targets:Map<string,Rect>;offset:number;frame:number;gesture?:Gesture}

/** Leafer owns the gesture/preview scene; React sees one grid commit at pointer-up. */
export default function LeaferLayout({items,editing,onCommit,onInteractionChange,onPanelEdit,children}:{items:LayoutItem[];editing:boolean;onCommit:(items:LayoutItem[])=>void;onInteractionChange?:(active:boolean)=>void;onPanelEdit?:(id:string)=>void;children:ReactNode}){
 const {l,language}=useMonitoringI18n();

 const stage=useRef<HTMLDivElement>(null),canvas=useRef<HTMLDivElement>(null),feedback=useRef<HTMLDivElement>(null),scene=useRef<Scene|undefined>(undefined),current=useRef({items,editing,onCommit,onInteractionChange,onPanelEdit}),[width,setWidth]=useState(0);
 const compact=width>0&&width<600,canvasEditing=editing&&!compact;
 let row=0;const displayed=compact?[...items].sort((a,b)=>a.y-b.y||a.x-b.x).map(item=>{const next={...item,x:0,y:row,w:columns};row+=item.h;return next;}):items;
 const displayByID=new Map(displayed.map(item=>[item.id,item]));
 current.current={items,editing:canvasEditing,onCommit,onInteractionChange,onPanelEdit};const signature=JSON.stringify(items),nodes=Children.toArray(children),height=layoutHeight(displayed);
 function element(id:string){return stage.current?.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);}
 function position(item:LayoutItem){const node=element(item.id);if(!node)return;const rect=toPixels(displayByID.get(item.id)??item,width);node.style.width=`${rect.width}px`;node.style.height=`${rect.height}px`;node.style.transform=`translate3d(${rect.x}px,${rect.y}px,0)`;node.classList.remove('lm-layout-active','lm-layout-displaced');}
 function drawViewport(){
  const s=scene.current,root=stage.current,view=canvas.current;if(!s||!root||!view)return;
  const bounds=root.getBoundingClientRect(),full=root.offsetHeight,viewHeight=Math.min(Math.max(120,window.innerHeight),full),offset=Math.max(0,Math.min(full-viewHeight,-bounds.top));
  view.style.transform=`translateY(${offset}px)`;view.style.height=`${viewHeight}px`;s.world.y=-offset;
  if(s.engine.width!==width||s.engine.height!==viewHeight)s.engine.resize({width,height:viewHeight});
  if(s.offset!==offset||!s.grid.children.length){s.offset=offset;s.grid.clear();for(let x=0;x<=columns;x++)s.grid.add(new Line({points:[x*columnStep(width),offset,x*columnStep(width),offset+viewHeight],stroke:'#b9cbed',strokeWidth:1,opacity:0.32,hittable:false}));for(let y=Math.floor(offset/rowStep)*rowStep;y<offset+viewHeight;y+=rowStep)s.grid.add(new Line({points:[0,y,width,y],stroke:'#b9cbed',strokeWidth:1,opacity:0.22,hittable:false}));}
 }
 function restore(gesture?:Gesture){for(const item of current.current.items)position(item);if(gesture?.chart)gesture.chart.node.style.cssText=gesture.chart.style;if(stage.current){stage.current.style.height=`${layoutHeight(current.current.items)}px`;stage.current.classList.remove('lm-layout-interacting');stage.current.dataset.layoutGesture='idle';}if(feedback.current)feedback.current.hidden=true;const s=scene.current;if(s){s.ghost.visible=false;s.selection.visible=false;for(const item of current.current.items)s.targets.get(item.id)?.set(toPixels(item,width));}drawViewport();}
 function finish(commit:boolean){
  const s=scene.current,g=s?.gesture;if(!s||!g)return;
  if(s.frame){cancelAnimationFrame(s.frame);s.frame=0;}if(commit&&!g.cancelled&&g.moved)paint();if(s.frame){cancelAnimationFrame(s.frame);s.frame=0;}
  const next=g.preview;s.gesture=undefined;current.current.onInteractionChange?.(false);
  if(stage.current){stage.current.dataset.dragFrameCount=String(g.frames);stage.current.dataset.layoutGesture='idle';}
  restore(g);if(stage.current&&stage.current.clientWidth!==width)setWidth(stage.current.clientWidth);if(commit&&!g.cancelled&&g.moved&&JSON.stringify(next)!==JSON.stringify(g.source)){if(stage.current)stage.current.dataset.layoutCommits=String(Number(stage.current.dataset.layoutCommits??0)+1);current.current.onCommit(next);}
 }
 function paint(){
  const s=scene.current,g=s?.gesture,root=stage.current;if(!s||!g||!root)return;s.frame=0;
  const bounds=root.getBoundingClientRect(),dx=g.last.x-bounds.left-g.start.x,dy=g.last.y-bounds.top-g.start.y;
  const raw:PixelRect=g.mode==='move'?{...g.base,x:Math.max(0,Math.min(width-g.base.width,g.base.x+dx)),y:Math.max(0,g.base.y+dy)}:{...g.base,width:Math.max(2*columnStep(width)-gap,Math.min(width-g.base.x,g.base.width+dx)),height:Math.max(g.item.minH*rowStep-gap,Math.min(maxRows*rowStep-gap,g.base.height+dy))};
  const target=snapGrid(raw,g.item,width,g.mode),key=[target.x,target.y,target.w,target.h].join(','),changed=g.snapKey!==key,preview=changed?previewLayout(g.source,g.item.id,target):{items:g.preview,displaced:g.displaced};g.preview=preview.items;g.displaced=preview.displaced;g.snapKey=key;g.frames++;
  const node=element(g.item.id);if(node){node.style.transform=`translate3d(${raw.x}px,${raw.y}px,0)`;if(g.mode==='resize'){node.style.width=`${raw.width}px`;node.style.height=`${raw.height}px`;if(g.chart){const chart=g.chart;chart.node.style.transform=`scale(${Math.max(1,raw.width-g.base.width+chart.width)/chart.width},${Math.max(1,raw.height-g.base.height+chart.height)/chart.height})`;}}node.classList.add('lm-layout-active');}
  if(changed)for(const item of preview.items){if(item.id===g.item.id)continue;const original=g.source.find(source=>source.id===item.id)!,other=element(item.id);if(!other)continue;const rect=toPixels(item,width);other.style.transform=`translate3d(${rect.x}px,${rect.y}px,0)`;other.classList.toggle('lm-layout-displaced',item.y!==original.y);}
  const snapped=toPixels(target,width);if(changed)s.ghost.set({...snapped,visible:true,stroke:preview.displaced.length?'#c28b27':'#3974f0',fill:preview.displaced.length?'#6f531744':'#274e7844'});s.selection.set({...raw,visible:true});
  if(feedback.current){feedback.current.hidden=false;feedback.current.textContent=l("{0} × {1} · {2} × {3} px{4}",target.w,target.h,Math.round(raw.width),Math.round(raw.height),preview.displaced.length?l(" · {0} 个面板下移",preview.displaced.length):l(" · 网格吸附"));feedback.current.style.transform=`translate3d(${Math.max(0,Math.min(width-280,raw.x+8))}px,${raw.y+raw.height+7}px,0)`;}
  const nextHeight=`${Math.max(layoutHeight(g.source),layoutHeight(preview.items),raw.y+raw.height+45)}px`;if(root.style.height!==nextHeight)root.style.height=nextHeight;root.dataset.dragFrameCount=String(g.frames);drawViewport();
  // Scroll only while the pointer is held near a visible canvas edge.
  const bottom=Math.min(window.innerHeight,root.getBoundingClientRect().bottom),velocity=g.last.y>bottom-45?Math.min(15,(g.last.y-bottom+45)/3):g.last.y<45&&bounds.top<0?-Math.min(15,(45-g.last.y)/3):0;
  if(velocity&&g.moved){const before=window.scrollY;window.scrollBy(0,velocity);if(window.scrollY!==before)s.frame=requestAnimationFrame(paint);}
 }
 function schedule(){const s=scene.current;if(s&&!s.frame)s.frame=requestAnimationFrame(paint);}
 function point(event:{clientX:number;clientY:number}){const bounds=stage.current!.getBoundingClientRect();return {x:event.clientX-bounds.left,y:event.clientY-bounds.top-(scene.current?.offset??0),buttons:1};}
 function down(event:ReactPointerEvent<HTMLDivElement>){
  const s=scene.current;if(!current.current.editing||!s||event.button!==0||s.gesture)return;
  const target=event.target instanceof Element?event.target:null,handle=target?.closest('.lm-panel-resize'),title=target?.closest('.lm-panel-drag');if(!handle&&!title)return;if(!handle&&target?.closest('button,input,textarea,a'))return;
  const id=target?.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId,item=current.current.items.find(item=>item.id===id);if(!item)return;
  event.preventDefault();event.stopPropagation();const bounds=stage.current!.getBoundingClientRect();s.gesture={item,mode:handle?'resize':'move',pointer:event.pointerId,start:{x:event.clientX-bounds.left,y:event.clientY-bounds.top},last:{x:event.clientX,y:event.clientY},base:toPixels(item,width),source:current.current.items.map(item=>({...item})),preview:current.current.items,displaced:[],moved:false,cancelled:false,frames:0};
  if(handle){const node=element(item.id)?.querySelector<HTMLElement>('.lm-chart-content');if(node){const box=node.getBoundingClientRect();s.gesture.chart={node,width:box.width,height:box.height,style:node.style.cssText};node.style.width=`${box.width}px`;node.style.height=`${box.height}px`;node.style.flex='none';node.style.transformOrigin='0 0';node.style.willChange='transform';}}
  current.current.onInteractionChange?.(true);stage.current!.setPointerCapture(event.pointerId);stage.current!.classList.add('lm-layout-interacting');stage.current!.dataset.layoutGesture='pending';if(handle instanceof HTMLElement)handle.focus();
  // Official Leafer interaction bridge preserves native chart/control events elsewhere.
  s.engine.interaction!.pointerDown(point(event));
 }
 function move(event:ReactPointerEvent<HTMLDivElement>){const s=scene.current,g=s?.gesture;if(!s||!g||event.pointerId!==g.pointer)return;event.preventDefault();event.stopPropagation();g.last={x:event.clientX,y:event.clientY};s.engine.interaction!.pointerMove(point(event));}
 function up(event:ReactPointerEvent<HTMLDivElement>,cancel=false){const s=scene.current,g=s?.gesture;if(!s||!g||event.pointerId!==g.pointer)return;event.preventDefault();event.stopPropagation();g.last={x:event.clientX,y:event.clientY};g.cancelled=cancel;if(cancel)s.engine.interaction!.pointerCancel();else s.engine.interaction!.pointerUp(point(event));finish(!cancel);if(stage.current?.hasPointerCapture(event.pointerId))stage.current.releasePointerCapture(event.pointerId);}
 function resizeKey(id:string,key:string){if(!canvasEditing||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return;const item=items.find(item=>item.id===id)!;const target={...item,w:Math.max(2,Math.min(columns-item.x,item.w+(key==='ArrowRight'?1:key==='ArrowLeft'?-1:0))),h:Math.max(item.minH,Math.min(maxRows,item.h+(key==='ArrowDown'?1:key==='ArrowUp'?-1:0)))};onCommit(previewLayout(items,id,target).items);}
 useLayoutEffect(()=>{const root=stage.current;if(!root)return;const observer=new ResizeObserver(()=>{const next=root.clientWidth;if(next!==width&&!scene.current?.gesture)setWidth(next);});observer.observe(root);return()=>observer.disconnect();},[width]);
 useLayoutEffect(()=>{if(!width||scene.current?.gesture)return;for(const item of items)position(item);drawViewport();},[signature,width,editing]);
 useEffect(()=>{
  if(!canvasEditing||!width||!canvas.current)return;const engine=new Leafer({view:canvas.current,width,height:Math.min(height,window.innerHeight),type:'custom',pointSnap:false,cursor:false,keyEvent:false,trackChanges:false,pointer:{hover:false,dragDistance:2},move:{drag:false,dragEmpty:false,holdSpaceKey:false,holdMiddleKey:false,holdRightKey:false,autoDistance:0}}),world=new Group(),grid=new Group({hittable:false}),ghost=new Rect({visible:false,hittable:false,stroke:'#3974f0',strokeWidth:2,dashPattern:[6,4],cornerRadius:5}),selection=new Rect({visible:false,hittable:false,stroke:'#3974f0',strokeWidth:2,cornerRadius:5});
  engine.add(world);world.add(grid);const s:Scene={engine,world,grid,ghost,selection,targets:new Map(),offset:-1,frame:0};scene.current=s;
  const dragStart=()=>{const g=s.gesture;if(!g)return;g.moved=true;stage.current!.dataset.layoutGesture=g.mode;schedule();},drag=()=>schedule(),end=()=>finish(!s.gesture?.cancelled);
  const doubleTap=()=>{const g=s.gesture;if(g?.mode==='move'&&!g.moved)current.current.onPanelEdit?.(g.item.id);};
  for(const item of current.current.items){const rect=new Rect({...toPixels(item,width),fill:'#0000',hitBox:true});rect.on(DragEvent.START,dragStart);rect.on(DragEvent.DRAG,drag);rect.on(DragEvent.END,end);rect.on(LeaferPointerEvent.DOUBLE_TAP,doubleTap);world.add(rect);s.targets.set(item.id,rect);}world.add(ghost);world.add(selection);drawViewport();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&s.gesture){event.preventDefault();event.stopPropagation();s.gesture.cancelled=true;engine.interaction!.pointerCancel();finish(false);}},blur=()=>{if(s.gesture){s.gesture.cancelled=true;engine.interaction!.pointerCancel();finish(false);}},scroll=()=>drawViewport();document.addEventListener('keydown',escape,true);window.addEventListener('blur',blur);window.addEventListener('scroll',scroll,{passive:true});window.addEventListener('resize',scroll);
  return()=>{finish(false);if(s.frame)cancelAnimationFrame(s.frame);document.removeEventListener('keydown',escape,true);window.removeEventListener('blur',blur);window.removeEventListener('scroll',scroll);window.removeEventListener('resize',scroll);engine.destroy();scene.current=undefined;};
 },[canvasEditing,width]);
 useEffect(()=>{const s=scene.current;if(!s||s.gesture)return;for(const [id,rect] of s.targets)if(!items.some(item=>item.id===id)){rect.destroy();s.targets.delete(id);}for(const item of items){const existing=s.targets.get(item.id);if(existing)existing.set(toPixels(item,width));else{const rect=new Rect({...toPixels(item,width),fill:'#0000',hitBox:true});rect.on(DragEvent.START,()=>{if(s.gesture){s.gesture.moved=true;schedule();}});rect.on(DragEvent.DRAG,schedule);rect.on(DragEvent.END,()=>finish(!s.gesture?.cancelled));rect.on(LeaferPointerEvent.DOUBLE_TAP,()=>{const g=s.gesture;if(g?.mode==='move'&&!g.moved)current.current.onPanelEdit?.(g.item.id);});s.world.addAt(rect,1);s.targets.set(item.id,rect);}}},[signature,width,editing]);
 return <div ref={stage} className={`lm-leafer-layout ${canvasEditing?'lm-layout-editing':'lm-layout-view'} ${compact?'is-compact':''}`} data-layout-engine="leafer" data-layout-gesture="idle" style={{height}} onPointerDownCapture={down} onPointerMoveCapture={move} onPointerUpCapture={event=>up(event)} onPointerCancelCapture={event=>up(event,true)}>
  <div ref={canvas} className="lm-layout-canvas" aria-hidden="true"/><div ref={feedback} hidden className="lm-layout-feedback" role="status" aria-live="off"/>
  {width>0&&items.map((item,index)=>{const rect=toPixels(displayByID.get(item.id)??item,width);return <div key={item.id} data-panel-id={item.id} className="lm-layout-item" style={{width:rect.width,height:rect.height,transform:`translate3d(${rect.x}px,${rect.y}px,0)`}}>{nodes[index]}{canvasEditing&&<button type="button" className="lm-panel-resize" aria-label={l("调整面板大小")} title={l("拖动调整大小；方向键微调")} onKeyDown={event=>{if(event.key.startsWith('Arrow')){event.preventDefault();resizeKey(item.id,event.key);}}}><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 12 12 3M7 12l5-5M11 12l1-1" stroke="currentColor" strokeWidth="1.5"/></svg></button>}</div>;})}
 </div>;
}
