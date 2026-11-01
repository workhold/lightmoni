import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {executorBootstrapAbsentCommand} from '../src/server/machine-executor-bootstrap.js';
import {inlineFixtureCommands} from './helpers/maintenance-shell.js';

/** Execute the exported fixed shell against isolated paths. Only UID, flock and
 * systemd replies are simulated; directory types, modes and symlinks are real.
 * These tests do not claim to verify Linux root ownership or native flock. */
function fixture(t:TestContext){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lm-executor-bootstrap-probe-'))),p=(path:string)=>join(root,path),bin=p('fakebin'),history=p('history.json');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const path of ['fakebin','run/systemd/system','opt','etc/systemd/system','var/lib','usr/local/bin','usr/local/sbin'])mkdirSync(p(path),{recursive:true,mode:0o755});
 writeFileSync(history,'[]');
 const command=(name:string,source:string)=>writeFileSync(join(bin,name),`#!${process.execPath}\n${source}\n`,{mode:0o755});
 const record=`const fs=require('node:fs'),file=process.env.PROBE_HISTORY,calls=JSON.parse(fs.readFileSync(file,'utf8'));calls.push({command:require('node:path').basename(process.argv[1]),args:process.argv.slice(2)});fs.writeFileSync(file,JSON.stringify(calls));`;
 command('id',`console.log('0');`);
 command('stat',`const fs=require('node:fs'),path=process.argv.at(-1),fd=/^\\/dev\\/fd\\/(\\d+)$/.exec(path),info=fd?fs.fstatSync(Number(fd[1])):fs.lstatSync(path),format=process.argv[3];if(format==='%u')console.log(path===process.env.PROBE_NON_ROOT?'123':'0');else if(format==='%a')console.log((info.mode&0o7777).toString(8));else if(format==='%d:%i:%u:%a')console.log([info.dev,info.ino,0,(info.mode&0o7777).toString(8)].join(':'));else process.exit(90);`);
 command('flock',record+`process.exit(Number(process.env.PROBE_LOCK_EXIT||0));`);
 command('systemctl',record+`const args=process.argv.slice(2);if(args[0]!=='show'||!args.includes('lightmoni-executor.service')||!args.includes('--value'))process.exit(91);if(args.includes('--property=LoadState')){console.log(process.env.PROBE_LOAD_STATE??'not-found');process.exit(Number(process.env.PROBE_LOAD_EXIT||0))}if(args.includes('--property=ActiveState')){console.log(process.env.PROBE_ACTIVE_STATE??'inactive');process.exit(Number(process.env.PROBE_ACTIVE_EXIT||0))}process.exit(92);`);
 // One pass prevents a temporary root containing /var or /usr from being
 // rewritten again. Include the standalone root checked by the actual probe.
 const shell=executorBootstrapAbsentCommand().replaceAll('/proc/self/fd/8','/dev/fd/8').replace(/\/(run|opt|etc|var|usr)(?=[^A-Za-z0-9_.-]|$)|(?<=\s)\/(?=\s)/g,value=>value==='/'?root:p(value.slice(1)))
  .replaceAll(`PATH=${p('usr/sbin')}:${p('usr/bin')}:/sbin:/bin`,`PATH=${bin}`);
 assert.ok(shell.includes(`PATH=${bin}`));
 assert.ok(!/(?:^|[\s="'])\/(?:run|opt|etc|var|usr)(?:\/|\b)/.test(shell.replaceAll(root,'FIXTURE')),'fixed Linux roots must be isolated');
 const interpreted=shell.replaceAll('set -eu\n','set -eu\n'+inlineFixtureCommands(bin).replaceAll("'","'\\''"));
 const run=(env:Record<string,string>={})=>spawnSync('/bin/sh',['-c',interpreted],{encoding:'utf8',timeout:10_000,env:{PATH:bin,PROBE_HISTORY:history,...env}});
 const calls=()=>JSON.parse(readFileSync(history,'utf8')) as {command:string;args:string[]}[];
 const refused=(env:Record<string,string>={})=>{const result=run(env);assert.ok(!result.error,result.error?.message);assert.notEqual(result.status,0,result.stdout+result.stderr);assert.ok(!result.stdout.includes('executor_bootstrap_absent=verified'),result.stdout);return result};
 return {root,p,run,refused,calls};
}

test('clean fixed absence probe acquires FD8 and verifies both successful systemd queries',t=>{
 const f=fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'executor_bootstrap_absent=verified\n');assert.deepEqual(f.calls(),[{command:'flock',args:['-n','8']},{command:'systemctl',args:['show','lightmoni-executor.service','--property=LoadState','--value']},{command:'systemctl',args:['show','lightmoni-executor.service','--property=ActiveState','--value']}]);
});

for(const ancestor of ['opt','etc/systemd','var/lib','usr/local','run/systemd'])test(`absence probe rejects dangling ancestor symlink ${ancestor}`,t=>{
 const f=fixture(t),path=f.p(ancestor);rmSync(path,{recursive:true,force:true});symlinkSync(f.p('missing-destination'),path);f.refused();assert.ok(!f.calls().some(call=>call.command==='systemctl'));
});

for(const ancestor of ['','opt','usr/local/sbin'])test(`absence probe rejects writable ${ancestor||'root'} directory`,t=>{
 const f=fixture(t);chmodSync(ancestor?f.p(ancestor):f.root,0o777);f.refused();assert.ok(!f.calls().some(call=>call.command==='systemctl'));
});

test('absence probe rejects non-root ownership before systemd evidence',t=>{
 const f=fixture(t);f.refused({PROBE_NON_ROOT:f.p('opt')});assert.ok(!f.calls().some(call=>call.command==='systemctl'));
});

for(const query of ['LOAD','ACTIVE'])test(`absence probe rejects failed ${query.toLowerCase()} query even with convincing stdout`,t=>{
 const f=fixture(t);f.refused({[`PROBE_${query}_EXIT`]:'1'});assert.equal(f.calls().filter(call=>call.command==='systemctl').length,query==='LOAD'?1:2);
});

for(const state of ['active','activating','unknown'])test(`absence probe rejects systemd ActiveState ${state}`,t=>{
 fixture(t).refused({PROBE_ACTIVE_STATE:state});
});

test('absence probe rejects a loaded inactive unit',t=>{fixture(t).refused({PROBE_LOAD_STATE:'loaded'});});

for(const [path,kind] of [['opt/lightmoni-executor','directory'],['usr/local/bin/lightmoni-executor','dangling-link'],['etc/systemd/system/lightmoni-executor.service','file']] as const)test(`absence probe preserves and rejects residual ${path}`,t=>{
 const f=fixture(t);if(kind==='directory')mkdirSync(f.p(path));else if(kind==='dangling-link')symlinkSync(f.p('missing-program'),f.p(path));else writeFileSync(f.p(path),'preserve this unit');f.refused();assert.ok(!f.calls().some(call=>call.command==='systemctl'));if(kind==='file')assert.equal(readFileSync(f.p(path),'utf8'),'preserve this unit');
});

test('absence probe rejects an occupied bootstrap flock without asking systemd',t=>{
 const f=fixture(t);f.refused({PROBE_LOCK_EXIT:'1'});assert.deepEqual(f.calls(),[{command:'flock',args:['-n','8']}]);
});

test('absence probe never opens a symlinked bootstrap lock',t=>{
 const f=fixture(t),outside=f.p('preserved-outside');writeFileSync(outside,'unchanged');symlinkSync(outside,f.p('run/lightmoni-executor-bootstrap.lock'));f.refused();assert.deepEqual(f.calls(),[]);assert.equal(readFileSync(outside,'utf8'),'unchanged');
});
