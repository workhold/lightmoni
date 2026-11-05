import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {containerTerminalCommand} from '../src/ops/application-terminals.js';
test('remote container command verifies ownership and running state and never falls back to a host shell',t=>{
 const directory=mkdtempSync(join(tmpdir(),'lm-container-command-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 writeFileSync(join(directory,'docker'),'#!/bin/sh\ncase "$1" in\ninfo) exit 0;;\ninspect) printf "%s" "$FIXTURE_INSPECTION";;\nexec) printf "IN_SELECTED_CONTAINER:%s\\n" "$*";;\n*) exit 1;;\nesac\n',{mode:0o700});
 const target={application_id:'app',instance_id:'instance-a',container_id:'a'.repeat(64),shell:'bash' as const,revision:1},command=containerTerminalCommand(target);
 const run=(inspection:string)=>spawnSync('/bin/sh',['-c',command],{encoding:'utf8',env:{...process.env,PATH:directory+':'+process.env.PATH,FIXTURE_INSPECTION:inspection}});
 const success=run('instance-a|lightmoni|true');assert.equal(success.status,0);assert.match(success.stdout,new RegExp('IN_SELECTED_CONTAINER:exec -it '+target.container_id+' /bin/bash'));
 for(const inspection of ['other-instance|lightmoni|true','instance-a|external|true','instance-a|lightmoni|false','']){const denied=run(inspection);assert.equal(denied.status,126);assert.doesNotMatch(denied.stdout,/IN_SELECTED_CONTAINER/);assert.match(denied.stderr,/target changed/);}
 assert.throws(()=>containerTerminalCommand({...target,container_id:'a;echo bad'}),/invalid_container/);
});
