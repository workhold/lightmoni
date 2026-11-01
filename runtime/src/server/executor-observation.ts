import type {Dependencies,Module} from '../shared/types.js';
import {APPLICATION_TABLE,applicationTargets,bindApplicationRows} from '../shared/application-observation.js';
import {decodeOTLP} from '../shared/otlp.js';
import {normalize,stamp,type Normalized} from './ingest.js';
import {canonicalJSON,sha256,strictRecord} from '../shared/privileged-executor.js';
import {fail} from '../shared/http.js';
import type {PrivilegedExecutorStore} from './privileged-executors.js';
/** A signed request acknowledges only a durable, encrypted center outbox.
 * ClickHouse I/O occurs after that transaction, with stable event identities. */
export function connectExecutorObservations(deps:Dependencies,store:PrivilegedExecutorStore,exporter:(table:string,rows:Normalized[],id:string,signal?:AbortSignal)=>Promise<void>):Module {
 const {db}=deps;db.exec("CREATE TABLE IF NOT EXISTS privileged_observation_batches(id TEXT PRIMARY KEY,executor_id TEXT,agent_id TEXT,digest TEXT,rows_enc TEXT,created_at TEXT,completed INTEGER DEFAULT 0)");
 store.observations={targets:e=>({targets:applicationTargets(db,e.agent_id,deps.decrypt)}),accept:(e,value)=>{
  const v=strictRecord(value,['id','signal','payload']);if(!/^[a-f0-9-]{36}$/.test(v.id??'')||!['logs','metrics'].includes(v.signal)||typeof v.payload!=='string'||v.payload.length>360000)fail(400,'invalid_executor_observation');
  const raw=Buffer.from(v.payload,'base64');if(raw.toString('base64')!==v.payload)fail(400,'invalid_executor_observation');
  const digest=sha256(canonicalJSON(v)),id=e.id+':'+v.id,old=db.get<any>('SELECT * FROM privileged_observation_batches WHERE id=?',id);if(old){if(old.digest!==digest)fail(409,'replay_conflict');return{accepted:true};}
  const rows=normalize(v.signal,decodeOTLP(v.signal,raw,'application/x-protobuf'),stamp(BigInt(deps.now().getTime())*1000000n),'');if(rows.length>10000)fail(400,'executor_observation_limit');
  bindApplicationRows(db,e.agent_id,rows,deps.decrypt);
  if(db.get<{n:number}>('SELECT coalesce(sum(length(rows_enc)),0) n FROM privileged_observation_batches WHERE completed=0')!.n>32<<20)fail(503,'executor_observation_queue_full');
  db.run('INSERT INTO privileged_observation_batches(id,executor_id,agent_id,digest,rows_enc,created_at) VALUES(?,?,?,?,?,?)',id,e.id,e.agent_id,digest,deps.encrypt(canonicalJSON(rows)),deps.now().toISOString());return{accepted:true};
 }};
 let work:Promise<void>|undefined;const controller=new AbortController();
 const drain=async()=>{for(const batch of db.all<any>('SELECT * FROM privileged_observation_batches WHERE completed=0 ORDER BY created_at,id LIMIT 20')){
  if(controller.signal.aborted)return;
  try{store.observationAuthority(batch.executor_id);const rows=JSON.parse(deps.decrypt(batch.rows_enc));bindApplicationRows(db,batch.agent_id,rows,deps.decrypt);await exporter(APPLICATION_TABLE,rows,batch.id,controller.signal);db.run("UPDATE privileged_observation_batches SET completed=1,rows_enc='' WHERE id=?",batch.id);}catch{return;}
 }db.run('DELETE FROM privileged_observation_batches WHERE completed=1 AND created_at<?',new Date(deps.now().getTime()-172800000).toISOString());};
 const timer=setInterval(()=>{if(!work)work=drain().finally(()=>work=undefined);},1000);timer.unref();
 return{async close(){clearInterval(timer);controller.abort();await work;}};
}
