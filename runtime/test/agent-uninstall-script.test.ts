import {inlineFixtureCommands} from './helpers/maintenance-shell.js';
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import { agentMaintenanceShellGuards } from "../src/shared/agent-maintenance-shell.js";
import { rewriteMaintenancePaths, writeMaintenanceStatShim } from "./helpers/maintenance-shell.js";

/** Fixed destinations are rewritten; no host paths or real systemd are used. */
function fixture(t:any,installed=true){
 const root=mkdtempSync(join(tmpdir(),"lm-uninstall-task-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const p=(name:string)=>join(root,name),commands=p("commands"),calls=p("calls.json");
 for(const name of ["commands","run","etc/systemd/system","etc/lightmoni-agent","var/lib/lightmoni-agent","opt/lightmoni-agent","usr/local/bin","usr/local/sbin"])mkdirSync(p(name),{recursive:true});
 writeFileSync(p("etc/lightmoni-agent/config.json"),"fixture configuration");
 writeFileSync(p("var/lib/lightmoni-agent/identity.json"),'{"agent_id":"fixture-agent","host_id":"fixture-host"}');
 writeFileSync(p("var/lib/lightmoni-agent/queue.sqlite"),"retained accepted queue");
 if(installed){writeFileSync(p("etc/systemd/system/lightmoni-agent.service"),"fixture unit");writeFileSync(p("usr/local/bin/lightmoni-agent"),"fixture launcher");}
 writeFileSync(calls,"[]");
 writeFileSync(join(commands,"id"),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),marker=${JSON.stringify(p('var/lib/lightmoni-agent-task-account.json'))},task=fs.existsSync(marker),name=a.at(-1);if(name==='lightmoni-task'){if(!task)process.exit(1);console.log(a[0]==='-u'?'19997':a[0]==='-g'?'19996':a[0]==='-Gn'?'lightmoni-task':'lightmoni-task');}else if(a[0]==='-u')console.log(0);else console.log('root');\n`,{mode:0o755});
 writeFileSync(join(commands,"getent"),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),marker=${JSON.stringify(p('var/lib/lightmoni-agent-task-account.json'))};if(a[0]!=='group'||a[1]!=='lightmoni-task'||!fs.existsSync(marker))process.exit(2);console.log('lightmoni-task:x:'+JSON.parse(fs.readFileSync(marker)).gid+':');\n`,{mode:0o755});
 writeMaintenanceStatShim(commands);
 writeFileSync(join(commands,"systemctl"),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2),file=${JSON.stringify(calls)},calls=JSON.parse(fs.readFileSync(file));calls.push(args);fs.writeFileSync(file,JSON.stringify(calls));if(args[0]==='show'){const helper=args.includes('lightmoni-agent-helper.service'),unit=helper?'lightmoni-agent-helper.service':'lightmoni-agent.service',path=${JSON.stringify(p('etc/systemd/system'))}+'/'+unit,exists=fs.existsSync(path);process.stdout.write(args.includes('--property=LoadState')?(exists?'loaded':'not-found'):args.includes('--property=FragmentPath')?(exists?path:''):'inactive');process.stdout.write('\\n');}\n`,{mode:0o755});
 for(const command of ['userdel','groupdel'])writeFileSync(join(commands,command),`#!${process.execPath}\nconst fs=require('node:fs'),file=${JSON.stringify(calls)},calls=JSON.parse(fs.readFileSync(file));calls.push([${JSON.stringify(command)},...process.argv.slice(2)]);fs.writeFileSync(file,JSON.stringify(calls));\n`,{mode:0o755});
 const script=rewriteMaintenancePaths(readFileSync(new URL("../../deploy/agent/uninstall.sh",import.meta.url),"utf8"),root);
 const run=(purge=false)=>spawnSync("sh",["-c",inlineFixtureCommands(commands)+script,"uninstall.sh",...(purge?["--purge"]:[])],{encoding:"utf8",env:{...process.env,PATH:commands+":"+process.env.PATH}});
 return {p,run,calls:()=>JSON.parse(readFileSync(calls,"utf8")) as string[][]};
}

for(const marker of ["task-run-state.json","agent-job-state.json","operations/execution.lock"])for(const installed of [true,false])for(const purge of [false,true])test(`unfinished ${marker} blocks ${purge?"purge":"uninstall"} with ${installed?"inactive":"missing"} service`,t=>{
 const f=fixture(t,installed), markerPath=f.p("var/lib/lightmoni-agent/"+marker);
 if(marker.endsWith(".lock"))mkdirSync(markerPath,{recursive:true});
 else writeFileSync(markerPath,'{"id":"unfinished-execution","lease_token":"fixture-lease"}');
 const result=f.run(purge);
 assert.notEqual(result.status,0,"a persisted script execution must block removal");
 assert.match(result.stderr,/unfinished operation/);
 assert.equal(readFileSync(f.p("var/lib/lightmoni-agent/queue.sqlite"),"utf8"),"retained accepted queue");
 assert.equal(existsSync(f.p("etc/lightmoni-agent/config.json")),true);
 assert.equal(existsSync(markerPath),true);
 if(installed)assert.equal(existsSync(f.p("usr/local/bin/lightmoni-agent")),true);
 assert.ok(!f.calls().some(call=>["stop","disable","daemon-reload"].includes(call[0])),"no service mutation before a busy refusal");
 assert.equal(existsSync(f.p("run/lightmoni-agent-lifecycle.lock")),false);
});

test("standalone and platform maintenance guards are identical",()=>{
 const script=readFileSync(new URL("../../deploy/agent/uninstall.sh",import.meta.url),"utf8");
 assert.equal(script.split("# BEGIN SHARED MAINTENANCE GUARDS\n")[1].split("\n# END SHARED MAINTENANCE GUARDS")[0],agentMaintenanceShellGuards);
});

for(const contents of ['{"id":','{"id":" "}','{"id":null}','', '[]', '{"id":"","receipt":{"state":"unknown"}}','{\v}','{}\0'])test("uncertain task marker blocks removal: "+JSON.stringify(contents),t=>{
 const f=fixture(t);writeFileSync(f.p("var/lib/lightmoni-agent/task-run-state.json"),contents);
 const result=f.run(true);assert.notEqual(result.status,0);assert.match(result.stderr,/operation/);
 assert.ok(existsSync(f.p("usr/local/bin/lightmoni-agent")));assert.deepEqual(f.calls().filter(v=>v[0]==="stop"),[]);
});
for(const kind of ["directory","symlink","dangling","oversized"])test("unsafe task marker blocks removal: "+kind,t=>{
 const f=fixture(t),p=f.p("var/lib/lightmoni-agent/task-run-state.json");
 if(kind==="directory")mkdirSync(p);else if(kind==="oversized")writeFileSync(p," ".repeat(65537));else symlinkSync(f.p(kind==="dangling"?"absent":"var/lib/lightmoni-agent/queue.sqlite"),p);
 assert.notEqual(f.run().status,0);assert.ok(existsSync(f.p("usr/local/bin/lightmoni-agent")));
});
for(const path of ["opt","opt/lightmoni-agent","etc/lightmoni-agent","var/lib/lightmoni-agent","usr/local/sbin/lightmoni-agent-uninstall"])test("symbolic managed path is never followed: "+path,t=>{
 const f=fixture(t),outside=f.p("outside");mkdirSync(outside);writeFileSync(join(outside,"business-data"),"preserve");
 rmSync(f.p(path),{recursive:true,force:true});symlinkSync(outside,f.p(path));
 assert.notEqual(f.run(true).status,0);assert.equal(readFileSync(join(outside,"business-data"),"utf8"),"preserve");
 assert.deepEqual(f.calls(),[]);
});
test("writable program directories cannot be removed",t=>{
 const f=fixture(t);chmodSync(f.p("opt/lightmoni-agent"),0o777);
 assert.notEqual(f.run().status,0);assert.deepEqual(f.calls(),[]);
});
test("identity absence and partially removed programs allow offline cleanup; purge is explicit",t=>{
 const f=fixture(t,false);rmSync(f.p("var/lib/lightmoni-agent/identity.json"));
 {const r=f.run();assert.equal(r.status,0,r.stderr);assert.ok(existsSync(f.p("var/lib/lightmoni-agent/queue.sqlite")));}
 assert.equal(f.run(true).status,0);assert.equal(existsSync(f.p("etc/lightmoni-agent")),false);assert.equal(existsSync(f.p("var/lib/lightmoni-agent")),false);
 assert.equal(f.run(true).status,0);
});
test("a task marker arriving while stopping preserves programs before disable",t=>{
 const f=fixture(t),ctl=f.p("commands/systemctl");let source=readFileSync(ctl,"utf8");
 source=source.replace("if(args[0]==='show')",`if(args[0]==='stop')fs.writeFileSync(${JSON.stringify(f.p("var/lib/lightmoni-agent/task-run-state.json"))},'{"id":"late-task"}');if(args[0]==='show')`);
 writeFileSync(ctl,source,{mode:0o755});
 const result=f.run();assert.notEqual(result.status,0,result.stderr);assert.ok(existsSync(f.p("usr/local/bin/lightmoni-agent")));
 assert.ok(f.calls().some(v=>v[0]==="stop"));assert.ok(!f.calls().some(v=>["disable","daemon-reload"].includes(v[0])));
});

test("cleared script marker permits offline uninstall while accepted data is retained",t=>{
 const f=fixture(t);writeFileSync(f.p("var/lib/lightmoni-agent/task-run-state.json"),'{"id":""}');
 const result=f.run();assert.equal(result.status,0,result.stderr);
 assert.equal(existsSync(f.p("usr/local/bin/lightmoni-agent")),false);
 assert.equal(readFileSync(f.p("var/lib/lightmoni-agent/queue.sqlite"),"utf8"),"retained accepted queue");
});

test("full-management uninstall removes the Agent, privileged helper and managed task account while retaining application data",t=>{
 const f=fixture(t),p=f.p;
 mkdirSync(p('etc/lightmoni-agent-helper'),{recursive:true,mode:0o700});
 mkdirSync(p('var/lib/lightmoni-agent-helper/managed'),{recursive:true,mode:0o700});
 mkdirSync(p('var/lib/lightmoni-agent-helper/tasks'),{recursive:true,mode:0o711});
 writeFileSync(p('etc/systemd/system/lightmoni-agent-helper.service'),readFileSync(new URL('../../deploy/agent/lightmoni-agent-helper.service',import.meta.url)));
 writeFileSync(p('etc/lightmoni-agent-helper/helper.json'),'{}',{mode:0o600});
 writeFileSync(p('etc/lightmoni-agent-helper/managed.json'),'{}',{mode:0o600});
 writeFileSync(p('var/lib/lightmoni-agent-helper/managed/journal.json'),'{}',{mode:0o600});
 writeFileSync(p('var/lib/lightmoni-agent-task-account.json'),'{"schema":1,"uid":19997,"gid":19996}',{mode:0o600});
 writeFileSync(p('usr/local/bin/lightmoni-agent'),`#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='helper-status')console.log(JSON.stringify({fenced:null,pending_results:0,ordinary_task_runner:{active:false,state:'idle'}}));\n`,{mode:0o755});
 chmodSync(p('usr/local/bin/lightmoni-agent'),0o755);
 const result=f.run();assert.equal(result.status,0,result.stderr);
 for(const name of ['etc/systemd/system/lightmoni-agent.service','etc/systemd/system/lightmoni-agent-helper.service','usr/local/bin/lightmoni-agent','var/lib/lightmoni-agent-task-account.json','etc/lightmoni-agent-helper','var/lib/lightmoni-agent-helper','opt/lightmoni-agent'])assert.equal(existsSync(p(name)),false,name);
 assert.equal(readFileSync(p('var/lib/lightmoni-agent/queue.sqlite'),'utf8'),'retained accepted queue');
 assert(f.calls().some(v=>v[0]==='stop'&&v[1]==='lightmoni-agent.service'));
 assert(f.calls().some(v=>v[0]==='stop'&&v[1]==='lightmoni-agent-helper.service'));
 assert(f.calls().some(v=>v[0]==='userdel'&&v[1]==='lightmoni-task'));
 assert(f.calls().some(v=>v[0]==='groupdel'&&v[1]==='lightmoni-task'));
});
