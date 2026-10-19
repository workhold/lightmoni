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
 const output='LMSSH=1\nplatform=linux\narch=amd64\n'+CHECK_NAMES.map(name=>name+'=1').join('\n')+'\n';
 assert.equal(parsePreflight(output).ready,true);
 for(const bad of [output+'curl=1\n',output+'remote prompt injection',output.replace('linux=1','linux=0'),output.replace('curl=1','curl=yes'),output+'secret=private\n'])assert.throws(()=>parsePreflight(bad),/invalid_response/);
 assert.match(preflightCommand('http://platform.example'),/echo 'platform_https=0'/);
 for(const url of ['file:///tmp/anything','https://user:password@platform.example','https://platform.example/?key=secret'])assert.throws(()=>preflightCommand(url),/HTTPS/);
});
