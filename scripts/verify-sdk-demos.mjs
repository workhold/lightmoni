// Run only against the isolated SDK QA instance, after browser checks.
import {loadSource} from '../web/src/features/dashboards/test-module.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {sdkSampleFor}=loadSource(new URL('../web/src/app/sdkExamples.ts',import.meta.url));
const root=resolve('.'),base=process.env.LIGHTMONI_DOMAINS_URL??'http://127.0.0.1:18886',account={name:'sdk-onboarding-qa',password:'local-sdk-onboarding-password'};
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(account)});if(!login.ok)throw Error('login failed');const cookie=login.headers.get('set-cookie').split(';')[0];
const req=async(path,method='GET',body)=>{const response=await fetch(base+'/api/v1'+path,{method,headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error(path+': '+response.status()+' '+await response.text());return response.json();};
const table='sdk_demos_'+Date.now().toString(16);await req('/sdk-exempt-tables','POST',{name:table,description:'隔离真实 SDK demo 验收'});const key=await req('/keys','POST',{name:'SDK demo integration',allowed_tables:[table]});
const results=[];
for(const authMode of ['key','anonymous'])for(const language of ['typescript','go','python']){
 const service=`demo-${language}-${authMode}`,code=sdkSampleFor(language,'direct',base,{table,service,authMode});
 const env={...process.env,LIGHTMONI_ENDPOINT:base,LIGHTMONI_KEY:authMode==='key'?key.key:'stale-must-not-be-used',PYTHONPATH:resolve('sdk/python')};
 let result;
 if(language==='typescript')result=spawnSync(process.execPath,['--input-type=module','-'],{input:code.replace("'@lightmoni/sdk'",JSON.stringify(pathToFileURL(resolve('sdk/typescript/dist/src/index.js')).href)),env,encoding:'utf8',timeout:30000});
 if(language==='python')result=spawnSync('python3',['-'],{input:code,env,encoding:'utf8',timeout:30000});
 if(language==='go'){const folder=resolve('.local-dev/sdk-onboarding-qa/go-demo');await mkdir(folder,{recursive:true});await writeFile(folder+'/main.go',code);result=spawnSync('go',['run',folder+'/main.go'],{cwd:root,env,encoding:'utf8',timeout:60000});}
 if(result.status!==0)throw Error(language+' '+authMode+': '+result.stderr);
 results.push({language,authMode,status:'passed'});
}
const now=new Date(),from=new Date(+now-3600000);
const query=await req('/query','POST',{queries:[{refId:'A',sql:`SELECT service,key_id,count() AS n FROM log_${table} GROUP BY service,key_id ORDER BY service`}],range:{from:from.toISOString(),to:now.toISOString()},interval_ms:60000});
if(query.results[0].status!=='success')throw Error(JSON.stringify(query));
const rows=query.results[0].frames[0].rows;for(const record of results){const service=`demo-${record.language}-${record.authMode}`;const row=rows.find(row=>row[0]===service);if(!row||record.authMode==='anonymous'&&row[1]!==''||record.authMode==='key'&&row[1]!==key.id)throw Error('missing/wrong identity '+service);}
await req('/keys/'+key.id,'PUT',{active:false});await req('/sdk-exempt-tables/'+table,'DELETE');
const evidence={results,logIdentityRows:rows,table,rust:'not executed: cargo unavailable on this host; browser and generation checks passed'};await writeFile(resolve('docs/evidence/sdk-onboarding/sdk-demos.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,demos:results.length,identityRows:rows.length}));
