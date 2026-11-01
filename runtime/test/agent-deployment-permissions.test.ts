import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
const {prepareDeploymentPermissions, checkDeploymentPermissions} = await import(pathToFileURL(resolve(import.meta.dirname, '../../deploy/agent/deployment-permissions.mjs')).href);

function fixture(t:any) {
  const root=fs.mkdtempSync(join(tmpdir(),'lm-permissions-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=(name:string)=>join(root,name);
  for(const name of ['var/lib','var/run','etc/lightmoni-agent','var/lib/lightmoni-agent'])fs.mkdirSync(p(name),{recursive:true,mode:0o700});
  fs.writeFileSync(p('etc/lightmoni-agent/config.json'),'synthetic private config',{mode:0o600});
  const calls:any[]=[];let exists=false;
  const options={root,chown:()=>{},command:(file:string,args:string[])=>{
    calls.push([file,args]);
    if(file==='id')return String(args[0]==='-u'?process.getuid?.()||501:process.getgid?.()||20);
    if(file==='getent'){if(!exists)throw Object.assign(Error('private details'),{status:2});return'docker:x:998:';}
    if(file==='groupadd'){exists=true;return'';}
    throw Error('unexpected command');
  }};
  return{root,p,options,calls};
}

test('installation creates the Docker group before service startup and prepares a separate public directory idempotently', t=>{
  const f=fixture(t);
  prepareDeploymentPermissions(f.options);
  prepareDeploymentPermissions(f.options);
  assert.equal(f.calls.filter(([file]:any)=>file==='groupadd').length,1);
  assert.equal(fs.statSync(f.p('var/lib/lightmoni-web')).mode&0o777,0o755);
  assert.equal(fs.statSync(f.p('var/lib/lightmoni-agent')).mode&0o777,0o700);
  assert(!f.calls.some(([file]:any)=>['usermod','chmod','chown'].includes(file)));
});

test('group lookup failures and root-group aliases are refused without leaking command errors', t=>{
  const f=fixture(t);
  for(const result of ['docker:x:0:','other:x:998:','docker:x:not-a-gid:']){
    assert.throws(()=>prepareDeploymentPermissions({...f.options,command:(file:string,args:string[])=>file==='id'?f.options.command(file,args):result}),/docker_group_invalid/);
  }
  assert.throws(()=>prepareDeploymentPermissions({...f.options,command:(file:string,args:string[])=>{
    if(file==='id')return f.options.command(file,args);
    throw Object.assign(Error('hidden secret'),{status:1});
  }}),/docker_group_lookup_failed/);
});

test('public directory symlinks are refused rather than changing their targets', t=>{
  const f=fixture(t), external=f.p('external');fs.mkdirSync(external);
  fs.symlinkSync(external,f.p('var/lib/lightmoni-web'));
  assert.throws(()=>prepareDeploymentPermissions(f.options),/agent_public_path_unsafe/);
  assert.deepEqual(fs.readdirSync(external),[]);
});

test('startup verifies atomic private/public writes and defers only a missing Docker dependency', async t=>{
  const f=fixture(t);prepareDeploymentPermissions(f.options);
  const result=await checkDeploymentPermissions({root:f.root,lowPortCheck:async()=>{}});
  assert.equal(result,'docker_daemon_pending');
  assert.equal(fs.readFileSync(f.p('etc/lightmoni-agent/config.json'),'utf8'),'synthetic private config');
  assert.deepEqual(fs.readdirSync(f.p('var/lib/lightmoni-agent')),[]);
  assert.deepEqual(fs.readdirSync(f.p('var/lib/lightmoni-web')),[]);
  fs.chmodSync(f.p('etc/lightmoni-agent/config.json'),0o644);
  await assert.rejects(checkDeploymentPermissions({root:f.root,lowPortCheck:async()=>{}}),/agent_config_permission_invalid/);
});

test('startup rejects low-port denial and Docker permission errors rather than reporting readiness', async t=>{
  const f=fixture(t);prepareDeploymentPermissions(f.options);
  await assert.rejects(checkDeploymentPermissions({root:f.root,lowPortCheck:async()=>{throw Error('agent_low_port_permission_denied');}}),/agent_low_port_permission_denied/);
  const socket=createServer();await new Promise<void>(r=>socket.listen(f.p('var/run/docker.sock'),r));
  try{
    await assert.rejects(checkDeploymentPermissions({root:f.root,lowPortCheck:async()=>{},dockerCommand:()=>({status:1,stderr:'permission denied: hidden socket details'})}),/agent_docker_permission_denied/);
    assert.equal(await checkDeploymentPermissions({root:f.root,lowPortCheck:async()=>{},dockerCommand:()=>({status:0,stderr:''})}),'deployment_permissions_ready');
  }finally{await new Promise<void>(r=>socket.close(()=>r()));}
});
