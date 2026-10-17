/**
 * Read-only backup of a real Go SQLite database, then offline Node registration.
 * Run from runtime: node --import tsx test/helpers/old-data-live.ts
 * Optional: LIGHTMONI_OLD_DATA_DIR and LIGHTMONI_OLD_DATA_EVIDENCE_DIR.
 * Never calls module.start(), launches HTTP, ClickHouse, or provider requests.
 */
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,chmodSync,statSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DB} from '../../src/shared/sqlite.js';
import {Router} from '../../src/shared/http.js';
import {Auth} from '../../src/server/auth.js';
import {Catalog} from '../../src/server/catalog.js';
import {Executor} from '../../src/server/query.js';
import {Ingest} from '../../src/server/ingest.js';
import {registerCore} from '../../src/server/core.js';
import {registerSettings} from '../../src/server/settings.js';
import {registerTemplates} from '../../src/server/templates.js';
import {registerInstall} from '../../src/server/install.js';
import {registerNodes} from '../../src/server/nodes.js';
import {registerAssistant} from '../../src/assistant/index.js';
import {registerDashboards} from '../../src/domains/dashboards.js';
import {registerLogs} from '../../src/domains/logs.js';
import {registerAlerts} from '../../src/domains/alerts.js';
import type {Dependencies,Module} from '../../src/shared/types.js';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url))),sourceDir=resolve(process.env.LIGHTMONI_OLD_DATA_DIR??join(root,'.lightmoni'));
const output=resolve(process.env.LIGHTMONI_OLD_DATA_EVIDENCE_DIR??join(root,'.local-dev','node-old-data-'+new Date().toISOString().replace(/[:.]/g,'-')));
if(output===sourceDir||!relative(root,output).startsWith('.local-dev/'))throw Error('Evidence must be a separate .local-dev directory');
mkdirSync(output,{recursive:true,mode:0o700});chmodSync(output,0o700);
const quote=(v:string)=>'"'+v.replace(/"/g,'""')+'"';
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?{bigint:x.toString()}:x)).digest('hex');
let stage='backup',networkAttempts=0,db:DB|undefined;const modules:Module[]=[];
const evidence:any={checked_at:new Date().toISOString(),source_opened_read_only:true,background_started:false,external_network_attempts:0,tables:[],encrypted_values:[],passed:false};
const savedFetch=globalThis.fetch;globalThis.fetch=(async()=>{networkAttempts++;throw Error('External network disabled in old-data validation');}) as typeof fetch;
try{
 const source=new DatabaseSync(join(sourceDir,'lightmoni.db'),{readOnly:true});try{await backup(source,join(output,'lightmoni.db'));}finally{source.close();}
 const master=readFileSync(join(sourceDir,'master.key'));writeFileSync(join(output,'master.key'),master,{mode:0o600,flag:'wx'});chmodSync(join(output,'lightmoni.db'),0o600);
 evidence.master_copy_mode_0600=(statSync(join(output,'master.key')).mode&0o777)===0o600;evidence.database_copy_mode_0600=(statSync(join(output,'lightmoni.db')).mode&0o777)===0o600;evidence.master_copy_valid=master.length===32;
 stage='baseline';db=new DB(join(output,'lightmoni.db'));
 const names=()=>db!.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
 const baseline=names().map(name=>{const cols=db!.all<any>('PRAGMA table_info('+quote(name)+')').map(r=>r.name as string),projection=cols.map(quote).join(',');const rows=db!.all<any>('SELECT '+projection+' FROM '+quote(name));return {name,cols,rows,hashes:rows.map(digest).sort()};});
 stage='module registration';const router=new Router(),auth=new Auth(db,output,'http://offline.invalid',router);router.auth=auth;auth.register();
 const blocked=async():Promise<never>=>{networkAttempts++;throw Error('ClickHouse disabled in old-data validation');};
 const ch={exec:blocked,query:blocked,insert:blocked,user:'offline'},cat=new Catalog(db,ch,ch),executor=new Executor(ch,cat);
 const deps:Dependencies={db,router,auth,ch,reader:ch,cat,query:executor.execute.bind(executor),referencedTables:executor.referencedTables.bind(executor),externalURL:'http://offline.invalid',encrypt:auth.encrypt,decrypt:auth.decrypt,now:()=>new Date(),logger:{info(){},warn(){},error(){}}};
 registerSettings(deps);new Ingest(cat,auth).register();registerCore(deps);registerTemplates(deps);registerInstall(deps,join(output,'downloads'));modules.push(registerNodes(deps),registerAssistant(deps),registerDashboards(deps),registerLogs(deps),registerAlerts(deps));
 stage='row preservation';for(const old of baseline){const after=db.all('SELECT '+old.cols.map(quote).join(',')+' FROM '+quote(old.name)).map(digest),available=new Map<string,number>();for(const h of after)available.set(h,(available.get(h)??0)+1);let retained=0;for(const h of old.hashes){const n=available.get(h)??0;if(n>0){retained++;available.set(h,n-1);}}evidence.tables.push({table:old.name,before:old.hashes.length,after:after.length,original_rows_preserved:retained===old.hashes.length,non_destructive:retained===old.hashes.length});}
 const previousCenter=baseline.find(t=>t.name==='dashboards')?.rows.find(r=>r.id==='system-center');
 const changedDashboard=evidence.tables.find((t:any)=>t.table==='dashboards'&&!t.original_rows_preserved);
 if(changedDashboard&&previousCenter){
  const current=db.get<any>("SELECT * FROM dashboards WHERE id='system-center'"),archived=db.get<any>('SELECT body,updated_at FROM dashboard_versions WHERE dashboard_id=? AND revision=?',previousCenter.id,previousCenter.revision);
  const old=JSON.parse(previousCenter.body),next=JSON.parse(current.body),expected=structuredClone(old),runtime=expected.panels?.find((p:any)=>p.id==='system-center-k');
  if(runtime){runtime.title='Node 活跃资源数';runtime.queries[0].sql=runtime.queries[0].sql.replace('lightmoni.center.goroutines','lightmoni.center.active_resources');}
  const onlyRuntimeAndEventLoop=JSON.stringify(next.panels.filter((p:any)=>p.id!=='system-center-event-loop'))===JSON.stringify(expected.panels.filter((p:any)=>p.id!=='system-center-event-loop'));
  const withoutRuntime=(v:any)=>{const c=structuredClone(v);delete c.panels;delete c.revision;delete c.updated_at;return c;};
  const otherDashboards=baseline.find(t=>t.name==='dashboards')!.rows.filter(r=>r.id!=='system-center').every(r=>digest(r)===digest(db!.get<any>('SELECT '+baseline.find(t=>t.name==='dashboards')!.cols.map(quote).join(',')+' FROM dashboards WHERE id=?',r.id)));
  const originalVersionRetained=archived?.body===previousCenter.body&&archived?.updated_at===previousCenter.updated_at;
  const approved=originalVersionRetained&&onlyRuntimeAndEventLoop&&digest(withoutRuntime(old))===digest(withoutRuntime(next))&&otherDashboards&&next.revision===old.revision+1&&next.panels.filter((p:any)=>p.id==='system-center-event-loop').length===1;
  evidence.expected_migrations=[{name:'node-runtime-center-v1',original_body_retained_in_history:originalVersionRetained,other_dashboards_unchanged:otherDashboards,only_runtime_panel_and_event_loop_changed:onlyRuntimeAndEventLoop,passed:approved}];changedDashboard.non_destructive=approved;
 }
 evidence.added_tables=names().filter(name=>!baseline.some(t=>t.name===name)).map(table=>({table,rows:db!.get<any>('SELECT count(*) n FROM '+quote(table))!.n}));evidence.routes_registered=router.list().length;
 stage='encrypted compatibility';const check=(table:string,values:string[])=>{let decrypted=true;for(const value of values)try{auth.decrypt(value);}catch{decrypted=false;}evidence.encrypted_values.push({table,checked:values.length,all_decryptable:decrypted});};
 check('oauth_providers',db.all<any>('SELECT config FROM oauth_providers').map(r=>JSON.parse(r.config).client_secret).filter(Boolean));
 for(const table of ['alert_channels','alert_directory_sources'])check(table,db.all<any>('SELECT secret FROM '+quote(table)).map(r=>r.secret).filter(Boolean));
 const cfg=db.get<any>("SELECT value FROM assistant_records WHERE id='config'");check('assistant_records.config',cfg?[JSON.parse(Buffer.from(cfg.value).toString()).api_key].filter(Boolean):[]);
 evidence.external_network_attempts=networkAttempts;evidence.all_original_rows_preserved=evidence.tables.every((t:any)=>t.original_rows_preserved);evidence.all_encrypted_values_decryptable=evidence.encrypted_values.every((t:any)=>t.all_decryptable);
 evidence.all_old_data_retained=evidence.tables.every((t:any)=>t.non_destructive);evidence.passed=evidence.all_old_data_retained&&evidence.all_encrypted_values_decryptable&&networkAttempts===0&&evidence.master_copy_mode_0600&&evidence.database_copy_mode_0600&&evidence.master_copy_valid;
}catch{evidence.failure_stage=stage;evidence.external_network_attempts=networkAttempts;process.exitCode=1;}
finally{for(const module of modules.reverse())await module.close?.();db?.close();globalThis.fetch=savedFetch;writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({...evidence,evidence_directory:relative(root,output)}));if(!evidence.passed)process.exitCode=1;}
