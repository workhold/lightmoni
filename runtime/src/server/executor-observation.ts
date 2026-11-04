import type {Dependencies,Module} from '../shared/types.js';
import {APPLICATION_TABLE,applicationTargets,bindApplicationRows} from '../shared/application-observation.js';
import {decodeOTLP} from '../shared/otlp.js';
import {normalize,stamp,type Normalized} from './ingest.js';
import {canonicalJSON,sha256,strictRecord} from '../shared/privileged-executor.js';
import {fail} from '../shared/http.js';
import type {PrivilegedExecutorStore} from './privileged-executors.js';
/** Preserve exact log sequence values across the encrypted JSON outbox. Older
 * batches serialized LosslessNumber's properties instead of its numeric value. */
export function restoreObservationRows(rows:Normalized[]):Normalized[] {
 for(const n of rows)if(n.kind==='log'&&n.row.source_seq!=null){
  let value=n.row.source_seq;
  if(typeof value==='object'){
   if(value.isLosslessNumber!==true||typeof value.value!=='string'||Object.keys(value).some(k=>!['isLosslessNumber','value'].includes(k)))throw Error('invalid_observation_source_sequence');
   value=value.value;
  }
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('invalid_observation_source_sequence');
  const text=String(value);if(!/^(?:0|[1-9]\d{0,19})$/.test(text)||BigInt(text)>18446744073709551615n)throw Error('invalid_observation_source_sequence');
  n.row.source_seq=text;
 }
 return rows;
}
/** A signed request acknowledges only a durable, encrypted center outbox.
 * ClickHouse I/O occurs after that transaction, with stable event identities. */
export function connectExecutorObservations(deps:Dependencies,store:PrivilegedExecutorStore,exporter:(table:string,rows:Normalized[],id:string,signal?:AbortSignal)=>Promise<void>):Module {
 const {db}=deps;db.exec("CREATE TABLE IF NOT EXISTS privileged_observation_batches(id TEXT PRIMARY KEY,executor_id TEXT,agent_id TEXT,digest TEXT,rows_enc TEXT,created_at TEXT,completed INTEGER DEFAULT 0)");
 store.observations={targets:e=>({targets:applicationTargets(db,e.agent_id,deps.decrypt)}),accept:(e,value)=>{
  const v=strictRecord(value,['id','signal','payload']);if(!/^[a-f0-9-]{36}$/.test(v.id??'')||!['logs','metrics'].includes(v.signal)||typeof v.payload!=='string'||v.payload.length>360000)fail(400,'invalid_executor_observation');
  const raw=Buffer.from(v.payload,'base64');if(raw.toString('base64')!==v.payload)fail(400,'invalid_executor_observation');
  const digest=sha256(canonicalJSON(v)),id=e.id+':'+v.id,old=db.get<any>('SELECT * FROM privileged_observation_batches WHERE id=?',id);if(old){if(old.digest!==digest)fail(409,'replay_conflict');return{accepted:true};}
  const rows=normalize(v.signal,decodeOTLP(v.signal,raw,'application/x-protobuf'),stamp(BigInt(deps.now().getTime())*1000000n),'');if(rows.length>10000)fail(400,'executor_observation_limit');
  bindApplicationRows(db,e.agent_id,rows,deps.decrypt);restoreObservationRows(rows);
  if(db.get<{n:number}>('SELECT coalesce(sum(length(rows_enc)),0) n FROM privileged_observation_batches WHERE completed=0')!.n>32<<20)fail(503,'executor_observation_queue_full');
  db.run('INSERT INTO privileged_observation_batches(id,executor_id,agent_id,digest,rows_enc,created_at) VALUES(?,?,?,?,?,?)',id,e.id,e.agent_id,digest,deps.encrypt(canonicalJSON(rows)),deps.now().toISOString());return{accepted:true};
 }};
 const errors=new Map<string,string>();
 deps.applicationObservationStatus=agentID=>({pending_batches:db.get<{n:number}>('SELECT count(*) n FROM privileged_observation_batches WHERE completed=0 AND agent_id=?',agentID)!.n,error:[...errors].some(([id])=>!!db.get('SELECT id FROM privileged_observation_batches WHERE id=? AND agent_id=? AND completed=0',id,agentID))?'observation_export_failed':''});
 let work:Promise<void>|undefined;const controller=new AbortController();let after={created_at:'',id:''};
 const drain=async()=>{
 let batches=db.all<any>('SELECT * FROM privileged_observation_batches WHERE completed=0 AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 20',after.created_at,after.created_at,after.id);
 if(!batches.length){after={created_at:'',id:''};batches=db.all<any>('SELECT * FROM privileged_observation_batches WHERE completed=0 ORDER BY created_at,id LIMIT 20');}
 for(const batch of batches){
  if(controller.signal.aborted)return;
  after={created_at:batch.created_at,id:batch.id};
  try{store.observationAuthority(batch.executor_id);const rows=restoreObservationRows(JSON.parse(deps.decrypt(batch.rows_enc)));bindApplicationRows(db,batch.agent_id,rows,deps.decrypt);await exporter(APPLICATION_TABLE,rows,batch.id,controller.signal);db.run("UPDATE privileged_observation_batches SET completed=1,rows_enc='' WHERE id=?",batch.id);errors.delete(batch.id);}catch{errors.set(batch.id,'observation_export_failed');}
 }db.run('DELETE FROM privileged_observation_batches WHERE completed=1 AND created_at<?',new Date(deps.now().getTime()-172800000).toISOString());};
 const timer=setInterval(()=>{if(!work)work=drain().finally(()=>work=undefined);},1000);timer.unref();
 return{async close(){clearInterval(timer);controller.abort();await work;}};
}
