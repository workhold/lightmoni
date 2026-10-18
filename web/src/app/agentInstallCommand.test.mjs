import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSource} from '../features/dashboards/test-module.mjs';
const {agentInstallCommand}=loadSource(new URL('./agentInstallCommand.ts',import.meta.url));
const metadata={endpoint:'https://public.example',install_url:'https://public.example/downloads/agent/install.sh',release_url:'https://public.example/downloads/agent',version:'0.1.0',bundles:['agent.tar.gz']};

test('selected Agent route uses an interactive enrollment token without embedding a secret',()=>{
 const command=agentInstallCommand(metadata,'  http://10.0.0.8:8080/monitor///  ','internal');
 assert.doesNotMatch(command,/public\.example/);
 assert.match(command,/systemd-ask-password/);
 assert.match(command,/Authorization: Bearer %s/);
 assert.match(command,/'http:\/\/10\.0\.0\.8:8080\/monitor\/downloads\/agent\/install\.sh'/);
 assert.match(command,/--release-url 'http:\/\/10\.0\.0\.8:8080\/monitor\/downloads\/agent'/);
 assert.match(command,/--endpoint 'http:\/\/10\.0\.0\.8:8080\/monitor'/);
 assert.match(command,/--group-id 'internal' --enrollment-token-stdin/);
 assert.doesNotMatch(command,/token_display_once|lm_test-key/);
});

test('generated shell treats address and group literally and keeps the token out of command arguments',()=>{
 const directory=mkdtempSync(join(tmpdir(),'lightmoni-command-'));
 const marker=join(directory,'injected');
 const endpoint="https://internal.example/base'path",group="group'$(false)";
 const command=agentInstallCommand(metadata,endpoint,group);
 const ask=join(directory,'systemd-ask-password');
 writeFileSync(ask,'#!/bin/sh\nprintf test-token\n',{mode:0o755});
 const shims=`curl(){ printf '%s\\0' "$@"; : > lightmoni-install.sh; }\nsudo(){ if [ "$1" != '-v' ]; then printf '%s\\0' "$@"; cat; printf '\\0'; fi; }\n`;
 try{
  const result=spawnSync('/bin/sh',['-c',`PATH=${directory}:$PATH\n`+shims+command+'\nprintf "%s\\0" "$LIGHTMONI_CURL_CONFIG"'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const args=result.stdout.split('\0');
  for(const value of [endpoint+'/downloads/agent/install.sh',endpoint+'/downloads/agent',endpoint,group,'--enrollment-token-stdin'])assert.ok(args.includes(value),value);
  const curlArgs=args.slice(0,args.indexOf('--enrollment-token-stdin'));
  assert.equal(curlArgs.includes('test-token'),false);
  assert.equal(existsSync(marker),false);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('failed enrollment download prevents executing a previous installer',()=>{
 const command=agentInstallCommand(metadata,metadata.endpoint,'default');
 const result=spawnSync('/bin/sh',['-c',`curl(){ return 22; }\nsudo(){ printf unexpected-install; }\n`+command],{input:'token\n',encoding:'utf8'});
 assert.equal(result.status,22);assert.equal(result.stdout,'');
});

test('invalid route and group values cannot generate an installation command',()=>{
 for(const value of ['', '  ', 'line\nother','line\rother','null\0'])assert.equal(agentInstallCommand(metadata,value,'default'),'');
 assert.equal(agentInstallCommand(metadata,metadata.endpoint,'bad\nvalue'),'');
});
