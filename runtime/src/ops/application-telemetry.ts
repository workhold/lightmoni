import {hash,id,token} from '../shared/crypto.js';
import {fail} from '../shared/http.js';
import type {PlatformStore,PlatformResource} from './types.js';
type Row=Record<string,any>;
export function createApplicationTelemetry(store:PlatformStore) {
 const {db}=store.deps;
 db.exec('CREATE TABLE IF NOT EXISTS ops_application_sdk(application_id TEXT PRIMARY KEY,key_id TEXT NOT NULL,secret_cipher TEXT NOT NULL,created_at TEXT NOT NULL)');
 return {
  environment(app:PlatformResource,instance:Row):Record<string,string> {
   if(app.spec.role!=='generic')return {};
   const machine=db.get<Row>('SELECT * FROM managed_machines WHERE id=?',instance.machine_id);
   const agent=db.get<Row>('SELECT * FROM agents WHERE id=?',instance.agent_id);
   const values:Record<string,string>={LIGHTMONI_SERVICE:app.spec.service_name,LIGHTMONI_APPLICATION_ID:app.id,LIGHTMONI_CLUSTER_ID:instance.cluster_id,LIGHTMONI_MACHINE_ID:instance.machine_id,LIGHTMONI_MACHINE_NAME:machine?.name??'',LIGHTMONI_HOST_ID:agent?.host_id??'',LIGHTMONI_AGENT_ID:instance.agent_id,LIGHTMONI_INSTANCE_ID:instance.id,LIGHTMONI_DEPLOYMENT_ID:instance.id};
   if(store.deps.externalURL)values.LIGHTMONI_ENDPOINT=store.deps.externalURL;
   if(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingest_keys'")) {
    let saved=db.get<Row>('SELECT * FROM ops_application_sdk WHERE application_id=?',app.id);
    if(!saved)db.transaction(()=>{
     saved=db.get<Row>('SELECT * FROM ops_application_sdk WHERE application_id=?',app.id);if(saved)return;
     const keyID=id(),key='lm_'+token(),at=store.deps.now().toISOString();
     db.run('INSERT INTO ingest_keys(id,name,token_hash,created_at) VALUES(?,?,?,?)',keyID,'应用 · '+app.spec.service_name,hash(key),at);
     db.run('INSERT INTO ops_application_sdk VALUES(?,?,?,?)',app.id,keyID,store.deps.encrypt(key),at);
     saved=db.get<Row>('SELECT * FROM ops_application_sdk WHERE application_id=?',app.id);
    });
    if(!db.get('SELECT id FROM ingest_keys WHERE id=? AND active=1',saved!.key_id))fail(409,'application_sdk_key_disabled');
    values.LIGHTMONI_KEY=store.deps.decrypt(saved!.secret_cipher);
    store.patchStatus(app.id,{sdk:{key_id:saved!.key_id,configured:true}});
   }
   return Object.fromEntries(Object.entries(values).filter(([,v])=>v!==''));
  },
  remove(applicationID:string) {
   const saved=db.get<Row>('SELECT key_id FROM ops_application_sdk WHERE application_id=?',applicationID);
   if(saved)db.run('UPDATE ingest_keys SET active=0 WHERE id=?',saved.key_id);
   db.run('DELETE FROM ops_application_sdk WHERE application_id=?',applicationID);
  }
 };
}
