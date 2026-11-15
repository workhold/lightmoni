import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogInstallation} from '../src/ops/catalog.js';
import {installationState} from '../../web/src/app/ops/install-state.js';
test('catalog defaults allocate ports in both supported modes while explicit mappings and fixed service ports survive',()=>{
 for(const [id,port] of [['redis',6379],['mysql',3306]] as const){
  const parameters=id==='mysql'?{password:'qa-hidden',user_password:'qa-hidden'}:{password:'qa-hidden'};
  const install=(mode:string,mapping?:number)=>catalogInstallation(id,{deployment_mode:mode,parameters,host_ports:mapping===undefined?undefined:{[id]:mapping}}).spec.ports[0].host_port;
  assert.equal(install('manual'),0);assert.equal(install('managed'),0);
  for(const mode of ['manual','managed']){assert.equal(install(mode,port),port);assert.equal(install(mode,16379),16379);assert.equal(install(mode,0),0)}
 }
 assert.equal(catalogInstallation('openresty',{deployment_mode:'managed',parameters:{}}).spec.ports[0].host_port,80);
});
test('catalog named mappings validate the full port contract and use named port mappings',()=>{
 const install=(input:any)=>catalogInstallation('registry',input).spec;
 assert.equal(install({host_ports:{registry:15000},listen_ip:'127.0.0.1'}).ports[0].host_port,15000);
 assert.equal(install({host_ports:{registry:0}}).ports[0].host_port,0);
 assert.equal(install({host_ports:{registry:15001}}).ports[0].host_port,15001);
 for(const host_ports of [null,[],{unknown:1},{registry:-1},{registry:65536},{registry:1.5},{registry:'5000'}])assert.throws(()=>install({host_ports}),/invalid_host_ports/);
 assert.throws(()=>install({listen_ip:'8.8.8.8'}),/invalid_listen_ip/);
 for (const id of ['registry','redis','mysql','postgresql']) assert.throws(()=>catalogInstallation(id,{parameters:{port:15000}}),/invalid_catalog_parameter/);
 assert.throws(()=>catalogInstallation('openresty',{host_ports:{http:8080}}),/openresty_fixed_host_ports/);
});
test('installation completion requires all published deployments and healthy instances, without hiding partial or unknown outcomes',()=>{
 const ready=(cluster_id:string)=>({id:cluster_id,cluster_id,slot:0,state:'running',healthy:true,availability:'ready',observed_generation:1});
 const resource:any={
  kind:'application',revision:1,
  spec:{deployment_mode:'managed',deployments:[{cluster_id:'a',replicas:1},{cluster_id:'b',replicas:1}]},
  status:{
   deployments:{
    a:{enabled:true,desired_revision:1,applied_revision:1,instances_total:1,ready_instances:1},
    b:{enabled:true,desired_revision:1,applied_revision:0,instances_total:1,ready_instances:0,pending:'capacity'},
   },
   instances:[ready('a'),{id:'b',cluster_id:'b',slot:0,state:'queued',healthy:false}],
  },
 };
 assert.equal(installationState(resource),'pending');
 resource.status.deployments.b.last_error='insufficient_node_capacity';assert.equal(installationState(resource),'failed');
 resource.status.instances[1].state='unknown';assert.equal(installationState(resource),'unknown');
 resource.status.instances[1]=ready('b');delete resource.status.deployments.b.last_error;resource.status.deployments.b.applied_revision=1;resource.status.deployments.b.ready_instances=1;
 assert.equal(installationState(resource),'succeeded');
 resource.status.instances[1].availability='protected';assert.equal(installationState(resource),'unverified');
 resource.status.instances[1].availability='ready';
 resource.status.instances.pop();resource.status.deployments.b.instances_total=0;resource.status.deployments.b.ready_instances=0;assert.equal(installationState(resource),'pending');
 resource.status.instances.push(ready('b'));resource.status.deployments.b.instances_total=1;resource.status.deployments.b.ready_instances=1;
 resource.status.instances[0].healthy=false;assert.equal(installationState(resource),'pending');
 resource.status.instances[0].healthy=true;resource.status.instances[1].retired=true;resource.status.deployments.b.instances_total=0;resource.status.deployments.b.ready_instances=0;assert.equal(installationState(resource),'pending');
});
