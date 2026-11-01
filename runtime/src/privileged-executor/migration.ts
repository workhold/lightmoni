import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertRoot,rootPath,secureDirectory,durableWrite,boundedFile,refuse,sha256} from './security.js';
import {loadConfig,EXECUTOR_CONFIG} from './config.js';
import {executorStatus} from './status.js';

export const LEGACY_DATA='/var/lib/lightmoni-agent',MANAGED_DATA='/var/lib/lightmoni-managed';
const publicPath=(data:string)=>'/var/lib/lightmoni-web/'+sha256(data).slice(0,20);
const OLD_PUBLIC=publicPath(LEGACY_DATA),NEW_PUBLIC=publicPath(MANAGED_DATA);
const systemctl='/usr/bin/systemctl';
function inactive(unit:string){try{execFileSync(systemctl,['is-active','--quiet',unit],{stdio:'ignore'});refuse('migration_stop_services_first');}catch(error){if(![3,4].includes((error as any).status))throw error;}}
function offline(){
 inactive('lightmoni-agent.service');inactive('lightmoni-executor.service');
 const status=executorStatus(loadConfig(EXECUTOR_CONFIG));if(status.fenced||status.pending_results)refuse('executor_has_unresolved_local_state');
 if(fs.existsSync(join(LEGACY_DATA,'operations/execution.lock')))refuse('migration_unresolved_legacy_execution');
 const processes=execFileSync('/usr/bin/ps',['-eo','args='],{encoding:'utf8'}).split('\n');
 if(processes.some(p=>p.startsWith('nginx: master process ')&&p.includes(LEGACY_DATA+'/operations/websites')))refuse('migration_stop_legacy_gateway_first');
 const socket='/var/run/docker.sock';if(fs.existsSync(socket)){
  const binary=['/usr/local/bin/docker','/usr/bin/docker'].find(p=>fs.existsSync(p));if(!binary)return refuse('migration_docker_inspection_required');rootPath(fs.realpathSync(binary));
  const args=['--host=unix:///var/run/docker.sock'],ids=execFileSync(binary,[...args,'ps','--quiet','--no-trunc'],{encoding:'utf8',timeout:15000}).trim().split('\n').filter(Boolean);
  for(let n=0;n<ids.length;n+=100){const containers=JSON.parse(execFileSync(binary,[...args,'inspect',...ids.slice(n,n+100)],{encoding:'utf8',maxBuffer:16<<20,timeout:15000}));
   if(containers.some((c:any)=>(c.Mounts??[]).some((m:any)=>[LEGACY_DATA,OLD_PUBLIC].some(base=>m.Source===base||m.Source?.startsWith(base+'/')))))refuse('migration_stop_legacy_containers_first');}
 }
}
/** A legacy directory never becomes privileged authority merely because an
 * ordinary credential queued another deploy. Only the separate root review
 * command below can adopt its frozen bytes. */
export function assertLegacyMigration(domain:string){
 if(!['platform','websites','certificates','compose','backups'].includes(domain))return;
 const path=join(LEGACY_DATA,'operations',domain);
 if(fs.existsSync(path)&&!fs.existsSync(join(MANAGED_DATA,'migration-receipt.json')))refuse('legacy_managed_state_requires_review');
}
type Entry={path:string;sha256:string;size:number;mode:number;uid:number;gid:number};
function control(path:string){return /^(platform|compose|websites|certificates)\//.test(path)&&/\.(json|conf)$/.test(path)&&!/^platform\/workloads\/[^/]+\/(data|initial|config)\//.test(path);}
function rewrite(bytes:Buffer){return Buffer.from(bytes.toString('utf8').replaceAll(OLD_PUBLIC,NEW_PUBLIC).replaceAll(LEGACY_DATA,MANAGED_DATA));}
function copyTree(source:string,destination:string,publicFiles:boolean,entries:Entry[],prefix=''){
 let count=0,total=0;
 const walk=(path:string,target:string,relative:string)=>{
  const stat=fs.lstatSync(path);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||stat.isFile()&&stat.nlink!==1)refuse('migration_unsupported_file');
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(stat.isDirectory()?fs.constants.O_DIRECTORY:0));
  try{
   const before=fs.fstatSync(fd);if(before.ino!==stat.ino||before.dev!==stat.dev)refuse('migration_source_changed');
   if(++count>200000)refuse('migration_file_limit');
   if(stat.isDirectory()){
    fs.mkdirSync(target,{mode:0o700});for(const name of fs.readdirSync('/proc/self/fd/'+fd).sort()){
     if(name==='nginx.pid'||name==='execution.lock'||name.endsWith('.tmp'))refuse('migration_remove_stale_runtime_files_after_review');
     walk('/proc/self/fd/'+fd+'/'+name,join(target,name),relative?relative+'/'+name:name);
    }
    // Application data keeps its numeric ownership. Control and public paths
    // are root-owned, and parent directories remain private.
    const data=/(^|\/)workloads\/[^/]+\/(data|initial)(\/|$)/.test(relative);
    fs.chownSync(target,data?stat.uid:0,data?stat.gid:0);fs.chmodSync(target,publicFiles?0o755:data?stat.mode&0o777:0o700);
   }else{
    total+=stat.size;if(total>512*1024*1024)refuse('migration_size_limit');
    const original=fs.readFileSync(fd),isControl=publicFiles?relative==='.lightmoni-web-owner.json':control(relative),bytes=isControl?rewrite(original):original;
    const data=/(^|\/)workloads\/[^/]+\/(data|initial)(\/|$)/.test(relative);
    const mode=publicFiles?0o644:data?stat.mode&0o777:0o600;
    const out=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);
    try{fs.writeFileSync(out,bytes);fs.fchownSync(out,data?stat.uid:0,data?stat.gid:0);fs.fchmodSync(out,mode);fs.fsyncSync(out);}finally{fs.closeSync(out);}
    entries.push({path:(prefix?prefix+'/':'')+relative,sha256:sha256(bytes),size:bytes.length,mode,uid:data?stat.uid:0,gid:data?stat.gid:0});
   }
   const after=fs.fstatSync(fd);if(before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==after.size)refuse('migration_source_changed');
  }finally{fs.closeSync(fd);}
 };
 walk(source,destination,'');
}
function emptyTarget(path:string){
 if(!fs.existsSync(path))return;rootPath(path,'directory');
 for(const name of fs.readdirSync(path)){
  const child=join(path,name),stat=fs.lstatSync(child);
  if(stat.isDirectory()&&!stat.isSymbolicLink())emptyTarget(child);
  else if(name==='.lightmoni-owner.json'||name==='.lightmoni-web-owner.json'){
   const marker=JSON.parse(boundedFile(child,4096).toString());
   if(marker.version!==1||(name==='.lightmoni-owner.json'?marker.root!==MANAGED_DATA||marker.domain!==path.split('/').at(-1):marker.dataDir!==MANAGED_DATA))refuse('migration_target_not_empty');
  }else refuse('migration_target_not_empty');
 }
}
function sync(path:string){const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function migrationCommand(args:string[]):Record<string,unknown>{
 assertRoot();offline();const config=loadConfig(EXECUTOR_CONFIG),base=join(config.data_dir,'migration-review');
 if(args[0]==='plan'&&args.length===1){
  if(fs.existsSync(base))refuse('migration_review_already_exists');secureDirectory(base);
  const entries:Entry[]=[];copyTree(join(LEGACY_DATA,'operations'),join(base,'operations'),false,entries,'operations');
  if(fs.existsSync(OLD_PUBLIC))copyTree(OLD_PUBLIC,join(base,'public'),true,entries,'public');
  const plan={version:1,executor_id:config.executor_id,install_generation:config.install_generation,source:LEGACY_DATA,target:MANAGED_DATA,created_at:new Date().toISOString(),entries};
  durableWrite(join(base,'plan.json'),JSON.stringify(plan));
  return{plan_sha256:sha256(JSON.stringify(plan)),review_directory:base,files:entries.length,warning:'Review every copied Compose/Nginx/state configuration as root intent. Applying explicitly trusts this snapshot; ordinary Agent credentials cannot approve it. Old files are retained. Keep all writers stopped until re-deploy and verification.'};
 }
 if(args[0]!=='apply'||args.length!==3||args[1]!=='--expected-plan-sha256'||!/^[a-f0-9]{64}$/.test(args[2]))refuse('invalid_migration_arguments');
 rootPath(base,'directory',true);const bytes=boundedFile(join(base,'plan.json'),32<<20,true);if(sha256(bytes)!==args[2])refuse('migration_plan_changed');const plan=JSON.parse(bytes.toString());
 if(plan.executor_id!==config.executor_id||plan.install_generation!==config.install_generation)refuse('migration_identity_changed');
 for(const e of plan.entries){if(typeof e.path!=='string'||!e.path.match(/^(operations|public)\//)||e.path.split('/').includes('..'))refuse('migration_plan_changed');const file=join(base,e.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==e.size||stat.uid!==e.uid||stat.gid!==e.gid||(stat.mode&0o777)!==e.mode)refuse('migration_snapshot_changed');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const hash=createHash('sha256');const chunk=Buffer.alloc(1<<20);let read;while((read=fs.readSync(fd,chunk)))hash.update(chunk.subarray(0,read));if(hash.digest('hex')!==e.sha256)refuse('migration_snapshot_changed');}finally{fs.closeSync(fd);}}
 secureDirectory(MANAGED_DATA);emptyTarget(join(MANAGED_DATA,'operations'));emptyTarget(NEW_PUBLIC);offline();
 let publicMoved=false;
 try{
  if(fs.existsSync(join(base,'public'))){rootPath(dirname(NEW_PUBLIC),'directory');if(fs.existsSync(NEW_PUBLIC))fs.renameSync(NEW_PUBLIC,join(base,'empty-public-before-migration'));fs.renameSync(join(base,'public'),NEW_PUBLIC);publicMoved=true;}
  if(fs.existsSync(join(MANAGED_DATA,'operations')))fs.renameSync(join(MANAGED_DATA,'operations'),join(base,'empty-operations-before-migration'));
  fs.renameSync(join(base,'operations'),join(MANAGED_DATA,'operations'));sync(MANAGED_DATA);
  durableWrite(join(MANAGED_DATA,'migration-receipt.json'),JSON.stringify({version:1,plan_sha256:args[2],executor_id:config.executor_id,applied_at:new Date().toISOString(),source_retained:true}));
 }catch(error){if(publicMoved&&!fs.existsSync(join(base,'public')))try{fs.renameSync(NEW_PUBLIC,join(base,'public'));}catch{}throw error;}
 return{migrated:true,source_retained:true,plan_sha256:args[2]};
}
