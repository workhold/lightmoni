import {monitoringText,type MonitoringLanguage} from '../monitoring-translations.ts';
import {getValueFormat,getValueFormats,formattedValueToString} from '@grafana/data';

export const normalizedUnit=(unit:unknown):string=>String(unit??'');
export const isFractionalUnit=(unit:unknown)=>normalizedUnit(unit)==='percentunit';
const categoryNames:Record<string,string>={Misc:'常用数值',Acceleration:'加速度',Angle:'角度',Area:'面积',Computation:'计算',Concentration:'浓度',Currency:'货币',Data:'数据大小','Data rate':'数据速率','Date & time':'日期与时间',Energy:'能量',Flow:'流量',Force:'力','Hash rate':'哈希速率',Mass:'质量',Length:'长度',Pressure:'压力',Radiation:'辐射','Rotational Speed':'转速',Temperature:'温度',Time:'时间',Throughput:'吞吐量',Velocity:'速度',Volume:'体积',Boolean:'布尔'};
const commonNames:Record<string,string>={none:'无单位',short:'短数值 · K / M / B',bytes:'字节（IEC）· KiB / MiB / GiB',decbytes:'字节（SI）· kB / MB / GB',bits:'比特（SI）',Bps:'字节/秒（SI）',binBps:'字节/秒（IEC）',bps:'比特/秒',ms:'毫秒 · 自动换算秒',s:'秒 · 自动换算时间',µs:'微秒',ns:'纳秒',percentunit:'百分比（0–1）',percent:'百分比（0–100）',hertz:'频率 · Hz',celsius:'摄氏度 · °C',fahrenheit:'华氏度 · °F',currencyUSD:'美元 · USD',currencyCNY:'人民币 · CNY',reqps:'请求/秒',ops:'操作/秒',pps:'包/秒'};
export const unitGroups=getValueFormats().map(group=>({label:categoryNames[group.text]??group.text,options:group.submenu.map(unit=>({value:unit.value,label:commonNames[unit.value]??unit.text,search:`${unit.text} ${unit.value} ${group.text} ${categoryNames[group.text]??''} ${commonNames[unit.value]??''}`}))}));
export const commonUnits=Object.keys(commonNames).flatMap(id=>unitGroups.flatMap(group=>group.options).filter(unit=>unit.value===id));
export function formatValue(value:unknown,unit:unknown,decimals=2):string{
 if(value===null||value===undefined)return '—';
 if(typeof value!=='number')return typeof value==='object'?JSON.stringify(value):String(value);
 if(!Number.isFinite(value))return '—';
 return formattedValueToString(getValueFormat(normalizedUnit(unit))(value,Math.min(10,Math.max(0,decimals))));
}
export function unitLabel(unit:unknown,language:MonitoringLanguage='zh-CN'):string{
 const l=(text:string,...values:unknown[])=>monitoringText(text,language,...values);

 const id=normalizedUnit(unit);
 const known=unitGroups.flatMap(group=>group.options).find(option=>option.value===id);
 return known?l(known.label):String(unit||l("数值"));
}
