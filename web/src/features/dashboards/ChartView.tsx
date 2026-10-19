import {useMonitoringI18n} from '../monitoring-i18n';
import {memo,useEffect,useMemo,useRef,useState} from 'react';
import {Chart} from '@antv/g2';
import {CaretDownOutlined,CaretUpOutlined} from '@ant-design/icons';
import {Alert,Button,ColorPicker,Empty,Space,Table,Tag,Tooltip} from '../../shared/ui';
import type {QueryResult,TimeRange} from '../../shared/types';
import {calculate,calculationName} from './statistics';
import {unitLabel} from './formatting';
import {ChartFrameBuffer,ChartRefreshQueue} from './chart-refresh';
import {retainHiddenSeries} from './panel-refresh';
import {canPlotTimeSeries,nextLegendSort,selectLegendSeries,sortLegendRows,type LegendSort} from './series-interaction';
import TimeSeriesPlot from './TimeSeriesPlot';
import {useAppearance} from '../../shared/appearance';
import type {AlertRule,AlertEvent} from '../alerts/types';
const emptyRules:AlertRule[]=[],emptyEvents:AlertEvent[]=[];
import {numeric,printable,resultFrames,thresholdsFor,thresholdColor,valueMapping,colorForSeries,displayedPoint,insertTimeGaps,timeBarRows,rightAxisRefs,axisScale,formatValue,histogramRows,timelineRows,pieRows,type Panel} from './model';

function ChartView({panel,results,onBrush,intervalMS=0,bucketedRefs=[],range,onColorChange,alertRules=emptyRules,alertEvents=emptyEvents}:{panel:Panel;results:QueryResult[];onBrush?:(from:number,to:number)=>void;intervalMS?:number;bucketedRefs?:string[];range?:TimeRange;onColorChange?:(name:string,color:string)=>void;alertRules?:AlertRule[];alertEvents?:AlertEvent[]}) {
 const {l,language}=useMonitoringI18n();

 const {dark}=useAppearance(),chartRef=useRef<Chart|undefined>(undefined),chartNode=useRef<HTMLDivElement|null>(null),renderQueue=useRef<ChartRefreshQueue<Record<string,unknown>>|undefined>(undefined),frameBuffer=useRef<ChartFrameBuffer|undefined>(undefined);
 function destroyChart(){renderQueue.current?.dispose();renderQueue.current=undefined;frameBuffer.current?.dispose();frameBuffer.current=undefined;chartRef.current?.destroy();chartRef.current=undefined;chartNode.current=null;}
 useEffect(()=>destroyChart,[]);
 const container=useRef<HTMLDivElement>(null),[renderError,setRenderError]=useState(''),[hidden,setHidden]=useState<string[]>([]),[narrow,setNarrow]=useState(false);
 const [contentNode,setContentNode]=useState<HTMLDivElement|null>(null),[contentWidth,setContentWidth]=useState(0);
 const [legendSort,setLegendSort]=useState<LegendSort>();
 useEffect(()=>{if(!contentNode)return;const measure=()=>setContentWidth(contentNode.clientWidth);measure();const observer=new ResizeObserver(measure);observer.observe(contentNode);return()=>observer.disconnect();},[contentNode]);
 const frames=useMemo(()=>resultFrames(results),[results,language]),bucketSignature=bucketedRefs.join(',');
 const prepared=useMemo(()=>{
  try {
   const rows:Record<string,unknown>[]=[];
   for(const {refId,frame} of frames)for(const row of frame.rows){
    const obj=Object.fromEntries(frame.columns.map((c,i)=>[c.name,row[i]]));
    const xName=String(panel.options.x??frame.columns[0]?.name??''),yName=String(panel.options.y??frame.columns.find(c=>/Int|Float|Decimal/.test(c.type))?.name??frame.columns[1]?.name??''),seriesName=String(panel.options.series??'');
    const type=frame.columns.find(c=>c.name===xName)?.type??'',isTime=/DateTime|^Date(?:32)?$|time/i.test(type);
    let x=obj[xName];if(isTime){x=Date.parse(String(x));if(!Number.isFinite(x))throw new Error(l("时间字段 {0} 包含无效时间",xName));}else if(/Int|Float|Decimal/.test(type))x=numeric(x,panel.options.approximate===true,language);
    const upperName=String(panel.options.upper??(panel.type==='timeline'?'end':'upper'));let upper=obj[upperName];
    if(panel.type==='histogram'&&panel.options.histogram_mode!=='auto'||panel.type==='timeline'&&panel.options.timeline_mode!=='auto'){
     if(upper===undefined)throw new Error(l("区间结束字段 {0} 不存在，请选择实际 SQL 字段",upperName));
     const upperType=frame.columns.find(c=>c.name===upperName)?.type??'';upper=/DateTime|^Date(?:32)?$/.test(upperType)?Date.parse(String(upper)):numeric(upper,panel.options.approximate===true,language);
     if(typeof upper!=='number'||!Number.isFinite(upper))throw new Error(l("区间结束值必须为有限数值或有效时间"));
    }
    const valueColumn=frame.columns.find(column=>column.name===yName);
    if(panel.type!=='timeline'&&(!valueColumn||(!/Int|Float|Decimal|Number|Double/i.test(valueColumn.type)&&obj[yName]!==null)))throw new Error(l("数值字段 {0} 不存在或不是数值类型，请检查映射或在 SQL 中转换",yName));
    const y=panel.type==='timeline'?null:numeric(obj[yName],panel.options.approximate===true,language),series=(panel.queries.length>1?`${refId} · `:'')+(seriesName?printable(obj[seriesName]):yName);
    rows.push({...obj,__x:x,__y:displayedPoint(y,panel.options),__rawY:obj[yName],__isTime:isTime,__upper:upper,__series:series,__refId:refId,__threshold_color:thresholdColor(y,panel.options,language)});
   }
   const displayRows=panel.type==='histogram'&&panel.options.histogram_mode==='auto'?histogramRows(rows,Number(panel.options.bin_count??20)):panel.type==='timeline'&&panel.options.timeline_mode==='auto'?timelineRows(rows,intervalMS||60000,language):panel.type==='pie'?pieRows(rows,String(panel.options.pie_reducer??'sum'),panel.options.approximate===true,language):insertTimeGaps(rows,intervalMS,String(panel.options.null_mode??'gap'),bucketSignature?bucketSignature.split(','):[],language);
   return {rows:displayRows,error:''};
  }catch(err){return {rows:[],error:(err as Error).message};}
 },[frames,panel.options,panel.type,panel.queries.length,intervalMS,bucketSignature,language]);
 const series=useMemo(()=>[...new Set(prepared.rows.map(row=>String(panel.type==='pie'?row.__x:row.__series)))].sort(),[prepared.rows,panel.type,language]);
 const fastTimeSeries=useMemo(()=>canPlotTimeSeries(prepared.rows,panel.type,panel.options),[prepared.rows,panel.type,panel.options,language]);
 const groupedSeries=useMemo(()=>new Map(series.map(name=>[name,prepared.rows.filter(row=>!row.__synthetic&&String(panel.type==='pie'?row.__x:row.__series)===name).sort((a,b)=>Number(a.__x)-Number(b.__x))])),[series,prepared.rows,panel.type,language]);
 const legendCalculations=(Array.isArray(panel.options.legend_calcs)?panel.options.legend_calcs:['lastNotNull','mean','max']) as string[];
 const resultComplete=results.every(result=>result.complete&&!result.truncated);
 const label=(name:string)=>String((panel.options.series_aliases as Record<string,string>|undefined)?.[name]??(series.length===1?panel.title:name));
 const legendRows=sortLegendRows(series.map((name,index)=>{const rows=groupedSeries.get(name)??[],values=rows.map(row=>row.__y as number|null);return {name,index,label:label(name),calculations:Object.fromEntries(legendCalculations.map(id=>{const value=calculate(values,id),unsafe=id==='sum'&&panel.options.approximate!==true&&values.every(value=>value===null||Number.isInteger(value))&&value!==null&&!Number.isSafeInteger(value);return [id,resultComplete&&!unsafe?value:null];}))};}),legendSort&&(legendSort.key==='name'||legendCalculations.includes(legendSort.key))?legendSort:undefined);
 const legendWidth=Math.max(180,Math.min(900,Number(panel.options.legend_width??Math.max(360,Math.min(640,Math.max(0,...series.map(name=>label(name).length))*6.5+legendCalculations.length*64+36))))),legendRight=panel.options.legend_position==='right'&&contentWidth>=Math.max(600,legendWidth+370);
 const seriesUnit=(name:string)=>rightAxisRefs(panel.options).includes(String(groupedSeries.get(name)?.[0]?.__refId))?(panel.options.right_unit??''):panel.options.unit;
 useEffect(()=>{setHidden(previous=>retainHiddenSeries(previous,series));},[series]);
 const thresholds=thresholdsFor(panel.options);
 const format=(value:unknown,unit=panel.options.unit)=>formatValue(value,unit,Number(panel.options.decimals??2));
 useEffect(()=>{
  if(fastTimeSeries||!container.current||['stat','table'].includes(panel.type)||prepared.error||!prepared.rows.length){destroyChart();return;}
  let disposed=false;
  if(chartNode.current!==container.current)destroyChart();
  const node=container.current,newInstance=!chartRef.current;
  const chart=chartRef.current??new Chart({container:node,autoFit:false,width:Math.max(1,node.clientWidth),height:Math.max(1,node.clientHeight)});
  chartRef.current=chart;chartNode.current=node;
  if(newInstance){
   node.dataset.chartInstance=crypto.randomUUID();
   const buffer=new ChartFrameBuffer(node);frameBuffer.current=buffer;
   renderQueue.current=new ChartRefreshQueue({
    before:()=>buffer.capture(),
    render:async spec=>{chart.options({...spec,autoFit:false,width:Math.max(1,node.clientWidth),height:Math.max(1,node.clientHeight)} as Parameters<Chart['options']>[0]);node.dataset.chartUpdates=String(Number(node.dataset.chartUpdates??0)+1);await chart.render();},
    committed:()=>{buffer.markReady();setRenderError('');node.dataset.chartCommits=String(Number(node.dataset.chartCommits??0)+1);},
    idle:success=>{if(success)buffer.release();},
    error:err=>setRenderError(String(err)),
   });
  }
  const queue=renderQueue.current!;
  const rows=prepared.rows.filter(row=>!hidden.includes(String(panel.type==='pie'?row.__x:row.__series)));
  if(!rows.length){queue.submit({type:'view',key:`panel-${panel.id}`,children:[],animate:false});return;}
  const type=panel.type==='timeseries'?'line':panel.type,isTime=rows.some(row=>row.__isTime===true),colors=series.map((name,index)=>colorForSeries(name,index,panel.options)),rightRefs=rightAxisRefs(panel.options),dual=['line','area','bar'].includes(type)&&rightRefs.length>0;
  if(isTime)rows.sort((a,b)=>Number(a.__x)-Number(b.__x));
  const formatTime=(value:unknown)=>{const ms=value instanceof Date?value.getTime():Number(value);return Number.isFinite(ms)?new Date(ms).toLocaleString(undefined,{...(narrow?{}:{month:'2-digit',day:'2-digit'}),hour:'2-digit',minute:'2-digit',hour12:false}):String(value);};
  const timeScale={type:'time',tickCount:narrow?3:5,...(range?{domain:[new Date(range.from),new Date(range.to)],nice:false}:{})};
  const supportsLines=['line','area','bar','histogram'].includes(type),showThresholds=panel.options.show_thresholds!==false;
  const sides=(panel.options.alert_rule_axes??{}) as Record<string,string>;
  const sideFor=(ruleID:string)=>{const ref=alertRules.find(rule=>rule.id===ruleID)?.panel_condition?.query_ref;return dual&&(ref?rightRefs.includes(ref):sides[ruleID]==='right')?'right':'left';};
  const events=alertEvents.filter(event=>{const time=Date.parse(event.created_at);return Number.isFinite(time)&&(!range||time>=Date.parse(range.from)&&time<=Date.parse(range.to));}).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  const yScales:Record<string,Record<string,unknown>>={};
  if(supportsLines){
   try{for(const side of (dual?['left','right']:['left']) as ('left'|'right')[]){
    const group=rows.filter(row=>!dual||rightRefs.includes(String(row.__refId))===(side==='right')),annotations=side==='left'&&showThresholds?thresholds.map(threshold=>threshold.value):[];
    if(['line','area','bar'].includes(type)){
     const add=(value:unknown)=>{try{const number=numeric(value,panel.options.approximate===true,language);if(number!==null)annotations.push(number);}catch{/* Invalid annotations are omitted from the plot. */}};
     if(panel.options.show_alert_thresholds!==false)for(const rule of alertRules.filter(rule=>rule.enabled&&rule.operator!=='no_data'&&sideFor(rule.id)===side))add(rule.threshold);
     if(isTime&&panel.options.show_alert_events!==false)for(const event of events.filter(event=>sideFor(event.rule_id)===side&&alertRules.find(rule=>rule.id===event.rule_id)?.operator!=='no_data'))add(event.state.value);
    }
    const scale=axisScale({...panel.options,stacked:type!=='histogram'&&panel.options.stacked===true},side,group,annotations,language);
    yScales[side]={...scale,tickCount:narrow?3:5,tickMethod:(min:number,max:number,count:number)=>Array.from({length:count},(_,index)=>scale.type==='log'?Math.exp(Math.log(min)+(Math.log(max)-Math.log(min))*index/(count-1)):min+(max-min)*index/(count-1))};
   }}catch(err){setRenderError((err as Error).message);destroyChart();return;}
  }
  // G2 5.4.8 computes a default bound but does not pass it into TooltipComponent.
  // Explicit bounds let right-edge shared tooltips flip left instead of being clipped.
  const tooltipBehavior={shared:true,crosshairs:type==='line'||type==='area',bounding:{x:0,y:0,width:container.current.clientWidth,height:Math.max(1,container.current.clientHeight)},css:{'.g2-tooltip':{transition:'visibility 0.1s ease'},'.g2-tooltip-list-item-name':{'max-width':narrow?'130px':'216px'},'.g2-tooltip-list-item-value':{'margin-left':narrow?'8px':'16px'}}};
  const options:Record<string,unknown>={data:rows,encode:{x:'__x',y:'__y',color:'__series'},scale:{color:{domain:series,range:colors},...(isTime?{x:timeScale}:{})},axis:{x:{title:false,...(isTime?{labelFormatter:formatTime,labelAutoRotate:false}:{})},y:{title:false,labelFormatter:(value:unknown)=>format(Number(value))}},legend:false,animate:false,tooltip:{title:(row:Record<string,unknown>)=>row.__isTime?new Date(Number(row.__x)).toLocaleString():printable(row.__x),items:[(row:Record<string,unknown>)=>{
   const mapped=valueMapping(row.__rawY,panel.options,language),unit=dual&&rightRefs.includes(String(row.__refId))?(panel.options.right_unit??''):panel.options.unit,text=mapped?l("{0}（原值 {1}）",mapped.text,printable(row.__rawY)):format(row.__rawY===null?null:row.__y,unit);
   return {name:label(printable(panel.type==='pie'?row.__x:row.__series)),value:panel.type==='pie'?`${text} (${((Number(row.__y)||0)/rows.reduce((sum,item)=>sum+(Number(item.__y)||0),0)*100).toFixed(1)}%)`:text,color:mapped?.color??colorForSeries(String(row.__series),series.indexOf(String(row.__series)),panel.options)};
  }]},interaction:{tooltip:tooltipBehavior}};
  if(type==='bar'){
   if(isTime){options.type='rect';options.data=timeBarRows(rows,bucketedRefs.length?intervalMS:0,panel.options.stacked===true);options.encode={x:'__bar_start',x1:'__bar_end',y:'__bar_lower',y1:'__bar_upper',color:'__series'};}else{options.type='interval';options.encode={...(options.encode as Record<string,unknown>),series:'__series'};options.transform=panel.options.stacked?[{type:'stackY'}]:[{type:'dodgeX'}];options.scale={color:{domain:series,range:colors},x:{type:'band'}};}
   if(panel.options.horizontal)options.coordinate={transform:[{type:'transpose'}]};
  }else if(type==='pie'){
   options.type='interval';options.encode={y:'__y',color:'__x'};options.scale={color:{domain:[...new Set(prepared.rows.map(row=>row.__x))],range:colors}};
   options.coordinate={type:'theta',innerRadius:panel.options.donut?0.65:0};options.transform=[{type:'stackY'}];options.legend=false;
   if(rows.every(row=>!row.__y)||rows.some(row=>(row.__y as number)<0)){setRenderError(l("饼图需要非负值且总和大于 0"));destroyChart();return;}
  }else if(type==='gauge'){
   const row=rows.at(-1)!,value=calculate(rows.filter(point=>!point.__synthetic&&point.__series===row.__series).map(point=>point.__y as number|null),String(panel.options.reducer??'lastNotNull')),min=Number(panel.options.min??0),max=Number(panel.options.max??100);
   if(max<=min||value===null){setRenderError(l("Gauge 需要有效数值，且最大值必须大于最小值"));destroyChart();return;}
   const cuts=thresholds.filter(t=>t.value>min&&t.value<max),mapped=valueMapping(row.__rawY,panel.options,language),activeColor=mapped?.color??thresholdColor(value,{...panel.options,base_color:panel.options.base_color??colorForSeries(String(row.__series),0,panel.options)},language);
   const endpoints=[...cuts.map(t=>t.value-min),max-min],bandColors=[thresholdColor(min,panel.options,language),...cuts.map(t=>t.color)];
   options.type='gauge';options.data={value:{target:Number(value)-min,total:max-min,name:panel.title,thresholds:endpoints}};
   options.scale={color:{domain:[...bandColors.map((_,i)=>i),'target','total'],range:[...bandColors,activeColor,'#343940']}};
   options.style={pointerStroke:activeColor,pinFill:activeColor,textFill:activeColor,textContent:()=>mapped?.text??format(Number(value))};delete options.encode;delete options.tooltip;
  }else if(type==='heatmap'){
   const categoryField=String(panel.options.series??'__series'),categories=[...new Set(rows.map(row=>printable(row[categoryField])))],times=[...new Set(rows.map(row=>Number(row.__x)))].sort((a,b)=>a-b),heatWidth=bucketedRefs.length?intervalMS:times.length>1?Math.min(...times.slice(1).map((x,i)=>x-times[i])):60000;if(isTime){options.type='rect';options.data=rows.filter(row=>typeof row.__y==='number').map(row=>({...row,__heat_end:Number(row.__x)+Math.max(1,heatWidth),__heat_y:categories.indexOf(printable(row[categoryField])),__heat_y1:categories.indexOf(printable(row[categoryField]))+1}));options.encode={x:'__x',x1:'__heat_end',y:'__heat_y',y1:'__heat_y1',color:'__y'};}else{options.type='cell';options.encode={x:'__x',y:categoryField,color:'__y'};}options.legend={color:{position:'bottom'}};
   options.scale={...(isTime?{x:timeScale,y:{type:'linear',domain:[0,categories.length],nice:false,tickMethod:()=>categories.map((_,i)=>i+0.5)}}:{}),...(thresholds.length?{color:{type:'threshold',domain:thresholds.map(t=>t.value),range:[thresholdColor(-Infinity,panel.options,language),...thresholds.map(t=>t.color)]}}:{})};
   options.axis={x:{title:false,...(isTime?{labelFormatter:formatTime,labelAutoRotate:false}:{})},y:{title:false,...(isTime?{labelFormatter:(v:unknown)=>categories[Math.floor(Number(v))]??'',grid:false}:{})}};
  }else if(type==='histogram'){options.type='rect';options.encode={x:'__x',x1:'__upper',y:'__y',color:'__series'};}
  else if(type==='timeline'){
   const stateField=String(panel.options.y??'state'),seriesField=String(panel.options.series??'__series'),states=[...new Set(rows.map(row=>printable(row[stateField])))],lanes=[...new Set(rows.map(row=>printable(row[seriesField])))];
   options.type='rect';options.data=rows.map(row=>({...row,__timeline_state:printable(row[stateField]),__lane_y:lanes.indexOf(printable(row[seriesField]))+0.15,__lane_y1:lanes.indexOf(printable(row[seriesField]))+0.85}));options.encode={x:'__x',x1:'__upper',y:'__lane_y',y1:'__lane_y1',color:'__timeline_state'};options.axis={x:{title:false,...(isTime?{labelFormatter:formatTime}:{})},y:{title:false,grid:false,labelFormatter:(value:unknown)=>lanes[Math.floor(Number(value))]??''}};
   options.scale={...(isTime?{x:timeScale}:{}),y:{type:'linear',domain:[0,lanes.length],nice:false,tickMethod:()=>lanes.map((_,index)=>index+0.5)},color:{type:'ordinal',domain:states,range:states.map((state,index)=>valueMapping(state,panel.options,language)?.color??colorForSeries(state,index,panel.options))}};
   options.tooltip={items:[(row:Record<string,unknown>)=>({name:printable(row.__series),value:valueMapping(row[stateField],panel.options,language)?.text??printable(row[stateField])})]};
  }else{options.type=type==='area'?'area':'line';options.style={connect:panel.options.null_mode==='connect',lineWidth:Number(panel.options.line_width??1.5)};options.shape=panel.options.line_interpolation==='smooth'?'smooth':panel.options.line_interpolation==='stepBefore'?'vh':panel.options.line_interpolation==='stepAfter'?'hv':type==='area'?'area':'line';if(panel.options.stacked)options.transform=[{type:'stackY'}];}
  if(['bar','histogram'].includes(type)&&panel.options.color_mode==='threshold'){
   options.encode={...(options.encode as Record<string,unknown>),color:'__threshold_color'};options.scale={...(options.scale as Record<string,unknown>),color:{type:'identity'}};
  }
  if(supportsLines)options.scale={...(options.scale as Record<string,unknown>),y:yScales.left};
  if(!dual&&type==='area'&&yScales.left.type==='log'&&panel.options.stacked){setRenderError(l("对数面积图不能堆叠，请使用线性尺度或折线图"));destroyChart();return;}
  if(!dual&&type==='bar'&&isTime&&yScales.left.type==='log')options.data=(options.data as Record<string,unknown>[]).map(row=>({...row,__bar_lower:Math.max(Number((yScales.left.domain as number[])[0]),Number(row.__bar_lower))}));
  if(type==='area'&&!panel.options.stacked)options.encode={...(options.encode as Record<string,unknown>),y1:()=>Math.max(Number((yScales.left.domain as number[])[0]),yScales.left.type==='log'?Number.MIN_VALUE:0)};
  const markers=['line','area'].includes(type)&&panel.options.show_points===true?[{type:'point',data:rows.filter(row=>typeof row.__y==='number'),encode:{x:'__x',y:'__y',color:'__series'},scale:options.scale,axis:options.axis,style:{r:2.2},tooltip:false,animate:false}]:[];
  const annotations=supportsLines&&showThresholds?thresholds.filter(t=>yScales.left.type!=='log'||t.value>0).map(t=>({type:'lineY',data:[{threshold:t.value}],encode:{y:'threshold'},style:{stroke:t.color,lineDash:[4,4],lineWidth:1.3},labels:[{text:t.label||format(t.value),position:'right',style:{fill:t.color,fontSize:11}}],tooltip:false})):[];
  let finalOptions:Record<string,unknown>=markers.length||annotations.length?{type:'view',data:rows,scale:options.scale,axis:options.axis,legend:false,animate:false,interaction:options.interaction,children:[options,...markers,...annotations]}:options;
  if(dual){
   try{
    const categories=[...new Set(rows.map(row=>printable(row.__x)))],children:Record<string,unknown>[]=[],scales=options.scale as Record<string,unknown>;
    for(const side of ['left','right'] as const){
     const group=rows.filter(row=>rightRefs.includes(String(row.__refId))===(side==='right'));if(!group.length)continue;
     const y=yScales[side],unit=side==='right'?(panel.options.right_unit??''):panel.options.unit,axis:Record<string,unknown>={...(options.axis as Record<string,unknown>),y:{position:side,title:false,grid:side==='left',labelFontSize:narrow?10:12,labelFormatter:(value:unknown)=>formatValue(Number(value),unit,narrow?0:Number(panel.options.decimals??2))}};
     const mark:Record<string,unknown>={...options,data:group,scale:{...scales,y},axis};
     if(type==='area')mark.style={...(options.style as Record<string,unknown>),fillOpacity:0.3};
     if(type==='bar'){
      const inputs=isTime?group:group.map(row=>({...row,__x:categories.indexOf(printable(row.__x))})),width=isTime?(bucketedRefs.length?intervalMS:0):1;
      let bars=timeBarRows(inputs,width,panel.options.stacked===true,series);
      if(panel.options.stacked===true)bars=bars.map(row=>{const middle=(Number(row.__bar_start)+Number(row.__bar_end))/2;return {...row,__bar_start:side==='left'?row.__bar_start:middle,__bar_end:side==='left'?middle:row.__bar_end};});
      if(y.type==='log'){const floor=(y.domain as number[])[0];bars=bars.map(row=>({...row,__bar_lower:Math.max(floor,Number(row.__bar_lower))}));}
      const barScales={...scales,color:side==='left'&&panel.options.color_mode==='threshold'?{type:'identity',key:'lightmoni-left-threshold-color'}:{type:'ordinal',key:'color',domain:series,range:colors}};
      mark.type='rect';mark.data=bars;mark.scale={...barScales,y};mark.encode={x:'__bar_start',x1:'__bar_end',y:'__bar_lower',y1:'__bar_upper',color:side==='left'&&panel.options.color_mode==='threshold'?'__threshold_color':'__series'};delete mark.transform;
      if(!isTime){mark.scale={...barScales,x:{type:'linear',domain:[0,categories.length],nice:false,tickMethod:()=>categories.map((_,i)=>i+0.5)},y};axis.x={title:false,labelFormatter:(value:unknown)=>categories[Math.floor(Number(value))]??'',labelAutoRotate:false};}
     }else if(type==='area'){
      if(y.type==='log'&&panel.options.stacked)throw new Error(l("对数面积图不能堆叠，请使用线性尺度或折线图"));
      if(!panel.options.stacked)mark.encode={...(mark.encode as Record<string,unknown>),y1:()=>Math.max(Number((y.domain as number[])[0]),y.type==='log'?Number.MIN_VALUE:0)};
     }
     children.push(mark);
     if(markers.length)children.push({...markers[0],data:group.filter(row=>typeof row.__y==='number'),scale:{...scales,y},axis});
     if(side==='left')children.push(...annotations.filter(annotation=>y.type!=='log'||Number(annotation.data[0].threshold)>0).map(annotation=>({...annotation,scale:{y},axis:{y:axis.y}})));
    }
    finalOptions={type:'view',data:rows,scale:{color:{type:'ordinal',domain:series,range:colors},...(isTime?{x:timeScale}:{})},legend:false,animate:false,interaction:options.interaction,coordinate:options.coordinate,...(narrow?{marginLeft:0,marginRight:0,paddingLeft:34,paddingRight:58}:{}),children};
   }catch(err){setRenderError((err as Error).message);destroyChart();return;}
  }
  if(['line','area','bar'].includes(type)){
   const alertRed=dark?'#ff738a':'#b42343',alertGreen=dark?'#9ed68d':'#27713b';
   const layers:Record<string,unknown>[]=[];
   const layerScale=(ruleID:string)=>({...(isTime?{x:timeScale}:{}),y:yScales[sideFor(ruleID)]});
   const layerAxis=(ruleID:string)=>{const side=sideFor(ruleID);return dual?{...(options.axis as Record<string,unknown>),y:{position:side,title:false,grid:side==='left',labelFontSize:narrow?10:12,labelFormatter:(value:unknown)=>format(value,side==='right'?panel.options.right_unit:panel.options.unit)}}:options.axis;};
   const thresholdLabelPositions:number[]=[],plotHeight=Math.max(60,node.clientHeight-50);
   if(panel.options.show_alert_thresholds!==false)for(const rule of alertRules.filter(rule=>rule.enabled&&rule.operator!=='no_data')){
    let value:number|null=null;try{value=numeric(rule.threshold,panel.options.approximate===true,language);}catch{}
    const scale=yScales[sideFor(rule.id)];if(value===null||scale.type==='log'&&value<=0)continue;
    const domain=scale.domain as number[],project=(number:number)=>scale.type==='log'?Math.log(number):number;
    const y=plotHeight*(1-(project(value)-project(domain[0]))/(project(domain[1])-project(domain[0])));
    const offsets=Array.from({length:alertRules.length*2+1},(_,index)=>index===0?-8:index%2?12+Math.floor(index/2)*20:-8-index/2*20);
    const dy=offsets.find(offset=>y+offset>=12&&y+offset<=plotHeight-4&&thresholdLabelPositions.every(position=>Math.abs(position-y-offset)>=24))??-8;
    thresholdLabelPositions.push(y+dy);
    layers.push({type:'lineY',data:[{threshold:value}],encode:{y:'threshold'},scale:layerScale(rule.id),axis:layerAxis(rule.id),style:{stroke:alertRed,lineDash:[5,4],lineWidth:1.6},labels:[{text:l("阈值 {0}",format(value,sideFor(rule.id)==='right'?panel.options.right_unit:panel.options.unit)),position:'right',style:{fill:alertRed,fontSize:12,fontWeight:600,dy}}],tooltip:false,animate:false});
   }
   if(isTime&&panel.options.show_alert_events!==false){
    const labelSpacing=range?(Date.parse(range.to)-Date.parse(range.from))*48/Math.max(120,container.current.clientWidth-80):0;let lastLabel=-Infinity;const labelIDs=new Set(events.filter(event=>{const time=Date.parse(event.created_at);if(time-lastLabel<labelSpacing)return false;lastLabel=time;return true;}).map(event=>event.id));
    for(const kind of ['firing','resolved']){const group=events.filter(event=>event.kind===kind),color=kind==='firing'?alertRed:alertGreen;if(!group.length)continue;
     layers.push({type:'lineX',data:group.map(event=>({time:Date.parse(event.created_at),label:labelIDs.has(event.id)?(kind==='firing'?l("触发"):l("恢复")):''})),encode:{x:'time'},scale:{x:timeScale},axis:{x:(options.axis as Record<string,unknown>).x},style:{stroke:color,lineDash:[3,4],lineWidth:1},labels:[{text:(datum:Record<string,unknown>)=>datum.label,position:'top',style:{fill:color,fontSize:12,fontWeight:600}}],tooltip:false,animate:false});
     for(const side of ['left','right']){const points=group.filter(event=>sideFor(event.rule_id)===side&&alertRules.find(rule=>rule.id===event.rule_id)?.operator!=='no_data').flatMap(event=>{let value:number|null=null;try{value=numeric(event.state.value,panel.options.approximate===true,language);}catch{}return value===null?[]:[{time:Date.parse(event.created_at),value,name:event.rule_name,state:kind==='firing'?l("告警触发"):l("告警恢复")}];});if(!points.length)continue;const ruleID=group.find(event=>sideFor(event.rule_id)===side)!.rule_id;
      layers.push({type:'point',data:points,encode:{x:'time',y:'value'},scale:layerScale(ruleID),axis:layerAxis(ruleID),style:{fill:color,stroke:dark?'#181b1f':'#fff',lineWidth:1.5,r:4},tooltip:{title:(datum:Record<string,unknown>)=>new Date(Number(datum.time)).toLocaleString(),items:[{name:l("规则"),field:'name'},{name:l("事件"),field:'state'},{name:l("数值"),field:'value'}]},animate:false});
     }
    }
   }
   if(layers.length){if(finalOptions.type==='view')finalOptions.children=[...(finalOptions.children as Record<string,unknown>[]),...layers];else finalOptions={type:'view',data:rows,scale:options.scale,axis:options.axis,legend:false,animate:false,interaction:options.interaction,children:[options,...layers]};}
  }
  // Bucket starts may precede range.from; clip marks to the plot, preserving
  // boundary interpolation and the original rows used by tooltips/statistics.
  // G2 5.4.8 drops root mark.clip when chart.options wraps it in a view.
  if(isTime&&!['pie','gauge'].includes(type)){
   if(finalOptions.type!=='view')finalOptions={type:'view',legend:false,animate:false,interaction:finalOptions.interaction,children:[finalOptions]};
   finalOptions.clip=true;
  }
  finalOptions.theme={type:dark?'dark':'light',axis:{labelFill:dark?'#a6adba':'#64738a',labelOpacity:1,gridStroke:dark?'#434a56':'#dfe3e9',gridStrokeOpacity:.65,gridLineWidth:.7,gridLineDash:[]}};
  finalOptions.key=`panel-${panel.id}`;
  if(onBrush&&isTime&&['line','area','timeseries','bar','heatmap'].includes(panel.type))finalOptions.interaction={...(finalOptions.interaction as Record<string,unknown>),brushXFilter:true};
  const tooltipHandler=()=>{requestAnimationFrame(()=>{
   if(disposed||!container.current)return;const tooltip=container.current.querySelector<HTMLElement>('.g2-tooltip');if(!tooltip)return;
   const bounds=container.current.getBoundingClientRect();tooltip.style.maxWidth=`${Math.max(100,bounds.width-8)}px`;
   const box=tooltip.getBoundingClientRect(),left=Math.min(Math.max(box.left,bounds.left+4),Math.max(bounds.left+4,bounds.right-box.width-4)),top=Math.min(Math.max(box.top,bounds.top+4),Math.max(bounds.top+4,bounds.bottom-box.height-4));
   tooltip.style.left=`${(parseFloat(tooltip.style.left)||0)+left-box.left}px`;tooltip.style.top=`${(parseFloat(tooltip.style.top)||0)+top-box.top}px`;
  });};chart.on('tooltip:show',tooltipHandler);
  const brushHandler=(event:unknown)=>{const e=event as {nativeEvent?:unknown;data?:{selection?:unknown[][]}};if(!e.nativeEvent)return;const selection=e.data?.selection?.[0];if(selection){const from=selection[0] instanceof Date?selection[0].getTime():Number(selection[0]),to=selection[1] instanceof Date?selection[1].getTime():Number(selection[1]);if(Number.isFinite(from)&&Number.isFinite(to)&&from<to)onBrush?.(from,to);}};
  if(onBrush&&isTime&&['line','area','timeseries','bar','heatmap'].includes(panel.type)){
   chart.on('brush:filter',brushHandler);
  }
  queue.submit(finalOptions);
  let measuredWidth=container.current.clientWidth,measuredHeight=container.current.clientHeight;
  const observer=new ResizeObserver(()=>{if(!disposed){const width=container.current?.clientWidth??600,height=Math.max(1,container.current?.clientHeight??220);setNarrow(width<500);if(width!==measuredWidth||height!==measuredHeight){measuredWidth=width;measuredHeight=height;queue.submit(finalOptions);}}});observer.observe(container.current);
  return()=>{disposed=true;observer.disconnect();chart.off('tooltip:show',tooltipHandler);chart.off('brush:filter',brushHandler);};
 },[fastTimeSeries,panel.type,panel.options,prepared,hidden,onBrush,intervalMS,range?.from,range?.to,narrow,dark,alertRules,alertEvents]);
 if(!frames.some(item=>item.frame.rows.length))return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={l("当前时间范围没有数据")}/>;
 if(panel.type==='table')return <div className="lm-dashboard-table">{frames.map(({refId,frame},i)=><div key={`${refId}-${i}`}><Tag>{l("查询 ")}{refId}</Tag><Table size="small" rowKey={(_,i)=>String(i)} dataSource={frame.rows} pagination={{pageSize:10,showSizeChanger:true}} scroll={{x:true}} columns={frame.columns.map((column,index)=>({title:<span title={column.type}>{column.name}</span>,key:column.name,render:(_:unknown,row:unknown[])=>{
  const raw=row[index],isValue=column.name===String(panel.options.y??'value'),mapped=isValue?valueMapping(raw,panel.options,language):undefined,color=mapped?.color??(thresholds.length&&isValue?thresholdColor(raw,panel.options,language):undefined);let display=printable(raw);if(isValue&&raw!==null){try{const n=numeric(raw,panel.options.approximate===true,language);if(n!==null)display=format(n,rightAxisRefs(panel.options).includes(refId)?panel.options.right_unit:panel.options.unit);}catch{/* Preserve exact integers and decimals in tables. */}}
  return <Tooltip title={mapped||display!==printable(raw)?l("原值：{0}",printable(raw)):undefined}><span style={color?{color,fontWeight:600}:undefined}>{mapped?.text??display}</span></Tooltip>;
 },sorter:(a:unknown[],b:unknown[])=>printable(a[index]).localeCompare(printable(b[index]),undefined,{numeric:true})}))}/></div>)}</div>;
 if(prepared.error)return <Alert type="warning" showIcon title={prepared.error}/>;
 if(panel.type==='stat'){
  if(!resultComplete)return <Alert type="warning" title={l("结果不完整，无法显示确定的指标值。请在 SQL 中聚合并减少返回行数。")}/>;
  const reducer=String(panel.options.reducer??'lastNotNull');
  return <div className="lm-dashboard-stats-grid">{series.map((name,index)=>{const rows=groupedSeries.get(name)??[],values=rows.map(row=>row.__y as number|null),value=calculate(values,reducer);
   if(reducer==='sum'&&panel.options.approximate!==true&&values.every(v=>v===null||Number.isInteger(v))&&typeof value==='number'&&!Number.isSafeInteger(value))return <Alert key={name} type="warning" title={l("客户端求和超过安全整数精度，请在 SQL 中汇总或开启近似数值。")}/>;
   const original=reducer==='last'?rows.at(-1)?.__rawY:reducer==='lastNotNull'?rows.filter(row=>row.__y!==null).at(-1)?.__rawY:value,mapped=valueMapping(original,panel.options,language),color=mapped?.color??(thresholds.length?thresholdColor(value,panel.options,language):colorForSeries(name,index,panel.options));
   return <div key={name} className="lm-dashboard-stat">{series.length>1&&<span title={name}>{label(name)}</span>}<strong style={{color}} title={l("原值：{0}",printable(original))}>{mapped?.text??format(value,seriesUnit(name))}</strong></div>;
  })}</div>;
 }
 const toggleSeries=(name:string,additive:boolean)=>setHidden(value=>selectLegendSeries(value,series,name,additive));
 const legendName=(name:string,index:number)=><div className="lm-legend-name">{onColorChange?<ColorPicker value={colorForSeries(name,index,panel.options)} disabledAlpha onChangeComplete={color=>onColorChange(name,color.toHexString())}><button type="button" className="lm-legend-color" aria-label={l("设置 {0} 颜色",name)} title={l("设置此序列颜色")} style={{background:colorForSeries(name,index,panel.options)}}/></ColorPicker>:<span className="lm-legend-dot" style={{background:colorForSeries(name,index,panel.options)}}/>}<Button size="small" type="text" aria-pressed={!hidden.includes(name)} title={l("{0} · 点击仅显示此序列；Ctrl / ⌘ / Shift + 点击切换显示",name)} style={{opacity:hidden.includes(name)?.4:1}} onClick={event=>toggleSeries(name,event.ctrlKey||event.metaKey||event.shiftKey)}><span className="lm-legend-label">{label(name)}</span></Button></div>;

 const legendHeader=(key:string,title:string)=><th key={key} scope="col" aria-sort={legendSort?.key===key?legendSort.direction:'none'}><button type="button" className="lm-legend-sort" aria-label={l("按 {0} 排序",title)} onClick={()=>setLegendSort(current=>nextLegendSort(current,key))}>{title}<span className="lm-legend-sort-indicator" aria-hidden><CaretUpOutlined className={legendSort?.key===key&&legendSort.direction==='ascending'?'is-active':''}/><CaretDownOutlined className={legendSort?.key===key&&legendSort.direction==='descending'?'is-active':''}/></span></button></th>;

 return <div ref={setContentNode} data-legend-placement={legendRight?'right':'bottom'} className={`lm-chart-content ${legendRight?'is-legend-right':''}`} style={legendRight?{gridTemplateColumns:`minmax(0,1fr) minmax(160px,min(55%,${legendWidth}px))`}:undefined}>{renderError&&<Alert type="error" title={renderError}/>}<div className="lm-chart-plot">{fastTimeSeries?<TimeSeriesPlot panel={panel} rows={prepared.rows} series={series} hidden={hidden} range={range} dark={dark} onBrush={onBrush} alertRules={alertRules} alertEvents={alertEvents}/>:<div ref={container} className="lm-chart-canvas lm-g2-chart" data-chart-layout={narrow?'compact':'regular'}/>}</div>{!['heatmap','gauge'].includes(panel.type)&&panel.options.legend_mode!=='hidden'&&(panel.options.legend_mode==='list'?<Space size={8} wrap className="lm-chart-legend">{series.map((name,index)=><span key={name}>{legendName(name,index)}</span>)}{hidden.length>0&&<Button type="link" size="small" onClick={()=>setHidden([])}>{l("显示全部")}</Button>}</Space>:<div className="lm-legend-table" role="region" aria-label={l("图例统计")}><table style={{minWidth:legendCalculations.length*64+180}}><colgroup><col/>{legendCalculations.map(id=><col key={id} style={{width:64}}/>)}</colgroup><thead><tr>{legendHeader('name',l("名称"))}{legendCalculations.map(id=>legendHeader(id,calculationName(id)))}</tr></thead><tbody>{legendRows.map(({name,index,calculations})=><tr key={name} style={{opacity:hidden.includes(name)?.45:1}}><td>{legendName(name,index)}</td>{legendCalculations.map(id=><td key={id} title={!resultComplete?l("查询结果不完整"):calculations[id]===null&&id==='sum'?l("汇总为空或超过安全整数精度"):undefined}>{format(calculations[id],id==='count'||id==='distinctCount'||id==='changeCount'?'':seriesUnit(name))}</td>)}</tr>)}</tbody></table>{hidden.length>0&&<Button type="link" size="small" onClick={()=>setHidden([])}>{l("显示全部")}</Button>}</div>)}{thresholds.length>0&&!fastTimeSeries&&<Space size={4} wrap className="lm-threshold-legend">{thresholds.map((t,i)=><small key={i} style={{color:t.color}}>{t.label||l("阈值")} ≥ {format(t.value)}</small>)}</Space>}{!fastTimeSeries&&rightAxisRefs(panel.options).length>0&&['line','timeseries','area','bar'].includes(panel.type)&&<small>{l("左轴：")}{unitLabel(panel.options.unit,language)} {l(" · 右轴：")}{unitLabel(panel.options.right_unit,language)}（{rightAxisRefs(panel.options).join('、')}）</small>}{panel.options.approximate===true&&<small className="lm-chart-approx">{l("近似数值展示；原值见检查器")}</small>}</div>;
}

export default memo(ChartView);
