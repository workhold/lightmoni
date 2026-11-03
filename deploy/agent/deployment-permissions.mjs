#!/usr/bin/env node
/** Verify the network-facing Agent remains an unprivileged service. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const fail = code => { throw Object.assign(Error(code), {safeCode: code}); };
const command = (file, args) => execFileSync('/usr/bin/'+file, args, {encoding:'utf8', timeout:5000, maxBuffer:8192, env:{PATH:'/usr/bin:/bin',LANG:'C'}, stdio:['ignore','pipe','ignore']}).trim();
const blockedGroups = new Set(['root','docker','lxd','lxc','incus-admin','libvirt','disk','kmem','sudo','wheel']);
const numericID = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fail('agent_account_invalid');
const groupSnapshot = (ids, names) => {
  if (!Array.isArray(ids) || !ids.length || ids.some(g=>!Number.isSafeInteger(g)||g<0)||!Array.isArray(names)||!names.length||names.some(n=>typeof n!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(n))) fail('agent_permission_observation_failed');
  if (ids.includes(0)||names.some(name=>blockedGroups.has(name))) fail('ordinary_agent_privilege_violation');
};

export function prepareDeploymentPermissions(options = {}) {
  const run = options.command ?? command;
  numericID(run('id', ['-u', 'lightmoni-agent'])); numericID(run('id', ['-g', 'lightmoni-agent']));
  const ids = run('id', ['-G', 'lightmoni-agent']).split(/\s+/).map(value=>/^\d+$/.test(value)?Number(value):NaN);
  const names = run('id', ['-Gn', 'lightmoni-agent']).split(/\s+/);
  groupSnapshot(ids,names);
  // No groupadd/usermod/setcap, socket ACL/mode, sysctl or public-path chown.
  // Existing privileges are left intact and are never called "removed".
  return 'ordinary_permissions_verified';
}

function writableDirectory(directory, uid) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid!==uid || (info.mode & 0o077)) fail('agent_directory_permission_invalid');
  const first = path.join(directory, '.lightmoni-permission-' + randomUUID()), second = first + '.verified';
  try {
    const fd = fs.openSync(first, 'wx', 0o600);
    try { fs.writeFileSync(fd, 'permission-check'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(first, second);
    if (fs.readFileSync(second, 'utf8') !== 'permission-check') fail('agent_directory_check_failed');
  } finally {
    for (const file of [first,second]) { try { fs.unlinkSync(file); } catch (error) { if (error.code!=='ENOENT') throw error; } }
  }
}
function actualIdentity() {
  if(process.platform!=='linux')fail('linux_permission_observation_required');
  const status=fs.readFileSync('/proc/self/status','utf8');
  const capability=name=>{const matches=[...status.matchAll(new RegExp('^'+name+':[ \\t]+([a-fA-F0-9]+)$','gm'))];if(matches.length!==1)fail('agent_permission_observation_failed');return matches[0][1];};
  return {uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),groups:process.getgroups(),names:command('id',['-Gn']).split(/\s+/),
    capabilities:{inheritable:capability('CapInh'),permitted:capability('CapPrm'),effective:capability('CapEff'),ambient:capability('CapAmb')}};
}
export async function checkDeploymentPermissions(options = {}) {
  const identity=options.identity??actualIdentity(), p=value=>path.join(options.root??'/',value);
  if(!Number.isSafeInteger(identity.uid)||identity.uid<=0||!Number.isSafeInteger(identity.euid)||identity.euid<=0||!Number.isSafeInteger(identity.gid)||identity.gid<=0)fail('ordinary_agent_privilege_violation');
  groupSnapshot([identity.gid,...identity.groups],identity.names);
  if(!identity.capabilities||Object.keys(identity.capabilities).sort().join(',')!=='ambient,effective,inheritable,permitted')fail('agent_permission_observation_failed');
  for(const value of Object.values(identity.capabilities)){
    if(typeof value!=='string'||!/^[a-fA-F0-9]{1,32}$/.test(value))fail('agent_permission_observation_failed');
    if(BigInt('0x'+value)!==0n)fail('ordinary_agent_privilege_violation');
  }
  const socket=p('/var/run/docker.sock'); let socketInfo;
  try{socketInfo=fs.lstatSync(socket);}catch(error){if(error.code!=='ENOENT')fail('agent_permission_observation_failed');}
  if(socketInfo){
    if(socketInfo.isSymbolicLink()||!socketInfo.isSocket())fail('ordinary_agent_privilege_violation');
    try{(options.access??fs.accessSync)(socket,fs.constants.W_OK);fail('ordinary_agent_privilege_violation');}
    catch(error){if(!['EACCES','EPERM'].includes(error.code))throw error;}
  }
  const config=p('/etc/lightmoni-agent/config.json'), info=fs.lstatSync(config);
  if(!info.isFile()||info.isSymbolicLink()||!(info.uid===identity.uid&&(info.mode&0o077)===0||info.uid===0&&(info.mode&0o027)===0))fail('agent_config_permission_invalid');
  let value;try{value=JSON.parse(fs.readFileSync(config,'utf8'));}catch{fail('agent_config_permission_invalid');}
  if(!['user','root'].includes(value.runtime_mode??'user')||!Number.isSafeInteger(value.permission_generation??1)||(value.permission_generation??1)<1)fail('runtime_identity_mismatch');
  fs.accessSync(config,fs.constants.R_OK);writableDirectory(p('/var/lib/lightmoni-agent'),identity.uid);
  return 'ordinary_permissions_ready';
}
export function checkHelperPermissions(options = {}) {
  const identity=options.identity??actualIdentity(), p=value=>path.join(options.root??'/',value);
  const boundary=path.resolve(options.root??'/');
  if(identity.uid!==0||identity.euid!==0||identity.gid!==0)fail('helper_root_identity_required');
  const lstat=options.lstat??fs.lstatSync;
  const privateFile=(file,mode)=>{
    const info=lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o777)!==mode||info.nlink!==1)fail('helper_private_config_invalid');
    for(let at=path.dirname(file);;at=path.dirname(at)){
      const parent=lstat(at);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o022))fail('helper_private_config_invalid');
      if(at===boundary)break;
      if(!at.startsWith(boundary+path.sep))fail('helper_private_config_invalid');
    }
    try{JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('helper_private_config_invalid');}
  };
  const privateDirectory=(directory,mode)=>{
    const info=lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o777)!==mode)fail('helper_private_state_invalid');
    for(let at=path.dirname(directory);;at=path.dirname(at)){
      const parent=lstat(at);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o022))fail('helper_private_state_invalid');
      if(at===boundary)break;
      if(!at.startsWith(boundary+path.sep))fail('helper_private_state_invalid');
    }
  };
  privateDirectory(p('/etc/lightmoni-agent-helper'),0o700);
  privateFile(p('/etc/lightmoni-agent-helper/helper.json'),0o600);
  privateDirectory(p('/var/lib/lightmoni-agent-helper'),0o711);
  privateDirectory(p('/var/lib/lightmoni-agent-helper/managed'),0o700);
  const tasks=lstat(p('/var/lib/lightmoni-agent-helper/tasks'));
  if(!tasks.isDirectory()||tasks.isSymbolicLink()||tasks.uid!==0||(tasks.mode&0o777)!==0o711)fail('helper_task_directory_invalid');
  return 'privileged_helper_permissions_ready';
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if(process.argv[2]==='prepare'&&process.getuid?.()===0)console.log(prepareDeploymentPermissions());
    else if(process.argv[2]==='check')console.log(await checkDeploymentPermissions());
    else if(process.argv[2]==='helper-check'&&process.getuid?.()===0)console.log(checkHelperPermissions());
    else fail('agent_permission_check_invalid_invocation');
  } catch(error){console.error(typeof error.safeCode==='string'?error.safeCode:'agent_permission_observation_failed');process.exitCode=1;}
}
