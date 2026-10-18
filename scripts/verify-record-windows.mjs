// Isolated QA: merge different distributions across SDK instances/windows.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createLightMoni} from '../sdk/typescript/dist/src/index.js';
import {loadSource} from '../web/src/features/dashboards/test-module.mjs';
const {sdkMetricQuery}=loadSource(new URL('../web/src/app/sdkMetricQueries.ts',import.meta.url));
const base='http://127.0.0.1:18886';
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'sdk-onboarding-qa',password:'local-sdk-onboarding-password'})});assert.ok(login.ok);
const cookie=login.headers.get('set-cookie').split(';')[0];
async function req(path,method='GET',body){const r=await fetch(base+'/api/v1'+path,{method,headers:{cookie,'content-type':'application/json',connection:'close'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();}
async function query(sql){const q=await req('/query','POST',{queries:[{refId:'A',sql}],range:{from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()},interval_ms:10000});const r=q.results[0];assert.equal(r.status,'success',JSON.stringify(r));const f=r.frames[0];return f.rows.map(row=>Object.fromEntries(f.columns.map((c,i)=>[c.name,row[i]])));}
const table='windows_'+Date.now().toString(16),key=await req('/keys','POST',{name:'isolated window verification'});
const clients=['a','b'].map(instance_id=>createLightMoni({service:'record-windows',env:'test',instance_id,endpoint:base,key:key.key,selfTelemetry:false,remoteConfig:false}));
try {
 for(let window=0;window<2;window++){
  for(let instance=0;instance<2;instance++){
   const client=clients[instance],start=window*200+instance*100;
   for(let i=1;i<=100;i++)client.record(table,'db.duration_ms',{key1:'mysql'},start+i,1);
   await client.flush({timeoutMs:5000});
  }
 }
 const rows=await query(sdkMetricQuery(table,'record-windows','test',60));assert.equal(rows.length,1);const row=rows[0];
 assert.equal(Number(row.sample_count),400);assert.equal(Number(row.total_value),80200);assert.equal(Number(row.average_value),200.5);assert.equal(Number(row.minimum_value),1);assert.equal(Number(row.maximum_value),400);
 const levels=[.005,.05,.1,.3,.5,.7,.9,.95,.995],labels=['P005','P05','P10','P30','P50','P70','P90','P95','P995'];
 const p=typeof row.percentiles==='string'?JSON.parse(row.percentiles):row.percentiles;
 for(let i=0;i<levels.length;i++){const expected=Math.ceil(levels[i]*400);assert.ok(Math.abs(p[labels[i]]-expected)/expected<=Number(row.relative_error_bound)+1e-9);}
 const points=await query(`SELECT count() AS points,uniqExact(instance_id) AS instances FROM metric_${table}_histogram WHERE service='record-windows'`);assert.equal(Number(points[0].points),4);assert.equal(Number(points[0].instances),2);
 // Business collection works with own telemetry disabled and no explicit flush.
 clients[0].record(table,'automatic',{},42,1);
 await new Promise(r=>setTimeout(r,11000));
 const automatic=await query(`SELECT sum(sample_count) AS samples FROM metric_${table}_histogram WHERE metric_name='automatic'`);assert.equal(Number(automatic[0].samples),1);
 // Packaged examples initialize with service/env only and get transport from env.
 const env={...process.env,LIGHTMONI_ENDPOINT:base,LIGHTMONI_KEY:key.key,LIGHTMONI_TABLE:table,PYTHONPATH:resolve('sdk/python')};
 const commands=[['node',process.execPath,['sdk/typescript/examples/record.mjs']],['go','go',['run','./examples/sdk/go/record']],['python','python3',['examples/sdk/python/record.py']],['rust',process.env.LIGHTMONI_CARGO??'cargo',['run','--offline','--quiet','--manifest-path','sdk/rust/Cargo.toml','--example','record']]];
 for(const [language,cmd,args] of commands){const r=spawnSync(cmd,args,{env,encoding:'utf8',timeout:180000});assert.equal(r.status,0,language+': '+r.stderr);}
 const examples=await query(`SELECT metric_name,sum(sample_count) AS samples,sum(value_sum) AS total,uniqExact(instance_id) AS instances,countIf(instance_id='') AS empty_ids FROM metric_${table}_histogram WHERE service='database-api' AND env='test' GROUP BY metric_name ORDER BY metric_name`);
 assert.equal(examples.length,2);assert.equal(Number(examples[0].samples),4);assert.equal(Number(examples[0].total),512);assert.equal(Number(examples[1].samples),20);assert.equal(Number(examples[1].total),400);for(const r of examples){assert.equal(Number(r.instances),4);assert.equal(Number(r.empty_ids),0);}
 await writeFile('docs/evidence/telemetry-table-model/windows.json',JSON.stringify({passed:true,points:4,instances:2,rows,automatic,packagedExamples:examples},null,2));console.log(JSON.stringify({passed:true,points:4,instances:2,automatic:true,packagedExamples:4}));
} finally {for(const c of clients)await c.shutdown({timeoutMs:5000});await req('/keys/'+key.id,'PUT',{active:false});}
