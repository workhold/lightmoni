import {useState} from 'react';
import {Select} from '../../shared/ui';
import {commonUnits,normalizedUnit,unitGroups} from './formatting';

export default function UnitSelect({value,onChange,label='单位'}:{value:unknown;onChange:(value:string)=>void;label?:string}){
 const [search,setSearch]=useState('');
 const current=normalizedUnit(value)||'none';
 const custom=search.trim(),customValue=custom.includes(':')?custom:`suffix:${custom}`;
 const common=new Set(commonUnits.map(unit=>unit.value));
 const groups=unitGroups.map(group=>({...group,options:group.options.filter(unit=>!common.has(unit.value))})).filter(group=>group.options.length);
 const savedCustom=!unitGroups.some(group=>group.options.some(unit=>unit.value===current))&&current!=='none'?{value:current,label:`自定义：${current.replace(/^suffix:/,'')}`,search:current}:undefined;
 const customOptions=[...(savedCustom?[savedCustom]:[]),...(custom&&customValue!==savedCustom?.value?[{value:customValue,label:`自定义：${custom}`,search:custom}]:[])];
 const options=[{label:'常用单位',options:commonUnits},...groups,...(customOptions.length?[{label:'自定义单位',options:customOptions}]:[])];
 return <Select aria-label={label} showSearch value={current} options={options} onSearch={setSearch} onChange={unit=>onChange(unit==='none'?'':unit)} filterOption={(input,option)=>String((option as {search?:string;label?:unknown})?.search??option?.label??'').toLowerCase().includes(input.toLowerCase())} popupMatchSelectWidth={350} styles={{popup:{root:{maxWidth:'calc(100vw - 24px)'}}}}/>;
}
