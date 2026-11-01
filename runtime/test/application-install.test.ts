import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogInstallation} from '../src/ops/catalog.js';
import {installationState} from '../../web/src/app/ops/install-state.js';
test('catalog manual ports match the container, managed ports allocate automatically, explicit ports survive both modes',()=>{
 for(const [id,port] of [['redis',6379],['mysql',3306]] as const){
  const parameters={password:'qa-hidden',user_password:'qa-hidden'};
  const install=(mode:string,p:unknown={})=>catalogInstallation(id,{deployment_mode:mode,parameters:{...parameters,...p as object}}).spec.ports[0].host_port;
  assert.equal(install('manual'),port);assert.equal(install('managed'),0);
  for(const mode of ['manual','managed']){assert.equal(install(mode,{port:16379}),16379);assert.equal(install(mode,{port:0}),0)}
  assert.equal(install('manual',{port:null}),port);assert.equal(install('managed',{port:''}),0);
 }
 assert.equal(catalogInstallation('openresty',{deployment_mode:'managed',parameters:{port:1234}}).spec.ports[0].host_port,80);
});
test('installation completion requires all published deployments and healthy instances, without hiding partial or unknown outcomes',()=>{
 const resource:any={spec:{deployments:[{cluster_id:'a'},{cluster_id:'b'}]},status:{deployments:{a:{enabled:true,desired_revision:1,applied_revision:1},b:{enabled:true,desired_revision:1,applied_revision:0,pending:'capacity'}},instances:[{id:'a',cluster_id:'a',state:'running',healthy:true},{id:'b',cluster_id:'b',state:'queued',healthy:false}]}};
 assert.equal(installationState(resource),'pending');
 resource.status.deployments.b.last_error='insufficient_node_capacity';assert.equal(installationState(resource),'failed');
 resource.status.instances[1].state='unknown';assert.equal(installationState(resource),'unknown');
 resource.status.instances[1]={id:'b',cluster_id:'b',state:'running',healthy:true};delete resource.status.deployments.b.last_error;resource.status.deployments.b.applied_revision=1;
 assert.equal(installationState(resource),'succeeded');
 resource.status.instances.pop();resource.status.deployments.b.instances_total=0;assert.equal(installationState(resource),'pending');
 resource.status.instances.push({id:'b',cluster_id:'b',state:'running',healthy:true});delete resource.status.deployments.b.instances_total;
 resource.status.instances[1].retired=true;resource.status.instances[0].healthy=false;assert.equal(installationState(resource),'pending');
});
