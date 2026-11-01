import { fail } from '../shared/http.js';

type Port = {name:string; host_port:number; protocol?:string};
/** Named overrides cannot add services or change the container's port contract. */
export function hostPortOverrides(value:unknown, ports:Port[]):Record<string,number>|undefined {
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'invalid_host_ports');
  const result:Record<string,number>={};
  for(const [name,n] of Object.entries(value)){
    if(!ports.some(p=>p.name===name)||typeof n!=='number'||!Number.isInteger(n)||n<0||n>65535)fail(400,'invalid_host_ports');
    result[name]=n;
  }
  const used=new Set<string>();
  for(const p of ports){
    const n=Object.hasOwn(result,p.name)?result[p.name]:p.host_port;
    if(!n)continue;
    const key=(p.protocol??'tcp')+':'+n;
    if(used.has(key))fail(400,'duplicate_host_port');
    used.add(key);
  }
  return result;
}
