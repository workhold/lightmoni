import {useMonitoringI18n} from '../monitoring-i18n';
import {useState} from 'react';
import {Select} from '../../shared/ui';
import {commonUnits,normalizedUnit,unitGroups} from './formatting';

export default function UnitSelect({value,onChange,label}:{value:unknown;onChange:(value:string)=>void;label?:string}){
 const {l,language}=useMonitoringI18n();

 const [search,setSearch]=useState('');
 const current=normalizedUnit(value)||'none';
 const custom=search.trim(),customValue=custom.includes(':')?custom:`suffix:${custom}`;
 const common=new Set(commonUnits.map(unit=>unit.value));
 const groups=unitGroups.map(group=>({...group,label:l(group.label),options:group.options.filter(unit=>!common.has(unit.value)).map(unit=>({...unit,label:l(unit.label)}))})).filter(group=>group.options.length);
 const savedCustom=!unitGroups.some(group=>group.options.some(unit=>unit.value===current))&&current!=='none'?{value:current,label:l("自定义：{0}",current.replace(/^suffix:/,'')),search:current}:undefined;
 const customOptions=[...(savedCustom?[savedCustom]:[]),...(custom&&customValue!==savedCustom?.value?[{value:customValue,label:l("自定义：{0}",custom),search:custom}]:[])];
 const options=[{label:l("常用单位"),options:commonUnits.map(unit=>({...unit,label:l(unit.label)}))},...groups,...(customOptions.length?[{label:l("自定义单位"),options:customOptions}]:[])];
 return <Select aria-label={label??l("单位")} showSearch value={current} options={options} onSearch={setSearch} onChange={unit=>onChange(unit==='none'?'':unit)} filterOption={(input,option)=>String((option as {search?:string;label?:unknown})?.search??option?.label??'').toLowerCase().includes(input.toLowerCase())} popupMatchSelectWidth={350} styles={{popup:{root:{maxWidth:'calc(100vw - 24px)'}}}}/>;
}
