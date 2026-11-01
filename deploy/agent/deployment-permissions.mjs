#!/usr/bin/env node
/** Ordinary Agent permission observation. Never grants or removes host powers.
 * Legacy/external authority requires explicit migration to the root executor. */
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
  if (ids.includes(0)||names.some(name=>blockedGroups.has(name))) fail('agent_privilege_migration_required');
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
  if(!Number.isSafeInteger(identity.uid)||identity.uid<=0||!Number.isSafeInteger(identity.euid)||identity.euid<=0||!Number.isSafeInteger(identity.gid)||identity.gid<=0)fail('agent_privilege_migration_required');
  groupSnapshot([identity.gid,...identity.groups],identity.names);
  if(!identity.capabilities||Object.keys(identity.capabilities).sort().join(',')!=='ambient,effective,inheritable,permitted')fail('agent_permission_observation_failed');
  for(const value of Object.values(identity.capabilities)){
    if(typeof value!=='string'||!/^[a-fA-F0-9]{1,32}$/.test(value))fail('agent_permission_observation_failed');
    if(BigInt('0x'+value)!==0n)fail('agent_privilege_migration_required');
  }
  const socket=p('/var/run/docker.sock'); let socketInfo;
  try{socketInfo=fs.lstatSync(socket);}catch(error){if(error.code!=='ENOENT')fail('agent_permission_observation_failed');}
  if(socketInfo){
    if(socketInfo.isSymbolicLink()||!socketInfo.isSocket())fail('agent_privilege_migration_required');
    try{(options.access??fs.accessSync)(socket,fs.constants.W_OK);fail('agent_privilege_migration_required');}
    catch(error){if(!['EACCES','EPERM'].includes(error.code))throw error;}
  }
  const config=p('/etc/lightmoni-agent/config.json'), info=fs.lstatSync(config);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==identity.uid||(info.mode&0o077))fail('agent_config_permission_invalid');
  fs.accessSync(config,fs.constants.R_OK);writableDirectory(p('/var/lib/lightmoni-agent'),identity.uid);
  return 'ordinary_permissions_ready';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if(process.argv[2]==='prepare'&&process.getuid?.()===0)console.log(prepareDeploymentPermissions());
    else if(process.argv[2]==='check'&&process.getuid?.()!==0)console.log(await checkDeploymentPermissions());
    else fail('agent_permission_check_invalid_invocation');
  } catch(error){console.error(typeof error.safeCode==='string'?error.safeCode:'agent_permission_observation_failed');process.exitCode=1;}
}
