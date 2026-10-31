import { randomUUID, createHash } from 'node:crypto';
import type { Dependencies } from '../shared/types.js';
import { stamp, type Ingest, type Normalized } from './ingest.js';
import { nowNano } from '../shared/otlp.js';

/** Transactional event outbox. Control state remains in SQLite; log reads use
 * ClickHouse. Triggers also cover background transitions and deleted resources. */
export class SystemLogs {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  constructor(readonly deps: Dependencies, readonly ingest: Pick<Ingest,'internal'>, readonly secrets: string[] = []) {
    const db=deps.db;
    db.exec(`CREATE TABLE IF NOT EXISTS system_log_outbox(id TEXT PRIMARY KEY,event_time TEXT NOT NULL,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS system_log_pending ON system_log_outbox(delivered,event_time);`);
    const sources=['ops_platform_resources','ops_platform_revisions','ops_resources','ops_platform_runs','ops_runs','agent_job_events','agent_jobs','deployment_events','machine_deployments','machine_uninstallations','machine_ssh_checks','machine_agent_link_events','machine_credential_events','ops_schedule_fires','key_events','agent_lifecycle_events','machine_terminal_events','alert_events','alert_response_events','assistant_alert_audit','task_runs'];
    for(const table of sources){
      const info=db.all<{name:string;pk:number}>('PRAGMA table_info('+table+')');
      const columns=new Set(info.map(c=>c.name));
      if(!columns.size)continue;
      const primary=info.filter(c=>Number(c.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(c=>c.name);
      const keys=primary.length?primary:['id','job_id','sequence','schedule_id','slot'].filter(k=>columns.has(k));
      const fields=['resource_id','resource_revision','revision','kind','name','agent_id','machine_id','deployment_id','job_id','sequence','operation','action','state','status','phase','event','actor','actor_id','created_by','code','key_id','service','rule_id','response_id','proposal_id','target_id','session_id','credential_id','connected_at','closed_at','revoked_credentials','task_id','host_id','trigger','retry_of','superseded_by','request_id','requested_by','exit_code','cancel_requested','resolved_at','resolved_by'].filter(k=>columns.has(k));
      const times=['resolved_at','finished_at','started_at','closed_at','connected_at','updated_at','occurred_at','verified_at','applied_at','at','created_at'].filter(k=>columns.has(k));
      if(!times.length)continue;
      const expression=(prefix:string,deleted=false)=>{
        const get=(k:string)=>prefix+k;
        const time=times.length?'COALESCE('+times.map(k=>`NULLIF(${get(k)},'')`).join(',')+",strftime('%Y-%m-%dT%H:%M:%fZ','now'))":"strftime('%Y-%m-%dT%H:%M:%fZ','now')";
        const state=['state','status','phase','event','revision','connected_at','closed_at','cancel_requested','resolved_at'].filter(k=>columns.has(k)).map(k=>`COALESCE(CAST(${get(k)} AS TEXT),'')`);
        const key="'"+table+":'||"+[...keys.map(k=>`CAST(${get(k)} AS TEXT)`),time,...state].join("||':'||");
        const extra=table==='ops_platform_runs'?`, 'resource_kind', COALESCE((SELECT kind FROM ops_platform_resources WHERE id=${get('resource_id')}),''), 'cluster_id', COALESCE(json_extract(${get('result_json')},'$.cluster_id'),'')`:table==='ops_platform_resources'||table==='ops_resources'?`, 'resource_id', ${get('id')}, 'resource_kind', ${get('kind')}`:table==='ops_platform_revisions'?`, 'resource_kind', COALESCE((SELECT kind FROM ops_platform_resources WHERE id=${get('resource_id')}),'')`:'';
        const alert=table==='alert_events'||table==='alert_response_events'?`, 'event', CASE WHEN json_valid(${get('body')}) THEN COALESCE(json_extract(${get('body')},'$.kind'),'') ELSE '' END`:'';
        const payload=`json_object('source','${table}','record_id',${keys.length?keys.map(k=>`CAST(${get(k)} AS TEXT)`).join("||':'||"):"''"}${fields.map(k=>`, '${k}', ${get(k)}`).join('')}${extra}${alert})`;
        return `${key}${deleted?"||':deleted'":''},${time},${deleted?`json_set(${payload},'$.event','deleted')`:payload},0`;
      };
      db.exec(`INSERT OR IGNORE INTO system_log_outbox SELECT ${expression('')} FROM ${table};`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS system_logs_${table}_insert AFTER INSERT ON ${table} BEGIN INSERT OR IGNORE INTO system_log_outbox VALUES(${expression('NEW.')}); END;`);
      if(['ops_platform_resources','ops_resources'].includes(table))db.exec(`CREATE TRIGGER IF NOT EXISTS system_logs_${table}_delete AFTER DELETE ON ${table} BEGIN INSERT OR IGNORE INTO system_log_outbox VALUES(${expression('OLD.',true)}); END;`);
      // Capture state transitions, not lease refreshes or encrypted payload changes.
      const state=['state','status','phase','event','revision','connected_at','closed_at','cancel_requested','resolved_at'].filter(k=>columns.has(k));
      if(state.length)db.exec(`CREATE TRIGGER IF NOT EXISTS system_logs_${table}_update AFTER UPDATE OF ${state.join(',')} ON ${table} WHEN ${state.map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')} BEGIN INSERT OR IGNORE INTO system_log_outbox VALUES(${expression('NEW.')}); END;`);
    }
  }
  private redact(message:string) {
    let body=message;
    for(const secret of this.secrets)if(secret)body=body.replaceAll(secret,'[redacted]');
    body=body.replace(/(Bearer\s+)[^\s,;]+/gi,'$1[redacted]').replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
    return body.slice(0,4096);
  }
  record(level: string, message: string) {
    this.deps.db.run('INSERT INTO system_log_outbox VALUES(?,?,?,0)',randomUUID(),this.deps.now().toISOString(),JSON.stringify({source:'center',level,body:this.redact(message)}));
  }
  publish() {
    if(this.pending)return this.pending;
    this.pending=this.drain().finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async drain() {
    const db=this.deps.db,entries=db.all<any>('SELECT * FROM system_log_outbox WHERE delivered=0 ORDER BY event_time,id LIMIT 256');
    if(!entries.length)return;
    const rows: Normalized[]=entries.map(e=>{
      const payload=JSON.parse(e.payload);
      // Copy the bounded control-event explanation, never its snapshot, script
      // or interactive terminal output. Raw explanations stay out of the outbox.
      if(payload.source==='agent_job_events'){
        const event=db.get<any>('SELECT summary FROM agent_job_events WHERE job_id=? AND sequence=?',payload.job_id,payload.sequence);
        if(event?.summary)payload.summary=this.redact(String(event.summary));
      }
      if(payload.source==='task_runs'){const event=db.get<any>('SELECT summary,state FROM task_runs WHERE id=?',payload.record_id);if(event?.summary&&event.state===payload.state&&['succeeded','failed','cancelled','unknown'].includes(payload.state))payload.summary=this.redact(String(event.summary));payload.machine_id=payload.host_id;}
      if(payload.source==='ops_platform_runs' && this.deps.decrypt){try{const run=db.get<any>('SELECT payload_cipher FROM ops_platform_runs WHERE id=?',payload.record_id);const config=JSON.parse(this.deps.decrypt(run.payload_cipher)).resource.config;payload.cluster_id=config.cluster_id??payload.cluster_id??'';}catch{}}
      const level=payload.level??(['failed','unknown','error'].includes(payload.state??payload.status??payload.phase)?'WARN':'INFO');
      const attributes=Object.fromEntries(Object.entries(payload).filter(([k])=>!['body','level'].includes(k)).map(([k,v])=>[k,String(v??'')]));
      attributes['lightmoni.component']=payload.source==='center'?'center':payload.source==='key_events'?'auth':payload.source==='agent_lifecycle_events'?'agent':payload.source==='assistant_alert_audit'?'assistant':payload.source.startsWith('alert_')?'alerts':payload.source==='task_runs'?'tasks':'operations';
      return {kind:'log',subtype:'',row:{event_id:createHash('sha256').update('system-log:'+e.id).digest('hex'),event_time:e.event_time.replace('T',' ').replace(/Z$/,''),ingested_at:stamp(nowNano()),service:'lightmoni-center',instance_id:'',host_id:'',agent_id:payload.agent_id??'',key_id:'system',resource_json:'{}',attributes,attributes_json:JSON.stringify(attributes),severity:level.toUpperCase(),severity_number:/error/i.test(level)?17:/warn/i.test(level)?13:9,body:payload.body??JSON.stringify(payload),body_json:'',trace_id:'',span_id:'',source_id:'system:'+e.id,source_seq:null}};
    });
    await this.ingest.internal('lightmoni',rows,'system-logs/'+entries.map(e=>e.id).join('/'));
    db.transaction(()=>{for(const e of entries)db.run("UPDATE system_log_outbox SET delivered=1,payload='{}' WHERE id=?",e.id);});
  }
  start() {this.timer=setInterval(()=>{void this.publish().catch(()=>{});},2000);this.timer.unref();void this.publish().catch(()=>{});}
  async close() {clearInterval(this.timer);await this.pending?.catch(()=>{});await this.publish().catch(()=>{});}
}
