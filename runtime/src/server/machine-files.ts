import { Client, type SFTPWrapper, type Stats } from 'ssh2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { TextDecoder } from 'node:util';
import { checkRequestOrigin, fail, HTTPError } from '../shared/http.js';
import type { Context, Dependencies, Module } from '../shared/types.js';
import type { MachineTerminalAccess, TerminalLease } from './managed-machines.js';
import { hostKeyAlgorithms } from './machine-host-keys.js';
import { cookie } from './auth.js';

export const TEXT_LIMIT = 1 << 20, UPLOAD_LIMIT = 8 << 20;
const FILE_SESSION_IDLE_MS = 20_000, FILE_SESSION_MAX_MS = 600_000;
const FILE_SESSION_HEADER = 'x-lightmoni-file-session';
type FileSession = {
  id:string;machineID:string;credentialID:string;actorID:string;loginHash:string;
  lease:TerminalLease;client:Client;sftp?:SFTPWrapper;createdAt:number;lastUsed:number;
  closed:boolean;closing:boolean;openers:number;queue:Promise<void>;pending:number;idleTimer?:ReturnType<typeof setTimeout>;maxTimer?:ReturnType<typeof setTimeout>;
};
type FileSessionOptions = {idleMs?:number;maxMs?:number;createClient?:()=>Client};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || value.split('/').includes('..')) fail(400, 'invalid_file_path');
  return posix.normalize(value);
}
const call = <T>(fn: (done: (error: any, value?: T) => void) => void): Promise<T> => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value as T)));
const version = (bytes: Buffer, stat: Stats) => digest(Buffer.from(JSON.stringify([digest(bytes),stat.size,stat.mtime,stat.mode,stat.uid,stat.gid])));
const metadataVersion = (stat: Stats) => digest(Buffer.from(JSON.stringify([stat.size,stat.mtime,stat.mode,stat.uid,stat.gid])));
const fileName = (value: unknown): string => {
  if(typeof value!=='string'||!value||value==='.'||value==='..'||Buffer.byteLength(value)>255||/[\\/\x00-\x1f\x7f]/.test(value))fail(400,'invalid_file_name');
  return value;
};
type FileAction = {operation:'create'|'mkdir'|'rename'|'remove'|'chmod';expected_version:string;confirmed:true;parent_version?:string;name?:string;mode?:string};
function fileAction(value: unknown): FileAction {
  const v=value as FileAction;
  if(!v||typeof v!=='object'||Array.isArray(v)||!['create','mkdir','rename','remove','chmod'].includes(v.operation)||v.confirmed!==true)fail(400,'invalid_file_action');
  const fields=['operation','expected_version','confirmed',...(['create','mkdir'].includes(v.operation)?['parent_version']:v.operation==='rename'?['name']:v.operation==='chmod'?['mode']:[])];
  if(Object.keys(v).some(key=>!fields.includes(key)))fail(400,'invalid_file_action');
  if(['create','mkdir'].includes(v.operation)) {
    if(v.expected_version!=='new'||!/^[a-f0-9]{64}$/.test(v.parent_version??''))fail(400,'invalid_file_action');
  }else if(!/^[a-f0-9]{64}$/.test(v.expected_version??''))fail(400,'invalid_file_action');
  if(v.operation==='rename')fileName(v.name);
  if(v.operation==='chmod'&&(typeof v.mode!=='string'||!/^0?[0-7]{3}$/.test(v.mode)))fail(400,'invalid_file_mode');
  return v;
}

// All paths are remote. No shell interpolation or local filesystem operations.
export class RemoteFiles {
  mutationStarted = false;
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
    const stat=await this.stat(canonical);if(!stat?.isDirectory())fail(409,'file_type_unsupported');
    const entries: Array<{name:string;type:string;size:number;mode:string;modified_at:string;version:string}> = [];
    let truncated = false;
    try {
      while (true) {
        const batch = await this.invoke<any>(done => this.sftp.readdir(handle, done)).catch(error=>{if(error.code===1)return false;throw error;});
        if (batch === false) break;
        for (const item of batch) {
          if (item.filename === '.' || item.filename === '..') continue;
          if (entries.length === 2000) { truncated = true; break; }
          const stat = item.attrs as Stats;
          entries.push({name:item.filename,type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'special',size:stat.size,mode:(stat.mode & 0o7777).toString(8).padStart(4,'0'),modified_at:new Date(stat.mtime*1000).toISOString(),version:metadataVersion(stat)});
        }
        if (truncated) break;
      }
    } finally { await call(done => this.sftp.close(handle, done)); }
    entries.sort((a,b) => Number(b.type==='directory')-Number(a.type==='directory') || a.name.localeCompare(b.name));
    const after=await this.stat(canonical);if(!after||metadataVersion(stat)!==metadataVersion(after))fail(409,'file_changed');
    const directoryVersion=digest(Buffer.from(JSON.stringify([metadataVersion(after),entries.map(entry=>[entry.name,entry.version]).sort(([a],[b])=>a.localeCompare(b))])));
    return {path:canonical,entries,truncated,version:directoryVersion};
  }
  /** Maintenance never downloads file contents. Directory versions also cover
   * the bounded immediate child inventory; recursive traversal is not allowed. */
  async metadata(path: string) {
    path=await this.target(path);
    const stat=await this.stat(path);if(!stat)fail(404,'file_not_found');
    if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())fail(409,'file_type_unsupported');
    let entryVersion=metadataVersion(stat),empty: boolean|undefined;
    if(stat.isDirectory()) {
      const directory=await this.list(path);
      if(directory.truncated)fail(409,'file_directory_limit');
      const latest=await this.stat(path);
      if(directory.path!==path||!latest?.isDirectory()||latest.isSymbolicLink()||metadataVersion(latest)!==metadataVersion(stat))fail(409,'file_changed');
      entryVersion=directory.version;empty=directory.entries.length===0;
    }
    return {path,type:stat.isDirectory()?'directory':'file',size:stat.size,mode:(stat.mode&0o7777).toString(8).padStart(4,'0'),version:entryVersion,...(empty===undefined?{}:{empty}),stat_version:metadataVersion(stat)};
  }
  private async mutate(fn: (done: (error: any, value?: void) => void) => void) {
    this.check();this.mutationStarted=true;
    try {await call(fn);}catch(error:any){if([2,3,11].includes(error.code))this.mutationStarted=false;throw error;}
    this.check();
  }
  async action(path: string, input: FileAction) {
    if(path==='/')fail(400,'file_root_mutation_forbidden');
    fileName(posix.basename(path));path=await this.target(path);
    if(['create','mkdir'].includes(input.operation)) {
      const parent=await this.metadata(posix.dirname(path));
      if(parent.type!=='directory'||parent.version!==input.parent_version)fail(409,'file_changed');
      if(await this.stat(path))fail(409,'file_already_exists');
      if(input.operation==='mkdir')await this.mutate(done=>this.sftp.mkdir(path,{mode:0o700},done));
      else {
        this.check();this.mutationStarted=true;
        let handle:Buffer;
        try{handle=await call<Buffer>(done=>this.sftp.open(path,'wx',0o600,done));}
        catch(error:any){if([2,3,4,11].includes(error.code)){this.mutationStarted=false;if([4,11].includes(error.code))fail(409,'file_already_exists');}throw error;}
        try{this.check();}finally{await call(done=>this.sftp.close(handle,done));}
      }
      const saved=await this.metadata(path);
      if(saved.type!==(input.operation==='mkdir'?'directory':'file')||saved.type==='file'&&saved.size!==0||saved.type==='directory'&&!saved.empty)fail(409,'file_action_unverified');
      return saved;
    }
    const current=await this.metadata(path);
    if(current.version!==input.expected_version)fail(409,'file_changed');
    if(input.operation==='rename') {
      const destination=posix.join(posix.dirname(path),fileName(input.name));
      if(destination===path)fail(400,'invalid_file_name');
      if(await this.stat(destination))fail(409,'file_already_exists');
      // The standard SFTP v3 rename is non-overwriting. Do not use the
      // OpenSSH POSIX rename extension, which replaces an existing target.
      await this.mutate(done=>this.sftp.rename(path,destination,done));
      const saved=await this.metadata(destination);
      if(await this.stat(path)||saved.version!==current.version)fail(409,'file_action_unverified');
      return saved;
    }
    if(input.operation==='remove') {
      if(current.type==='directory'&&!current.empty)fail(409,'file_directory_not_empty');
      await this.mutate(done=>current.type==='directory'?this.sftp.rmdir(path,done):this.sftp.unlink(path,done));
      if(await this.stat(path))fail(409,'file_action_unverified');
      return {path,removed:true};
    }
    const mode=parseInt(input.mode!,8);
    const handle=await this.invoke<Buffer>(done=>current.type==='directory'?this.sftp.opendir(path,done):this.sftp.open(path,'r',done));
    try {
      const opened=await this.invoke<Stats>(done=>this.sftp.fstat(handle,done));
      if(metadataVersion(opened)!==current.stat_version)fail(409,'file_changed');
      await this.mutate(done=>this.sftp.fsetstat(handle,{mode},done));
    }finally{await call(done=>this.sftp.close(handle,done));}
    const saved=await this.metadata(path);
    if(saved.type!==current.type||parseInt(saved.mode,8)!==mode||saved.size!==current.size)fail(409,'file_action_unverified');
    return saved;
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
      const bytes = Buffer.alloc(opened.size);
      const chunkSize = 32 << 10;
      let nextOffset = 0, failed = false;
      const worker = async () => {
        try {
          while (!failed && nextOffset < opened.size) {
            const start = nextOffset, end = Math.min(start + chunkSize, opened.size);
            nextOffset = end;
            for (let offset = start; offset < end;) {
              const count = await this.invoke<number>(done => this.sftp.read(handle, bytes, offset, end - offset, offset, (e,n) => done(e,n)));
              if (!count) fail(409, 'file_changed');
              offset += count;
            }
          }
        } catch (error) { failed = true; throw error; }
      };
      // Wait for every in-flight READ before fstat or closing the shared handle.
      const reads = await Promise.allSettled(Array.from({length:Math.min(8,Math.ceil(opened.size/chunkSize))},worker));
      const rejected = reads.find((result):result is PromiseRejectedResult=>result.status==='rejected');
      if (rejected) throw rejected.reason;
      const after = await this.invoke<Stats>(done => this.sftp.fstat(handle, done));
      if (opened.size !== after.size || version(Buffer.alloc(0),opened) !== version(Buffer.alloc(0),after)) fail(409,'file_changed');
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
      this.check();this.mutationStarted=true;
      if (original) await this.invoke<void>(done => this.sftp.ext_openssh_rename(temporary,path,done));
      else await this.invoke<void>(done => this.sftp.ext_openssh_hardlink(temporary,path,done));
      published = true;
      const saved = await this.read(path);
      if (!saved || digest(saved.bytes)!==digest(bytes)) fail(409,'file_write_unverified');
      return {path,version:saved.version,size:saved.bytes.length};
    } catch (error: any) {
      if(error?.message==='Server does not support this extended request'||error?.code===8){this.mutationStarted=false;fail(409,'file_atomic_operation_unsupported');}
      if (published) fail(409,'file_write_unverified');
      throw error;
    } finally { if (created) await call(done=>this.sftp.unlink(temporary,done)).catch(()=>{}); }
  }
}

export function registerMachineFiles(deps: Dependencies, machines: MachineTerminalAccess, options: FileSessionOptions = {}): Module {
  const idleMs=options.idleMs??FILE_SESSION_IDLE_MS,maxMs=options.maxMs??FILE_SESSION_MAX_MS;
  const connections = new Set<Client>(), requests = new Set<Promise<void>>(), sessions=new Map<string,FileSession>();
  const changedSessions=new Map<string,{machineID:string;actorID:string;loginHash:string}>();
  let stopped = false;
  const track=(request:Promise<void>)=>{requests.add(request);void request.finally(()=>requests.delete(request)).catch(()=>{});return request;};
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_file_events(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,account_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation TEXT NOT NULL,path TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)`);
  const human = (ctx: Context) => {
    deps.auth.requireAdmin(ctx);
    const user = deps.auth.user(ctx.req);
    if (ctx.req.headers.authorization || !ctx.req.headers.cookie?.split(';').some(v=>v.trim().startsWith('lm_session=')) || user?.id!==ctx.user.id || user.role!=='admin') fail(403,'human_admin_session_required');
  };
  const loginHash=(ctx:Context)=>digest(Buffer.from(cookie(ctx.req,'lm_session')??''));
  const closeSession=(session:FileSession,reason:'expired'|'changed')=>{
    if(session.closed)return;
    session.closed=true;sessions.delete(session.id);clearTimeout(session.idleTimer);clearTimeout(session.maxTimer);
    if(reason==='changed'){
      changedSessions.set(session.id,{machineID:session.machineID,actorID:session.actorID,loginHash:session.loginHash});
      const cleanup=setTimeout(()=>changedSessions.delete(session.id),60_000);cleanup.unref?.();
      if(changedSessions.size>100)changedSessions.delete(changedSessions.keys().next().value!);
    }
    session.client.destroy();connections.delete(session.client);session.lease.release();
  };
  const expireSession=(session:FileSession)=>{
    if(session.closed)return;
    if(session.pending){session.closing=true;clearTimeout(session.idleTimer);return;}
    closeSession(session,'expired');
  };
  const scheduleIdle=(session:FileSession)=>{
    clearTimeout(session.idleTimer);
    if(session.closed||session.pending)return;
    if(session.closing){closeSession(session,'expired');return;}
    session.idleTimer=setTimeout(()=>expireSession(session),idleMs);session.idleTimer.unref?.();
  };
  const releaseOpener=(session:FileSession)=>{
    if(session.closed)return;
    session.openers--;
    if(session.openers<=0)expireSession(session);else scheduleIdle(session);
  };
  const sessionHeader=(ctx:Context)=>{
    const value=ctx.req.headers[FILE_SESSION_HEADER];
    if(value===undefined)return undefined;
    if(typeof value!=='string'||!(/^[A-Za-z0-9_-]{20,128}$/).test(value))fail(400,'invalid_file_session');
    return value;
  };
  const sessionFor=(ctx:Context,id:string,credential?:string)=>{
    const session=sessions.get(id);
    if(!session){
      const changed=changedSessions.get(id);
      if(changed&&changed.machineID===ctx.params.id&&changed.actorID===ctx.user.id&&changed.loginHash===loginHash(ctx))fail(409,'file_credential_changed');
      fail(409,'file_session_expired');
    }
    if(session.machineID!==ctx.params.id||session.actorID!==ctx.user.id||session.loginHash!==loginHash(ctx))fail(403,'file_session_forbidden');
    if(credential!==undefined&&credential!==session.credentialID)fail(409,'file_credential_changed');
    if(session.closing)fail(409,'file_session_expired');
    if(Date.now()-session.createdAt>=maxMs){expireSession(session);fail(409,'file_session_expired');}
    if(!session.lease.valid()){closeSession(session,'changed');fail(409,'file_credential_changed');}
    return session;
  };
  const sessionWork=async(session:FileSession,operation:string,work:(files:RemoteFiles,path:string,ctx:Context)=>Promise<unknown>,path:string,ctx:Context)=>{
    if(session.pending>=8)fail(429,'file_session_busy');
    session.pending++;clearTimeout(session.idleTimer);
    const previous=session.queue;
    let release!:()=>void;session.queue=new Promise<void>(resolve=>{release=resolve});
    await previous;
    let remote:RemoteFiles|undefined,result='failed';
    const check=()=>{
      human(ctx);ctx.signal.throwIfAborted();
      if(session.closed)fail(409,'file_session_expired');
      if(!session.lease.valid()){closeSession(session,'changed');fail(409,'file_credential_changed');}
    };
    const abort=()=>closeSession(session,'expired');
    ctx.signal.addEventListener('abort',abort,{once:true});
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      if(session.closing)fail(409,'file_session_expired');
      check();remote=new RemoteFiles(session.sftp!,check);
      const value=await Promise.race([
        work(remote,path,ctx),
        new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{closeSession(session,'expired');reject(new HTTPError(504,'file_operation_timeout'));},30_000);})
      ]);
      check();result='succeeded';session.lastUsed=Date.now();ctx.json({machine_id:ctx.params.id,...value as object});
    }catch(error:any){
      const uncertainWrite=['write','upload'].includes(operation)&&(remote?.mutationStarted||!(error instanceof HTTPError)||error.status>=500||error.message==='file_write_unverified');
      if(remote?.mutationStarted||uncertainWrite)result='unknown';
      if(uncertainWrite)fail(409,'file_write_unverified');
      if(remote?.mutationStarted)fail(409,'file_action_unverified');
      if(error instanceof HTTPError)throw error;
      if(error.code===2)fail(404,'file_not_found');
      if(error.code===3)fail(403,'file_permission_denied');
      if(error.code===8)fail(409,'file_atomic_operation_unsupported');
      fail(502,'file_operation_failed');
    }finally{
      clearTimeout(timeout);ctx.signal.removeEventListener('abort',abort);session.pending--;release();scheduleIdle(session);
      deps.db.run('INSERT INTO machine_file_events VALUES(?,?,?,?,?,?,?,?)',randomUUID(),ctx.params.id,session.lease.machine.account_id,ctx.user.id,operation,path,result,deps.now().toISOString());
    }
  };
  const run = (operation: string, work: (files: RemoteFiles,path: string,ctx: Context) => Promise<unknown>) => {
   const handler = async (ctx: Context) => {
    human(ctx);ctx.res.setHeader('Cache-Control','no-store');
    const path = filePath(ctx.url.searchParams.get('path') ?? '/');
    const credential = ctx.url.searchParams.get('credential_id') ?? undefined;
    if (credential!==undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(credential)) fail(400,'invalid_credential_id');
    if (stopped) fail(503,'file_service_stopped');
    const sessionID=sessionHeader(ctx);
    if(sessionID)return sessionWork(sessionFor(ctx,sessionID,credential),operation,work,path,ctx);
    if (connections.size >= 20) fail(429,'file_connections_limit');
    const client = options.createClient?.()??new Client();
    const lease = machines.acquireTerminal(ctx.params.id,credential,()=>client.destroy());
    connections.add(client);
    let result = 'failed', mismatch=false, remote:RemoteFiles|undefined;
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
              remote=new RemoteFiles(sftp,check);work(remote,path,ctx).then(resolve,reject);
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
      const uncertainWrite=['write','upload'].includes(operation)&&(remote?.mutationStarted||!(error instanceof HTTPError)||error.status>=500||error.message==='file_write_unverified');
      if(remote?.mutationStarted||uncertainWrite)result='unknown';
      if(uncertainWrite)fail(409,'file_write_unverified');
      if(remote?.mutationStarted)fail(409,'file_action_unverified');
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
     return track(handler(ctx));
   };
  };
  const base='/api/v1/machines/:id';
  const openSession=async(ctx:Context)=>{
    ctx.res.setHeader('Cache-Control','no-store');human(ctx);checkRequestOrigin(ctx.req,deps.externalURL,true);
    const input=await ctx.body<any>();
    const fields=input&&typeof input==='object'&&!Array.isArray(input)?Object.keys(input).sort().join(','):'';
    if(!['credential_id','credential_id,initial_path'].includes(fields)||typeof input.credential_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.credential_id))fail(400,'invalid_file_session');
    const initialPath=fields==='credential_id,initial_path'?filePath(input.initial_path):undefined;
    if(stopped)fail(503,'file_service_stopped');
    const response=(session:FileSession)=>({machine_id:session.machineID,credential_id:session.credentialID,session_id:session.id,idle_timeout_ms:idleMs,expires_at:new Date(session.createdAt+maxMs).toISOString()});
    const respond=async(session:FileSession)=>{
      if(initialPath===undefined)ctx.json(response(session));
      else await sessionWork(session,'list',async(files,path)=>({...response(session),initial_directory:{machine_id:session.machineID,...await files.list(path)}}),initialPath,ctx);
    };
    // Tabs from one login may share the same bound SFTP connection. Keep the
    // original handle alive if a second tab asks for a different credential.
    const identity=loginHash(ctx);
    const existing=[...sessions.values()].find(value=>value.machineID===ctx.params.id&&value.actorID===ctx.user.id&&value.loginHash===identity);
    if(existing){
      if(existing.closing)fail(409,'file_session_busy');
      if(Date.now()-existing.createdAt>=maxMs){expireSession(existing);if(!existing.closed)fail(409,'file_session_busy');}
      else if(!existing.lease.valid())closeSession(existing,'changed');
      else{
        if(existing.credentialID!==input.credential_id)fail(409,'file_session_busy');
        if(existing.openers>=8)fail(429,'file_session_busy');
        existing.openers++;existing.lastUsed=Date.now();scheduleIdle(existing);
        try{await respond(existing);}catch(error){releaseOpener(existing);throw error;}
        return;
      }
    }
    if(connections.size>=20)fail(429,'file_connections_limit');
    let session:FileSession|undefined;
    const lease=machines.acquireTerminal(ctx.params.id,input.credential_id,()=>{if(session)closeSession(session,'changed');});
    let client:Client;
    try{client=options.createClient?.()??new Client();}catch(error){lease.release();throw error;}
    const createdAt=Date.now();
    session={id:randomBytes(24).toString('base64url'),machineID:ctx.params.id,credentialID:lease.credentialID,actorID:ctx.user.id,loginHash:identity,lease,client,createdAt,lastUsed:createdAt,closed:false,closing:false,openers:1,queue:Promise.resolve(),pending:0};
    const current=session;connections.add(client);
    let mismatch=false,connectTimeout:ReturnType<typeof setTimeout>|undefined,published=false;
    const abort=()=>closeSession(current,'expired');ctx.signal.addEventListener('abort',abort,{once:true});
    try{
      const connected=new Promise<void>((resolve,reject)=>{
        let settled=false;
        const failed=(error:HTTPError)=>{if(!settled){settled=true;reject(error);}else closeSession(current,'expired');};
        client.on('error',()=>failed(new HTTPError(502,mismatch?'host_key_mismatch':'file_ssh_failed')));
        client.on('close',()=>failed(new HTTPError(502,'file_connection_closed')));
        client.once('ready',()=>{
          if(current.closed)return failed(new HTTPError(409,'file_session_expired'));
          client.sftp((error,sftp)=>{
            if(error)return failed(new HTTPError(502,'file_sftp_unavailable'));
            if(current.closed)return failed(new HTTPError(409,'file_session_expired'));
            current.sftp=sftp;settled=true;resolve();
          });
        });
        try{
          const m=lease.machine;
          client.connect({host:m.address.replace(/^\[|\]$/g,''),port:m.port,username:m.username,
            ...(lease.credentialMethod==='password'?{password:lease.password,tryKeyboard:false}:{privateKey:lease.privateKey}),
            algorithms:hostKeyAlgorithms(m),readyTimeout:15000,keepaliveInterval:15000,keepaliveCountMax:2,
            hostVerifier(key:Buffer){try{mismatch=!lease.verifyHostKey(key);}catch{mismatch=true;}return !mismatch;}});
          lease.privateKey='';lease.password='';
        }catch{failed(new HTTPError(502,'file_ssh_failed'));}
      });
      await Promise.race([connected,new Promise<never>((_,reject)=>{connectTimeout=setTimeout(()=>{closeSession(current,'expired');reject(new HTTPError(504,'file_operation_timeout'));},30_000);})]);
      clearTimeout(connectTimeout);connectTimeout=undefined;
      human(ctx);ctx.signal.throwIfAborted();
      if(current.closed)fail(409,'file_session_expired');
      if(!lease.valid()){closeSession(current,'changed');fail(409,'file_credential_changed');}
      lease.markUsed();sessions.set(current.id,current);
      current.maxTimer=setTimeout(()=>expireSession(current),maxMs);current.maxTimer.unref?.();scheduleIdle(current);
      published=true;
      await respond(current);
    }catch(error){if(published)releaseOpener(current);else closeSession(current,'expired');throw error;}
    finally{clearTimeout(connectTimeout);ctx.signal.removeEventListener('abort',abort);}
  };
  deps.router.post(base+'/file-session',ctx=>track(openSession(ctx)));
  deps.router.delete(base+'/file-session',ctx=>{
    ctx.res.setHeader('Cache-Control','no-store');human(ctx);checkRequestOrigin(ctx.req,deps.externalURL,true);
    const id=sessionHeader(ctx);if(!id)fail(400,'invalid_file_session');
    const session=sessions.get(id);
    if(session&&(session.machineID!==ctx.params.id||session.actorID!==ctx.user.id||session.loginHash!==loginHash(ctx)))fail(403,'file_session_forbidden');
    if(session)releaseOpener(session);
    ctx.res.writeHead(204);ctx.res.end();
  });
  deps.router.get(base+'/files',run('list',(files,path)=>files.list(path)));
  deps.router.get(base+'/file',run('read',(files,path)=>files.text(path)));
  deps.router.get(base+'/file-version',run('version',async(files,path)=>({path,version:(await files.read(path))?.version??null})));
  deps.router.get(base+'/file-metadata',run('metadata',(files,path)=>files.metadata(path)));
  deps.router.post(base+'/file-actions',async ctx=>{
    human(ctx);
    const input=fileAction(await ctx.body());
    return run(input.operation,(files,path)=>files.action(path,input))(ctx);
  });
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
  return {async close(){stopped=true;for(const session of sessions.values())closeSession(session,'expired');for(const client of connections)client.destroy();await Promise.allSettled([...requests]);}};
}
