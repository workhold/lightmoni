/** Grafana: click isolates/restores; Ctrl/Cmd/Shift-click toggles one series. */
export function selectLegendSeries(hidden:string[],series:string[],name:string,additive:boolean):string[] {
 if(additive)return hidden.includes(name)?hidden.filter(item=>item!==name):[...hidden,name];
 const isolated=series.every(item=>item===name?!hidden.includes(item):hidden.includes(item));
 return isolated?[]:series.filter(item=>item!==name);
}

export type LegendSort={key:string;direction:'ascending'|'descending'};
export function nextLegendSort(current:LegendSort|undefined,key:string):LegendSort|undefined {
 const first=key==='name'?'ascending':'descending';
 return current?.key!==key?{key,direction:first}:current.direction===first?{key,direction:first==='ascending'?'descending':'ascending'}:undefined;
}
export function sortLegendRows<T extends {label:string;calculations:Record<string,number|null>}>(rows:T[],sort?:LegendSort):T[] {
 if(!sort)return rows;
 return [...rows].sort((a,b)=>{
  if(sort.key==='name')return a.label.localeCompare(b.label,undefined,{numeric:true})*(sort.direction==='ascending'?1:-1);
  const av=a.calculations[sort.key],bv=b.calculations[sort.key],aValid=typeof av==='number'&&Number.isFinite(av),bValid=typeof bv==='number'&&Number.isFinite(bv);
  if(!aValid||!bValid)return aValid?-1:bValid?1:0;
  return (av-bv)*(sort.direction==='ascending'?1:-1);
 });
}

/** Alignment artifacts stay undefined; explicit nulls must remain real gaps. */
export function alignTimeSeries(rows:Record<string,unknown>[],series:string[]) {
 const times=[...new Set(rows.map(row=>Number(row.__x)))].sort((a,b)=>a-b);
 const positions=new Map(times.map((time,index)=>[time,index]));
 const values=series.map(()=>Array<number|null|undefined>(times.length).fill(undefined));
 const indexes=new Map(series.map((name,index)=>[name,index]));
 for(const row of rows){const index=indexes.get(String(row.__series));if(index!==undefined)values[index][positions.get(Number(row.__x))!]=row.__y as number|null;}
 return [times,...values] as [number[],...(number|null|undefined)[][]];
}

export function canPlotTimeSeries(rows:Record<string,unknown>[],type:string,options:Record<string,unknown>):boolean {
 if(!['line','timeseries','area'].includes(type)||options.stacked===true||!rows.length)return false;
 const seen=new Set<string>();
 for(const row of rows){if(!row.__isTime||!Number.isFinite(Number(row.__x)))return false;const key=`${row.__series}\0${row.__x}`;if(seen.has(key))return false;seen.add(key);}
 return true;
}
