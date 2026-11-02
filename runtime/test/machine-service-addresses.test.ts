import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DB} from '../src/shared/sqlite.js';
import {Router,fail} from '../src/shared/http.js';
import {cipher} from '../src/shared/crypto.js';
import {registerManagedMachines} from '../src/server/managed-machines.js';
import {machineServiceAddresses,recordHostNetwork} from '../src/server/host-network.js';
import {normalizeNetworkAddresses} from '../src/shared/host-network.js';

async function fixture(t:any){
 const db=new DB(':memory:'),router=new Router(),now=new Date('2026-11-01T12:00:00Z');
 db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
 const deps:any={db,router,...cipher(Buffer.alloc(32,31)),now:()=>now,externalURL:'https://qa.example.test',logger:{info(){},warn(){},error(){}},cat:{list:async()=>[]},auth:{master:Buffer.alloc(32,31),user:(req:any)=>({id:'qa-admin',name:'QA',role:req.headers['x-role']??'admin'}),requireAdmin:(ctx:any)=>{if(ctx.user.role!=='admin')fail(403,'administrator_required')}}};
 router.auth=deps.auth;
 const machines=registerManagedMachines(deps,{agentCredentials:{has:()=>false} as any,sshRunner:async()=>{throw Error('qa_ssh_disabled')}});
 const server=createServer((req,res)=>void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}}));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{machines.close?.();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close()});
 const req=async(path:string,method='GET',body?:any,role='admin')=>{const response=await fetch('http://127.0.0.1:'+(server.address() as any).port+'/api/v1'+path,{method,headers:{'content-type':'application/json','x-role':role},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json() as any}};
 const host=(await req('/machines','POST',{name:'NAT host',address:'8.8.4.4',username:'root'})).body;
 db.run("INSERT INTO agents(id,last_seen) VALUES('agent-a',?)",now.toISOString());db.run("UPDATE managed_machines SET agent_id='agent-a' WHERE id=?",host.id);
 const observe=(agent='agent-a',addresses=[{interface:'eth0',address:'10.0.0.16'}],at=now.toISOString())=>recordHostNetwork(db,host.id,agent,normalizeNetworkAddresses(addresses),{source_ip:'172.24.0.1',source_kind:'direct'},at);
 observe();const path='/machines/'+host.id+'/service-addresses';
 const read=()=>req(path),save=(value:any)=>req(path,'PUT',value);
 const payload=async(overrides:any={})=>{const {body}=await read();return{revision:body.revision,target_generation:body.target_generation,private:{mode:'auto',address:''},public:{mode:'auto',address:''},...overrides}};
 return{db,req,host,path,read,save,payload,observe};
}

test('NAT candidates keep NIC, SSH target and proxy provenance separate; both families support overrides',async t=>{
 const f=await fixture(t),initial=(await f.read()).body;
 assert.equal(initial.private.effective,'10.0.0.16');assert.equal(initial.public.effective,'');
 assert.ok(initial.candidates.some((c:any)=>c.address==='8.8.4.4'&&c.source==='ssh_target'&&c.requires_confirmation));
 assert.ok(!initial.candidates.some((c:any)=>c.address==='172.24.0.1'));
 const save=await f.save(await f.payload({private:{mode:'manual',address:'10.0.0.17'},public:{mode:'manual',address:'8.8.4.4'}}));
 assert.equal(save.status,200);assert.equal(save.body.revision,1);assert.equal(save.body.updated_by,'qa-admin');
 assert.deepEqual(machineServiceAddresses(f.db,f.host.id),{address:'10.0.0.17',public_address:'8.8.4.4',private_ips:['10.0.0.17'],public_ips:['8.8.4.4']});
 f.observe('agent-a',[{interface:'eth0',address:'10.0.0.18'}],'2026-11-01T12:01:00Z');
 assert.equal((await f.read()).body.private.effective,'10.0.0.17');
 assert.equal((await f.req('/machines/'+f.host.id)).body.machine.network.private_ips[0],'10.0.0.18');
 assert.equal((await f.req('/machines/'+f.host.id)).body.machine.network.service_addresses.public.effective,'8.8.4.4');
 assert.equal((await f.save(await f.payload({private:{mode:'manual',address:'fd12::17'},public:{mode:'manual',address:'2606:4700:4700::1111'}}))).status,200);
 assert.equal(machineServiceAddresses(f.db,f.host.id).address,'fd12::17');
 assert.equal(machineServiceAddresses(f.db,f.host.id).public_address,'2606:4700:4700::1111');
 assert.equal((await f.save(await f.payload())).status,200);
 assert.equal(machineServiceAddresses(f.db,f.host.id).address,'10.0.0.18');assert.equal(machineServiceAddresses(f.db,f.host.id).public_address,'');
});

test('service address API rejects wrong fields, scopes and stale writes atomically and enforces administrator access',async t=>{
 const f=await fixture(t),base=await f.payload();
 for(const [scope,addresses] of [['private',['8.8.8.8','127.0.0.1','169.254.1.2','http://10.0.0.1','10.0.0.1:80','10.0.0.1/24']],['public',['10.0.0.1','100.64.0.1','172.21.0.16','172.24.0.1','198.18.0.34','203.0.113.4','0.0.0.0','224.0.0.1','::','::1','fe80::1','fd00::1','2001:db8::1']]] as const){
  for(const address of addresses){const result=await f.save({...base,[scope]:{mode:'manual',address}});assert.equal(result.status,400,address);assert.equal(result.body.error,'invalid_'+scope+'_service_address');}
 }
 assert.equal((await f.save({...base,public:{mode:'auto',address:'8.8.8.8'}})).status,400);
 assert.equal((await f.save({...base,private:{mode:'manual',address:'10.0.0.1',ignored:true}})).status,400);
 assert.equal((await f.save({...base,ignored:true})).status,400);
 assert.equal((await f.read()).body.revision,0);
 assert.equal((await f.req(f.path,'GET',undefined,'member')).status,403);
 assert.equal((await f.req(f.path,'PUT',base,'member')).status,403);
 assert.equal((await f.save({...base,public:{mode:'manual',address:'8.8.4.4'}})).status,200);
 const conflict=await f.save(base);assert.equal(conflict.status,409);assert.equal(conflict.body.error,'machine_service_address_revision_conflict');
 assert.equal((await f.read()).body.public.effective,'8.8.4.4');
 const current=await f.payload();f.db.run('UPDATE managed_machines SET ssh_target_generation=ssh_target_generation+1 WHERE id=?',f.host.id);
 assert.equal((await f.save(current)).body.error,'machine_network_target_changed');
 assert.equal((await f.read()).body.public.needs_confirmation,true);assert.equal(machineServiceAddresses(f.db,f.host.id).public_address,'');
 assert.equal((await f.save(await f.payload({public:{mode:'manual',address:'8.8.4.4'}}))).status,200);
});

test('manual settings survive Agent replacement, exclude old observations, and are deleted with their host',async t=>{
 const f=await fixture(t);
 await f.save(await f.payload({private:{mode:'manual',address:'10.0.0.17'},public:{mode:'manual',address:'8.8.4.4'}}));
 f.db.run("UPDATE managed_machines SET agent_id='replacement' WHERE id=?",f.host.id);
 assert.equal((await f.read()).body.candidates.filter((c:any)=>c.source==='interface').length,0);
 assert.equal(machineServiceAddresses(f.db,f.host.id).public_address,'8.8.4.4');
 f.observe('replacement',[{interface:'eth0',address:'10.0.0.19'},{interface:'docker0',address:'172.17.0.1'},{interface:'wg0',address:'10.7.0.2'}],'2026-11-01T12:02:00Z');
 const current=(await f.read()).body;
 assert.ok(current.candidates.some((c:any)=>c.address==='10.0.0.19'));
 assert.ok(!current.candidates.some((c:any)=>['172.17.0.1','10.7.0.2'].includes(c.address)));
 assert.equal(current.private.effective,'10.0.0.17');
 f.db.run('DELETE FROM managed_machines WHERE id=?',f.host.id);
 assert.equal(f.db.all('SELECT * FROM machine_service_address_settings').length,0);
});

test('automatic selection supports both scopes; numeric source candidates never resolve an SSH hostname or override a NIC',async t=>{
 const f=await fixture(t);
 f.db.run('UPDATE managed_machines SET address=? WHERE id=?','ssh.example.test',f.host.id);
 recordHostNetwork(f.db,f.host.id,'agent-a',normalizeNetworkAddresses([{interface:'eth0',address:'fd12::16'},{interface:'eth0',address:'10.0.0.16'},{interface:'eth0',address:'2606:4700:4700::1111'},{interface:'eth0',address:'8.8.8.8'}]),{source_ip:'1.1.1.1',source_kind:'trusted_proxy'},'2026-11-01T12:01:00Z');
 const value=(await f.read()).body;
 assert.equal(value.private.effective,'10.0.0.16');assert.equal(value.public.effective,'8.8.8.8');
 assert.ok(value.candidates.some((c:any)=>c.address==='1.1.1.1'&&c.source==='platform_source'&&c.requires_confirmation));
 assert.ok(!value.candidates.some((c:any)=>c.source==='ssh_target'));
 assert.deepEqual(value.public.effective_addresses,['8.8.8.8','2606:4700:4700::1111']);
});
