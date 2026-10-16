import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {loadSource} from '../features/dashboards/test-module.mjs';
const {sdkExamples,sdkSampleFor,sdkEnvironment,sdkEndpointError,sdkEndpointIsLoopback}=loadSource(new URL('./sdkExamples.ts',import.meta.url));

test('eight SDK examples explicitly configure the endpoint and key for both routes',()=>{
 for(const language of Object.keys(sdkExamples)){
  const agent=sdkSampleFor(language,'agent'),direct=sdkSampleFor(language,'direct');
  for(const sample of [agent,direct]){assert.match(sample,/LIGHTMONI_ENDPOINT/);assert.match(sample,/LIGHTMONI_KEY/);}
  assert.match(agent,/127\.0\.0\.1:4318/);
  assert.doesNotMatch(direct,/127\.0\.0\.1:4318/,'direct mode must not silently fall back to an Agent');
  assert.equal(sdkExamples[language].sample,agent);
 }
 assert.match(sdkSampleFor('dotnet','direct'),/key: Environment/);
 assert.match(sdkSampleFor('php','direct'),/new \\LightMoni\\Client/);
 assert.equal(sdkSampleFor('unknown','agent'),sdkSampleFor('typescript','agent'));
});

test('environment setup preserves endpoints safely and separates Agent tokens from center keys',()=>{
 const endpoint="https://monitor.example/base'path/";
 const script=sdkEnvironment('direct',endpoint);
 const run=spawnSync('/bin/sh',['-c',script+'\nprintf %s "$LIGHTMONI_ENDPOINT"'],{encoding:'utf8'});
 assert.equal(run.status,0);assert.equal(run.stdout,endpoint.slice(0,-1));
 assert.match(script,/export LIGHTMONI_KEY=/);
 const agent=sdkEnvironment('agent','http://agent:4318/');
 assert.match(agent,/unset LIGHTMONI_KEY/);assert.match(agent,/本地访问令牌/);
});

test('SDK URLs accept public and container routes and reject incompatible configuration',()=>{
 for(const endpoint of ['https://monitor.example/base/','http://lightmoni:8080','http://agent:4318','http://[::1]:18380'])assert.equal(sdkEndpointError(endpoint),'');
 for(const endpoint of ['','ftp://center','http://user:secret@center','http://center/?key=secret','http://center/#frag','http://center/?','http://center/#','http:/center','http://center\\path','http://center/a b'])assert.notEqual(sdkEndpointError(endpoint),'');
 for(const endpoint of ['http://localhost:18380','http://127.0.0.1:18380','http://[::1]:18380'])assert.equal(sdkEndpointIsLoopback(endpoint),true);
 assert.equal(sdkEndpointIsLoopback('http://lightmoni:8080'),false);
});

test('all SDK demos carry the selected public or private route without changing key injection',()=>{
 for(const endpoint of ['https://public.example/monitor','http://10.0.0.8:8080/base']){
  for(const language of Object.keys(sdkExamples)){
   const sample=sdkSampleFor(language,'direct',endpoint+'/');
   assert.ok(sample.includes(endpoint),language);
   assert.match(sample,/LIGHTMONI_KEY/);
   assert.doesNotMatch(sample,/127\.0\.0\.1:4318/);
  }
 }
 assert.match(sdkSampleFor('php','direct',"https://center/a'$value"),/https:\/\/center\/a\\'\$value'/);
 assert.match(sdkSampleFor('ruby','direct',"https://center/a'path"),/https:\/\/center\/a\\'path'/);
});
