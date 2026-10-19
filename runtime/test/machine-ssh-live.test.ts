import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {defaultSSHRunner,parsePreflight,preflightCommand} from '../src/server/machine-ssh.js';
import type {MachineSummary} from '../src/server/managed-machines.js';

// Optional only on hosts without an SSH daemon. Uses disposable keys, a high
// loopback port and no platform or user SSH configuration.
test('real SSH handshake, exact host pin, private-key authentication, timeout and cancellation',{skip:!existsSync('/usr/sbin/sshd')},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-sshd-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const name of ['host','client','wrong'])execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,name)]);
 await writeFile(join(dir,'authorized_keys'),await readFile(join(dir,'client.pub')));
 const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=(free.address() as any).port;await new Promise<void>(resolve=>free.close(()=>resolve()));
 await writeFile(join(dir,'config'),`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host\nAuthorizedKeysFile ${dir}/authorized_keys\nPidFile ${dir}/pid\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin yes\nLogLevel ERROR\n`);
 const extra:string[]=[];
 // A fixture performs many intentional failed connections from one loopback
 // address. Disable penalties when supported, without changing real sshd.
 try{execFileSync('/usr/sbin/sshd',['-T','-f',join(dir,'config'),'-o','PerSourcePenalties=no'],{stdio:'ignore'});extra.push('-o','PerSourcePenalties=no')}catch{}
 const daemon=spawn('/usr/sbin/sshd',['-D','-e','-f',join(dir,'config'),...extra],{stdio:['ignore','ignore','pipe']});
 let daemonError='';daemon.stderr.on('data',chunk=>{daemonError+=chunk.toString()});
 t.after(async()=>{if(daemon.exitCode===null){daemon.kill('SIGTERM');await once(daemon,'close')}});
 for(let attempt=0;;attempt++){
  if(daemon.exitCode!==null)throw Error('isolated sshd startup failed: '+daemonError);
  const listening=await new Promise<boolean>(resolve=>{const socket=connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))});
  if(listening)break;if(attempt>=50)throw Error('isolated sshd did not listen');await new Promise(resolve=>setTimeout(resolve,20));
 }
 const publicKey=(await readFile(join(dir,'host.pub'),'utf8')).trim().split(/\s+/)[1];
 const pin='SHA256:'+createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('base64').replace(/=+$/,'');
 const machine={address:'127.0.0.1',username:userInfo().username,host_key_fingerprint:pin} as MachineSummary;
 const input={machine,privateKey:await readFile(join(dir,'client'),'utf8'),command:preflightCommand('https://127.0.0.1:1'),signal:new AbortController().signal,port,timeoutMs:10_000};
 const result=await defaultSSHRunner(input),preflight=parsePreflight(result.stdout);
 assert.equal(preflight.checks.platform_https,false);assert.equal(preflight.ready,false);assert.ok(result.stages.includes('host_key_confirmed'));
 await assert.rejects(()=>defaultSSHRunner({...input,machine:{...machine,host_key_fingerprint:'SHA256:wrong-confirmed-key'}}),/host_key_mismatch/);

 await assert.rejects(()=>defaultSSHRunner({...input,command:'sleep 2',timeoutMs:700}),/timed_out/);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>defaultSSHRunner({...input,signal:controller.signal}),/cancelled/);
 const wrongKey=await readFile(join(dir,'wrong'),'utf8');await assert.rejects(()=>defaultSSHRunner({...input,privateKey:wrongKey}),/ssh_failed/);
});
