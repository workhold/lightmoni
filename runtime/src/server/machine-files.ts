import { Client, type SFTPWrapper, type Stats } from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { TextDecoder } from 'node:util';
import { fail, HTTPError } from '../shared/http.js';
import type { Context, Dependencies, Module } from '../shared/types.js';
import type { MachineTerminalAccess } from './managed-machines.js';
import { hostKeyAlgorithms } from './machine-host-keys.js';

export const TEXT_LIMIT = 1 << 20, UPLOAD_LIMIT = 8 << 20;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || value.split('/').includes('..')) fail(400, 'invalid_file_path');
  return posix.normalize(value);
}
const call = <T>(fn: (done: (error: any, value?: T) => void) => void): Promise<T> => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value as T)));
const version = (bytes: Buffer, stat: Stats) => digest(Buffer.from(JSON.stringify([digest(bytes),stat.size,stat.mtime,stat.mode,stat.uid,stat.gid])));

// All paths are remote. No shell interpolation or local filesystem operations.
export class RemoteFiles {
  constructor(private sftp: SFTPWrapper, private check: () => void) {}
  private async invoke<T>(fn: (done: (error: any, value?: T) => void) => void) { this.check(); const value = await call(fn); this.check(); return value; }
  async target(path: string) {
    const parent = await this.invoke<string>(done => this.sftp.realpath(posix.dirname(path), done));
    return posix.join(parent, posix.basename(path));
  }
  async stat(path: string): Promise<Stats | null> {
    try { return await this.invoke<Stats>(done => this.sftp.lstat(path, done)); }
    catch (e: any) { if (e.code === 2) return null; throw e; }
  }
  async list(path: string) {
    const canonical = await this.invoke<string>(done => this.sftp.realpath(path, done));
    const handle = await this.invoke<Buffer>(done => this.sftp.opendir(canonical, done));
    const entries: Array<{name:string;type:string;size:number;mode:string;modified_at:string}> = [];
    let truncated = false;
    try {
      while (true) {
        const batch = await this.invoke<any>(done => this.sftp.readdir(handle, done)).catch(error=>{if(error.code===1)return false;throw error;});
        if (batch === false) break;
        for (const item of batch) {
          if (item.filename === '.' || item.filename === '..') continue;
          if (entries.length === 2000) { truncated = true; break; }
          const stat = item.attrs as Stats;
          entries.push({name:item.filename,type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'special',size:stat.size,mode:(stat.mode & 0o7777).toString(8).padStart(4,'0'),modified_at:new Date(stat.mtime*1000).toISOString()});
        }
        if (truncated) break;
      }
    } finally { await call(done => this.sftp.close(handle, done)); }
    entries.sort((a,b) => Number(b.type==='directory')-Number(a.type==='directory') || a.name.localeCompare(b.name));
    return {path:canonical,entries,truncated};
  }
  async read(path: string, limit = UPLOAD_LIMIT) {
    const stat = await this.stat(path);
    if (!stat) return null;
    if (!stat.isFile()) fail(409, 'file_type_unsupported');
    if (stat.size > limit) fail(413, 'file_too_large');
    // fstat the opened handle as well: a path may change between lstat/open.
    const handle = await this.invoke<Buffer>(done => this.sftp.open(path, 'r', done));
    try {
      const opened = await this.invoke<Stats>(done => this.sftp.fstat(handle, done));
      if (!opened.isFile()) fail(409, 'file_type_unsupported');
      if (opened.size > limit) fail(413, 'file_too_large');
      const chunks: Buffer[] = []; let offset = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 << 10, limit + 1 - offset));
        const count = await this.invoke<number>(done => this.sftp.read(handle, buffer, 0, buffer.length, offset, (e,n) => done(e,n)));
        if (!count) break;
        offset += count; if (offset > limit) fail(413, 'file_too_large');
        chunks.push(buffer.subarray(0,count));
      }
      const after = await this.invoke<Stats>(done => this.sftp.fstat(handle, done));
      if (opened.size !== offset || version(Buffer.alloc(0),opened) !== version(Buffer.alloc(0),after)) fail(409,'file_changed');
      const bytes = Buffer.concat(chunks);
      return {bytes,stat:after,version:version(bytes,after)};
    } finally { await call(done => this.sftp.close(handle, done)); }
  }
  async text(path: string) {
    const found = await this.read(path, TEXT_LIMIT);
    if (!found) fail(404, 'file_not_found');
    let content: string;
    try { content = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(found.bytes); if (content.includes('\0')) throw Error(); }
    catch { fail(409,'file_not_utf8_text'); }
    return {path,content,version:found.version,size:found.bytes.length};
  }
  async write(path: string, bytes: Buffer, expected: string | null) {
    if (bytes.length > UPLOAD_LIMIT) fail(413,'file_too_large');
    path = await this.target(path);
    const original = await this.read(path);
    if ((original?.version ?? null) !== expected) fail(409,'file_changed');
    const temporary = posix.join(posix.dirname(path),'.lightmoni-upload-'+randomUUID());
    let created = false, published = false;
    try {
      const handle = await this.invoke<Buffer>(done => this.sftp.open(temporary,'wx',0o600,done)); created = true;
      try {
        for (let offset=0;offset<bytes.length;offset+=64<<10) {
          const count=Math.min(64<<10,bytes.length-offset);
          await this.invoke<void>(done => this.sftp.write(handle,bytes,offset,count,offset,done));
        }
        if (original) await this.invoke<void>(done => this.sftp.fsetstat(handle,{uid:original.stat.uid,gid:original.stat.gid,mode:original.stat.mode & 0o777},done));
      } finally { await call(done => this.sftp.close(handle,done)); }
      const latest = await this.read(path);
      if ((latest?.version ?? null) !== expected) fail(409,'file_changed');
      if (original) await this.invoke<void>(done => this.sftp.ext_openssh_rename(temporary,path,done));
      else await this.invoke<void>(done => this.sftp.ext_openssh_hardlink(temporary,path,done));
      published = true;
      const saved = await this.read(path);
      if (!saved || digest(saved.bytes)!==digest(bytes)) fail(409,'file_write_unverified');
      return {path,version:saved.version,size:saved.bytes.length};
    } catch (error: any) {
      if(error?.message==='Server does not support this extended request')fail(409,'file_atomic_operation_unsupported');
      if (published) fail(409,'file_write_unverified');
      throw error;
    } finally { if (created) await call(done=>this.sftp.unlink(temporary,done)).catch(()=>{}); }
  }
}

export function registerMachineFiles(deps: Dependencies, machines: MachineTerminalAccess): Module {
  const connections = new Set<Client>(), requests = new Set<Promise<void>>(); let stopped = false;
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_file_events(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,account_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation TEXT NOT NULL,path TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)`);
  const human = (ctx: Context) => {
    deps.auth.requireAdmin(ctx);
    const user = deps.auth.user(ctx.req);
    if (ctx.req.headers.authorization || !ctx.req.headers.cookie?.split(';').some(v=>v.trim().startsWith('lm_session=')) || user?.id!==ctx.user.id || user.role!=='admin') fail(403,'human_admin_session_required');
  };
  const run = (operation: string, work: (files: RemoteFiles,path: string,ctx: Context) => Promise<unknown>) => {
   const handler = async (ctx: Context) => {
    human(ctx);ctx.res.setHeader('Cache-Control','no-store');
    const path = filePath(ctx.url.searchParams.get('path') ?? '/');
    const credential = ctx.url.searchParams.get('credential_id') ?? undefined;
    if (credential!==undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(credential)) fail(400,'invalid_credential_id');
    if (stopped) fail(503,'file_service_stopped');
    if (connections.size >= 20) fail(429,'file_connections_limit');
    const client = new Client();
    const lease = machines.acquireTerminal(ctx.params.id,credential,()=>client.destroy());
    connections.add(client);
    let result = 'failed', mismatch=false;
    const check=()=>{human(ctx);ctx.signal.throwIfAborted();if(!lease.valid())fail(409,'file_credential_changed');};
    const abort=()=>client.destroy();ctx.signal.addEventListener('abort',abort,{once:true});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{reject(new HTTPError(504,'file_operation_timeout'));client.destroy();},30000);}),
        new Promise<unknown>((resolve,reject)=>{
          client.once('error',()=>reject(new HTTPError(502,mismatch?'host_key_mismatch':'file_ssh_failed')));
          client.once('close',()=>reject(new HTTPError(502,'file_connection_closed')));
          client.once('ready',()=>{
            try { check();lease.markUsed();client.sftp((error,sftp)=>{
              if(error)return reject(new HTTPError(502,'file_sftp_unavailable'));
              work(new RemoteFiles(sftp,check),path,ctx).then(resolve,reject);
            }); } catch(error) {reject(error);}
          });
          const m=lease.machine;
          client.connect({host:m.address.replace(/^\[|\]$/g,''),port:m.port,username:m.username,
            ...(lease.credentialMethod==='password'?{password:lease.password,tryKeyboard:false}:{privateKey:lease.privateKey}),
            algorithms:hostKeyAlgorithms(m),readyTimeout:15000,hostVerifier(key:Buffer){try{mismatch=!lease.verifyHostKey(key);}catch{mismatch=true;}return !mismatch;}});
          lease.privateKey='';lease.password='';
        })
      ]);
      check();result='succeeded';ctx.json({machine_id:ctx.params.id,...value as object});
    } catch (error: any) {
      if(['write','upload'].includes(operation)&&(!(error instanceof HTTPError)||error.status>=500||error.message==='file_write_unverified'))result='unknown';
      if (error instanceof HTTPError) throw error;
      if (error.code===2) fail(404,'file_not_found');
      if (error.code===3) fail(403,'file_permission_denied');
      if (error.code===8) fail(409,'file_atomic_operation_unsupported');
      fail(502,'file_operation_failed');
    } finally {
      clearTimeout(timeout);ctx.signal.removeEventListener('abort',abort);client.destroy();connections.delete(client);lease.release();
      deps.db.run('INSERT INTO machine_file_events VALUES(?,?,?,?,?,?,?,?)',randomUUID(),ctx.params.id,lease.machine.account_id,ctx.user.id,operation,path,result,deps.now().toISOString());
    }
   };
   return (ctx: Context) => {
     const request = handler(ctx);requests.add(request);
     void request.finally(()=>requests.delete(request)).catch(()=>{});
     return request;
   };
  };
  const base='/api/v1/machines/:id';
  deps.router.get(base+'/files',run('list',(files,path)=>files.list(path)));
  deps.router.get(base+'/file',run('read',(files,path)=>files.text(path)));
  deps.router.get(base+'/file-version',run('version',async(files,path)=>({path,version:(await files.read(path))?.version??null})));
  deps.router.put(base+'/file',run('write',async(files,path,ctx)=>{
    const input=await ctx.body<any>();
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['content','expected_version','confirmed'].includes(k))||input.confirmed!==true||typeof input.content!=='string'||!/^[a-f0-9]{64}$/.test(input.expected_version??''))fail(400,'invalid_file_write');
    if(input.content.includes('\0'))fail(400,'file_not_utf8_text');
    const bytes=Buffer.from(input.content);if(bytes.length>TEXT_LIMIT)fail(413,'file_too_large');
    return files.write(path,bytes,input.expected_version);
  }));
  deps.router.post(base+'/file-upload',run('upload',async(files,path,ctx)=>{
    const expected=ctx.url.searchParams.get('expected_version');
    if(ctx.url.searchParams.get('confirmed')!=='true'||expected!=='new'&&!/^[a-f0-9]{64}$/.test(expected??''))fail(400,'invalid_file_upload');
    return files.write(path,await ctx.raw(UPLOAD_LIMIT),expected==='new'?null:expected!);
  }));
  return {async close(){stopped=true;for(const client of connections)client.destroy();await Promise.allSettled([...requests]);}};
}
