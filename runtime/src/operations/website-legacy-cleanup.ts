import {lstat,readFile,readdir,readlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicFile,hash,readJSON,safeFile,safeID} from './website-files.js';
import {OperationRejectedError} from './errors.js';
import type {OperationExecutionContext} from './types.js';

export interface LegacyGatewayScope {instance_id:string;application_id:string;historical_only?:boolean;site_proofs:{digest:string;fragment_id:string;target:boolean}[]}
type Token={value:string;start:number;end:number;symbol:boolean};
type Statement={head:Token[];start:number;end:number;children?:Statement[]};
function reject():never{throw new OperationRejectedError('LEGACY_WEBSITE_EVIDENCE_REQUIRED');}
const digestPattern=/^[a-f0-9]{64}$/;

/** Only lexical structure is interpreted. Quoted braces, escapes and comments
 * never become block delimiters; retained source ranges remain byte-identical. */
function statements(source:string):Statement[] {
 const tokens:Token[]=[];let i=0;
 while(i<source.length){
  if(/\s/.test(source[i])){i++;continue;}
  if(source[i]==='#'){while(i<source.length&&source[i]!=='\n')i++;continue;}
  const start=i;let value='';
  if('{};'.includes(source[i]))value=source[i++];
  else if(source[i]==='"'||source[i]==="'"){
   const quote=source[i++];let closed=false;
   while(i<source.length){const c=source[i++];if(c==='\\'){if(i>=source.length)reject();value+=source[i++];}else if(c===quote){closed=true;break;}else value+=c;}
   if(!closed)reject();
  }else while(i<source.length&&!/[\s{};#]/.test(source[i])){if(source[i]==='\\'){i++;if(i>=source.length)reject();}value+=source[i++];}
  tokens.push({value,start,end:i,symbol:'{};'.includes(source[start])});
 }
 if(tokens.length>100000)reject();let n=0;
 const parse=(nested=false,depth=0):Statement[]=>{
  if(depth>64)reject();
  const result:Statement[]=[];
  while(n<tokens.length){
   if(tokens[n].symbol&&tokens[n].value==='}'){if(!nested)reject();n++;return result;}
   const start=tokens[n].start,head:Token[]=[];
   while(n<tokens.length&&!(tokens[n].symbol&&['{','}',';'].includes(tokens[n].value)))head.push(tokens[n++]);
   if(!head.length||n>=tokens.length)reject();const delimiter=tokens[n++];
   if(delimiter.value===';')result.push({head,start,end:delimiter.end});
   else if(delimiter.value==='{'){const children=parse(true,depth+1);result.push({head,start,end:tokens[n-1].end,children});}
   else reject();
  }
  if(nested)reject();return result;
 };
 return parse();
}
function descendants(nodes:Statement[]):Statement[]{return nodes.flatMap(n=>[n,...descendants(n.children??[])]);}

export function cleanLegacyIndex(source:string,proofs:LegacyGatewayScope['site_proofs']) {
 if(source.length>1_100_000||source.includes('/etc/lightmoni-websites/'))reject();
 const tree=statements(source),all=descendants(tree),http=tree.filter(n=>n.head.length===1&&n.head[0].value==='http'&&n.children);
 if(http.length!==1)reject();
 for(const n of all)if(n.head[0].value==='include'&&(n.head.length!==2||n.head[1].value!=='/usr/local/openresty/nginx/conf/mime.types'))reject();
 const known=new Map<string,{fragment_id:string;target:boolean}>();
 for(const p of proofs){if(!digestPattern.test(p.digest)||typeof p.target!=='boolean')reject();safeID(p.fragment_id);const old=known.get(p.digest);if(old&&(old.fragment_id!==p.fragment_id||old.target!==p.target))reject();known.set(p.digest,p);}
 const targetIDs=new Set(proofs.filter(p=>p.target).map(p=>p.fragment_id)),remove:Statement[]=[];
 for(const node of http[0].children!){
  if(node.head[0].value==='server'&&node.children){
   const locations=node.children.filter(n=>n.head[0].value==='location');
   const health=locations.filter(n=>n.head.some(t=>t.value==='/.well-known/lightmoni-health'));
   if(!health.length){if(!locations.some(n=>n.head.some(t=>t.value==='/.well-known/lightmoni-gateway')))reject();continue;}
   if(health.length!==1)reject();
   const returns=health[0].children?.filter(n=>n.head[0].value==='return'&&n.head[1]?.value==='200')??[];
   if(returns.length!==1||returns[0].head.length!==3)reject();const proof=known.get(returns[0].head[2].value);if(!proof)reject();
   if(proof.target)remove.push(node);
  }else if(node.head.some(t=>[...targetIDs].some(id=>new RegExp('^(?:backend_|req_|conn_|cache_)'+id+'_[0-9]+$').test(t.value)||t.value.includes('zone=req_'+id+'_')||t.value.includes('zone=conn_'+id+'_')||t.value.includes('keys_zone=cache_'+id+'_')||t.value.startsWith('/tmp/lightmoni-cache_'+id+'_'))))remove.push(node);
 }
 let cleaned=source;for(const n of remove.sort((a,b)=>b.start-a.start))cleaned=cleaned.slice(0,n.start)+cleaned.slice(n.end);
 // Never remove a shared definition still referenced by another server.
 if([...targetIDs].some(id=>cleaned.includes(id))||proofs.some(p=>p.target&&cleaned.includes(p.digest)))reject();
 return {body:cleaned,changed:cleaned!==source};
}
async function realDirectory(path:string){const info=await lstat(path);if(info.isSymbolicLink()||!info.isDirectory())reject();}
async function safeTree(path:string,budget={left:10000},depth=0):Promise<void>{if(--budget.left<0||depth>32)reject();const info=await lstat(path);if(info.isSymbolicLink())reject();if(info.isDirectory())for(const name of await readdir(path))await safeTree(join(path,name),budget,depth+1);else if(!info.isFile())reject();}

/** The caller proves this version is inactive before calling apply. */
export async function legacyVersionPlan(version:string,scope:LegacyGatewayScope) {
 await realDirectory(version);
 if((await readdir(version)).some(n=>!['nginx.conf','auth-probe.json','sites'].includes(n)))reject();
 const config=join(version,'nginx.conf');await safeFile(config);if((await lstat(config)).size>1_100_000)reject();
 const before=await readFile(config,'utf8'),result=cleanLegacyIndex(before,scope.site_proofs),deletes:string[]=[];
 const targetIDs=new Set(scope.site_proofs.filter(p=>p.target).map(p=>safeID(p.fragment_id))),sites=join(version,'sites');
 try{await realDirectory(sites);for(const id of await readdir(sites)){safeID(id);if(targetIDs.has(id)){await safeTree(join(sites,id));deletes.push(join(sites,id));}}}catch(e:any){if(e.code!=='ENOENT')throw e;}
 return {referenced:result.changed||deletes.length>0,async apply(){if(result.changed)await atomicFile(config,result.body);for(const path of deletes)await rm(path,{recursive:true});}};
}

/** A narrow cleanup of a registered, stopped historical gateway. No owner
 * marker is fabricated and no old gateway executable or container is started. */
export async function legacyWebsitePlan(context:OperationExecutionContext,platform:string,websiteID:string,scope:LegacyGatewayScope) {
 if(scope.historical_only)reject();
 const instance=safeID(scope.instance_id),application=safeID(scope.application_id),root=join(platform,'gateways',instance);
 await realDirectory(root);const names=await readdir(root);if(names.some(n=>!['state.json','current','versions'].includes(n)))reject();
 const statePath=join(root,'state.json');await safeFile(statePath);if((await lstat(statePath)).size>1_100_000)reject();const raw=await readJSON<any>(statePath,null);
 if(raw?.version!==1||raw.config?.instance_id!==instance||raw.config?.openresty_application_id!==application||!Array.isArray(raw.config.sites)||!digestPattern.test(raw.digest))reject();
 if(!Array.isArray(scope.site_proofs)||scope.site_proofs.length>2048)reject();
 const proofMap=new Map(scope.site_proofs.map(p=>[p.digest,p]));
 for(const site of raw.config.sites)if(!proofMap.has(hash(JSON.stringify(site))))reject();
 const pointer=join(root,'current'),link=await lstat(pointer);if(!link.isSymbolicLink()||await readlink(pointer)!=='versions/'+raw.digest)reject();
 const found=await context.command('docker',['ps','-aq','--filter','name=^lm-gateway-'+instance+'$'],{timeoutMs:15000});
 const ids=found.stdout.trim().split(/\s+/).filter(Boolean);if(ids.length!==1||!/^[a-f0-9]{12,64}$/.test(ids[0]))reject();
 const containers=JSON.parse((await context.command('docker',['inspect',ids[0]],{timeoutMs:15000})).stdout);
 if(!Array.isArray(containers)||containers.length!==1)reject();const container=containers[0];
 if(container.State?.Running!==false||container.Config?.Labels?.['io.lightmoni.platform.instance']!==instance||container.Config?.Labels?.['io.lightmoni.platform.owner']!=='lightmoni'||!container.Mounts?.some((m:any)=>m.Type==='bind'&&m.Source===root&&m.Destination==='/etc/lightmoni'&&m.RW===false))reject();
 const versions=join(root,'versions');await realDirectory(versions);
 const digests=await readdir(versions);if(digests.length>512||!digests.includes(raw.digest))reject();
 const plans:Awaited<ReturnType<typeof legacyVersionPlan>>[]=[];
 for(const digest of digests){
  if(!digestPattern.test(digest))reject();plans.push(await legacyVersionPlan(join(versions,digest),scope));
 }
 const next=structuredClone(raw);next.config.sites=next.config.sites.filter((s:any)=>!proofMap.get(hash(JSON.stringify(s)))!.target);
 for(const key of ['website_revisions','website_enabled'])if(next.config[key])delete next.config[key][websiteID];
 const stateChanged=JSON.stringify(raw)!==JSON.stringify(next),referenced=plans.some(p=>p.referenced)||stateChanged;
 return {instance_id:instance,referenced,async apply(){for(const plan of plans)await plan.apply();if(stateChanged)await atomicFile(join(root,'state.json'),JSON.stringify(next));}};
}
