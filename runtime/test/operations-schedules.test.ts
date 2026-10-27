import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {registerOperationSchedules,cronMatches,validateCron} from '../src/server/operation-schedules.js';
import type {Dependencies} from '../src/shared/types.js';

test('cron validates fields and IANA zones, supports lists ranges steps and DST UTC slots',()=>{
 assert.throws(()=>validateCron('* * * * * *','UTC'),/five/);
 assert.throws(()=>validateCron('61 * * * *','UTC'),/cron/);
 assert.throws(()=>validateCron('* * * * *','No/SuchZone'),/timezone/);
 assert.equal(cronMatches('30 1 * * *','America/New_York',new Date('2026-11-01T05:30:00Z')),true);
 assert.equal(cronMatches('30 1 * * *','America/New_York',new Date('2026-11-01T06:30:00Z')),true);
 assert.equal(cronMatches('*/15 8-18 * * 1-5','Asia/Shanghai',new Date('2026-10-27T02:15:00Z')),true);
});
function fixture(){const db=new DB(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER,role TEXT);INSERT INTO users VALUES('admin',1,'admin')");let now=new Date('2026-10-27T00:00:00Z');const resources:any={a:{id:'a',kind:'backup',revision:1}};const runs:any={};let planned=0;const deps={db,router:{get(){},post(){},put(){},delete(){}},now:()=>now,encrypt:(s:string)=>s,decrypt:(s:string)=>s,auth:{requireAdmin(){}},logger:{error(){},warn(){}}}as unknown as Dependencies;const ops:any={get:(id:string)=>resources[id],validateOperation:(_id:string,_op:string,input:any)=>input??{},plan:()=>{const id='run-'+(++planned);runs[id]={id,state:'awaiting_approval',resource_revision:1};return runs[id];},approve:(id:string)=>{runs[id].state='queued';return runs[id];},getRun:(id:string)=>runs[id],runs:()=>Object.values(runs)};const schedules=registerOperationSchedules(deps,ops);return {db,schedules,resources,runs,get planned(){return planned;},advance:(n:number)=>{now=new Date(now.getTime()+n*60000);},close:()=>{schedules.close?.();db.close();}};}
test('schedule authorizes fixed action and revision, deduplicates UTC minutes, skips missed/busy and stops unknown',()=>{
 const f=fixture();try{
  assert.throws(()=>f.schedules.create({resource_id:'a',resource_revision:1,operation:'restore',input:{},cron:'* * * * *',timezone:'UTC',enabled:true},'admin'),/scheduled/);
  const s=f.schedules.create({resource_id:'a',resource_revision:1,operation:'create',input:{},cron:'* * * * *',timezone:'UTC',enabled:true},'admin');
  f.schedules.start?.();f.advance(1);f.schedules.tick();f.schedules.tick();assert.equal(f.planned,1);
  f.advance(3);f.schedules.tick();assert.equal(f.planned,1);assert.ok(f.schedules.fires(s.id).some((r:any)=>r.state==='skipped_busy'));
  f.runs['run-1'].state='unknown';f.advance(1);f.schedules.tick();assert.equal(f.schedules.get(s.id).enabled,false);assert.equal(f.planned,1);
 }finally{f.close();}
});
test('schedule resource changes invalidate authorization and restart never backfills elapsed slots',()=>{
 const f=fixture();try{const s=f.schedules.create({resource_id:'a',resource_revision:1,operation:'create',cron:'* * * * *',timezone:'UTC',enabled:true},'admin');
 f.schedules.start?.();f.resources.a.revision=2;f.advance(1);f.schedules.tick();assert.equal(f.planned,0);assert.equal(f.schedules.get(s.id).disabled_reason,'resource_changed');
 assert.throws(()=>f.schedules.update(s.id,{...f.schedules.get(s.id),resource_revision:1,enabled:true},'admin'),/revision/);
 }finally{f.close();}
});
test('an administrator can reauthorize after unknown without silently replaying the same firing',()=>{
 const f=fixture();try{const s=f.schedules.create({resource_id:'a',resource_revision:1,operation:'create',cron:'* * * * *',timezone:'UTC',enabled:true},'admin');f.schedules.start?.();f.advance(1);f.schedules.tick();f.runs['run-1'].state='unknown';f.advance(1);f.schedules.tick();assert.equal(f.schedules.get(s.id).enabled,false);const old=f.schedules.get(s.id);f.schedules.update(s.id,{...old,enabled:true},'admin');f.advance(1);f.schedules.tick();assert.equal(f.planned,2);assert.equal(f.schedules.fires(s.id).filter((r:any)=>r.run_id==='run-1').length,1);}finally{f.close();}
});
test('schedule HTTP API requires administrator, binds optimistic revisions and never exposes encrypted storage',async()=>{
 const {createServer}=await import('node:http');const {Router,fail}=await import('../src/shared/http.js');
 const db=new DB(':memory:'),router=new Router();db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER,role TEXT);INSERT INTO users VALUES('u',1,'admin')");const auth={user:(req:any)=>req.headers.authorization?{id:'u',name:'user',role:req.headers.authorization}:undefined,requireAdmin:(ctx:any)=>{if(ctx.user.role!=='admin')fail(403,'admin required');}};router.auth=auth as any;const ops:any={get:()=>({id:'a',name:'backup',kind:'backup',revision:1}),validateOperation:()=>({}),plan:()=>({id:'run',state:'awaiting_approval'}),approve:()=>({id:'run',state:'queued'}),getRun:()=>({state:'queued'})};const deps={db,router,auth,now:()=>new Date(),encrypt:(s:string)=>'encrypted:'+s,decrypt:(s:string)=>s.slice(10)} as unknown as Dependencies;const scheduler=registerOperationSchedules(deps,ops);const server=createServer((req,res)=>{void router.handle(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address()as any).port+'/api/v1/operation-schedules';try{assert.equal((await fetch(base)).status,401);assert.equal((await fetch(base,{headers:{authorization:'member'}})).status,403);const input={resource_id:'a',resource_revision:1,operation:'create',cron:'0 * * * *',timezone:'UTC',enabled:true};const created=await fetch(base,{method:'POST',headers:{authorization:'admin','content-type':'application/json'},body:JSON.stringify(input)});assert.equal(created.status,201);const {schedule}=await created.json()as any;assert.equal((await fetch(base+'/'+schedule.id,{method:'PUT',headers:{authorization:'admin','content-type':'application/json'},body:JSON.stringify({...input,revision:0})})).status,409);const run=await fetch(base+'/'+schedule.id+'/run',{method:'POST',headers:{authorization:'admin','content-type':'application/json'},body:JSON.stringify({revision:1})});assert.equal(run.status,202);const list=await (await fetch(base,{headers:{authorization:'admin'}})).json();assert.ok(!JSON.stringify(list).includes('encrypted:'));assert.equal(db.get<any>('SELECT input_json FROM ops_schedules WHERE id=?',schedule.id)!.input_json,'encrypted:{}');}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));scheduler.close?.();db.close();}
});
test('restart skips prior minutes and freezes a dispatch whose completion was not persisted',()=>{
 const db=new DB(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER,role TEXT);INSERT INTO users VALUES('admin',1,'admin')");let now=new Date('2026-10-27T00:00:00Z'),plans=0;const deps={db,router:{get(){},post(){},put(){},delete(){}},now:()=>now,encrypt:(s:string)=>s,decrypt:(s:string)=>s,auth:{requireAdmin(){}}}as unknown as Dependencies;const ops:any={get:()=>({id:'a',kind:'backup',revision:1}),validateOperation:()=>({}),plan:()=>{plans++;return {id:'r',state:'awaiting_approval'}},approve:()=>({id:'r',state:'queued'}),getRun:()=>({state:'queued'})};const one=registerOperationSchedules(deps,ops),s=one.create({resource_id:'a',resource_revision:1,operation:'create',cron:'* * * * *',timezone:'UTC',enabled:true},'admin');one.start?.();one.close?.();now=new Date('2026-10-27T01:00:00Z');const two=registerOperationSchedules(deps,ops);two.start?.();two.tick();assert.equal(plans,0);db.run('INSERT INTO ops_schedule_fires(schedule_id,slot,state,schedule_revision,created_at) VALUES(?,?,?,?,?)',s.id,'2026-10-27T00:59:00.000Z','dispatching',1,now.toISOString());two.close?.();const three=registerOperationSchedules(deps,ops);three.start?.();assert.equal(three.get(s.id).disabled_reason,'unknown_result');now=new Date('2026-10-27T01:01:00Z');three.tick();assert.equal(plans,0);three.close?.();db.close();
});
test('disabled or demoted authorizer automatically revokes scheduled execution',()=>{
 for(const [column,value]of [['active',0],['role','member']]as const){const f=fixture();try{const s=f.schedules.create({resource_id:'a',resource_revision:1,operation:'create',cron:'* * * * *',timezone:'UTC',enabled:true},'admin');f.schedules.start?.();f.db.run('UPDATE users SET '+column+'=? WHERE id=?',value,'admin');f.advance(1);f.schedules.tick();assert.equal(f.planned,0);assert.equal(f.schedules.get(s.id).disabled_reason,'authorizer_unavailable');}finally{f.close();}}
});
