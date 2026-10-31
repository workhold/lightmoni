import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {loadSource} from '../features/dashboards/test-module.mjs';
const {SDK_LANGUAGES,sdkExamples,sdkSampleFor,sdkEnvironment,sdkEndpointError,sdkEndpointIsLoopback,validSDKTable,recommendedExemptTables}=loadSource(new URL('./sdkExamples.ts',import.meta.url));
test('four SDK demos initialize identity without binding tables and expose one five-argument record call',()=>{
 assert.deepEqual(SDK_LANGUAGES.map(item=>item.value),['go','typescript','rust','python']);
 assert.deepEqual(Object.keys(sdkExamples).sort(),['go','python','rust','typescript']);
 for(const language of Object.keys(sdkExamples)){
  const direct=sdkSampleFor(language,'https://monitor.example/base/',{service:'payments-prod',env:'prod',service_version:'v1.2',instance_id:'instance-one'});
  for(const value of ['payments-prod','prod','v1.2','instance-one','https://monitor.example/base','LIGHTMONI_KEY'])assert.ok(direct.includes(value),`${language}: ${value}`);
  assert.doesNotMatch(direct,/127\.0\.0\.1:4318/);
  assert.doesNotMatch(direct, /\btable\s*[:=]|Table\s*:|orders_created|create_order/);assert.match(direct, /db\.query\.duration_ms/);assert.match(direct, /restaurant\.spend/);assert.match(direct, /100(?:\.0)?, 5/);
  const anonymous=sdkSampleFor(language,'https://monitor.example',{authMode:'anonymous'});
  assert.doesNotMatch(anonymous,/LIGHTMONI_KEY/);assert.doesNotMatch(anonymous,/business|browser_events_192acf/);
 }
 assert.equal(sdkSampleFor('unknown'),sdkSampleFor('typescript'));
});
test('environment safely injects selected secrets and clears stale keys in anonymous mode',()=>{
 const endpoint="https://monitor.example/base'path/",key="lm_quote'$(printf unsafe)`printf unsafe`";
 const script=sdkEnvironment(endpoint,{key});
 const run=spawnSync('/bin/sh',['-c',script+'\nprintf "%s\\n%s" "$LIGHTMONI_ENDPOINT" "$LIGHTMONI_KEY"'],{encoding:'utf8'});
 assert.equal(run.status,0);assert.equal(run.stdout,endpoint.slice(0,-1)+'\n'+key);
 assert.match(sdkEnvironment(endpoint,{keyName:'payments-prod'}),/payments-prod/);
 const anonymous=sdkEnvironment(endpoint,{authMode:'anonymous',key:'must-not-leak'});assert.doesNotMatch(anonymous,/must-not-leak/);
 const clean=spawnSync('/bin/sh',['-c',anonymous+'\nprintf %s "${LIGHTMONI_KEY-unset}"'],{encoding:'utf8',env:{...process.env,LIGHTMONI_KEY:'stale-key'}});assert.equal(clean.stdout,'unset');
});
test('exemption recommendations are valid complex names and never system tables',()=>{
 const first=recommendedExemptTables(),second=recommendedExemptTables();assert.equal(first.length,3);assert.notDeepEqual(first.map(item=>item.name),second.map(item=>item.name));
 for(const item of first){assert.equal(validSDKTable(item.name),true);assert.match(item.name,/_[a-f0-9]{16}$/);}
 for(const value of ['log_app','metric_app','trace_app','lightmoni_sdk','lightmoni_center','lightmoni_agent','App','*','a'.repeat(49),''])assert.equal(validSDKTable(value),false,value);
});
test('SDK addresses validate public and container routes',()=>{
 for(const value of ['https://monitor.example/base/','http://lightmoni:8080','http://[::1]:18380'])assert.equal(sdkEndpointError(value),'');
 for(const value of ['','ftp://center','http://user:secret@center','http://center/?key=secret','http://center/#','http:/center','http://center\\path','http://center/a b'])assert.notEqual(sdkEndpointError(value),'');
 for(const value of ['http://localhost:18380','http://127.0.0.1:18380','http://[::1]:18380'])assert.equal(sdkEndpointIsLoopback(value),true);
 assert.equal(sdkEndpointIsLoopback('http://lightmoni:8080'),false);
});
