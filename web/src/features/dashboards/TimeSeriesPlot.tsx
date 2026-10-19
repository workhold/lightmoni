import {useMonitoringI18n} from '../monitoring-i18n';
import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {Alert} from '../../shared/ui';
import type {TimeRange} from '../../shared/types';
import type {AlertRule,AlertEvent} from '../alerts/types';
import {axisScale,colorForSeries,formatValue,numeric,rightAxisRefs,thresholdsFor,valueMapping,type Panel} from './model';
import {alignTimeSeries} from './series-interaction';

type Props={panel:Panel;rows:Record<string,unknown>[];series:string[];hidden:string[];range?:TimeRange;dark:boolean;onBrush?:(from:number,to:number)=>void;alertRules:AlertRule[];alertEvents:AlertEvent[]};
type Threshold={value:number;color:string;label:string;side:'left'|'right'};

/** Cursor and selection live outside React; data refreshes update the same canvas. */
export default function TimeSeriesPlot(props:Props){
 const {l,language}=useMonitoringI18n();
 const localization=useRef({l,language});localization.current={l,language};

 const node=useRef<HTMLDivElement>(null),plot=useRef<uPlot|undefined>(undefined),current=useRef(props),tooltip=useRef<HTMLDivElement|undefined>(undefined),hover=useRef(false),[error,setError]=useState('');
 current.current=props;
 const data=useMemo(()=>alignTimeSeries(props.rows,props.series),[props.rows,props.series]);
 const prepared=useMemo(()=>{
  try{
   const right=rightAxisRefs(props.panel.options),sides=new Map(props.series.map(name=>[name,right.includes(String(props.rows.find(row=>row.__series===name)?.__refId))?'right':'left'] as const));
   const sideFor=(rule:AlertRule):'left'|'right'=>right.length&&(rule.panel_condition?.query_ref?right.includes(rule.panel_condition.query_ref):(props.panel.options.alert_rule_axes as Record<string,string>|undefined)?.[rule.id]==='right')?'right':'left';
   const lines:Threshold[]=props.panel.options.show_thresholds===false?[]:thresholdsFor(props.panel.options).map(item=>({...item,label:item.label??'',side:'left'}));
   if(props.panel.options.show_alert_thresholds!==false)for(const rule of props.alertRules.filter(item=>item.enabled&&item.operator!=='no_data')){const value=numeric(rule.threshold,props.panel.options.approximate===true,language);if(value!==null)lines.push({value,color:props.dark?'#ff738a':'#b42343',label:l("阈值"),side:sideFor(rule)});}
   const events=props.panel.options.show_alert_events===false?[]:props.alertEvents.filter(event=>Number.isFinite(Date.parse(event.created_at))&&(!props.range||Date.parse(event.created_at)>=Date.parse(props.range.from)&&Date.parse(event.created_at)<=Date.parse(props.range.to)));
   const scales=Object.fromEntries((right.length?['left','right']:['left']).map(side=>[side,axisScale(props.panel.options,side as 'left'|'right',props.rows.filter(row=>!props.hidden.includes(String(row.__series))&&sides.get(String(row.__series))===side),[...lines.filter(line=>line.side===side).map(line=>line.value),...events.filter(event=>{const rule=props.alertRules.find(item=>item.id===event.rule_id);return rule&&rule.operator!=='no_data'&&sideFor(rule)===side;}).map(event=>Number(event.state.value)).filter(Number.isFinite)],language)]));
   return {sides,scales,lines,events,error:''};
  }catch(cause){return {sides:new Map<string,'left'|'right'>(),scales:{},lines:[],events:[],error:(cause as Error).message};}
 },[props.panel.options,props.rows,props.series,props.hidden,props.alertRules,props.alertEvents,props.range?.from,props.range?.to,props.dark,language]);
 const latest=useRef({data,prepared});latest.current={data,prepared};
 const structure=JSON.stringify({series:props.series,type:props.panel.type,options:props.panel.options,dark:props.dark,sides:[...prepared.sides],error:prepared.error});

 useLayoutEffect(()=>{
  const host=node.current;if(!host||prepared.error)return;
  const {panel,series,dark}=current.current,options=panel.options,muted=dark?'#a6adba':'#64738a',grid=dark?'#2c3037':'#e8ebef',font='12px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const format=(value:unknown,side='left')=>formatValue(value,side==='right'?options.right_unit:options.unit,Number(options.decimals??2));
  const label=(name:string)=>String((options.series_aliases as Record<string,string>|undefined)?.[name]??name);
  const tip=document.createElement('div');tip.className='lm-series-tooltip';tip.hidden=true;tip.setAttribute('role','tooltip');document.body.appendChild(tip);tooltip.current=tip;
  const title=document.createElement('div');title.className='lm-series-tooltip-time';tip.appendChild(title);
  const cells=series.map((name,index)=>{const row=document.createElement('div');row.className='lm-series-tooltip-row';const dot=document.createElement('i');dot.style.background=colorForSeries(name,index,options);const text=document.createElement('span');text.textContent=label(name);const value=document.createElement('strong');row.append(dot,text,value);tip.appendChild(row);return {row,value};});
  const eventDetails=document.createElement('div');eventDetails.className='lm-series-tooltip-events';tip.appendChild(eventDetails);
  let lastIndex=-1,frame=0;
  function hide(){tip.hidden=true;}
  function cursor(chart:uPlot){
   const index=chart.cursor.idx;
   if(!hover.current||index==null||(chart.cursor.left??-1)<0||(chart.cursor.top??-1)<0){hide();return;}
   if(index!==lastIndex){lastIndex=index;title.textContent=new Date(Number(chart.data[0][index])).toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    for(let i=0;i<series.length;i++){const name=series[i],value=chart.data[i+1][index],mapped=valueMapping(value,options,localization.current.language);cells[i].value.textContent=mapped?.text??format(value,latest.current.prepared.sides.get(name));}
   }
   for(let i=0;i<series.length;i++)cells[i].row.hidden=current.current.hidden.includes(series[i]);
   const nearby=latest.current.prepared.events.filter(event=>Math.abs(chart.valToPos(Date.parse(event.created_at),'x')-(chart.cursor.left??0))<=8);eventDetails.hidden=!nearby.length;eventDetails.textContent=nearby.slice(0,3).map(event=>localization.current.l("{0} · {1}",event.kind==='firing'?localization.current.l("告警触发"):localization.current.l("告警恢复"),event.rule_name)).join('\n');
   tip.hidden=false;
   const bounds=chart.over.getBoundingClientRect(),x=bounds.left+(chart.cursor.left??0),y=bounds.top+(chart.cursor.top??0),width=tip.offsetWidth,height=tip.offsetHeight;
   const left=x+18+width>window.innerWidth-8?x-width-18:x+18;
   tip.style.transform=`translate3d(${Math.max(8,Math.min(window.innerWidth-width-8,left))}px,${Math.max(8,Math.min(window.innerHeight-height-8,y+16))}px,0)`;
  }
  function annotations(chart:uPlot){
   const {lines,events}=latest.current.prepared,ctx=chart.ctx,{left,top,width,height}=chart.bbox,ratio=uPlot.pxRatio;
   ctx.save();ctx.beginPath();ctx.rect(left,top,width,height);ctx.clip();ctx.font=`${11*ratio}px sans-serif`;
   const labels:number[]=[],compact=chart.width<400;
   for(const line of lines){const y=chart.valToPos(line.value,line.side,true);if(!Number.isFinite(y)||y<top||y>top+height)continue;ctx.strokeStyle=line.color;ctx.lineWidth=ratio;ctx.setLineDash([4*ratio,4*ratio]);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+width,y);ctx.stroke();if(labels.every(value=>Math.abs(value-y)>16*ratio)){ctx.fillStyle=line.color;ctx.textAlign='right';ctx.fillText(localization.current.l("{0}{1}",compact?'':(line.label||localization.current.l("阈值"))+' ',format(line.value,line.side)),left+width-4*ratio,Math.max(top+12*ratio,y-5*ratio));labels.push(y);}}
   let lastLabel=-Infinity;
   for(const event of [...events].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))){const x=chart.valToPos(Date.parse(event.created_at),'x',true),color=event.kind==='firing'?(dark?'#ff738a':'#b42343'):(dark?'#9ed68d':'#27713b');if(x<left||x>left+width)continue;ctx.strokeStyle=color;ctx.lineWidth=ratio;ctx.setLineDash([3*ratio,4*ratio]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+height);ctx.stroke();if(x-lastLabel>48*ratio){ctx.textAlign='left';ctx.fillStyle=color;ctx.fillText(event.kind==='firing'?localization.current.l("触发"):localization.current.l("恢复"),Math.min(x+4*ratio,left+width-28*ratio),top+height-6*ratio);lastLabel=x;}
    const rule=current.current.alertRules.find(rule=>rule.id===event.rule_id),right=rightAxisRefs(options),side=rule?.panel_condition?.query_ref&&right.includes(rule.panel_condition.query_ref)?'right':'left',value=Number(event.state.value);if(rule?.operator!=='no_data'&&event.state.value!==null&&Number.isFinite(value)){const y=chart.valToPos(value,side,true);if(Number.isFinite(y)){ctx.setLineDash([]);ctx.fillStyle=color;ctx.strokeStyle=dark?'#181b1f':'#fff';ctx.beginPath();ctx.arc(x,y,4*ratio,0,Math.PI*2);ctx.fill();ctx.stroke();}}
   }
   ctx.restore();
  }
  const scales:uPlot.Scales={x:{time:true,range:()=>{const r=current.current.range;return r?[Date.parse(r.from),Date.parse(r.to)]:[latest.current.data[0][0],latest.current.data[0].at(-1)!+1];}}};
  const axes:uPlot.Axis[]=[{scale:'x',stroke:muted,font,size:28,gap:8,space:80,grid:{show:false},ticks:{show:false},values:(_chart,splits)=>splits.map(value=>new Date(value).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',...(current.current.range&&Date.parse(current.current.range.to)-Date.parse(current.current.range.from)<120000?{second:'2-digit'}:{}),hour12:false}))}];
  for(const [side,scale] of Object.entries(prepared.scales)){scales[side]={distr:scale.type==='log'?3:1,range:()=>latest.current.prepared.scales[side].domain as [number,number]};axes.push({scale:side,side:side==='right'?1:3,stroke:muted,font,size:(_chart,values)=>Math.min(110,Math.max(42,...(values??[]).map(value=>String(value).length*7+12))),gap:8,space:40,grid:{show:side==='left',stroke:grid,width:1},ticks:{show:false},values:(_chart,splits)=>splits.map(value=>format(value,side))});}
  const interpolate=String(options.line_interpolation??'linear'),paths=interpolate==='smooth'?uPlot.paths.spline?.():interpolate==='stepBefore'?uPlot.paths.stepped?.({align:-1}):interpolate==='stepAfter'?uPlot.paths.stepped?.({align:1}):undefined;
  let chart:uPlot;
  try{chart=new uPlot({width:Math.max(80,host.clientWidth),height:Math.max(60,host.clientHeight),ms:1,padding:[14,12,0,4],scales,axes,legend:{show:false},series:[{},...series.map((name,index)=>{const color=colorForSeries(name,index,options);return {label:label(name),scale:prepared.sides.get(name),stroke:color,width:Number(options.line_width??1.5),show:!current.current.hidden.includes(name),spanGaps:options.null_mode==='connect',paths,points:{show:options.show_points===true,size:4},...(panel.type==='area'?{fill:color.startsWith('#')&&color.length===7?color+'33':color,fillTo:(u:uPlot)=>Math.max(Number(u.scales[prepared.sides.get(name)!].min),0)}:{})};})],cursor:{x:true,y:false,lock:false,points:{size:6,width:1},drag:{x:!!current.current.onBrush,y:false,setScale:false,dist:8},sync:{key:host.closest('.lm-panel-workbench,.lm-panel-viewer')?'lightmoni-panel-preview':'lightmoni-dashboard',setSeries:false,scales:['x',null],filters:{pub:type=>type==='mousemove'||type==='mouseleave',sub:type=>type==='mousemove'||type==='mouseleave'}},bind:{dblclick:()=>event=>{event.preventDefault();const r=current.current.range;if(r&&current.current.onBrush){const from=Date.parse(r.from),to=Date.parse(r.to),span=to-from;current.current.onBrush(from-span/2,to+span/2);}return null;}}},hooks:{setData:[()=>{lastIndex=-1;hide();}],setCursor:[cursor],setSelect:[chart=>{if(!hover.current||chart.select.width<8)return;const from=chart.posToVal(chart.select.left,'x'),to=chart.posToVal(chart.select.left+chart.select.width,'x');chart.setSelect({left:0,top:0,width:0,height:0},false);hide();if(from<to)current.current.onBrush?.(from,to);}],draw:[annotations]}},latest.current.data,host);plot.current=chart;host.dataset.chartInstance=crypto.randomUUID();host.dataset.chartRenderer='uplot';host.dataset.chartCommits='1';setError('');}
  catch(cause){tip.remove();setError((cause as Error).message);return;}
  const enter=()=>{hover.current=true;lastIndex=-1;},leave=()=>{hover.current=false;hide();};chart.over.addEventListener('mouseenter',enter);chart.over.addEventListener('mouseleave',leave);window.addEventListener('scroll',leave,true);
  const observer=new ResizeObserver(()=>{if(frame)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{frame=0;if(host.closest('.lm-layout-interacting'))return;const width=Math.max(80,host.clientWidth),height=Math.max(60,host.clientHeight);if(width!==chart.width||height!==chart.height){chart.setSize({width,height});hide();}});});observer.observe(host);
  return()=>{observer.disconnect();if(frame)cancelAnimationFrame(frame);window.removeEventListener('scroll',leave,true);chart.over.removeEventListener('mouseenter',enter);chart.over.removeEventListener('mouseleave',leave);chart.destroy();plot.current=undefined;tip.remove();tooltip.current=undefined;hover.current=false;};
 // Recreate only for visual configuration. Rows/range/visibility update below.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[structure]);
 useLayoutEffect(()=>{const chart=plot.current,host=node.current;if(!chart||!host||prepared.error)return;try{chart.batch(()=>{for(let index=0;index<props.series.length;index++)chart.setSeries(index+1,{show:!props.hidden.includes(props.series[index])},false);chart.setData(data);});host.dataset.chartCommits=String(Number(host.dataset.chartCommits??0)+1);tooltip.current?.setAttribute('hidden','');setError('');}catch(cause){setError((cause as Error).message);}},[data,prepared,props.hidden,props.range?.from,props.range?.to,structure]);
 return <>{(prepared.error||error)&&<Alert type="error" showIcon title={prepared.error||error}/>}<div ref={node} className="lm-chart-canvas lm-uplot-chart" aria-label={l("{0} 时间序列图",props.panel.title)}/></>;
}
