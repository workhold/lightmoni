import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dockerInstallScript} from '../src/server/docker-install-script.js';

/** Execute the production shell with isolated system paths and command stubs.
 * Package managers always fail before they could reach any real host state. */
function runInstaller(options:{distribution:string;engine?:boolean;compose?:boolean;finalComposeFails?:boolean}) {
 const root=mkdtempSync(join(tmpdir(),'lm-docker-existing-'));
 try {
  const bin=join(root,'bin'),status=join(root,'operation'),calls=join(root,'calls');
  mkdirSync(bin);mkdirSync(status);mkdirSync(join(root,'systemd'));
  writeFileSync(join(root,'os-release'),`ID=${options.distribution}\nVERSION_CODENAME=bookworm\n`);
  const stub=(name:string,body:string)=>writeFileSync(join(bin,name),'#!'+process.execPath+'\n'+body,{mode:0o755});
  const record=`const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.LM_DOCKER_TEST_CALLS,JSON.stringify({command:require('node:path').basename(process.argv[1]),args})+'\\n');`;
  stub('id',`process.stdout.write('0\\n');`);
  stub('uname',`process.stdout.write(process.argv[2]==='-s'?'Linux\\n':'x86_64\\n');`);
  stub('flock',record);
  stub('systemctl',record);
  stub('apt-get',record+'process.exit(90);');
  stub('dpkg-query',record+'process.exit(1);');
  if(options.engine!==false)stub('docker',record+`
if(args.includes('compose')){
 const file=process.env.LM_DOCKER_TEST_COMPOSE_CALLS;let count=0;try{count=Number(fs.readFileSync(file,'utf8'));}catch{}fs.writeFileSync(file,String(++count));
 if(process.env.LM_DOCKER_TEST_COMPOSE!=='yes'||process.env.LM_DOCKER_TEST_FINAL_FAIL==='yes'&&count>1)process.exit(1);
 process.stdout.write('2.27.0\\n');
}else if(args.includes('info'))process.stdout.write('26.1.3\\n');else process.exit(1);
`);
  symlinkSync('/bin/mv',join(bin,'mv'));
  const script=join(root,'install.sh');
  writeFileSync(script,dockerInstallScript.replaceAll('/etc/os-release',join(root,'os-release')).replaceAll('/run/systemd/system',join(root,'systemd')).replaceAll('/run/lightmoni-docker-install.lock',join(root,'install.lock')));
  const result=spawnSync('/bin/sh',[script,status],{env:{...process.env,PATH:bin,LM_DOCKER_TEST_CALLS:calls,LM_DOCKER_TEST_COMPOSE_CALLS:join(root,'compose-calls'),LM_DOCKER_TEST_COMPOSE:options.compose===false?'no':'yes',LM_DOCKER_TEST_FINAL_FAIL:options.finalComposeFails?'yes':'no'},encoding:'utf8',timeout:30000});
  assert.ifError(result.error);
  return {exit:result.status,status:JSON.parse(readFileSync(join(status,'status.json'),'utf8')),calls:readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line)) as {command:string;args:string[]}[]};
 } finally {rmSync(root,{recursive:true,force:true});}
}

for(const distribution of ['centos','ubuntu'])test(`existing Docker and Compose on ${distribution} are verified without package management`,()=>{
 const result=runInstaller({distribution});
 assert.equal(result.exit,0,JSON.stringify(result.status));
 assert.deepEqual(result.status,{state:'succeeded',phase:'verified',code:''});
 assert.deepEqual(result.calls.filter(call=>call.command==='systemctl'),[{command:'systemctl',args:['enable','--now','docker']}]);
 assert.equal(result.calls.some(call=>['apt-get','dpkg-query'].includes(call.command)),false);
 assert.ok(result.calls.some(call=>call.command==='docker'&&call.args.includes('info')));
 assert.equal(result.calls.filter(call=>call.command==='docker'&&call.args.includes('compose')).length,2);
});

for(const missing of ['engine','compose'])test(`CentOS with missing ${missing} refuses package installation and leaves the daemon untouched`,()=>{
 const result=runInstaller({distribution:'centos',engine:missing!=='engine',compose:missing!=='compose'});
 assert.equal(result.exit,1);
 assert.deepEqual(result.status,{state:'failed',phase:'checking_system',code:'docker_install_unsupported'});
 assert.equal(result.calls.some(call=>['apt-get','dpkg-query','systemctl'].includes(call.command)),false);
});

test('existing Docker requires final Compose verification before recording success',()=>{
 const result=runInstaller({distribution:'centos',finalComposeFails:true});
 assert.equal(result.exit,1);
 assert.deepEqual(result.status,{state:'failed',phase:'verifying_docker',code:'docker_install_verification_failed'});
 assert.equal(result.calls.some(call=>call.command==='apt-get'),false);
});
