import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createServer, type Socket} from 'node:net';
import {once} from 'node:events';
import {Client, type ConnectConfig} from 'ssh2';
import {CHECK_NAMES,defaultSSHRunner,parsePreflight,pinnedHostKeys,preflightCommand,SSHError} from '../src/server/machine-ssh.js';
import type {SSHMachineTarget} from '../src/server/managed-machines.js';
import {agentInstallationPaths} from '../src/shared/agent-maintenance-shell.js';
import {freshAgentGuard} from '../src/server/machine-agent-lifecycle.js';

test('SSH handshake deadline remains timed_out before the fixed command deadline',async t=>{
 const sockets=new Set<Socket>(),server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('data',()=>{});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const connect=Client.prototype.connect;
 // Exercise ssh2's actual readyTimeout error on a silent loopback endpoint,
 // shortening only the library's handshake deadline in this isolated test.
 t.mock.method(Client.prototype,'connect',function(this:Client,options:ConnectConfig){assert.equal(options.readyTimeout,3000);return connect.call(this,{...options,readyTimeout:30});});
 await assert.rejects(()=>defaultSSHRunner({machine:{address:'127.0.0.1',username:'fixture',host_key_fingerprint:''} as SSHMachineTarget,password:'isolated-loopback-password',privateKey:'',command:'must-not-run',signal:new AbortController().signal,port:(server.address() as {port:number}).port,timeoutMs:3000}),error=>error instanceof SSHError&&error.code==='timed_out');
});

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

test('root and sudo SSH discovery detect every unified Agent residue before fresh deployment without altering it',t=>{
 const root=mkdtempSync(join(tmpdir(),'lm-ssh-installation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const probe=preflightCommand('https://platform.example').split('\n').find(line=>line.includes('echo agent_installation=present'))!;
 const rewrite=(source:string)=>agentInstallationPaths.reduce((text,filename)=>text.replaceAll(filename,join(root,filename)),source);
 const run=(source:string)=>spawnSync('sh',['-c',source],{encoding:'utf8'});
 for(const sudo of [false,true]){
   const login=sudo?'id() { echo 1001; }; sudo() { test "$1" = -n && test "$2" = /bin/sh && test "$3" = -c || return 1; shift 3; /bin/sh -c "$1"; };':'id() { echo 0; };';
   assert.equal(run(login+rewrite(probe)).stdout,'agent_installation=absent\n');
   assert.equal(run(rewrite(freshAgentGuard)).status,0);
   for(const filename of agentInstallationPaths){
     const target=join(root,filename);mkdirSync(dirname(target),{recursive:true});
     const directory=['/opt/lightmoni-agent','/etc/lightmoni-agent-helper','/var/lib/lightmoni-agent-helper'].includes(filename);
     if(directory){mkdirSync(target);writeFileSync(join(target,'sentinel'),'retained helper state');}else writeFileSync(target,'retained program/configuration');
     const observed=run(login+rewrite(probe));assert.equal(observed.status,0,observed.stderr);assert.equal(observed.stdout,'agent_installation=present\n',filename);
     const fresh=run(rewrite(freshAgentGuard));assert.equal(fresh.status,1,filename);assert.match(fresh.stderr,/Existing Agent installation detected/);
     assert.equal(readFileSync(directory?join(target,'sentinel'):target,'utf8'),directory?'retained helper state':'retained program/configuration');
     rmSync(target,{recursive:true});
     symlinkSync('missing-lightmoni-target',target);
     assert.equal(run(login+rewrite(probe)).stdout,'agent_installation=present\n',filename+' dangling link');
     assert.equal(run(rewrite(freshAgentGuard)).status,1,filename+' dangling link');assert.equal(lstatSync(target).isSymbolicLink(),true);
     rmSync(target);
   }
 }
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
