import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createServer, type Server} from 'node:net';
const {prepareDeploymentPermissions, checkDeploymentPermissions} = await import(pathToFileURL(resolve(import.meta.dirname, '../../deploy/agent/deployment-permissions.mjs')).href);

type Identity = {uid:number;euid:number;gid:number;groups:number[];names:string[];capabilities:{inheritable:string;permitted:string;effective:string;ambient:string}};
const ordinaryIdentity = (): Identity => ({uid:process.getuid?.()||1001,euid:process.geteuid?.()||1001,gid:process.getgid?.()||1001,groups:[process.getgid?.()||1001],names:['lightmoni-agent'],capabilities:{inheritable:'0000000000000000',permitted:'0000000000000000',effective:'0000000000000000',ambient:'0000000000000000'}});
const denied = () => {throw Object.assign(Error('synthetic access denied'),{code:'EACCES'});};

function fixture(t:TestContext) {
  const root=fs.mkdtempSync(join(tmpdir(),'lm-permissions-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=(name:string)=>join(root,name);
  for(const name of ['var/lib','var/run','etc/lightmoni-agent','var/lib/lightmoni-agent'])fs.mkdirSync(p(name),{recursive:true,mode:0o700});
  fs.writeFileSync(p('etc/lightmoni-agent/config.json'),'synthetic private config',{mode:0o600});
  const calls:{file:string;args:string[]}[]=[],identity=ordinaryIdentity();
  const options={root,identity,access:denied,chown:()=>{throw Error('unexpected host ownership mutation');},command:(file:string,args:string[])=>{
    calls.push({file,args:[...args]});
    assert.equal(file,'id','permission preparation may only read the installed account identity');
    assert.equal(args[1],'lightmoni-agent');
    if(args[0]==='-u')return String(identity.uid);
    if(args[0]==='-g')return String(identity.gid);
    if(args[0]==='-G')return identity.groups.join(' ');
    if(args[0]==='-Gn')return identity.names.join(' ');
    throw Error('unexpected account query');
  }};
  return{root,p,options,calls,identity};
}
function snapshot(filename:string) {
  const stat=fs.lstatSync(filename);
  return{mode:stat.mode&0o7777,uid:stat.uid,gid:stat.gid,entries:stat.isDirectory()?fs.readdirSync(filename).sort():undefined,bytes:stat.isFile()?fs.readFileSync(filename,'utf8'):undefined};
}
async function socketAt(filename:string):Promise<Server> {
  const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(filename,resolve);});return server;
}
async function close(server:Server) {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}

test('preparation only reads ordinary account identity and never grants Docker, groups or public-directory ownership',t=>{
  const f=fixture(t),publicRoot=f.p('var/lib/lightmoni-web');
  fs.mkdirSync(publicRoot,{mode:0o710});fs.writeFileSync(join(publicRoot,'external-sentinel'),'external public asset',{mode:0o640});
  const before=snapshot(publicRoot),asset=snapshot(join(publicRoot,'external-sentinel')),config=snapshot(f.p('etc/lightmoni-agent/config.json'));
  assert.equal(prepareDeploymentPermissions(f.options),'ordinary_permissions_verified');assert.equal(prepareDeploymentPermissions(f.options),'ordinary_permissions_verified');
  assert.deepEqual(snapshot(publicRoot),before);assert.deepEqual(snapshot(join(publicRoot,'external-sentinel')),asset);assert.deepEqual(snapshot(f.p('etc/lightmoni-agent/config.json')),config);
  assert(f.calls.length>0);assert(f.calls.every(call=>call.file==='id'));
  assert(!f.calls.some(call=>['getent','groupadd','usermod','chmod','chown','setcap','setfacl'].includes(call.file)));
  fs.rmSync(publicRoot,{recursive:true});prepareDeploymentPermissions(f.options);
  assert.equal(fs.existsSync(publicRoot),false,'ordinary startup does not create a shared website tree');
});

test('dangerous external account groups are rejected without removing membership or touching public data',t=>{
  for(const name of ['root','docker','lxd','libvirt','disk']) {
    const f=fixture(t);f.identity.groups=[1001,998];f.identity.names=['lightmoni-agent',name];
    const prior=structuredClone(f.identity);
    assert.throws(()=>prepareDeploymentPermissions(f.options),/agent_privilege_migration_required/);
    assert.deepEqual(f.identity,prior);assert(f.calls.every(call=>call.file==='id'));
    assert.equal(fs.existsSync(f.p('var/lib/lightmoni-web')),false);
  }
  const f=fixture(t);f.identity.gid=0;f.identity.groups=[0];f.identity.names=['alias-for-gid-zero'];
  assert.throws(()=>prepareDeploymentPermissions(f.options),/agent_account_invalid|agent_privilege_migration_required/);
});

test('root identities and failed or malformed account queries never turn into implicit permission grants',t=>{
  for(const uid of [0,-1]) {
    const f=fixture(t);f.identity.uid=uid;
    assert.throws(()=>prepareDeploymentPermissions(f.options),/agent_account_invalid/);
    assert(f.calls.every(call=>call.file==='id'));
  }
  const f=fixture(t);
  for(const answer of ['not-an-id','1\n2',''])assert.throws(()=>prepareDeploymentPermissions({...f.options,command:()=>answer}),/agent_account_invalid/);
  assert.throws(()=>prepareDeploymentPermissions({...f.options,command:()=>{throw Error('synthetic account query failure');}}));
  assert.equal(fs.existsSync(f.p('var/lib/lightmoni-web')),false);
});

test('startup with no Docker socket is ready using only private config and atomic data-directory writes',async t=>{
  const f=fixture(t),config=snapshot(f.p('etc/lightmoni-agent/config.json'));
  const result=await checkDeploymentPermissions(f.options);
  assert.equal(result,'ordinary_permissions_ready');
  assert.deepEqual(snapshot(f.p('etc/lightmoni-agent/config.json')),config);
  assert.deepEqual(fs.readdirSync(f.p('var/lib/lightmoni-agent')),[]);
  assert.equal(fs.existsSync(f.p('var/lib/lightmoni-web')),false);
  assert.equal(f.calls.length,0,'startup does not run docker or account-management commands when identity is injected');
});

test('runtime actual identity rejects root, privileged groups and every Linux capability set',async t=>{
  for(const changed of [
    {uid:0},{euid:0},{gid:0},{groups:[1001,0]},
    ...['root','docker','lxd','libvirt','disk'].map(name=>({groups:[1001,998],names:['lightmoni-agent',name]})),
    ...['inheritable','permitted','effective','ambient'].map(name=>({capabilities:{...ordinaryIdentity().capabilities,[name]:'0000000000000001'}})),
    {capabilities:{...ordinaryIdentity().capabilities,ambient:'0000000000000400'}},
  ]) {
    const f=fixture(t),identity={...ordinaryIdentity(),...changed};
    await assert.rejects(checkDeploymentPermissions({...f.options,identity}),/agent_privilege_migration_required/);
    assert.deepEqual(fs.readdirSync(f.p('var/lib/lightmoni-agent')),[]);
  }
});

test('runtime rejects malformed capability evidence instead of treating it as all-zero',async t=>{
  for(const value of ['not-hex','',-1,null]) {
    const f=fixture(t);
    await assert.rejects(checkDeploymentPermissions({...f.options,identity:{...f.identity,capabilities:{...f.identity.capabilities,effective:value}}}),/agent_permission_observation_failed/);
  }
});

test('Docker socket connection permission blocks ordinary startup; denied write access permits it',async t=>{
  const f=fixture(t),filename=f.p('var/run/docker.sock'),server=await socketAt(filename);
  try {
    const checks:number[]=[];
    await assert.rejects(checkDeploymentPermissions({...f.options,access:(path:string,mode:number)=>{
      assert.equal(path,filename);checks.push(mode);assert.equal(mode,fs.constants.W_OK);
    }}),/agent_privilege_migration_required/);
    assert.deepEqual(checks,[fs.constants.W_OK]);
    // A read mode bit does not grant Unix socket connect permission. Only
    // denied W_OK is relevant; the helper must not send a Docker command.
    assert.equal(await checkDeploymentPermissions({...f.options,access:(path:string,mode:number)=>{assert.equal(path,filename);assert.equal(mode,fs.constants.W_OK);denied();}}),'ordinary_permissions_ready');
    assert.equal(server.listening,true,'the helper neither stops the daemon nor changes socket grants');
  } finally {await close(server);}
});

test('socket symlinks, non-sockets and unprovable access errors fail closed without changing their targets',async t=>{
  const f=fixture(t),filename=f.p('var/run/docker.sock'),external=f.p('external-socket'),server=await socketAt(external);
  try {
    fs.symlinkSync(external,filename);
    await assert.rejects(checkDeploymentPermissions(f.options),/agent_privilege_migration_required/);
    assert.equal(fs.lstatSync(filename).isSymbolicLink(),true);assert.equal(server.listening,true);
    fs.unlinkSync(filename);fs.writeFileSync(filename,'external non-socket');
    await assert.rejects(checkDeploymentPermissions(f.options),/agent_privilege_migration_required/);
    assert.equal(fs.readFileSync(filename,'utf8'),'external non-socket');fs.unlinkSync(filename);
    fs.symlinkSync(f.p('absent-target'),filename);
    await assert.rejects(checkDeploymentPermissions(f.options),/agent_privilege_migration_required/);
    fs.unlinkSync(filename);
  } finally {await close(server);}
  const actual=await socketAt(filename);
  try {await assert.rejects(checkDeploymentPermissions({...f.options,access:()=>{throw Object.assign(Error('unprovable socket permissions'),{code:'EIO'});}}));}
  finally {await close(actual);}
});

test('config secrecy and private directory boundaries remain mandatory without a public-directory requirement',async t=>{
  for(const entry of ['etc/lightmoni-agent/config.json','var/lib/lightmoni-agent']) {
    const f=fixture(t);fs.chmodSync(f.p(entry),entry.endsWith('.json')?0o644:0o755);
    await assert.rejects(checkDeploymentPermissions(f.options),/agent_(?:config|directory)_permission_invalid/);
    assert.equal(fs.readFileSync(f.p('etc/lightmoni-agent/config.json'),'utf8'),'synthetic private config');
  }
  const f=fixture(t),external=f.p('external-private');fs.mkdirSync(external,{mode:0o700});
  fs.rmSync(f.p('var/lib/lightmoni-agent'),{recursive:true});fs.symlinkSync(external,f.p('var/lib/lightmoni-agent'));
  await assert.rejects(checkDeploymentPermissions(f.options),/agent_directory_permission_invalid/);assert.deepEqual(fs.readdirSync(external),[]);
  fs.unlinkSync(f.p('var/lib/lightmoni-agent'));fs.mkdirSync(f.p('var/lib/lightmoni-agent'),{mode:0o700});
  const original=f.p('etc/lightmoni-agent/config.json');const target=f.p('external-config.json');fs.renameSync(original,target);fs.symlinkSync(target,original);
  await assert.rejects(checkDeploymentPermissions(f.options),/agent_config_permission_invalid/);
  assert.equal(fs.readFileSync(target,'utf8'),'synthetic private config');
});
