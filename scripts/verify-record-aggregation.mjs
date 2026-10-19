// Isolated QA only: native SDKs -> OTLP -> real ClickHouse -> public query API.
import {loadSource} from '../web/src/features/dashboards/test-module.mjs';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const base=process.env.LIGHTMONI_DOMAINS_URL??'http://127.0.0.1:18886';
if(base!=='http://127.0.0.1:18886')throw Error('Use the isolated record QA server on 18886');
const {sdkSampleFor}=loadSource(new URL('../web/src/app/sdkExamples.ts',import.meta.url));
const {sdkMetricQuery}=loadSource(new URL('../web/src/app/sdkMetricQueries.ts',import.meta.url));
const account={name:'sdk-onboarding-qa',password:'local-sdk-onboarding-password'};
const setup=await(await fetch(base+'/api/v1/setup')).json();
const login=await fetch(base+'/api/v1'+(setup.required?'/setup':'/auth/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(account)});if(!login.ok)throw Error('QA login failed');
const cookie=login.headers.get('set-cookie').split(';')[0];
const req=async(path,method='GET',body)=>{const res=await fetch(base+'/api/v1'+path,{method,headers:{cookie,'content-type':'application/json',connection:'close'},body:body?JSON.stringify(body):undefined});if(!res.ok)throw Error(path+': '+res.status+' '+await res.text());return res.json();};
const table='record_'+Date.now().toString(16),other=table+'_other',key=await req('/keys','POST',{name:'isolated record acceptance'});
for(const name of [table,other])await req('/sdk-exempt-tables','POST',{name});
const results=[],languages=(process.env.LIGHTMONI_RECORD_LANGUAGES??'typescript,go,python').split(',');
try{
for(const authMode of ['key','anonymous'])for(const language of languages){
 const service='record-'+language+'-'+authMode;
 let code=sdkSampleFor(language,'direct',base,{service,env:'test',service_version:'v-record',instance_id:service+'-one',authMode}).replaceAll('your_table',table);
 const codeFor={
  typescript:`for(let i=1;i<=1000;i++)moni.record('${table}','db.duration_ms',i%2?{key1:'telecom',key2:'zhejiang'}:{key2:'zhejiang',key1:'telecom'},i,1);
moni.record('${table}','restaurant.spend',{},100,5);moni.record('${table}','restaurant.spend',{},200,10);
moni.record('${table}','mixed',{},10,1);moni.record('${table}','mixed',{},30,1);moni.record('${table}','mixed',{},100,5);
moni.record('${other}','other.metric',{},5,1);
moni.record('${table}','signed',{},-5,1);moni.record('${table}','signed',{},0,1);moni.record('${table}','signed',{},10,1);
`,
  python:`for i in range(1,1001):
    moni.record('${table}','db.duration_ms',{'key1':'telecom','key2':'zhejiang'} if i%2 else {'key2':'zhejiang','key1':'telecom'},i,1)
moni.record('${table}','restaurant.spend',{},100,5)
moni.record('${table}','restaurant.spend',{},200,10)
moni.record('${table}','mixed',{},10,1)
moni.record('${table}','mixed',{},30,1)
moni.record('${table}','mixed',{},100,5)
moni.record('${other}','other.metric',{},5,1)
for v in [-5,0,10]: moni.record('${table}','signed',{},v,1)
`,
  go:`for i:=1;i<=1000;i++ {client.Record("${table}","db.duration_ms",moni.Attributes{"key1":"telecom","key2":"zhejiang"},float64(i),1)}
client.Record("${table}","restaurant.spend",nil,100,5)
client.Record("${table}","restaurant.spend",nil,200,10)
client.Record("${table}","mixed",nil,10,1);client.Record("${table}","mixed",nil,30,1);client.Record("${table}","mixed",nil,100,5)
client.Record("${other}","other.metric",nil,5,1)
for _,v:=range []float64{-5,0,10}{client.Record("${table}","signed",nil,v,1)}
`,
  rust:`for i in 1..=1000 {moni.record("${table}","db.duration_ms",&Attributes::from([("key1".into(),"telecom".into()),("key2".into(),"zhejiang".into())]),i as f64,1);}
moni.record("${table}","restaurant.spend",&Attributes::new(),100.0,5);moni.record("${table}","restaurant.spend",&Attributes::new(),200.0,10);
moni.record("${table}","mixed",&Attributes::new(),10.0,1);moni.record("${table}","mixed",&Attributes::new(),30.0,1);moni.record("${table}","mixed",&Attributes::new(),100.0,5);
moni.record("${other}","other.metric",&Attributes::new(),5.0,1);
for v in [-5.0,0.0,10.0]{moni.record("${table}","signed",&Attributes::new(),v,1);}
`};
 if(language==='typescript')code=code.replace('await moni.shutdown',codeFor[language]+'\nawait moni.shutdown');
 if(language==='python')code=code.replace('moni.shutdown',codeFor[language]+'\nmoni.shutdown');
 if(language==='go')code=code.replace('  ctx, cancel :=',codeFor[language]+'\n  ctx, cancel :=');
 if(language==='rust')code=code.replace('    moni.shutdown',codeFor[language]+'\n    moni.shutdown');
 if(language==='typescript'){
  code=code.replace('{createLightMoni}', '{createLightMoni, HTTPExporter}');
  code=code.replace('const moni = createLightMoni',`let lostAck=true,sawRetry=false;const frozen=new Map();
const transport=new HTTPExporter(${JSON.stringify(base)},()=>${authMode==='key'?'process.env.LIGHTMONI_KEY':'undefined'});
const moni = createLightMoni`);
  code=code.replace('  service:',`  selfTelemetry:false,retryMinMs:1,retryMaxMs:2,exporter:{async deliver(batch,signal){const raw=Buffer.from(batch.payload).toString('base64');if(frozen.has(batch.id)){if(frozen.get(batch.id)!==raw)throw Error('retry mutated payload');sawRetry=true;}frozen.set(batch.id,raw);await transport.deliver(batch,signal);if(lostAck&&batch.table===${JSON.stringify(table)}){lostAck=false;throw Error('simulated lost durable ACK');}}},\n  service:`);
  code+='\nif(!sawRetry)throw Error("durable retry was not exercised");';
 }
 const env={...process.env,LIGHTMONI_ENDPOINT:base,LIGHTMONI_KEY:authMode==='key'?key.key:'stale-must-not-use',PYTHONPATH:resolve('sdk/python')};
 let run;
 if(language==='typescript')run=spawnSync(process.execPath,['--input-type=module','-'],{input:code.replace("'@lightmoni/sdk'",JSON.stringify(pathToFileURL(resolve('sdk/typescript/dist/src/index.js')).href)),env,encoding:'utf8',timeout:30000});
 if(language==='python')run=spawnSync('python3',['-'],{input:code,env,encoding:'utf8',timeout:30000});
 if(language==='go'){const folder=resolve('.local-dev/record-qa/go');await mkdir(folder,{recursive:true});await writeFile(folder+'/main.go',code);run=spawnSync('go',['run',folder+'/main.go'],{env,encoding:'utf8',timeout:60000});}
 if(language==='rust'){const folder=resolve('.local-dev/record-qa/rust');await mkdir(folder+'/src',{recursive:true});await writeFile(folder+'/src/main.rs',code);await writeFile(folder+'/Cargo.toml',`[package]\nname="record-qa"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nlightmoni={path=${JSON.stringify(resolve('sdk/rust'))}}\n`);await copyFile('sdk/rust/Cargo.lock',folder+'/Cargo.lock');run=spawnSync(process.env.LIGHTMONI_CARGO??'cargo',['run','--offline','--quiet','--manifest-path',folder+'/Cargo.toml'],{env,encoding:'utf8',timeout:180000});}
 if(run.status!==0)throw Error(language+' '+authMode+': '+run.stderr);
 const query=await req('/query','POST',{queries:[{refId:'A',sql:sdkMetricQuery(table,service,'test',60)}],range:{from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()},interval_ms:10000});
 const result=query.results[0];if(result.status!=='success')throw Error(JSON.stringify(result));
 const frame=result.frames[0],rows=frame.rows.map(row=>Object.fromEntries(frame.columns.map((field,i)=>[field.name,row[i]])));
 const duration=rows.find(row=>row.metric_name==='db.duration_ms');assert.ok(duration);assert.equal(Number(duration.sample_count),1000);assert.equal(Number(duration.total_value),500500);assert.equal(Number(duration.average_value),500.5);assert.equal(Number(duration.minimum_value),1);assert.equal(Number(duration.maximum_value),1000);assert.equal(duration.distribution_status,'complete');
 const levels=[.005,.05,.1,.3,.5,.7,.9,.95,.995],labels=['P005','P05','P10','P30','P50','P70','P90','P95','P995'];
 const percentiles=typeof duration.percentiles==='string'?JSON.parse(duration.percentiles):duration.percentiles;
 for(let i=0;i<levels.length;i++){const actual=Number(percentiles[labels[i]]),expected=Math.ceil(levels[i]*1000),error=Math.abs(actual-expected)/expected;assert.ok(error<=Number(duration.relative_error_bound)+1e-9,labels[i]+': '+error);}
 for(const name of ['restaurant.spend','mixed']){const row=rows.find(row=>row.metric_name===name);assert.ok(row);assert.equal(Number(row.sample_count),name==='mixed'?7:15);assert.equal(Number(row.average_value),20);assert.equal(row.minimum_value,null);assert.equal(row.maximum_value,null);assert.equal(row.distribution_status,'incomplete_distribution');assert.ok(Object.values(typeof row.percentiles==='string'?JSON.parse(row.percentiles):row.percentiles).every(v=>v===null));}
 const pointQuery=await req('/query','POST',{queries:[{refId:'N',sql:`SELECT count() AS n FROM metric_${table}_histogram WHERE service='${service}' AND metric_name='db.duration_ms'`}],range:{from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()},interval_ms:10000});assert.equal(pointQuery.results[0].status,'success');assert.equal(Number(pointQuery.results[0].frames[0].rows[0][0]),1);
 results.push({language,authMode,passed:true,exportedDurationPoints:1,lostAckRetryVerified:language==='typescript',rows});console.log(JSON.stringify({language,authMode,passed:true}));
}
const catalog=await req('/catalog/tables');const system=catalog.filter(row=>row.system).map(row=>row.name).sort();assert.deepEqual(system,['lightmoni_log','lightmoni_metric_gauge','lightmoni_metric_histogram','lightmoni_metric_sum']);
await mkdir('docs/evidence/telemetry-table-model',{recursive:true});await writeFile('docs/evidence/telemetry-table-model/record-sdk.json',JSON.stringify({passed:true,table,systemTables:system,results},null,2));
}finally{await req('/keys/'+key.id,'PUT',{active:false});for(const name of [table,other])await req('/sdk-exempt-tables/'+name,'DELETE');}
