import {join} from 'node:path';
import {existsSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DB} from '../shared/sqlite.js';
import {ApplicationObserver,readDockerLogs} from '../agent/application-observer.js';
import {saveLogCursor,type Batch,type LogCursor} from '../agent/queue.js';
import {encodeOTLP,nowNano} from '../shared/otlp.js';
import type {ApplicationObservation} from '../shared/application-observation.js';
import {operationCommand} from '../agent/operations.js';
import {inspectManagedDockerDaemon} from './docker.js';
import {rootPath,secureDirectory,refuse} from './security.js';
import {requestExecutor} from './client.js';
import type {ExecutorConfig} from './config.js';
/** Separate root-owned, bounded log cursor/outbox. No ordinary credentials or
 * socket access are forwarded. Existing collector parsing/dedup is shared. */
export class ExecutorApplicationObserver {
 private db:DB;private observer:ApplicationObserver;private metrics:any[]=[];private last=0;
 private attemptedAt='';private lastSuccessAt='';private error='';
 constructor(private config:ExecutorConfig){
  const data=join(config.data_dir,'observations');secureDirectory(data);
  this.db=new DB(join(data,'queue.sqlite'));this.db.exec("CREATE TABLE IF NOT EXISTS log_cursors(id TEXT PRIMARY KEY,offset INTEGER,generation INTEGER,prefix BLOB,path TEXT);CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,signal TEXT,payload BLOB,created_at TEXT)");
  const accept=(b:Batch,_owned:boolean,cursor?:LogCursor)=>this.db.transaction(()=>{saveObservationBatch(this.db,b.id,b.signal,b.payload);if(cursor)saveLogCursor(this.db,cursor);});
  const sdk={withTable:()=>({gauge:(name:string,{unit}:{unit:string})=>({record:(value:number,attributes:Record<string,string>)=>this.metrics.push({name,unit,gauge:{dataPoints:[{asDouble:value,timeUnixNano:nowNano().toString(),attributes:Object.entries(attributes).map(([key,value])=>({key,value:{stringValue:value}}))}]}})})})};
  const command:typeof operationCommand=async(_file,args,options)=>{if((await inspectManagedDockerDaemon()).daemon_id!==config.daemon_id)refuse('docker_daemon_changed');return operationCommand(this.binary(),['--host=unix:///var/run/docker.sock',...(args[0]==='--context'?args.slice(2):args)],options);};
  this.observer=new ApplicationObserver({queue:{db:this.db},identity:{agent_id:config.agent_id,host_id:config.machine_id},config:{max_batch_bytes:256<<10},accept,sdk} as any,command,(args,signal,stream,checkpoint)=>readDockerLogs(args,signal,stream,checkpoint,{executable:this.binary(),prefix:['--host=unix:///var/run/docker.sock']}));
 }
 private binary(){const path=['/usr/local/bin/docker','/usr/bin/docker'].find(p=>existsSync(p));if(!path)return refuse('docker_cli_missing');return rootPath(realpathSync(path));}
 status():ApplicationObservation {
  const row=this.db.get<{n:number;bytes:number}>('SELECT count(*) n,coalesce(sum(length(payload)),0) bytes FROM batches')!;
  return {state:this.error?'degraded':this.lastSuccessAt?'ok':'waiting',attempted_at:this.attemptedAt,last_success_at:this.lastSuccessAt,error:this.error,queue_batches:row.n,queue_bytes:row.bytes};
 }
 async collect(signal:AbortSignal){
  if(Date.now()-this.last<15000)return;this.last=Date.now();this.attemptedAt=new Date().toISOString();
  const errors:string[]=[];
  try{
   const policy=await requestExecutor(this.config,'observations/targets',{},undefined,undefined,undefined,signal);this.observer.targets=policy.targets;
   errors.push(...await this.flush(signal));
   if((await inspectManagedDockerDaemon()).daemon_id!==this.config.daemon_id)refuse('docker_daemon_changed');
   this.metrics=[];
   try{await this.observer.collect(signal);}catch(error){errors.push(observationDiagnostic(error));}
   // Docker stats are sampled before logs; retain them even when a log fails.
   for(let i=0;i<this.metrics.length;i+=100){
    const payload=encodeOTLP('metrics',{resourceMetrics:[{resource:{attributes:[{key:'service.name',value:{stringValue:'lightmoni-agent-helper'}}]},scopeMetrics:[{scope:{name:'lightmoni.application'},metrics:this.metrics.slice(i,i+100)}]}]});
    saveObservationBatch(this.db,randomUUID(),'metrics',payload);
   }
   errors.push(...await this.flush(signal));
  }catch(error){errors.push(observationDiagnostic(error));}
  this.error=errors[0]??'';if(!this.error)this.lastSuccessAt=new Date().toISOString();
 }
 private async flush(signal:AbortSignal){
  return flushObservationBatches(this.db,async batch=>{await requestExecutor(this.config,'observations/batches',{id:batch.id,signal:batch.signal,payload:Buffer.from(batch.payload).toString('base64')},undefined,undefined,undefined,signal);},signal);
 }
 close(){this.db.close();}
}
export function observationDiagnostic(error:unknown){
 const code=error instanceof Error?error.message:'';
 return /^(executor_http_\d{3}|application_log_collection_failed|observation_queue_full|docker_daemon_changed|docker_cli_missing)$/.test(code)?code:'application_collection_failed';
}
export function saveObservationBatch(db:DB,id:string,signal:string,payload:Buffer){
 const bytes=db.get<{n:number}>('SELECT coalesce(sum(length(payload)),0) n FROM batches WHERE signal=?',signal)!.n;
 // Reserve metric capacity even when logs are permanently rejected upstream.
 if(payload.length>256<<10||bytes+payload.length>(signal==='metrics'?4<<20:28<<20))refuse('observation_queue_full');
 db.run('INSERT INTO batches VALUES(?,?,?,?)',id,signal,payload,new Date().toISOString());
}
export async function flushObservationBatches(db:DB,send:(batch:any)=>Promise<void>,signal:AbortSignal){
 const errors:string[]=[];
 // Preserve FIFO within each signal; a rejected log cannot starve metrics.
 for(const kind of ['metrics','logs'])for(const batch of db.all<any>('SELECT * FROM batches WHERE signal=? ORDER BY created_at,id LIMIT 20',kind)){
  try{signal.throwIfAborted();await send(batch);db.run('DELETE FROM batches WHERE id=?',batch.id);}
  catch(error){errors.push(observationDiagnostic(error));break;}
 }
 return errors;
}
