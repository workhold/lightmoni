import {join} from 'node:path';
import {existsSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DB} from '../shared/sqlite.js';
import {ApplicationObserver,readDockerLogs} from '../agent/application-observer.js';
import {saveLogCursor,type Batch,type LogCursor} from '../agent/queue.js';
import {encodeOTLP,nowNano} from '../shared/otlp.js';
import {APPLICATION_TABLE} from '../shared/application-observation.js';
import {operationCommand} from '../agent/operations.js';
import {inspectManagedDockerDaemon} from './docker.js';
import {rootPath,secureDirectory,refuse} from './security.js';
import {requestExecutor} from './client.js';
import type {ExecutorConfig} from './config.js';
/** Separate root-owned, bounded log cursor/outbox. No ordinary credentials or
 * socket access are forwarded. Existing collector parsing/dedup is shared. */
export class ExecutorApplicationObserver {
 private db:DB;private observer:ApplicationObserver;private metrics:any[]=[];private last=0;
 constructor(private config:ExecutorConfig){
  const data=join(config.data_dir,'observations');secureDirectory(data);
  this.db=new DB(join(data,'queue.sqlite'));this.db.exec("CREATE TABLE IF NOT EXISTS log_cursors(id TEXT PRIMARY KEY,offset INTEGER,generation INTEGER,prefix BLOB,path TEXT);CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,signal TEXT,payload BLOB,created_at TEXT)");
  const accept=(b:Batch,_owned:boolean,cursor?:LogCursor)=>this.db.transaction(()=>{const size=this.db.get<{n:number}>('SELECT coalesce(sum(length(payload)),0) n FROM batches')!.n;if(size+b.payload.length>32<<20)refuse('observation_queue_full');this.db.run('INSERT INTO batches VALUES(?,?,?,?)',b.id,b.signal,b.payload,new Date().toISOString());if(cursor)saveLogCursor(this.db,cursor);});
  const sdk={withTable:()=>({gauge:(name:string,{unit}:{unit:string})=>({record:(value:number,attributes:Record<string,string>)=>this.metrics.push({name,unit,gauge:{dataPoints:[{asDouble:value,timeUnixNano:nowNano().toString(),attributes:Object.entries(attributes).map(([key,value])=>({key,value:{stringValue:value}}))}]}})})})};
  const command:typeof operationCommand=async(_file,args,options)=>{if((await inspectManagedDockerDaemon()).daemon_id!==config.daemon_id)refuse('docker_daemon_changed');return operationCommand(this.binary(),['--host=unix:///var/run/docker.sock',...(args[0]==='--context'?args.slice(2):args)],options);};
  this.observer=new ApplicationObserver({queue:{db:this.db},identity:{agent_id:config.agent_id,host_id:config.machine_id},config:{max_batch_bytes:256<<10},accept,sdk} as any,command,(args,signal,stream,checkpoint)=>readDockerLogs(args,signal,stream,checkpoint,{executable:this.binary(),prefix:['--host=unix:///var/run/docker.sock']}));
 }
 private binary(){const path=['/usr/local/bin/docker','/usr/bin/docker'].find(p=>existsSync(p));if(!path)return refuse('docker_cli_missing');return rootPath(realpathSync(path));}
 async collect(signal:AbortSignal){
  if(Date.now()-this.last<15000)return;this.last=Date.now();
  const policy=await requestExecutor(this.config,'observations/targets',{});this.observer.targets=policy.targets;
  await this.flush(signal);
  if((await inspectManagedDockerDaemon()).daemon_id!==this.config.daemon_id)refuse('docker_daemon_changed');
  this.metrics=[];await this.observer.collect(signal);
  if(this.metrics.length){const payload=encodeOTLP('metrics',{resourceMetrics:[{resource:{attributes:[{key:'service.name',value:{stringValue:'lightmoni-executor'}}]},scopeMetrics:[{scope:{name:'lightmoni.application'},metrics:this.metrics}]}]});if(payload.length<=256<<10&&this.db.get<{n:number}>('SELECT coalesce(sum(length(payload)),0) n FROM batches')!.n+payload.length<=32<<20)this.db.run('INSERT INTO batches VALUES(?,?,?,?)',randomUUID(),'metrics',payload,new Date().toISOString());}
  await this.flush(signal);
 }
 private async flush(signal:AbortSignal){
  for(const batch of this.db.all<any>('SELECT * FROM batches ORDER BY created_at,id LIMIT 20')){signal.throwIfAborted();await requestExecutor(this.config,'observations/batches',{id:batch.id,signal:batch.signal,payload:Buffer.from(batch.payload).toString('base64')});this.db.run('DELETE FROM batches WHERE id=?',batch.id);}
 }
 close(){this.db.close();}
}
