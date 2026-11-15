import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {agentRecoveryNodeSelector} from '../src/server/machine-agent-update-ssh.js';
import {rewriteMaintenancePaths,writeMaintenanceStatShim} from './helpers/maintenance-shell.js';

function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'lm-recovery-runtime-')),commands=join(root,'commands'),releases=join(root,'opt/lightmoni-agent/releases');
 mkdirSync(commands,{recursive:true});mkdirSync(releases,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeMaintenanceStatShim(commands);
 writeFileSync(join(commands,'sha256sum'),`#!${process.execPath}\nconst fs=require('node:fs'),c=require('node:crypto'),p=process.argv.at(-1);console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')+'  '+p);\n`,{mode:0o755});
 const release=(name:string,usable:boolean,validDigest=true,mode=0o755)=>{
  const directory=join(releases,name);mkdirSync(directory,{recursive:true});
  const node=join(directory,'node');writeFileSync(node,`#!/bin/sh\nexit ${usable?0:1}\n`,{mode});chmodSync(node,mode);
  const digest=createHash('sha256').update(readFileSync(node)).digest('hex');
  writeFileSync(join(directory,'release.json'),JSON.stringify({node_binary_sha256:validDigest?digest:'0'.repeat(64)})+'\n',{mode:0o644});
  return directory;
 };
 const select=()=>spawnSync('/bin/sh',['-c',`set -eu\n${rewriteMaintenancePaths(agentRecoveryNodeSelector,root)}\nprintf '%s\\n' "$runtime_node"`],{encoding:'utf8',env:{...process.env,PATH:commands+':'+process.env.PATH}});
 return {root,releases,release,select};
}

test('recovery runtime skips a broken current, tampered digest and selects a verified retained release',t=>{
 const f=fixture(t),broken=f.release('01-broken',false),good=f.release('03-good',true);f.release('02-tampered',true,false);
 symlinkSync(broken,join(f.root,'opt/lightmoni-agent/current'));
 const result=f.select();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),join(good,'node'));
});

test('recovery runtime rejects current path escape and unsafe writable files',t=>{
 const f=fixture(t),outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'node'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 writeFileSync(join(outside,'release.json'),JSON.stringify({node_binary_sha256:createHash('sha256').update(readFileSync(join(outside,'node'))).digest('hex')})+'\n');
 symlinkSync(outside,join(f.root,'opt/lightmoni-agent/current'));f.release('writable',true,true,0o777);
 const result=f.select();assert.equal(result.status,127);assert.match(result.stderr,/agent_recovery_runtime_unavailable/);assert.equal(result.stdout,'');
});

test('recovery runtime fails closed when no bundled runtime can start',t=>{
 const f=fixture(t),broken=f.release('broken',false);symlinkSync(broken,join(f.root,'opt/lightmoni-agent/current'));
 const result=f.select();assert.equal(result.status,127);assert.match(result.stderr,/agent_recovery_runtime_unavailable/);assert.doesNotMatch(result.stderr,/fixture|secret/i);
});
