import type { Dependencies } from '../shared/types.js';
import { desiredHash, desiredJSON, managedResourceID } from '../shared/desired-state.js';

export type Category = 'deployment' | 'file' | 'agent' | 'custom';
export type ReconciliationState = 'pending' | 'in_sync' | 'drifted' | 'blocked';
export interface DesiredResource {
  key: string; machine_id: string; agent_id: string; owner_id: string; actor: string;
  desired: Record<string, any>;
  /** Only non-secret metadata: this is the public inventory contract. */
  summary: Record<string, any>;
  dependencies?: string[];
}
export interface ManagedResource extends DesiredResource {
  id: string; provider: string; category: Category; generation: number; desired_hash: string; deleted: boolean;
  state: ReconciliationState; code: string; job_id: string; failures: number; observed_at: string;
  observed_generation: number; next_attempt_at: string; updated_at: string;
}
export interface ReconciliationResult { state: ReconciliationState; code?: string; job_id?: string }
export interface ResourceProvider {
  kind: string; category: Category;
  /** A complete synchronous authoritative snapshot; throwing never implies deletion. */
  collect(): DesiredResource[];
  /** Must inspect actual state and use existing authorized, fenced execution paths. */
  reconcile(resource: ManagedResource): Promise<ReconciliationResult> | ReconciliationResult;
}

export class ReconciliationRegistry {
  private readonly providers = new Map<string, ResourceProvider>();
  private readonly errors = new Map<string, string>();
  private inflight?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(readonly deps: Pick<Dependencies, 'db' | 'now' | 'encrypt' | 'decrypt' | 'logger'>) {
    deps.db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_resources(
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,category TEXT NOT NULL,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,owner_id TEXT NOT NULL,actor TEXT NOT NULL,generation INTEGER NOT NULL,desired_hash TEXT NOT NULL,
      desired_cipher TEXT NOT NULL,summary_json TEXT NOT NULL,dependencies_json TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',code TEXT NOT NULL DEFAULT '',job_id TEXT NOT NULL DEFAULT '',failures INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,observed_at TEXT NOT NULL DEFAULT '',observed_generation INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
      UNIQUE(provider,machine_id,agent_id,resource_key));
      CREATE INDEX IF NOT EXISTS reconciliation_due ON reconciliation_resources(next_attempt_at);
      CREATE INDEX IF NOT EXISTS reconciliation_machine ON reconciliation_resources(machine_id,provider);`);
  }
  register(provider: ResourceProvider) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(provider.kind) || !['deployment','file','agent','custom'].includes(provider.category)) throw Error('invalid_reconciliation_provider');
    if (this.providers.has(provider.kind)) throw Error('duplicate_reconciliation_provider');
    this.providers.set(provider.kind, provider);
  }
  catalog() { return [...this.providers.values()].map(p => ({kind:p.kind, category:p.category, error:this.errors.get(p.kind) ?? ''})); }
  private at() { return this.deps.now().toISOString(); }
  private decode(row: any): ManagedResource {
    const {resource_key,desired_cipher,summary_json,dependencies_json,...rest}=row;
    return {...rest,key:resource_key,deleted:!!row.deleted,desired:JSON.parse(this.deps.decrypt(desired_cipher)),summary:JSON.parse(summary_json),dependencies:JSON.parse(dependencies_json)};
  }
  get(id: string) { const row=this.deps.db.get<any>('SELECT * FROM reconciliation_resources WHERE id=?',id); return row ? this.decode(row) : undefined; }
  /** Also usable inside an upstream transaction: DB supports nested savepoints. */
  refresh(kind?: string) {
    if(this.closed)return;
    for(const provider of this.providers.values()) {
      if(kind && provider.kind!==kind)continue;
      try {
        const snapshot=provider.collect();
        if(!Array.isArray(snapshot)||snapshot.length>10000)throw Error('invalid_reconciliation_snapshot');
        const ids=new Set<string>();
        const prepared=snapshot.map(resource=>{
          for(const field of ['key','machine_id','agent_id','owner_id','actor'] as const) if(typeof resource[field]!=='string'||!resource[field]||resource[field].length>256)throw Error('invalid_reconciliation_resource');
          const id=managedResourceID(provider.kind,resource.machine_id,resource.agent_id,resource.key);
          if(ids.has(id))throw Error('duplicate_reconciliation_resource');ids.add(id);
          if(!resource.desired||Array.isArray(resource.desired)||!resource.summary||Array.isArray(resource.summary)||
            Buffer.byteLength(desiredJSON(resource.desired))>1100000||Buffer.byteLength(desiredJSON(resource.summary))>32000||
            (resource.dependencies??[]).length>100||!(resource.dependencies??[]).every(d=>/^[a-f0-9]{64}$/.test(d)))throw Error('invalid_reconciliation_resource');
          return {resource,id,hash:desiredHash(resource.desired)};
        });
        this.deps.db.transaction(()=>{
          for(const {resource:r,id,hash} of prepared) {
            const old=this.deps.db.get<any>('SELECT * FROM reconciliation_resources WHERE id=?',id);
            const changed=!old||old.deleted||old.desired_hash!==hash||old.actor!==r.actor||old.owner_id!==r.owner_id||old.dependencies_json!==desiredJSON(r.dependencies??[]);
            if(!old) this.deps.db.run(`INSERT INTO reconciliation_resources(id,provider,category,machine_id,agent_id,resource_key,owner_id,actor,generation,desired_hash,desired_cipher,summary_json,dependencies_json,next_attempt_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,provider.kind,provider.category,r.machine_id,r.agent_id,r.key,r.owner_id,r.actor,1,hash,this.deps.encrypt(desiredJSON(r.desired)),desiredJSON(r.summary),desiredJSON(r.dependencies??[]),this.at(),this.at());
            else if(changed)this.deps.db.run(`UPDATE reconciliation_resources SET owner_id=?,actor=?,generation=generation+1,desired_hash=?,desired_cipher=?,summary_json=?,dependencies_json=?,deleted=0,state='pending',code='',job_id='',failures=0,next_attempt_at=?,observed_at='',observed_generation=0,updated_at=? WHERE id=?`,r.owner_id,r.actor,hash,this.deps.encrypt(desiredJSON(r.desired)),desiredJSON(r.summary),desiredJSON(r.dependencies??[]),this.at(),this.at(),id);
            else this.deps.db.run('UPDATE reconciliation_resources SET summary_json=? WHERE id=?',desiredJSON(r.summary),id);
          }
          for(const old of this.deps.db.all<any>('SELECT id FROM reconciliation_resources WHERE provider=? AND deleted=0',provider.kind)) if(!ids.has(old.id))this.deps.db.run(`UPDATE reconciliation_resources SET deleted=1,generation=generation+1,state='pending',code='',job_id='',failures=0,observed_at='',observed_generation=0,next_attempt_at=?,updated_at=? WHERE id=?`,this.at(),this.at(),old.id);
        });
        this.errors.delete(provider.kind);
      } catch {
        this.errors.set(provider.kind,'desired_snapshot_failed');
        this.deps.db.run("UPDATE reconciliation_resources SET state='blocked',code='desired_snapshot_failed' WHERE provider=?",provider.kind);
      }
    }
  }
  inventory(machine: string, limit=100, offset=0) {
    const resources=this.deps.db.all<any>(`SELECT id,provider,category,machine_id,agent_id,resource_key,owner_id,generation,desired_hash,summary_json,dependencies_json,deleted,state,code,job_id,failures,next_attempt_at,observed_at,observed_generation,updated_at FROM reconciliation_resources WHERE machine_id=? ORDER BY provider,resource_key,agent_id LIMIT ? OFFSET ?`,machine,limit,offset).map(r=>{
      const {summary_json,dependencies_json,...rest}=r;
      if(!this.providers.has(r.provider)){rest.state='blocked';rest.code='provider_unavailable';}
      return {...rest,deleted:!!r.deleted,summary:JSON.parse(summary_json),dependencies:JSON.parse(dependencies_json)};
    });
    return {machine_id:machine,providers:this.catalog(),resources,total:this.deps.db.get<any>('SELECT count(*) n FROM reconciliation_resources WHERE machine_id=?',machine)!.n,limit,offset};
  }
  request(machine: string) { this.deps.db.run('UPDATE reconciliation_resources SET next_attempt_at=? WHERE machine_id=?',this.at(),machine); }
  tick(): Promise<void> {
    if(this.closed)return Promise.resolve();
    if(this.inflight)return this.inflight;
    this.inflight=this.run().finally(()=>{this.inflight=undefined;});return this.inflight;
  }
  private async run() {
    this.refresh();
    const due=this.deps.db.all<any>('SELECT * FROM reconciliation_resources WHERE next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 100',this.at());
    for(const row of due) {
      if(this.closed)break;
      if(this.deps.db.get<any>("SELECT generation FROM reconciliation_resources WHERE id=?",row.id)?.generation!==row.generation)continue;
      const provider=this.providers.get(row.provider);
      let result:ReconciliationResult;
      try {
        const resource=this.decode(row);
        const dependent=resource.deleted&&this.deps.db.get("SELECT id FROM reconciliation_resources WHERE id<>? AND EXISTS(SELECT 1 FROM json_each(dependencies_json) WHERE value=?) AND (deleted=0 OR state<>'in_sync' OR observed_generation<>generation) LIMIT 1",resource.id,resource.id);
        const dependency=(resource.dependencies??[]).map(id=>this.get(id)).some(d=>!d||d.machine_id!==resource.machine_id||d.deleted||d.state!=='in_sync'||d.observed_generation!==d.generation||this.errors.has(d.provider)||!this.providers.has(d.provider));
        result=!provider ? {state:'blocked',code:'provider_unavailable'} : this.errors.has(row.provider) ? {state:'blocked',code:'desired_snapshot_failed'} : dependent ? {state:'blocked',code:'dependent_cleanup_required'} : !resource.deleted&&dependency ? {state:'blocked',code:'dependency_not_ready'} : await provider.reconcile(resource);
        if(!['pending','in_sync','drifted','blocked'].includes(result?.state))throw Error('invalid_reconciliation_result');
      } catch { result={state:'drifted',code:'reconciliation_failed'}; }
      const failed=result.state==='drifted',failures=failed ? row.failures+1 : result.state==='in_sync'?0:row.failures;
      const delay=result.state==='pending'?5000:failed?Math.min(300000,5000*2**Math.min(failures-1,6)):60000;
      // Only a current generation may accept the observation. A slow provider
      // cannot acknowledge a desired state changed while it was awaiting I/O.
      this.deps.db.run(`UPDATE reconciliation_resources SET state=?,code=?,job_id=?,failures=?,next_attempt_at=?,observed_at=?,observed_generation=?,updated_at=? WHERE id=? AND generation=?`,result.state,/^[A-Za-z0-9_.-]{0,128}$/.test(result.code??'')?result.code??'':'reconciliation_failed',String(result.job_id??'').slice(0,256),failures,new Date(this.deps.now().getTime()+delay).toISOString(),result.state==='in_sync'?this.at():row.observed_at,result.state==='in_sync'?row.generation:0,this.at(),row.id,row.generation);
    }
  }
  kick() { if(!this.closed){this.refresh();void this.tick().catch(()=>this.deps.logger.warn('Machine reconciliation needs attention'));} }
  start() { if(this.timer||this.closed)return;this.timer=setInterval(()=>this.kick(),15000);this.timer.unref?.();this.kick(); }
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);await this.inflight;}
}
