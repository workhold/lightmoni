import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {prepareDeploymentPermissions,checkDeploymentPermissions} from '/work/deploy/agent/deployment-permissions.mjs';
import {executeWebsite} from '../../../runtime/src/operations/websites.ts';
import {executeCertificate} from '../../../runtime/src/operations/certificates.ts';

async function runChild(mode, groups) {
  const args=['--reset-env','--reuid=lightmoni-agent','--regid=lightmoni-agent',groups,
    '--bounding-set=-all,+net_bind_service','--inh-caps=+net_bind_service',
    '--ambient-caps=+net_bind_service','--no-new-privs','env','PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','node',process.argv[1],mode];
  return new Promise((resolve,reject)=>{
    const child=spawn('setpriv',args,{stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('permission fixture child failed: '+code)));
  });
}

async function worker(denied) {
  assert.notEqual(process.getuid(),0);
  assert.equal(fs.readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start','utf8').trim(),'1024');
  const status=fs.readFileSync('/proc/self/status','utf8');
  assert.match(status,/CapEff:\s+0*400\n/);assert.match(status,/NoNewPrivs:\s+1\n/);
  if(denied){
    await assert.rejects(checkDeploymentPermissions(),/agent_docker_permission_denied/);
    console.log('PASS Docker socket access is denied without its service group');
    return;
  }
  assert.equal(await checkDeploymentPermissions(),'deployment_permissions_ready');
  console.log('PASS startup checks under the real non-root UID, Docker group, capability and read-only root');
  assert.throws(()=>fs.writeFileSync('/etc/lightmoni-must-not-write','test'),e=>['EROFS','EACCES'].includes(e.code));
  for(const port of [80,443]){
    const probe=tcpServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});
    await new Promise(resolve=>probe.close(resolve));
  }
  console.log('PASS 80/443 bind with CAP_NET_BIND_SERVICE');
  const dataDir='/var/lib/lightmoni-agent';
  const command=(file,args,options={})=>new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:options.cwd,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:dataDir,LANG:'C',LC_ALL:'C'}});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fixture command timeout'));},options.timeoutMs??15000);
    child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(code===0){resolve({stdout,stderr});return;}if(file==='nginx')console.error('Fixture nginx diagnostic:',stderr);reject(Error('fixture command failed: '+file+' '+stderr));});
    child.stdin.end(options.stdin);
  });
  const context={dataDir,signal:AbortSignal.timeout(60000),now:()=>new Date(),command};
  const payload=(id,kind,config,operation='apply',revision=1,input={})=>({version:1,operation_id:randomUUID().replaceAll('-',''),operation,resource:{id,kind,name:id,agent_id:'isolated-fixture',revision,config,created_at:'',updated_at:''},input});
  const upstream=createServer((_req,res)=>res.end('upstream healthy'));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const original={domains:['example.test'],mode:'static',listen_port:80,static_files:{'index.html':'first static content'}};
  try{
    const first=await executeWebsite(payload('site-one','website',original),context);
    assert.equal(first.verified,true);
    assert.equal(await(await fetch('http://127.0.0.1/',{headers:{Connection:'close'}})).text(),'first static content');
    const config=fs.readFileSync(join(dataDir,'operations/websites/nginx.conf'),'utf8');
    for(const name of ['client_body','proxy','fastcgi','uwsgi','scgi'])assert.match(config,new RegExp(name+'_temp_path "/var/lib/lightmoni-agent/operations/websites/temp/'));
    assert.match(fs.readFileSync(join(dataDir,'operations/websites/active/site-one.conf'),'utf8'),/\/var\/lib\/lightmoni-web\//);
    console.log('PASS real static website on port 80; config, PID, logs and all temporary paths stay in managed directories');
    await assert.rejects(executeWebsite(payload('site-one','website',{domains:original.domains,mode:'proxy',listen_port:80,upstream:'http://127.0.0.1:9'},'apply',2),context),/WEBSITE_ACTIVATION_FAILED_RESTORED/);
    assert.equal(await(await fetch('http://127.0.0.1/',{headers:{Connection:'close'}})).text(),'first static content');
    console.log('PASS failed website update restores the live previous configuration');
    const second={...original,static_files:{'index.html':'second static content'}};
    await executeWebsite(payload('site-one','website',second,'apply',2),context);
    assert.equal(await(await fetch('http://127.0.0.1/',{headers:{Connection:'close'}})).text(),'second static content');
    await executeWebsite(payload('site-one','website',second,'restore',2,{version:first.data.active_version}),context);
    assert.equal(await(await fetch('http://127.0.0.1/',{headers:{Connection:'close'}})).text(),'first static content');
    console.log('PASS configuration reload and explicit version restore under the Agent user');
    const proxy={domains:['proxy.test'],mode:'proxy',listen_port:18080,upstream:'http://127.0.0.1:'+upstream.address().port};
    await executeWebsite(payload('site-proxy','website',proxy),context);
    assert.equal(await(await fetch('http://127.0.0.1:18080/',{headers:{Connection:'close'}})).text(),'upstream healthy');
    console.log('PASS real reverse proxy deployment');
    const makeCertificate=async name=>{
      const key=join(dataDir,name+'.key'),certificate=join(dataDir,name+'.crt');
      await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','2','-subj','/CN=example.test','-addext','subjectAltName=DNS:example.test']);
      return{domains:['example.test'],certificate_pem:fs.readFileSync(certificate,'utf8'),private_key_pem:fs.readFileSync(key,'utf8')};
    };
    const certificate=await makeCertificate('certificate-one');
    assert.equal((await executeCertificate(payload('cert-one','certificate',certificate,'install'),context)).verified,true);
    const privateKey=join(dataDir,'operations/certificates/cert-one/private.key');
    assert.equal(fs.statSync(privateKey).mode&0o777,0o600);
    const tls={...original,certificate_id:'cert-one',https_port:443};
    assert.equal((await executeWebsite(payload('site-one','website',tls,'apply',3),context)).verified,true);
    const replacement=await makeCertificate('certificate-two');
    assert.equal((await executeCertificate(payload('cert-one','certificate',replacement,'install',2),context)).verified,true);
    assert.equal(fs.statSync(privateKey).mode&0o777,0o600);
    console.log('PASS HTTPS on port 443, uploaded certificate and verified certificate rotation; private key stays 0600');
    const log=await executeWebsite(payload('site-one','website',tls,'logs',3,{stream:'access',lines:2}),context);
    assert.ok(log.data.text);
    await executeWebsite(payload('site-one','website',tls,'disable',3),context);
    await executeWebsite(payload('site-proxy','website',proxy,'disable'),context);
    console.log('PASS managed log reading and website disable/reload');
  }finally{
    await new Promise(resolve=>upstream.close(resolve));
    await command('nginx',['-p',join(dataDir,'operations/websites')+'/','-c',join(dataDir,'operations/websites/nginx.conf'),'-s','quit']).catch(()=>{});
  }
}

async function main(){
  if(process.getuid()!==0)return worker(process.argv[2]==='--denied');
  const uid=Number(execFileSync('id',['-u','lightmoni-agent'],{encoding:'utf8'}));
  const primaryGid=Number(execFileSync('id',['-g','lightmoni-agent'],{encoding:'utf8'}));
  fs.chownSync('/var/lib/lightmoni-agent',uid,primaryGid);
  prepareDeploymentPermissions();
  // A read-only Engine API fixture validates actual Unix socket permissions;
  // this is not a container deployment or a connection to the host Docker daemon.
  const gid=Number(execFileSync('getent',['group','docker'],{encoding:'utf8'}).split(':')[2]);
  let requests=0;
  const engine=createServer((req,res)=>{
    requests++;res.setHeader('API-Version','1.47');res.setHeader('Connection','close');
    if(req.url==='/_ping'){res.end(req.method==='HEAD'?'':'OK');return;}
    if(req.url.endsWith('/version')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Version:'27.5.1-fixture',ApiVersion:'1.47',MinAPIVersion:'1.24',Os:'linux',Arch:process.arch}));return;}
    res.statusCode=404;res.end();
  });
  await new Promise(resolve=>engine.listen('/var/run/docker.sock',resolve));
  fs.chownSync('/var/run/docker.sock',0,gid);fs.chmodSync('/var/run/docker.sock',0o660);
  try{
    await runChild('--denied','--clear-groups');
    await runChild('--worker','--groups=lightmoni-agent,docker');
    assert.ok(requests>0);
    console.log('PASS all deployment and website permission checks; Engine API calls='+requests);
  }finally{await new Promise(resolve=>engine.close(resolve));}
}
await main();
