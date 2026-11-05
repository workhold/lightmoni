import * as fs from 'node:fs';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const base='/qa-recovery',runner=process.argv[2];
// This manual fault-injection harness must never run on a managed host.
if(process.platform!=='linux'||process.getuid?.()!==0||!fs.existsSync('/etc/lightmoni094-disposable-vm'))
 throw Error('Run only as root inside the dedicated disposable SDD094 Linux VM');
if(!runner||!runner.startsWith('/')||!fs.statSync(runner).isFile())throw Error('Pass an absolute maintenance runner path');
fs.mkdirSync(base,{recursive:true,mode:0o700});fs.chmodSync(base,0o700);
const {AgentMaintenance}=await import(pathToFileURL(runner).href);
const maintenance=new AgentMaintenance();
// Only private operation files are mapped to this test-owned directory.
// systemctl, /proc and /sys/fs/cgroup use the real production implementation.
maintenance.opDir=id=>{if(!/^[a-f0-9]{32}$/.test(id))throw Error('invalid fixture id');return base+'/operations/'+id;};
const report={schema:1,runner_sha256:createHash('sha256').update(fs.readFileSync(runner)).digest('hex'),platform:process.platform,node:process.version,
 fixture_boundary:'Dummy worker, no Agent or credentials; only opDir is mapped to /qa-recovery. Production systemctl, /proc, cgroup and exitEvidenceScript are unmodified.',checks:[],observations:[],limitations:['No real Agent deployment, release switch, restore or whole-platform integration is claimed by these unit-liveness and exit-evidence tests.']};
const check=(name,passed,detail={})=>{report.checks.push({name,passed,...detail});if(!passed)process.stderr.write('FAILED '+name+'\n');};
const id=()=> '94'+randomBytes(15).toString('hex');
const unit=value=>'lightmoni-agent-update-'+value+'.service';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=(file,args,options={})=>{const result=spawnSync(file,args,{encoding:'utf8',timeout:20000,...options});if(result.error)throw result.error;if(result.status!==0)throw Error(file+' '+args[0]+' failed '+result.status+': '+result.stderr.trim());return result.stdout.trim();};
const show=value=>Object.fromEntries(run('systemctl',['show',unit(value),'--property=LoadState,ActiveState,MainPID,ControlPID,ControlGroup,Job,Result,ExecMainCode,ExecMainStatus,MemoryPeak']).split('\n').map(line=>{const p=line.indexOf('=');return [line.slice(0,p),line.slice(p+1)];}));
const stopped=value=>{try{maintenance.assertWorkerStopped(value);return {allowed:true};}catch(error){return {allowed:false,code:error.safeCode??'command_error',message:String(error.message).slice(0,180)};}};
const units=[],groups=[],children=[];
const prepare=value=>{const directory=maintenance.opDir(value);fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.writeFileSync(directory+'/exit-evidence.sh',maintenance.exitEvidenceScript(value),{mode:0o700});return directory;};
const start=(value,command,extra=[])=>{const directory=prepare(value);units.push(unit(value));run('systemd-run',['--quiet','--no-block','--collect','--unit='+unit(value),'--property=Type=exec','--property=UMask=0077','--property=StandardOutput=null','--property=StandardError=null','--property=ExecStopPost=/bin/sh '+directory+'/exit-evidence.sh','--property=MemoryHigh=384M','--property=MemoryMax=512M','--property=MemorySwapMax=0','--property=CPUQuota=50%','--property=TasksMax=64',...extra,...command]);return directory;};
async function until(callback,ms=10000){const deadline=Date.now()+ms;while(Date.now()<deadline){const result=callback();if(result)return result;await sleep(50);}throw Error('fixture wait timed out');}
fs.writeFileSync(base+'/dummy-worker.mjs',"globalThis.memory=Buffer.alloc(16*1024*1024,1);setInterval(()=>{},1000);\n",{mode:0o600});
try{
 const absent=id(),absentResult=stopped(absent);check('collected/not-found unit with no cgroup and no worker is allowed',absentResult.allowed,{result:absentResult,unit_state:show(absent)});

 const loaded=id(),loadedFile='/run/systemd/system/'+unit(loaded);fs.writeFileSync(loadedFile,'[Unit]\nDescription=LightMoni isolated liveness fixture\n[Service]\nType=oneshot\nExecStart=/bin/true\n');units.push(unit(loaded));run('systemctl',['daemon-reload']);
 check('loaded inactive real unit is allowed',stopped(loaded).allowed,{result:stopped(loaded),unit_state:show(loaded)});

 const cg=id(),cgPath='/sys/fs/cgroup/system.slice/'+unit(cg);fs.mkdirSync(cgPath);groups.push(cgPath);
 const empty={events:fs.readFileSync(cgPath+'/cgroup.events','utf8').trim(),procs:fs.readFileSync(cgPath+'/cgroup.procs','utf8').trim(),result:stopped(cg)};
 check('real residual empty cgroup is allowed',empty.result.allowed,{observation:empty});
 const sleeper=spawn('/bin/sleep',['60'],{stdio:'ignore'});children.push(sleeper);await sleep(50);fs.writeFileSync(cgPath+'/cgroup.procs',String(sleeper.pid));
 const populated={events:fs.readFileSync(cgPath+'/cgroup.events','utf8').trim(),procs:fs.readFileSync(cgPath+'/cgroup.procs','utf8').trim(),result:stopped(cg)};
 check('real populated cgroup rejects even when the unit is collected',!populated.result.allowed&&populated.result.code==='recovery_worker_running',{observation:populated});sleeper.kill('SIGKILL');await until(()=>!fs.readFileSync(cgPath+'/cgroup.procs','utf8').trim());
 check('drained real cgroup is allowed again',stopped(cg).allowed,{result:stopped(cg)});

 const escaped=id(),worker=spawn('/qa/node',[base+'/dummy-worker.mjs','worker',escaped],{stdio:'ignore'});children.push(worker);await sleep(100);
 const procResult=stopped(escaped);check('real /proc worker marker rejects a collected unit with no corresponding cgroup',!procResult.allowed&&procResult.code==='recovery_worker_running',{result:procResult});worker.kill('SIGKILL');await until(()=>!fs.existsSync('/proc/'+worker.pid));
 check('exited /proc worker is allowed again',stopped(escaped).allowed,{result:stopped(escaped)});

 for(const kind of ['sigterm','timeout','sigkill','exit7','success']){
  const value=id(),command=kind==='exit7'?['/bin/sh','-c','exit 7']:kind==='success'?['/bin/true']:['/qa/node',base+'/dummy-worker.mjs','worker',value];
  const directory=start(value,command,kind==='timeout'?['--property=RuntimeMaxSec=1s']:['--property=RuntimeMaxSec=15s']);
  if(!['exit7','success'].includes(kind)){
   await until(()=>show(value).ActiveState==='active');const running=stopped(value);
   check(kind+' running real systemd unit rejects recovery',!running.allowed&&running.code==='recovery_worker_running',{result:running,unit_state:show(value)});
   await sleep(150);
   if(kind==='sigterm')run('systemctl',['kill','--kill-whom=main','--signal=SIGTERM',unit(value)]);
   if(kind==='sigkill')run('systemctl',['kill','--kill-whom=main','--signal=SIGKILL',unit(value)]);
  }
  await until(()=>fs.existsSync(directory+'/unit-exit.json'));
  const raw=fs.readFileSync(directory+'/unit-exit.json','utf8');let evidence;try{evidence=JSON.parse(raw);}catch(error){check(kind+' ExecStopPost JSON is valid',false,{raw});continue;}
  const expected=kind==='sigterm'?15:kind==='timeout'?15:kind==='sigkill'?9:kind==='exit7'?7:0;
  check(kind+' ExecStopPost exit evidence',evidence.schema===1&&evidence.exit_status===expected&&evidence.exit_code===(['exit7','success'].includes(kind)?'exited':'killed'),{evidence});
  check(kind+' ExecStopPost real memory.peak is a positive integer',Number.isSafeInteger(evidence.memory_peak_bytes)&&evidence.memory_peak_bytes>0,{evidence});
  if(kind==='timeout')check('RuntimeMaxSec is recorded as timeout',evidence.result==='timeout',{evidence});
  await until(()=>!['active','activating','deactivating'].includes(show(value).ActiveState));
  const final=stopped(value);check(kind+' stopped/collected unit permits recovery',final.allowed,{result:final,unit_state:show(value)});
  report.observations.push({kind,unit_id:value,raw_exit:raw,unit_state:show(value)});
 }
 const oom=id(),oomDirectory=prepare(oom),sentinel=JSON.stringify({fixture:true,status:'preparing',note:'not a real Agent operation'})+'\n';
 fs.writeFileSync(oomDirectory+'/status.json',sentinel,{mode:0o600});
 const fence=oomDirectory+'/fixture-lifecycle.lock';fs.mkdirSync(fence,{mode:0o700});fs.writeFileSync(fence+'/owner.json',JSON.stringify({fixture:true,operation_id:oom}),{mode:0o600});
 const owner=fs.readFileSync(fence+'/owner.json');
 fs.writeFileSync(base+'/oom-worker.mjs',"setTimeout(()=>{globalThis.memory=Buffer.alloc(256*1024*1024,1);},700);setInterval(()=>{},1000);\n",{mode:0o600});
 start(oom,['/qa/node',base+'/oom-worker.mjs','worker',oom],['--property=MemoryHigh=infinity','--property=MemoryMax=64M','--property=MemorySwapMax=0','--property=RuntimeMaxSec=30s']);
 await until(()=>show(oom).ActiveState==='active');
 const oomGroup='/sys/fs/cgroup/system.slice/'+unit(oom),limits={max:fs.readFileSync(oomGroup+'/memory.max','utf8').trim(),swap:fs.readFileSync(oomGroup+'/memory.swap.max','utf8').trim()};
 check('OOM fixture is restricted to its own real 64 MiB cgroup with swap disabled',limits.max===String(64*1024*1024)&&limits.swap==='0',{limits});
 await until(()=>fs.existsSync(oomDirectory+'/unit-exit.json'),20000);
 const oomRaw=fs.readFileSync(oomDirectory+'/unit-exit.json','utf8'),oomEvidence=JSON.parse(oomRaw);
 check('real cgroup OOM ExecStopPost records oom-kill killed9',oomEvidence.schema===1&&oomEvidence.result==='oom-kill'&&oomEvidence.exit_code==='killed'&&oomEvidence.exit_status===9,{evidence:oomEvidence});
 check('real cgroup OOM retains a positive MemoryPeak near its configured limit',Number.isSafeInteger(oomEvidence.memory_peak_bytes)&&oomEvidence.memory_peak_bytes>=48*1024*1024&&oomEvidence.memory_peak_bytes<=80*1024*1024,{evidence:oomEvidence});
 check('OOM exit evidence never changes the fixture status receipt',fs.readFileSync(oomDirectory+'/status.json','utf8')===sentinel);
 check('OOM exit evidence never removes the fixture lifecycle fence',fs.existsSync(fence)&&fs.readFileSync(fence+'/owner.json').equals(owner));
 await until(()=>!['active','activating','deactivating'].includes(show(oom).ActiveState));
 check('real cgroup OOM stopped unit allows liveness verification',stopped(oom).allowed,{result:stopped(oom),unit_state:show(oom)});
 report.observations.push({kind:'cgroup_oom_64MiB',unit_id:oom,allocation_bytes:256*1024*1024,limits,raw_exit:oomRaw,unit_state:show(oom),status_and_fence:'Private dummy fixture sentinels unchanged; no real Agent status/lock was created.'});

}catch(error){report.error={name:error.name,message:String(error.message),stack:String(error.stack)};}finally{
 for(const child of children){try{child.kill('SIGKILL');}catch{}}
 for(const name of units){spawnSync('systemctl',['stop',name],{stdio:'ignore',timeout:10000});spawnSync('systemctl',['reset-failed',name],{stdio:'ignore',timeout:10000});const file='/run/systemd/system/'+name;if(fs.existsSync(file))fs.unlinkSync(file);}
 for(const group of groups){try{if(!fs.readFileSync(group+'/cgroup.procs','utf8').trim())fs.rmdirSync(group);}catch{}}
 spawnSync('systemctl',['daemon-reload'],{stdio:'ignore',timeout:10000});
 report.completed_at=new Date().toISOString();report.passed=report.checks.filter(x=>x.passed).length;report.failed=report.checks.filter(x=>!x.passed).length;
 fs.writeFileSync(base+'/report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
