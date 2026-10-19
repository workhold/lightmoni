import {useMonitoringI18n} from '../monitoring-i18n';
import type {ReactNode} from 'react';
import {Button} from '../../shared/ui';
export const visualizations=[
 {type:'line',title:'折线',hint:'时间趋势'}, {type:'area',title:'面积',hint:'趋势与累计'}, {type:'bar',title:'柱状',hint:'数量与对比'},
 {type:'pie',title:'饼图',hint:'类别占比'}, {type:'stat',title:'数值',hint:'单值摘要'}, {type:'table',title:'表格',hint:'结果明细'},
 {type:'gauge',title:'仪表',hint:'目标范围'}, {type:'heatmap',title:'热力',hint:'多维密度'}, {type:'histogram',title:'分布',hint:'样本分桶'}, {type:'timeline',title:'状态',hint:'时间区间'},
];
export function VisualizationIcon({type}:{type:string}){
 const paths:Record<string,ReactNode>={
  line:<polyline points="4,25 12,17 20,21 28,7 36,13 44,4"/>,area:<><path d="M4 25 12 17 20 21 28 7 36 13 44 4V29H4Z" fill="currentColor" opacity=".15"/><polyline points="4,25 12,17 20,21 28,7 36,13 44,4"/></>,
  bar:<><path d="M6 29V16h7v13M21 29V6h7v23M36 29V11h7v18" fill="currentColor" opacity=".75"/></>,
  pie:<><path d="M24 16V3a13 13 0 1 0 13 13Z" fill="currentColor" opacity=".6"/><path d="M27 3v10h10A13 13 0 0 0 27 3Z" fill="currentColor"/></>,
  stat:<text x="24" y="25" textAnchor="middle" fill="currentColor" stroke="none" fontSize="26" fontWeight="600">42</text>,
  table:<><rect x="5" y="4" width="38" height="25" rx="2"/><path d="M5 12h38M5 20h38M18 4v25M31 4v25"/></>,
  gauge:<><path d="M7 26a17 17 0 1 1 34 0" strokeWidth="4" opacity=".5"/><path d="m24 23 8-13" strokeWidth="2.5"/><circle cx="24" cy="23" r="2" fill="currentColor"/></>,
  heatmap:<>{[0,1,2].flatMap(x=>[0,1].map(y=><rect key={`${x}-${y}`} x={6+x*13} y={5+y*14} width="10" height="11" rx="1" fill="currentColor" stroke="none" opacity={(x+y+1)/5}/>))}</>,
  histogram:<path d="M5 29V22h8V12h8V5h8v11h8v8h7v5Z" fill="currentColor" opacity=".65"/>,
  timeline:<><path d="M5 8h16M25 8h18M5 17h8M17 17h26M5 26h27M36 26h7" strokeWidth="5" opacity=".7"/></>,
 };
 return <svg className="lm-visualization-icon" viewBox="0 0 48 34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]??paths.line}</svg>;
}
export default function VisualizationPicker({value,onChange,compact=false}:{value:string;onChange:(type:string)=>void;compact?:boolean}){
 const {l,language}=useMonitoringI18n();

 return <div className={compact?'lm-visualization-strip':'lm-visualization-gallery'} role="radiogroup" aria-label={l("图表类型")}>{visualizations.map(item=><Button key={item.type} type="text" role="radio" aria-checked={(value==='timeseries'?'line':value)===item.type} data-visualization={item.type} className="lm-visualization-choice" onClick={()=>onChange(item.type)}><VisualizationIcon type={item.type}/><span><strong>{l(item.title)}</strong>{!compact&&<small>{l(item.hint)}</small>}</span></Button>)}</div>;
}
