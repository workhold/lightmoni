import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {CHECK_NAMES,parsePreflight,pinnedHostKeys,preflightCommand} from '../src/server/machine-ssh.js';

test('host key pin matches the exact key even when another algorithm appears first',()=>{
 const first=Buffer.from('untrusted-algorithm-key').toString('base64'),second=Buffer.from('confirmed-key').toString('base64');
 const pin='SHA256:'+createHash('sha256').update(Buffer.from(second,'base64')).digest('base64').replace(/=+$/,'');
 const scan=`host ssh-rsa ${first}\nhost ssh-ed25519 ${second}\n`;
 assert.equal(pinnedHostKeys(scan,pin),`host ssh-ed25519 ${second}\n`);
 assert.throws(()=>pinnedHostKeys(`host ssh-rsa ${first}\n`,pin),/host_key_mismatch/);
});

test('fixed preflight executes valid POSIX shell and returns only bounded enum/boolean values',()=>{
 const command=preflightCommand('https://127.0.0.1:1');
 assert.equal(execFileSync('sh',['-n'],{input:command,encoding:'utf8'}),'');
 const output=execFileSync('sh',[],{input:command,encoding:'utf8',timeout:15_000});
 const result=parsePreflight(output);assert.equal(result.checks.platform_https,false);
 assert.deepEqual(Object.keys(result.checks),[...CHECK_NAMES]);
 assert.equal(typeof result.ready,'boolean');assert.ok(['amd64','arm64','unsupported'].includes(result.arch));
});

test('preflight rejects duplicates, arbitrary text, inconsistent statuses and credential-bearing platform URLs',()=>{
 const output='LMSSH=1\nplatform=linux\narch=amd64\nprivilege_state=root\n'+CHECK_NAMES.map(name=>name+'=1').join('\n')+'\n';
 assert.equal(parsePreflight(output).ready,true);
 for(const bad of [output+'curl=1\n',output+'remote prompt injection',output.replace('linux=1','linux=0'),output.replace('curl=1','curl=yes'),output+'secret=private\n'])assert.throws(()=>parsePreflight(bad),/invalid_response/);
 assert.match(preflightCommand('http://platform.example'),/echo 'platform_https=0'/);
 for(const url of ['file:///tmp/anything','https://user:password@platform.example','https://platform.example/?key=secret'])assert.throws(()=>preflightCommand(url),/HTTPS/);
});

test('privilege probe distinguishes actual root, non-interactive sudo, denied sudo and unknown UID',()=>{
 const probe=preflightCommand('https://platform.example').split('\n').find(line=>line.startsWith('LM_SSH_UID='))!;
 assert.ok(probe);assert.match(probe,/sudo -n \/bin\/sh -c/);assert.doesNotMatch(probe,/sudo -S|password|read /);
 const run=(prelude:string)=>execFileSync('sh',[],{input:prelude+'\n'+probe,encoding:'utf8'});
 assert.equal(run('id() { echo 0; }; sudo() { echo unexpected; return 1; }'),'privilege_state=root\ninstall_privilege=1\n');
 assert.equal(run('id() { echo 1001; }; sudo() { test "$1" = -n && test "$2" = /bin/sh && test "$3" = -c; }'),'privilege_state=sudo_noninteractive\ninstall_privilege=1\n');
 assert.equal(run('id() { echo 1001; }; sudo() { return 1; }'),'privilege_state=unavailable\ninstall_privilege=0\n');
 assert.equal(run('id() { return 1; }; sudo() { echo unexpected; return 0; }'),'privilege_state=unknown\ninstall_privilege=0\n');
});

test('structured privilege fails closed on missing, inconsistent or malformed provenance',()=>{
 const base='LMSSH=1\nplatform=linux\narch=amd64\nprivilege_state=root\n'+CHECK_NAMES.map(name=>name+'=1').join('\n')+'\n';
 assert.deepEqual(parsePreflight(base).privilege,{state:'root',reason_code:''});
 assert.deepEqual(parsePreflight(base.replace('privilege_state=root','privilege_state=sudo_noninteractive')).privilege,{state:'sudo_noninteractive',reason_code:''});
 for(const state of ['unavailable','unknown']){
  const parsed=parsePreflight(base.replace('privilege_state=root','privilege_state='+state).replace('install_privilege=1','install_privilege=0'));
  assert.equal(parsed.ready,false);assert.equal(parsed.privilege.state,state);
  assert.equal(parsed.privilege.reason_code,state==='unknown'?'privilege_probe_failed':'privilege_unavailable_or_interactive');
 }
 for(const value of [base.replace('privilege_state=root\n',''),base.replace('privilege_state=root','privilege_state=unavailable'),base.replace('privilege_state=root','privilege_state=administrator'),base.replace('install_privilege=1','install_privilege=0'),base+'privilege_state=root\n'])assert.throws(()=>parsePreflight(value),/invalid_response/);
});
