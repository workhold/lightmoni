import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSource} from '../features/dashboards/test-module.mjs';
const {agentInstallCommand}=loadSource(new URL('./agentInstallCommand.ts',import.meta.url));
const metadata={endpoint:'https://public.example',install_url:'https://public.example/downloads/agent/install.sh',release_url:'https://public.example/downloads/agent',version:'0.1.0',bundles:['agent.tar.gz']};

test('Agent overrides use the reachable address for installer, bundle and reporting',()=>{
 const command=agentInstallCommand(metadata,'  http://10.0.0.8:8080/monitor///  ','internal');
 assert.doesNotMatch(command,/public\.example/);
 assert.match(command,/curl -fSL 'http:\/\/10\.0\.0\.8:8080\/monitor\/downloads\/agent\/install\.sh'/);
 assert.match(command,/--release-url 'http:\/\/10\.0\.0\.8:8080\/monitor\/downloads\/agent'/);
 assert.match(command,/--endpoint 'http:\/\/10\.0\.0\.8:8080\/monitor'/);
 assert.match(command,/--group-id 'internal' --key-stdin/);
});

test('Agent generation quotes endpoint paths and group IDs as literal shell arguments',()=>{
 const endpoint="https://internal.example/base'path",group="group'$(false)";
 const command=agentInstallCommand(metadata,endpoint,group);
 const directory=mkdtempSync(join(tmpdir(),'lightmoni-command-'));
 writeFileSync(join(directory,'systemd-ask-password'),"#!/bin/sh\nprintf '%s' 'local-test-key'\n",{mode:0o755});
 const shims=`curl(){ printf '%s\\0' "$@"; }\nsudo(){ if [ "$1" != '-v' ]; then printf '%s\\0' "$@"; fi; }\n`;
 let result;
 try{result=spawnSync('/bin/sh',['-c',shims+command],{encoding:'utf8',env:{...process.env,PATH:directory+':'+process.env.PATH}});}
 finally{rmSync(directory,{recursive:true,force:true});}
 assert.equal(result.status,0,result.stderr);
 const args=result.stdout.split('\0');
 assert.ok(args.includes(endpoint+'/downloads/agent/install.sh'));
 assert.ok(args.includes(endpoint+'/downloads/agent'));
 assert.ok(args.includes(endpoint));
 assert.ok(args.includes(group));
 assert.doesNotMatch(command,/local-test-key/);
});
