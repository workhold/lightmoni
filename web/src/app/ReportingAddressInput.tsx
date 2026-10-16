import {AutoComplete,Input} from '../shared/ui';
import type {ReportingAddress} from './reporting-addresses';
import './reporting-addresses.css';

export default function ReportingAddressInput({id,label,value,onChange,addresses=[],defaultID,error,placeholder}:{id?:string;label:string;value:string;onChange:(value:string)=>void;addresses?:ReportingAddress[];defaultID?:string;error?:string;placeholder?:string}){
 return <AutoComplete className="lm-reporting-address-input" value={value} onChange={onChange} options={addresses.map(address=>({value:address.url,label:`${address.name}${address.id===defaultID?'（默认）':''} · ${address.url}`}))} filterOption={(input,option)=>addresses.some(address=>address.url===input)||String(option?.label??'').toLowerCase().includes(input.toLowerCase())}>
  <Input id={id} aria-label={label} status={error?'error':undefined} maxLength={2048} placeholder={placeholder}/>
 </AutoComplete>;
}
