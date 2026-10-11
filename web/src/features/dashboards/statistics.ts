export const calculations=[
 {value:'last',label:'Last · 最后值'}, {value:'lastNotNull',label:'Last * · 最后非空值'},
 {value:'mean',label:'Avg · 平均值'}, {value:'min',label:'Min · 最小值'},
 {value:'max',label:'Max · 最大值'}, {value:'sum',label:'Total · 总和'},
 {value:'first',label:'First · 首个值'}, {value:'firstNotNull',label:'First * · 首个非空值'},
 {value:'count',label:'Count · 数量'}, {value:'range',label:'Range · 极差'},
 {value:'diff',label:'Difference · 首末差值'}, {value:'median',label:'Median · 中位数'},
 {value:'stdDev',label:'StdDev · 标准差'}, {value:'variance',label:'Variance · 方差'},
 {value:'distinctCount',label:'Distinct · 不同值数量'}, {value:'changeCount',label:'Changes · 变化次数'},
 {value:'delta',label:'Delta · 增量（含计数重置）'}, {value:'step',label:'Step · 最小正差值'},
 {value:'allIsZero',label:'All zero · 全部为零'}, {value:'allIsNull',label:'All null · 全部为空'},
];
export function calculate(values:(number|null)[],reducer:string):number|null{
 const finite=values.filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
 if(reducer==='allIsNull')return finite.length===0?1:0;
 if(reducer==='count')return values.length;
 if(reducer==='last')return values.at(-1)??null;
 if(reducer==='first')return values[0]??null;
 if(!finite.length)return null;
 const first=finite[0],last=finite.at(-1)!,min=Math.min(...finite),max=Math.max(...finite);
 if(reducer==='lastNotNull')return last;
 if(reducer==='firstNotNull')return first;
 if(reducer==='min')return min;
 if(reducer==='max')return max;
 if(reducer==='sum')return finite.reduce((sum,value)=>sum+value,0);
 if(reducer==='range')return max-min;
 if(reducer==='diff')return last-first;
 if(reducer==='distinctCount')return new Set(finite).size;
 if(reducer==='allIsZero')return finite.every(value=>value===0)?1:0;
 if(reducer==='changeCount')return finite.slice(1).filter((value,i)=>value!==finite[i]).length;
 if(reducer==='delta')return finite.slice(1).reduce((sum,value,i)=>sum+(value>=finite[i]?value-finite[i]:value),0);
 if(reducer==='step'){const steps=finite.slice(1).map((value,i)=>value-finite[i]).filter(value=>value>0);return steps.length?Math.min(...steps):null;}
 if(reducer==='median'){const sorted=[...finite].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;}
 // An online mean avoids overflowing a finite average of large values.
 const mean=finite.reduce((average,value,i)=>average*(i/(i+1))+value/(i+1),0);
 if(reducer==='stdDev'||reducer==='variance'){const variance=finite.reduce((sum,value)=>sum+(value-mean)**2,0)/finite.length;return reducer==='stdDev'?Math.sqrt(variance):variance;}
 return mean;
}
export const calculationName=(id:string)=>calculations.find(c=>c.value===id)?.label.split(' · ')[0]??id;
