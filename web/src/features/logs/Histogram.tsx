import {useEffect,useMemo,useRef,useState} from 'react';
import {Chart} from '@antv/g2';
import {Alert,Button,Empty,Modal,Table} from '../../shared/ui';
import type {QueryFrame,TimeRange} from '../../shared/types';
import {asRows} from './model';
import {useAppearance} from '../../shared/appearance';

export default function Histogram({frame,intervalMS,range,breakdown="none",onRange}:{frame?:QueryFrame;intervalMS:number;range?:TimeRange;breakdown?:"none"|"severity";onRange:(from:string,to:string)=>void}){
 const {dark}=useAppearance();
 const container=useRef<HTMLDivElement>(null),[error,setError]=useState(''),[dataOpen,setDataOpen]=useState(false);
 const data=useMemo(()=>{
  if(!frame)return [];
  const points=asRows(frame).map(row=>({time:Date.parse(String(row.time)),count:Number(row.count),countText:String(row.count),severity:String(row.severity)})).filter(row=>Number.isFinite(row.time)&&Number.isFinite(row.count));
  const grouped=new Map<number,typeof points[number]>();
  if(breakdown==='none')for(const point of points){const previous=grouped.get(point.time);const count=(previous?.count??0)+point.count;grouped.set(point.time,{...point,count,countText:String(count),severity:'全部日志'})}
  const totals=new Map<number,number>();
  return (breakdown==='none'?[...grouped.values()]:points).map(row=>{const lower=totals.get(row.time)??0;totals.set(row.time,lower+row.count);return {...row,end:row.time+intervalMS,lower,upper:lower+row.count}})
 },[frame,intervalMS,breakdown]);
 const handler=useRef(onRange);handler.current=onRange;
 useEffect(()=>{if(!container.current||!data.length)return;setError('');let alive=true;const span=range?Date.parse(range.to)-Date.parse(range.from):0;const showSeconds=span<=300000;const colors:Record<string,string>={'全部日志':'#54b399',TRACE:'#909aac',DEBUG:'#7793b7',INFO:'#54b399',WARN:'#d6bf57',ERROR:'#e7664c',FATAL:'#9f3157',UNSPECIFIED:'#8290a5'};const levels=[...new Set(data.map(row=>row.severity))].sort((a,b)=>Object.keys(colors).indexOf(a)-Object.keys(colors).indexOf(b));const chart=new Chart({container:container.current,autoFit:true,height:150});
  chart.options({theme:{type:dark?'dark':'light',axis:{labelOpacity:1,labelFill:dark?'#a6adba':'#64738a'}},type:'rect',data,encode:{x:'time',x1:'end',y:'upper',y1:'lower',color:'severity'},scale:{x:{type:'time',tickCount:5,nice:false,...(range?{domain:[Date.parse(range.from),Date.parse(range.to)]}:{})},color:{domain:levels,range:levels.map(level=>colors[level]??'#8290a5')}},axis:{x:{title:false,labelAutoRotate:false,labelAutoHide:true,labelFontSize:11,labelFormatter:(value:number)=>span>86400000?new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'}):new Date(value).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',...(showSeconds?{second:'2-digit' as const}:{})})},y:{title:false}},legend:breakdown==='none'?false:{color:{position:'bottom'}},animate:false,tooltip:{title:(datum:Record<string,unknown>)=>`${new Date(Number(datum.time)).toLocaleString()} — ${new Date(Math.min(Number(datum.end),range?Date.parse(range.to):Number(datum.end))).toLocaleTimeString()}`,items:[{name:'日志数',field:'count'},{name:'级别',field:'severity'}]},interaction:{tooltip:{shared:true}}} as Parameters<Chart['options']>[0]);
  chart.interaction('brushXFilter',true);chart.on('brush:filter',(event:unknown)=>{const e=event as {nativeEvent?:unknown;data?:{selection?:unknown[][]}};if(!e.nativeEvent)return;const range=e.data?.selection?.[0];if(!range||range.length<2)return;const from=Number(range[0]),to=Number(range[1]);if(Number.isFinite(from)&&Number.isFinite(to)&&from<to)handler.current(new Date(from).toISOString(),new Date(to).toISOString())});
  chart.on('rect:click',(event:unknown)=>{const e=event as {data?:{data?:{time?:number}}};const from=Number(e.data?.data?.time);if(Number.isFinite(from)){const lower=Math.max(from,range?Date.parse(range.from):from),upper=Math.min(from+intervalMS,range?Date.parse(range.to):from+intervalMS);if(lower<upper)handler.current(new Date(lower).toISOString(),new Date(upper).toISOString())}});
  void chart.render().catch(err=>{if(alive)setError(String(err))});return()=>{alive=false;chart.destroy()};
 },[data,intervalMS,range?.from,range?.to,dark,breakdown]);
 return <div className="lm-log-histogram"><Button className="lm-log-histogram-data" size="small" type="link" onClick={()=>setDataOpen(true)} disabled={!data.length}>分布数据</Button>{error&&<Alert type="error" title={`时间图：${error}`}/>} {data.length?<div ref={container}/>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前时间范围没有日志"/>}<Modal title="日志时间分布数据" open={dataOpen} onCancel={()=>setDataOpen(false)} footer={null} width={720}><Table size="small" rowKey={row=>String(row.time)+row.severity} dataSource={data} pagination={{pageSize:20}} columns={[{title:'开始时间',render:(_,row)=>new Date(row.time).toISOString()},{title:'级别',dataIndex:'severity'},{title:'日志数',dataIndex:'countText'},{title:'查看',render:(_,row)=><Button size="small" onClick={()=>{setDataOpen(false);onRange(new Date(Math.max(row.time,range?Date.parse(range.from):row.time)).toISOString(),new Date(Math.min(row.end,range?Date.parse(range.to):row.end)).toISOString())}}>查看时段</Button>}]}/></Modal></div>
}
