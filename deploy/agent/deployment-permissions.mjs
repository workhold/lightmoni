#!/usr/bin/env node
/** Fixed installation/startup permission contract. Never prints config or CLI output. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';

const fail = code => { throw Object.assign(Error(code), {safeCode: code}); };
const command = (file, args) => execFileSync(file, args, {encoding:'utf8', timeout:15000, stdio:['ignore','pipe','pipe']}).trim();
const numericID = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fail('agent_account_invalid');

export function prepareDeploymentPermissions(options = {}) {
  const run = options.command ?? command;
  const p = value => path.join(options.root ?? '/', value);
  const uid = numericID(run('id', ['-u', 'lightmoni-agent']));
  const gid = numericID(run('id', ['-g', 'lightmoni-agent']));
  let docker;
  try { docker = run('getent', ['group', 'docker']); }
  catch (error) {
    if (error.status !== 2) fail('docker_group_lookup_failed');
    try { run('groupadd', ['--system', 'docker']); docker = run('getent', ['group', 'docker']); }
    catch { fail('docker_group_prepare_failed'); }
  }
  if (!/^docker:[^:]*:[1-9]\d*:[^\n]*$/.test(docker) || !Number.isSafeInteger(Number(docker.split(':')[2]))) fail('docker_group_invalid');
  const publicRoot = p('/var/lib/lightmoni-web');
  // No recursive chown: existing website assets and unrelated trees are never followed.
  for (const ancestor of [p('/var'), p('/var/lib')]) {
    const info = fs.lstatSync(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('agent_public_path_unsafe');
  }
  try {
    const info = fs.lstatSync(publicRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid)) fail('agent_public_path_unsafe');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(publicRoot, {mode:0o755});
  }
  const own = options.chown ?? fs.chownSync;
  own(publicRoot, uid, gid);
  fs.chmodSync(publicRoot, 0o755);
}

function writableDirectory(directory, privateDirectory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (privateDirectory && (info.mode & 0o077))) fail('agent_directory_permission_invalid');
  const first = path.join(directory, '.lightmoni-permission-' + randomUUID());
  const second = first + '.verified';
  try {
    const fd = fs.openSync(first, 'wx', 0o600);
    try { fs.writeFileSync(fd, 'permission-check'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(first, second);
    if (fs.readFileSync(second, 'utf8') !== 'permission-check') fail('agent_directory_check_failed');
  } finally {
    for (const file of [first, second]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

async function lowPortPermission() {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => {
      try { server.close(); } catch {}
      // Linux checks low-port permission before checking whether the address is busy.
      if (error.code === 'EADDRINUSE') resolve();
      else reject(Object.assign(Error('agent_low_port_permission_denied'), {safeCode:'agent_low_port_permission_denied'}));
    });
    server.once('listening', () => server.close(resolve));
    server.listen(1023, '127.0.0.1');
  });
}

export async function checkDeploymentPermissions(options = {}) {
  const root = options.root ?? '/';
  const p = value => path.join(root, value);
  const config = p('/etc/lightmoni-agent/config.json');
  const info = fs.lstatSync(config);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail('agent_config_permission_invalid');
  fs.accessSync(config, fs.constants.R_OK);
  writableDirectory(p('/var/lib/lightmoni-agent'), true);
  writableDirectory(p('/var/lib/lightmoni-web'), false);
  await (options.lowPortCheck ?? lowPortPermission)();
  const socket = p('/var/run/docker.sock');
  try {
    const socketInfo = fs.statSync(socket);
    if (!socketInfo.isSocket()) fail('agent_docker_socket_invalid');
    fs.accessSync(socket, fs.constants.W_OK);
  } catch (error) {
    if (error.code === 'ENOENT') return 'docker_daemon_pending';
    if (error.code === 'EACCES') fail('agent_docker_permission_denied');
    throw error;
  }
  const result = (options.dockerCommand ?? spawnSync)('docker', ['--context','default','version','--format','{{.Server.Version}}'], {
    encoding:'utf8', timeout:8000, maxBuffer:16384,
    env:{PATH:process.env.PATH, HOME:process.env.HOME, LANG:'C', LC_ALL:'C'},
  });
  if (result.error?.code === 'ENOENT') return 'docker_cli_pending';
  if (/permission denied|access is denied/i.test(result.stderr ?? '')) fail('agent_docker_permission_denied');
  return result.status === 0 ? 'deployment_permissions_ready' : 'docker_daemon_pending';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare' && process.getuid?.() === 0) prepareDeploymentPermissions();
    else if (process.argv[2] === 'check' && process.getuid?.() !== 0) console.log(await checkDeploymentPermissions());
    else fail('agent_permission_check_invalid_invocation');
  } catch (error) {
    console.error(typeof error.safeCode === 'string' ? error.safeCode : 'agent_deployment_permission_check_failed');
    process.exitCode = 1;
  }
}
