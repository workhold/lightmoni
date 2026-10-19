import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {loadSource} from '../features/dashboards/test-module.mjs';
const {sdkExamples,sdkSampleFor,sdkEnvironment,sdkEndpointError,sdkEndpointIsLoopback}=loadSource(new URL('./sdkExamples.ts',import.meta.url));

test('six supported SDK examples use environment constructors for both routes',()=>{
 for(const language of Object.keys(sdkExamples)){
  const agent=sdkSampleFor(language,'agent'),direct=sdkSampleFor(language,'direct');
  assert.match(agent,/from_env|fromEnv|FromEnv/);
  assert.match(direct,/from_env|fromEnv|FromEnv/);
  assert.equal(sdkExamples[language].sample,direct);
  assert.equal(sdkSampleFor(language),direct);
 }
 assert.match(sdkSampleFor('php','direct'),/LightMoni\\Client::fromEnv/);
 assert.equal(sdkSampleFor('unknown','agent'),sdkSampleFor('typescript','agent'));
});

test('environment setup preserves endpoints safely and separates Agent tokens from center keys',()=>{
 const endpoint="https://monitor.example/base'path/";
 const script=sdkEnvironment('direct',endpoint);
 const run=spawnSync('/bin/sh',['-c',script+'\nprintf %s "$LIGHTMONI_ENDPOINT"'],{encoding:'utf8'});
 assert.equal(run.status,0);assert.equal(run.stdout,endpoint.slice(0,-1));
 assert.match(script,/export LIGHTMONI_DATA_KEY=/);
 const agent=sdkEnvironment('agent','http://agent:4318/');
 assert.match(agent,/LIGHTMONI_DATA_KEY/);assert.match(agent,/LIGHTMONI_LOCAL_TOKEN/);assert.match(agent,/本地访问令牌/);
 assert.doesNotMatch(agent,/^export LIGHTMONI_LOCAL_TOKEN=/m);
});

const staleEnvironment={
 LIGHTMONI_MODE:'auto',LIGHTMONI_ENDPOINT:'https://stale-center.example',LIGHTMONI_AGENT_ENDPOINT:'https://stale-agent.example',
 LIGHTMONI_DATA_KEY:'old-data',LIGHTMONI_DATA_KEY_FILE:'/missing/data-key',LIGHTMONI_KEY:'legacy-data',
 LIGHTMONI_LOCAL_TOKEN:'old-local',LIGHTMONI_LOCAL_TOKEN_FILE:'/missing/local-token',
};
function executeEnvironment(...scripts){
 const run=spawnSync('/bin/sh',['-c',scripts.join('\n')+'\nenv -0'],{encoding:'utf8',env:{PATH:process.env.PATH,...staleEnvironment}});
 assert.equal(run.status,0,run.stderr);
 return Object.fromEntries(run.stdout.split('\0').filter(Boolean).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
}
test('executed direct setup removes stale Agent, file and legacy credential sources',()=>{
 const endpoint="https://platform.example/base'path/$literal";
 const result=executeEnvironment(sdkEnvironment('direct',endpoint));
 assert.equal(result.LIGHTMONI_MODE,'direct');assert.equal(result.LIGHTMONI_ENDPOINT,endpoint);
 assert.equal(result.LIGHTMONI_DATA_KEY,'替换为允许 business 表的上报 Key');
 for(const key of ['LIGHTMONI_AGENT_ENDPOINT','LIGHTMONI_LOCAL_TOKEN','LIGHTMONI_LOCAL_TOKEN_FILE','LIGHTMONI_DATA_KEY_FILE','LIGHTMONI_KEY'])assert.equal(result[key],undefined,key);
});
test('executed Agent setup removes stale platform and local credentials without injecting a fake token',()=>{
 const endpoint="http://agent.example/base'path/$literal";
 const result=executeEnvironment(sdkEnvironment('agent',endpoint));
 assert.equal(result.LIGHTMONI_MODE,'agent');assert.equal(result.LIGHTMONI_AGENT_ENDPOINT,endpoint);
 for(const key of ['LIGHTMONI_ENDPOINT','LIGHTMONI_DATA_KEY','LIGHTMONI_DATA_KEY_FILE','LIGHTMONI_KEY','LIGHTMONI_LOCAL_TOKEN','LIGHTMONI_LOCAL_TOKEN_FILE'])assert.equal(result[key],undefined,key);
 const fallback=executeEnvironment(sdkEnvironment('agent',''));
 assert.equal(fallback.LIGHTMONI_AGENT_ENDPOINT,'http://127.0.0.1:4318');
});
test('copying setup blocks in either order leaves only the final route configured',()=>{
 for(const routes of [['direct','agent'],['agent','direct']]){
  const target=routes.at(-1),result=executeEnvironment(...routes.map(route=>sdkEnvironment(route,'https://'+route+'.example')));
  assert.equal(result.LIGHTMONI_MODE,target);
  assert.equal(result.LIGHTMONI_ENDPOINT,target==='direct'?'https://direct.example':undefined);
  assert.equal(result.LIGHTMONI_AGENT_ENDPOINT,target==='agent'?'https://agent.example':undefined);
  assert.equal(result.LIGHTMONI_DATA_KEY,target==='direct'?'替换为允许 business 表的上报 Key':undefined);
  assert.equal(result.LIGHTMONI_LOCAL_TOKEN,undefined);
 }
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
   assert.match(sample,/from_env|fromEnv|FromEnv/,language);
  }
 }
 assert.match(sdkEnvironment('direct',"https://center/a'$value"),/https:\/\/center\/a'\\''\$value/);
 assert.match(sdkEnvironment('agent',"https://center/a'path"),/https:\/\/center\/a'\\''path/);
});
