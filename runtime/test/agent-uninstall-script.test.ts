import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

/** Fixed destinations are rewritten; no host paths or real systemd are used. */
function fixture(t:any,installed=true){
 const root=mkdtempSync(join(tmpdir(),"lm-uninstall-task-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const p=(name:string)=>join(root,name),commands=p("commands"),calls=p("calls.json");
 for(const name of ["commands","run","etc/systemd/system","etc/lightmoni-agent","var/lib/lightmoni-agent","opt/lightmoni-agent","usr/local/bin"])mkdirSync(p(name),{recursive:true});
 writeFileSync(p("etc/lightmoni-agent/config.json"),"fixture configuration");
 writeFileSync(p("var/lib/lightmoni-agent/identity.json"),'{"agent_id":"fixture-agent","host_id":"fixture-host"}');
 writeFileSync(p("var/lib/lightmoni-agent/queue.sqlite"),"retained accepted queue");
 if(installed){writeFileSync(p("etc/systemd/system/lightmoni-agent.service"),"fixture unit");writeFileSync(p("usr/local/bin/lightmoni-agent"),"fixture launcher");}
 writeFileSync(calls,"[]");
 writeFileSync(join(commands,"id"),"#!/bin/sh\necho 0\n",{mode:0o755});
 writeFileSync(join(commands,"systemctl"),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2),file=${JSON.stringify(calls)},calls=JSON.parse(fs.readFileSync(file));calls.push(args);fs.writeFileSync(file,JSON.stringify(calls));if(args[0]==='show'){const exists=fs.existsSync(${JSON.stringify(p("etc/systemd/system/lightmoni-agent.service"))});process.stdout.write(args.includes('--property=LoadState')?(exists?'loaded':'not-found'):args.includes('--property=FragmentPath')?(exists?${JSON.stringify(p("etc/systemd/system/lightmoni-agent.service"))}:''):'inactive');process.stdout.write('\\n');}\n`,{mode:0o755});
 let script=readFileSync(new URL("../../deploy/agent/uninstall.sh",import.meta.url),"utf8");
 for(const absolute of ["/run/lightmoni-agent-lifecycle.lock","/etc/lightmoni-agent","/var/lib/lightmoni-agent","/opt/lightmoni-agent","/etc/systemd/system/lightmoni-agent.service","/usr/local/bin/lightmoni-agent"])script=script.replaceAll(absolute,p(absolute.slice(1)));
 const run=(purge=false)=>spawnSync("sh",["-c",script,"uninstall.sh",...(purge?["--purge"]:[])],{encoding:"utf8",env:{...process.env,PATH:commands+":"+process.env.PATH}});
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

test("cleared script marker permits offline uninstall while accepted data is retained",t=>{
 const f=fixture(t);writeFileSync(f.p("var/lib/lightmoni-agent/task-run-state.json"),'{"id":""}');
 const result=f.run();assert.equal(result.status,0,result.stderr);
 assert.equal(existsSync(f.p("usr/local/bin/lightmoni-agent")),false);
 assert.equal(readFileSync(f.p("var/lib/lightmoni-agent/queue.sqlite"),"utf8"),"retained accepted queue");
});
