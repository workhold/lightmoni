import { createHash } from 'node:crypto';
import { OperationRejectedError } from './errors.js';
import { privateRegistryAddress } from './registry-address.js';
import type { OperationExecutionContext, OperationExecutionResult } from './types.js';

export interface RegistryReference { repository: string; reference: string; id: string; name: string }
export const repositoryName = (s: unknown): s is string => typeof s === 'string' && s.length <= 255 && /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/.test(s);
export const tagName = (s: unknown): s is string => typeof s === 'string' && /^[\w][\w.-]{0,127}$/.test(s);
const digestName = (s: unknown): s is string => typeof s === 'string' && /^sha256:[a-f0-9]{64}$/.test(s);
const reject = (code: string): never => { throw new OperationRejectedError(code); };
const ACCEPT = ['application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json','application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'].join(', ');
const LIMIT = 10000;
const CONCURRENCY = 4;
async function parallelMap<T,R>(values:T[], fn:(value:T)=>Promise<R>):Promise<R[]> {
  const result:R[]=new Array(values.length);let next=0;
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,values.length)},async()=>{while(next<values.length){const index=next++;result[index]=await fn(values[index]);}}));
  return result;
}
export function validateRegistryConfig(c: Record<string, any>) {
  let url: URL;
  try { url = new URL(c.endpoint); } catch { return reject('INVALID_REGISTRY_ENDPOINT'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) reject('INVALID_REGISTRY_ENDPOINT');
  privateRegistryAddress(url.hostname.replace(/^\[|\]$/g,''));
  if (!Array.isArray(c.references) || c.references.length > LIMIT || c.references.some((r: RegistryReference) => !repositoryName(r.repository) || !(tagName(r.reference) || digestName(r.reference)) || typeof r.id !== 'string' || typeof r.name !== 'string' || r.name.length > 200)) reject('INVALID_REGISTRY_REFERENCES');
  if (c.repository !== undefined && !repositoryName(c.repository)) reject('INVALID_REGISTRY_REPOSITORY');
  if (c.after !== undefined && (!c.repository || !tagName(c.after))) reject('INVALID_REGISTRY_CURSOR');
}

class RegistryClient {
  private manifests = new Map<string, {digest:string; children:string[]}>();
  private pending = new Map<string, Promise<{digest:string; children:string[]}>>();
  private active=0;
  private waiters:(()=>void)[]=[];
  constructor(private c: Record<string, any>, private signal: AbortSignal, private fetcher: typeof fetch) {}
  async request(path: string, method = 'GET') {
    if(this.active>=CONCURRENCY)await new Promise<void>(resolve=>this.waiters.push(resolve));else this.active++;
    try{return await this.performRequest(path,method)}finally{const waiter=this.waiters.shift();if(waiter)waiter();else this.active--;}
  }
  private async performRequest(path:string,method:string) {
    this.signal.throwIfAborted();
    const response = await this.fetcher(new URL(path, this.c.endpoint), {method, redirect:'error', headers:{Accept:ACCEPT}, signal:AbortSignal.any([this.signal,AbortSignal.timeout(15000)])});
    if (method === 'DELETE' && response.status === 405) { await response.body?.cancel(); return reject('REGISTRY_DELETE_DISABLED'); }
    if (method === 'GET' && response.status === 404) { await response.body?.cancel(); return reject('REGISTRY_REFERENCE_NOT_FOUND'); }
    if (method === 'DELETE' && (response.status >= 500 || response.status === 408)) { await response.body?.cancel(); throw Object.assign(Error('registry_delete_unknown'), {code:'registry_delete_unknown'}); }
    if (!(response.ok || method === 'DELETE' && response.status === 404)) { await response.body?.cancel(); return reject(method==='DELETE'?'REGISTRY_DELETE_REJECTED':'REGISTRY_REQUEST_FAILED'); }
    let size = 0; const chunks: Uint8Array[] = [];
    if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) { await response.body.cancel().catch(()=>{}); return reject('REGISTRY_RESPONSE_LIMIT'); } chunks.push(chunk); }
    return {response, body:Buffer.concat(chunks)};
  }
  async page(path: string, key: 'repositories'|'tags', validate: (s:unknown)=>boolean) {
    const {response,body} = await this.request(path);
    let data: any; try { data = JSON.parse(body.toString()); } catch { return reject('INVALID_REGISTRY_RESPONSE'); }
    if(!data || typeof data!=='object' || !(key in data) || data[key]===null && key!=='tags')return reject('INVALID_REGISTRY_RESPONSE');
    if(key==='tags' && data.name!==new URL(path,this.c.endpoint).pathname.slice(4,-10))return reject('INVALID_REGISTRY_RESPONSE');
    const values = data[key] ?? [];
    if (!Array.isArray(values) || values.length > 1000 || values.some(s=>!validate(s))) return reject('INVALID_REGISTRY_RESPONSE');
    const link = response.headers.get('link'); let next: string | undefined;
    if (link) {
      const match = /^<([^>]+)>;\s*rel="?next"?$/.exec(link);
      if (!match) return reject('INVALID_REGISTRY_PAGINATION');
      const url = new URL(match[1], this.c.endpoint), original = new URL(path,this.c.endpoint);
      if (url.origin !== original.origin || url.pathname !== original.pathname || url.username || url.password || url.hash || !validate(url.searchParams.get('last')) || url.searchParams.get('last') !== values.at(-1) || url.searchParams.get('last') === original.searchParams.get('last')) return reject('INVALID_REGISTRY_PAGINATION');
      next = url.pathname + url.search;
    }
    return {values:values as string[],next};
  }
  async all(path:string,key:'repositories'|'tags',validate:(s:unknown)=>boolean,max:number) {
    const seen = new Set<string>(), values = new Set<string>(); let next:string|undefined=path;
    while (next) {
      if(seen.has(next) || seen.size > LIMIT) return reject('INVALID_REGISTRY_PAGINATION');
      seen.add(next); const page = await this.page(next,key,validate);
      page.values.forEach(v=>values.add(v)); if(values.size>max)return reject('REGISTRY_SCAN_LIMIT'); next=page.next;
    }
    return [...values].sort();
  }
  async manifest(repository:string,reference:string,depth=0,parents=new Set<string>()):Promise<{digest:string; children:string[]}> {
    const key=repository+'@'+reference, known=this.manifests.get(key); if(known)return known;
    if(depth>8 || parents.has(key) || this.manifests.size+this.pending.size>=LIMIT)return reject('REGISTRY_SCAN_LIMIT');
    const waiting=this.pending.get(key);if(waiting)return waiting;
    const lineage=new Set(parents);lineage.add(key);
    const promise=this.loadManifest(repository,reference,depth,lineage);
    this.pending.set(key,promise);
    try{return await promise}finally{this.pending.delete(key)}
  }
  private async loadManifest(repository:string,reference:string,depth:number,parents:Set<string>):Promise<{digest:string;children:string[]}> {
    const key=repository+'@'+reference;
    const {response,body}=await this.request('/v2/'+repository+'/manifests/'+reference);
    const digest='sha256:'+createHash('sha256').update(body).digest('hex');
    if(response.headers.get('docker-content-digest')!==digest || digestName(reference)&&reference!==digest)return reject('REGISTRY_DIGEST_MISMATCH');
    let data:any;try{data=JSON.parse(body.toString());}catch{return reject('INVALID_REGISTRY_MANIFEST');}
    if(data.schemaVersion!==2 || !ACCEPT.split(', ').includes(data.mediaType))return reject('INVALID_REGISTRY_MANIFEST');
    if(/index|list/.test(data.mediaType) && !Array.isArray(data.manifests))return reject('INVALID_REGISTRY_MANIFEST');
    if(data.manifests!==undefined && (!Array.isArray(data.manifests)||data.manifests.length>1000||data.manifests.some((d:any)=>!digestName(d.digest))))return reject('INVALID_REGISTRY_MANIFEST');
    const result={digest,children:[digest]};
    // A cycle or incomplete index rejects the entire scan before any deletion.
    for(const child of await parallelMap<any,{digest:string;children:string[]}>(data.manifests??[],child=>this.manifest(repository,child.digest,depth+1,parents)))result.children.push(...child.children);
    result.children=[...new Set(result.children)];this.manifests.set(key,result);this.manifests.set(repository+'@'+digest,result);return result;
  }
}

export async function executeRegistry(c:Record<string,any>,context:Pick<OperationExecutionContext,'signal'|'now'>,fetcher:typeof fetch=fetch):Promise<OperationExecutionResult> {
  validateRegistryConfig(c);
  const client=new RegistryClient(c,context.signal,fetcher);
  let deleting=false;
  try {
  if(c.task==='registry.inspect'&&!c.repository)return {verified:true,data:{repositories:await client.all('/v2/_catalog?n=100','repositories',repositoryName,1000)}};
  const refs=c.references as RegistryReference[];
  const protection=new Map<string,Map<string,{id:string;name:string}>>();
  for(const r of refs) {
    if(c.repository && r.repository!==c.repository)continue;
    let manifest;
    try { manifest=await client.manifest(r.repository,r.reference); } catch(e) { if(c.task==='registry.inspect' && e instanceof OperationRejectedError && e.message==='REGISTRY_REFERENCE_NOT_FOUND')continue; throw e; }
    for(const d of manifest.children){const key=r.repository+'@'+d;const apps=protection.get(key)??new Map();apps.set(r.id,{id:r.id,name:r.name});protection.set(key,apps);}
  }
  const versions=async(repository:string,tags:string[])=>{
    return parallelMap(tags,async tag=>{const m=await client.manifest(repository,tag);return {tag,digest:m.digest,used_by:[...(protection.get(repository+'@'+m.digest)?.values()??[])]};});
  };
  if(c.task==='registry.inspect'){
    const path='/v2/'+c.repository+'/tags/list?n=100'+(c.after?'&last='+encodeURIComponent(c.after):'');
    const page=await client.page(path,'tags',tagName);
    return {verified:true,data:{usage_complete:c.usage_complete!==false,repository:c.repository,versions:await versions(c.repository,page.values),next:page.next?new URL(page.next,c.endpoint).searchParams.get('last'):null}};
  }
  if(c.task!=='registry.cleanup')return reject('INVALID_PLATFORM_TASK');
  const repositories=await client.all('/v2/_catalog?n=100','repositories',repositoryName,1000);
  const groups=new Map<string,{repository:string;digest:string;tags:string[]}>();let count=0;
  for(const repository of repositories){
    const tags=await client.all('/v2/'+repository+'/tags/list?n=100','tags',tagName,LIMIT);
    count+=tags.length;if(count>LIMIT)return reject('REGISTRY_SCAN_LIMIT');
    for(const v of await versions(repository,tags)){const key=repository+'@'+v.digest;const group=groups.get(key)??{repository,digest:v.digest,tags:[]};group.tags.push(v.tag);groups.set(key,group);}
  }
  // Never delete roots reachable through another retained tag, including index children.
  const retained=[...groups.values()].filter(g=>protection.has(g.repository+'@'+g.digest));
  let deleted=0,deleted_tags=0,failed=0;const failures:{repository:string;digest:string;code:string}[]=[];
  for(const g of groups.values()){
    if(protection.has(g.repository+'@'+g.digest))continue;
    try {
      deleting=true;
      await client.request('/v2/'+g.repository+'/manifests/'+g.digest,'DELETE');deleted++;deleted_tags+=g.tags.length;
    }catch(e){
      if(!(e instanceof OperationRejectedError))throw e;
      failed++;if(failures.length<30)failures.push({repository:g.repository,digest:g.digest,code:e.message.toLowerCase()});
      if(e.message==='REGISTRY_DELETE_DISABLED')break;
    }
  }
  return {verified:failed===0,data:{deleted,deleted_tags,retained:retained.length,failed,skipped:groups.size-retained.length-deleted-failed,failures,partial:failed>0,scanned:groups.size,observed_at:context.now().toISOString()}};
  } catch(e) {
    if(!deleting && !context.signal.aborted && !(e instanceof OperationRejectedError))return reject('REGISTRY_REQUEST_FAILED');
    throw e;
  }
}
