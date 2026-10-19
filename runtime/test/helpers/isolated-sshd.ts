import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import type {TestContext} from 'node:test';

export async function isolatedSSHD(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-terminal-sshd-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const name of ['host','client','wrong'])execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,name)]);
 await writeFile(join(dir,'authorized_keys'),await readFile(join(dir,'client.pub')));
 const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=(free.address() as any).port;await new Promise<void>(resolve=>free.close(()=>resolve()));
 await writeFile(join(dir,'config'),`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host\nAuthorizedKeysFile ${dir}/authorized_keys\nPidFile ${dir}/pid\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin yes\nLogLevel ERROR\nPrintMotd no\nPrintLastLog no\nForceCommand /usr/bin/env LANG=${process.platform==='darwin'?'en_US.UTF-8':'C.UTF-8'} LC_ALL=${process.platform==='darwin'?'en_US.UTF-8':'C.UTF-8'} HISTFILE=/dev/null INPUTRC=/dev/null /bin/bash --noprofile --norc -i\n`);
 const extra:string[]=[];
 try{execFileSync('/usr/sbin/sshd',['-T','-f',join(dir,'config'),'-o','PerSourcePenalties=no'],{stdio:'ignore'});extra.push('-o','PerSourcePenalties=no')}catch{}
 const daemon=spawn('/usr/sbin/sshd',['-D','-e','-f',join(dir,'config'),...extra],{stdio:['ignore','ignore','pipe']});
 let error='';daemon.stderr.on('data',chunk=>{error+=chunk.toString()});
 t.after(async()=>{if(daemon.exitCode===null){daemon.kill('SIGTERM');await once(daemon,'close')}});
 for(let attempt=0;;attempt++){
  if(daemon.exitCode!==null)throw Error('isolated sshd startup failed: '+error);
  const listening=await new Promise<boolean>(resolve=>{const socket=connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))});
  if(listening)break;if(attempt>=50)throw Error('isolated sshd did not listen');await new Promise(resolve=>setTimeout(resolve,20));
 }
 const key=(await readFile(join(dir,'host.pub'),'utf8')).trim().split(/\s+/)[1];
 return {address:'127.0.0.1',port,username:userInfo().username,pin:'SHA256:'+createHash('sha256').update(Buffer.from(key,'base64')).digest('base64').replace(/=+$/,''),privateKey:await readFile(join(dir,'client'),'utf8'),wrongKey:await readFile(join(dir,'wrong'),'utf8')};
}
