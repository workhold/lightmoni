import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSource} from '../features/dashboards/test-module.mjs';
const {agentInstallCommand}=loadSource(new URL('./agentInstallCommand.ts',import.meta.url));
const metadata={endpoint:'https://public.example',install_url:'https://public.example/downloads/agent/install.sh',release_url:'https://public.example/downloads/agent',version:'0.1.0',bundles:['agent.tar.gz']};

test('selected Agent route and supplied key are used for download and configuration',()=>{
 const command=agentInstallCommand(metadata,'  http://10.0.0.8:8080/monitor///  ','internal','lm_test-key');
 assert.doesNotMatch(command,/public\.example|systemd-ask-password/);
 assert.match(command,/Authorization: Bearer \$LIGHTMONI_KEY/);
 assert.match(command,/'http:\/\/10\.0\.0\.8:8080\/monitor\/downloads\/agent\/install\.sh'/);
 assert.match(command,/--release-url 'http:\/\/10\.0\.0\.8:8080\/monitor\/downloads\/agent'/);
 assert.match(command,/--endpoint 'http:\/\/10\.0\.0\.8:8080\/monitor'/);
 assert.match(command,/--group-id 'internal' --key-stdin/);
 assert.match(command,/LIGHTMONI_KEY='lm_test-key'/);
});

test('generated shell treats address, group and key literally and keeps caller variables intact',()=>{
 const directory=mkdtempSync(join(tmpdir(),'lightmoni-command-'));
 const marker=join(directory,'injected');
 const endpoint="https://internal.example/base'path",group="group'$(false)",key=`lm_'$(touch ${marker})`;
 const command=agentInstallCommand(metadata,endpoint,group,key);
 const shims=`curl(){ printf '%s\\0' "$@"; }\nsudo(){ if [ "$1" != '-v' ]; then printf '%s\\0' "$@"; cat; printf '\\0'; fi; }\nLIGHTMONI_KEY=caller\n`;
 try{
  const result=spawnSync('/bin/sh',['-c',shims+command+'\nprintf "%s\\0" "$LIGHTMONI_KEY"'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const args=result.stdout.split('\0');
  for(const value of [endpoint+'/downloads/agent/install.sh',endpoint+'/downloads/agent',endpoint,group,`Authorization: Bearer ${key}`,key+'\n','caller'])assert.ok(args.includes(value),value);
  assert.equal(existsSync(marker),false);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('failed authenticated download prevents executing a previous installer',()=>{
 const command=agentInstallCommand(metadata,metadata.endpoint,'default','lm_test-key');
 const result=spawnSync('/bin/sh',['-c',`curl(){ return 22; }\nsudo(){ printf unexpected-install; }\n`+command],{encoding:'utf8'});
 assert.equal(result.status,22);assert.equal(result.stdout,'');
});

test('missing or multiline keys cannot generate an installation command',()=>{
 for(const key of ['', '  ', 'lm_line\nother','lm_line\rother','lm_null\0'])assert.equal(agentInstallCommand(metadata,metadata.endpoint,'default',key),'');
});
