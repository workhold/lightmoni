import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {boundedFile,durableWrite,rootPath,refuse,sha256} from './security.js';
import type {OperationExecutionContext} from '../operations/types.js';
/** A published gateway is persistent business intent, independent of the
 * short-lived authorizing job and executor identity. Its files stay root-owned. */
export async function startManagedGateway(dataRoot:string,nginx:string,args:string[],command:OperationExecutionContext['command'],systemctl:string,signal:AbortSignal) {
 const root=join(dataRoot,'operations','websites');
 if(args.length!==4||args[0]!=='-p'||args[1]!==root+'/'||args[2]!=='-c'||args[3]!==join(root,'nginx.conf'))refuse('managed_gateway_scope_mismatch');
 rootPath(join(root,'nginx.conf'));
 const unit='lightmoni-managed-web-'+sha256(dataRoot).slice(0,20)+'.service',filename=join('/etc/systemd/system',unit);
 const text=[
  '[Unit]','Description=LightMoni managed website gateway','After=network.target',
  '[Service]','Type=forking','User=root','Group=root','UMask=0077',
  'PIDFile='+join(root,'nginx.pid'),
  'ExecStart='+nginx+' -p '+root+'/ -c '+join(root,'nginx.conf'),
  'Restart=on-failure','RestartSec=5','NoNewPrivileges=true','LimitCORE=0',
  '[Install]','WantedBy=multi-user.target','',
 ].join('\n');
 rootPath('/etc/systemd/system','directory');
 if(existsSync(filename)) {
   if(boundedFile(filename,65536).toString()!==text)refuse('managed_gateway_unit_changed');
 }else durableWrite(filename,text,0o644);
 await command(systemctl,['daemon-reload'],{signal,timeoutMs:15000});
 await command(systemctl,['enable',unit],{signal,timeoutMs:15000});
 return command(systemctl,['start',unit],{signal,timeoutMs:20000});
}
