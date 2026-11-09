import {stringify} from 'yaml';
import {catalogInstallation,catalogTemplate} from './catalog.js';
import {fail} from '../shared/http.js';

/** Pure recipe preview: no store, credentials, directory, placement or execution side effects. */
export function catalogPreview(templateID:string,input:Record<string,any>){
 const template=catalogTemplate(templateID),parameters={...(input.parameters??{})};
 if(!input.parameters||typeof input.parameters!=='object'||Array.isArray(input.parameters))fail(400,'invalid_catalog_parameters');
 const secrets:string[]=[];
 for(const p of template.parameters)if(['password','secret'].includes(p.type)){
  if(typeof parameters[p.key]==='string'&&parameters[p.key])secrets.push(parameters[p.key]);
  if(!parameters[p.key]&&p.required){parameters[p.key]='x'.repeat(Math.min(p.max??4096,Math.max(p.min??8,32)));secrets.push(parameters[p.key]);}
 }
 const {spec:built}=catalogInstallation(templateID,{...input,parameters},true);
 const spec:Record<string,any>=built;
 const doc:Record<string,any>=spec.mode==='compose'?structuredClone(spec.compose):{services:{app:{image:spec.image,...Object.fromEntries(['command','entrypoint','environment','restart','network_mode','networks','user','working_dir','read_only'].filter(k=>spec[k]!==undefined).map(k=>[k,spec[k]]))}}};
 const names=Object.keys(doc.services);
 for(const p of spec.ports??[]){const service=doc.services[p.service??names[0]];if(!service)continue;service.ports??=[];const mapping={target:p.container_port,published:String(p.host_port??0),protocol:p.protocol??'tcp',host_ip:p.host_ip??'0.0.0.0'};if(!service.ports.some((v:any)=>typeof v==='object'&&v.target===mapping.target))service.ports.push(mapping)}
 for(const [index,mount] of (spec.mounts??[]).entries()){
  const service=doc.services[mount.service??names[0]];if(!service)continue;
  const source=mount.type==='volume'?mount.source:mount.type==='data'?'[application-data:'+index+']':'[managed-'+mount.type+':'+index+']';
  service.volumes??=[];service.volumes.push({type:mount.type==='volume'?'volume':'bind',source,target:mount.target,read_only:mount.read_only??false});
 }
 const redact=(v:any,key=''):any=>{
  if(v&&typeof v==='object')return Array.isArray(v)?v.map(x=>redact(x,key)):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,redact(x,k)]));
  if(typeof v!=='string')return v;
  if(/password|secret|token|credential|private_key/i.test(key))return '[redacted]';
  let value=v;for(const secret of secrets)value=value.split(secret).join('[redacted]');return value;
 };
 return {template_id:template.id,version:input.version??template.version,yaml:stringify(redact(doc),{lineWidth:0,aliasDuplicateObjects:false}),mounts:(spec.mounts??[]).map((m:any)=>({type:m.type,service:m.service??names[0],target:m.target})),runtime_assignment:true};
}
