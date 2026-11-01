import * as fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {boundedFile,durableWrite,rootPath,refuse,assertRoot} from './security.js';
import {loadConfig,EXECUTOR_CONFIG} from './config.js';
import {executorStatus} from './status.js';
import {parseStrictJSON} from '../shared/privileged-executor.js';
const BASE='/opt/lightmoni-executor',RELEASES=join(BASE,'releases'),CURRENT=join(BASE,'current'),PREVIOUS=join(BASE,'previous');
const controlFiles=[['executor/launcher.sh','/usr/local/bin/lightmoni-executor',0o755],['executor/uninstall.sh','/usr/local/sbin/lightmoni-executor-uninstall',0o755],['executor/lightmoni-executor.service','/etc/systemd/system/lightmoni-executor.service',0o644]] as const;
const command=(...args:string[])=>execFileSync('/usr/bin/systemctl',args,{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:'ignore',timeout:15000});
const active=()=>{try{command('is-active','--quiet','lightmoni-executor.service');return true;}catch{return false;}};
function tree(path:string,base=path):void {
 const stat=fs.lstatSync(path);if(stat.uid!==0)refuse('unsafe_executor_release');
 if(stat.isSymbolicLink()){if(!fs.realpathSync(path).startsWith(base+'/'))refuse('unsafe_executor_release');return;}
 if(stat.mode&0o022)refuse('unsafe_executor_release');
 if(stat.isDirectory())for(const entry of fs.readdirSync(path))tree(join(path,entry),base);
 else if(!stat.isFile())refuse('unsafe_executor_release');
}
function linkTarget(link:string,required=true):string|undefined {
 rootPath(dirname(link),'directory',true);
 try{const stat=fs.lstatSync(link);if(!stat.isSymbolicLink()||stat.uid!==0)refuse('unsafe_executor_pointer');const target=resolve(dirname(link),fs.readlinkSync(link));if(dirname(target)!==RELEASES||!/^[A-Za-z0-9._-]{1,128}$/.test(target.slice(RELEASES.length+1)))refuse('unsafe_executor_pointer');rootPath(target,'directory');return target;}
 catch(error){if(!required&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
function metadata(directory:string) {
 rootPath(directory,'directory');const release=parseStrictJSON(boundedFile(join(directory,'release.json'),8192)),receipt=parseStrictJSON(boundedFile(join(directory,'installation.json'),8192));
 if(!/^[A-Za-z0-9._-]{1,128}$/.test(release.build_id??'')||release.state_schema!==1||release.platform!=='linux'||!['amd64','arm64'].includes(release.arch)||!/^[a-f0-9]{40}$/.test(release.source_revision??'')||receipt.schema!==1||!/^[a-f0-9]{64}$/.test(receipt.artifact_sha256??''))refuse('invalid_executor_release');
 return{version:release.version,build_id:release.build_id,source_revision:release.source_revision,arch:release.arch,state_schema:1,artifact_sha256:receipt.artifact_sha256};
}
export function retainedExecutorReleases(){assertRoot();const current=linkTarget(CURRENT)!,previous=linkTarget(PREVIOUS,false);return{current:metadata(current),previous:previous?metadata(previous):null};}
function atomicLink(target:string,path:string){const temp=path+'.new-'+process.pid;try{fs.symlinkSync(target,temp);fs.renameSync(temp,path);const fd=fs.openSync(BASE,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}finally{try{fs.unlinkSync(temp);}catch{}}}
function publishControls(directory:string){for(const [source,destination,mode] of controlFiles){rootPath(dirname(destination),'directory');if(fs.existsSync(destination))rootPath(destination);durableWrite(destination,boundedFile(join(directory,source),65536),mode);}}
/** Fixed subprocess entry, invoked while the stopped executor writer is held
 * by flock. It never starts a worker until that lock has been released. */
export function switchExecutorProgram(args:string[]){
 assertRoot();if(process.env.LIGHTMONI_EXECUTOR_UPGRADE_LOCK!=='held'||args.length!==10)refuse('executor_upgrade_lock_required');
 const [target,id,generation,oldSHA,newSHA,activation,oldBuild,newBuild,oldSource,newSource]=args;
 if(dirname(target)!==RELEASES||!/^[a-f0-9-]{36}$/.test(activation))refuse('invalid_executor_upgrade_arguments');tree(target);
 const current=metadata(linkTarget(CURRENT)!),next=metadata(target),config=loadConfig(EXECUTOR_CONFIG),status=executorStatus(config);
 if(active()||status.fenced||status.pending_results||config.executor_id!==id||String(config.install_generation)!==generation||current.artifact_sha256!==oldSHA||next.artifact_sha256!==newSHA||current.build_id!==oldBuild||next.build_id!==newBuild||current.source_revision!==oldSource||next.source_revision!==newSource)refuse('executor_state_changed_while_stopping');
 atomicLink(target,CURRENT);publishControls(target);
 durableWrite(join(config.data_dir,'activation.json'),JSON.stringify({id:activation,executor_id:id,install_generation:config.install_generation,artifact_sha256:newSHA,stage:'ready'}));
}
/** Called only by the fixed upgrade shell while its kernel lifecycle lock is
 * held. No identity, journal, policy or business-data snapshot is ever restored. */
export function upgradeExecutor(args:string[]):void {
 assertRoot();if(process.env.LIGHTMONI_EXECUTOR_UPGRADE_LOCK!=='held')refuse('executor_upgrade_lock_required');
 const values:Record<string,string>={};for(let n=0;n<args.length;n+=2){const key=args[n],value=args[n+1];if(!['--action','--expected-executor-id','--expected-install-generation','--expected-current-sha','--target-sha','--activation-id'].includes(key)||values[key]!==undefined||!value)refuse('invalid_executor_upgrade_arguments');values[key]=value;}
 if(!['upgrade','rollback'].includes(values['--action'])||!/^[a-f0-9]{64}$/.test(values['--target-sha']??'')||!/^[a-f0-9]{64}$/.test(values['--expected-current-sha']??'')||!/^[a-f0-9-]{36}$/.test(values['--activation-id']??''))refuse('invalid_executor_upgrade_arguments');
 const config=loadConfig(EXECUTOR_CONFIG),status=executorStatus(config);
 if(status.executor_id!==values['--expected-executor-id']||String(status.install_generation)!==values['--expected-install-generation']||status.fenced||status.pending_results)refuse('executor_has_unresolved_local_state');
 const old=linkTarget(CURRENT)!,oldMetadata=metadata(old),prior=linkTarget(PREVIOUS,false);
 if(oldMetadata.artifact_sha256!==values['--expected-current-sha'])refuse('executor_current_release_changed');
 if(fs.existsSync('/etc/systemd/system/lightmoni-executor.service.d')||fs.existsSync('/run/systemd/system/lightmoni-executor.service.d'))refuse('executor_custom_unit_requires_review');
 for(const [source,destination] of controlFiles)if(!boundedFile(destination,65536).equals(boundedFile(join(old,source),65536)))refuse('executor_controls_changed');
 const source=resolve(fileURLToPath(new URL('../../../../',import.meta.url)));tree(source);const next=metadata(source);
 if(next.artifact_sha256!==values['--target-sha']||next.arch!==oldMetadata.arch||next.build_id===oldMetadata.build_id)refuse('executor_target_release_mismatch');
 if(values['--action']==='rollback'&&(!prior||metadata(prior).artifact_sha256!==next.artifact_sha256))refuse('executor_rollback_target_changed');
 const target=join(RELEASES,next.build_id),wasActive=active(),activationPath=join(config.data_dir,'activation.json'),oldActivation=fs.existsSync(activationPath)?boundedFile(activationPath,4096,true):undefined;
 if(fs.existsSync(target)){tree(target);if(metadata(target).artifact_sha256!==next.artifact_sha256)refuse('executor_release_conflict');}
 else{fs.cpSync(source,target,{recursive:true,dereference:false,verbatimSymlinks:true,force:false,errorOnExist:true});tree(target);}
 let switched=false;
 try{
   command('stop','lightmoni-executor.service');
   const stopped=executorStatus(loadConfig(EXECUTOR_CONFIG));if(stopped.fenced||stopped.pending_results||stopped.executor_id!==status.executor_id||stopped.install_generation!==status.install_generation)refuse('executor_state_changed_while_stopping');
   if(active())refuse('executor_stop_not_verified');
   const writer=join(config.data_dir,'writer.lock');rootPath(writer,'file',true);rootPath('/usr/bin/flock');switched=true;
   execFileSync('/usr/bin/flock',['--exclusive','--nonblock',writer,join(target,'node'),join(target,'app/runtime/dist/privileged-executor/main.js'),'upgrade-switch',target,config.executor_id,String(config.install_generation),oldMetadata.artifact_sha256,next.artifact_sha256,values['--activation-id'],oldMetadata.build_id,next.build_id,oldMetadata.source_revision,next.source_revision],{env:{PATH:'/usr/bin:/bin',LANG:'C',LIGHTMONI_EXECUTOR_UPGRADE_LOCK:'held'},stdio:'ignore',timeout:60000});
   command('daemon-reload');command('start','lightmoni-executor.service');
   let good=0;for(let n=0;n<15;n++){good=active()?good+1:0;if(good>=3)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);}if(good<3)refuse('executor_new_service_unavailable');
   const after=executorStatus(loadConfig(EXECUTOR_CONFIG));if(after.executor_id!==status.executor_id||after.install_generation!==status.install_generation||after.policy_generation<status.policy_generation)refuse('executor_identity_or_policy_changed');
   durableWrite(activationPath,JSON.stringify({id:values['--activation-id'],executor_id:config.executor_id,install_generation:config.install_generation,artifact_sha256:next.artifact_sha256,stage:'started'}));
   atomicLink(old,PREVIOUS);process.stdout.write('executor_upgrade=ready\n');
 }catch{
   if(switched){try{command('stop','lightmoni-executor.service');atomicLink(old,CURRENT);publishControls(old);if(oldActivation)durableWrite(activationPath,oldActivation);else if(fs.existsSync(activationPath))fs.unlinkSync(activationPath);command('daemon-reload');if(wasActive)command('start','lightmoni-executor.service');}catch{refuse('executor_update_restore_unknown');}}
   refuse('executor_update_failed_restored');
 }
}
